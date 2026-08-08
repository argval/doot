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

test("streams mock captions after receiving a bounded PCM batch", async (context) => {
  const app = await buildServer();
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const caption = await receiveMockCaption(address.replace("http", "ws") + "/v1/realtime");

  assert.deepEqual(caption, {
    type: "caption",
    sessionId: "mock-session",
    sequence: 0,
    sourceText: "Received 1500 ms of system audio.",
    translatedText: "The live caption pipeline is connected.",
    isFinal: true,
    startMs: 0,
    endMs: 0,
    provider: "mock",
  });
});

test("selects Sarvam when configured for Indian language routes", async () => {
  const { ProviderRouter } = await import("../src/providers.js");
  const router = new ProviderRouter("test-sarvam-key");
  assert.equal(router.select("hi", "en").id, "sarvam");
  assert.equal(router.select("auto", "en").id, "sarvam");
  assert.equal(router.select("en", "es").id, "mock");
});

test("falls back to mock when Sarvam is not configured", async () => {
  const { ProviderRouter } = await import("../src/providers.js");
  const router = new ProviderRouter();
  assert.equal(router.select("hi", "en").id, "mock");
});

test("skips near-silent PCM before calling Sarvam helpers", async () => {
  const { hasSpeechEnergy, pcmS16leRms } = await import("../src/sarvam.js");
  const silence = new Uint8Array(32_000);
  assert.equal(pcmS16leRms(silence), 0);
  assert.equal(hasSpeechEnergy(silence), false);

  const tone = Buffer.alloc(32_000);
  for (let index = 0; index < tone.length; index += 2) {
    tone.writeInt16LE(8_000, index);
  }
  assert.equal(hasSpeechEnergy(tone), true);
});

test("resolves Sarvam translate mode for Indic → English", async () => {
  const { resolveSarvamMode, toSarvamLanguageCode } = await import("../src/sarvam.js");
  assert.equal(resolveSarvamMode("hi", "en"), "translate");
  assert.equal(resolveSarvamMode("en", "en"), "transcribe");
  assert.equal(toSarvamLanguageCode("auto"), "unknown");
  assert.equal(toSarvamLanguageCode("hi"), "hi-IN");
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

function receiveMockCaption(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for mock caption"));
    }, 3_000);

    socket.once("error", reject);
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "start_session",
        sessionId: "mock-session",
        sourceLanguage: "en",
        targetLanguage: "es",
        provider: "mock",
        sampleRate: 16_000,
        channels: 1,
      }));
    });
    socket.on("message", (raw) => {
      const message: unknown = JSON.parse(raw.toString());
      if (
        typeof message === "object"
        && message !== null
        && "type" in message
        && message.type === "session_started"
      ) {
        socket.send(JSON.stringify({
          type: "audio_chunk",
          sessionId: "mock-session",
          sequence: 0,
          timestampMs: 0,
          encoding: "pcm_s16le",
          dataBase64: Buffer.alloc(48_000).toString("base64"),
        }));
      }
      if (
        typeof message === "object"
        && message !== null
        && "type" in message
        && message.type === "caption"
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(message);
      }
    });
  });
}
