use super::{AudioCaptureBackend, AudioFrameQueue, CaptureConfig};

/// WASAPI loopback seam for Windows system-audio capture.
///
/// Implementation plan:
/// 1. Activate the default render endpoint with `IAudioClient` loopback mode.
/// 2. Read packets from `IAudioCaptureClient` on a dedicated high-priority thread.
/// 3. Resample the endpoint format to the shared PCM S16LE stream format.
/// 4. Push frames into the bounded audio ring buffer consumed by the stream manager.
pub struct WasapiBackend {
    running: bool,
}

impl WasapiBackend {
    pub fn new() -> Self {
        Self { running: false }
    }
}

impl AudioCaptureBackend for WasapiBackend {
    fn name(&self) -> &'static str {
        "wasapi-loopback"
    }
    fn start(&mut self, _config: &CaptureConfig, _frames: AudioFrameQueue) -> Result<(), String> {
        self.running = true;
        Err("WASAPI loopback backend is scaffolded; implement COM endpoint wiring next".into())
    }
    fn stop(&mut self) -> Result<(), String> {
        self.running = false;
        Ok(())
    }
}
