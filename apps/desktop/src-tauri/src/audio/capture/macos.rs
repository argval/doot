use super::{AudioCaptureBackend, CaptureConfig};

/// ScreenCaptureKit seam for macOS system-audio capture.
///
/// Implementation plan:
/// 1. Ask for screen-recording permission and enumerate shareable content.
/// 2. Create an `SCStream` with audio enabled and video disabled.
/// 3. Convert `CMSampleBuffer` audio to mono PCM S16LE at `CaptureConfig`.
/// 4. Push frames into the bounded audio ring buffer consumed by the stream manager.
pub struct ScreenCaptureKitBackend {
    running: bool,
}

impl ScreenCaptureKitBackend { pub fn new() -> Self { Self { running: false } } }

impl AudioCaptureBackend for ScreenCaptureKitBackend {
    fn name(&self) -> &'static str { "screencapturekit" }
    fn start(&mut self, _config: &CaptureConfig) -> Result<(), String> {
        self.running = true;
        Err("ScreenCaptureKit backend is scaffolded; implement permission and SCStream wiring next".into())
    }
    fn stop(&mut self) -> Result<(), String> { self.running = false; Ok(()) }
}
