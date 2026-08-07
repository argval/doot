pub mod capture;

use crate::providers::ProviderRouter;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Auto,
    En,
    Hi,
    Ta,
    Te,
    Bn,
    Mr,
    Es,
    Fr,
    De,
}

impl Language {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(Self::Auto),
            "en" => Ok(Self::En), "hi" => Ok(Self::Hi), "ta" => Ok(Self::Ta),
            "te" => Ok(Self::Te), "bn" => Ok(Self::Bn), "mr" => Ok(Self::Mr),
            "es" => Ok(Self::Es), "fr" => Ok(Self::Fr), "de" => Ok(Self::De),
            other => Err(format!("unsupported language: {other}")),
        }
    }
}

impl std::fmt::Display for Language {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self { Self::Auto => "auto", Self::En => "en", Self::Hi => "hi", Self::Ta => "ta", Self::Te => "te", Self::Bn => "bn", Self::Mr => "mr", Self::Es => "es", Self::Fr => "fr", Self::De => "de" };
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
    pub fn id(&self) -> Uuid { self.id }
    pub fn config(&self) -> &SessionConfig { &self.config }
    pub fn provider_name(&self) -> &str { &self.provider_name }
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
    provider_router: ProviderRouter,
    active_session: Option<CaptionSession>,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self { capture: capture::AudioCapture::new(), provider_router: ProviderRouter::default(), active_session: None }
    }

    pub fn start(&mut self, config: SessionConfig) -> Result<&CaptionSession, String> {
        if self.active_session.is_some() { return Err("a caption session is already running".into()); }
        self.capture.start()?;
        let provider = self.provider_router.select(&config.source_language, &config.target_language);
        self.active_session = Some(CaptionSession { id: Uuid::new_v4(), config, provider_name: provider.name().to_string() });
        Ok(self.active_session.as_ref().expect("session was just created"))
    }

    pub fn stop(&mut self, session_id: &str) -> Result<(), String> {
        match &self.active_session {
            Some(session) if session.id().to_string() == session_id => {},
            Some(_) => return Err("session id does not match the active session".into()),
            None => return Err("no active caption session".into()),
        }
        self.capture.stop()?;
        self.active_session = None;
        Ok(())
    }

    pub fn capture_status(&self) -> AudioCaptureStatus { self.capture.status() }
}
