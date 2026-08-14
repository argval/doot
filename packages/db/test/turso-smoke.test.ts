import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { migrateDb } from "../src/migrate.js";
import { captionSegments, sessions } from "../src/schema.js";

test("Turso migrates, inserts a session, and reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doot-turso-"));
  const db = await migrateDb(join(dir, "doot.db"));

  const [session] = await db.insert(sessions).values({
    sourceLanguage: "en",
    targetLanguage: "hi",
    provider: "mock",
  }).returning();

  assert.ok(session?.id);
  assert.equal(session.sourceLanguage, "en");
  assert.ok(session.startedAt instanceof Date);

  await db.insert(captionSegments).values({
    sessionId: session.id,
    sequence: 0,
    sourceText: "hello",
    translatedText: "नमस्ते",
    startMs: 0,
    endMs: 900,
  });

  const rows = await db.select().from(captionSegments).where(
    eq(captionSegments.sessionId, session.id),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.translatedText, "नमस्ते");
  assert.equal(rows[0]?.sequence, 0);
});
