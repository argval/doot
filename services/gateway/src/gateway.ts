import type { FastifyInstance } from "fastify";
import type { ClientMessage, ProviderId, ServerMessage, StartSessionRequest } from "@doot/protocol";
import { WebSocket } from "ws";
import { ProviderRouter } from "./providers.js";

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
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(socket, { type: "error", code: "INVALID_JSON", message: "Message must be valid JSON", retryable: false });
        return;
      }

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

function send(socket: WebSocket, event: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}
