import assert from "node:assert/strict";
import test from "node:test";
import { SarvamTextTranslator } from "../src/translate.js";

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
