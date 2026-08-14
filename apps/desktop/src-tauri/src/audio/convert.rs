//! Shared PCM conversion for capture backends.
//!
//! WASAPI and other OS mix formats are converted to the gateway contract:
//! mono PCM S16LE at `CaptureConfig.sample_rate` (16 kHz).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleEncoding {
    F32,
    I16,
    I32,
}

impl SampleEncoding {
    pub fn bytes_per_sample(self) -> usize {
        match self {
            Self::F32 | Self::I32 => 4,
            Self::I16 => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub encoding: SampleEncoding,
}

impl PcmFormat {
    pub fn frame_bytes(self) -> usize {
        self.encoding.bytes_per_sample() * self.channels.max(1) as usize
    }
}

pub fn to_mono_i16(
    bytes: &[u8],
    input: PcmFormat,
    output_sample_rate: u32,
) -> Result<Vec<i16>, String> {
    validate_format(input, output_sample_rate)?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let frame_bytes = input.frame_bytes();
    if bytes.len() % frame_bytes != 0 {
        return Err(format!(
            "PCM buffer length {} is not a multiple of {frame_bytes}-byte frames",
            bytes.len()
        ));
    }

    if input.encoding == SampleEncoding::I16
        && input.channels == 1
        && input.sample_rate == output_sample_rate
    {
        return Ok(decode_i16_le(bytes));
    }

    let interleaved = decode_interleaved_f32(bytes, input.encoding)?;
    let mono = downmix_to_mono(&interleaved, input.channels);
    let resampled = resample_mono(&mono, input.sample_rate, output_sample_rate);
    Ok(resampled.into_iter().map(f32_to_i16).collect())
}

pub fn f32_to_i16(sample: f32) -> i16 {
    let scaled = sample.clamp(-1.0, 1.0) * i16::MAX as f32;
    scaled.round() as i16
}

fn validate_format(input: PcmFormat, output_sample_rate: u32) -> Result<(), String> {
    if input.channels == 0 || input.channels > 32 {
        return Err(format!("unsupported PCM channel count: {}", input.channels));
    }
    if input.sample_rate == 0 {
        return Err("PCM sample rate must be greater than 0".into());
    }
    if output_sample_rate == 0 {
        return Err("output sample rate must be greater than 0".into());
    }
    Ok(())
}

fn decode_interleaved_f32(bytes: &[u8], encoding: SampleEncoding) -> Result<Vec<f32>, String> {
    match encoding {
        SampleEncoding::F32 => decode_f32_le(bytes),
        SampleEncoding::I16 => Ok(decode_i16_le(bytes)
            .into_iter()
            .map(|sample| sample as f32 / 32768.0)
            .collect()),
        SampleEncoding::I32 => decode_i32_le(bytes).map(|samples| {
            samples
                .into_iter()
                .map(|sample| sample as f32 / 2147483648.0)
                .collect()
        }),
    }
}

fn decode_f32_le(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err("float32 PCM length must be a multiple of 4 bytes".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn decode_i16_le(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect()
}

fn decode_i32_le(bytes: &[u8]) -> Result<Vec<i32>, String> {
    if bytes.len() % 4 != 0 {
        return Err("int32 PCM length must be a multiple of 4 bytes".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn downmix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channel_count = channels.max(1) as usize;
    if channel_count == 1 {
        return samples.to_vec();
    }
    samples
        .chunks_exact(channel_count)
        .map(|frame| frame.iter().sum::<f32>() / channel_count as f32)
        .collect()
}

fn resample_mono(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if input.is_empty() || in_rate == 0 || out_rate == 0 {
        return Vec::new();
    }
    if in_rate == out_rate {
        return input.to_vec();
    }
    if in_rate > out_rate && in_rate % out_rate == 0 {
        let factor = (in_rate / out_rate) as usize;
        return input
            .chunks_exact(factor)
            .map(|chunk| chunk.iter().sum::<f32>() / factor as f32)
            .collect();
    }

    let ratio = f64::from(in_rate) / f64::from(out_rate);
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    (0..out_len)
        .map(|index| {
            let src = index as f64 * ratio;
            let left = src.floor() as usize;
            let frac = (src - left as f64) as f32;
            let first = input[left];
            let second = input.get(left + 1).copied().unwrap_or(first);
            first + (second - first) * frac
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{f32_to_i16, to_mono_i16, PcmFormat, SampleEncoding};

    fn f32_le_bytes(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    fn i16_le_bytes(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    #[test]
    fn stereo_float_48k_downmixes_and_downsamples_to_16k_mono() {
        // 3 stereo frames at 48 kHz → 1 mono frame at 16 kHz.
        let bytes = f32_le_bytes(&[0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
        let samples = to_mono_i16(
            &bytes,
            PcmFormat {
                sample_rate: 48_000,
                channels: 2,
                encoding: SampleEncoding::F32,
            },
            16_000,
        )
        .expect("conversion should succeed");
        assert_eq!(samples, vec![f32_to_i16(0.5)]);
    }

    #[test]
    fn mono_i16_passthrough_skips_resample() {
        let samples = to_mono_i16(
            &i16_le_bytes(&[1, -2, i16::MAX]),
            PcmFormat {
                sample_rate: 16_000,
                channels: 1,
                encoding: SampleEncoding::I16,
            },
            16_000,
        )
        .expect("conversion should succeed");
        assert_eq!(samples, vec![1, -2, i16::MAX]);
    }

    #[test]
    fn stereo_i16_same_rate_averages_channels() {
        let samples = to_mono_i16(
            &i16_le_bytes(&[100, 300, -50, 50]),
            PcmFormat {
                sample_rate: 16_000,
                channels: 2,
                encoding: SampleEncoding::I16,
            },
            16_000,
        )
        .expect("conversion should succeed");
        assert_eq!(samples, vec![f32_to_i16(200.0 / 32768.0), f32_to_i16(0.0)]);
    }

    #[test]
    fn empty_buffer_returns_empty() {
        let samples = to_mono_i16(
            &[],
            PcmFormat {
                sample_rate: 48_000,
                channels: 2,
                encoding: SampleEncoding::F32,
            },
            16_000,
        )
        .expect("empty conversion should succeed");
        assert!(samples.is_empty());
    }

    #[test]
    fn rejects_misaligned_buffer() {
        let error = to_mono_i16(
            &[0, 1, 2],
            PcmFormat {
                sample_rate: 48_000,
                channels: 2,
                encoding: SampleEncoding::F32,
            },
            16_000,
        )
        .expect_err("misaligned buffer should fail");
        assert!(error.contains("not a multiple"));
    }

    #[test]
    fn linear_resample_handles_44100_to_16000() {
        let mut input = Vec::new();
        for _ in 0..441 {
            input.extend_from_slice(&[0.25_f32, 0.25]);
        }
        let samples = to_mono_i16(
            &f32_le_bytes(&input),
            PcmFormat {
                sample_rate: 44_100,
                channels: 2,
                encoding: SampleEncoding::F32,
            },
            16_000,
        )
        .expect("44.1 kHz conversion should succeed");
        assert_eq!(samples.len(), 160);
        assert!(samples.iter().all(|sample| *sample == f32_to_i16(0.25)));
    }

    #[test]
    fn f32_to_i16_clamps() {
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16(0.0), 0);
    }
}
