import assert from "node:assert/strict";
import test from "node:test";
import { migrateDb } from "../src/migrate.js";
import { getHistoryPolicy, setHistoryPolicy, pruneHistory } from "../src/privacy.js";
import { createCaptionSession, saveCaptionSegment, stopCaptionSession, listCaptionSessions, getCaptionSession } from "../src/captions.js";

test("privacy policy persists, validates retention, and prunes only finished expired sessions", async () => {
  const db = await migrateDb(":memory:");
  assert.deepEqual(await getHistoryPolicy(db), { saveHistory: true, retentionDays: 0 });
  await assert.rejects(() => setHistoryPolicy(db, { saveHistory: true, retentionDays: -1 }));
  await setHistoryPolicy(db, { saveHistory: false, retentionDays: 7 });
  assert.deepEqual(await getHistoryPolicy(db), { saveHistory: false, retentionDays: 7 });
  const complete = await createCaptionSession(db, { sourceLanguage: "en", targetLanguage: "en", provider: "mock" });
  await saveCaptionSegment(db, { sessionId: complete, sequence: 0, sourceText: "expired", translatedText: "expired", startMs: 0, endMs: 100 });
  await stopCaptionSession(db, complete);
  const live = await createCaptionSession(db, { sourceLanguage: "en", targetLanguage: "en", provider: "mock" });
  await pruneHistory(db, 7, Date.now() + 8 * 86_400_000);
  assert.equal((await listCaptionSessions(db)).length, 0);
  assert.equal(await getCaptionSession(db, complete), null);
  assert.notEqual(await getCaptionSession(db, live), null);
});
