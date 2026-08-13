import assert from "node:assert/strict";
import test from "node:test";
import {
  filterGeminiTranslationToTarget,
  geminiLanguageCodeMatches,
  looksLikeGeminiLanguage,
} from "../src/speech/gemini/languages.js";

test("drops Spanish source leaks from English Gemini translations", () => {
  const mixed = [
    "I will invoke the Alien Enemies Act of 1798, you know, 1798.",
    "That's when they ran the country a little tougher than we run it today.",
    "Estale, aun vigente marte dos siglos despues, permite arrestar y deportar",
    "a migrantes mayores de catorce años, aunque no hay acargos",
  ].join(" ");

  const filtered = filterGeminiTranslationToTarget(mixed, "en", "es");
  assert.match(filtered, /Alien Enemies Act/i);
  assert.match(filtered, /tougher than we run it today/i);
  assert.doesNotMatch(filtered, /migrantes|vigente|catorce|despues/i);
});

test("drops French source leaks from English Gemini translations", () => {
  const mixed = [
    "I will invoke the Alien Enemies Act of 1798.",
    "Cette loi est encore en vigueur après plus de deux siècles et permet d'arrêter les migrants.",
  ].join(" ");

  const filtered = filterGeminiTranslationToTarget(mixed, "en", "fr");
  assert.match(filtered, /Alien Enemies Act/i);
  assert.doesNotMatch(filtered, /vigueur|siècles|migrants|après/i);
});

test("drops German source leaks from English Gemini translations", () => {
  const mixed = [
    "I will invoke the Alien Enemies Act of 1798.",
    "Dieses Gesetz ist auch heute noch in Kraft und erlaubt es, Migranten zu verhaften.",
  ].join(" ");

  const filtered = filterGeminiTranslationToTarget(mixed, "en", "de");
  assert.match(filtered, /Alien Enemies Act/i);
  assert.doesNotMatch(filtered, /Gesetz|Kraft|Migranten|verhaften|heute/i);
});

test("rejects entire source-only output chunks for fr/de→en", () => {
  assert.equal(
    filterGeminiTranslationToTarget(
      "Cette loi est encore en vigueur après plus de deux siècles",
      "en",
      "fr",
    ),
    "",
  );
  assert.equal(
    filterGeminiTranslationToTarget(
      "Dieses Gesetz ist auch heute noch in Kraft und erlaubt es Migranten zu verhaften",
      "en",
      "de",
    ),
    "",
  );
});

test("drops Spanish leaks from Hindi Gemini translations", () => {
  const filtered = filterGeminiTranslationToTarget(
    "यह कानून अभी भी लागू है। Esta ley aun vigente permite arrestar y deportar a migrantes",
    "hi",
    "es",
  );
  assert.match(filtered, /यह कानून/);
  assert.doesNotMatch(filtered, /migrantes|vigente|arrestar/i);
});

test("drops French leaks when targeting Spanish", () => {
  const filtered = filterGeminiTranslationToTarget(
    "Esta ley sigue vigente hoy. Cette loi est encore en vigueur après plus de deux siècles",
    "es",
    "fr",
  );
  assert.match(filtered, /Esta ley sigue vigente/i);
  assert.doesNotMatch(filtered, /vigueur|siècles|Cette/i);
});

test("drops English leaks when targeting Spanish", () => {
  const filtered = filterGeminiTranslationToTarget(
    "Esta ley sigue vigente hoy. That is when they ran the country a little tougher than we run it today",
    "es",
    "en",
  );
  assert.match(filtered, /Esta ley sigue vigente/i);
  assert.doesNotMatch(filtered, /country|tougher|today/i);
});

test("rejects an entire Spanish-only output chunk when targeting English", () => {
  assert.equal(
    filterGeminiTranslationToTarget(
      "Esta ley aun vigente permite arrestar y deportar a migrantes",
      "en",
      "es",
    ),
    "",
  );
});

test("matches Gemini language codes against doot targets", () => {
  assert.equal(geminiLanguageCodeMatches("en", "en"), true);
  assert.equal(geminiLanguageCodeMatches("en-US", "en"), true);
  assert.equal(geminiLanguageCodeMatches("es", "en"), false);
  assert.equal(geminiLanguageCodeMatches("fr-FR", "en"), false);
  assert.equal(geminiLanguageCodeMatches("de", "en"), false);
  assert.equal(geminiLanguageCodeMatches(undefined, "en"), true);
});

test("detects Spanish marker density", () => {
  assert.equal(
    looksLikeGeminiLanguage(
      "permite arrestar y deportar a migrantes mayores de catorce años",
      "es",
    ),
    true,
  );
  assert.equal(
    looksLikeGeminiLanguage(
      "That's when they ran the country a little tougher than we run it today",
      "es",
    ),
    false,
  );
});
