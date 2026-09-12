import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CaptionPanel } from "../../../apps/desktop/src/overlay/CaptionPanel.js";
import { captionTimingSample, summarizeTiming } from "../../../apps/desktop/src/lib/timing.js";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { getConnectionStatus } from "../../../apps/desktop/src/lib/tauri.js";

test("desktop readiness checks authenticated HTTP health, not just a running process", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  mockIPC((command) => command === "gateway_connection"
    ? { origin: "http://127.0.0.1:34567", token: "test-connection-token" }
    : { capture: { state: "idle", backend: "test", sampleRate: 16000, channels: 1 }, lastProvider: null, audioPermission: "required" });
  try {
    for (const status of [200, 503]) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "http://127.0.0.1:34567/health");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-connection-token");
        return new Response(null, { status });
      };
      const readiness = await getConnectionStatus();
      assert.equal(readiness.gatewayReachable, status === 200);
      assert.equal(readiness.capture.state, "idle");
    }
  } finally {
    clearMocks(); globalThis.fetch = priorFetch;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("desktop timing separates native pipeline lag from presentation scheduling and excludes unknown clocks", () => {
  const timing = { nativeReceivedAtMs: 10_000, audioLagMs: 1200 };
  assert.deepEqual(captionTimingSample("sarvam", true, timing, 10_024), { provider: "sarvam", final: true, pipelineMs: 1200, desktopMs: 24, estimatedDisplayLagMs: 1224 });
  assert.equal(captionTimingSample("sarvam", false, undefined, 10_024), null);
  assert.equal(captionTimingSample("sarvam", false, timing, 9999), null);
  const sample = captionTimingSample("sarvam", true, timing, 10_024)!;
  assert.deepEqual(summarizeTiming([sample], "desktopMs"), { count: 1, p50: 24, p95: 24 });
  assert.deepEqual(summarizeTiming([], "desktopMs"), { count: 0, p50: null, p95: null });
});

test("Auto transcription follows the text script without declaring an unknown language as English", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(CaptionPanel, {
    lines: [{ utteranceId: "auto", translatedText: text, isActive: true }], targetLanguage: "auto", error: null, statusNotice: null, placeholder: "",
  }));
  assert.match(render("یہ ایک جملہ ہے"), /dir="auto"/);
  assert.match(render("یہ ایک جملہ ہے"), /data-script="rtl"/);
  assert.doesNotMatch(render("یہ ایک جملہ ہے"), /lang="en"/);
  assert.match(render("یہ ایک جملہ ہے"), /lang=""/, "unknown speech must override the document's English language");
  assert.match(render("ನಮಸ್ಕಾರ"), /data-script="indic"/);
  assert.match(render("こんにちは"), /data-script="cjk"/);
});
import { DEFAULT_PREFS, normalizePrefs, rememberPair, translationModePatch } from "../../../apps/desktop/src/lib/prefs.js";
import { speechProviderLabel } from "../../../apps/desktop/src/lib/speech-labels.js";

test("language modes restore the last pair, preserve Auto→English, and bound recents", () => {
  const translating = normalizePrefs({ ...DEFAULT_PREFS, sourceLanguage: "kn", targetLanguage: "en" });
  const transcription = normalizePrefs({ ...translating, ...translationModePatch(translating) });
  assert.equal(transcription.translateEnabled, false);
  const restored = normalizePrefs({ ...transcription, ...translationModePatch(transcription) });
  assert.equal(restored.sourceLanguage, "kn");
  assert.equal(restored.targetLanguage, "en");
  const auto = normalizePrefs({ ...transcription, targetLanguage: "auto" });
  assert.deepEqual(translationModePatch(auto), { translateEnabled: true, sourceLanguage: "auto", targetLanguage: "en" });
  const recent = rememberPair(normalizePrefs({ ...translating, recentPairs: [
    { source: "es", target: "en" }, { source: "kn", target: "en" },
    { source: "fr", target: "en" }, { source: "ja", target: "en" },
    { source: "de", target: "en" }, { source: "hi", target: "en" },
  ] }));
  assert.equal(recent.length, 5);
  assert.deepEqual(recent[0], { source: "kn", target: "en" });
  assert.equal(recent.filter((pair) => pair.source === "kn").length, 1);
  const malformed = normalizePrefs({ recentPairs: [null, { source: "en", target: "auto" }, { source: "invalid", target: "en" }], lastTranslationPair: {} });
  assert.deepEqual(malformed.recentPairs, []);
  assert.deepEqual(malformed.lastTranslationPair, { source: "auto", target: "en" });
});

test("settled speaker turns tint the existing left bar without names", () => {
  const html = renderToStaticMarkup(createElement(CaptionPanel, {
    lines: [
      { utteranceId: "s1", translatedText: "First speaker.", isActive: false, speakerTint: 2 },
      { utteranceId: "s2", translatedText: "Live caption.", isActive: true },
    ],
    targetLanguage: "en",
    error: null,
    statusNotice: null,
    placeholder: "Listening…",
  }));
  assert.match(html, /data-speaker="2"/);
  assert.match(html, /class="caption-text caption-turn live"/);
  assert.doesNotMatch(html, /data-speaker="2"[^>]*>Live caption/);
  assert.doesNotMatch(html, />S1<|>Speaker /);
});

test("caption failures preserve readable turns and drafts do not flood live announcements", () => {
  const html = renderToStaticMarkup(createElement(CaptionPanel, {
    lines: [{ utteranceId: "turn-1", translatedText: "Keep this readable caption.", isActive: true }],
    targetLanguage: "ar",
    error: "Connection interrupted",
    statusNotice: null,
    statusLabel: "Reconnecting…",
    placeholder: "Listening…",
    announcement: "Last finalized caption.",
    onOpenSettings: () => {},
  }));
  assert.match(html, /Keep this readable caption\./);
  assert.match(html, /class="caption-notice" role="status"/);
  assert.match(html, /Connection interrupted/);
  assert.match(html, /Open Settings/);
  assert.match(html, /class="caption-lines" aria-live="off"/);
  assert.match(html, /aria-live="polite" aria-atomic="true">Last finalized caption\./);
  assert.match(html, /lang="ar" dir="rtl"/);
  assert.doesNotMatch(html, /class="caption-error"/);
});

test("speech provider ids render as human-readable labels", () => {
  assert.equal(speechProviderLabel("sarvam"), "Sarvam recognition");
  assert.equal(speechProviderLabel("gemini-transcribe"), "Gemini Transcribe Live");
  assert.equal(speechProviderLabel("openai-transcribe"), "OpenAI GPT Live Transcribe");
  assert.equal(speechProviderLabel(null), null);
});
