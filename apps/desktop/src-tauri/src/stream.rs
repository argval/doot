use crate::audio::capture::AudioFrameQueue;
use crate::events::{emit_status, CaptionEvent, SessionStatusEvent, CAPTION_SEGMENT_EVENT};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::{interval, sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const GATEWAY_URL: &str = "ws://127.0.0.1:8787/v1/realtime";
const MAX_CHUNK_BYTES: usize = 3_200; // 100 ms @ 16 kHz mono S16LE — matches live capture pace
const MAX_RECONNECT_ATTEMPTS: u32 = 8;

pub struct StreamSession {
    pub session_id: String,
    pub source_language: String,
    pub target_language: String,
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct StreamManager {
    stop_tx: Option<oneshot::Sender<()>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self { stop_tx: None }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        session: StreamSession,
        frames: AudioFrameQueue,
    ) -> Result<(), String> {
        if self.stop_tx.is_some() {
            return Err("audio stream is already running".into());
        }

        let session_id = session.session_id.clone();
        let (stop_tx, stop_rx) = oneshot::channel();
        self.stop_tx = Some(stop_tx);
        tauri::async_runtime::spawn(async move {
            if let Err(message) = run_stream(app.clone(), session, frames, stop_rx).await {
                emit_status(&app, SessionStatusEvent::error(Some(session_id), message));
            }
        });
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
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

    loop {
        match run_stream_once(&app, &session, &frames, &mut stop_rx, &mut sequence).await {
            Ok(StreamExit::Stopped) => return Ok(()),
            Ok(StreamExit::Disconnected(reason)) => {
                attempts = attempts.saturating_add(1);
                if attempts > MAX_RECONNECT_ATTEMPTS {
                    return Err(format!(
                        "caption gateway disconnected repeatedly: {reason}"
                    ));
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
    loop {
        tokio::select! {
            _ = &mut *stop_rx => {
                let _ = send_json(
                    &mut writer,
                    &StopSessionMessage {
                        message_type: "stop_session",
                        session_id: &session.session_id,
                    },
                ).await;
                let _ = writer.close().await;
                return Ok(StreamExit::Stopped);
            }
            _ = send_tick.tick() => {
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
                        if let Err(error) = handle_server_message(app, text.as_ref()) {
                            return Err(error);
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

fn handle_server_message(app: &AppHandle, raw: &str) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid gateway response: {error}"))?;
    match value.get("type").and_then(Value::as_str) {
        Some("caption") => {
            let caption: CaptionEvent = serde_json::from_value(value)
                .map_err(|error| format!("invalid caption event: {error}"))?;
            app.emit(CAPTION_SEGMENT_EVENT, caption)
                .map_err(|error| format!("failed to publish caption: {error}"))
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
            if retryable {
                emit_status(app, SessionStatusEvent::warning(session_id, message));
                Ok(())
            } else {
                Err(message)
            }
        }
        Some("session_started" | "session_stopped") => Ok(()),
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
