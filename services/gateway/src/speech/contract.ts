import type {
  AudioSampleRate,
  ChannelCount,
  ProviderId,
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

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
  | {
    type: "translation";
    /** Cumulative translated text for the active provider utterance. */
    text: string;
    timestampMs: number;
    languageCode?: string;
    /** True when the provider has settled the translated utterance. */
    isFinal: boolean;
  }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; retryable: boolean };

export interface SpeechProviderCapabilities {
  sourceLanguages: readonly SupportedLanguage[];
  sampleRates: readonly AudioSampleRate[];
  channels: readonly ChannelCount[];
  /** The provider returns translated text from the same streaming session. */
  nativeTranslation?: boolean;
  /** When present, limits targets accepted by this provider. */
  targetLanguages?: readonly SupportedTargetLanguage[];
  /**
   * Auto-detect only when the target is in this provider's source family.
   * Sarvam uses this so Auto→Spanish (etc.) falls through to Gemini.
   */
  restrictAutoToFamilyTargets?: boolean;
  routingPriority: number;
  automaticDetectionPriority: number;
}

export interface OpenProviderSessionOptions {
  sessionId: string;
  source: SupportedLanguage;
  target: SupportedLanguage;
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
  target?: SupportedLanguage,
): boolean {
  const capabilities = provider.capabilities;
  return capabilities.sourceLanguages.includes(source)
    && (sampleRate === undefined || capabilities.sampleRates.includes(sampleRate))
    && (channels === undefined || capabilities.channels.includes(channels))
    && (
      target === undefined
      || capabilities.targetLanguages === undefined
      || capabilities.targetLanguages.some((language) => language === target)
    )
    && (
      source !== "auto"
      || target === undefined
      || !capabilities.restrictAutoToFamilyTargets
      || capabilities.sourceLanguages.some((language) => language === target)
    );
}
