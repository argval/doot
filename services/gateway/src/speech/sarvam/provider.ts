import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import { SarvamFailoverSession } from "./failover.js";
import { SARVAM_SUPPORTED_LANGUAGES } from "./languages.js";

export class SarvamProvider implements SpeechProvider {
  id = "sarvam" as const;
  configured: boolean;
  capabilities = {
    sourceLanguages: SARVAM_SUPPORTED_LANGUAGES,
    sampleRates: [16_000],
    channels: [1],
    automaticLanguageDetection: true,
    partialTranscripts: true,
    routingPriority: 90,
    automaticDetectionPriority: 100,
  } as const;

  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }

  async openSession(
    options: OpenProviderSessionOptions,
  ): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("SARVAM_API_KEY is not configured");
    const session = new SarvamFailoverSession(this.apiKey, options);
    await session.open();
    return session;
  }
}
