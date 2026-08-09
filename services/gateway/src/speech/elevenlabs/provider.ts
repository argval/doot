import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import { ELEVENLABS_SUPPORTED_LANGUAGES } from "./languages.js";
import { ElevenLabsRealtimeSession } from "./realtime.js";

export class ElevenLabsProvider implements SpeechProvider {
  id = "elevenlabs" as const;
  configured: boolean;
  capabilities = {
    sourceLanguages: ELEVENLABS_SUPPORTED_LANGUAGES,
    sampleRates: [16_000, 24_000, 48_000],
    channels: [1],
    automaticLanguageDetection: true,
    partialTranscripts: true,
    routingPriority: 100,
    automaticDetectionPriority: 50,
  } as const;

  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }

  async openSession(
    options: OpenProviderSessionOptions,
  ): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");
    const session = new ElevenLabsRealtimeSession(this.apiKey, options);
    await session.open();
    return session;
  }
}
