import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import { SPEECHMATICS_SUPPORTED_LANGUAGES } from "./languages.js";
import { SpeechmaticsRealtimeSession } from "./realtime.js";

export class SpeechmaticsProvider implements SpeechProvider {
  readonly id = "speechmatics" as const;
  readonly configured: boolean;
  readonly capabilities = {
    sourceLanguages: SPEECHMATICS_SUPPORTED_LANGUAGES,
    sampleRates: [16_000],
    channels: [1],
  } as const;

  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }

  async openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("SPEECHMATICS_API_KEY is not configured");
    const session = new SpeechmaticsRealtimeSession(this.apiKey, options);
    await session.open();
    return session;
  }
}
