import {
  type AudioSampleRate,
  type CaptionRoute,
  type ChannelCount,
  type ProviderId,
  type StartSessionRequest,
  type SupportedLanguage,
} from "@doot/protocol";
import { supportsSession, type SpeechProvider } from "./contract.js";
import { isSarvamSupportedLanguage } from "./sarvam/languages.js";
import type { TranslationRouter } from "../translation/router.js";
import type { TranslateText } from "../translation/contract.js";

export type RouteRequest = Pick<StartSessionRequest,
  "sourceLanguage" | "targetLanguage" | "provider" | "sampleRate" | "channels"
>;

const SPEECH_NAMES: Record<ProviderId, string> = {
  sarvam: "Sarvam recognition",
  "gemini-transcribe": "Gemini Transcribe Live",
  gemini: "Gemini Live Translate",
  mock: "Demo captions (not speech recognition)",
};

export class ProviderRouter {
  constructor(private readonly providers: readonly SpeechProvider[]) {
    if (providers.length === 0) throw new Error("At least one speech provider is required");
  }

  availability(): Partial<Record<ProviderId, boolean>> {
    return Object.fromEntries(
      this.providers.map((provider) => [provider.id, provider.configured]),
    );
  }

  /** Resolve and pin the whole path before opening speech or accepting audio. */
  resolveRoute(request: RouteRequest, translation: TranslationRouter): {
    provider: SpeechProvider;
    translate: TranslateText;
    route: CaptionRoute;
  } {
    const { sourceLanguage: source, targetLanguage: target } = request;
    if (target === "auto" && source !== "auto") {
      throw new Error("Translate To must be a specific language; Auto is only available for transcription.");
    }
    const provider = this.select(source, request.provider, request.sampleRate, request.channels, target);
    const native = provider.capabilities.nativeTranslation === true;
    const mode = source === target ? "transcribe" : "translate";
    const textProvider = !native && mode === "translate"
      ? translation.select({ source, target })
      : null;
    const textName = textProvider?.id === "sarvam" ? "Sarvam"
      : textProvider?.id === "gemini" ? "Gemini" : textProvider?.id;
    const description = SPEECH_NAMES[provider.id]
      + (textProvider ? ` → ${textName} text translation` : "")
      + (source === "auto" && provider.id === "sarvam" ? ". Auto detects English and Indic speech only." : "");
    return {
      provider,
      translate: textProvider
        ? (input) => textProvider.translate({
          text: input.text.trim(),
          source,
          target,
          ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
          ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
        })
        : async (input) => input.text.trim(),
      route: {
        mode,
        speechProvider: provider.id,
        translation: native ? "native" : textProvider ? "text" : "none",
        translationProvider: native ? provider.id : textProvider?.id ?? null,
        description,
        detectionLanguages: source === "auto"
          ? provider.capabilities.sourceLanguages.filter((language) => language !== "auto")
          : [],
      },
    };
  }

  select(
    source: SupportedLanguage,
    requested?: ProviderId,
    sampleRate?: AudioSampleRate,
    channels?: ChannelCount,
    target?: SupportedLanguage,
  ): SpeechProvider {
    const supports = (provider: SpeechProvider) => (
      supportsSession(provider, source, sampleRate, channels, target)
      // Auto→international must use international recognition, even when Sarvam
      // text could be translated afterward. Auto is scoped to the speech engine.
      && !(provider.id === "sarvam" && source === "auto"
        && target !== undefined && !isSarvamSupportedLanguage(target))
    );
    if (requested) {
      const explicit = this.providers.find((provider) => provider.id === requested);
      if (!explicit) throw new Error(`Unknown provider: ${requested}`);
      if (!explicit.configured) throw new Error(`Provider ${requested} is not configured`);
      if (!supports(explicit)) {
        throw new Error(`Provider ${requested} does not support this ${source}${target ? ` → ${target}` : ""} audio session`);
      }
      return explicit;
    }

    // Product policy, in order:
    // 1. English/Indic recognition: Sarvam (including Auto→English/Indic).
    // 2. Same-language international transcription: Gemini Transcribe Live.
    // 3. International translation: Gemini Live Translate.
    // Skip unconfigured/incompatible engines. Mock always requires an explicit request.
    for (const id of ["sarvam", "gemini-transcribe", "gemini"] as const) {
      const provider = this.providers.find((candidate) => candidate.id === id);
      if (provider?.configured && supports(provider)) return provider;
    }
    throw new Error(`No configured speech provider supports ${target ? `${source} → ${target}` : source}. Add the required service key in Settings → Setup (or .env for a standalone gateway).`);
  }
}
