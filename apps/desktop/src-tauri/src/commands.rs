use crate::audio::{AudioCaptureStatus, Language, SessionConfig};
use crate::events::{emit_status, SessionStatusEvent};
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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
    pub capture: AudioCaptureStatus,
    pub last_provider: Option<String>,
    pub audio_permission: &'static str,
}

#[tauri::command]
pub async fn start_caption_session(
    app: AppHandle,
    state: State<'_, AppState>,
    source_language: String,
    target_language: String,
) -> Result<SessionInfo, String> {
    let mut gateway = state.gateway.lock().await;
    if state.exiting.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Doot is quitting.".into());
    }
    gateway.ensure(&app).await?;
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

    emit_status(
        &app,
        SessionStatusEvent {
            state: "finalizing",
            session_id: Some(session_id.clone()),
            message: Some("Finalizing captions…".into()),
        },
    );

    if let Some(done_rx) = done_rx {
        tokio::time::timeout(std::time::Duration::from_secs(50), done_rx)
            .await
            .map_err(|_| "Caption finalization timed out. Try stopping again.".to_string())?
            .map_err(|_| "Caption stream exited without a final result.".to_string())??;
    }

    {
        let mut engine = state
            .audio_engine
            .lock()
            .map_err(|_| "audio engine lock poisoned")?;
        engine.finish_stop(&session_id)?;
    }

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
pub async fn check_system_audio(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Doot is quitting.".into());
        }
        let mut engine = state
            .audio_engine
            .lock()
            .map_err(|_| "Audio engine unavailable")?;
        engine.check_audio(std::time::Duration::from_secs(3))
    })
    .await
    .map_err(|_| "Audio check failed".to_string())?
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
        capture,
        last_provider,
        audio_permission: audio_permission(),
    })
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    crate::open_settings(&app)
}

#[tauri::command]
pub fn set_overlay_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Overlay unavailable")?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    app.state::<AppState>()
        .click_through
        .store(enabled, std::sync::atomic::Ordering::SeqCst);
    let _ = app.emit("overlay://click-through", enabled);
    Ok(())
}

#[tauri::command]
pub fn move_overlay(app: AppHandle, direction: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Overlay unavailable")?;
    let mut position = window.outer_position().map_err(|e| e.to_string())?;
    let step = (10.0 * window.scale_factor().map_err(|e| e.to_string())?) as i32;
    match direction.as_str() {
        "left" => position.x -= step,
        "right" => position.x += step,
        "up" => position.y -= step,
        "down" => position.y += step,
        "reset" => {
            set_overlay_click_through(app.clone(), false)?;
            window.center().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        _ => return Err("Invalid overlay direction".into()),
    }
    window.set_position(position).map_err(|e| e.to_string())
}

fn audio_permission() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
        }
        if unsafe { CGPreflightScreenCaptureAccess() } {
            "granted"
        } else {
            "required"
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "not-required"
    }
}

#[tauri::command]
pub fn open_audio_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:sound"])
        .spawn();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        result.map(|_| ()).map_err(|error| error.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Open your system audio settings manually.".into())
    }
}
