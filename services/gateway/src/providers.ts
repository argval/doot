import type { ProviderId, SupportedLanguage } from "@doot/protocol";

export interface SpeechProvider {
  id: ProviderId;
  supports(source: SupportedLanguage, target: SupportedLanguage): boolean;
  transcribeAndTranslate(audio: Uint8Array, source: SupportedLanguage, target: SupportedLanguage): Promise<{ sourceText: string; translatedText: string }>;
}

export class MockProvider implements SpeechProvider {
  id = "mock" as const;
  supports(): boolean { return true; }
  async transcribeAndTranslate(): Promise<{ sourceText: string; translatedText: string }> {
    return { sourceText: "Waiting for provider configuration…", translatedText: "Connect a speech provider to receive live captions." };
  }
}

export class SarvamProvider implements SpeechProvider {
  id = "sarvam" as const;
  constructor(private readonly apiKey?: string) {}
  supports(source: SupportedLanguage, target: SupportedLanguage): boolean {
    const indian = new Set<SupportedLanguage>(["auto", "en", "hi", "ta", "te", "bn", "mr"]);
    return indian.has(source) && indian.has(target);
  }
  async transcribeAndTranslate(_audio: Uint8Array, _source: SupportedLanguage, _target: SupportedLanguage): Promise<{ sourceText: string; translatedText: string }> {
    if (!this.apiKey) throw new Error("SARVAM_API_KEY is not configured");
    throw new Error("Sarvam streaming adapter is a scaffold; add the provider websocket client here");
  }
}

export class InternationalProvider implements SpeechProvider {
  id = "international-stt" as const;
  constructor(private readonly apiKey?: string) {}
  supports(): boolean { return true; }
  async transcribeAndTranslate(_audio: Uint8Array, _source: SupportedLanguage, _target: SupportedLanguage): Promise<{ sourceText: string; translatedText: string }> {
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
      if (explicit) return explicit;
    }
    return this.providers.find((provider) => provider.supports(source, target)) ?? this.providers.at(-1)!;
  }
}
