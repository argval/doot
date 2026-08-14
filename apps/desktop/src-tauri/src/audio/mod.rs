pub mod capture;
pub mod convert;

use crate::stream::{StreamManager, StreamSession};
use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

// Keep in sync with packages/protocol INTERNATIONAL_LANGUAGES + INDIC_LANGUAGES.
const SUPPORTED_LANGUAGES: &[&str] = &[
    "auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ar", "ru", "nl", "pl", "tr",
    "vi", "th", "id", "af", "ak", "sq", "am", "hy", "az", "eu", "be", "bg", "my", "ca", "hr",
    "cs", "da", "et", "fil", "fi", "gl", "ka", "el", "ha", "he", "hu", "is", "jv", "kk", "km",
    "rw", "lo", "lv", "lt", "mk", "ms", "mn", "no", "fa", "ro", "sr", "si", "sk", "sl", "su",
    "sw", "sv", "uk", "uz", "zu", "hi", "bn", "gu", "kn", "ml", "mr", "od", "pa", "ta", "te",
    "as", "ur", "ne", "kok", "ks", "sd", "sa", "sat", "mni", "brx", "mai", "doi",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Language(String);

impl Language {
    pub fn parse(value: &str) -> Result<Self, String> {
        if SUPPORTED_LANGUAGES.contains(&value) {
            Ok(Self(value.to_string()))
        } else {
            Err(format!("unsupported language: {value}"))
        }
    }
}

impl std::fmt::Display for Language {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub source_language: Language,
    pub target_language: Language,
}

#[derive(Debug)]
pub struct CaptionSession {
    id: Uuid,
    config: SessionConfig,
    provider_name: String,
}

impl CaptionSession {
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }
    pub fn provider_name(&self) -> &str {
        &self.provider_name
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureStatus {
    pub state: String,
    pub backend: String,
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct AudioEngine {
    capture: capture::AudioCapture,
    stream_manager: StreamManager,
    active_session: Option<CaptionSession>,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self {
            capture: capture::AudioCapture::new(),
            stream_manager: StreamManager::new(),
            active_session: None,
        }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        config: SessionConfig,
    ) -> Result<&CaptionSession, String> {
        // A prior stream task may have exited while leaving session bookkeeping
        // behind; clear that before accepting a new capture.
        self.stream_manager.clear_if_finished();
        if self.stream_manager.is_active() {
            return Err("a caption session is already running".into());
        }
        if self.active_session.is_some() {
            let _ = self.capture.stop();
            self.active_session = None;
        }
        let session_id = Uuid::new_v4();
        // Provider selection belongs to the gateway and is resolved after this
        // synchronous command returns.
        let provider_name = "automatic".to_string();
        let source_language = config.source_language.to_string();
        let target_language = config.target_language.to_string();

        self.capture.start()?;
        let capture_config = self.capture.config();
        if let Err(error) = self.stream_manager.start(
            app,
            StreamSession {
                session_id: session_id.to_string(),
                source_language,
                target_language,
                sample_rate: capture_config.sample_rate,
                channels: capture_config.channels,
            },
            self.capture.frames(),
        ) {
            let _ = self.capture.stop();
            return Err(error);
        }

        self.active_session = Some(CaptionSession {
            id: session_id,
            config,
            provider_name,
        });
        Ok(self
            .active_session
            .as_ref()
            .expect("session was just created"))
    }

    pub fn prepare_stop(
        &mut self,
        session_id: &str,
    ) -> Result<Option<tokio::sync::oneshot::Receiver<()>>, String> {
        match &self.active_session {
            Some(session) if session.id().to_string() == session_id => {}
            Some(_) => return Err("session id does not match the active session".into()),
            None => return Err("no active caption session".into()),
        }
        // Stop capture first so no new frames arrive, then ask the stream task to
        // drain residual PCM, flush the provider, and wait for session_stopped.
        let capture_result = self.capture.stop();
        let done_rx = self.stream_manager.request_stop();
        capture_result?;
        Ok(done_rx)
    }

    pub fn finish_stop(&mut self, session_id: &str) -> Result<(), String> {
        match &self.active_session {
            Some(session) if session.id().to_string() == session_id => {
                self.active_session = None;
                Ok(())
            }
            Some(_) => Err("session id does not match the active session".into()),
            None => Ok(()),
        }
    }

    pub fn capture_status(&self) -> AudioCaptureStatus {
        self.capture.status()
    }
}

#[cfg(test)]
mod tests {
    use super::Language;

    #[test]
    fn parses_and_serializes_every_supported_language() {
        for code in [
            "auto", "en", "es", "fr", "de", "hi", "bn", "gu", "kn", "ml", "mr", "od",
            "pa", "ta", "te", "as", "ur", "ne", "kok", "ks", "sd", "sa", "sat", "mni", "brx",
            "mai", "doi",
        ] {
            let language = Language::parse(code).expect("language should parse");
            assert_eq!(language.to_string(), code);
        }
        for code in ["it", "pt", "ja", "zh", "ar", "fil", "no"] {
            let language = Language::parse(code).expect("language should parse");
            assert_eq!(language.to_string(), code);
        }
    }
}
