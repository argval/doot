import type {
  OpenProviderSessionOptions,
  ProviderStreamEvent,
  ProviderStreamSession,
} from "../contract.js";
import {
  SarvamRealtimeSession,
  type SarvamRealtimeRuntime,
} from "./realtime.js";
import {
  SarvamStreamingSession,
  type SarvamStreamingRuntime,
} from "./legacy.js";

const REPLAY_TAIL_BYTES = 16_000;
const MAX_HANDOFF_QUEUE_BYTES = 192_000;

export interface SarvamFailoverRuntime {
  realtime?: SarvamRealtimeRuntime;
  legacy?: SarvamStreamingRuntime;
}

interface AudioFrame {
  audio: Buffer;
  timestampMs: number;
}

/**
 * Uses Saaras Realtime by default and switches to the legacy stream only when
 * Realtime is unavailable or exhausts its own reconnect policy. Keeping this
 * wrapper at the provider boundary means desktop clients stay protocol-stable.
 */
export class SarvamFailoverSession implements ProviderStreamSession {
  private active: ProviderStreamSession | null = null;
  private transport: "realtime" | "legacy" | null = null;
  private switching: Promise<void> | null = null;
  private closed = false;
  private committedThroughTimestampMs = -1;
  private readonly replayTail: AudioFrame[] = [];
  private replayTailBytes = 0;
  private readonly handoffQueue: AudioFrame[] = [];
  private handoffQueueBytes = 0;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenProviderSessionOptions,
    private readonly runtime: SarvamFailoverRuntime = {},
  ) {}

  async open(): Promise<void> {
    try {
      await this.openRealtime();
    } catch (error) {
      if (this.closed) throw error;
      await this.openLegacy(
        `Sarvam Realtime could not open (${messageFor(error)}); using legacy streaming`,
      );
    }
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || audio.byteLength === 0) return;
    const frame: AudioFrame = { audio: Buffer.from(audio), timestampMs };
    this.rememberReplayTail(frame);
    if (this.switching) {
      this.enqueueHandoffFrame(frame);
      return;
    }
    this.active?.pushAudio(frame.audio, timestampMs);
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
    while (
      this.handoffQueue.length > 0
      && (this.handoffQueue[0]?.timestampMs ?? Number.POSITIVE_INFINITY)
        <= this.committedThroughTimestampMs
    ) {
      const removed = this.handoffQueue.shift();
      if (removed) this.handoffQueueBytes -= removed.audio.byteLength;
    }
    this.active?.commitAudioThrough(timestampMs);
  }

  async flush(): Promise<void> {
    await this.waitForSwitch();
    if (!this.active) throw new Error("Sarvam has no active streaming transport");
    await this.active.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.waitForSwitch();
    const active = this.active;
    this.active = null;
    this.transport = null;
    await active?.close();
  }

  private async openRealtime(): Promise<void> {
    const session = new SarvamRealtimeSession(
      this.apiKey,
      {
        ...this.options,
        onEvent: (event) => this.handleRealtimeEvent(event),
      },
      this.runtime.realtime,
    );
    this.active = session;
    this.transport = "realtime";
    try {
      await session.open();
    } catch (error) {
      if (this.active === session) {
        this.active = null;
        this.transport = null;
      }
      await session.close();
      throw error;
    }
  }

  private async openLegacy(warning: string): Promise<void> {
    this.options.onEvent({ type: "warning", message: warning });
    const session = new SarvamStreamingSession(
      this.apiKey,
      {
        ...this.options,
        onEvent: (event) => this.options.onEvent(event),
      },
      this.runtime.legacy,
    );
    this.active = session;
    this.transport = "legacy";
    try {
      await session.open();
      if (this.closed) {
        await session.close();
        return;
      }
      for (const frame of this.takeHandoffFrames()) {
        if (frame.timestampMs > this.committedThroughTimestampMs) {
          session.pushAudio(frame.audio, frame.timestampMs);
        }
      }
    } catch (error) {
      if (this.active === session) {
        this.active = null;
        this.transport = null;
      }
      await session.close();
      throw error;
    }
  }

  private handleRealtimeEvent(event: ProviderStreamEvent): void {
    if (
      event.type === "error"
      && !event.retryable
      && this.transport === "realtime"
      && !this.closed
    ) {
      void this.switchToLegacy(event.message);
      return;
    }
    this.options.onEvent(event);
  }

  private switchToLegacy(reason: string): Promise<void> {
    if (this.switching) return this.switching;
    const realtime = this.active;
    this.active = null;
    this.transport = null;
    this.seedHandoffQueue();
    this.switching = (async () => {
      try {
        await realtime?.close();
        if (this.closed) return;
        await this.openLegacy(
          `Sarvam Realtime failed (${reason}); switched to legacy streaming`,
        );
      } catch (error) {
        if (!this.closed) {
          this.options.onEvent({
            type: "error",
            message: `Sarvam legacy fallback failed: ${messageFor(error)}`,
            retryable: false,
          });
        }
      } finally {
        this.switching = null;
      }
    })();
    return this.switching;
  }

  private rememberReplayTail(frame: AudioFrame): void {
    this.replayTail.push(frame);
    this.replayTailBytes += frame.audio.byteLength;
    while (this.replayTailBytes > REPLAY_TAIL_BYTES && this.replayTail.length > 1) {
      const removed = this.replayTail.shift();
      if (removed) this.replayTailBytes -= removed.audio.byteLength;
    }
  }

  private seedHandoffQueue(): void {
    for (const frame of this.replayTail) {
      if (frame.timestampMs > this.committedThroughTimestampMs) {
        this.enqueueHandoffFrame(frame);
      }
    }
  }

  private enqueueHandoffFrame(frame: AudioFrame): void {
    if (frame.timestampMs <= this.committedThroughTimestampMs) return;
    this.handoffQueue.push(frame);
    this.handoffQueueBytes += frame.audio.byteLength;

    let droppedBytes = 0;
    while (
      this.handoffQueueBytes > MAX_HANDOFF_QUEUE_BYTES
      && this.handoffQueue.length > 1
    ) {
      const removed = this.handoffQueue.shift();
      if (!removed) break;
      this.handoffQueueBytes -= removed.audio.byteLength;
      droppedBytes += removed.audio.byteLength;
    }
    if (droppedBytes > 0) {
      this.options.onEvent({
        type: "warning",
        message: "Sarvam fallback buffer filled; oldest audio was dropped",
      });
    }
  }

  private takeHandoffFrames(): AudioFrame[] {
    const frames = this.handoffQueue.splice(0);
    this.handoffQueueBytes = 0;
    return frames;
  }

  private async waitForSwitch(): Promise<void> {
    while (this.switching) await this.switching;
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
