use crate::audio::{AudioCaptureStatus, Language, SessionConfig};
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub source_language: String,
    pub target_language: String,
    pub provider: String,
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
    let mut engine = state.audio_engine.lock().map_err(|_| "audio engine lock poisoned")?;
    let session = engine.start(config)?;
    let info = SessionInfo {
        session_id: session.id().to_string(),
        source_language: session.config().source_language.to_string(),
        target_language: session.config().target_language.to_string(),
        provider: session.provider_name().to_string(),
    };
    let _ = app.emit("caption://status", &info);
    Ok(info)
}

#[tauri::command]
pub fn stop_caption_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut engine = state.audio_engine.lock().map_err(|_| "audio engine lock poisoned")?;
    engine.stop(&session_id)
}

#[tauri::command]
pub fn set_overlay_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn audio_capture_status(state: State<'_, AppState>) -> Result<AudioCaptureStatus, String> {
    let engine = state.audio_engine.lock().map_err(|_| "audio engine lock poisoned")?;
    Ok(engine.capture_status())
}
