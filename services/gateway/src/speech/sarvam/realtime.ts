import { WebSocket, type RawData } from "ws";
import {
  pcmS16leDurationMs,
  type OpenProviderSessionOptions,
  type ProviderStreamEvent,
  type ProviderStreamSession,
} from "../contract.js";
import {
  SARVAM_REALTIME_STT_WS,
  toSarvamRealtimeLanguageCode,
} from "./languages.js";
import { isRecord } from "../../util.js";

const CONNECT_TIMEOUT_MS = 8_000;
const END_TIMEOUT_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const MAX_RECONNECT_DELAY_MS = 4_000;
const MAX_QUEUE_BYTES = 192_000; // Six seconds of mono PCM S16LE at 16 kHz.
const REPLAY_TAIL_BYTES = 16_000; // Replay the most recent 500 ms after reconnecting.
const MAX_SOCKET_BUFFER_BYTES = 256_000;
const PING_INTERVAL_MS = 20_000;

/** Test-only overrides for endpoint and timing. */
export interface SarvamRealtimeRuntime {
  endpoint?: string;
  connectTimeoutMs?: number;
  endTimeoutMs?: number;
  drainTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  pingIntervalMs?: number;
}

interface AudioFrame {
  id: number;
  audio: Buffer;
  timestampMs: number;
}

interface EndWaiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Sarvam's current `saaras:v3-realtime` WebSocket transport. It intentionally
 * stays transcription-only: Realtime partials are always source text, and the
 * gateway's existing Sarvam text translator produces progressive target text.
 */
export class SarvamRealtimeSession implements ProviderStreamSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly queuedFrames: AudioFrame[] = [];
  private queueBytes = 0;
  private readonly replayTail: AudioFrame[] = [];
  private replayTailBytes = 0;
  private frameId = 0;
  private reconnectAttempts = 0;
  private replayQueuedForOutage = false;
  private closed = false;
  private terminal = false;
  private ending = false;
  private lastSentAudioStartMs = 0;
  private lastSentAudioEndMs = 0;
  private lastVadTimestampMs: number | null = null;
  private speechActive = false;
  private currentTurnId: string | null = null;
  private currentTurnFinalSeen = false;
  private readonly pendingFinalTurns: Array<{ turnId: string; timestampMs: number }> = [];
  private readonly queuedTurnEvents: ProviderStreamEvent[] = [];
  private turnEnded = false;
  private turnSequence = 0;
  private committedThroughTimestampMs = -1;
  private finalTranscriptCount = 0;
  private endFinalBarrierCount = 0;
  private readonly endWaiters = new Set<EndWaiter>();

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: SarvamRealtimeRuntime = {},
  ) {
    if (options.channels !== 1) {
      throw new Error("Sarvam Realtime requires mono audio");
    }
    if (options.sampleRate !== 16_000) {
      throw new Error(`Sarvam Realtime does not support ${options.sampleRate} Hz audio`);
    }
  }

  async open(): Promise<void> {
    await this.connect();
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.terminal || this.ending || audio.byteLength === 0) return;

    const frame: AudioFrame = {
      id: this.frameId,
      audio: Buffer.from(audio),
      timestampMs,
    };
    this.frameId += 1;
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
        `Sarvam Realtime end could not send ${this.queueBytes} buffered audio bytes`,
      );
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Sarvam Realtime end could not reach an open provider connection");
    }
    if (this.ending) return this.waitForEnd();

    this.ending = true;
    this.endFinalBarrierCount = this.finalTranscriptCount;
    await new Promise<void>((resolve, reject) => {
      const waiter: EndWaiter = {
        timeout: setTimeout(() => {
          this.endWaiters.delete(waiter);
          reject(new Error("Sarvam Realtime end timed out waiting for completion"));
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
      try {
        socket.send(JSON.stringify({ event: "end" }));
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.rejectEndWaiters(new Error("Sarvam Realtime stream closed during end"));

    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
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
  }

  private connect(): Promise<void> {
    if (this.closed || this.terminal || this.ending) return Promise.resolve();

    const url = new URL(this.runtime.endpoint ?? SARVAM_REALTIME_STT_WS);
    url.searchParams.set("model", "saaras:v3-realtime");
    url.searchParams.set("language_code", toSarvamRealtimeLanguageCode(this.options.source));
    url.searchParams.set("stream_type", "balanced");
    // Partials are source-language text in Realtime. Keep finals source text too
    // so the existing progressive text translator handles every target uniformly.
    url.searchParams.set("mode", "transcribe");
    url.searchParams.set("endpointing", "vad");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(this.options.sampleRate));
    url.searchParams.set("threshold", "0.3");
    url.searchParams.set("silence_duration_ms", "500");
    url.searchParams.set("min_speech_duration_ms", "250");

    const socket = new WebSocket(url, {
      headers: { "Api-Subscription-Key": this.apiKey },
    });
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const timeout = setTimeout(() => {
        failBeforeOpen(new Error("Sarvam Realtime connection timed out"));
        socket.terminate();
      }, this.runtime.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      const failBeforeOpen = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      socket.once("open", () => {
        if (this.closed || this.terminal || this.ending || this.socket !== socket) {
          socket.close();
          failBeforeOpen(new Error("Sarvam Realtime session was superseded"));
          return;
        }
        opened = true;
        settled = true;
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.replayQueuedForOutage = false;
        this.startPing();
        this.drainQueue();
        resolve();
      });

      socket.on("message", (raw) => this.handleMessage(raw));

      socket.once("unexpected-response", (_request, response) => {
        failBeforeOpen(new Error(
          `Sarvam Realtime WebSocket rejected the connection (HTTP ${response.statusCode})`,
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
          message: `Sarvam Realtime stream error: ${error.message}`,
        });
      });

      socket.once("close", (code, reason) => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        this.stopPing();
        if (this.closed || this.terminal) return;
        if (this.ending) {
          this.resolveEndWaiters();
          return;
        }

        const detail = reason.length > 0 ? reason.toString() : `code ${code}`;
        if (!opened) {
          failBeforeOpen(new Error(`Sarvam Realtime closed before opening (${detail})`));
          return;
        }
        if (isTerminalCloseCode(code)) {
          this.failTerminal(`Sarvam Realtime disconnected (${detail})`);
          return;
        }
        this.scheduleReconnect(`Sarvam Realtime disconnected (${detail})`);
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
        message: "Sarvam Realtime returned a non-JSON streaming message",
      });
      return;
    }
    if (!isRecord(payload) || typeof payload.event !== "string") return;

    const event = payload.event;
    if (event === "error") {
      const message = readMessage(payload, "Sarvam Realtime failed");
      if (payload.is_fatal === true) {
        this.failTerminal(message);
      } else {
        this.options.onEvent({ type: "error", message, retryable: true });
      }
      return;
    }

    if (event === "vad.speech_start") {
      const turnId = this.startSpeechTurn();
      this.speechActive = true;
      this.lastVadTimestampMs = this.lastSentAudioStartMs;
      this.emitTurnEvent({
        type: "speech_start",
        timestampMs: this.lastSentAudioStartMs,
        turnId,
      });
      return;
    }

    if (event === "vad.speech_end") {
      const turnId = this.ensureTurn();
      const timestampMs = this.lastSentAudioEndMs;
      this.speechActive = false;
      this.turnEnded = true;
      if (
        !this.currentTurnFinalSeen
        && !this.pendingFinalTurns.some((turn) => turn.turnId === turnId)
      ) {
        this.pendingFinalTurns.push({ turnId, timestampMs });
      }
      this.lastVadTimestampMs = timestampMs;
      this.emitTurnEvent({ type: "speech_end", timestampMs, turnId });
      return;
    }

    if (event === "transcript.partial" || event === "transcript.final") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return;
      const languageCode = typeof payload.language === "string"
        ? payload.language
        : undefined;
      const isFinal = event === "transcript.final";
      const pendingTurn = isFinal ? this.pendingFinalTurns[0] : undefined;
      const turnId = pendingTurn?.turnId ?? this.ensureTurn();
      const timestampMs = pendingTurn
        ? pendingTurn.timestampMs
        : this.speechActive
          ? this.lastSentAudioEndMs
          : this.lastVadTimestampMs ?? this.lastSentAudioEndMs;
      if (isFinal) {
        if (turnId === this.currentTurnId) this.currentTurnFinalSeen = true;
        this.finalTranscriptCount += 1;
      }
      const transcriptEvent: ProviderStreamEvent = {
        type: "transcript",
        text,
        timestampMs,
        turnId,
        ...(languageCode ? { languageCode } : {}),
        isFinal,
      };
      if (pendingTurn) {
        this.options.onEvent(transcriptEvent);
        this.pendingFinalTurns.shift();
        this.flushQueuedTurnEvents();
      } else {
        this.emitTurnEvent(transcriptEvent);
      }
      if (
        isFinal
        && this.ending
        && this.finalTranscriptCount > this.endFinalBarrierCount
        && this.pendingFinalTurns.length === 0
        && this.currentTurnFinalSeen
      ) {
        this.resolveEndWaiters();
      }
      return;
    }

    if (event === "session.end") {
      if (this.ending) {
        this.pendingFinalTurns.splice(0);
        this.flushQueuedTurnEvents();
        this.resolveEndWaiters();
      } else {
        this.failTerminal("Sarvam Realtime ended the session unexpectedly");
      }
    }
  }

  private startSpeechTurn(): string {
    if (!this.currentTurnId || this.turnEnded) {
      this.currentTurnId = `${this.options.sessionId}:${this.turnSequence}`;
      this.turnSequence += 1;
      this.currentTurnFinalSeen = false;
      this.turnEnded = false;
    }
    return this.currentTurnId;
  }

  private ensureTurn(): string {
    if (!this.currentTurnId) return this.startSpeechTurn();
    return this.currentTurnId;
  }

  private emitTurnEvent(event: ProviderStreamEvent): void {
    const pendingTurnId = this.pendingFinalTurns[0]?.turnId;
    if (
      pendingTurnId
      && "turnId" in event
      && event.turnId
      && event.turnId !== pendingTurnId
    ) {
      this.queuedTurnEvents.push(event);
      return;
    }
    this.options.onEvent(event);
  }

  private flushQueuedTurnEvents(): void {
    const pendingTurnId = this.pendingFinalTurns[0]?.turnId;
    while (this.queuedTurnEvents.length > 0) {
      const event = this.queuedTurnEvents[0];
      if (
        pendingTurnId
        && event
        && "turnId" in event
        && event.turnId
        && event.turnId !== pendingTurnId
      ) break;
      this.queuedTurnEvents.shift();
      if (!event) continue;
      this.options.onEvent(event);
    }
  }

  private sendFrame(frame: AudioFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.enqueueFrame(frame, true);
      return;
    }

    this.lastSentAudioStartMs = frame.timestampMs;
    this.lastSentAudioEndMs = Math.max(
      this.lastSentAudioEndMs,
      frame.timestampMs + pcmS16leDurationMs(
        frame.audio.byteLength,
        this.options.sampleRate,
        this.options.channels,
      ),
    );
    try {
      socket.send(JSON.stringify({
        event: "audio_input",
        audio: frame.audio.toString("base64"),
      }), (error) => {
        if (!error || this.closed || this.terminal) return;
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
        message: "Sarvam Realtime reconnect buffer filled; oldest audio was dropped",
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
    if (!socket || socket.readyState !== WebSocket.OPEN || this.closed || this.terminal) return;

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
    if (this.drainTimer || this.closed || this.terminal) return;
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
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    return this.queuedFrames.length === 0;
  }

  private waitForEnd(): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: EndWaiter = {
        timeout: setTimeout(() => {
          this.endWaiters.delete(waiter);
          reject(new Error("Sarvam Realtime end timed out waiting for completion"));
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

  private scheduleReconnect(message: string): void {
    if (this.closed || this.terminal || this.ending || this.reconnectTimer) return;
    this.queueReplayTail();
    this.reconnectAttempts += 1;
    if (
      this.reconnectAttempts
      > (this.runtime.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)
    ) {
      this.failTerminal(`${message}; reconnect limit reached`);
      return;
    }

    this.options.onEvent({ type: "warning", message });
    const delayMs = Math.min(
      (this.runtime.reconnectBaseDelayMs ?? 250)
        * (2 ** (this.reconnectAttempts - 1)),
      this.runtime.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.scheduleReconnect(detail);
      });
    }, delayMs);
  }

  private failTerminal(message: string): void {
    if (this.closed || this.terminal) return;
    this.terminal = true;
    this.clearTimers();
    this.rejectEndWaiters(new Error(message));
    this.options.onEvent({ type: "error", message, retryable: false });
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private resolveEndWaiters(): void {
    for (const waiter of [...this.endWaiters]) waiter.resolve();
    this.endWaiters.clear();
  }

  private rejectEndWaiters(error: Error): void {
    for (const waiter of [...this.endWaiters]) waiter.reject(error);
    this.endWaiters.clear();
  }

  private startPing(): void {
    this.stopPing();
    const intervalMs = this.runtime.pingIntervalMs ?? PING_INTERVAL_MS;
    if (intervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || this.closed || this.ending) return;
      try {
        socket.send(JSON.stringify({ event: "ping" }));
      } catch {
        socket.terminate();
      }
    }, intervalMs);
  }

  private stopPing(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.stopPing();
    this.reconnectTimer = null;
    this.drainTimer = null;
  }
}

function readMessage(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  if (typeof payload.code === "string" && payload.code.trim()) {
    return `Sarvam Realtime error: ${payload.code}`;
  }
  return fallback;
}

function isTerminalCloseCode(code: number): boolean {
  // Sarvam documents 1003 (key/quota/rate limit) and 4000 (invalid Realtime
  // configuration/account) as terminal. A normal close without our explicit
  // `end` is also terminal; 1008/1011 and network-style closes retry first.
  return code === 1_000 || code === 1_003 || code === 4_000;
}
