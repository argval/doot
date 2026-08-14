import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import {
  GeminiLiveTranslateSession,
  type GeminiLiveRuntime,
} from "./live.js";
import {
  GEMINI_LIVE_SOURCE_LANGUAGES,
  GEMINI_LIVE_TARGET_LANGUAGES,
} from "./languages.js";

export class GeminiProvider implements SpeechProvider {
  readonly id = "gemini" as const;
  readonly configured: boolean;
  readonly capabilities = {
    sourceLanguages: GEMINI_LIVE_SOURCE_LANGUAGES,
    targetLanguages: GEMINI_LIVE_TARGET_LANGUAGES,
    sampleRates: [16_000],
    channels: [1],
    automaticLanguageDetection: true,
    partialTranscripts: true,
    nativeTranslation: true,
    routingPriority: 80,
    automaticDetectionPriority: 0,
  } as const;

  constructor(
    private readonly apiKey?: string,
    private readonly runtime: GeminiLiveRuntime = {},
  ) {
    this.configured = Boolean(apiKey);
  }

  async openSession(
    options: OpenProviderSessionOptions,
  ): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const session = new GeminiLiveTranslateSession(this.apiKey, options, this.runtime);
    await session.open();
    return session;
  }
}
