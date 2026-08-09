import { WebSocket, type RawData } from "ws";
import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
} from "../contract.js";
import {
  OPENAI_INPUT_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_TRANSLATE_MODEL,
  OPENAI_REALTIME_TRANSLATE_WS,
  toOpenAITranslateLanguageCode,
} from "./languages.js";
import { parseOpenAITranslateMessage } from "./messages.js";
import { resamplePcmS16leTo24k } from "./resample.js";

const CONNECT_TIMEOUT_MS = 8_000;
const FLUSH_TIMEOUT_MS = 3_000;
const UTTERANCE_GAP_MS = 900;
const MAX_QUEUE_BYTES = 192_000;
const MAX_SOCKET_BUFFER_BYTES = 256_000;

export interface OpenAIRealtimeTranslateRuntime {
  endpoint?: string;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
  utteranceGapMs?: number;
}

interface AudioFrame {
  audio: Buffer;
  timestampMs: number;
}

interface FlushWaiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

export class OpenAIRealtimeTranslateSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private readonly queuedFrames: AudioFrame[] = [];
  private queueBytes = 0;
  private closed = false;
  private terminalFailure = false;
  private lastTimestampMs = 0;
  private inputTranscript = "";
  private outputTranscript = "";
  private utteranceTimer: NodeJS.Timeout | null = null;
  private readonly flushWaiters = new Set<FlushWaiter>();
  private closingFlush = false;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: OpenAIRealtimeTranslateRuntime = {},
  ) {
    if (options.channels !== 1) {
      throw new Error("OpenAI realtime translate requires mono audio");
    }
    if (!options.target) {
      throw new Error("OpenAI realtime translate requires a target language");
    }
  }

  async open(): Promise<void> {
    await this.connect();
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.terminalFailure || audio.byteLength === 0) return;
    const resampled = resamplePcmS16leTo24k(audio, this.options.sampleRate);
    if (resampled.byteLength === 0) return;
    const frame: AudioFrame = { audio: resampled, timestampMs };
    this.lastTimestampMs = timestampMs;

    if (
      this.socket?.readyState === WebSocket.OPEN
      && this.socket.bufferedAmount < MAX_SOCKET_BUFFER_BYTES
      && this.queuedFrames.length === 0
    ) {
      this.sendFrame(frame);
      return;
    }
    this.enqueueFrame(frame);
    this.drainQueue();
  }

  commitAudioThrough(_timestampMs: number): void {
    // Continuous translation sessions do not expose manual audio commits.
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    this.drainQueue();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.finalizeUtterance(true);
      return;
    }

    this.closingFlush = true;
    await new Promise<void>((resolve, reject) => {
      const waiter: FlushWaiter = {
        timeout: setTimeout(() => {
          this.flushWaiters.delete(waiter);
          reject(new Error("OpenAI realtime translate flush timed out"));
        }, this.runtime.flushTimeoutMs ?? FLUSH_TIMEOUT_MS),
        resolve: () => {
          clearTimeout(waiter.timeout);
          this.flushWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(waiter.timeout);
          this.flushWaiters.delete(waiter);
          reject(error);
        },
      };
      this.flushWaiters.add(waiter);
      this.sendJson({ type: "session.close" });
    }).catch((error) => {
      this.finalizeUtterance(true);
      throw error;
    });
    this.finalizeUtterance(true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearUtteranceTimer();
    this.rejectFlushWaiters(new Error("OpenAI realtime translate session closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // ignore
      }
      socket.close();
    } else {
      socket?.terminate();
    }
    this.options.onEvent({ type: "state", state: "closed" });
  }

  private async connect(): Promise<void> {
    this.options.onEvent({ type: "state", state: "connecting" });
    const endpoint = this.runtime.endpoint
      ?? `${OPENAI_REALTIME_TRANSLATE_WS}?model=${OPENAI_REALTIME_TRANSLATE_MODEL}`;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.socket = socket;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error("OpenAI realtime translate connection timed out"));
      }, this.runtime.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      socket.once("open", () => {
        this.sendJson({
          type: "session.update",
          session: {
            audio: {
              input: {
                transcription: { model: OPENAI_INPUT_TRANSCRIPTION_MODEL },
              },
              output: {
                language: toOpenAITranslateLanguageCode(this.options.target!),
              },
            },
          },
        });
        this.options.onEvent({ type: "state", state: "open" });
        this.drainQueue();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      socket.on("message", (data) => this.handleMessage(data));
      socket.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
          return;
        }
        this.fail(error instanceof Error ? error.message : "OpenAI socket error", true);
      });
      socket.once("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("OpenAI realtime translate closed before ready"));
          return;
        }
        if (this.closingFlush) {
          this.resolveFlushWaiters();
        } else if (!this.closed && !this.terminalFailure) {
          this.fail("OpenAI realtime translate disconnected", true);
        }
      });
    });
  }

  private handleMessage(data: RawData): void {
    const event = parseOpenAITranslateMessage(data.toString());
    switch (event.type) {
      case "session.input_transcript.delta": {
        if (!event.delta) return;
        this.inputTranscript += event.delta;
        this.emitPartial();
        this.scheduleUtteranceFinalization();
        return;
      }
      case "session.output_transcript.delta": {
        if (!event.delta) return;
        this.outputTranscript += event.delta;
        this.emitPartial();
        this.scheduleUtteranceFinalization();
        return;
      }
      case "session.closed": {
        this.resolveFlushWaiters();
        this.finalizeUtterance(true);
        return;
      }
      case "error": {
        this.fail(event.message, event.retryable);
        return;
      }
      case "session.created":
      case "session.updated":
      case "session.output_audio.delta":
      case "ignored":
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  private emitPartial(): void {
    const sourceText = this.inputTranscript.trim();
    const translatedText = this.outputTranscript.trim();
    if (!sourceText && !translatedText) return;
    this.options.onEvent({
      type: "transcript",
      text: sourceText || translatedText,
      translatedText: translatedText || undefined,
      timestampMs: this.lastTimestampMs,
      isFinal: false,
    });
  }

  private scheduleUtteranceFinalization(): void {
    this.clearUtteranceTimer();
    this.utteranceTimer = setTimeout(() => {
      this.utteranceTimer = null;
      this.finalizeUtterance(false);
    }, this.runtime.utteranceGapMs ?? UTTERANCE_GAP_MS);
  }

  private finalizeUtterance(force: boolean): void {
    this.clearUtteranceTimer();
    const sourceText = this.inputTranscript.trim();
    const translatedText = this.outputTranscript.trim();
    if (!sourceText && !translatedText) return;
    if (!force && !translatedText && !sourceText) return;

    this.options.onEvent({
      type: "transcript",
      text: sourceText || translatedText,
      translatedText: translatedText || undefined,
      timestampMs: this.lastTimestampMs,
      isFinal: true,
    });
    this.inputTranscript = "";
    this.outputTranscript = "";
  }

  private enqueueFrame(frame: AudioFrame): void {
    this.queuedFrames.push(frame);
    this.queueBytes += frame.audio.byteLength;
    while (this.queueBytes > MAX_QUEUE_BYTES && this.queuedFrames.length > 1) {
      const removed = this.queuedFrames.shift();
      if (removed) this.queueBytes -= removed.audio.byteLength;
    }
  }

  private drainQueue(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (
      this.queuedFrames.length > 0
      && socket.bufferedAmount < MAX_SOCKET_BUFFER_BYTES
    ) {
      const frame = this.queuedFrames.shift();
      if (!frame) break;
      this.queueBytes -= frame.audio.byteLength;
      this.sendFrame(frame);
    }
  }

  private sendFrame(frame: AudioFrame): void {
    this.sendJson({
      type: "session.input_audio_buffer.append",
      audio: frame.audio.toString("base64"),
    });
  }

  private sendJson(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private clearUtteranceTimer(): void {
    if (!this.utteranceTimer) return;
    clearTimeout(this.utteranceTimer);
    this.utteranceTimer = null;
  }

  private resolveFlushWaiters(): void {
    for (const waiter of this.flushWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.flushWaiters.clear();
  }

  private rejectFlushWaiters(error: Error): void {
    for (const waiter of this.flushWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.flushWaiters.clear();
  }

  private fail(message: string, retryable: boolean): void {
    if (this.terminalFailure || this.closed) return;
    this.terminalFailure = true;
    this.rejectFlushWaiters(new Error(message));
    this.options.onEvent({ type: "error", message, retryable });
  }
}
