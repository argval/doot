import type {
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

/** International launch languages DeepL covers for doot. */
export const DEEPL_TRANSLATION_SOURCE_LANGUAGES = [
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
] as const satisfies readonly SupportedLanguage[];

export const DEEPL_TRANSLATION_TARGET_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
] as const satisfies readonly SupportedTargetLanguage[];

type DeepLTranslationSourceLanguage =
  (typeof DEEPL_TRANSLATION_SOURCE_LANGUAGES)[number];
type DeepLTranslationTargetLanguage =
  (typeof DEEPL_TRANSLATION_TARGET_LANGUAGES)[number];

const sourceLanguageCodes: Record<
  Exclude<DeepLTranslationSourceLanguage, "auto">,
  string
> = {
  en: "EN",
  es: "ES",
  fr: "FR",
  de: "DE",
  pt: "PT",
  it: "IT",
};

/** Prefer Brazilian Portuguese as the default PT caption target. */
const targetLanguageCodes: Record<DeepLTranslationTargetLanguage, string> = {
  en: "EN",
  es: "ES",
  fr: "FR",
  de: "DE",
  pt: "PT-BR",
  it: "IT",
};

export function isDeepLTranslationSource(
  language: SupportedLanguage,
): language is DeepLTranslationSourceLanguage {
  return DEEPL_TRANSLATION_SOURCE_LANGUAGES.some((candidate) => candidate === language);
}

export function isDeepLTranslationTarget(
  language: SupportedTargetLanguage,
): language is DeepLTranslationTargetLanguage {
  return DEEPL_TRANSLATION_TARGET_LANGUAGES.some((candidate) => candidate === language);
}

export function toDeepLSourceLanguageCode(
  language: SupportedLanguage,
): string | undefined {
  if (!isDeepLTranslationSource(language)) {
    throw new Error(`DeepL translation does not support source language: ${language}`);
  }
  if (language === "auto") return undefined;
  return sourceLanguageCodes[language];
}

export function toDeepLTargetLanguageCode(
  language: SupportedTargetLanguage,
): string {
  if (!isDeepLTranslationTarget(language)) {
    throw new Error(`DeepL translation does not support target language: ${language}`);
  }
  return targetLanguageCodes[language];
}

/** Free keys end with `:fx` and must use the free API host. */
export function resolveDeepLApiBaseUrl(apiKey: string): string {
  return apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
}
