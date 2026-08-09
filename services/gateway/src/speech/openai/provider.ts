import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import {
  OPENAI_TRANSLATE_SOURCE_LANGUAGES,
  OPENAI_TRANSLATE_TARGET_LANGUAGES,
  supportsOpenAITranslateRoute,
} from "./languages.js";
import {
  OpenAIRealtimeTranslateSession,
  type OpenAIRealtimeTranslateRuntime,
} from "./realtime.js";

export class OpenAITranslateProvider implements SpeechProvider {
  id = "openai" as const;
  configured: boolean;
  capabilities = {
    sourceLanguages: OPENAI_TRANSLATE_SOURCE_LANGUAGES,
    sampleRates: [16_000, 24_000, 48_000],
    channels: [1],
    automaticLanguageDetection: true,
    partialTranscripts: true,
    routingPriority: 40,
    automaticDetectionPriority: 20,
    endToEndTranslation: true,
    translationTargets: OPENAI_TRANSLATE_TARGET_LANGUAGES,
  } as const;

  constructor(
    private readonly apiKey?: string,
    private readonly runtime: OpenAIRealtimeTranslateRuntime = {},
  ) {
    this.configured = Boolean(apiKey);
  }

  async openSession(
    options: OpenProviderSessionOptions,
  ): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    if (!options.target) {
      throw new Error("OpenAI realtime translate requires a target language");
    }
    if (!supportsOpenAITranslateRoute(options.source, options.target)) {
      throw new Error(
        `OpenAI realtime translate does not support ${options.source} → ${options.target}`,
      );
    }
    const session = new OpenAIRealtimeTranslateSession(
      this.apiKey,
      options,
      this.runtime,
    );
    await session.open();
    return session;
  }
}
