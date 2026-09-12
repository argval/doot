import { SUPPORTED_LANGUAGES } from "@doot/protocol";
import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
  SpeechProvider,
} from "../contract.js";
import { OpenAITranscribeSession } from "./realtime.js";

export class OpenAITranscribeProvider implements SpeechProvider {
  readonly id = "openai-transcribe" as const;
  readonly configured: boolean;
  readonly capabilities = {
    sourceLanguages: SUPPORTED_LANGUAGES,
    sampleRates: [16_000],
    channels: [1],
  } as const;

  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }

  async openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const session = new OpenAITranscribeSession(this.apiKey, options);
    await session.open();
    return session;
  }
}
