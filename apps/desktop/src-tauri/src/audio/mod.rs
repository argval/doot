pub mod capture;

use crate::stream::{StreamManager, StreamSession};
use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Auto,
    En,
    Es,
    Fr,
    De,
    Pt,
    It,
    Hi,
    Bn,
    Gu,
    Kn,
    Ml,
    Mr,
    Od,
    Pa,
    Ta,
    Te,
    As,
    Ur,
    Ne,
    Kok,
    Ks,
    Sd,
    Sa,
    Sat,
    Mni,
    Brx,
    Mai,
    Doi,
}

impl Language {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(Self::Auto),
            "en" => Ok(Self::En),
            "es" => Ok(Self::Es),
            "fr" => Ok(Self::Fr),
            "de" => Ok(Self::De),
            "pt" => Ok(Self::Pt),
            "it" => Ok(Self::It),
            "hi" => Ok(Self::Hi),
            "bn" => Ok(Self::Bn),
            "gu" => Ok(Self::Gu),
            "kn" => Ok(Self::Kn),
            "ml" => Ok(Self::Ml),
            "mr" => Ok(Self::Mr),
            "od" => Ok(Self::Od),
            "pa" => Ok(Self::Pa),
            "ta" => Ok(Self::Ta),
            "te" => Ok(Self::Te),
            "as" => Ok(Self::As),
            "ur" => Ok(Self::Ur),
            "ne" => Ok(Self::Ne),
            "kok" => Ok(Self::Kok),
            "ks" => Ok(Self::Ks),
            "sd" => Ok(Self::Sd),
            "sa" => Ok(Self::Sa),
            "sat" => Ok(Self::Sat),
            "mni" => Ok(Self::Mni),
            "brx" => Ok(Self::Brx),
            "mai" => Ok(Self::Mai),
            "doi" => Ok(Self::Doi),
            other => Err(format!("unsupported language: {other}")),
        }
    }
}

impl std::fmt::Display for Language {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Auto => "auto",
            Self::En => "en",
            Self::Es => "es",
            Self::Fr => "fr",
            Self::De => "de",
            Self::Pt => "pt",
            Self::It => "it",
            Self::Hi => "hi",
            Self::Bn => "bn",
            Self::Gu => "gu",
            Self::Kn => "kn",
            Self::Ml => "ml",
            Self::Mr => "mr",
            Self::Od => "od",
            Self::Pa => "pa",
            Self::Ta => "ta",
            Self::Te => "te",
            Self::As => "as",
            Self::Ur => "ur",
            Self::Ne => "ne",
            Self::Kok => "kok",
            Self::Ks => "ks",
            Self::Sd => "sd",
            Self::Sa => "sa",
            Self::Sat => "sat",
            Self::Mni => "mni",
            Self::Brx => "brx",
            Self::Mai => "mai",
            Self::Doi => "doi",
        };
        formatter.write_str(value)
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
            "auto", "en", "es", "fr", "de", "pt", "it", "hi", "bn", "gu", "kn", "ml", "mr", "od",
            "pa", "ta", "te", "as", "ur", "ne", "kok", "ks", "sd", "sa", "sat", "mni", "brx",
            "mai", "doi",
        ] {
            let language = Language::parse(code).expect("language should parse");
            assert_eq!(language.to_string(), code);
        }
    }
}
