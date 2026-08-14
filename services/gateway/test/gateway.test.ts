import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPPORTED_LANGUAGES,
  type ServerMessage,
} from "@doot/protocol";
import WebSocket from "ws";
import { parseClientMessage } from "../src/gateway.js";
import { createProviderRouter } from "../src/speech/registry.js";
import { createTranslationRouter } from "../src/translation/registry.js";
import {
  SARVAM_SUPPORTED_LANGUAGES,
  hasSpeechEnergy,
  pcmS16leRms,
  toSarvamLanguageCode,
} from "../src/speech/sarvam/languages.js";
import { toGeminiLanguageCode } from "../src/speech/gemini/languages.js";
import { buildServer } from "../src/server.js";

test("accepts canonical language IDs in session-start messages", () => {
  for (const sourceLanguage of SUPPORTED_LANGUAGES) {
    const result = parseClientMessage(JSON.stringify({
      type: "start_session",
      sessionId: `session-${sourceLanguage}`,
      sourceLanguage,
      targetLanguage: "en",
      sampleRate: 16_000,
      channels: 1,
    }));
    assert.equal(result.ok, true, `expected ${sourceLanguage} to be supported`);
  }
});

test("accepts international translation targets", () => {
  for (const targetLanguage of ["es", "fr", "de", "ja", "zh"] as const) {
    const result = parseClientMessage(JSON.stringify({
      type: "start_session",
      sessionId: `session-to-${targetLanguage}`,
      sourceLanguage: "en",
      targetLanguage,
      sampleRate: 16_000,
      channels: 1,
    }));
    assert.equal(result.ok, true, `expected target ${targetLanguage} to be supported`);
  }
});

test("rejects malformed, unsupported, and oversized audio messages", () => {
  for (const payload of [
    "not json",
    JSON.stringify({
      type: "start_session",
      sessionId: "s",
      sourceLanguage: "invalid",
      targetLanguage: "en",
      sampleRate: 16_000,
      channels: 1,
    }),
    JSON.stringify({
      type: "audio_chunk",
      sessionId: "s",
      sequence: 1,
      timestampMs: 0,
      encoding: "pcm_s16le",
      dataBase64: "not base64!",
    }),
    JSON.stringify({
      type: "audio_chunk",
      sessionId: "s",
      sequence: 1,
      timestampMs: 0,
      encoding: "pcm_s16le",
      dataBase64: "A".repeat(349_528),
    }),
  ]) {
    assert.deepEqual(parseClientMessage(payload), { ok: false });
  }
});

test("returns a protocol error for an invalid realtime WebSocket payload", async (context) => {
  const app = await buildServer();
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const response = await receiveMessage(
    address.replace("http", "ws") + "/v1/realtime",
    "not json",
  );
  assert.deepEqual(response, {
    type: "error",
    code: "INVALID_MESSAGE",
    message: "Message does not match the realtime protocol",
    retryable: false,
  });
});

test("returns the established provider error when Gemini is unavailable", async (context) => {
  const app = await buildServer(createProviderRouter());
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const response = await receiveMessage(
    address.replace("http", "ws") + "/v1/realtime",
    JSON.stringify({
      type: "start_session",
      sessionId: "gemini-unavailable",
      sourceLanguage: "es",
      targetLanguage: "en",
      provider: "gemini",
      sampleRate: 16_000,
      channels: 1,
    }),
  );
  assert.deepEqual(response, {
    type: "error",
    sessionId: "gemini-unavailable",
    code: "PROVIDER_UNAVAILABLE",
    message: "Provider gemini is not configured",
    retryable: false,
  });
});

test("streams revisioned mock captions after receiving PCM", async (context) => {
  const app = await buildServer(
    createProviderRouter(),
    async (request) => request.text,
    { utteranceGraceMs: 10 },
  );
  context.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const caption = await receiveMockFinalCaption(
    address.replace("http", "ws") + "/v1/realtime",
  );

  assert.deepEqual(caption, {
    type: "caption",
    sessionId: "mock-session",
    sequence: 0,
    utteranceId: "mock-session:0:0",
    revision: 2,
    sourceText: "Received 1500 ms of system audio.",
    translatedText: "Received 1500 ms of system audio.",
    isFinal: true,
    startMs: 0,
    endMs: 0,
    provider: "mock",
  });
});

test("routes every Saaras language through Sarvam when configured", () => {
  const router = createProviderRouter({ sarvamApiKey: "test-sarvam-key" });
  for (const language of SARVAM_SUPPORTED_LANGUAGES) {
    assert.equal(
      router.select(language).id,
      "sarvam",
      `expected Sarvam route for ${language}`,
    );
  }
  assert.equal(router.select("kn").id, "sarvam");
});

test("falls back to mock when Sarvam is not configured", () => {
  const router = createProviderRouter();
  assert.equal(router.select("kn").id, "mock");
});

test("routes international sources through Gemini and Sarvam sources through Sarvam", () => {
  const router = createProviderRouter({
    sarvamApiKey: "test-sarvam-key",
    geminiApiKey: "test-gemini-key",
  });
  for (const language of ["es", "fr", "de", "it", "ja", "zh"] as const) {
    assert.equal(router.select(language).id, "gemini");
    assert.equal(router.select(language, undefined, 16_000, 1, "en").id, "gemini");
  }
  assert.equal(router.select("en", undefined, 16_000, 1, "es").id, "sarvam");
  assert.equal(router.select("en", undefined, 16_000, 1, "fr").id, "sarvam");
  assert.equal(router.select("kn", undefined, 16_000, 1, "es").id, "sarvam");
  assert.equal(router.select("auto", undefined, 16_000, 1, "en").id, "sarvam");
  assert.equal(router.select("auto", undefined, 16_000, 1, "es").id, "gemini");
  assert.equal(router.select("en", "gemini", 16_000, 1, "es").id, "gemini");
  assert.equal(router.select("en", "gemini", 16_000, 1, "hi").id, "gemini");
});

test("routes every supported live language through Sarvam", () => {
  const router = createProviderRouter({
    sarvamApiKey: "test-sarvam-key",
  });
  for (const language of SARVAM_SUPPORTED_LANGUAGES) {
    assert.equal(router.select(language).id, "sarvam");
  }
  assert.deepEqual(router.availability(), {
    sarvam: true,
    gemini: false,
    mock: true,
  });
});

test("health reports speech, translation, and language coverage", async (context) => {
  const translation = createTranslationRouter({
    sarvamApiKey: "test-sarvam-key",
    geminiApiKey: "test-gemini-key",
  });
  const app = await buildServer(
    createProviderRouter({
      sarvamApiKey: "test-sarvam-key",
      geminiApiKey: "test-gemini-key",
    }),
    (request) => translation.translate(request),
    {},
    translation,
  );
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    status: string;
    providers: Record<string, boolean>;
    translation: Record<string, boolean>;
    languages: { sources: string[]; targets: string[] };
  };
  assert.equal(body.status, "ok");
  assert.equal(body.providers.sarvam, true);
  assert.equal(body.providers.gemini, true);
  assert.equal(body.translation.sarvam, true);
  assert.equal(body.translation.gemini, true);
  assert.ok(body.languages.sources.includes("auto"));
  assert.ok(body.languages.sources.includes("es"));
  assert.ok(body.languages.targets.includes("fr"));
  assert.ok(body.languages.targets.includes("ja"));
});

test("maps all Saaras languages and retains PCM diagnostics", () => {
  assert.equal(toSarvamLanguageCode("auto"), "unknown");
  assert.equal(toSarvamLanguageCode("kn"), "kn-IN");
  assert.equal(toSarvamLanguageCode("doi"), "doi-IN");
  assert.equal(toGeminiLanguageCode("en"), "en");
  assert.equal(toGeminiLanguageCode("zh"), "zh-Hans");
  assert.equal(toGeminiLanguageCode("pt"), "pt-BR");

  const silence = new Uint8Array(32_000);
  assert.equal(pcmS16leRms(silence), 0);
  assert.equal(hasSpeechEnergy(silence), false);

  const tone = Buffer.alloc(32_000);
  for (let index = 0; index < tone.length; index += 2) {
    tone.writeInt16LE(8_000, index);
  }
  assert.equal(hasSpeechEnergy(tone), true);
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

function receiveMockFinalCaption(url: string): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for final mock caption"));
    }, 3_000);

    socket.once("error", reject);
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "start_session",
        sessionId: "mock-session",
        sourceLanguage: "en",
        targetLanguage: "hi",
        provider: "mock",
        sampleRate: 16_000,
        channels: 1,
      }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "session_started") {
        socket.send(JSON.stringify({
          type: "audio_chunk",
          sessionId: "mock-session",
          sequence: 0,
          timestampMs: 0,
          encoding: "pcm_s16le",
          dataBase64: Buffer.alloc(48_000).toString("base64"),
        }));
      }
      if (message.type === "caption" && message.isFinal) {
        clearTimeout(timeout);
        socket.close();
        resolve(message);
      }
    });
  });
}
