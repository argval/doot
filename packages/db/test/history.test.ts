import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCaptionSession,
  deleteCaptionSession,
  getCaptionSession,
  listCaptionSessions,
  saveCaptionSegment,
  stopCaptionSession,
} from "../src/captions.js";
import { migrateDb } from "../src/migrate.js";

test("lists, searches, and deletes finalized caption sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doot-history-"));
  const db = await migrateDb(join(dir, "doot.db"));

  const liveId = await createCaptionSession(db, {
    sourceLanguage: "en",
    targetLanguage: "hi",
    provider: "sarvam",
  });
  await saveCaptionSegment(db, {
    sessionId: liveId,
    sequence: 0,
    sourceText: "still going",
    translatedText: "अभी चल रहा है",
    startMs: 0,
    endMs: 800,
  });

  const hindiId = await createCaptionSession(db, {
    sourceLanguage: "en",
    targetLanguage: "hi",
    provider: "sarvam",
  });
  await saveCaptionSegment(db, {
    sessionId: hindiId,
    sequence: 0,
    sourceText: "hello there",
    translatedText: "नमस्ते",
    startMs: 100,
    endMs: 900,
  });
  await saveCaptionSegment(db, {
    sessionId: hindiId,
    sequence: 1,
    sourceText: "later turn",
    translatedText: "बाद में",
    startMs: 1_200,
    endMs: 1_800,
  });
  await stopCaptionSession(db, hindiId);

  const spanishId = await createCaptionSession(db, {
    sourceLanguage: "es",
    targetLanguage: "en",
    provider: "gemini",
  });
  await saveCaptionSegment(db, {
    sessionId: spanishId,
    sequence: 0,
    sourceText: "hola",
    translatedText: "hello from spanish",
    startMs: 0,
    endMs: 500,
  });
  await stopCaptionSession(db, spanishId);

  const listed = await listCaptionSessions(db);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.id, spanishId);
  assert.equal(listed[0]?.segmentCount, 1);
  assert.equal(listed[1]?.id, hindiId);
  assert.equal(listed[1]?.preview, "नमस्ते");
  assert.equal(listed[1]?.segmentCount, 2);

  const textHits = await listCaptionSessions(db, { query: "नमस्ते" });
  assert.deepEqual(textHits.map((session) => session.id), [hindiId]);

  const languageHits = await listCaptionSessions(db, {
    query: "es",
    languageCodes: ["es"],
  });
  assert.deepEqual(languageHits.map((session) => session.id), [spanishId]);

  const wildcard = await listCaptionSessions(db, { query: "%" });
  assert.equal(wildcard.length, 0);

  const loaded = await getCaptionSession(db, hindiId);
  assert.equal(loaded?.segments.length, 2);
  assert.equal(loaded?.segments[1]?.translatedText, "बाद में");

  assert.equal(await deleteCaptionSession(db, hindiId), true);
  assert.equal(await getCaptionSession(db, hindiId), null);
  assert.equal((await listCaptionSessions(db)).length, 1);
  assert.equal(await deleteCaptionSession(db, "missing"), false);
});
