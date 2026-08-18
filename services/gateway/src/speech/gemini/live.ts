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
/**
 * Tighter than Sarvam's 500 ms so Live Translate captions break on brief
 * pauses (commentary breaths) without going as low as Google's 100 ms demo
 * value, which fragments mid-phrase.
 */
const GEMINI_SILENCE_DURATION_MS = 300;
/** Prefer a sentence break once a turn has at least this much audio. */
const GEMINI_SOFT_SPLIT_MIN_MS = 2_500;
/** Force a new caption line even mid-phrase after this much continuous audio. */
const GEMINI_MAX_TURN_MS = 5_500;
const MAX_RECONNECT_ATTEMPTS = 6;
const MAX_RECONNECT_DELAY_MS = 4_000;
const MAX_QUEUED_AUDIO_BYTES = 192_000;
const GO_AWAY_RECONNECT_LEAD_MS = 1_000;

export interface GeminiLiveRuntime {
  endpoint?: string;
  setupTimeoutMs?: number;
  endTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  maxReconnectDelayMs?: number;
  softSplitMinMs?: number;
  maxTurnMs?: number;
}

interface Waiter {
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

interface QueuedAudioFrame {
  audio: Buffer;
  timestampMs: number;
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
  private readonly queuedAudio: QueuedAudioFrame[] = [];
  private queuedAudioBytes = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private goAwayTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private resumptionHandle: string | null = null;
  private sourceText = "";
  private translatedText = "";
  /** Text already finalized via soft splits within the current Gemini activity. */
  private committedSource = "";
  private committedTranslated = "";
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
    return this.connect(true);
  }

  private connect(initial: boolean): Promise<void> {
    if (this.closed || this.ending) {
      return Promise.reject(new Error("Gemini session is closed"));
    }
    // Without a resumable handle Gemini starts a new provider session. Close
    // any abandoned local turn so its cumulative text cannot bleed into it.
    if (!initial && !this.resumptionHandle) this.finalizeTurn();
    const url = new URL(this.runtime.endpoint ?? GEMINI_LIVE_TRANSLATE_WS);
    url.searchParams.set("key", this.apiKey);
    const socket = new WebSocket(url);
    this.socket = socket;
    this.setupComplete = false;

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
      socket.on("message", (raw) => this.handleMessage(socket, raw));
      socket.once("unexpected-response", (_request, response) => {
        waiter.reject(new Error(
          `Gemini Live Translate WebSocket rejected the connection (HTTP ${response.statusCode})`,
        ));
        socket.terminate();
      });
      socket.once("error", (error) => {
        if (!this.setupComplete || this.socket !== socket) {
          waiter.reject(error);
          return;
        }
        this.options.onEvent({
          type: "warning",
          message: `Gemini Live Translate stream error: ${error.message}`,
        });
      });
      socket.once("close", (code, reason) => {
        const current = this.socket === socket;
        const wasReady = current && this.setupComplete;
        if (current) {
          this.socket = null;
          this.setupComplete = false;
          this.clearGoAwayTimer();
          this.queuePendingAudio();
        }
        if (this.closed || !current) return;
        if (this.ending) {
          this.rejectEndWaiters(new Error("Gemini Live Translate disconnected during flush"));
          return;
        }
        const detail = reason.length > 0 ? reason.toString() : `code ${code}`;
        if (!wasReady) {
          waiter.reject(new Error(`Gemini Live Translate closed before setup (${detail})`));
        }
        if (wasReady || !initial) {
          this.scheduleReconnect(`Gemini Live Translate disconnected (${detail})`);
        }
      });
    });
  }

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    if (this.closed || this.ending || audio.byteLength === 0) return;
    if (audio.byteLength % 2 !== 0) {
      this.options.onEvent({
        type: "error",
        message: "Gemini Live Translate received an incomplete PCM16 sample",
        retryable: false,
      });
      return;
    }
    const socket = this.socket;
    if (!this.setupComplete || !socket || socket.readyState !== WebSocket.OPEN) {
      this.enqueueAudio(audio, timestampMs);
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
    this.clearReconnectTimer();
    this.clearGoAwayTimer();
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
      // the runtime rejects that with 1007. Silence is tighter than Sarvam so
      // continuous commentary opens new caption lines on brief breaths.
      socket.send(JSON.stringify({
        setup: {
          model: `models/${GEMINI_LIVE_TRANSLATE_MODEL}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: this.resumptionHandle
            ? { handle: this.resumptionHandle }
            : {},
          contextWindowCompression: { slidingWindow: {} },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
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

  private handleMessage(socket: WebSocket, raw: RawData): void {
    if (this.socket !== socket) return;
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
      this.reconnectAttempts = 0;
      this.setupWaiter?.resolve();
      this.drainQueuedAudio();
      return;
    }
    if (isRecord(payload.sessionResumptionUpdate)) {
      const update = payload.sessionResumptionUpdate;
      this.resumptionHandle = update.resumable === true && typeof update.newHandle === "string"
        ? update.newHandle
        : null;
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
      this.scheduleGoAwayReconnect(socket, parseDurationMs(payload.goAway.timeLeft));
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
    const relative = textAfterCommitted(text, this.committedSource);
    if (!relative) return;
    const merged = mergeStreamingText(this.sourceText, relative);
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
    this.maybeSplitLongTurn();
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

    const relative = textAfterCommitted(filteredIncoming, this.committedTranslated);
    if (!relative) return;
    const merged = mergeStreamingText(this.translatedText, relative);
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
    this.maybeSplitLongTurn();
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

  /**
   * Continuous speech (e.g. match commentary) may never hit the silence VAD.
   * Prefer sentence boundaries after a minimum turn length; otherwise force a
   * split at maxTurnMs so the overlay still gets new lines.
   */
  private maybeSplitLongTurn(): void {
    if (!this.speechStarted || this.turnAudioStartMs === null) return;
    if (!this.translatedText) return;
    const turnMs = this.lastAudioEndMs - this.turnAudioStartMs;
    const softSplitMinMs = this.runtime.softSplitMinMs ?? GEMINI_SOFT_SPLIT_MIN_MS;
    const maxTurnMs = this.runtime.maxTurnMs ?? GEMINI_MAX_TURN_MS;
    if (turnMs < softSplitMinMs) return;

    const sentence = splitCompletedSentence(this.translatedText);
    if (sentence) {
      this.commitSoftSplit(sentence.completed, sentence.remainder);
      return;
    }
    if (turnMs >= maxTurnMs) {
      this.finalizeTurn({ providerComplete: false });
    }
  }

  private commitSoftSplit(completed: string, remainder: string): void {
    this.translatedText = completed;
    this.emitTranslation(true);
    if (this.speechStarted) {
      this.options.onEvent({
        type: "speech_end",
        timestampMs: this.lastAudioEndMs,
        ...(this.turnId ? { turnId: this.turnId } : {}),
      });
    }
    this.committedTranslated = appendCommitted(this.committedTranslated, completed);
    if (this.sourceText) {
      this.committedSource = appendCommitted(this.committedSource, this.sourceText);
    }
    this.sourceText = "";
    this.translatedText = remainder;
    this.lastEmittedTranslation = "";
    this.speechStarted = false;
    this.turnId = null;
    this.turnAudioStartMs = this.lastAudioEndMs;
    this.awaitingTurn = true;
    if (remainder) {
      this.markSpeechStarted();
      this.emitTranslation(false);
    }
  }

  private finalizeTurn(options: { providerComplete?: boolean } = {}): void {
    const providerComplete = options.providerComplete !== false;
    if (this.translatedText) {
      this.emitTranslation(true);
      if (!providerComplete) {
        this.committedTranslated = appendCommitted(
          this.committedTranslated,
          this.translatedText,
        );
      }
    } else if (this.sourceText) {
      this.options.onEvent({
        type: "error",
        message: "Gemini Live Translate completed without translated text",
        retryable: true,
      });
    }
    if (!providerComplete && this.sourceText) {
      this.committedSource = appendCommitted(this.committedSource, this.sourceText);
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
    if (providerComplete) {
      this.committedSource = "";
      this.committedTranslated = "";
      this.awaitingTurn = false;
      this.turnAudioStartMs = null;
      this.resolveEndWaiters();
    } else {
      // Soft max: keep the Gemini activity open for the next caption line.
      this.awaitingTurn = true;
      this.turnAudioStartMs = this.lastAudioEndMs;
    }
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

  private enqueueAudio(audio: Uint8Array, timestampMs: number): void {
    this.queuedAudio.push({ audio: Buffer.from(audio), timestampMs });
    this.queuedAudioBytes += audio.byteLength;
    let droppedBytes = 0;
    while (this.queuedAudioBytes > MAX_QUEUED_AUDIO_BYTES && this.queuedAudio.length > 1) {
      const dropped = this.queuedAudio.shift();
      if (!dropped) break;
      this.queuedAudioBytes -= dropped.audio.byteLength;
      droppedBytes += dropped.audio.byteLength;
    }
    if (droppedBytes > 0) {
      this.options.onEvent({
        type: "warning",
        message: "Gemini Live Translate reconnect buffer filled; oldest audio was dropped",
      });
    }
  }

  private drainQueuedAudio(): void {
    while (this.queuedAudio.length > 0 && this.setupComplete && !this.closed && !this.ending) {
      const frame = this.queuedAudio.shift();
      if (!frame) break;
      this.queuedAudioBytes -= frame.audio.byteLength;
      this.pushAudio(frame.audio, frame.timestampMs);
    }
  }

  private queuePendingAudio(): void {
    if (this.pendingAudio.byteLength === 0) return;
    this.enqueueAudio(this.pendingAudio, this.pendingAudioTimestampMs ?? this.lastAudioEndMs);
    this.pendingAudio = Buffer.alloc(0);
    this.pendingAudioTimestampMs = null;
  }

  private scheduleReconnect(message: string): void {
    if (this.closed || this.ending || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.options.onEvent({
        type: "error",
        message: `${message}; reconnect limit reached`,
        retryable: false,
      });
      return;
    }
    this.options.onEvent({ type: "warning", message });
    const delayMs = Math.min(
      (this.runtime.reconnectBaseDelayMs ?? 250) * (2 ** (this.reconnectAttempts - 1)),
      this.runtime.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(false).catch(() => undefined);
    }, delayMs);
  }

  private scheduleGoAwayReconnect(socket: WebSocket, timeLeftMs: number | null): void {
    if (timeLeftMs === null || this.goAwayTimer || this.closed || this.ending) return;
    this.goAwayTimer = setTimeout(() => {
      this.goAwayTimer = null;
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.terminate();
    }, Math.max(0, timeLeftMs - GO_AWAY_RECONNECT_LEAD_MS));
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearGoAwayTimer(): void {
    if (!this.goAwayTimer) return;
    clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
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
    this.maybeSplitLongTurn();
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

/** Drop text already finalized by a soft split when Gemini re-sends cumulatives. */
function textAfterCommitted(incoming: string, committed: string): string {
  const normalizedIncoming = normalizeText(incoming);
  const normalizedCommitted = normalizeText(committed);
  if (!normalizedCommitted) return normalizedIncoming;
  if (!normalizedIncoming) return "";
  if (normalizedIncoming === normalizedCommitted) return "";
  if (normalizedIncoming.startsWith(normalizedCommitted)) {
    return normalizedIncoming.slice(normalizedCommitted.length).trim();
  }
  const committedWords = normalizedCommitted.split(/\s+/);
  const incomingWords = normalizedIncoming.split(/\s+/);
  if (
    committedWords.length > 0
    && committedWords.length <= incomingWords.length
    && committedWords.every((word, index) => (
      word.toLocaleLowerCase() === (incomingWords[index] ?? "").toLocaleLowerCase()
    ))
  ) {
    return incomingWords.slice(committedWords.length).join(" ");
  }
  return normalizedIncoming;
}

function appendCommitted(base: string, next: string): string {
  const left = normalizeText(base);
  const right = normalizeText(next);
  if (!left) return right;
  if (!right) return left;
  if (right.startsWith(left)) return right;
  if (left.startsWith(right)) return left;
  return `${left} ${right}`;
}

/** First completed sentence plus trailing speech — used for commentary line breaks. */
function splitCompletedSentence(text: string): { completed: string; remainder: string } | null {
  const normalized = normalizeText(text);
  const match = normalized.match(/^(.+?[.!?…])\s+(\S[\s\S]*)$/u);
  if (!match?.[1] || !match[2]) return null;
  const completed = match[1].trim();
  const remainder = match[2].trim();
  if (!completed || !remainder) return null;
  return { completed, remainder };
}

function parseDurationMs(value: unknown): number | null {
  if (typeof value === "string") {
    const seconds = Number.parseFloat(value.replace(/s$/i, ""));
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1_000)) : null;
  }
  if (!isRecord(value) || typeof value.seconds !== "number") return null;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  return Math.max(0, Math.round(value.seconds * 1_000 + nanos / 1_000_000));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
