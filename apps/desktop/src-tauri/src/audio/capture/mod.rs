#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use crossbeam_queue::ArrayQueue;
use serde::Serialize;
use std::sync::Arc;

const FRAME_QUEUE_CAPACITY: usize = 128;

#[derive(Debug, Clone, Serialize)]
pub struct AudioFrame {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
    pub timestamp_ms: u64,
}

pub type AudioFrameQueue = Arc<ArrayQueue<AudioFrame>>;

pub fn push_latest_frame(queue: &AudioFrameQueue, frame: AudioFrame) {
    if let Err(frame) = queue.push(frame) {
        let _ = queue.pop();
        let _ = queue.push(frame);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub include_system_audio: bool,
}

pub trait AudioCaptureBackend: Send {
    fn name(&self) -> &'static str;
    fn start(&mut self, config: &CaptureConfig, frames: AudioFrameQueue) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
}

pub struct AudioCapture {
    backend: Box<dyn AudioCaptureBackend>,
    status: String,
    config: CaptureConfig,
    frames: AudioFrameQueue,
}

impl AudioCapture {
    pub fn new() -> Self {
        Self {
            backend: platform_backend(),
            status: "idle".to_string(),
            config: CaptureConfig {
                sample_rate: 16_000,
                channels: 1,
                include_system_audio: true,
            },
            frames: Arc::new(ArrayQueue::new(FRAME_QUEUE_CAPACITY)),
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        while self.frames.pop().is_some() {}
        self.backend.start(&self.config, Arc::clone(&self.frames))?;
        self.status = "capturing".to_string();
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.backend.stop()?;
        self.status = "idle".to_string();
        Ok(())
    }

    pub fn status(&self) -> super::AudioCaptureStatus {
        super::AudioCaptureStatus {
            state: self.status.clone(),
            backend: self.backend.name().to_string(),
            sample_rate: self.config.sample_rate,
            channels: self.config.channels,
        }
    }

    pub fn frames(&self) -> AudioFrameQueue {
        Arc::clone(&self.frames)
    }

    pub fn config(&self) -> &CaptureConfig {
        &self.config
    }
}

#[cfg(target_os = "macos")]
fn platform_backend() -> Box<dyn AudioCaptureBackend> {
    Box::new(macos::ScreenCaptureKitBackend::new())
}

#[cfg(target_os = "windows")]
fn platform_backend() -> Box<dyn AudioCaptureBackend> {
    Box::new(windows::WasapiBackend::new())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_backend() -> Box<dyn AudioCaptureBackend> {
    Box::new(StubBackend)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct StubBackend;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl AudioCaptureBackend for StubBackend {
    fn name(&self) -> &'static str {
        "stub"
    }
    fn start(&mut self, _config: &CaptureConfig, _frames: AudioFrameQueue) -> Result<(), String> {
        Ok(())
    }
    fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }
}
