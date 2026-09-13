use crate::audio::capture::AudioFrameQueue;
use crate::events::{emit_status, CaptionEvent, SessionStatusEvent, CAPTION_SEGMENT_EVENT};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio::time::{interval, sleep, Duration, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_CHUNK_BYTES: usize = 3_200; // 100 ms @ 16 kHz mono S16LE — matches live capture pace
const MAX_CATCHUP_BYTES: usize = 3 * MAX_CHUNK_BYTES;
const MAX_RECONNECT_ATTEMPTS: u32 = 8;
const STOP_FINALIZATION_TIMEOUT: Duration = Duration::from_secs(45);

pub struct StreamSession {
    pub session_id: String,
    pub source_language: String,
    pub target_language: String,
    pub context_hint: String,
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct StreamManager {
    stop_tx: Option<oneshot::Sender<()>>,
    done_rx: Option<oneshot::Receiver<Result<(), String>>>,
    running: Option<Arc<AtomicBool>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self {
            stop_tx: None,
            done_rx: None,
            running: None,
        }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        session: StreamSession,
        frames: AudioFrameQueue,
    ) -> Result<(), String> {
        if self.is_active() {
            return Err("audio stream is already running".into());
        }

        let session_id = session.session_id.clone();
        let (stop_tx, stop_rx) = oneshot::channel();
        let (done_tx, done_rx) = oneshot::channel();
        let running = Arc::new(AtomicBool::new(true));
        self.stop_tx = Some(stop_tx);
        self.done_rx = Some(done_rx);
        self.running = Some(Arc::clone(&running));
        emit_status(&app, SessionStatusEvent::starting(session_id.clone()));
        tauri::async_runtime::spawn(async move {
            let result = run_stream(app.clone(), session, frames, stop_rx).await;
            let cleanup = app
                .state::<crate::AppState>()
                .audio_engine
                .lock()
                .map_err(|_| "audio engine lock poisoned".to_string())
                .and_then(|mut engine| engine.complete_stream(&session_id).map(|_| ()));
            let result = result.and(cleanup);
            running.store(false, Ordering::SeqCst);
            match &result {
                Ok(()) => {
                    // Stream ended without an explicit UI stop (disconnect after
                    // reconnect budget, cancel during reconnect, etc.). Reset the
                    // overlay so we do not stick on "Listening…" with no socket.
                    emit_status(&app, SessionStatusEvent::idle(session_id));
                }
                Err(message) => {
                    emit_status(
                        &app,
                        SessionStatusEvent::error(Some(session_id), message.clone()),
                    );
                }
            }
            let _ = done_tx.send(result);
        });
        Ok(())
    }

    pub fn request_stop(&mut self) -> Option<oneshot::Receiver<Result<(), String>>> {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        self.done_rx.take()
    }

    /// Drop local stream handles after the async task finishes so a dead stream
    /// cannot block the next `start_caption_session` call.
    pub fn clear_if_finished(&mut self) {
        let finished = self
            .running
            .as_ref()
            .is_some_and(|flag| !flag.load(Ordering::SeqCst));
        if !finished {
            return;
        }
        self.stop_tx = None;
        self.done_rx = None;
        self.running = None;
    }

    pub fn is_active(&self) -> bool {
        self.running
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartSessionMessage<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    session_id: &'a str,
    source_language: &'a str,
    target_language: &'a str,
    sample_rate: u32,
    channels: u16,
    next_caption_sequence: u64,
    #[serde(skip_serializing_if = "str::is_empty")]
    context_hint: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioChunkMessage<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    session_id: &'a str,
    sequence: u64,
    timestamp_ms: u64,
    encoding: &'static str,
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopSessionMessage<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    session_id: &'a str,
}

async fn run_stream(
    app: AppHandle,
    session: StreamSession,
    frames: AudioFrameQueue,
    mut stop_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let mut sequence = 0_u64;
    let mut next_caption_sequence = 0_u64;
    let mut attempts = 0_u32;
    let mut stopping = false;
    let mut pending_error: Option<String> = None;

    loop {
        if let Some(error) = frames.capture_error() {
            return Err(error);
        }
        let connected_at = Instant::now();
        match run_stream_once(
            &app,
            &session,
            &frames,
            &mut stop_rx,
            &mut sequence,
            &mut next_caption_sequence,
            &mut stopping,
            &mut pending_error,
        )
        .await
        {
            Ok(StreamExit::Stopped) => {
                return pending_error.map_or(Ok(()), Err);
            }
            Ok(StreamExit::Disconnected(reason)) => {
                if stopping {
                    return pending_error.map_or_else(
                        || {
                            Err(format!(
                                "caption gateway disconnected during stop: {reason}"
                            ))
                        },
                        Err,
                    );
                }
                if connected_at.elapsed() > Duration::from_secs(30) {
                    attempts = 0;
                }
                attempts = attempts.saturating_add(1);
                if attempts > MAX_RECONNECT_ATTEMPTS {
                    return Err(format!("caption gateway disconnected repeatedly: {reason}"));
                }
                let delay_ms = 250 * u64::from(attempts).min(4);
                emit_status(
                    &app,
                    SessionStatusEvent::reconnecting(session.session_id.clone()),
                );
                tokio::select! {
                    _ = &mut stop_rx => return Ok(()),
                    _ = sleep(Duration::from_millis(delay_ms)) => {}
                }
            }
            Err(error) => return Err(error),
        }
    }
}

enum StreamExit {
    Stopped,
    Disconnected(String),
}

async fn run_stream_once(
    app: &AppHandle,
    session: &StreamSession,
    frames: &AudioFrameQueue,
    stop_rx: &mut oneshot::Receiver<()>,
    sequence: &mut u64,
    next_caption_sequence: &mut u64,
    stopping: &mut bool,
    pending_error: &mut Option<String>,
) -> Result<StreamExit, String> {
    let gateway = app
        .state::<crate::AppState>()
        .gateway
        .lock()
        .await
        .ensure(app)
        .await?;
    let mut request = format!("{}/v1/realtime", gateway.origin.replacen("http", "ws", 1))
        .into_client_request()
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", gateway.token)
            .parse()
            .map_err(|_| "Invalid service token")?,
    );
    let connection = tokio::select! {
        _ = &mut *stop_rx => return Ok(StreamExit::Stopped),
        result = tokio::time::timeout(Duration::from_secs(5), connect_async(request)) => result,
    };
    let (socket, _) = match connection {
        Ok(Ok(connected)) => connected,
        Err(_) => return Ok(StreamExit::Disconnected("connection timed out".into())),
        Ok(Err(error)) => {
            return Ok(StreamExit::Disconnected(format!(
                "cannot connect to the caption gateway: {error}"
            )));
        }
    };
    let (mut writer, mut reader) = socket.split();

    if let Err(error) = send_json(
        &mut writer,
        &StartSessionMessage {
            message_type: "start_session",
            session_id: &session.session_id,
            source_language: &session.source_language,
            target_language: &session.target_language,
            sample_rate: session.sample_rate,
            channels: session.channels,
            next_caption_sequence: *next_caption_sequence,
            context_hint: &session.context_hint,
        },
    )
    .await
    {
        return Ok(StreamExit::Disconnected(error));
    }

    let mut send_tick = interval(Duration::from_millis(100));
    let mut last_sound = Instant::now();
    let stop_timeout = sleep(Duration::from_secs(86_400));
    tokio::pin!(stop_timeout);
    loop {
        tokio::select! {
            _ = &mut *stop_rx, if !*stopping => {
                if let Err(error) = request_gateway_stop(&mut writer, session, frames, sequence, stopping).await {
                    return Ok(StreamExit::Disconnected(error));
                }
                stop_timeout
                    .as_mut()
                    .reset(Instant::now() + STOP_FINALIZATION_TIMEOUT);
            }
            _ = &mut stop_timeout, if *stopping => {
                let _ = writer.close().await;
                return Err(pending_error.take().unwrap_or_else(|| {
                    "caption gateway timed out finalizing the session".into()
                }));
            }
            _ = send_tick.tick(), if !*stopping => {
                if let Some(error) = frames.capture_error() { return Err(error); }
                let chunk = drain_audio(frames);
                let level = chunk.as_ref().map_or(0.0, |(audio, _)| audio_level(audio));
                // -60 dBFS is an activity threshold, not speech detection/VAD.
                if level > 0.001 { last_sound = Instant::now(); }
                let _ = app.emit("caption://audio", serde_json::json!({
                    "sessionId": session.session_id,
                    "level": level,
                    "silentForMs": last_sound.elapsed().as_millis() as u64,
                    "droppedAudioMs": frames.dropped_audio_ms(),
                    "oldestAudioAgeMs": chunk.as_ref().and_then(|(_, start)| frames.audio_lag_ms(*start)),
                }));
                if let Some((audio, timestamp_ms)) = chunk {
                    let message = AudioChunkMessage {
                        message_type: "audio_chunk",
                        session_id: &session.session_id,
                        sequence: *sequence,
                        timestamp_ms,
                        encoding: "pcm_s16le",
                        data_base64: BASE64_STANDARD.encode(audio),
                    };
                    if let Err(error) = send_json(&mut writer, &message).await {
                        return Ok(StreamExit::Disconnected(error));
                    }
                    *sequence = sequence.saturating_add(1);
                }
            }
            inbound = reader.next() => {
                let Some(inbound) = inbound else {
                    return Ok(StreamExit::Disconnected(
                        "caption gateway disconnected".into(),
                    ));
                };
                match inbound {
                    Ok(Message::Text(text)) => {
                        match handle_server_message(app, text.as_ref(), *stopping, frames) {
                            Ok(ServerMessageAction::Continue) => {}
                            Ok(ServerMessageAction::Caption(sequence)) => {
                                *next_caption_sequence = (*next_caption_sequence).max(sequence.saturating_add(1));
                            }
                            Ok(ServerMessageAction::SessionStopped) => {
                                let _ = writer.close().await;
                                return Ok(StreamExit::Stopped);
                            }
                            Ok(ServerMessageAction::RetainError(error)) => {
                                *pending_error = Some(error);
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    Ok(Message::Close(_)) => {
                        return Ok(StreamExit::Disconnected(
                            "caption gateway closed the session".into(),
                        ));
                    }
                    Ok(Message::Ping(payload)) => {
                        if let Err(error) = writer.send(Message::Pong(payload)).await {
                            return Ok(StreamExit::Disconnected(format!(
                                "caption gateway pong failed: {error}"
                            )));
                        }
                    }
                    Ok(Message::Binary(_) | Message::Pong(_) | Message::Frame(_)) => {}
                    Err(error) => {
                        return Ok(StreamExit::Disconnected(format!(
                            "caption gateway read failed: {error}"
                        )));
                    }
                }
            }
        }
    }
}

async fn request_gateway_stop<S>(
    writer: &mut S,
    session: &StreamSession,
    frames: &AudioFrameQueue,
    sequence: &mut u64,
    stopping: &mut bool,
) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    // Consume cancellation once, even if draining or sending stop fails.
    *stopping = true;
    flush_remaining_audio(writer, session, frames, sequence).await?;
    send_json(
        writer,
        &StopSessionMessage {
            message_type: "stop_session",
            session_id: &session.session_id,
        },
    )
    .await
}

async fn flush_remaining_audio<S>(
    writer: &mut S,
    session: &StreamSession,
    frames: &AudioFrameQueue,
    sequence: &mut u64,
) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    while let Some((audio, timestamp_ms)) = drain_audio(frames) {
        let message = AudioChunkMessage {
            message_type: "audio_chunk",
            session_id: &session.session_id,
            sequence: *sequence,
            timestamp_ms,
            encoding: "pcm_s16le",
            data_base64: BASE64_STANDARD.encode(audio),
        };
        send_json(writer, &message).await?;
        *sequence = sequence.saturating_add(1);
    }
    Ok(())
}

async fn send_json<S, T>(writer: &mut S, value: &T) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
    T: Serialize,
{
    let serialized = serde_json::to_string(value)
        .map_err(|error| format!("protocol encoding failed: {error}"))?;
    tokio::time::timeout(
        Duration::from_secs(5),
        writer.send(Message::Text(serialized.into())),
    )
    .await
    .map_err(|_| "Caption service write timed out".to_string())?
    .map_err(|error| format!("caption gateway write failed: {error}"))
}

fn drain_audio(frames: &AudioFrameQueue) -> Option<(Vec<u8>, u64)> {
    let first = frames.pop()?;
    let timestamp_ms = first.timestamp_ms;
    // Drain faster than capture after startup or a stalled write, with bounded work.
    let limit = if frames
        .audio_lag_ms(timestamp_ms)
        .is_some_and(|age| age > 250)
    {
        MAX_CATCHUP_BYTES
    } else {
        MAX_CHUNK_BYTES
    };
    let mut bytes = Vec::with_capacity(limit);
    append_samples(&mut bytes, &first.samples);

    while bytes.len() < limit {
        let Some(frame) = frames.pop() else {
            break;
        };
        append_samples(&mut bytes, &frame.samples);
    }
    Some((bytes, timestamp_ms))
}

fn append_samples(bytes: &mut Vec<u8>, samples: &[i16]) {
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
}

enum ServerMessageAction {
    Continue,
    Caption(u64),
    SessionStopped,
    RetainError(String),
}

fn handle_server_message(
    app: &AppHandle,
    raw: &str,
    stopping: bool,
    frames: &AudioFrameQueue,
) -> Result<ServerMessageAction, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid gateway response: {error}"))?;
    match value.get("type").and_then(Value::as_str) {
        Some("translation_timing") => {
            app.state::<crate::diagnostics::Timings>()
                .record_translation(value)?;
            Ok(ServerMessageAction::Continue)
        }
        Some("caption") => {
            let mut caption: CaptionEvent = serde_json::from_value(value)
                .map_err(|error| format!("invalid caption event: {error}"))?;
            if caption.utterance_id.is_empty() {
                return Err("caption event is missing utteranceId".into());
            }
            crate::remember_provider(app, &caption.provider);
            let sequence = caption.sequence;
            caption.timing = Some(crate::events::CaptionTiming {
                native_received_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "System clock is unavailable")?
                    .as_millis() as u64,
                audio_lag_ms: frames.audio_lag_ms(caption.end_ms),
            });
            app.emit(CAPTION_SEGMENT_EVENT, caption)
                .map_err(|error| format!("failed to publish caption: {error}"))?;
            Ok(ServerMessageAction::Caption(sequence))
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("caption gateway returned an error")
                .to_string();
            let retryable = value
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if retryable || stopping {
                if value.get("code").and_then(Value::as_str) == Some("HISTORY_SAVE_FAILED") {
                    let _ = app.emit(crate::events::CAPTION_STATUS_EVENT, serde_json::json!({ "state": "warning", "sessionId": session_id, "message": message, "code": "HISTORY_SAVE_FAILED" }));
                    return Ok(ServerMessageAction::Continue);
                }
                emit_status(
                    app,
                    SessionStatusEvent::warning(session_id, message.clone()),
                );
                if stopping && !retryable {
                    Ok(ServerMessageAction::RetainError(message))
                } else {
                    Ok(ServerMessageAction::Continue)
                }
            } else {
                Err(message)
            }
        }
        Some("session_started") => {
            if let Some(provider) = value.get("provider").and_then(Value::as_str) {
                crate::remember_provider(app, provider);
            }
            if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
                emit_status(app, SessionStatusEvent::capturing(id.to_string()));
            }
            Ok(ServerMessageAction::Continue)
        }
        Some("session_stopped") => Ok(ServerMessageAction::SessionStopped),
        Some(other) => Err(format!("unsupported gateway event: {other}")),
        None => Err("gateway response is missing a type".into()),
    }
}

fn audio_level(bytes: &[u8]) -> f64 {
    let count = bytes.len() / 2;
    if count == 0 {
        return 0.0;
    }
    let energy: f64 = bytes
        .chunks_exact(2)
        .map(|sample| {
            let value = f64::from(i16::from_le_bytes([sample[0], sample[1]])) / 32768.0;
            value * value
        })
        .sum();
    (energy / count as f64).sqrt()
}

#[cfg(test)]
mod tests {
    use super::{audio_level, drain_audio};
    use crate::audio::capture::AudioFrames;
    use crate::audio::capture::{AudioFrame, AudioFrameQueue};
    use std::sync::Arc;

    #[tokio::test]
    async fn failed_drain_stays_stopping_instead_of_repolling_consumed_cancellation() {
        use futures_util::Sink;
        use std::{
            pin::Pin,
            task::{Context, Poll},
        };
        struct Disconnected;
        impl Sink<super::Message> for Disconnected {
            type Error = &'static str;
            fn poll_ready(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Result<(), Self::Error>> {
                Poll::Ready(Err("disconnected"))
            }
            fn start_send(self: Pin<&mut Self>, _: super::Message) -> Result<(), Self::Error> {
                unreachable!()
            }
            fn poll_flush(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Result<(), Self::Error>> {
                Poll::Ready(Ok(()))
            }
            fn poll_close(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Result<(), Self::Error>> {
                Poll::Ready(Ok(()))
            }
        }
        let frames = Arc::new(AudioFrames::new(1));
        frames
            .push(AudioFrame {
                samples: vec![1; 160],
                sample_rate: 16000,
                channels: 1,
                timestamp_ms: 0,
            })
            .unwrap();
        let session = super::StreamSession {
            session_id: "test".into(),
            source_language: "en".into(),
            target_language: "en".into(),
            context_hint: String::new(),
            sample_rate: 16000,
            channels: 1,
        };
        let mut stopping = false;
        assert!(super::request_gateway_stop(
            &mut Disconnected,
            &session,
            &frames,
            &mut 0,
            &mut stopping
        )
        .await
        .is_err());
        assert!(stopping);
    }

    #[test]
    fn measures_pcm_activity_without_mistaking_silence_for_sound() {
        assert_eq!(audio_level(&[]), 0.0);
        assert_eq!(audio_level(&[0; 3200]), 0.0);
        assert!((audio_level(&[0, 64, 0, 192]) - 0.5).abs() < 0.0001);
    }

    #[test]
    fn drains_frames_as_little_endian_pcm() {
        let frames: AudioFrameQueue = Arc::new(AudioFrames::new(2));
        frames
            .push(AudioFrame {
                samples: vec![1, -2],
                sample_rate: 16_000,
                channels: 1,
                timestamp_ms: 40,
            })
            .expect("first frame should fit");
        frames
            .push(AudioFrame {
                samples: vec![i16::MAX],
                sample_rate: 16_000,
                channels: 1,
                timestamp_ms: 60,
            })
            .expect("second frame should fit");

        let (bytes, timestamp_ms) = drain_audio(&frames).expect("audio should be available");

        assert_eq!(timestamp_ms, 40);
        assert_eq!(
            bytes,
            [
                1_i16.to_le_bytes(),
                (-2_i16).to_le_bytes(),
                i16::MAX.to_le_bytes(),
            ]
            .concat()
        );
        assert!(frames.is_empty());
    }

    #[test]
    fn catches_up_old_audio_without_an_unbounded_send() {
        let frames = Arc::new(AudioFrames::new(10));
        frames.set_clock(std::time::Instant::now() - std::time::Duration::from_secs(1));
        for index in 0..10 {
            frames
                .push(AudioFrame {
                    samples: vec![index as i16; 1600],
                    sample_rate: 16000,
                    channels: 1,
                    timestamp_ms: index * 100,
                })
                .unwrap();
        }
        let (bytes, start) = drain_audio(&frames).unwrap();
        assert_eq!(start, 0);
        assert_eq!(bytes.len(), super::MAX_CATCHUP_BYTES);
        assert_eq!(frames.len(), 7);
        assert_eq!(drain_audio(&frames).unwrap().1, 300);
    }
}
