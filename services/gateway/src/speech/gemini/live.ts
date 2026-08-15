import { WebSocket, type RawData } from "ws";
import {
  pcmS16leDurationMs,
  type OpenProviderSessionOptions,
  type ProviderStreamSession,
} from "../contract.js";
import { isRecord } from "../../util.js";
import { mergeStreamingText } from "../../merge-text.js";
import {
  GEMINI_LIVE_TRANSLATE_MODEL,
  GEMINI_LIVE_TRANSLATE_WS,
  filterGeminiTranslationToTarget,
  geminiLanguageCodeMatches,
  toGeminiLanguageCode,
} from "./languages.js";

const SETUP_TIMEOUT_MS = 8_000;
const END_TIMEOUT_MS = 3_000;
/** Soft coalesce target — desktop already emits ~100 ms frames. */
const PCM_BYTES_PER_100_MS = 3_200;
/** Same silence window Sarvam Realtime uses (`silence_duration_ms=500`). */
const GEMINI_SILENCE_DURATION_MS = 500;

export interface GeminiLiveRuntime {
  endpoint?: string;
  setupTimeoutMs?: number;
  endTimeoutMs?: number;
}

interface Waiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Server-to-server Gemini Live Translate session. Google emits source and
 * translated transcripts independently, so this adapter correlates both into
 * one provider utterance before publishing native translation events.
 */
export class GeminiLiveTranslateSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private setupWaiter: Waiter | null = null;
  private readonly endWaiters = new Set<Waiter>();
  private sourceText = "";
  private translatedText = "";
  private sourceLanguageCode: string | undefined;
  private targetLanguageCode: string | undefined;
  private lastEmittedTranslation = "";
  private lastAudioEndMs = 0;
  private turnAudioStartMs: number | null = null;
  private pendingAudio = Buffer.alloc(0);
  private pendingAudioTimestampMs: number | null = null;
  private speechStarted = false;
  private turnId: string | null = null;
  private turnSequence = 0;
  private awaitingTurn = false;
  private setupComplete = false;
  private ending = false;
  private closed = false;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: GeminiLiveRuntime = {},
  ) {
    if (options.channels !== 1) {
      throw new Error("Gemini Live Translate requires mono audio");
    }
    if (options.sampleRate !== 16_000) {
      throw new Error(`Gemini Live Translate does not support ${options.sampleRate} Hz audio`);
    }
  }

  open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Gemini session is closed"));
    const url = new URL(this.runtime.endpoint ?? GEMINI_LIVE_TRANSLATE_WS);
    url.searchParams.set("key", this.apiKey);
    const socket = new WebSocket(url);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        timeout: setTimeout(() => {
          waiter.reject(new Error("Gemini Live Translate setup timed out"));
          socket.terminate();
        }, this.runtime.setupTimeoutMs ?? SETUP_TIMEOUT_MS),
        resolve: () => {
          if (this.setupWaiter !== waiter) return;
          clearTimeout(waiter.timeout);
          this.setupWaiter = null;
          resolve();
        },
        reject: (error) => {
          if (this.setupWaiter !== waiter) return;
          clearTimeout(waiter.timeout);
          this.setupWaiter = null;
          reject(error);
        },
      };
      this.setupWaiter = waiter;

      socket.once("open", () => {
        if (this.closed || this.socket !== socket) {
          waiter.reject(new Error("Gemini Live Translate session was superseded"));
          socket.close();
          return;
        }
        this.sendSetup(socket, waiter);
      });
      socket.on("message", (raw) => this.handleMessage(raw));
      socket.once("unexpected-response", (_request, response) => {
        waiter.reject(new Error(
          `Gemini Live Translate WebSocket rejected the connection (HTTP ${response.statusCode})`,
        ));
        socket.terminate();
      });
      socket.once("error", (error) => {
        if (!this.setupComplete) {
          waiter.reject(error);
          return;
        }
        this.options.onEvent({
          type: "error",
          message: `Gemini Live Translate stream error: ${error.message}`,
          retryable: true,
        });
      });
      socket.once("close", (code, reason) => {
        if (this.socket === socket) this.socket = null;
        if (!this.setupComplete) {
          const detail = reason.length > 0 ? reason.toString() : `code ${code}`;
          waiter.reject(new Error(`Gemini Live Translate closed before setup (${detail})`));
        } else if (!this.closed) {
          this.rejectEndWaiters(new Error("Gemini Live Translate disconnected during flush"));
          const detail = reason.length > 0 ? reason.toString() : `code ${code}`;
          this.options.onEvent({
            type: "error",
            message: `Gemini Live Translate disconnected (${detail})`,
            retryable: true,
          });
        }
      });
    });
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.ending || audio.byteLength === 0) return;
    const socket = this.socket;
    if (!this.setupComplete || !socket || socket.readyState !== WebSocket.OPEN) {
      this.options.onEvent({
        type: "warning",
        message: "Gemini Live Translate dropped audio before setup completed",
      });
      return;
    }
    if (audio.byteLength % 2 !== 0) {
      this.options.onEvent({
        type: "error",
        message: "Gemini Live Translate received an incomplete PCM16 sample",
        retryable: false,
      });
      return;
    }

    if (!this.awaitingTurn) this.turnAudioStartMs = timestampMs;
    this.awaitingTurn = true;
    // Mirror Sarvam: forward live PCM as it arrives. Only coalesce undersized
    // leftovers toward ~100 ms — never invent silence by zero-padding.
    if (this.pendingAudio.byteLength === 0) this.pendingAudioTimestampMs = timestampMs;
    this.pendingAudio = Buffer.concat([this.pendingAudio, Buffer.from(audio)]);
    while (this.pendingAudio.byteLength >= PCM_BYTES_PER_100_MS) {
      const frame = this.pendingAudio.subarray(0, PCM_BYTES_PER_100_MS);
      this.pendingAudio = this.pendingAudio.subarray(PCM_BYTES_PER_100_MS);
      this.sendAudioFrame(
        socket,
        frame,
        this.pendingAudioTimestampMs ?? timestampMs,
      );
      this.pendingAudioTimestampMs = this.pendingAudio.byteLength > 0
        ? (this.pendingAudioTimestampMs ?? timestampMs) + 100
        : null;
    }
    if (
      this.pendingAudio.byteLength > 0
      && this.pendingAudio.byteLength === audio.byteLength
      && audio.byteLength < PCM_BYTES_PER_100_MS
    ) {
      // Desktop already paced this chunk; send it immediately like Sarvam.
      this.sendAudioFrame(
        socket,
        this.pendingAudio,
        this.pendingAudioTimestampMs ?? timestampMs,
      );
      this.pendingAudio = Buffer.alloc(0);
      this.pendingAudioTimestampMs = null;
    }
  }

  commitAudioThrough(_timestampMs: number): void {
    // Gemini consumes the live stream immediately and exposes no commit cursor.
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.ending) return this.waitForEnd();
    this.ending = true;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live Translate flush requires an open connection");
    }
    if (this.pendingAudio.byteLength > 0) {
      // Send the real remainder — zero-padding looked like speech silence/noise.
      this.sendAudioFrame(
        socket,
        this.pendingAudio,
        this.pendingAudioTimestampMs ?? this.lastAudioEndMs,
      );
      this.pendingAudio = Buffer.alloc(0);
      this.pendingAudioTimestampMs = null;
    }
    this.send(socket, { realtimeInput: { audioStreamEnd: true } });
    if (!this.awaitingTurn && !this.sourceText && !this.translatedText) return;
    await this.waitForEnd();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setupWaiter?.reject(new Error("Gemini Live Translate closed during setup"));
    this.rejectEndWaiters(new Error("Gemini Live Translate closed during flush"));

    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        socket.removeAllListeners();
        socket.terminate();
        finish();
      }, 500);
      socket.once("close", finish);
      socket.close(1000, "Doot caption session closed");
    });
  }

  private sendSetup(socket: WebSocket, waiter: Waiter): void {
    try {
      // Transcription + VAD live on setup (BidiGenerateContentSetup). Google's
      // live-translate WS example nests transcription under generationConfig and
      // the runtime rejects that with 1007. Silence window mirrors Sarvam.
      socket.send(JSON.stringify({
        setup: {
          model: `models/${GEMINI_LIVE_TRANSLATE_MODEL}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              prefixPaddingMs: 20,
              silenceDurationMs: GEMINI_SILENCE_DURATION_MS,
            },
          },
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: toGeminiLanguageCode(this.options.target),
              echoTargetLanguage: true,
            },
          },
        },
      }));
    } catch (error) {
      waiter.reject(asError(error));
    }
  }

  private handleMessage(raw: RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      this.options.onEvent({
        type: "warning",
        message: "Gemini Live Translate returned a non-JSON streaming message",
      });
      return;
    }
    if (!isRecord(payload)) return;

    if ("setupComplete" in payload) {
      this.setupComplete = true;
      this.setupWaiter?.resolve();
      return;
    }
    if (isRecord(payload.error)) {
      const message = typeof payload.error.message === "string"
        ? payload.error.message
        : "Gemini Live Translate returned an error";
      if (!this.setupComplete) {
        this.setupWaiter?.reject(new Error(message));
        this.socket?.terminate();
        return;
      }
      this.options.onEvent({ type: "error", message, retryable: false });
      this.rejectEndWaiters(new Error(message));
      return;
    }
    if (isRecord(payload.goAway)) {
      this.options.onEvent({
        type: "warning",
        message: "Gemini Live Translate announced an upcoming disconnect",
      });
      return;
    }
    if (!isRecord(payload.serverContent)) return;

    const content = payload.serverContent;
    const input = readTranscription(content.inputTranscription);
    if (input) this.handleInputTranscription(input.text, input.languageCode);
    const output = readTranscription(content.outputTranscription);
    if (output) this.handleOutputTranscription(output.text, output.languageCode);
    if (content.turnComplete === true) this.finalizeTurn();
  }

  private handleInputTranscription(text: string, languageCode?: string): void {
    const merged = mergeStreamingText(this.sourceText, text);
    if (!merged || merged === this.sourceText) return;
    this.sourceText = merged;
    this.sourceLanguageCode = languageCode ?? this.sourceLanguageCode;
    this.markSpeechStarted();
    this.options.onEvent({
      type: "transcript",
      text: this.sourceText,
      timestampMs: this.lastAudioEndMs,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(this.sourceLanguageCode ? { languageCode: this.sourceLanguageCode } : {}),
      isFinal: false,
    });
    this.emitTranslation(false);
  }

  private handleOutputTranscription(text: string, languageCode?: string): void {
    // Gemini frequently puts source-language text on outputTranscription during
    // fast/mixed speech. Never let that into translated-only captions.
    if (!geminiLanguageCodeMatches(languageCode, this.options.target)) return;
    const filteredIncoming = filterGeminiTranslationToTarget(
      text,
      this.options.target,
      this.options.source,
    );
    if (!filteredIncoming) return;

    const merged = mergeStreamingText(this.translatedText, filteredIncoming);
    const filteredMerged = filterGeminiTranslationToTarget(
      merged,
      this.options.target,
      this.options.source,
    );
    if (!filteredMerged || filteredMerged === this.translatedText) return;
    this.translatedText = filteredMerged;
    this.targetLanguageCode = languageCode ?? this.targetLanguageCode ?? this.options.target;
    // Translated-only overlay: do not wait for the source transcript stream.
    this.markSpeechStarted();
    this.emitTranslation(false);
  }

  private markSpeechStarted(): void {
    if (this.speechStarted) return;
    this.speechStarted = true;
    this.turnId = `${this.options.sessionId}:${this.turnSequence}`;
    this.turnSequence += 1;
    this.options.onEvent({
      type: "speech_start",
      timestampMs: this.turnAudioStartMs ?? this.lastAudioEndMs,
      turnId: this.turnId,
    });
  }

  private emitTranslation(isFinal: boolean): void {
    if (!this.translatedText) return;
    if (!isFinal && this.translatedText === this.lastEmittedTranslation) return;
    this.lastEmittedTranslation = this.translatedText;
    this.options.onEvent({
      type: "translation",
      text: this.translatedText,
      timestampMs: this.lastAudioEndMs,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(this.targetLanguageCode ? { languageCode: this.targetLanguageCode } : {}),
      isFinal,
    });
  }

  private finalizeTurn(): void {
    if (this.translatedText) {
      this.emitTranslation(true);
    } else if (this.sourceText) {
      this.options.onEvent({
        type: "error",
        message: "Gemini Live Translate completed without translated text",
        retryable: true,
      });
    }
    if (this.speechStarted) {
      this.options.onEvent({
        type: "speech_end",
        timestampMs: this.lastAudioEndMs,
        ...(this.turnId ? { turnId: this.turnId } : {}),
      });
    }
    this.sourceText = "";
    this.translatedText = "";
    this.sourceLanguageCode = undefined;
    this.targetLanguageCode = undefined;
    this.lastEmittedTranslation = "";
    this.speechStarted = false;
    this.turnId = null;
    this.awaitingTurn = false;
    this.turnAudioStartMs = null;
    this.resolveEndWaiters();
  }

  private waitForEnd(): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        timeout: setTimeout(() => {
          this.endWaiters.delete(waiter);
          reject(new Error("Gemini Live Translate flush timed out waiting for completion"));
        }, this.runtime.endTimeoutMs ?? END_TIMEOUT_MS),
        resolve: () => {
          clearTimeout(waiter.timeout);
          this.endWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(waiter.timeout);
          this.endWaiters.delete(waiter);
          reject(error);
        },
      };
      this.endWaiters.add(waiter);
    });
  }

  private resolveEndWaiters(): void {
    for (const waiter of [...this.endWaiters]) waiter.resolve();
  }

  private rejectEndWaiters(error: Error): void {
    for (const waiter of [...this.endWaiters]) waiter.reject(error);
  }

  private send(socket: WebSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.options.onEvent({
        type: "error",
        message: `Gemini Live Translate could not send streaming data: ${asError(error).message}`,
        retryable: true,
      });
    }
  }

  private sendAudioFrame(socket: WebSocket, frame: Uint8Array, timestampMs: number): void {
    this.lastAudioEndMs = Math.max(
      this.lastAudioEndMs,
      timestampMs + pcmS16leDurationMs(
        frame.byteLength,
        this.options.sampleRate,
        this.options.channels,
      ),
    );
    this.send(socket, {
      realtimeInput: {
        audio: {
          data: Buffer.from(frame).toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });
  }
}

function readTranscription(value: unknown): {
  text: string;
  languageCode?: string;
} | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const text = normalizeText(value.text);
  if (!text) return null;
  return {
    text,
    ...(typeof value.languageCode === "string"
      ? { languageCode: value.languageCode }
      : {}),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
