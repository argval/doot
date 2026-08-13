use crate::audio::{AudioCaptureStatus, Language, SessionConfig};
use crate::events::{emit_status, SessionStatusEvent};
use crate::stream::GATEWAY_ADDR;
use crate::AppState;
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, State, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub source_language: String,
    pub target_language: String,
    pub provider: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub gateway_reachable: bool,
    pub capture: AudioCaptureStatus,
    pub last_provider: Option<String>,
}

#[tauri::command]
pub fn start_caption_session(
    app: AppHandle,
    state: State<'_, AppState>,
    source_language: String,
    target_language: String,
) -> Result<SessionInfo, String> {
    let config = SessionConfig {
        source_language: Language::parse(&source_language)?,
        target_language: Language::parse(&target_language)?,
    };
    let mut engine = state
        .audio_engine
        .lock()
        .map_err(|_| "audio engine lock poisoned")?;
    let session = match engine.start(app.clone(), config) {
        Ok(session) => session,
        Err(error) => {
            emit_status(&app, SessionStatusEvent::error(None, error.clone()));
            return Err(error);
        }
    };
    let info = SessionInfo {
        session_id: session.id().to_string(),
        source_language: session.config().source_language.to_string(),
        target_language: session.config().target_language.to_string(),
        provider: session.provider_name().to_string(),
    };
    crate::remember_provider(&app, &info.provider);
    emit_status(&app, SessionStatusEvent::capturing(info.session_id.clone()));
    Ok(info)
}

#[tauri::command]
pub async fn stop_caption_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let done_rx = {
        let mut engine = state
            .audio_engine
            .lock()
            .map_err(|_| "audio engine lock poisoned")?;
        engine.prepare_stop(&session_id)?
    };

    if let Some(done_rx) = done_rx {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(45), done_rx).await;
    }

    {
        let mut engine = state
            .audio_engine
            .lock()
            .map_err(|_| "audio engine lock poisoned")?;
        engine.finish_stop(&session_id)?;
    }

    emit_status(&app, SessionStatusEvent::idle());
    Ok(())
}

#[tauri::command]
pub fn set_overlay_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn audio_capture_status(state: State<'_, AppState>) -> Result<AudioCaptureStatus, String> {
    let engine = state
        .audio_engine
        .lock()
        .map_err(|_| "audio engine lock poisoned")?;
    Ok(engine.capture_status())
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let capture = {
        let engine = state
            .audio_engine
            .lock()
            .map_err(|_| "audio engine lock poisoned")?;
        engine.capture_status()
    };
    let last_provider = state
        .last_provider
        .lock()
        .map_err(|_| "last provider lock poisoned")?
        .clone();
    Ok(ConnectionStatus {
        gateway_reachable: probe_gateway().await,
        capture,
        last_provider,
    })
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    crate::open_settings(&app)
}

async fn probe_gateway() -> bool {
    let connect = tokio::time::timeout(
        Duration::from_millis(700),
        tokio::net::TcpStream::connect(GATEWAY_ADDR),
    )
    .await;
    let Ok(Ok(mut stream)) = connect else {
        return false;
    };
    let request = b"GET /health HTTP/1.0\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).await.is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match tokio::time::timeout(Duration::from_millis(700), stream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => {
            let body = String::from_utf8_lossy(&buf[..n]);
            body.contains("200") || body.contains("\"ok\"")
        }
        _ => false,
    }
}
