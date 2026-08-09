import { WebSocket, type RawData } from "ws";
import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
} from "../contract.js";
import {
  ELEVENLABS_REALTIME_MODEL,
  ELEVENLABS_REALTIME_STT_WS,
  toElevenLabsAudioFormat,
  toElevenLabsLanguageCode,
} from "./languages.js";
import { parseElevenLabsMessage } from "./messages.js";

const CONNECT_TIMEOUT_MS = 8_000;
const FLUSH_TIMEOUT_MS = 2_000;
const MAX_QUEUE_BYTES = 192_000;
const MAX_SOCKET_BUFFER_BYTES = 256_000;
const REPLAY_TAIL_BYTES = 16_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const MAX_RECONNECT_DELAY_MS = 4_000;

export interface ElevenLabsRealtimeRuntime {
  endpoint?: string;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
  drainTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

interface AudioFrame {
  id: number;
  audio: Buffer;
  timestampMs: number;
}

interface FlushWaiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

export class ElevenLabsRealtimeSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly queuedFrames: AudioFrame[] = [];
  private queueBytes = 0;
  private readonly replayTail: AudioFrame[] = [];
  private replayTailBytes = 0;
  private frameId = 0;
  private reconnectAttempts = 0;
  private closed = false;
  private terminalFailure = false;
  private speechActive = false;
  private hasUncommittedAudio = false;
  private lastTimestampMs = 0;
  private committedThroughTimestampMs = -1;
  private readonly flushWaiters = new Set<FlushWaiter>();

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: ElevenLabsRealtimeRuntime = {},
  ) {
    if (options.channels !== 1) {
      throw new Error("ElevenLabs Scribe v2 Realtime requires mono audio");
    }
  }

  async open(): Promise<void> {
    await this.connect(false);
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.terminalFailure || audio.byteLength === 0) return;
    const frame: AudioFrame = {
      id: this.frameId,
      audio: Buffer.from(audio),
      timestampMs,
    };
    this.frameId += 1;
    this.lastTimestampMs = timestampMs;
    this.hasUncommittedAudio = true;
    this.rememberReplayTail(frame);

    if (
      this.socket?.readyState === WebSocket.OPEN
      && this.socket.bufferedAmount < MAX_SOCKET_BUFFER_BYTES
      && this.queuedFrames.length === 0
    ) {
      this.sendFrame(frame);
      return;
    }
    this.enqueueFrame(frame);
    this.scheduleDrain();
  }

  commitAudioThrough(timestampMs: number): void {
    this.committedThroughTimestampMs = Math.max(
      this.committedThroughTimestampMs,
      timestampMs,
    );
    for (let index = this.queuedFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.queuedFrames[index];
      if (frame && frame.timestampMs <= this.committedThroughTimestampMs) {
        this.queuedFrames.splice(index, 1);
        this.queueBytes -= frame.audio.byteLength;
      }
    }
    while (
      this.replayTail.length > 0
      && (this.replayTail[0]?.timestampMs ?? Number.POSITIVE_INFINITY)
        <= this.committedThroughTimestampMs
    ) {
      const removed = this.replayTail.shift();
      if (removed) this.replayTailBytes -= removed.audio.byteLength;
    }
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    const drained = await this.waitForQueueDrain();
    if (!drained) {
      throw new Error(
        `ElevenLabs flush could not send ${this.queueBytes} buffered audio bytes`,
      );
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("ElevenLabs flush could not reach an open connection");
    }
    if (!this.hasUncommittedAudio) return;

    await new Promise<void>((resolve, reject) => {
      const waiter: FlushWaiter = {
        timeout: setTimeout(() => {
          this.flushWaiters.delete(waiter);
          reject(new Error("ElevenLabs flush timed out waiting for committed speech"));
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
      try {
        socket.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
        }));
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.reconnectTimer = null;
    this.drainTimer = null;
    this.rejectFlushWaiters(new Error("ElevenLabs session closed during flush"));
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.options.onEvent({ type: "state", state: "closed" });
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 500);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.close(1000, "Doot caption session closed");
    });
    this.options.onEvent({ type: "state", state: "closed" });
  }

  private connect(reconnecting: boolean): Promise<void> {
    this.options.onEvent({
      type: "state",
      state: reconnecting ? "reconnecting" : "connecting",
    });
    const url = new URL(this.runtime.endpoint ?? ELEVENLABS_REALTIME_STT_WS);
    url.searchParams.set("model_id", ELEVENLABS_REALTIME_MODEL);
    url.searchParams.set("audio_format", toElevenLabsAudioFormat(this.options.sampleRate));
    url.searchParams.set("commit_strategy", "vad");
    const language = toElevenLabsLanguageCode(this.options.source);
    if (language) url.searchParams.set("language_code", language);

    const socket = new WebSocket(url, {
      headers: { "xi-api-key": this.apiKey },
    });
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let socketOpened = false;
      let sessionStarted = false;
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error("ElevenLabs realtime connection timed out"));
        socket.terminate();
      }, this.runtime.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.options.onEvent({ type: "state", state: "open" });
        this.drainQueue();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      socket.once("open", () => {
        socketOpened = true;
      });
      socket.on("message", (raw) => {
        const event = this.parseMessage(raw);
        if (event === "session_started") {
          sessionStarted = true;
          succeed();
        }
      });
      socket.once("unexpected-response", (_request, response) => {
        fail(new Error(
          `ElevenLabs WebSocket rejected the connection (HTTP ${response.statusCode})`,
        ));
        socket.terminate();
      });
      socket.once("error", (error) => {
        if (!sessionStarted) fail(error);
        else this.options.onEvent({
          type: "warning",
          message: `ElevenLabs stream error: ${error.message}`,
        });
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        const detail = reason.length > 0 ? reason.toString() : `code ${code}`;
        if (!sessionStarted) {
          fail(new Error(
            `ElevenLabs stream closed before session start (${detail})`,
          ));
        } else if (!this.closed && !this.terminalFailure) {
          this.rejectFlushWaiters(new Error("ElevenLabs stream disconnected"));
          this.queueReplayTail();
          this.scheduleReconnect(`ElevenLabs stream disconnected (${detail})`);
        }
        if (!socketOpened && !settled) {
          fail(new Error("ElevenLabs WebSocket could not open"));
        }
      });
    });
  }

  private parseMessage(raw: RawData): string | null {
    const payload = parseElevenLabsMessage(raw.toString());
    if (payload.kind === "invalid") {
      this.options.onEvent({
        type: "warning",
        message: "ElevenLabs returned a non-JSON realtime message",
      });
      return null;
    }
    if (payload.kind === "session_started") return payload.messageType;

    if (payload.kind === "transcript") {
      if (payload.text) {
        if (!this.speechActive) {
          this.speechActive = true;
          this.options.onEvent({
            type: "speech_start",
            timestampMs: this.lastTimestampMs,
          });
        }
        this.options.onEvent({
          type: "transcript",
          text: payload.text,
          timestampMs: this.lastTimestampMs,
          isFinal: payload.committed,
          ...(payload.languageCode ? { languageCode: payload.languageCode } : {}),
        });
      }
      if (payload.committed) {
        this.hasUncommittedAudio = false;
        if (this.speechActive) {
          this.speechActive = false;
          this.options.onEvent({
            type: "speech_end",
            timestampMs: this.lastTimestampMs,
          });
        }
        this.resolveFlushWaiters();
      }
      return payload.messageType;
    }

    if (payload.kind === "error") {
      this.options.onEvent({
        type: "error",
        message: payload.message,
        retryable: payload.retryable,
      });
      this.rejectFlushWaiters(new Error(payload.message));
      if (!payload.retryable) {
        this.terminalFailure = true;
        this.socket?.close(1008, payload.messageType);
      } else if (payload.messageType !== "commit_throttled") {
        this.socket?.terminate();
      }
      return payload.messageType;
    }
    return payload.messageType ?? null;
  }

  private sendFrame(frame: AudioFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.enqueueFrame(frame, true);
      return;
    }
    try {
      socket.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: frame.audio.toString("base64"),
      }), (error) => {
        if (!error || this.closed) return;
        this.enqueueFrame(frame, true);
        socket.terminate();
      });
    } catch {
      this.enqueueFrame(frame, true);
      socket.terminate();
    }
  }

  private enqueueFrame(frame: AudioFrame, atFront = false): void {
    if (frame.timestampMs <= this.committedThroughTimestampMs) return;
    if (this.queuedFrames.some((queued) => queued.id === frame.id)) return;
    if (atFront) this.queuedFrames.unshift(frame);
    else this.queuedFrames.push(frame);
    this.queueBytes += frame.audio.byteLength;
    let droppedBytes = 0;
    while (this.queueBytes > MAX_QUEUE_BYTES && this.queuedFrames.length > 1) {
      const removed = this.queuedFrames.shift();
      if (!removed) break;
      this.queueBytes -= removed.audio.byteLength;
      droppedBytes += removed.audio.byteLength;
    }
    if (droppedBytes > 0) {
      this.options.onEvent({
        type: "warning",
        message: "ElevenLabs buffer filled; oldest audio was dropped",
      });
    }
  }

  private rememberReplayTail(frame: AudioFrame): void {
    this.replayTail.push(frame);
    this.replayTailBytes += frame.audio.byteLength;
    while (this.replayTailBytes > REPLAY_TAIL_BYTES && this.replayTail.length > 1) {
      const removed = this.replayTail.shift();
      if (removed) this.replayTailBytes -= removed.audio.byteLength;
    }
  }

  private queueReplayTail(): void {
    for (let index = this.replayTail.length - 1; index >= 0; index -= 1) {
      const frame = this.replayTail[index];
      if (frame) this.enqueueFrame(frame, true);
    }
  }

  private drainQueue(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
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
    if (this.queuedFrames.length > 0) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.closed) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainQueue();
    }, 20);
  }

  private async waitForQueueDrain(): Promise<boolean> {
    const startedAt = Date.now();
    while (
      this.queuedFrames.length > 0
      && Date.now() - startedAt < (this.runtime.drainTimeoutMs ?? CONNECT_TIMEOUT_MS)
    ) {
      this.drainQueue();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return this.queuedFrames.length === 0;
  }

  private scheduleReconnect(message: string): void {
    if (this.closed || this.terminalFailure || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (
      this.reconnectAttempts
      > (this.runtime.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)
    ) {
      this.terminalFailure = true;
      this.options.onEvent({
        type: "error",
        message: `${message}; reconnect limit reached`,
        retryable: false,
      });
      return;
    }
    this.options.onEvent({ type: "warning", message });
    this.options.onEvent({ type: "state", state: "reconnecting" });
    const delayMs = Math.min(
      (this.runtime.reconnectBaseDelayMs ?? 250)
        * (2 ** (this.reconnectAttempts - 1)),
      this.runtime.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(true).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.scheduleReconnect(detail);
      });
    }, delayMs);
  }

  private resolveFlushWaiters(): void {
    for (const waiter of [...this.flushWaiters]) waiter.resolve();
    this.flushWaiters.clear();
  }

  private rejectFlushWaiters(error: Error): void {
    for (const waiter of [...this.flushWaiters]) waiter.reject(error);
    this.flushWaiters.clear();
  }
}
