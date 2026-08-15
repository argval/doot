use super::{
    audio_frame_start_ms, push_latest_frame, AudioCaptureBackend, AudioFrame, AudioFrameQueue,
    CaptureConfig,
};
use screencapturekit::prelude::*;
use std::time::Instant;

/// ScreenCaptureKit seam for macOS system-audio capture.
///
/// Implementation plan:
/// 1. Ask for screen-recording permission and enumerate shareable content.
/// 2. Create an `SCStream` with audio enabled and video disabled.
/// 3. Convert `CMSampleBuffer` audio to mono PCM S16LE at `CaptureConfig`.
/// 4. Push frames into the bounded audio ring buffer consumed by the stream manager.
pub struct ScreenCaptureKitBackend {
    running: bool,
    stream: Option<SCStream>,
}

impl ScreenCaptureKitBackend {
    pub fn new() -> Self {
        Self {
            running: false,
            stream: None,
        }
    }
}

impl AudioCaptureBackend for ScreenCaptureKitBackend {
    fn name(&self) -> &'static str {
        "screencapturekit"
    }

    fn start(&mut self, config: &CaptureConfig, frames: AudioFrameQueue) -> Result<(), String> {
        if self.running {
            return Err("ScreenCaptureKit capture is already running".into());
        }

        let content = SCShareableContent::get().map_err(|error| {
            format!("Screen & System Audio Recording permission is required: {error}")
        })?;
        let displays = content.displays();
        let display = displays
            .first()
            .ok_or_else(|| "ScreenCaptureKit found no display to capture".to_string())?;
        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build();
        let stream_config = SCStreamConfiguration::new()
            .with_captures_audio(config.include_system_audio)
            .with_sample_rate(config.sample_rate as i32)
            .with_channel_count(config.channels as i32);

        let mut stream = SCStream::new(&filter, &stream_config);
        let handler = SystemAudioHandler {
            frames,
            started_at: Instant::now(),
            sample_rate: config.sample_rate,
            channels: config.channels,
        };
        stream
            .add_output_handler(handler, SCStreamOutputType::Audio)
            .ok_or_else(|| {
                "ScreenCaptureKit rejected the system-audio output handler".to_string()
            })?;
        stream
            .start_capture()
            .map_err(|error| format!("failed to start ScreenCaptureKit: {error}"))?;

        self.stream = Some(stream);
        self.running = true;
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        let result = if let Some(stream) = self.stream.take() {
            stream
                .stop_capture()
                .map_err(|error| format!("failed to stop ScreenCaptureKit: {error}"))
        } else {
            Ok(())
        };
        self.running = false;
        result
    }
}

struct SystemAudioHandler {
    frames: AudioFrameQueue,
    started_at: Instant,
    sample_rate: u32,
    channels: u16,
}

impl SCStreamOutputTrait for SystemAudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, output_type: SCStreamOutputType) {
        if output_type != SCStreamOutputType::Audio {
            return;
        }

        let Some(buffer_list) = sample.audio_buffer_list() else {
            return;
        };
        let samples = float_audio_to_mono_i16(&buffer_list);
        if samples.is_empty() {
            return;
        }
        let timestamp_ms = audio_frame_start_ms(
            self.started_at.elapsed().as_millis() as u64,
            samples.len(),
            self.sample_rate,
            self.channels,
        );

        push_latest_frame(
            &self.frames,
            AudioFrame {
                samples,
                sample_rate: self.sample_rate,
                channels: self.channels,
                timestamp_ms,
            },
        );
    }
}

fn float_audio_to_mono_i16(buffer_list: &screencapturekit::cm::AudioBufferList) -> Vec<i16> {
    let buffers: Vec<_> = buffer_list.iter().collect();
    if buffers.is_empty() {
        return Vec::new();
    }

    if buffers.len() == 1 {
        let buffer = buffers[0];
        let channel_count = buffer.number_channels.max(1) as usize;
        let samples = decode_f32_samples(buffer.data());
        return samples
            .chunks(channel_count)
            .map(|frame| f32_to_i16(frame.iter().sum::<f32>() / frame.len() as f32))
            .collect();
    }

    let channels: Vec<Vec<f32>> = buffers
        .iter()
        .map(|buffer| decode_f32_samples(buffer.data()))
        .collect();
    let frame_count = channels.iter().map(Vec::len).min().unwrap_or(0);
    (0..frame_count)
        .map(|index| {
            let mixed =
                channels.iter().map(|channel| channel[index]).sum::<f32>() / channels.len() as f32;
            f32_to_i16(mixed)
        })
        .collect()
}

fn decode_f32_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(size_of::<f32>())
        .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn f32_to_i16(sample: f32) -> i16 {
    let scaled = sample.clamp(-1.0, 1.0) * i16::MAX as f32;
    scaled.round() as i16
}
