import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import {
  GeminiLiveTranscribeSession,
  type GeminiLiveRuntime,
} from "./live.js";
import { GEMINI_TRANSCRIBE_SOURCE_LANGUAGES } from "./languages.js";

/** Gemini's caption-native live STT path. Translation stays in the text router. */
export class GeminiTranscribeProvider implements SpeechProvider {
  readonly id = "gemini-transcribe" as const;
  readonly configured: boolean;
  readonly capabilities = {
    sourceLanguages: GEMINI_TRANSCRIBE_SOURCE_LANGUAGES,
    sampleRates: [16_000],
    channels: [1],
    routingPriority: 85,
    automaticDetectionPriority: 80,
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
    const session = new GeminiLiveTranscribeSession(this.apiKey, options, this.runtime);
    await session.open();
    return session;
  }
}
