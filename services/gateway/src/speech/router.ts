import type {
  AudioSampleRate,
  ChannelCount,
  ProviderId,
  SupportedLanguage,
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

  select(
    source: SupportedLanguage,
    requested?: ProviderId,
    sampleRate?: AudioSampleRate,
    channels?: ChannelCount,
  ): SpeechProvider {
    if (requested) {
      const explicit = this.providers.find((provider) => provider.id === requested);
      if (!explicit) throw new Error(`Unknown provider: ${requested}`);
      if (!explicit.configured) throw new Error(`Provider ${requested} is not configured`);
      if (!supportsSession(explicit, source, sampleRate, channels)) {
        throw new Error(`Provider ${requested} does not support this ${source} audio session`);
      }
      return explicit;
    }

    const compatible = this.providers.filter((provider) => (
      provider.configured && supportsSession(provider, source, sampleRate, channels)
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
    if (!selected) throw new Error(`No configured speech provider supports ${source}`);
    return selected;
  }
}
