import { createHash } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
} from "../contract.js";
import {
  OPENAI_REALTIME_TRANSLATE_MODEL,
  OPENAI_REALTIME_TRANSLATE_WS,
  toOpenAITranslateLanguageCode,
} from "./languages.js";
import { parseOpenAITranslateMessage } from "./messages.js";
import { resamplePcmS16leTo24k } from "./resample.js";

const CONNECT_TIMEOUT_MS = 8_000;
const FLUSH_TIMEOUT_MS = 3_000;
const DRAIN_TIMEOUT_MS = 8_000;
const DRAIN_INTERVAL_MS = 20;
const UTTERANCE_GAP_MS = 900;
const MAX_QUEUE_BYTES = 192_000;
const MAX_SOCKET_BUFFER_BYTES = 256_000;
const REPLAY_TAIL_BYTES = 24_000; // 500 ms of 24 kHz PCM S16LE.
const MAX_RECONNECT_ATTEMPTS = 6;
const MAX_RECONNECT_DELAY_MS = 4_000;

export interface OpenAIRealtimeTranslateRuntime {
  endpoint?: string;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
  drainTimeoutMs?: number;
  utteranceGapMs?: number;
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

export class OpenAIRealtimeTranslateSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly queuedFrames: AudioFrame[] = [];
  private queueBytes = 0;
  private readonly replayTail: AudioFrame[] = [];
  private replayTailBytes = 0;
  private frameId = 0;
  private pendingSends = 0;
  private sendFailure: Error | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private sessionClosed = false;
  private terminalFailure = false;
  private lastTimestampMs = 0;
  private inputTranscript = "";
  private outputTranscript = "";
  private utteranceTimer: NodeJS.Timeout | null = null;
  private readonly flushWaiters = new Set<FlushWaiter>();
  private closingFlush = false;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: OpenAIRealtimeTranslateRuntime = {},
    private readonly safetyIdentifier?: string,
  ) {
    if (options.channels !== 1) {
      throw new Error("OpenAI realtime translate requires mono audio");
    }
    if (!options.target) {
      throw new Error("OpenAI realtime translate requires a target language");
    }
  }

  async open(): Promise<void> {
    await this.connect(false);
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (
      this.closed
      || this.closingFlush
      || this.terminalFailure
      || audio.byteLength === 0
    ) return;
    const resampled = resamplePcmS16leTo24k(audio, this.options.sampleRate);
    if (resampled.byteLength === 0) return;
    const frame: AudioFrame = {
      id: this.frameId,
      audio: resampled,
      timestampMs,
    };
    this.frameId += 1;
    this.lastTimestampMs = timestampMs;
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
    // OpenAI transcript deltas do not include an input-audio offset. The only
    // timestamp we have is the last frame pushed by the desktop, which may
    // already belong to a newer utterance. Keep the bounded replay tail rather
    // than incorrectly discarding unfinalized audio after a provider final.
    void timestampMs;
  }

  async flush(): Promise<void> {
    if (this.closed || this.sessionClosed) return;
    if (!this.flushPromise) this.flushPromise = this.flushOpenSession();
    return this.flushPromise;
  }

  private async flushOpenSession(): Promise<void> {
    this.closingFlush = true;
    const drained = await this.waitForQueueDrain();
    if (!drained) {
      const detail = this.sendFailure?.message ?? `${this.queueBytes} buffered audio bytes`;
      throw new Error(
        `OpenAI realtime translate flush could not send audio: ${detail}`,
      );
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI realtime translate flush could not reach an open connection");
    }

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
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error) => {
      this.finalizeUtterance();
      throw error;
    });
    this.finalizeUtterance();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.terminalFailure && !this.sessionClosed) {
      try {
        await this.flush();
      } catch {
        // Continue teardown if the provider could not flush its final output.
      }
    }
    this.closed = true;
    this.clearUtteranceTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.reconnectTimer = null;
    this.drainTimer = null;
    this.rejectFlushWaiters(new Error("OpenAI realtime translate session closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
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
    }
    this.options.onEvent({ type: "state", state: "closed" });
  }

  private connect(reconnecting: boolean): Promise<void> {
    this.options.onEvent({ type: "state", state: "connecting" });
    if (reconnecting) this.options.onEvent({ type: "state", state: "reconnecting" });
    const endpoint = this.runtime.endpoint
      ?? `${OPENAI_REALTIME_TRANSLATE_WS}?model=${OPENAI_REALTIME_TRANSLATE_MODEL}`;

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Safety-Identifier": this.resolveSafetyIdentifier(),
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
        try {
          socket.send(JSON.stringify({
            type: "session.update",
            session: {
              audio: {
                output: {
                  language: toOpenAITranslateLanguageCode(this.options.target!),
                },
              },
            },
          }));
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
          socket.terminate();
          return;
        }
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
        if (!this.closed && !this.closingFlush) {
          this.options.onEvent({
            type: "warning",
            message: `OpenAI realtime translate socket error: ${error.message}`,
          });
          socket.terminate();
        }
      });
      socket.once("close", () => {
        if (this.socket === socket) this.socket = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("OpenAI realtime translate closed before ready"));
          return;
        }
        if (this.closingFlush) {
          this.rejectFlushWaiters(
            new Error("OpenAI realtime translate closed before session.closed"),
          );
        } else if (!this.closed && !this.terminalFailure) {
          this.queueReplayTail();
          this.scheduleReconnect("OpenAI realtime translate disconnected");
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
        this.sessionClosed = this.closingFlush;
        if (this.closingFlush) this.resolveFlushWaiters();
        this.finalizeUtterance();
        if (!this.closingFlush) this.socket?.terminate();
        return;
      }
      case "error": {
        if (event.retryable) {
          this.options.onEvent({
            type: "warning",
            message: `OpenAI realtime translate will reconnect: ${event.message}`,
          });
          this.socket?.terminate();
        } else {
          this.fail(event.message);
        }
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
    // Target deltas may arrive before source deltas. The gateway understands an
    // empty source as a translated-only caption, so do not turn target text
    // into source text or delay the progressive caption.
    if (!translatedText) return;
    this.options.onEvent({
      type: "transcript",
      text: sourceText,
      translatedText,
      timestampMs: this.lastTimestampMs,
      isFinal: false,
    });
  }

  private scheduleUtteranceFinalization(): void {
    this.clearUtteranceTimer();
    this.utteranceTimer = setTimeout(() => {
      this.utteranceTimer = null;
      this.finalizeUtterance();
    }, this.runtime.utteranceGapMs ?? UTTERANCE_GAP_MS);
  }

  private finalizeUtterance(): void {
    this.clearUtteranceTimer();
    const sourceText = this.inputTranscript.trim();
    const translatedText = this.outputTranscript.trim();
    if (!translatedText) return;

    this.options.onEvent({
      type: "transcript",
      text: sourceText,
      translatedText,
      timestampMs: this.lastTimestampMs,
      isFinal: true,
    });
    this.inputTranscript = "";
    this.outputTranscript = "";
  }

  private enqueueFrame(frame: AudioFrame, atFront = false): void {
    if (this.queuedFrames.some((queued) => queued.id === frame.id)) return;
    if (atFront) this.queuedFrames.unshift(frame);
    else this.queuedFrames.push(frame);
    this.queueBytes += frame.audio.byteLength;
    let droppedBytes = 0;
    while (this.queueBytes > MAX_QUEUE_BYTES && this.queuedFrames.length > 1) {
      const removed = this.queuedFrames.shift();
      if (removed) {
        this.queueBytes -= removed.audio.byteLength;
        droppedBytes += removed.audio.byteLength;
      }
    }
    if (droppedBytes > 0) {
      this.options.onEvent({
        type: "warning",
        message: "OpenAI translation buffer filled; oldest audio was dropped",
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
    this.clearUtteranceTimer();
    this.inputTranscript = "";
    this.outputTranscript = "";
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
    if (this.drainTimer || this.closed || this.closingFlush) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainQueue();
    }, DRAIN_INTERVAL_MS);
  }

  private async waitForQueueDrain(): Promise<boolean> {
    const startedAt = Date.now();
    const timeoutMs = this.runtime.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    while (Date.now() - startedAt < timeoutMs) {
      this.drainQueue();
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (
        !this.sendFailure
        && this.queuedFrames.length === 0
        && this.pendingSends === 0
        && socket.bufferedAmount === 0
      ) return true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_INTERVAL_MS);
      });
    }
    return false;
  }

  private sendFrame(frame: AudioFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.enqueueFrame(frame);
      this.scheduleDrain();
      return;
    }
    try {
      this.pendingSends += 1;
      socket.send(JSON.stringify({
        type: "session.input_audio_buffer.append",
        audio: frame.audio.toString("base64"),
      }), (error) => {
        this.pendingSends -= 1;
        if (!error || this.closed) return;
        if (this.closingFlush) this.sendFailure = error;
        this.enqueueFrame(frame, true);
        socket.terminate();
      });
    } catch (error) {
      this.pendingSends -= 1;
      if (this.closingFlush) {
        this.sendFailure = error instanceof Error
          ? error
          : new Error("OpenAI realtime translate audio send failed");
      }
      this.enqueueFrame(frame, true);
      socket.terminate();
    }
  }

  private resolveSafetyIdentifier(): string {
    const configured = this.safetyIdentifier?.trim();
    if (configured) return configured;
    return createHash("sha256").update(this.options.sessionId).digest("hex");
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

  private scheduleReconnect(message: string): void {
    if (this.closed || this.terminalFailure || this.closingFlush || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    if (
      this.reconnectAttempts
      > (this.runtime.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)
    ) {
      this.fail(`${message}; reconnect limit reached`);
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

  private fail(message: string): void {
    if (this.terminalFailure || this.closed) return;
    this.terminalFailure = true;
    this.rejectFlushWaiters(new Error(message));
    this.options.onEvent({ type: "error", message, retryable: false });
  }
}
