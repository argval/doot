import type { SupportedLanguage } from "@doot/protocol";

/** Current Speechmatics Realtime languages that overlap Doot's protocol. */
export const SPEECHMATICS_SUPPORTED_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ar", "ru",
  "nl", "pl", "tr", "vi", "th", "id", "be", "bg", "ca", "hr", "cs",
  "da", "et", "fil", "fi", "gl", "el", "he", "hu", "lv", "lt", "ms",
  "mn", "no", "fa", "ro", "sk", "sl", "sw", "sv", "uk", "hi", "bn",
  "mr", "ta", "ur",
] as const satisfies readonly SupportedLanguage[];

export function toSpeechmaticsLanguageCode(language: SupportedLanguage): string {
  if (!SPEECHMATICS_SUPPORTED_LANGUAGES.includes(language as typeof SPEECHMATICS_SUPPORTED_LANGUAGES[number])) {
    throw new Error(`Speechmatics does not support ${language}`);
  }
  return language === "zh" ? "cmn" : language;
}
