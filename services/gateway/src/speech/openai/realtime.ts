import { WebSocket, type RawData } from "ws";
import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
} from "../contract.js";
import { isRecord } from "../../util.js";

const OPENAI_REALTIME_WS = "wss://api.openai.com/v1/realtime?model=gpt-live-transcribe";
const SETUP_TIMEOUT_MS = 8_000;
const END_TIMEOUT_MS = 3_000;

export interface OpenAITranscribeRuntime {
  endpoint?: string;
  setupTimeoutMs?: number;
  endTimeoutMs?: number;
}

interface Waiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

/** GPT Live Transcribe needs 24 kHz PCM; Doot's 16 kHz capture stays unchanged. */
export class OpenAITranscribeSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private setupWaiter: Waiter | null = null;
  private endWaiter: Waiter | null = null;
  private flushPromise: Promise<void> | null = null;
  private closed = false;
  private ending = false;
  private lastAudioEndMs = 0;
  private turnSequence = 0;
  private activeTurnId: string | null = null;
  private readonly itemTurns = new Map<string, string>();

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: OpenAITranscribeRuntime = {},
  ) {
    if (options.channels !== 1) throw new Error("OpenAI GPT Live Transcribe requires mono audio");
    if (options.sampleRate !== 16_000) throw new Error(`OpenAI GPT Live Transcribe does not support ${options.sampleRate} Hz audio`);
  }

  open(): Promise<void> {
    const socket = new WebSocket(this.runtime.endpoint ?? OPENAI_REALTIME_WS, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        timeout: setTimeout(() => {
          waiter.reject(new Error("OpenAI GPT Live Transcribe setup timed out"));
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
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24_000 },
                transcription: {
                  model: "gpt-live-transcribe",
                  delay: "low",
                  ...(this.options.source === "auto" ? {} : { languages: [this.options.source] }),
                },
                turn_detection: {
                  type: "server_vad",
                  prefix_padding_ms: 100,
                  silence_duration_ms: 300,
                },
              },
            },
          },
        }));
      });
      socket.on("message", (raw) => this.handleMessage(raw));
      socket.once("error", (error) => {
        if (this.setupWaiter) waiter.reject(error);
        else this.options.onEvent({ type: "error", message: `OpenAI GPT Live Transcribe stream error: ${error.message}`, retryable: true });
      });
      socket.once("close", () => {
        if (this.setupWaiter) waiter.reject(new Error("OpenAI GPT Live Transcribe closed before setup"));
        if (this.endWaiter) this.endWaiter.reject(new Error("OpenAI GPT Live Transcribe closed during flush"));
        if (!this.closed && !this.ending && !this.setupWaiter) {
          this.options.onEvent({ type: "error", message: "OpenAI GPT Live Transcribe disconnected", retryable: true });
        }
      });
    });
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.ending || audio.byteLength === 0) return;
    if (audio.byteLength % 2 !== 0) {
      this.options.onEvent({ type: "error", message: "OpenAI GPT Live Transcribe received an incomplete PCM16 sample", retryable: false });
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN || this.setupWaiter) return;
    this.lastAudioEndMs = Math.max(this.lastAudioEndMs, timestampMs + audio.byteLength / 32);
    const upsampled = upsamplePcm16To24k(audio);
    if (upsampled.byteLength === 0) return;
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: upsampled.toString("base64") }));
  }

  commitAudioThrough(_timestampMs: number): void {}

  flush(): Promise<void> {
    if (this.closed || this.flushPromise) return this.flushPromise ?? Promise.resolve();
    this.ending = true;
    this.flushPromise = new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error("OpenAI GPT Live Transcribe is not connected")); return; }
      const waiter: Waiter = {
        timeout: setTimeout(() => waiter.resolve(), this.runtime.endTimeoutMs ?? END_TIMEOUT_MS),
        resolve: () => { if (this.endWaiter !== waiter) return; clearTimeout(waiter.timeout); this.endWaiter = null; resolve(); },
        reject: (error) => { if (this.endWaiter !== waiter) return; clearTimeout(waiter.timeout); this.endWaiter = null; reject(error); },
      };
      this.endWaiter = waiter;
      // Give server VAD its configured trailing silence before the socket closes.
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(14_400).toString("base64") }));
      if (!this.activeTurnId && this.itemTurns.size === 0) waiter.resolve();
    });
    return this.flushPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setupWaiter?.reject(new Error("OpenAI GPT Live Transcribe session closed"));
    this.endWaiter?.resolve();
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
      this.options.onEvent({ type: "warning", message: "OpenAI GPT Live Transcribe returned a non-JSON message" });
      return;
    }
    if (!isRecord(payload) || typeof payload.type !== "string") return;
    if (payload.type === "session.updated") { this.setupWaiter?.resolve(); return; }
    if (payload.type === "error") {
      const error = openAiError(payload);
      this.setupWaiter?.reject(new Error(error));
      this.options.onEvent({ type: "error", message: error, retryable: false });
      return;
    }
    if (payload.type === "input_audio_buffer.speech_started") {
      this.activeTurnId = `${this.options.sessionId}:openai:${this.turnSequence}`;
      this.turnSequence += 1;
      this.options.onEvent({ type: "speech_start", timestampMs: this.lastAudioEndMs, turnId: this.activeTurnId });
      return;
    }
    if (payload.type === "input_audio_buffer.speech_stopped") {
      const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
      const turnId = this.activeTurnId ?? itemId;
      if (!turnId) return;
      if (itemId) this.itemTurns.set(itemId, turnId);
      this.options.onEvent({ type: "speech_end", timestampMs: this.lastAudioEndMs, turnId, finalTranscriptPending: true });
      this.activeTurnId = null;
      return;
    }
    const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
    const turnId = itemId ? this.itemTurns.get(itemId) ?? this.activeTurnId ?? itemId : this.activeTurnId;
    if (!turnId) return;
    if (payload.type === "conversation.item.input_audio_transcription.delta" && typeof payload.delta === "string") {
      this.options.onEvent({ type: "transcript", text: payload.delta, timestampMs: this.lastAudioEndMs, turnId, isFinal: false });
      return;
    }
    if (payload.type === "conversation.item.input_audio_transcription.completed" && typeof payload.transcript === "string") {
      this.options.onEvent({ type: "transcript", text: payload.transcript, timestampMs: this.lastAudioEndMs, turnId, isFinal: true });
      if (itemId) this.itemTurns.delete(itemId);
      if (this.itemTurns.size === 0) this.endWaiter?.resolve();
    }
  }
}

/** Linear 16→24 kHz PCM16 conversion: each input pair becomes three samples. */
export function upsamplePcm16To24k(input: Uint8Array): Buffer {
  const sourcePcm = input.byteLength % 4 === 0 ? input : Buffer.concat([
    input,
    Buffer.from(input.subarray(-2)),
  ]);
  const output = Buffer.alloc((sourcePcm.byteLength / 4) * 6);
  for (let source = 0, target = 0; source < sourcePcm.byteLength; source += 4, target += 6) {
    const first = sourcePcm[source]! | (sourcePcm[source + 1]! << 8);
    const second = sourcePcm[source + 2]! | (sourcePcm[source + 3]! << 8);
    const a = first & 0x8000 ? first - 0x1_0000 : first;
    const b = second & 0x8000 ? second - 0x1_0000 : second;
    output.writeInt16LE(a, target);
    output.writeInt16LE(Math.round((a + b) / 2), target + 2);
    output.writeInt16LE(b, target + 4);
  }
  return output;
}

function openAiError(payload: Record<string, unknown>): string {
  const error = isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : undefined;
  return error ? `OpenAI GPT Live Transcribe: ${error}` : "OpenAI GPT Live Transcribe rejected the session";
}
