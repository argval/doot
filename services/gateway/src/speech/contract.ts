import type {
  AudioSampleRate,
  ChannelCount,
  ProviderId,
  SupportedLanguage,
} from "@doot/protocol";

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
    isFinal: boolean;
  }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "state"; state: ProviderStreamState };

export interface SpeechProviderCapabilities {
  sourceLanguages: readonly SupportedLanguage[];
  sampleRates: readonly AudioSampleRate[];
  channels: readonly ChannelCount[];
  automaticLanguageDetection: boolean;
  partialTranscripts: boolean;
  routingPriority: number;
  automaticDetectionPriority: number;
}

export interface OpenProviderSessionOptions {
  sessionId: string;
  source: SupportedLanguage;
  sampleRate: AudioSampleRate;
  channels: ChannelCount;
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
  capabilities: SpeechProviderCapabilities;
  openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession>;
}

export function supportsSession(
  provider: SpeechProvider,
  source: SupportedLanguage,
  sampleRate?: AudioSampleRate,
  channels?: ChannelCount,
): boolean {
  const capabilities = provider.capabilities;
  return capabilities.sourceLanguages.includes(source)
    && (sampleRate === undefined || capabilities.sampleRates.includes(sampleRate))
    && (channels === undefined || capabilities.channels.includes(channels));
}
