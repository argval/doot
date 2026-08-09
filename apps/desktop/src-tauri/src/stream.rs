use crate::audio::capture::AudioFrameQueue;
use crate::events::{emit_status, CaptionEvent, SessionStatusEvent, CAPTION_SEGMENT_EVENT};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::{interval, sleep, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const GATEWAY_URL: &str = "ws://127.0.0.1:8787/v1/realtime";
const MAX_CHUNK_BYTES: usize = 3_200; // 100 ms @ 16 kHz mono S16LE — matches live capture pace
const MAX_RECONNECT_ATTEMPTS: u32 = 8;
const STOP_FINALIZATION_TIMEOUT: Duration = Duration::from_secs(45);

pub struct StreamSession {
    pub session_id: String,
    pub source_language: String,
    pub target_language: String,
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct StreamManager {
    stop_tx: Option<oneshot::Sender<()>>,
    done_rx: Option<oneshot::Receiver<()>>,
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
        tauri::async_runtime::spawn(async move {
            let result = run_stream(app.clone(), session, frames, stop_rx).await;
            running.store(false, Ordering::SeqCst);
            let _ = done_tx.send(());
            match result {
                Ok(()) => {
                    // Stream ended without an explicit UI stop (disconnect after
                    // reconnect budget, cancel during reconnect, etc.). Reset the
                    // overlay so we do not stick on "Listening…" with no socket.
                    emit_status(&app, SessionStatusEvent::idle());
                }
                Err(message) => {
                    emit_status(&app, SessionStatusEvent::error(Some(session_id), message));
                }
            }
        });
        Ok(())
    }

    pub fn request_stop(&mut self) -> Option<oneshot::Receiver<()>> {
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
        self
            .running
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
    let mut attempts = 0_u32;
    let mut stopping = false;
    let mut pending_error: Option<String> = None;

    loop {
        match run_stream_once(
            &app,
            &session,
            &frames,
            &mut stop_rx,
            &mut sequence,
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
                attempts = attempts.saturating_add(1);
                if attempts > MAX_RECONNECT_ATTEMPTS {
                    return Err(format!("caption gateway disconnected repeatedly: {reason}"));
                }
                let delay_ms = 250 * u64::from(attempts).min(4);
                emit_status(
                    &app,
                    SessionStatusEvent::warning(
                        Some(session.session_id.clone()),
                        format!("Reconnecting to caption gateway… ({attempts})"),
                    ),
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
    stopping: &mut bool,
    pending_error: &mut Option<String>,
) -> Result<StreamExit, String> {
    let (socket, _) = match connect_async(GATEWAY_URL).await {
        Ok(connected) => connected,
        Err(error) => {
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
        },
    )
    .await
    {
        return Ok(StreamExit::Disconnected(error));
    }

    emit_status(
        app,
        SessionStatusEvent::capturing(session.session_id.clone()),
    );

    let mut send_tick = interval(Duration::from_millis(100));
    let stop_timeout = sleep(Duration::from_secs(86_400));
    tokio::pin!(stop_timeout);
    if *stopping {
        if let Err(error) = flush_remaining_audio(&mut writer, session, frames, sequence).await {
            return Ok(StreamExit::Disconnected(error));
        }
        if let Err(error) = send_json(
            &mut writer,
            &StopSessionMessage {
                message_type: "stop_session",
                session_id: &session.session_id,
            },
        )
        .await
        {
            return Ok(StreamExit::Disconnected(error));
        }
        stop_timeout
            .as_mut()
            .reset(Instant::now() + STOP_FINALIZATION_TIMEOUT);
    }

    loop {
        tokio::select! {
            _ = &mut *stop_rx, if !*stopping => {
                if let Err(error) = flush_remaining_audio(
                    &mut writer,
                    session,
                    frames,
                    sequence,
                ).await {
                    return Ok(StreamExit::Disconnected(error));
                }
                if let Err(error) = send_json(
                    &mut writer,
                    &StopSessionMessage {
                        message_type: "stop_session",
                        session_id: &session.session_id,
                    },
                ).await {
                    return Ok(StreamExit::Disconnected(error));
                }
                *stopping = true;
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
                if let Some((audio, timestamp_ms)) = drain_audio(frames) {
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
                        match handle_server_message(app, text.as_ref(), *stopping) {
                            Ok(ServerMessageAction::Continue) => {}
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
                        if *stopping {
                            return Ok(StreamExit::Stopped);
                        }
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
    writer
        .send(Message::Text(serialized.into()))
        .await
        .map_err(|error| format!("caption gateway write failed: {error}"))
}

fn drain_audio(frames: &AudioFrameQueue) -> Option<(Vec<u8>, u64)> {
    let first = frames.pop()?;
    let timestamp_ms = first.timestamp_ms;
    let mut bytes = Vec::with_capacity(MAX_CHUNK_BYTES);
    append_samples(&mut bytes, &first.samples);

    while bytes.len() < MAX_CHUNK_BYTES {
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
    SessionStopped,
    RetainError(String),
}

fn handle_server_message(
    app: &AppHandle,
    raw: &str,
    stopping: bool,
) -> Result<ServerMessageAction, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid gateway response: {error}"))?;
    match value.get("type").and_then(Value::as_str) {
        Some("caption") => {
            let caption: CaptionEvent = serde_json::from_value(value)
                .map_err(|error| format!("invalid caption event: {error}"))?;
            if caption.utterance_id.is_empty() {
                return Err("caption event is missing utteranceId".into());
            }
            app.emit(CAPTION_SEGMENT_EVENT, caption)
                .map_err(|error| format!("failed to publish caption: {error}"))?;
            Ok(ServerMessageAction::Continue)
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
        Some("session_started") => Ok(ServerMessageAction::Continue),
        Some("session_stopped") => Ok(ServerMessageAction::SessionStopped),
        Some(other) => Err(format!("unsupported gateway event: {other}")),
        None => Err("gateway response is missing a type".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::drain_audio;
    use crate::audio::capture::{AudioFrame, AudioFrameQueue};
    use crossbeam_queue::ArrayQueue;
    use std::sync::Arc;

    #[test]
    fn drains_frames_as_little_endian_pcm() {
        let frames: AudioFrameQueue = Arc::new(ArrayQueue::new(2));
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
}
