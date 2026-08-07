import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { parseClientMessage } from "../src/gateway.js";
import { buildServer } from "../src/server.js";

test("accepts a valid session-start message", () => {
  const result = parseClientMessage(JSON.stringify({
    type: "start_session",
    sessionId: "session-1",
    sourceLanguage: "en",
    targetLanguage: "es",
    sampleRate: 16_000,
    channels: 1,
  }));

  assert.deepEqual(result, {
    ok: true,
    message: {
      type: "start_session",
      sessionId: "session-1",
      sourceLanguage: "en",
      targetLanguage: "es",
      sampleRate: 16_000,
      channels: 1,
    },
  });
});

test("rejects malformed, unsupported, and oversized audio messages", () => {
  for (const payload of [
    "not json",
    JSON.stringify({ type: "start_session", sessionId: "s", sourceLanguage: "invalid", targetLanguage: "en", sampleRate: 16_000, channels: 1 }),
    JSON.stringify({ type: "audio_chunk", sessionId: "s", sequence: 1, timestampMs: 0, encoding: "pcm_s16le", dataBase64: "not base64!" }),
    JSON.stringify({ type: "audio_chunk", sessionId: "s", sequence: 1, timestampMs: 0, encoding: "pcm_s16le", dataBase64: "A".repeat(349_528) }),
  ]) {
    assert.deepEqual(parseClientMessage(payload), { ok: false });
  }
});

test("returns a protocol error for an invalid realtime WebSocket payload", async (context) => {
  const app = await buildServer();
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const response = await receiveMessage(address.replace("http", "ws") + "/v1/realtime", "not json");
  assert.deepEqual(response, {
    type: "error",
    code: "INVALID_MESSAGE",
    message: "Message does not match the realtime protocol",
    retryable: false,
  });
});

function receiveMessage(url: string, payload: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for WebSocket response"));
    }, 3_000);

    socket.once("error", reject);
    socket.once("open", () => socket.send(payload));
    socket.once("message", (raw) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(raw.toString()));
    });
  });
}
