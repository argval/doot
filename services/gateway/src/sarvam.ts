import { WebSocket } from "ws";
import type { SupportedLanguage } from "@doot/protocol";

const SARVAM_STT_WS = "wss://api.sarvam.ai/speech-to-text/ws";
const REQUEST_TIMEOUT_MS = 8_000;
const STREAM_FRAME_BYTES = 3_200; // 100 ms of mono PCM S16LE @ 16 kHz

const languageCodes: Record<SupportedLanguage, string> = {
  auto: "unknown",
  en: "en-IN",
  hi: "hi-IN",
  ta: "ta-IN",
  te: "te-IN",
  bn: "bn-IN",
  mr: "mr-IN",
  es: "en-IN",
  fr: "en-IN",
  de: "en-IN",
  pt: "en-IN",
  ja: "en-IN",
  ko: "en-IN",
  zh: "en-IN",
};

export type SarvamMode = "transcribe" | "translate";

export function resolveSarvamMode(source: SupportedLanguage, target: SupportedLanguage): SarvamMode {
  if (target === "en" && source !== "en") return "translate";
  return "transcribe";
}

export function toSarvamLanguageCode(language: SupportedLanguage): string {
  return languageCodes[language];
}

/** RMS of mono PCM S16LE. Used to skip near-silent batches before calling Sarvam. */
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

export async function transcribeWithSarvam(options: {
  apiKey: string;
  audio: Uint8Array;
  source: SupportedLanguage;
  target: SupportedLanguage;
  sampleRate?: 8_000 | 16_000;
}): Promise<{ sourceText: string; translatedText: string } | null> {
  if (!hasSpeechEnergy(options.audio)) return null;

  const mode = resolveSarvamMode(options.source, options.target);
  const languageCode = toSarvamLanguageCode(options.source);
  const sampleRate = options.sampleRate ?? 16_000;
  const transcript = await requestSarvamTranscript({
    apiKey: options.apiKey,
    audio: options.audio,
    mode,
    languageCode,
    sampleRate,
  });

  if (!transcript) return null;

  if (mode === "translate") {
    return { sourceText: "", translatedText: transcript };
  }

  return { sourceText: transcript, translatedText: transcript };
}

function requestSarvamTranscript(options: {
  apiKey: string;
  audio: Uint8Array;
  mode: SarvamMode;
  languageCode: string;
  sampleRate: 8_000 | 16_000;
}): Promise<string> {
  const url = new URL(SARVAM_STT_WS);
  url.searchParams.set("model", "saaras:v3");
  url.searchParams.set("mode", options.mode);
  url.searchParams.set("language-code", options.languageCode);
  url.searchParams.set("sample_rate", String(options.sampleRate));
  url.searchParams.set("input_audio_codec", "pcm_s16le");
  url.searchParams.set("flush_signal", "true");
  url.searchParams.set("high_vad_sensitivity", "true");

  return new Promise((resolve, reject) => {
    let settled = false;
    let latestTranscript = "";

    const socket = new WebSocket(url, {
      headers: { "Api-Subscription-Key": options.apiKey },
    });

    const finish = (error?: Error, transcript?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (error) reject(error);
      else resolve((transcript ?? "").trim());
    };

    const timeout = setTimeout(() => {
      // No speech / VAD never fired — treat as empty, not a hard failure.
      finish(undefined, latestTranscript);
    }, REQUEST_TIMEOUT_MS);

    socket.once("open", () => {
      for (let offset = 0; offset < options.audio.byteLength; offset += STREAM_FRAME_BYTES) {
        const frame = options.audio.subarray(offset, Math.min(offset + STREAM_FRAME_BYTES, options.audio.byteLength));
        socket.send(JSON.stringify({
          audio: {
            data: Buffer.from(frame).toString("base64"),
            sample_rate: String(options.sampleRate),
            encoding: "audio/wav",
          },
        }));
      }
      socket.send(JSON.stringify({ type: "flush" }));
    });

    socket.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        finish(new Error("Sarvam returned a non-JSON response"));
        return;
      }

      if (!isRecord(payload) || typeof payload.type !== "string") return;

      if (payload.type === "error") {
        const data = isRecord(payload.data) ? payload.data : {};
        const message = typeof data.error === "string" ? data.error : "Sarvam streaming failed";
        finish(new Error(message));
        return;
      }

      if (payload.type === "data" && isRecord(payload.data) && typeof payload.data.transcript === "string") {
        const transcript = payload.data.transcript.trim();
        if (!transcript) return;
        latestTranscript = transcript;
        finish(undefined, transcript);
      }
    });

    socket.once("unexpected-response", (_request, response) => {
      finish(new Error(`Sarvam WebSocket rejected the connection (HTTP ${response.statusCode})`));
    });

    socket.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.once("close", () => {
      finish(undefined, latestTranscript);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
