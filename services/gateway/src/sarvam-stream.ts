import { WebSocket, type RawData } from "ws";
import type {
  OpenProviderSessionOptions,
  ProviderStreamSession,
} from "./providers.js";
import {
  SARVAM_STT_WS,
  hasSpeechEnergy,
  sarvamStreamMode,
  toSarvamLanguageCode,
} from "./sarvam.js";
import { isRecord } from "./util.js";

const CONNECT_TIMEOUT_MS = 8_000;
const FLUSH_TIMEOUT_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const MAX_RECONNECT_DELAY_MS = 4_000;
const MAX_QUEUE_BYTES = 192_000; // Six seconds of mono PCM S16LE at 16 kHz.
const REPLAY_TAIL_BYTES = 16_000; // Replay the most recent 500 ms after reconnecting.
const MAX_SOCKET_BUFFER_BYTES = 256_000;
const DEFAULT_SOFT_FLUSH_MS = 700;

/** Test-only overrides for timeouts and endpoint. */
type SarvamStreamingRuntime = {
  endpoint?: string;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
  drainTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  /** Periodic mid-speech flush interval; 0 disables. */
  softFlushMs?: number;
};

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

export class SarvamStreamingSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private softFlushTimer: NodeJS.Timeout | null = null;
  private readonly queuedFrames: AudioFrame[] = [];
  private queueBytes = 0;
  private readonly replayTail: AudioFrame[] = [];
  private replayTailBytes = 0;
  private frameId = 0;
  private reconnectAttempts = 0;
  private replayQueuedForOutage = false;
  private closed = false;
  private lastPushedTimestampMs = 0;
  private lastSentTimestampMs = 0;
  private lastVadTimestampMs: number | null = null;
  private recentSpeechTimestampMs: number | null = null;
  private speechActive = false;
  private committedThroughTimestampMs = -1;
  private transcriptCount = 0;
  private flushBarrierCount = 0;
  private flushPending = false;
  private flushSawPostBarrierTranscript = false;
  private readonly flushWaiters = new Set<FlushWaiter>();
  private readonly streamMode;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: SarvamStreamingRuntime = {},
  ) {
    this.streamMode = sarvamStreamMode(options.target);
    if (options.channels !== 1) {
      throw new Error("Sarvam streaming requires mono audio");
    }
    if (options.sampleRate !== 8_000 && options.sampleRate !== 16_000) {
      throw new Error(`Sarvam streaming does not support ${options.sampleRate} Hz audio`);
    }
  }

  async open(): Promise<void> {
    await this.connect(false);
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || audio.byteLength === 0) return;

    const frame: AudioFrame = {
      id: this.frameId,
      audio: Buffer.from(audio),
      timestampMs,
    };
    this.frameId += 1;
    this.lastPushedTimestampMs = timestampMs;
    if (hasSpeechEnergy(audio)) this.recentSpeechTimestampMs = timestampMs;
    this.rememberReplayTail(frame);

    if (this.socket?.readyState === WebSocket.OPEN
      && this.socket.bufferedAmount < MAX_SOCKET_BUFFER_BYTES
      && this.queuedFrames.length === 0) {
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
    while (
      this.replayTail.length > 0
      && (this.replayTail[0]?.timestampMs ?? Number.POSITIVE_INFINITY)
        <= this.committedThroughTimestampMs
    ) {
      const removed = this.replayTail.shift();
      if (removed) this.replayTailBytes -= removed.audio.byteLength;
    }
    for (let index = this.queuedFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.queuedFrames[index];
      if (frame && frame.timestampMs <= this.committedThroughTimestampMs) {
        this.queuedFrames.splice(index, 1);
        this.queueBytes -= frame.audio.byteLength;
      }
    }
  }

  async flush(): Promise<void> {
    if (this.closed) return;

    const drained = await this.waitForQueueDrain();
    if (!drained) {
      throw new Error(
        `Sarvam flush could not send ${this.queueBytes} buffered audio bytes`,
      );
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Sarvam flush could not reach an open provider connection");
    }

    // Let any already-queued provider messages settle before snapshotting the
    // transcript barrier so in-flight revisions cannot complete this flush.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const recentSpeech = this.recentSpeechTimestampMs !== null
      && this.lastPushedTimestampMs - this.recentSpeechTimestampMs <= 2_000;
    const requiresProviderCompletion = this.speechActive || recentSpeech;
    this.flushBarrierCount = this.transcriptCount;
    this.flushPending = requiresProviderCompletion;
    this.flushSawPostBarrierTranscript = false;

    await new Promise<void>((resolve, reject) => {
      const waiter: FlushWaiter = {
        timeout: setTimeout(() => {
          this.flushWaiters.delete(waiter);
          this.flushPending = false;
          if (requiresProviderCompletion) {
            reject(new Error("Sarvam flush timed out waiting for final speech"));
          } else {
            resolve();
          }
        }, this.runtime.flushTimeoutMs ?? FLUSH_TIMEOUT_MS),
        resolve: () => {
          clearTimeout(waiter.timeout);
          this.flushWaiters.delete(waiter);
          this.flushPending = false;
          resolve();
        },
        reject: (error) => {
          clearTimeout(waiter.timeout);
          this.flushWaiters.delete(waiter);
          this.flushPending = false;
          reject(error);
        },
      };
      this.flushWaiters.add(waiter);
      try {
        socket.send(JSON.stringify({ type: "flush" }));
        if (!requiresProviderCompletion) {
          waiter.resolve();
        }
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.rejectFlushWaiters(new Error("Sarvam stream closed during flush"));

    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.options.onEvent({ type: "state", state: "closed" });
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      timeout = setTimeout(() => {
        socket.removeAllListeners();
        try {
          socket.terminate();
        } finally {
          finish();
        }
      }, 500);
      socket.once("close", finish);
      try {
        socket.close(1000, "Doot caption session closed");
      } catch {
        socket.removeAllListeners();
        try {
          socket.terminate();
        } finally {
          finish();
        }
      }
    });
    this.options.onEvent({ type: "state", state: "closed" });
  }

  private connect(reconnecting: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.options.onEvent({
      type: "state",
      state: reconnecting ? "reconnecting" : "connecting",
    });

    const url = new URL(this.runtime.endpoint ?? SARVAM_STT_WS);
    url.searchParams.set("model", "saaras:v3");
    url.searchParams.set("mode", this.streamMode);
    url.searchParams.set("language-code", toSarvamLanguageCode(this.options.source));
    url.searchParams.set("sample_rate", String(this.options.sampleRate));
    url.searchParams.set("input_audio_codec", "pcm_s16le");
    url.searchParams.set("vad_signals", "true");
    url.searchParams.set("flush_signal", "true");
    // The high-sensitivity preset provides a compatible two-frame end-of-speech
    // window. Do not override just the required-silence count: it can otherwise
    // exceed that window and make END_SPEECH unreachable.
    url.searchParams.set("high_vad_sensitivity", "true");

    const socket = new WebSocket(url, {
      headers: { "Api-Subscription-Key": this.apiKey },
    });
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const timeout = setTimeout(() => {
        failBeforeOpen(new Error("Sarvam streaming connection timed out"));
        socket.terminate();
      }, this.runtime.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      const failBeforeOpen = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      socket.once("open", () => {
        if (this.closed || this.socket !== socket) {
          socket.close();
          failBeforeOpen(new Error("Sarvam streaming session was superseded"));
          return;
        }
        opened = true;
        settled = true;
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.replayQueuedForOutage = false;
        this.options.onEvent({ type: "state", state: "open" });
        this.drainQueue();
        resolve();
      });

      socket.on("message", (raw) => this.handleMessage(raw));

      socket.once("unexpected-response", (_request, response) => {
        failBeforeOpen(new Error(
          `Sarvam WebSocket rejected the connection (HTTP ${response.statusCode})`,
        ));
        socket.terminate();
      });

      socket.once("error", (error) => {
        if (!opened) {
          failBeforeOpen(error);
          return;
        }
        this.options.onEvent({
          type: "warning",
          message: `Sarvam stream error: ${error.message}`,
        });
      });

      socket.once("close", (code, reason) => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        this.rejectFlushWaiters(new Error("Sarvam stream disconnected during flush"));
        if (this.closed) return;

        const detail = reason.length > 0 ? reason.toString() : `code ${code}`;
        if (!opened) {
          failBeforeOpen(new Error(`Sarvam stream closed before opening (${detail})`));
          return;
        }
        this.scheduleReconnect(`Sarvam stream disconnected (${detail})`);
      });
    });
  }

  private handleMessage(raw: RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      this.options.onEvent({
        type: "warning",
        message: "Sarvam returned a non-JSON streaming message",
      });
      return;
    }
    if (!isRecord(payload) || typeof payload.type !== "string") return;

    const data = isRecord(payload.data) ? payload.data : {};
    if (payload.type === "error") {
      const message = typeof data.error === "string"
        ? data.error
        : typeof payload.message === "string"
          ? payload.message
          : "Sarvam streaming failed";
      this.options.onEvent({ type: "error", message, retryable: true });
      this.rejectFlushWaiters(new Error(message));
      return;
    }

    if (payload.type === "events" || payload.type === "event") {
      const signal = typeof data.signal_type === "string"
        ? data.signal_type
        : typeof data.type === "string"
          ? data.type
          : "";
      const timestampMs = this.lastSentTimestampMs;
      this.lastVadTimestampMs = timestampMs;
      if (signal === "START_SPEECH") {
        this.speechActive = true;
        this.startSoftFlush();
        this.options.onEvent({
          type: "speech_start",
          timestampMs,
        });
      } else if (signal === "END_SPEECH") {
        this.speechActive = false;
        this.stopSoftFlush();
        this.options.onEvent({
          type: "speech_end",
          timestampMs,
        });
        this.maybeResolveFlushWaiters("end_speech");
      }
      return;
    }

    if (payload.type !== "data" || typeof data.transcript !== "string") return;
    const transcript = data.transcript.trim();
    if (!transcript) return;

    const languageCode = typeof data.language_code === "string"
      ? data.language_code
      : typeof data.language === "string"
        ? data.language
        : undefined;
    const timestampMs = this.lastVadTimestampMs ?? this.lastSentTimestampMs;
    this.transcriptCount += 1;
    if (this.flushPending && this.transcriptCount > this.flushBarrierCount) {
      this.flushSawPostBarrierTranscript = true;
    }
    this.options.onEvent({
      type: "transcript",
      text: transcript,
      timestampMs,
      ...(languageCode ? { languageCode } : {}),
      ...(this.streamMode === "translate" ? { translated: true } : {}),
    });
    this.recentSpeechTimestampMs = null;
    this.lastVadTimestampMs = null;
    this.maybeResolveFlushWaiters("transcript");
  }

  private softFlushIntervalMs(): number {
    return this.runtime.softFlushMs ?? DEFAULT_SOFT_FLUSH_MS;
  }

  private startSoftFlush(): void {
    const intervalMs = this.softFlushIntervalMs();
    if (intervalMs <= 0 || this.softFlushTimer) return;
    this.softFlushTimer = setInterval(() => {
      this.sendSoftFlush();
    }, intervalMs);
  }

  private stopSoftFlush(): void {
    if (!this.softFlushTimer) return;
    clearInterval(this.softFlushTimer);
    this.softFlushTimer = null;
  }

  /** Force Sarvam to emit a partial transcript without waiting for silence. */
  private sendSoftFlush(): void {
    if (this.closed || !this.speechActive || this.flushPending) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "flush" }));
    } catch {
      // Soft flush is best-effort; hard flush / reconnect handle real failures.
    }
  }

  private maybeResolveFlushWaiters(reason: "transcript" | "end_speech"): void {
    if (!this.flushPending) return;
    if (!this.flushSawPostBarrierTranscript) return;
    // A mid-utterance revision must not complete flush while speech is still active.
    if (reason === "transcript" && this.speechActive) return;
    this.resolveFlushWaiters();
  }

  private sendFrame(frame: AudioFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.enqueueFrame(frame, true);
      return;
    }

    this.lastSentTimestampMs = frame.timestampMs;
    try {
      socket.send(JSON.stringify({
        audio: {
          data: frame.audio.toString("base64"),
          sample_rate: String(this.options.sampleRate),
          encoding: "audio/wav",
        },
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

  private rememberReplayTail(frame: AudioFrame): void {
    this.replayTail.push(frame);
    this.replayTailBytes += frame.audio.byteLength;
    while (this.replayTailBytes > REPLAY_TAIL_BYTES && this.replayTail.length > 1) {
      const removed = this.replayTail.shift();
      if (removed) this.replayTailBytes -= removed.audio.byteLength;
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
        message: "Sarvam reconnect buffer filled; oldest audio was dropped",
      });
    }
  }

  private queueReplayTail(): void {
    if (this.replayQueuedForOutage) return;
    this.replayQueuedForOutage = true;
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
    if (!socket || socket.readyState !== WebSocket.OPEN || this.closed) return;

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
      && Date.now() - startedAt < (this.runtime.drainTimeoutMs ?? 8_000)
    ) {
      this.drainQueue();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return this.queuedFrames.length === 0;
  }

  private scheduleReconnect(message: string): void {
    if (this.closed || this.reconnectTimer) return;
    this.queueReplayTail();
    this.reconnectAttempts += 1;
    if (
      this.reconnectAttempts
      > (this.runtime.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)
    ) {
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

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.stopSoftFlush();
    this.reconnectTimer = null;
    this.drainTimer = null;
  }
}
