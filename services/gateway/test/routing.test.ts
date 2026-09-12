import assert from "node:assert/strict";
import test from "node:test";
import { type CaptionRoute, type SupportedLanguage } from "@doot/protocol";
import { buildServer, createProviderRouter, createTranslationRouter } from "../src/server.js";
import { ProviderRouter } from "../src/speech/router.js";
import { SarvamProvider } from "../src/speech/sarvam/provider.js";
import { GeminiProvider } from "../src/speech/gemini/provider.js";
import { GeminiTranscribeProvider } from "../src/speech/gemini/transcribe.js";
import { TranslationRouter } from "../src/translation/router.js";
import { SarvamTextTranslator } from "../src/translation/sarvam/provider.js";
import { GeminiTextTranslator } from "../src/translation/gemini/provider.js";
import { parseClientMessage } from "../src/gateway.js";

const bothKeys = { sarvamApiKey: "test", geminiApiKey: "test" };
const request = (sourceLanguage: SupportedLanguage, targetLanguage: SupportedLanguage) => ({
  sourceLanguage, targetLanguage, sampleRate: 16_000 as const, channels: 1 as const,
});

test("complete routing matrix with both keys, each key alone, and no keys", () => {
  // Columns are both keys, Sarvam only, Gemini only, neither. Null means unavailable.
  const cases: Array<[SupportedLanguage, SupportedLanguage, Array<string | null>]> = [
    ["en", "en", ["sarvam/none", "sarvam/none", "gemini-transcribe/none", null]],
    ["kn", "en", ["sarvam/sarvam", "sarvam/sarvam", "gemini/gemini", null]],
    ["en", "hi", ["sarvam/sarvam", "sarvam/sarvam", "gemini/gemini", null]],
    ["en", "es", ["sarvam/gemini", null, "gemini/gemini", null]],
    ["es", "es", ["gemini-transcribe/none", null, "gemini-transcribe/none", null]],
    ["es", "en", ["gemini/gemini", null, "gemini/gemini", null]],
    ["auto", "auto", ["sarvam/none", "sarvam/none", "gemini-transcribe/none", null]],
    ["auto", "en", ["sarvam/sarvam", "sarvam/sarvam", "gemini/gemini", null]],
    ["auto", "fr", ["gemini/gemini", null, "gemini/gemini", null]],
  ];
  const configurations = [bothKeys, { sarvamApiKey: "test" }, { geminiApiKey: "test" }, {}];
  configurations.forEach((keys, index) => {
    const speech = createProviderRouter(keys);
    const translation = createTranslationRouter(keys);
    for (const [source, target, expected] of cases) {
      const resolve = () => speech.resolveRoute(request(source, target), translation).route;
      if (expected[index] === null) {
        assert.throws(resolve, /No configured (speech|translation) provider/, `${source}→${target}, keys ${index}`);
      } else {
        const route = resolve();
        assert.equal(`${route.speechProvider}/${route.translationProvider ?? "none"}`, expected[index], `${source}→${target}, keys ${index}`);
        assert.equal(route.mode, source === target ? "transcribe" : "translate");
      }
    }
  });
});

test("route preferences do not depend on provider construction order", () => {
  const speech = new ProviderRouter([
    new GeminiProvider("test"), new GeminiTranscribeProvider("test"), new SarvamProvider("test"),
  ]);
  const translation = new TranslationRouter([
    new GeminiTextTranslator("test"), new SarvamTextTranslator("test"),
  ]);
  assert.equal(speech.resolveRoute(request("en", "hi"), translation).route.translationProvider, "sarvam");
  assert.equal(speech.resolveRoute(request("en", "hi"), translation).route.speechProvider, "sarvam");
  assert.equal(speech.resolveRoute(request("es", "es"), translation).route.speechProvider, "gemini-transcribe");
});

test("explicit providers still obey mode, format, credentials, and translation availability", () => {
  const speech = createProviderRouter(bothKeys);
  const translation = createTranslationRouter(bothKeys);
  assert.throws(() => speech.resolveRoute({ ...request("es", "en"), provider: "gemini-transcribe" }, translation), /does not support/);
  assert.throws(() => speech.resolveRoute({ ...request("en", "es"), provider: "sarvam" }, new TranslationRouter([])), /No configured translation/);
  assert.equal(parseClientMessage(JSON.stringify({ type: "start_session", sessionId: "invalid-rate", ...request("en", "en"), sampleRate: 48_000 })).ok, false);
  assert.throws(() => speech.resolveRoute(request("en", "auto"), translation), /Translate To/);
  assert.equal(parseClientMessage(JSON.stringify({ type: "start_session", sessionId: "invalid", ...request("en", "auto") })).ok, false);
  const demo = createProviderRouter().resolveRoute({ ...request("en", "en"), provider: "mock" }, new TranslationRouter([]));
  assert.match(demo.route.description, /Demo/);
});

test("Auto reports its actual detection scope and pins the translator for the session", async () => {
  let calls = 0;
  const provider = {
    id: "sarvam", configured: true, targetLanguages: ["en"] as const,
    supports: () => true,
    translate: async () => { calls++; return "translated"; },
  };
  const resolved = createProviderRouter(bothKeys).resolveRoute(request("auto", "en"), new TranslationRouter([provider]));
  assert.ok(resolved.route.detectionLanguages.includes("kn"));
  assert.ok(!resolved.route.detectionLanguages.includes("es"));
  assert.match(resolved.route.description, /English and Indic/);
  provider.configured = false;
  assert.equal(await resolved.translate({ source: "auto", target: "en", text: "hello" }), "translated");
  assert.equal(calls, 1);
});

test("preflight and WebSocket startup reject missing translation before opening speech", { timeout: 3000 }, async (context) => {
  const speech = new SarvamProvider("test");
  let opens = 0;
  speech.openSession = async () => { opens++; throw new Error("Must not open speech"); };
  const app = await buildServer(new ProviderRouter([speech]), new TranslationRouter([]));
  context.after(() => app.close());
  const preflight = await app.inject({ url: "/v1/route?source=en&target=es" });
  assert.equal(preflight.statusCode, 422);
  const socket = await app.injectWS("/v1/realtime");
  context.after(() => socket.terminate());
  const response = new Promise<{ code: string; message: string }>((resolve) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  socket.send(JSON.stringify({ type: "start_session", sessionId: "missing-mt", ...request("en", "es") }));
  const error = await response;
  assert.equal(error.code, "TRANSLATION_UNAVAILABLE");
  assert.equal(error.message, preflight.json().message);
  assert.equal(opens, 0);
  socket.terminate();
});

test("session_started reports the same resolved route as preflight", { timeout: 3000 }, async (context) => {
  const app = await buildServer(createProviderRouter(), new TranslationRouter([]));
  context.after(() => app.close());
  const preflight = await app.inject({ url: "/v1/route?source=en&target=en&provider=mock" });
  const socket = await app.injectWS("/v1/realtime");
  context.after(() => socket.terminate());
  const response = new Promise<{ type: string; route: CaptionRoute }>((resolve) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  socket.send(JSON.stringify({ type: "start_session", sessionId: "demo", ...request("en", "en"), provider: "mock" }));
  const started = await response;
  assert.equal(started.type, "session_started");
  assert.deepEqual(started.route, preflight.json());
  socket.terminate();
});

test("preflight reports the route, validates input, and limits cross-origin access", async (context) => {
  const app = await buildServer(createProviderRouter(bothKeys), createTranslationRouter(bothKeys));
  context.after(() => app.close());
  const response = await app.inject({ url: "/v1/route?source=en&target=es", headers: { origin: "http://localhost:1420" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:1420");
  const route = response.json<CaptionRoute>();
  assert.equal(route.translation, "text");
  assert.match(route.description, /Sarvam recognition → Gemini text translation/);
  for (const query of ["source=bad&target=en", "source=en&target=auto", "source=en&target=en&provider=bad", "source=en"]) {
    assert.equal((await app.inject({ url: `/v1/route?${query}` })).statusCode, 400);
  }
  assert.equal((await app.inject({ url: "/v1/route?source=en&target=en", headers: { origin: "https://untrusted.example" } })).headers["access-control-allow-origin"], undefined);
});

test("health excludes mock and translation-only coverage without recognition", async (context) => {
  const app = await buildServer(createProviderRouter(), createTranslationRouter(bothKeys));
  context.after(() => app.close());
  const response = await app.inject({ url: "/health" });
  assert.deepEqual(response.json().languages, { sources: [], targets: [] });
  assert.equal((await app.inject({ url: "/v1/route?source=en&target=en" })).statusCode, 422);
});
