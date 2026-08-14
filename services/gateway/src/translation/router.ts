import {
  SUPPORTED_TARGET_LANGUAGES,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import type {
  TextTranslationProvider,
  TranslationRequest,
} from "./contract.js";
import { TranslationUnavailableError } from "./contract.js";

export class TranslationRouter {
  constructor(private readonly providers: readonly TextTranslationProvider[]) {}

  availability(): Record<string, boolean> {
    return Object.fromEntries(
      this.providers.map((provider) => [provider.id, provider.configured]),
    );
  }

  configuredTargetLanguages(): SupportedTargetLanguage[] {
    const targets = new Set<SupportedTargetLanguage>();
    for (const provider of this.providers) {
      if (!provider.configured) continue;
      for (const language of provider.targetLanguages) {
        targets.add(language);
      }
    }
    return SUPPORTED_TARGET_LANGUAGES.filter((language) => targets.has(language));
  }

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim();
    if (!text || request.source === request.target) return text;
    const provider = this.providers.find((candidate) => (
      candidate.configured && candidate.supports({ ...request, text })
    ));
    if (!provider) throw new TranslationUnavailableError(request);
    return provider.translate({ ...request, text });
  }
}
