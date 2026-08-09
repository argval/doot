import assert from "node:assert/strict";
import test from "node:test";
import { DeepLTextTranslator } from "../src/translation/deepl/provider.js";
import { resolveDeepLApiBaseUrl } from "../src/translation/deepl/languages.js";
import { TranslationRouter } from "../src/translation/router.js";
import { TranslationUnavailableError } from "../src/translation/contract.js";
import { SarvamTextTranslator } from "../src/translation/sarvam/provider.js";

test("translates international pairs through DeepL JSON API", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      translations: [{
        detected_source_language: "ES",
        text: "Hello world",
      }],
    });
  };
  const translator = new DeepLTextTranslator("pro-key", fetcher);

  const translated = await translator.translate({
    text: "Hola mundo",
    source: "es",
    target: "en",
  });

  assert.equal(translated, "Hello world");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.deepl.com/v2/translate");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>).Authorization,
    "DeepL-Auth-Key pro-key",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    text: ["Hola mundo"],
    target_lang: "EN",
    source_lang: "ES",
  });
});

test("omits source_lang for auto detection and uses the free API host", async () => {
  let url = "";
  let body: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      translations: [{ detected_source_language: "FR", text: "Hello" }],
    });
  };
  const translator = new DeepLTextTranslator("abc123:fx", fetcher);

  assert.equal(
    await translator.translate({
      text: "Bonjour",
      source: "auto",
      target: "en",
    }),
    "Hello",
  );
  assert.equal(url, "https://api-free.deepl.com/v2/translate");
  assert.deepEqual(body, {
    text: ["Bonjour"],
    target_lang: "EN",
  });
  assert.equal(resolveDeepLApiBaseUrl("abc123:fx"), "https://api-free.deepl.com");
});

test("maps Portuguese targets to PT-BR and skips same-language calls", async () => {
  let called = false;
  const fetcher: typeof fetch = async (_input, init) => {
    called = true;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.target_lang, "PT-BR");
    return Response.json({
      translations: [{ detected_source_language: "EN", text: "Olá" }],
    });
  };
  const translator = new DeepLTextTranslator("pro-key", fetcher);

  assert.equal(
    await translator.translate({
      text: "Hello",
      source: "en",
      target: "pt",
    }),
    "Olá",
  );
  assert.equal(called, true);

  called = false;
  assert.equal(
    await translator.translate({
      text: "Ciao",
      source: "it",
      target: "it",
    }),
    "Ciao",
  );
  assert.equal(called, false);
});

test("routes European pairs to DeepL while keeping Indic pairs on Sarvam", async () => {
  const deeplCalls: string[] = [];
  const sarvamCalls: string[] = [];

  const deepl = new DeepLTextTranslator("deepl-key", async (_input, init) => {
    deeplCalls.push(String(init?.body));
    return Response.json({
      translations: [{ detected_source_language: "DE", text: "Hello world" }],
    });
  });
  const sarvam = new SarvamTextTranslator("sarvam-key", async (_input, init) => {
    sarvamCalls.push(String(init?.body));
    return Response.json({ translated_text: "Indic translation" });
  });
  const router = new TranslationRouter([sarvam, deepl]);

  assert.equal(
    await router.translate({
      text: "Hallo Welt",
      source: "de",
      target: "en",
    }),
    "Hello world",
  );
  assert.equal(deeplCalls.length, 1);
  assert.equal(sarvamCalls.length, 0);

  assert.equal(
    await router.translate({
      text: "ನಮಸ್ಕಾರ",
      source: "kn",
      target: "en",
    }),
    "Indic translation",
  );
  assert.equal(sarvamCalls.length, 1);
  assert.equal(deeplCalls.length, 1);
});

test("still rejects unsupported cross-family routes without leaking source text", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return Response.json({ translations: [{ text: "leak" }] });
  };
  const router = new TranslationRouter([
    new SarvamTextTranslator("sarvam-key", fetcher),
    new DeepLTextTranslator("deepl-key", fetcher),
  ]);

  await assert.rejects(
    router.translate({
      text: "Hallo Welt",
      source: "de",
      target: "hi",
    }),
    TranslationUnavailableError,
  );
  assert.equal(called, false);
});
