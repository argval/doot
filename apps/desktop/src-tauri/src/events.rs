use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const CAPTION_SEGMENT_EVENT: &str = "caption://segment";
pub const CAPTION_STATUS_EVENT: &str = "caption://status";
pub const CAPTURE_TOGGLE_EVENT: &str = "caption://toggle-request";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SessionStatusEvent {
    pub fn idle() -> Self {
        Self {
            state: "idle",
            session_id: None,
            message: None,
        }
    }

    pub fn capturing(session_id: String) -> Self {
        Self {
            state: "capturing",
            session_id: Some(session_id),
            message: None,
        }
    }

    pub fn warning(session_id: Option<String>, message: String) -> Self {
        Self {
            state: "warning",
            session_id,
            message: Some(message),
        }
    }

    pub fn error(session_id: Option<String>, message: String) -> Self {
        Self {
            state: "error",
            session_id,
            message: Some(message),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    pub sequence: u64,
    pub source_text: String,
    pub translated_text: String,
    pub is_final: bool,
    pub start_ms: u64,
    pub end_ms: u64,
    pub provider: String,
}

pub fn emit_status(app: &AppHandle, status: SessionStatusEvent) {
    let _ = app.emit(CAPTION_STATUS_EVENT, status);
}
