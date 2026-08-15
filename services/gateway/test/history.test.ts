import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCaptionSession,
  saveCaptionSegment,
  stopCaptionSession,
} from "@doot/db/captions";
import { migrateDb } from "@doot/db/migrate";
import {
  formatHistoryExport,
  type HistorySessionDetail,
  type HistorySessionListResponse,
} from "@doot/protocol";
import { languageCodesMatching } from "../src/history.js";
import { buildServer } from "../src/server.js";
import { ProviderRouter } from "../src/speech/router.js";
import { MockProvider } from "../src/speech/mock/provider.js";
import { TranslationRouter } from "../src/translation/router.js";

test("history routes list, search, export, and delete finalized sessions", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "doot-history-http-"));
  const db = await migrateDb(join(dir, "doot.db"));
  const sessionId = await createCaptionSession(db, {
    sourceLanguage: "kn",
    targetLanguage: "en",
    provider: "sarvam",
  });
  await saveCaptionSegment(db, {
    sessionId,
    sequence: 0,
    sourceText: "ನಮಸ್ಕಾರ",
    translatedText: "Hello from Kannada",
    startMs: 40,
    endMs: 1_240,
  });
  await stopCaptionSession(db, sessionId);

  const app = await buildServer(
    new ProviderRouter([new MockProvider()]),
    new TranslationRouter([]),
    { db },
  );
  context.after(() => app.close());

  const listed = await app.inject({
    method: "GET",
    url: "/v1/history/sessions",
    headers: { origin: "http://localhost:1420" },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers["access-control-allow-origin"], "http://localhost:1420");
  const preflight = await app.inject({
    method: "OPTIONS",
    url: `/v1/history/sessions/${sessionId}`,
    headers: {
      origin: "http://localhost:1420",
      "access-control-request-method": "DELETE",
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "http://localhost:1420");
  const listBody = listed.json() as HistorySessionListResponse;
  assert.equal(listBody.sessions.length, 1);
  assert.equal(listBody.sessions[0]?.id, sessionId);
  assert.equal(listBody.sessions[0]?.preview, "Hello from Kannada");

  const searched = await app.inject({
    method: "GET",
    url: "/v1/history/sessions?q=Kannada",
  });
  assert.equal(searched.json<HistorySessionListResponse>().sessions.length, 1);

  const languageSearch = await app.inject({
    method: "GET",
    url: "/v1/history/sessions?q=kannada",
  });
  assert.equal(languageSearch.json<HistorySessionListResponse>().sessions.length, 1);

  const detail = await app.inject({ method: "GET", url: `/v1/history/sessions/${sessionId}` });
  assert.equal(detail.statusCode, 200);
  const session = detail.json() as HistorySessionDetail;
  assert.equal(session.segments[0]?.translatedText, "Hello from Kannada");

  const srt = await app.inject({
    method: "GET",
    url: `/v1/history/sessions/${sessionId}/export?format=srt`,
  });
  assert.equal(srt.statusCode, 200);
  assert.match(String(srt.headers["content-type"]), /subrip|plain/);
  assert.match(srt.body, /00:00:00,040 --> 00:00:01,240/);
  assert.match(srt.body, /Hello from Kannada/);
  assert.equal(srt.body, formatHistoryExport(session, "srt"));

  const missing = await app.inject({ method: "GET", url: "/v1/history/sessions/missing" });
  assert.equal(missing.statusCode, 404);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/v1/history/sessions/${sessionId}`,
  });
  assert.equal(deleted.statusCode, 204);
  const empty = await app.inject({ method: "GET", url: "/v1/history/sessions" });
  assert.equal(empty.json<HistorySessionListResponse>().sessions.length, 0);
});

test("history routes return 503 when no database is configured", async (context) => {
  const app = await buildServer(
    new ProviderRouter([new MockProvider()]),
    new TranslationRouter([]),
  );
  context.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/v1/history/sessions" });
  assert.equal(response.statusCode, 503);
});

test("matches language labels without short false positives", () => {
  assert.ok(languageCodesMatching("kannada").includes("kn"));
  assert.ok(languageCodesMatching("en").includes("en"));
  assert.equal(languageCodesMatching("in").includes("hi"), false);
});
