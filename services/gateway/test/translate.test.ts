import assert from "node:assert/strict";
import test from "node:test";
import { GeminiTextTranslator } from "../src/translation/gemini/provider.js";
import { SarvamTextTranslator } from "../src/translation/sarvam/provider.js";
import { TranslationRouter } from "../src/translation/router.js";
import { TranslationUnavailableError } from "../src/translation/contract.js";

test("sends code-mixed text and numbers to Mayura with automatic detection", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = init?.body;
    if (typeof body !== "string") throw new Error("Expected JSON request body");
    requests.push(JSON.parse(body) as Record<string, unknown>);
    return Response.json({
      translated_text: "I use Cursor version 42 every day.",
      source_language_code: "kn-IN",
    });
  };
  const translator = new SarvamTextTranslator("test-key", fetcher);

  const translated = await translator.translate({
    text: "ನಾನು Cursor version 42 daily use ಮಾಡುತ್ತೇನೆ",
    source: "auto",
    target: "en",
  });

  assert.equal(translated, "I use Cursor version 42 every day.");
  assert.deepEqual(requests, [{
    input: "ನಾನು Cursor version 42 daily use ಮಾಡುತ್ತೇನೆ",
    source_language_code: "auto",
    target_language_code: "en-IN",
    model: "mayura:v1",
    mode: "modern-colloquial",
    output_script: "fully-native",
  }]);
});

test("falls back to the broad Sarvam translation model when Mayura rejects input", async () => {
  const models: unknown[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const rawBody = init?.body;
    if (typeof rawBody !== "string") throw new Error("Expected JSON request body");
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    models.push(body.model);
    if (models.length === 1) {
      return Response.json({ message: "unsupported mode" }, { status: 422 });
    }
    return Response.json({ translated_text: "fallback translation" });
  };
  const translator = new SarvamTextTranslator("test-key", fetcher);

  const translated = await translator.translate({
    text: "mixed text",
    source: "ur",
    target: "hi",
  });

  assert.equal(translated, "fallback translation");
  assert.deepEqual(models, ["mayura:v1", "sarvam-translate:v1"]);
});

test("skips API translation on explicit same-language routes", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return Response.json({ translated_text: "unexpected" });
  };
  const translator = new SarvamTextTranslator("test-key", fetcher);

  assert.equal(
    await translator.translate({
      text: "ನಮಸ್ಕಾರ",
      source: "kn",
      target: "kn",
    }),
    "ನಮಸ್ಕಾರ",
  );
  assert.equal(called, false);
});

test("skips API translation for auto-detect transcription", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return Response.json({ translated_text: "unexpected" });
  };
  const router = new TranslationRouter([
    new SarvamTextTranslator("test-key", fetcher),
  ]);

  assert.equal(
    await router.translate({
      text: "hello",
      source: "auto",
      target: "auto",
    }),
    "hello",
  );
  assert.equal(called, false);
});

test("rejects unsupported routes without leaking source text as translation", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return Response.json({ translated_text: "unexpected" });
  };
  const sarvam = new SarvamTextTranslator(undefined, fetcher);
  const router = new TranslationRouter([sarvam]);

  await assert.rejects(
    router.translate({
      text: "Hello world",
      source: "en",
      target: "hi",
    }),
    TranslationUnavailableError,
  );
  assert.equal(called, false);
});

test("translates English to Spanish through Gemini text translation", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const rawBody = init?.body;
    if (typeof rawBody !== "string") throw new Error("Expected JSON request body");
    requests.push({ url, body: JSON.parse(rawBody) as Record<string, unknown> });
    return Response.json({
      candidates: [{ content: { parts: [{ text: "Hola mundo" }] } }],
    });
  };
  const translator = new GeminiTextTranslator("test-gemini-key", fetcher);

  const translated = await translator.translate({
    text: "Hello world",
    source: "en",
    target: "es",
  });

  assert.equal(translated, "Hola mundo");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /gemini-2\.5-flash:generateContent/);
  assert.match(JSON.stringify(requests[0]!.body), /Spanish/);
});

test("prefers Sarvam for Indic pairs and Gemini for European targets", async () => {
  const models: string[] = [];
  const sarvamFetcher: typeof fetch = async (_input, init) => {
    models.push("sarvam");
    const rawBody = init?.body;
    if (typeof rawBody !== "string") throw new Error("Expected JSON request body");
    return Response.json({ translated_text: "Indic translation" });
  };
  const geminiFetcher: typeof fetch = async () => {
    models.push("gemini");
    return Response.json({
      candidates: [{ content: { parts: [{ text: "Bonjour" }] } }],
    });
  };
  const router = new TranslationRouter([
    new SarvamTextTranslator("sarvam-key", sarvamFetcher),
    new GeminiTextTranslator("gemini-key", geminiFetcher),
  ]);

  assert.equal(
    await router.translate({ text: "ನಮಸ್ಕಾರ", source: "kn", target: "en" }),
    "Indic translation",
  );
  assert.equal(
    await router.translate({ text: "Hello", source: "en", target: "fr" }),
    "Bonjour",
  );
  assert.deepEqual(models, ["sarvam", "gemini"]);
});
