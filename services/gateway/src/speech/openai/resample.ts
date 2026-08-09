/** Resample mono PCM S16LE to 24 kHz for OpenAI realtime translate. */
export function resamplePcmS16leTo24k(
  pcm: Uint8Array,
  sourceSampleRate: number,
): Buffer {
  if (sourceSampleRate === 24_000) return Buffer.from(pcm);
  if (sourceSampleRate <= 0 || pcm.byteLength < 2) return Buffer.alloc(0);
  if (pcm.byteLength % 2 !== 0) {
    throw new Error("PCM S16LE audio length must be even");
  }

  const inputSamples = pcm.byteLength / 2;
  const outputSamples = Math.max(
    1,
    Math.round((inputSamples * 24_000) / sourceSampleRate),
  );
  const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const output = Buffer.alloc(outputSamples * 2);

  if (inputSamples === 1) {
    const sample = input.readInt16LE(0);
    for (let index = 0; index < outputSamples; index += 1) {
      output.writeInt16LE(sample, index * 2);
    }
    return output;
  }

  for (let index = 0; index < outputSamples; index += 1) {
    const position = (index * (inputSamples - 1)) / Math.max(outputSamples - 1, 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, inputSamples - 1);
    const fraction = position - leftIndex;
    const left = input.readInt16LE(leftIndex * 2);
    const right = input.readInt16LE(rightIndex * 2);
    output.writeInt16LE(Math.round(left + (right - left) * fraction), index * 2);
  }
  return output;
}
