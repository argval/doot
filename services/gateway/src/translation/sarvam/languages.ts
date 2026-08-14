import type { SupportedLanguage } from "@doot/protocol";
import {
  isSarvamSupportedLanguage,
  SARVAM_SUPPORTED_LANGUAGES,
} from "../../speech/sarvam/languages.js";

export const SARVAM_TRANSLATION_SOURCE_LANGUAGES = SARVAM_SUPPORTED_LANGUAGES;

type SarvamTranslationTargetLanguage = Exclude<
  (typeof SARVAM_SUPPORTED_LANGUAGES)[number],
  "auto"
>;

export const SARVAM_TRANSLATION_TARGET_LANGUAGES = SARVAM_SUPPORTED_LANGUAGES.filter(
  (language): language is SarvamTranslationTargetLanguage => language !== "auto",
);

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
  return isSarvamSupportedLanguage(language);
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
