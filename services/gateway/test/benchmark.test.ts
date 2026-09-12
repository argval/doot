import assert from "node:assert/strict";
import test from "node:test";
import type { CaptionEvent } from "@doot/protocol";
import { parseReference, summarizeCaptions } from "../scripts/benchmark-metrics.js";
import { runBenchmark } from "../scripts/benchmark-live.js";
import { buildServer } from "../src/server.js";
import { MockProvider } from "../src/speech/mock/provider.js";
import { ProviderRouter } from "../src/speech/router.js";
import { TranslationRouter } from "../src/translation/router.js";
import { parseCorpus, compareRuns } from "../scripts/benchmark-corpus.js";

test("corpus evaluation bounds paid runs and compares like-for-like metrics", () => {
  const entry = { id: "code-switch", audio: "clip.pcm", reference: "clip.json", source: "kn", target: "en", provider: "sarvam" };
  assert.equal(parseCorpus({ repeats: 3, cases: [entry] }).repeats, 3);
  assert.throws(() => parseCorpus({ repeats: 101, cases: [entry] }));
  assert.throws(() => parseCorpus({ repeats: 1, cases: [entry, entry] }));
  assert.throws(() => parseCorpus({ repeats: 1, cases: [{ ...entry, target: "auto" }] }));
  assert.deepEqual(compareRuns({ lagP95Ms: 1200, wordErrorRate: 0.1, boundaryF1: 0.8 }, { lagP95Ms: 1500, wordErrorRate: 0.2, boundaryF1: 0.7 }), { lagP95Ms: -300, wordErrorRate: -0.1, boundaryF1: 0.1 });
});

test("benchmark measures all turns, ignores stale revisions, and scores reference text and boundaries", () => {
  const first: CaptionEvent = {
    type: "caption", sessionId: "test", utteranceId: "first", sequence: 0, revision: 1,
    sourceText: "Hello", translatedText: "", startMs: 0, endMs: 1000, isFinal: false, provider: "mock",
  };
  const second: CaptionEvent = { ...first, utteranceId: "second", sequence: 1, sourceText: "world", startMs: 1200, endMs: 2000 };
  const report = summarizeCaptions([
    { caption: first, receivedAtMs: 1100 },
    { caption: { ...first, revision: 2, translatedText: "ನಮಸ್ಕಾರ" }, receivedAtMs: 1400 },
    { caption: second, receivedAtMs: 2100 },
    { caption: { ...second, revision: 2, translatedText: "ಜಗತ್ತು", isFinal: true }, receivedAtMs: 2200 },
    { caption: { ...first, revision: 3, translatedText: "ನಮಸ್ಕಾರ", isFinal: true }, receivedAtMs: 2300 },
    { caption: first, receivedAtMs: 2400 },
  ], parseReference({ sourceText: "Hello, world!", boundariesMs: [1000, 2000] }));
  assert.equal(report.finalTranslation, "ನಮಸ್ಕಾರ\nಜಗತ್ತು");
  assert.equal(report.finalizedTurns, 2);
  assert.equal(report.unfinishedTurns, 0);
  assert.deepEqual(report.sourceToFirstTranslationMs, { count: 2, p50: 100, p95: 300 });
  assert.deepEqual(report.estimatedFinalLagMs, { count: 2, p50: 200, p95: 1300 });
  assert.equal(report.referenceScores?.sourceWordErrorRate, 0);
  assert.equal(report.referenceScores?.sourceCharacterErrorRate, 0);
  assert.equal(report.referenceScores?.estimatedBoundaryScore.f1, 1);
  const mismatch = summarizeCaptions([{ caption: { ...first, sourceText: "hello moon", isFinal: true }, receivedAtMs: 1400 }],
    parseReference({ sourceText: "hello world", boundariesMs: [1000, 2000] }));
  assert.equal(mismatch.referenceScores?.sourceWordErrorRate, 0.5);
  assert.equal(mismatch.referenceScores?.estimatedBoundaryScore.recall, 0.5);
  assert.throws(() => parseReference({ sourceText: "text", boundariesMs: [2000, 1000] }));
  assert.throws(() => parseReference({ sourceText: "text", boundariesMs: [NaN] }));
  assert.throws(() => parseReference({ sourceText: "", boundariesMs: [] }));
});

test("benchmark streams paced PCM through the gateway and returns the whole session", async () => {
  const app = await buildServer(new ProviderRouter([new MockProvider()]), new TranslationRouter([]), { authToken: "benchmark-test-token" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const report = await runBenchmark({ audioPath: "in-memory.pcm", source: "en", target: "en", provider: "mock", authToken: "benchmark-test-token", gatewayUrl: address.replace("http", "ws") + "/v1/realtime" }, Buffer.alloc(96_000));
    assert.equal(report.finalizedTurns, 2);
    assert.equal(report.finalTranslation, "Received 1500 ms of system audio.\nReceived 1500 ms of system audio.");
    assert.equal(report.audioDurationMs, 3000);
    assert.equal(report.unfinishedTurns, 0);
    assert.deepEqual(report.providerErrors, []);
    assert.ok(report.firstTranslatedCaptionLatencyMs! >= 1400);
    assert.ok(report.finalCaptionLatencyMs! >= 2900);
  } finally {
    await app.close();
  }
});
