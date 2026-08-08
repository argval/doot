export const SUPPORTED_LANGUAGES = [
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
] as const;

export const SARVAM_SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;

export const PROVIDER_IDS = ["sarvam", "mock"] as const;
export const AUDIO_SAMPLE_RATES = [16_000, 24_000, 48_000] as const;
export const CHANNEL_COUNTS = [1, 2] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type SarvamSupportedLanguage = SupportedLanguage;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATES)[number];
export type ChannelCount = (typeof CHANNEL_COUNTS)[number];

export const LANGUAGE_LABELS: Readonly<Record<SupportedLanguage, string>> = {
  auto: "Auto detect",
  en: "English",
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

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.some((language) => language === value);
}

export const isSarvamSupportedLanguage = isSupportedLanguage;

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
