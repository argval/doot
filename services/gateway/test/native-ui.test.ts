import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { nativePreferencePatch, handleNativeSettingsRequest, formatNativeTimings } from "../../../apps/desktop/src/lib/native-settings.js";
import { DEFAULT_PREFS, updatePrefs } from "../../../apps/desktop/src/lib/prefs.js";
import { confirmDestructive } from "../../../apps/desktop/src/lib/native-ui.js";
import { liveOverlaySnapshot, overlayCaptureAction, overlayRecentPair, registerOverlayCapture, settingsOverlayPreview } from "../../../apps/desktop/src/lib/overlay-bridge.js";

test("native UI validates mutations, preserves cancellation, and reuses translated-only history exports", async () => {
  assert.deepEqual(nativePreferencePatch({ captionFontSize: 24, overlayIdleOpacity: 0, contextHint: "日本語", onboardingComplete: true }), { captionFontSize: 24, overlayIdleOpacity: 0, contextHint: "日本語", onboardingComplete: true });
  assert.deepEqual(nativePreferencePatch({ captionFontSize: 28.0000001 }), { captionFontSize: 28 });
  assert.deepEqual(nativePreferencePatch({ captionFontSize: 28.5 }), { captionFontSize: 29 });
  assert.deepEqual(nativePreferencePatch({ overlayIdleOpacity: 1.0000000001 }), { overlayIdleOpacity: 1 });
  assert.deepEqual(nativePreferencePatch({ overlayIdleOpacity: 0.8 }), { overlayIdleOpacity: 0.8 });
  for (const patch of [{ captionFontSize: 0 }, { overlayIdleOpacity: NaN }, { overlayIdleOpacity: 1.2 }, { contextHint: "x".repeat(81) }, { onboardingComplete: "true" }, { targetLanguage: "auto" }]) {
    assert.throws(() => nativePreferencePatch(patch));
  }
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  let captureState = "capturing";
  const writes: string[] = [];
  let stored = { ...DEFAULT_PREFS };
  mockIPC((command, payload) => {
    if (command === "caption_session_active") return captureState !== "idle";
    if (command === "plugin:store|load") return 1;
    if (command === "plugin:store|get") return [stored, true];
    if (command === "gateway_connection") return { origin: "http://127.0.0.1:34567", token: "fixture-token" };
    if (command === "confirm_destructive") return false;
    if (command === "plugin:store|set") { stored = (payload as { value: typeof stored }).value; return; }
    if (command === "plugin:store|save" || command === "plugin:event|emit") return;
    writes.push(command);
    throw new Error(`Unexpected native command: ${command}`);
  });
  try {
    assert.equal(await confirmDestructive("Delete?", "Permanent", "Delete"), false);
    await assert.rejects(handleNativeSettingsRequest("capture", {}), /Overlay is not ready/);
    await assert.rejects(handleNativeSettingsRequest("recent", { source: "en", target: "kn" }), /Stop capture/);
    await assert.rejects(handleNativeSettingsRequest("moveOverlay", { direction: "sideways" }), /Invalid overlay move/);
    captureState = "idle";
    await assert.rejects(handleNativeSettingsRequest("language", { key: "targetLanguage", value: "auto" }), /cannot be Auto/);
    await assert.rejects(handleNativeSettingsRequest("key", { provider: "unknown", key: "secret" }), /Unknown provider/);
    await assert.rejects(handleNativeSettingsRequest("savePolicy", { saveHistory: true, retentionDays: 1 }), /Invalid retention/);
    await assert.rejects(handleNativeSettingsRequest("export", { id: "test", format: "exe" }), /Invalid export/);
    await assert.rejects(handleNativeSettingsRequest("arbitraryCommand", {}), /Unknown native action/);
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:34567/v1/history/sessions/a%2Fb");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
      return Response.json({ id: "a/b", startedAtMs: 1000, sourceLanguage: "en", targetLanguage: "kn", segments: [{ id: "1", sequence: 1, sourceText: "Source stays out of the text export", translatedText: "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ", startMs: 0, endMs: 1000 }] });
    };
    const result = await handleNativeSettingsRequest("export", { id: "a/b", format: "txt" }) as { body: string; filename: string };
    assert.equal(result.body, "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ\n");
    assert.match(result.filename, /en-kn\.txt$/);
    assert.deepEqual(writes, [], "invalid actions and cancelled confirmations must not write");
    await Promise.all([updatePrefs({ contextHint: "A match" }), updatePrefs({ captionFontSize: 32 })]);
    assert.equal(stored.contextHint, "A match", "concurrent native settings and overlay writes must merge");
    assert.equal(stored.captionFontSize, 32);
  } finally {
    clearMocks(); globalThis.fetch = priorFetch;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("native diagnostics report failures without including them in successful latency percentiles", () => {
  const result = formatNativeTimings([], [
    { speechProvider: "sarvam", translationProvider: "gemini", sourceLanguage: "en", targetLanguage: "kn", urgency: "final", outcome: "success", queueMs: 0, requestMs: 100, sourceToCompleteMs: 120, completionToCaptionMs: 2 },
    { speechProvider: "sarvam", translationProvider: "gemini", sourceLanguage: "en", targetLanguage: "kn", urgency: "final", outcome: "timeout", queueMs: 20, requestMs: 1900, sourceToCompleteMs: 2000, completionToCaptionMs: null },
  ]);
  assert.match(result.text, /1 succeeded · 0 reused · 1 timed out/);
  assert.match(result.text, /requestMs: successful p50 100 \/ p95 100 ms/);
  assert.equal(JSON.parse(result.json).translations.length, 2);
  assert.doesNotMatch(result.json, /sessionId|utteranceId|sourceText/);
});

test("native overlay snapshots stay bounded and reject incomplete language pairs", () => {
  const snapshot = liveOverlaySnapshot({
    lines: [{ utteranceId: "x".repeat(200), translatedText: "ಕ".repeat(5000), isActive: true }],
    prefs: { ...DEFAULT_PREFS, targetLanguage: "kn" },
    capturing: false,
    transitioning: false,
    error: "e".repeat(800),
    notice: "",
    status: "Starting…",
    placeholder: "Listening",
    announcement: "",
    audioLevel: 4,
    listening: true,
    clickThrough: false,
    captureHint: "Start",
  });
  assert.equal(snapshot.lines[0]?.id.length, 128);
  assert.equal(snapshot.lines[0]?.text.length, 4000);
  assert.equal(snapshot.error.length, 500);
  assert.equal(snapshot.audioLevel, 1);
  assert.equal(snapshot.script, "indic");
  assert.equal(settingsOverlayPreview(DEFAULT_PREFS).lines.length, 2);
  assert.throws(() => overlayRecentPair({ source: "en", target: "auto" }));
});

test("native overlay capture is a no-write until the live overlay registers", async () => {
  await assert.rejects(async () => { overlayCaptureAction(); }, /Overlay is not ready/);
  let captured = false;
  registerOverlayCapture(async () => { captured = true; });
  try {
    await overlayCaptureAction()();
    assert.equal(captured, true);
  } finally {
    registerOverlayCapture(null);
  }
});
