import {
  isSarvamSupportedLanguage,
  type ProviderId,
  type SupportedLanguage,
} from "@doot/protocol";
import { SarvamFailoverSession } from "./sarvam-failover.js";

export type ProviderStreamState = "connecting" | "open" | "reconnecting" | "closed";

export type ProviderStreamEvent =
  | { type: "speech_start"; timestampMs: number }
  | { type: "speech_end"; timestampMs: number }
  | {
    type: "transcript";
    text: string;
    timestampMs: number;
    languageCode?: string;
    /** True only when the provider emitted a complete utterance transcript. */
    isFinal?: boolean;
    /** True when the provider already returned target-language text (e.g. Saaras translate). */
    translated?: boolean;
  }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "state"; state: ProviderStreamState };

export interface OpenProviderSessionOptions {
  sessionId: string;
  source: SupportedLanguage;
  target: SupportedLanguage;
  sampleRate: number;
  channels: number;
  onEvent(event: ProviderStreamEvent): void;
}

export interface ProviderStreamSession {
  pushAudio(audio: Uint8Array, timestampMs: number): void;
  commitAudioThrough(timestampMs: number): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SpeechProvider {
  id: ProviderId;
  configured: boolean;
  supports(source: SupportedLanguage, target: SupportedLanguage): boolean;
  openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession>;
}

export class MockProvider implements SpeechProvider {
  id = "mock" as const;
  configured = true;
  supports(): boolean { return true; }
  async openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession> {
    return new MockStreamingSession(options);
  }
}

export class SarvamProvider implements SpeechProvider {
  id = "sarvam" as const;
  configured: boolean;
  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }
  supports(source: SupportedLanguage, target: SupportedLanguage): boolean {
    return this.configured
      && isSarvamSupportedLanguage(source)
      && target !== "auto"
      && isSarvamSupportedLanguage(target);
  }
  async openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("SARVAM_API_KEY is not configured");
    const session = new SarvamFailoverSession(this.apiKey, options);
    await session.open();
    return session;
  }
}

export class ProviderRouter {
  private readonly providers: SpeechProvider[];
  constructor(
    sarvamApiKey?: string,
    providers?: SpeechProvider[],
  ) {
    this.providers = providers ?? [
      new SarvamProvider(sarvamApiKey),
      new MockProvider(),
    ];
  }
  select(source: SupportedLanguage, target: SupportedLanguage, requested?: ProviderId): SpeechProvider {
    if (requested) {
      const explicit = this.providers.find((provider) => provider.id === requested);
      if (!explicit) throw new Error(`Unknown provider: ${requested}`);
      if (!explicit.configured) throw new Error(`Provider ${requested} is not configured`);
      if (!explicit.supports(source, target)) throw new Error(`Provider ${requested} does not support ${source} → ${target}`);
      return explicit;
    }
    return this.providers.find((provider) => provider.configured && provider.supports(source, target)) ?? this.providers.at(-1)!;
  }
}

const MOCK_UTTERANCE_BYTES = 48_000;

class MockStreamingSession implements ProviderStreamSession {
  private audioBytes = 0;
  private started = false;
  private lastTimestampMs = 0;
  private closed = false;

  constructor(private readonly options: OpenProviderSessionOptions) {
    options.onEvent({ type: "state", state: "open" });
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed) return;
    if (!this.started) {
      this.started = true;
      this.options.onEvent({ type: "speech_start", timestampMs });
    }
    this.audioBytes += audio.byteLength;
    this.lastTimestampMs = timestampMs;
    if (this.audioBytes >= MOCK_UTTERANCE_BYTES) {
      this.emitTranscript();
    }
  }

  async flush(): Promise<void> {
    if (this.audioBytes > 0) this.emitTranscript();
  }

  commitAudioThrough(_timestampMs: number): void {}

  async close(): Promise<void> {
    this.closed = true;
    this.options.onEvent({ type: "state", state: "closed" });
  }

  private emitTranscript(): void {
    const durationMs = Math.round(this.audioBytes / 32);
    this.options.onEvent({
      type: "transcript",
      text: `Received ${durationMs} ms of system audio.`,
      timestampMs: this.lastTimestampMs,
      languageCode: "en-IN",
    });
    this.options.onEvent({
      type: "speech_end",
      timestampMs: this.lastTimestampMs,
    });
    this.audioBytes = 0;
    this.started = false;
  }
}
