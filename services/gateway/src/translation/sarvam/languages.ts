import type {
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

export const SARVAM_TRANSLATION_SOURCE_LANGUAGES = [
  "auto",
  "en",
  "hi",
  "bn",
  "gu",
  "kn",
  "ml",
  "mr",
  "od",
  "pa",
  "ta",
  "te",
  "as",
  "ur",
  "ne",
  "kok",
  "ks",
  "sd",
  "sa",
  "sat",
  "mni",
  "brx",
  "mai",
  "doi",
] as const satisfies readonly SupportedLanguage[];

export const SARVAM_TRANSLATION_TARGET_LANGUAGES = [
  "en",
  "hi",
  "bn",
  "gu",
  "kn",
  "ml",
  "mr",
  "od",
  "pa",
  "ta",
  "te",
  "as",
  "ur",
  "ne",
  "kok",
  "ks",
  "sd",
  "sa",
  "sat",
  "mni",
  "brx",
  "mai",
  "doi",
] as const satisfies readonly SupportedTargetLanguage[];

type SarvamTranslationTargetLanguage =
  (typeof SARVAM_TRANSLATION_TARGET_LANGUAGES)[number];

const languageCodes: Record<SarvamTranslationTargetLanguage, string> = {
  en: "en-IN",
  hi: "hi-IN",
  bn: "bn-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  od: "od-IN",
  pa: "pa-IN",
  ta: "ta-IN",
  te: "te-IN",
  as: "as-IN",
  ur: "ur-IN",
  ne: "ne-IN",
  kok: "kok-IN",
  ks: "ks-IN",
  sd: "sd-IN",
  sa: "sa-IN",
  sat: "sat-IN",
  mni: "mni-IN",
  brx: "brx-IN",
  mai: "mai-IN",
  doi: "doi-IN",
};

export function isSarvamTranslationSource(
  language: SupportedLanguage,
): boolean {
  return SARVAM_TRANSLATION_SOURCE_LANGUAGES.some((candidate) => candidate === language);
}

export function isSarvamTranslationTarget(
  language: SupportedLanguage,
): language is SarvamTranslationTargetLanguage {
  return SARVAM_TRANSLATION_TARGET_LANGUAGES.some((candidate) => candidate === language);
}

export function toSarvamTranslationLanguageCode(
  language: SupportedLanguage,
): string {
  if (!isSarvamTranslationTarget(language)) {
    throw new Error(`Sarvam translation does not support target language: ${language}`);
  }
  return languageCodes[language];
}
