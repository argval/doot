#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use crossbeam_queue::ArrayQueue;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

const FRAME_QUEUE_CAPACITY: usize = 128;

#[derive(Debug, Clone, Serialize)]
pub struct AudioFrame {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
    pub timestamp_ms: u64,
}

pub type AudioFrameQueue = Arc<AudioFrames>;

pub struct AudioFrames {
    queue: ArrayQueue<AudioFrame>,
    dropped_ms: AtomicU64,
    error: Mutex<Option<String>>,
    clock: Mutex<Option<std::time::Instant>>,
}

impl AudioFrames {
    pub fn new(capacity: usize) -> Self {
        Self {
            queue: ArrayQueue::new(capacity),
            dropped_ms: AtomicU64::new(0),
            error: Mutex::new(None),
            clock: Mutex::new(None),
        }
    }
    pub fn set_clock(&self, start: std::time::Instant) {
        if let Ok(mut clock) = self.clock.lock() {
            *clock = Some(start);
        }
    }
    pub fn audio_lag_ms(&self, end_ms: u64) -> Option<u64> {
        self.clock
            .lock()
            .ok()?
            .as_ref()
            .and_then(|start| (start.elapsed().as_millis() as u64).checked_sub(end_ms))
    }
    pub fn fail(&self, message: String) {
        if let Ok(mut error) = self.error.lock() {
            *error = Some(message);
        }
    }
    pub fn capture_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|error| error.clone())
    }
    pub fn dropped_audio_ms(&self) -> u64 {
        self.dropped_ms.load(Ordering::Relaxed)
    }
    fn reset(&self) {
        while self.queue.pop().is_some() {}
        self.dropped_ms.store(0, Ordering::Relaxed);
        if let Ok(mut error) = self.error.lock() {
            *error = None;
        }
        if let Ok(mut clock) = self.clock.lock() {
            *clock = None;
        }
    }
}

impl std::ops::Deref for AudioFrames {
    type Target = ArrayQueue<AudioFrame>;
    fn deref(&self) -> &Self::Target {
        &self.queue
    }
}

pub fn audio_frame_start_ms(
    captured_at_ms: u64,
    sample_count: usize,
    sample_rate: u32,
    channels: u16,
) -> u64 {
    let samples_per_second = u64::from(sample_rate) * u64::from(channels.max(1));
    let duration_ms = (sample_count as u64 * 1_000).div_ceil(samples_per_second);
    captured_at_ms.saturating_sub(duration_ms)
}

pub fn push_latest_frame(queue: &AudioFrameQueue, frame: AudioFrame) {
    if let Err(frame) = queue.push(frame) {
        if let Some(dropped) = queue.pop() {
            let duration = dropped.samples.len() as u64 * 1000
                / (u64::from(dropped.sample_rate) * u64::from(dropped.channels.max(1)));
            queue.dropped_ms.fetch_add(duration, Ordering::Relaxed);
        }
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
            frames: Arc::new(AudioFrames::new(FRAME_QUEUE_CAPACITY)),
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        self.frames.reset();
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

    #[cfg(test)]
    pub fn with_backend(backend: Box<dyn AudioCaptureBackend>) -> Self {
        Self {
            backend,
            ..Self::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_keeps_latest_audio_and_reset_clears_loss_and_errors() {
        let frames = Arc::new(AudioFrames::new(1));
        for timestamp_ms in [0, 100] {
            push_latest_frame(
                &frames,
                AudioFrame {
                    samples: vec![0; 1600],
                    sample_rate: 16000,
                    channels: 1,
                    timestamp_ms,
                },
            );
        }
        assert_eq!(frames.dropped_audio_ms(), 100);
        assert_eq!(frames.pop().unwrap().timestamp_ms, 100);
        frames.fail("device disconnected".into());
        assert!(frames.capture_error().is_some());
        frames.reset();
        assert_eq!(frames.dropped_audio_ms(), 0);
        assert!(frames.capture_error().is_none());
    }

    #[test]
    fn derives_pcm_interval_start_from_capture_time() {
        assert_eq!(audio_frame_start_ms(500, 1_600, 16_000, 1), 400);
        assert_eq!(audio_frame_start_ms(50, 1_600, 16_000, 1), 0);
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
