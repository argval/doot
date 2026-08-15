import {
  AUDIO_SAMPLE_RATES,
  CHANNEL_COUNTS,
  SUPPORTED_LANGUAGES,
} from "@doot/protocol";
import {
  pcmS16leDurationMs,
  type OpenProviderSessionOptions,
  type ProviderStreamSession,
  type SpeechProvider,
} from "../contract.js";

const MOCK_UTTERANCE_BYTES = 48_000;

export class MockProvider implements SpeechProvider {
  id = "mock" as const;
  configured = true;
  capabilities = {
    sourceLanguages: SUPPORTED_LANGUAGES,
    sampleRates: AUDIO_SAMPLE_RATES,
    channels: CHANNEL_COUNTS,
    routingPriority: 0,
    automaticDetectionPriority: 0,
  } as const;

  async openSession(
    options: OpenProviderSessionOptions,
  ): Promise<ProviderStreamSession> {
    return new MockStreamingSession(options);
  }
}

class MockStreamingSession implements ProviderStreamSession {
  private audioBytes = 0;
  private started = false;
  private lastTimestampMs = 0;
  private closed = false;
  private turnId: string | null = null;
  private turnSequence = 0;

  constructor(private readonly options: OpenProviderSessionOptions) {}

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed) return;
    if (!this.started) {
      this.started = true;
      this.turnId = `${this.options.sessionId}:${this.turnSequence}`;
      this.turnSequence += 1;
      this.options.onEvent({
        type: "speech_start",
        timestampMs,
        turnId: this.turnId,
      });
    }
    this.audioBytes += audio.byteLength;
    this.lastTimestampMs = timestampMs + pcmS16leDurationMs(
      audio.byteLength,
      this.options.sampleRate,
      this.options.channels,
    );
    if (this.audioBytes >= MOCK_UTTERANCE_BYTES) this.emitTranscript();
  }

  async flush(): Promise<void> {
    if (this.audioBytes > 0) this.emitTranscript();
  }

  commitAudioThrough(_timestampMs: number): void {}

  async close(): Promise<void> {
    this.closed = true;
  }

  private emitTranscript(): void {
    const durationMs = Math.round(this.audioBytes / 32);
    this.options.onEvent({
      type: "transcript",
      text: `Received ${durationMs} ms of system audio.`,
      timestampMs: this.lastTimestampMs,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      languageCode: "en-IN",
      isFinal: true,
    });
    this.options.onEvent({
      type: "speech_end",
      timestampMs: this.lastTimestampMs,
      ...(this.turnId ? { turnId: this.turnId } : {}),
    });
    this.audioBytes = 0;
    this.started = false;
    this.turnId = null;
  }
}
