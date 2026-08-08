import "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import {
  isAudioSampleRate,
  isChannelCount,
  isProviderId,
  isSupportedLanguage,
  type ClientMessage,
  type ProviderId,
  type ServerMessage,
  type StartSessionRequest,
} from "@doot/protocol";
import { WebSocket } from "ws";
import { ProviderRouter } from "./providers.js";

const maxAudioChunkBytes = 256 * 1024;
const maxBase64Length = Math.ceil(maxAudioChunkBytes / 3) * 4;
const providerBatchBytes = 48_000; // 1.5s @ 16 kHz mono S16LE
const maxBufferedAudioBytes = 192_000; // 6s @ 16 kHz mono S16LE

interface SessionState {
  request: StartSessionRequest;
  providerId: ProviderId;
  audioBytes: number;
  audioChunks: Buffer[];
  captionSequence: number;
  segmentStartMs: number;
  providerPending: boolean;
  lastAudioTimestampMs: number;
  stopRequested: boolean;
}

export function registerRealtimeGateway(app: FastifyInstance, router: ProviderRouter) {
  app.get("/v1/realtime", { websocket: true }, (socket: WebSocket, request) => {
    const sessions = new Map<string, SessionState>();
    app.log.info({ ip: request.ip }, "realtime client connected");

    socket.on("message", (raw) => {
      try {
        handleMessage(router, socket, sessions, raw.toString());
      } catch (error) {
        app.log.error({ err: error }, "realtime message handler failed");
        send(socket, {
          type: "error",
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Realtime handler failed",
          retryable: true,
        });
      }
    });

    socket.on("error", (error) => {
      app.log.warn({ err: error }, "realtime socket error");
    });

    socket.on("close", () => app.log.info("realtime client disconnected"));
  });
}

function handleMessage(
  router: ProviderRouter,
  socket: WebSocket,
  sessions: Map<string, SessionState>,
  raw: string,
): void {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    send(socket, {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Message does not match the realtime protocol",
      retryable: false,
    });
    return;
  }
  const message = parsed.message;

  if (message.type === "start_session") {
    try {
      const provider = router.select(message.sourceLanguage, message.targetLanguage, message.provider);
      sessions.set(message.sessionId, {
        request: message,
        providerId: provider.id,
        audioBytes: 0,
        audioChunks: [],
        captionSequence: 0,
        segmentStartMs: 0,
        providerPending: false,
        lastAudioTimestampMs: 0,
        stopRequested: false,
      });
      send(socket, {
        type: "session_started",
        sessionId: message.sessionId,
        provider: provider.id,
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
      });
    } catch (error) {
      send(socket, {
        type: "error",
        sessionId: message.sessionId,
        code: "PROVIDER_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Requested provider is unavailable",
        retryable: false,
      });
      return;
    }
    return;
  }

  const session = sessions.get(message.sessionId);
  if (!session) {
    send(socket, {
      type: "error",
      sessionId: message.sessionId,
      code: "SESSION_NOT_FOUND",
      message: "Start the session before sending audio",
      retryable: false,
    });
    return;
  }

  if (message.type === "audio_chunk") {
    enqueueAudio(session, message);
    scheduleProvider(router, socket, session, message.sessionId, false);
    return;
  }

  if (message.type === "stop_session") {
    session.stopRequested = true;
    scheduleProvider(router, socket, session, message.sessionId, true);
    sessions.delete(message.sessionId);
    send(socket, { type: "session_stopped", sessionId: message.sessionId });
  }
}

function enqueueAudio(
  session: SessionState,
  message: Extract<ClientMessage, { type: "audio_chunk" }>,
): void {
  const audio = Buffer.from(message.dataBase64, "base64");
  if (session.audioBytes === 0) session.segmentStartMs = message.timestampMs;
  session.audioChunks.push(audio);
  session.audioBytes += audio.byteLength;
  session.lastAudioTimestampMs = message.timestampMs;

  const droppedBytes = trimBufferedAudio(session);
  if (droppedBytes > 0) {
    session.segmentStartMs = message.timestampMs;
  }
}

function scheduleProvider(
  router: ProviderRouter,
  socket: WebSocket,
  session: SessionState,
  sessionId: string,
  flush: boolean,
): void {
  if (session.providerPending || session.audioBytes === 0) return;
  if (!flush && session.audioBytes < providerBatchBytes) return;

  const byteCount = flush ? session.audioBytes : providerBatchBytes;
  const startMs = session.segmentStartMs;
  const providerAudio = takeAudio(session, byteCount);
  session.providerPending = true;

  void emitProviderCaption(
    router,
    socket,
    session,
    sessionId,
    providerAudio,
    startMs,
    session.lastAudioTimestampMs,
    flush,
  ).finally(() => {
    session.providerPending = false;
    if (session.audioBytes > 0) {
      session.segmentStartMs = session.lastAudioTimestampMs;
    }
    if (!session.stopRequested) {
      scheduleProvider(router, socket, session, sessionId, false);
    }
  });
}

async function emitProviderCaption(
  router: ProviderRouter,
  socket: WebSocket,
  session: SessionState,
  sessionId: string,
  providerAudio: Buffer,
  startMs: number,
  endMs: number,
  isFinal: boolean,
): Promise<void> {
  try {
    const provider = router.select(
      session.request.sourceLanguage,
      session.request.targetLanguage,
      session.providerId,
    );
    const result = await provider.transcribeAndTranslate(
      providerAudio,
      session.request.sourceLanguage,
      session.request.targetLanguage,
    );
    if (!result || (!result.sourceText && !result.translatedText)) return;

    const sequence = session.captionSequence;
    session.captionSequence += 1;
    send(socket, {
      type: "caption",
      sessionId,
      sequence,
      sourceText: result.sourceText,
      translatedText: result.translatedText,
      isFinal: isFinal || endsSentence(result.translatedText || result.sourceText),
      startMs,
      endMs,
      provider: session.providerId,
    });
  } catch (error) {
    send(socket, {
      type: "error",
      sessionId,
      code: "PROVIDER_ERROR",
      message: error instanceof Error ? error.message : "Speech provider failed",
      retryable: true,
    });
  }
}

function endsSentence(text: string): boolean {
  return /[.!?।]$/u.test(text.trim());
}

function takeAudio(session: SessionState, byteCount: number): Buffer {
  const out = Buffer.allocUnsafe(byteCount);
  let offset = 0;
  while (offset < byteCount && session.audioChunks.length > 0) {
    const chunk = session.audioChunks[0]!;
    const copy = Math.min(chunk.byteLength, byteCount - offset);
    chunk.copy(out, offset, 0, copy);
    offset += copy;
    if (copy === chunk.byteLength) {
      session.audioChunks.shift();
    } else {
      session.audioChunks[0] = chunk.subarray(copy);
    }
  }
  session.audioBytes = Math.max(0, session.audioBytes - offset);
  return offset === byteCount ? out : out.subarray(0, offset);
}

function trimBufferedAudio(session: SessionState): number {
  let droppedBytes = 0;
  while (session.audioBytes > maxBufferedAudioBytes && session.audioChunks.length > 0) {
    const dropped = session.audioChunks.shift()!;
    session.audioBytes -= dropped.byteLength;
    droppedBytes += dropped.byteLength;
  }
  session.audioBytes = Math.max(0, session.audioBytes);
  return droppedBytes;
}

export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!isRecord(value) || typeof value.type !== "string") return { ok: false };

  if (value.type === "start_session") {
    if (
      !isSessionId(value.sessionId)
      || !isSupportedLanguage(value.sourceLanguage)
      || !isSupportedLanguage(value.targetLanguage)
      || !isAudioSampleRate(value.sampleRate)
      || !isChannelCount(value.channels)
      || (value.provider !== undefined && !isProviderId(value.provider))
    ) return { ok: false };

    return {
      ok: true,
      message: {
        type: "start_session",
        sessionId: value.sessionId,
        sourceLanguage: value.sourceLanguage,
        targetLanguage: value.targetLanguage,
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        sampleRate: value.sampleRate,
        channels: value.channels,
      },
    };
  }

  if (value.type === "audio_chunk") {
    if (
      !isSessionId(value.sessionId)
      || !isNonNegativeInteger(value.sequence)
      || !isNonNegativeInteger(value.timestampMs)
      || value.encoding !== "pcm_s16le"
      || !isBase64Chunk(value.dataBase64)
    ) return { ok: false };

    return {
      ok: true,
      message: {
        type: "audio_chunk",
        sessionId: value.sessionId,
        sequence: value.sequence,
        timestampMs: value.timestampMs,
        encoding: value.encoding,
        dataBase64: value.dataBase64,
      },
    };
  }

  if (value.type === "stop_session" && isSessionId(value.sessionId)) {
    return { ok: true, message: { type: "stop_session", sessionId: value.sessionId } };
  }

  return { ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBase64Chunk(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxBase64Length
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && Buffer.byteLength(value, "base64") <= maxAudioChunkBytes;
}

function send(socket: WebSocket, event: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // The peer may close between the ready-state check and send.
  }
}
