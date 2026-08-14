/** Gemini Live Translate international set, common languages first. */
export const INTERNATIONAL_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "zh",
  "ar",
  "ru",
  "nl",
  "pl",
  "tr",
  "vi",
  "th",
  "id",
  "af",
  "ak",
  "sq",
  "am",
  "hy",
  "az",
  "eu",
  "be",
  "bg",
  "my",
  "ca",
  "hr",
  "cs",
  "da",
  "et",
  "fil",
  "fi",
  "gl",
  "ka",
  "el",
  "ha",
  "he",
  "hu",
  "is",
  "jv",
  "kk",
  "km",
  "rw",
  "lo",
  "lv",
  "lt",
  "mk",
  "ms",
  "mn",
  "no",
  "fa",
  "ro",
  "sr",
  "si",
  "sk",
  "sl",
  "su",
  "sw",
  "sv",
  "uk",
  "uz",
  "zu",
] as const;

/** Sarvam Indic set (English lives in INTERNATIONAL_LANGUAGES). */
export const INDIC_LANGUAGES = [
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
] as const;

export const SUPPORTED_LANGUAGES = [
  "auto",
  ...INTERNATIONAL_LANGUAGES,
  ...INDIC_LANGUAGES,
] as const;

export const SUPPORTED_TARGET_LANGUAGES = [
  ...INTERNATIONAL_LANGUAGES,
  ...INDIC_LANGUAGES,
] as const satisfies readonly (typeof SUPPORTED_LANGUAGES)[number][];

export const PROVIDER_IDS = ["sarvam", "gemini", "mock"] as const;
export const AUDIO_SAMPLE_RATES = [16_000] as const;
export const CHANNEL_COUNTS = [1] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type SupportedTargetLanguage = (typeof SUPPORTED_TARGET_LANGUAGES)[number];
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATES)[number];
export type ChannelCount = (typeof CHANNEL_COUNTS)[number];

export const LANGUAGE_LABELS: Readonly<Record<SupportedLanguage, string>> = {
  auto: "Auto detect",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ar: "Arabic",
  ru: "Russian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  af: "Afrikaans",
  ak: "Akan",
  sq: "Albanian",
  am: "Amharic",
  hy: "Armenian",
  az: "Azerbaijani",
  eu: "Basque",
  be: "Belarusian",
  bg: "Bulgarian",
  my: "Burmese",
  ca: "Catalan",
  hr: "Croatian",
  cs: "Czech",
  da: "Danish",
  et: "Estonian",
  fil: "Filipino",
  fi: "Finnish",
  gl: "Galician",
  ka: "Georgian",
  el: "Greek",
  ha: "Hausa",
  he: "Hebrew",
  hu: "Hungarian",
  is: "Icelandic",
  jv: "Javanese",
  kk: "Kazakh",
  km: "Khmer",
  rw: "Kinyarwanda",
  lo: "Lao",
  lv: "Latvian",
  lt: "Lithuanian",
  mk: "Macedonian",
  ms: "Malay",
  mn: "Mongolian",
  no: "Norwegian",
  fa: "Persian",
  ro: "Romanian",
  sr: "Serbian",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  su: "Sundanese",
  sw: "Swahili",
  sv: "Swedish",
  uk: "Ukrainian",
  uz: "Uzbek",
  zu: "Zulu",
  hi: "Hindi",
  bn: "Bengali",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  mr: "Marathi",
  od: "Odia",
  pa: "Punjabi",
  ta: "Tamil",
  te: "Telugu",
  as: "Assamese",
  ur: "Urdu",
  ne: "Nepali",
  kok: "Konkani",
  ks: "Kashmiri",
  sd: "Sindhi",
  sa: "Sanskrit",
  sat: "Santali",
  mni: "Manipuri",
  brx: "Bodo",
  mai: "Maithili",
  doi: "Dogri",
};

/** Group caption languages for overlay selects, preserving protocol order. */
export function groupedCaptionLanguages(
  languages: readonly SupportedLanguage[],
): Array<{ id: "international" | "indic"; label: string; languages: SupportedLanguage[] }> {
  const allowed = new Set<string>(languages);
  const groups: Array<{
    id: "international" | "indic";
    label: string;
    languages: SupportedLanguage[];
  }> = [];
  const international = INTERNATIONAL_LANGUAGES.filter((language) => allowed.has(language));
  const indic = INDIC_LANGUAGES.filter((language) => allowed.has(language));
  if (international.length > 0) {
    groups.push({
      id: "international",
      label: "International",
      languages: [...international],
    });
  }
  if (indic.length > 0) {
    groups.push({
      id: "indic",
      label: "Indic",
      languages: [...indic],
    });
  }
  return groups;
}

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.some((language) => language === value);
}

export function isSupportedTargetLanguage(
  value: unknown,
): value is SupportedTargetLanguage {
  return typeof value === "string"
    && SUPPORTED_TARGET_LANGUAGES.some((language) => language === value);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.some((providerId) => providerId === value);
}

export function isAudioSampleRate(value: unknown): value is AudioSampleRate {
  return typeof value === "number" && AUDIO_SAMPLE_RATES.some((sampleRate) => sampleRate === value);
}

export function isChannelCount(value: unknown): value is ChannelCount {
  return typeof value === "number" && CHANNEL_COUNTS.some((channels) => channels === value);
}

export interface StartSessionRequest {
  type: "start_session";
  sessionId: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  provider?: ProviderId;
  sampleRate: AudioSampleRate;
  channels: ChannelCount;
}

export interface AudioChunkMessage {
  type: "audio_chunk";
  sessionId: string;
  sequence: number;
  timestampMs: number;
  encoding: "pcm_s16le";
  dataBase64: string;
}

export interface StopSessionRequest {
  type: "stop_session";
  sessionId: string;
}

export type ClientMessage = StartSessionRequest | AudioChunkMessage | StopSessionRequest;

export interface SessionStartedEvent {
  type: "session_started";
  sessionId: string;
  provider: ProviderId;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
}

export interface CaptionEvent {
  type: "caption";
  sessionId: string;
  sequence: number;
  utteranceId: string;
  revision: number;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  provider: ProviderId;
}

export interface SessionStoppedEvent {
  type: "session_stopped";
  sessionId: string;
}

export interface ErrorEvent {
  type: "error";
  sessionId?: string;
  code: string;
  message: string;
  retryable: boolean;
}

export type ServerMessage = SessionStartedEvent | CaptionEvent | SessionStoppedEvent | ErrorEvent;
