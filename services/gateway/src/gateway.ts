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

interface SessionState {
  request: StartSessionRequest;
  providerId: ProviderId;
  audioBytes: number;
}

export function registerRealtimeGateway(app: FastifyInstance, router: ProviderRouter) {
  app.get("/v1/realtime", { websocket: true }, (socket: WebSocket, request) => {
    const sessions = new Map<string, SessionState>();
    app.log.info({ ip: request.ip }, "realtime client connected");

    socket.on("message", async (raw) => {
      const parsed = parseClientMessage(raw.toString());
      if (!parsed.ok) {
        send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Message does not match the realtime protocol", retryable: false });
        return;
      }
      const message = parsed.message;

      if (message.type === "start_session") {
        const provider = router.select(message.sourceLanguage, message.targetLanguage, message.provider);
        sessions.set(message.sessionId, { request: message, providerId: provider.id, audioBytes: 0 });
        send(socket, { type: "session_started", sessionId: message.sessionId, provider: provider.id, sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage });
        return;
      }

      const session = sessions.get(message.sessionId);
      if (!session) {
        send(socket, { type: "error", sessionId: message.sessionId, code: "SESSION_NOT_FOUND", message: "Start the session before sending audio", retryable: false });
        return;
      }

      if (message.type === "audio_chunk") {
        session.audioBytes += Buffer.from(message.dataBase64, "base64").byteLength;
        // TODO: hand bounded PCM chunks to the provider stream and emit partial/final captions.
        if (session.audioBytes >= 32_000) {
          send(socket, { type: "caption", sessionId: message.sessionId, sequence: message.sequence, sourceText: "", translatedText: "Provider adapter ready; awaiting streaming implementation.", isFinal: false, startMs: message.timestampMs, endMs: message.timestampMs, provider: session.providerId });
          session.audioBytes = 0;
        }
        return;
      }

      if (message.type === "stop_session") {
        sessions.delete(message.sessionId);
        send(socket, { type: "session_stopped", sessionId: message.sessionId });
      }
    });

    socket.on("close", () => app.log.info("realtime client disconnected"));
  });
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
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}
