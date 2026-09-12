import { WebSocket, type RawData } from "ws";
import {
  pcmS16leDurationMs,
  type OpenProviderSessionOptions,
  type ProviderStreamSession,
} from "../contract.js";
import { isRecord } from "../../util.js";
import { toSpeechmaticsLanguageCode } from "./languages.js";

const SPEECHMATICS_REALTIME_WS = "wss://eu2.rt.speechmatics.com/v2";
const SETUP_TIMEOUT_MS = 8_000;
const END_TIMEOUT_MS = 3_000;

export interface SpeechmaticsRealtimeRuntime {
  endpoint?: string;
  setupTimeoutMs?: number;
  endTimeoutMs?: number;
}

interface Waiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

/** Speechmatics Realtime PCM16 adapter. Translation remains pinned by Doot's router. */
export class SpeechmaticsRealtimeSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private setupWaiter: Waiter | null = null;
  private endWaiter: Waiter | null = null;
  private closed = false;
  private ending = false;
  private audioSequence = 0;
  private lastAudioEndMs = 0;
  private turnId: string | null = null;
  private turnSequence = 0;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: SpeechmaticsRealtimeRuntime = {},
  ) {
    if (options.channels !== 1) throw new Error("Speechmatics Realtime requires mono audio");
    if (options.sampleRate !== 16_000) throw new Error(`Speechmatics Realtime does not support ${options.sampleRate} Hz audio`);
  }

  open(): Promise<void> {
    const socket = new WebSocket(this.runtime.endpoint ?? SPEECHMATICS_REALTIME_WS, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        timeout: setTimeout(() => {
          waiter.reject(new Error("Speechmatics Realtime setup timed out"));
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
        socket.send(JSON.stringify({
          message: "StartRecognition",
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16_000 },
          transcription_config: {
            language: toSpeechmaticsLanguageCode(this.options.source),
            enable_partials: true,
            max_delay: 1,
          },
        }));
      });
      socket.on("message", (raw) => this.handleMessage(raw));
      socket.once("error", (error) => {
        if (this.setupWaiter) waiter.reject(error);
        else this.options.onEvent({ type: "error", message: `Speechmatics Realtime stream error: ${error.message}`, retryable: true });
      });
      socket.once("close", () => {
        if (this.setupWaiter) waiter.reject(new Error("Speechmatics Realtime closed before setup"));
        if (this.endWaiter) this.endWaiter.reject(new Error("Speechmatics Realtime closed during flush"));
        if (!this.closed && !this.ending && !this.setupWaiter) {
          this.options.onEvent({ type: "error", message: "Speechmatics Realtime disconnected", retryable: true });
        }
      });
    });
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.ending || audio.byteLength === 0) return;
    if (audio.byteLength % 2 !== 0) {
      this.options.onEvent({ type: "error", message: "Speechmatics Realtime received an incomplete PCM16 sample", retryable: false });
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN || this.setupWaiter) return;
    this.lastAudioEndMs = Math.max(this.lastAudioEndMs, timestampMs + pcmS16leDurationMs(audio.byteLength, this.options.sampleRate, this.options.channels));
    this.audioSequence += 1;
    this.socket.send(audio);
  }

  commitAudioThrough(_timestampMs: number): void {}

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ending && this.endWaiter) return new Promise((resolve, reject) => {
      const waiter = this.endWaiter!;
      const originalResolve = waiter.resolve;
      const originalReject = waiter.reject;
      waiter.resolve = () => { originalResolve(); resolve(); };
      waiter.reject = (error) => { originalReject(error); reject(error); };
    });
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Speechmatics Realtime is not connected"));
    this.ending = true;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        timeout: setTimeout(() => waiter.reject(new Error("Speechmatics Realtime end timed out waiting for completion")), this.runtime.endTimeoutMs ?? END_TIMEOUT_MS),
        resolve: () => { if (this.endWaiter !== waiter) return; clearTimeout(waiter.timeout); this.endWaiter = null; resolve(); },
        reject: (error) => { if (this.endWaiter !== waiter) return; clearTimeout(waiter.timeout); this.endWaiter = null; reject(error); },
      };
      this.endWaiter = waiter;
      this.socket!.send(JSON.stringify({ message: "EndOfStream", last_seq_no: this.audioSequence }));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setupWaiter?.reject(new Error("Speechmatics Realtime session closed"));
    this.endWaiter?.reject(new Error("Speechmatics Realtime session closed"));
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 500);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close();
    });
  }

  private handleMessage(raw: RawData): void {
    let payload: unknown;
    try { payload = JSON.parse(raw.toString()); } catch {
      this.options.onEvent({ type: "warning", message: "Speechmatics Realtime returned a non-JSON message" });
      return;
    }
    if (!isRecord(payload) || typeof payload.message !== "string") return;
    if (payload.message === "RecognitionStarted") {
      this.setupWaiter?.resolve();
      return;
    }
    if (payload.message === "EndOfTranscript") {
      this.endWaiter?.resolve();
      return;
    }
    if (payload.message === "Error") {
      this.options.onEvent({ type: "error", message: speechmaticsError(payload), retryable: false });
      this.setupWaiter?.reject(new Error(speechmaticsError(payload)));
      return;
    }
    if (payload.message !== "AddPartialTranscript" && payload.message !== "AddTranscript") return;
    const metadata = isRecord(payload.metadata) ? payload.metadata : {};
    const text = typeof metadata.transcript === "string" ? metadata.transcript.trim() : "";
    if (!text) return;
    if (!this.turnId) {
      this.turnId = `${this.options.sessionId}:speechmatics:${this.turnSequence}`;
      this.turnSequence += 1;
      this.options.onEvent({ type: "speech_start", timestampMs: this.lastAudioEndMs, turnId: this.turnId });
    }
    const turnId = this.turnId;
    const isFinal = payload.message === "AddTranscript";
    this.options.onEvent({ type: "transcript", text, timestampMs: this.lastAudioEndMs, turnId, isFinal });
    if (isFinal) {
      this.options.onEvent({ type: "speech_end", timestampMs: this.lastAudioEndMs, turnId });
      this.turnId = null;
    }
  }
}

function speechmaticsError(payload: Record<string, unknown>): string {
  return typeof payload.reason === "string" ? `Speechmatics Realtime: ${payload.reason}` : "Speechmatics Realtime rejected the session";
}
