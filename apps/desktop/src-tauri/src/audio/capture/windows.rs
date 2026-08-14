use super::{push_latest_frame, AudioCaptureBackend, AudioFrame, AudioFrameQueue, CaptureConfig};
use crate::audio::convert::{to_mono_i16, PcmFormat, SampleEncoding};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

const INIT_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(4);
const RECONNECT_DELAY: Duration = Duration::from_millis(250);
const BUFFER_DURATION_HNS: i64 = 2_000_000; // 200 ms
const AUDCLNT_E_DEVICE_INVALIDATED: u32 = 0x8889_0004;

struct MixFormat {
    pcm: PcmFormat,
    block_align: u16,
}

/// WASAPI shared-mode loopback of the default render endpoint.
pub struct WasapiBackend {
    stop: Option<Arc<AtomicBool>>,
    thread: Option<JoinHandle<()>>,
}

impl WasapiBackend {
    pub fn new() -> Self {
        Self {
            stop: None,
            thread: None,
        }
    }
}

impl AudioCaptureBackend for WasapiBackend {
    fn name(&self) -> &'static str {
        "wasapi-loopback"
    }

    fn start(&mut self, config: &CaptureConfig, frames: AudioFrameQueue) -> Result<(), String> {
        if self.thread.is_some() {
            return Err("WASAPI capture is already running".into());
        }
        if !config.include_system_audio {
            return Err("WASAPI loopback captures system audio only".into());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let capture_config = config.clone();
        let (init_tx, init_rx) = sync_channel::<Result<(), String>>(1);

        let thread = thread::Builder::new()
            .name("doot-wasapi".into())
            .spawn(move || capture_loop(capture_config, frames, thread_stop, init_tx))
            .map_err(|error| format!("failed to start WASAPI capture thread: {error}"))?;

        match init_rx.recv_timeout(INIT_TIMEOUT) {
            Ok(Ok(())) => {
                self.stop = Some(stop);
                self.thread = Some(thread);
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(RecvTimeoutError::Timeout) => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                Err("WASAPI capture did not start within 8s".into())
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = thread.join();
                Err("WASAPI capture thread exited before becoming ready".into())
            }
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::SeqCst);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.stop = None;
        Ok(())
    }
}

struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

fn capture_loop(
    config: CaptureConfig,
    frames: AudioFrameQueue,
    stop: Arc<AtomicBool>,
    init_tx: std::sync::mpsc::SyncSender<Result<(), String>>,
) {
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if let Err(error) = com {
        let _ = init_tx.send(Err(format!("COM initialization failed: {error}")));
        return;
    }
    let _com = ComGuard;
    let started_at = Instant::now();
    let mut ready_sent = false;

    while !stop.load(Ordering::SeqCst) {
        let session = match open_loopback() {
            Ok(session) => session,
            Err(error) => {
                if !ready_sent {
                    let _ = init_tx.send(Err(error));
                    return;
                }
                thread::sleep(RECONNECT_DELAY);
                continue;
            }
        };
        if !ready_sent {
            ready_sent = true;
            let _ = init_tx.send(Ok(()));
        }
        match pump_packets(
            &session.capture,
            &session.mix,
            &config,
            &frames,
            &stop,
            started_at,
        ) {
            Ok(()) => return,
            Err(error) => {
                drop(session);
                if !is_recoverable_device_error(&error) {
                    eprintln!("WASAPI capture stopped: {error}");
                    return;
                }
                thread::sleep(RECONNECT_DELAY);
            }
        }
    }
}

struct LoopbackSession {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    mix: MixFormat,
}

impl Drop for LoopbackSession {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

fn open_loopback() -> Result<LoopbackSession, String> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|error| format!("no audio device enumerator: {error}"))?
    };
    let device = unsafe {
        enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|error| {
                format!("no default playback device for system-audio capture: {error}")
            })?
    };
    let client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|error| format!("failed to activate WASAPI audio client: {error}"))?
    };

    let format_ptr = unsafe {
        client
            .GetMixFormat()
            .map_err(|error| format!("failed to read WASAPI mix format: {error}"))?
    };
    if format_ptr.is_null() {
        return Err("WASAPI mix format pointer was null".into());
    }
    let mix = {
        // SAFETY: GetMixFormat allocates a WAVEFORMATEX/EXTENSIBLE buffer that
        // stays valid until CoTaskMemFree. Initialize must see the same pointer.
        let parsed = parse_mix_format(unsafe { &*format_ptr });
        let init = unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                BUFFER_DURATION_HNS,
                0,
                format_ptr,
                None,
            )
        };
        unsafe { CoTaskMemFree(Some(format_ptr.cast())) };
        init.map_err(|error| format!("failed to initialize WASAPI loopback: {error}"))?;
        parsed?
    };

    let capture: IAudioCaptureClient = unsafe {
        client
            .GetService()
            .map_err(|error| format!("failed to open WASAPI capture client: {error}"))?
    };
    unsafe {
        client
            .Start()
            .map_err(|error| format!("failed to start WASAPI loopback: {error}"))?;
    }

    Ok(LoopbackSession {
        client,
        capture,
        mix,
    })
}

fn pump_packets(
    capture: &IAudioCaptureClient,
    mix: &MixFormat,
    config: &CaptureConfig,
    frames: &AudioFrameQueue,
    stop: &AtomicBool,
    started_at: Instant,
) -> Result<(), String> {
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(POLL_INTERVAL);
        loop {
            let packet_frames = unsafe {
                capture
                    .GetNextPacketSize()
                    .map_err(|error| map_capture_error("GetNextPacketSize", error))?
            };
            if packet_frames == 0 {
                break;
            }

            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_read = 0_u32;
            let mut flags = 0_u32;
            unsafe {
                capture
                    .GetBuffer(
                        &mut data_ptr,
                        &mut frames_read,
                        &mut flags,
                        None,
                        None,
                    )
                    .map_err(|error| map_capture_error("GetBuffer", error))?;
            }

            let byte_count = frames_read as usize * mix.block_align as usize;
            let bytes = if flags & silent_flag_bits() != 0 || data_ptr.is_null() {
                vec![0_u8; byte_count]
            } else {
                // SAFETY: GetBuffer returns `frames_read` frames of mix.block_align
                // bytes each until ReleaseBuffer is called.
                unsafe { std::slice::from_raw_parts(data_ptr, byte_count) }.to_vec()
            };
            unsafe {
                capture
                    .ReleaseBuffer(frames_read)
                    .map_err(|error| map_capture_error("ReleaseBuffer", error))?;
            }

            if frames_read == 0 {
                continue;
            }
            let Ok(samples) = to_mono_i16(&bytes, mix.pcm, config.sample_rate) else {
                continue;
            };
            if samples.is_empty() {
                continue;
            }
            push_latest_frame(
                frames,
                AudioFrame {
                    samples,
                    sample_rate: config.sample_rate,
                    channels: config.channels,
                    timestamp_ms: started_at.elapsed().as_millis() as u64,
                },
            );
        }
    }
    Ok(())
}

fn parse_mix_format(format: &WAVEFORMATEX) -> Result<MixFormat, String> {
    let tag = u32::from(format.wFormatTag);
    let bits = format.wBitsPerSample;
    let encoding = if tag == WAVE_FORMAT_IEEE_FLOAT as u32 {
        SampleEncoding::F32
    } else if tag == WAVE_FORMAT_PCM as u32 {
        pcm_encoding(bits)?
    } else if tag == WAVE_FORMAT_EXTENSIBLE as u32 {
        if format.cbSize < 22 {
            return Err("WAVEFORMATEXTENSIBLE mix format is truncated".into());
        }
        // SAFETY: cbSize says the extensible tail is present, matching GetMixFormat.
        let ext = unsafe { &*(std::ptr::from_ref(format) as *const WAVEFORMATEXTENSIBLE) };
        if ext.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            SampleEncoding::F32
        } else if ext.SubFormat == KSDATAFORMAT_SUBTYPE_PCM {
            pcm_encoding(bits)?
        } else {
            return Err(format!(
                "unsupported WASAPI mix sub-format: {:?}",
                ext.SubFormat
            ));
        }
    } else {
        return Err(format!("unsupported WASAPI mix format tag: {tag}"));
    };

    if format.nChannels == 0 || format.nSamplesPerSec == 0 || format.nBlockAlign == 0 {
        return Err("WASAPI mix format is missing channel, rate, or block align".into());
    }

    Ok(MixFormat {
        pcm: PcmFormat {
            sample_rate: format.nSamplesPerSec,
            channels: format.nChannels,
            encoding,
        },
        block_align: format.nBlockAlign,
    })
}

fn pcm_encoding(bits: u16) -> Result<SampleEncoding, String> {
    match bits {
        16 => Ok(SampleEncoding::I16),
        32 => Ok(SampleEncoding::I32),
        other => Err(format!(
            "unsupported PCM bit depth from WASAPI mix format: {other}"
        )),
    }
}

fn map_capture_error(operation: &str, error: windows::core::Error) -> String {
    if is_device_invalidated(&error) {
        format!("playback device changed during {operation}")
    } else {
        format!("WASAPI {operation} failed: {error}")
    }
}

fn is_device_invalidated(error: &windows::core::Error) -> bool {
    error.code().0 as u32 == AUDCLNT_E_DEVICE_INVALIDATED
}

fn is_recoverable_device_error(message: &str) -> bool {
    message.contains("playback device") || message.contains("device changed")
}

fn silent_flag_bits() -> u32 {
    AUDCLNT_BUFFERFLAGS_SILENT.0 as u32
}

#[cfg(test)]
mod tests {
    use super::parse_mix_format;
    use crate::audio::convert::SampleEncoding;
    use windows::Win32::Media::Audio::{WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM};
    use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
    use windows::Win32::Media::Multimedia::{
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT,
    };

    fn base_format(tag: u32, bits: u16) -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: tag as u16,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * 2 * u32::from(bits / 8),
            nBlockAlign: 2 * (bits / 8),
            wBitsPerSample: bits,
            cbSize: 0,
        }
    }

    #[test]
    fn parses_ieee_float_mix_format() {
        let mix = parse_mix_format(&base_format(WAVE_FORMAT_IEEE_FLOAT, 32)).unwrap();
        assert_eq!(mix.pcm.encoding, SampleEncoding::F32);
        assert_eq!(mix.pcm.sample_rate, 48_000);
        assert_eq!(mix.pcm.channels, 2);
        assert_eq!(mix.block_align, 8);
    }

    #[test]
    fn parses_pcm_16bit() {
        let mix = parse_mix_format(&base_format(WAVE_FORMAT_PCM, 16)).unwrap();
        assert_eq!(mix.pcm.encoding, SampleEncoding::I16);
    }

    #[test]
    fn rejects_odd_pcm_depth() {
        assert!(parse_mix_format(&base_format(WAVE_FORMAT_PCM, 24)).is_err());
    }

    #[test]
    fn parses_extensible_float() {
        let mut base = base_format(WAVE_FORMAT_EXTENSIBLE, 32);
        base.cbSize = 22;
        let ext = WAVEFORMATEXTENSIBLE {
            Format: base,
            SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
            ..Default::default()
        };
        let fmt = std::ptr::from_ref(&ext) as *const WAVEFORMATEX;
        let mix = parse_mix_format(unsafe { &*fmt }).unwrap();
        assert_eq!(mix.pcm.encoding, SampleEncoding::F32);
    }
}
