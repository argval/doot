import type { ProviderId, SupportedLanguage } from "@doot/protocol";
import { transcribeWithSarvam } from "./sarvam.js";

export interface SpeechProvider {
  id: ProviderId;
  configured: boolean;
  supports(source: SupportedLanguage, target: SupportedLanguage): boolean;
  transcribeAndTranslate(audio: Uint8Array, source: SupportedLanguage, target: SupportedLanguage): Promise<{ sourceText: string; translatedText: string } | null>;
}

export class MockProvider implements SpeechProvider {
  id = "mock" as const;
  configured = true;
  supports(): boolean { return true; }
  async transcribeAndTranslate(audio: Uint8Array): Promise<{ sourceText: string; translatedText: string } | null> {
    const durationMs = Math.round(audio.byteLength / 32);
    return {
      sourceText: `Received ${durationMs} ms of system audio.`,
      translatedText: "The live caption pipeline is connected.",
    };
  }
}

export class SarvamProvider implements SpeechProvider {
  id = "sarvam" as const;
  configured: boolean;
  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }
  supports(source: SupportedLanguage, target: SupportedLanguage): boolean {
    if (!this.configured) return false;
    const indian = new Set<SupportedLanguage>(["auto", "en", "hi", "ta", "te", "bn", "mr"]);
    return indian.has(source) && indian.has(target);
  }
  async transcribeAndTranslate(audio: Uint8Array, source: SupportedLanguage, target: SupportedLanguage): Promise<{ sourceText: string; translatedText: string } | null> {
    if (!this.apiKey) throw new Error("SARVAM_API_KEY is not configured");
    return transcribeWithSarvam({
      apiKey: this.apiKey,
      audio,
      source,
      target,
    });
  }
}

export class InternationalProvider implements SpeechProvider {
  id = "international-stt" as const;
  configured: boolean;
  constructor(private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
  }
  supports(): boolean { return this.configured; }
  async transcribeAndTranslate(_audio: Uint8Array, _source: SupportedLanguage, _target: SupportedLanguage): Promise<{ sourceText: string; translatedText: string } | null> {
    if (!this.apiKey) throw new Error("INTERNATIONAL_STT_API_KEY is not configured");
    throw new Error("International streaming adapter is a scaffold; add the provider websocket client here");
  }
}

export class ProviderRouter {
  private readonly providers: SpeechProvider[];
  constructor(sarvamApiKey?: string, internationalApiKey?: string) {
    this.providers = [new SarvamProvider(sarvamApiKey), new InternationalProvider(internationalApiKey), new MockProvider()];
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
