import type {
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

/**
 * International launch sources for OpenAI realtime translate.
 * Auto gives international input an end-to-end English route. Explicit Indic
 * sources remain on Sarvam for its code-switch-aware lane.
 */
export const OPENAI_TRANSLATE_SOURCE_LANGUAGES = [
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
] as const satisfies readonly SupportedLanguage[];

/**
 * OpenAI supports 13 output languages; doot only routes the international
 * launch set here so Indic targets remain on Sarvam.
 */
export const OPENAI_TRANSLATE_TARGET_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
] as const satisfies readonly SupportedTargetLanguage[];

type OpenAITranslateSourceLanguage =
  (typeof OPENAI_TRANSLATE_SOURCE_LANGUAGES)[number];
type OpenAITranslateTargetLanguage =
  (typeof OPENAI_TRANSLATE_TARGET_LANGUAGES)[number];

export const OPENAI_REALTIME_TRANSLATE_WS =
  "wss://api.openai.com/v1/realtime/translations";
export const OPENAI_REALTIME_TRANSLATE_MODEL = "gpt-realtime-translate";
export const OPENAI_TRANSLATE_SAMPLE_RATE = 24_000;

export function isOpenAITranslateSource(
  language: SupportedLanguage,
): language is OpenAITranslateSourceLanguage {
  return OPENAI_TRANSLATE_SOURCE_LANGUAGES.some((candidate) => candidate === language);
}

export function isOpenAITranslateTarget(
  language: SupportedTargetLanguage,
): language is OpenAITranslateTargetLanguage {
  return OPENAI_TRANSLATE_TARGET_LANGUAGES.some((candidate) => candidate === language);
}

export function toOpenAITranslateLanguageCode(
  language: SupportedTargetLanguage,
): string {
  if (!isOpenAITranslateTarget(language)) {
    throw new Error(`OpenAI realtime translate does not support target: ${language}`);
  }
  return language;
}

export function supportsOpenAITranslateRoute(
  source: SupportedLanguage,
  target: SupportedTargetLanguage,
): boolean {
  return source !== target
    && isOpenAITranslateSource(source)
    && isOpenAITranslateTarget(target);
}
