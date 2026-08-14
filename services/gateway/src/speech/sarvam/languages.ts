import {
  type SupportedLanguage,
} from "@doot/protocol";

export const SARVAM_SUPPORTED_LANGUAGES = [
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

type SarvamSupportedLanguage = (typeof SARVAM_SUPPORTED_LANGUAGES)[number];

export function isSarvamSupportedLanguage(
  value: SupportedLanguage,
): value is SarvamSupportedLanguage {
  return SARVAM_SUPPORTED_LANGUAGES.some((language) => language === value);
}

export const SARVAM_REALTIME_STT_WS = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

const realtimeLanguageCodes: Record<Exclude<SarvamSupportedLanguage, "auto">, string> = {
  en: "en-IN",
  hi: "hi-IN",
  bn: "bn-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  mr: "mr-IN",
  od: "or-IN",
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

export function toSarvamRealtimeLanguageCode(language: SupportedLanguage): string {
  if (!isSarvamSupportedLanguage(language)) {
    throw new Error(`Sarvam does not support language: ${language}`);
  }
  if (language === "auto") return "auto";
  return realtimeLanguageCodes[language];
}
