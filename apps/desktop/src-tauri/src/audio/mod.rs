pub mod capture;
pub mod convert;

use crate::stream::{StreamManager, StreamSession};
use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

// Keep in sync with packages/protocol INTERNATIONAL_LANGUAGES + INDIC_LANGUAGES.
const SUPPORTED_LANGUAGES: &[&str] = &[
    "auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ar", "ru", "nl", "pl", "tr",
    "vi", "th", "id", "af", "ak", "sq", "am", "hy", "az", "eu", "be", "bg", "my", "ca", "hr", "cs",
    "da", "et", "fil", "fi", "gl", "ka", "el", "ha", "he", "hu", "is", "jv", "kk", "km", "rw",
    "lo", "lv", "lt", "mk", "ms", "mn", "no", "fa", "ro", "sr", "si", "sk", "sl", "su", "sw", "sv",
    "uk", "uz", "zu", "hi", "bn", "gu", "kn", "ml", "mr", "od", "pa", "ta", "te", "as", "ur", "ne",
    "kok", "ks", "sd", "sa", "sat", "mni", "brx", "mai", "doi",
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
    pub context_hint: String,
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
        let context_hint = config.context_hint.clone();

        self.capture.start()?;
        let capture_config = self.capture.config();
        if let Err(error) = self.stream_manager.start(
            app,
            StreamSession {
                session_id: session_id.to_string(),
                source_language,
                target_language,
                context_hint,
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
    ) -> Result<Option<tokio::sync::oneshot::Receiver<Result<(), String>>>, String> {
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

    /// The stream task owns terminal cleanup, including error and disconnect paths.
    pub fn complete_stream(&mut self, session_id: &str) -> Result<bool, String> {
        if self
            .active_session
            .as_ref()
            .is_none_or(|session| session.id().to_string() != session_id)
        {
            return Ok(false);
        }
        let stopped = self.capture.stop();
        self.active_session = None;
        stopped?;
        Ok(true)
    }

    pub fn capture_status(&self) -> AudioCaptureStatus {
        self.capture.status()
    }

    pub fn is_active(&self) -> bool {
        self.stream_manager.is_active()
    }

    pub fn request_shutdown(&mut self) {
        let _ = self.capture.stop();
        self.stream_manager.request_stop();
    }

    pub fn check_audio(&mut self, duration: std::time::Duration) -> Result<bool, String> {
        if self.is_active() {
            return Err("Stop captions before checking audio.".into());
        }
        self.capture.start()?;
        std::thread::sleep(duration);
        let stopped = self.capture.stop();
        let frames = self.capture.frames();
        let mut heard = false;
        while let Some(frame) = frames.pop() {
            heard |= frame
                .samples
                .iter()
                .any(|sample| i32::from(*sample).abs() > 32);
        }
        stopped?;
        if let Some(error) = frames.capture_error() {
            return Err(error);
        }
        Ok(heard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct TestCapture(Arc<AtomicUsize>);
    impl capture::AudioCaptureBackend for TestCapture {
        fn name(&self) -> &'static str {
            "test"
        }
        fn start(
            &mut self,
            _: &capture::CaptureConfig,
            frames: capture::AudioFrameQueue,
        ) -> Result<(), String> {
            capture::push_latest_frame(
                &frames,
                capture::AudioFrame {
                    samples: vec![16_000; 160],
                    sample_rate: 16000,
                    channels: 1,
                    timestamp_ms: 0,
                },
            );
            Ok(())
        }
        fn stop(&mut self) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn ending_a_stream_stops_capture_and_does_not_end_a_newer_session() {
        let mut engine = AudioEngine::new();
        let stops = Arc::new(AtomicUsize::new(0));
        engine.capture =
            capture::AudioCapture::with_backend(Box::new(TestCapture(Arc::clone(&stops))));
        engine.capture.start().unwrap();
        let id = Uuid::new_v4();
        engine.active_session = Some(CaptionSession {
            id,
            config: SessionConfig {
                source_language: Language::parse("en").unwrap(),
                target_language: Language::parse("en").unwrap(),
                context_hint: String::new(),
            },
            provider_name: "mock".into(),
        });
        assert!(!engine.complete_stream(&Uuid::new_v4().to_string()).unwrap());
        assert!(engine.active_session.is_some());
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        assert!(engine.complete_stream(&id.to_string()).unwrap());
        assert!(engine.active_session.is_none());
        assert_eq!(engine.capture_status().state, "idle");
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert!(!engine.complete_stream(&id.to_string()).unwrap());
    }

    #[test]
    fn local_audio_check_stops_and_discards_audio_without_opening_a_session() {
        let mut engine = AudioEngine::new();
        let stops = Arc::new(AtomicUsize::new(0));
        engine.capture =
            capture::AudioCapture::with_backend(Box::new(TestCapture(Arc::clone(&stops))));
        assert!(engine.check_audio(std::time::Duration::ZERO).unwrap());
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert!(engine.active_session.is_none());
        assert!(engine.capture.frames().is_empty());
    }

    #[test]
    fn parses_and_serializes_every_supported_language() {
        for code in [
            "auto", "en", "es", "fr", "de", "hi", "bn", "gu", "kn", "ml", "mr", "od", "pa", "ta",
            "te", "as", "ur", "ne", "kok", "ks", "sd", "sa", "sat", "mni", "brx", "mai", "doi",
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
