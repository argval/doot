import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCanonicalNames,
  createGeminiCaptionContextInferrer,
  normalizeContextHint,
  parseCaptionContextResponse,
  readOptionalContextHint,
  SessionCaptionContext,
} from "../src/caption-context.js";

test("canonical names replace word-bounded spellings and keep longer names intact", () => {
  const names = new Map([
    ["yohaba", "Yhwach"],
    ["mbappe", "Mbappé"],
    ["ren", "Renji"],
  ]);
  assert.equal(applyCanonicalNames("Yohaba raises his sword", names), "Yhwach raises his sword");
  assert.equal(applyCanonicalNames("Mbappe scores", names), "Mbappé scores");
  assert.equal(applyCanonicalNames("Renji blocks Aizen", names), "Renji blocks Aizen");
  assert.equal(applyCanonicalNames("Ren swings", names), "Renji swings");
  assert.equal(applyCanonicalNames("Get back Get back", names), "Get back Get back");
});

test("context hints trim, cap at 80 characters, and reject oversized protocol values", () => {
  assert.equal(normalizeContextHint("  Bleach  "), "Bleach");
  assert.equal(normalizeContextHint("x".repeat(90)).length, 80);
  assert.equal(normalizeContextHint("   "), "");
  assert.equal(readOptionalContextHint(undefined), undefined);
  assert.equal(readOptionalContextHint("  "), undefined);
  assert.equal(readOptionalContextHint("Premier League"), "Premier League");
  assert.equal(readOptionalContextHint("y".repeat(201)), false);
  assert.equal(readOptionalContextHint(12), false);
});

test("inferred names must appear in recent captions", () => {
  const parsed = parseCaptionContextResponse({
    title: "Bleach",
    names: [
      { heard: "Yohaba", canonical: "Yhwach" },
      { heard: "Ichigo", canonical: "Kurosaki Ichigo" },
    ],
  }, ["Yohaba appears before the throne"]);
  assert.equal(parsed.title, "Bleach");
  assert.deepEqual(parsed.names, [{ heard: "Yohaba", canonical: "Yhwach" }]);
});

test("session context applies names after the first long final without rewriting it", async () => {
  const ctx = new SessionCaptionContext("", async () => ({
    title: "Bleach",
    names: [{ heard: "Yohaba", canonical: "Yhwach" }],
  }), "en");
  const first = "Yohaba appears before the throne";
  assert.equal(ctx.apply(first), first);
  ctx.noteFinal(first);
  await ctx.flush();
  assert.equal(ctx.apply("Yohaba raises his sword"), "Yhwach raises his sword");
});

test("Gemini caption-context inferrer reads JSON names from generateContent", async () => {
  const infer = createGeminiCaptionContextInferrer("test-key", async (url, init) => {
    assert.match(String(url), /gemini-2.5-flash:generateContent/);
    const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
    assert.match(body.contents[0]!.parts[0]!.text, /Yohaba appears/);
    assert.match(body.contents[0]!.parts[0]!.text, /Bleach/);
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify({ title: "Bleach", names: [{ heard: "Yohaba", canonical: "Yhwach" }] }) }],
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const result = await infer({
    hint: "Bleach",
    title: "Bleach",
    lines: ["Yohaba appears before the throne"],
    knownNames: [],
    targetLanguage: "en",
  });
  assert.deepEqual(result, {
    title: "Bleach",
    names: [{ heard: "Yohaba", canonical: "Yhwach" }],
  });
});
