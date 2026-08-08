import {
  isSarvamSupportedLanguage,
  type SarvamSupportedLanguage,
  type SupportedLanguage,
} from "@doot/protocol";

export const SARVAM_STT_WS = "wss://api.sarvam.ai/speech-to-text/ws";
export const SARVAM_REALTIME_STT_WS = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

export type SarvamStreamMode = "codemix" | "translate" | "transcribe";

/** Prefer Saaras translate→English when the overlay target is English. */
export function sarvamStreamMode(target: SupportedLanguage): SarvamStreamMode {
  return target === "en" ? "translate" : "codemix";
}

const legacyLanguageCodes: Record<SarvamSupportedLanguage, string> = {
  auto: "unknown",
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

export function toSarvamLanguageCode(language: SupportedLanguage): string {
  if (!isSarvamSupportedLanguage(language)) {
    throw new Error(`Sarvam does not support language: ${language}`);
  }
  return legacyLanguageCodes[language];
}

/**
 * Saaras Realtime accepts `auto` directly and renamed Odia from `od-IN` to
 * `or-IN`; keep this mapping separate from the legacy Streaming API mapping.
 */
export function toSarvamRealtimeLanguageCode(language: SupportedLanguage): string {
  if (!isSarvamSupportedLanguage(language)) {
    throw new Error(`Sarvam does not support language: ${language}`);
  }
  if (language === "auto") return "auto";
  if (language === "od") return "or-IN";
  return legacyLanguageCodes[language];
}

export function toSarvamTranslationLanguageCode(language: SupportedLanguage): string {
  const code = toSarvamLanguageCode(language);
  if (code === "unknown") {
    throw new Error("Translation target cannot use automatic language detection");
  }
  return code;
}

/** RMS of mono PCM S16LE, useful for diagnostics and tests. */
export function pcmS16leRms(audio: Uint8Array): number {
  const sampleCount = Math.floor(audio.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export function hasSpeechEnergy(audio: Uint8Array, minimumRms = 180): boolean {
  return pcmS16leRms(audio) >= minimumRms;
}
