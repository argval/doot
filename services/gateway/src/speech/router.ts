import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  type AudioSampleRate,
  type ChannelCount,
  type ProviderId,
  type SupportedLanguage,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import {
  supportsSession,
  type SpeechProvider,
} from "./contract.js";

export class ProviderRouter {
  constructor(private readonly providers: readonly SpeechProvider[]) {
    if (providers.length === 0) throw new Error("At least one speech provider is required");
  }

  availability(): Partial<Record<ProviderId, boolean>> {
    return Object.fromEntries(
      this.providers.map((provider) => [provider.id, provider.configured]),
    );
  }

  languageCoverage(): {
    sources: SupportedLanguage[];
    targets: SupportedTargetLanguage[];
  } {
    const sources = new Set<SupportedLanguage>();
    const targets = new Set<SupportedTargetLanguage>();
    for (const provider of this.providers) {
      if (!provider.configured) continue;
      for (const language of provider.capabilities.sourceLanguages) {
        sources.add(language);
      }
      if (provider.capabilities.targetLanguages) {
        for (const language of provider.capabilities.targetLanguages) {
          targets.add(language);
        }
        continue;
      }
      for (const language of provider.capabilities.sourceLanguages) {
        if (language === "auto") continue;
        if (SUPPORTED_TARGET_LANGUAGES.some((candidate) => candidate === language)) {
          targets.add(language);
        }
      }
    }
    return {
      sources: SUPPORTED_LANGUAGES.filter((language) => sources.has(language)),
      targets: SUPPORTED_TARGET_LANGUAGES.filter((language) => targets.has(language)),
    };
  }

  select(
    source: SupportedLanguage,
    requested?: ProviderId,
    sampleRate?: AudioSampleRate,
    channels?: ChannelCount,
    target?: SupportedLanguage,
  ): SpeechProvider {
    if (requested) {
      const explicit = this.providers.find((provider) => provider.id === requested);
      if (!explicit) throw new Error(`Unknown provider: ${requested}`);
      if (!explicit.configured) throw new Error(`Provider ${requested} is not configured`);
      if (!supportsSession(explicit, source, sampleRate, channels, target)) {
        throw new Error(
          `Provider ${requested} does not support this ${source}`
          + `${target ? ` → ${target}` : ""} audio session`,
        );
      }
      return explicit;
    }

    const compatible = this.providers.filter((provider) => (
      provider.configured && supportsSession(provider, source, sampleRate, channels, target)
    ));
    compatible.sort((left, right) => {
      const leftPriority = source === "auto"
        ? left.capabilities.automaticDetectionPriority
        : left.capabilities.routingPriority;
      const rightPriority = source === "auto"
        ? right.capabilities.automaticDetectionPriority
        : right.capabilities.routingPriority;
      return rightPriority - leftPriority;
    });
    const selected = compatible[0];
    if (!selected) {
      const pair = target ? `${source} → ${target}` : source;
      throw new Error(`No configured speech provider supports ${pair}`);
    }
    return selected;
  }
}
