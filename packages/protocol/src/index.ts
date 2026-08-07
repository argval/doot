export type SupportedLanguage =
  | "auto"
  | "en"
  | "hi"
  | "ta"
  | "te"
  | "bn"
  | "mr"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "ja"
  | "ko"
  | "zh";

export type ProviderId = "sarvam" | "international-stt" | "mock";

export interface StartSessionRequest {
  type: "start_session";
  sessionId: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  provider?: ProviderId;
  sampleRate: 16000 | 24000 | 48000;
  channels: 1 | 2;
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

export const PROTOCOL_VERSION = 1;

