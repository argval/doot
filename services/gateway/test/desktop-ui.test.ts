import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
import { DEFAULT_PREFS, hoverBoostFor, normalizePrefs, overlayDimmingAlpha, overlayVibrancyAlpha, OVERLAY_IDLE_OPACITY_MAX, rememberPair, translationModePatch } from "../../../apps/desktop/src/lib/prefs.js";
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
  assert.equal(normalizePrefs({ contextHint: "  Bleach" }).contextHint, "  Bleach");
  assert.equal(normalizePrefs({ contextHint: "x".repeat(90) }).contextHint.length, 80);
  assert.equal(DEFAULT_PREFS.contextHint, "");
});

test("idle opacity stays continuous while hover lands at a controlled final opacity", () => {
  assert.equal(OVERLAY_IDLE_OPACITY_MAX, 1);
  assert.equal(overlayDimmingAlpha(0), 0, "full transparency must clear the fill, not floor at frosted glass");
  assert.equal(overlayDimmingAlpha(1), 1, "the opaque end must be solid charcoal");
  assert.equal(overlayVibrancyAlpha(0), 0, "HUD frost must turn off at full transparency");
  assert.equal(overlayVibrancyAlpha(1), 0, "opaque fill must not keep a frost layer");
  assert.ok(overlayVibrancyAlpha(0.42) > 0.9, "the default idle look stays glass");
  assert.ok(overlayDimmingAlpha(0, true) > 0);
  assert.equal(overlayDimmingAlpha(1, true), 1);
  for (const idleOpacity of [0, 0.18, 0.42, 0.7, 1]) {
    const idleFill = overlayDimmingAlpha(idleOpacity);
    const hoverFill = overlayDimmingAlpha(idleOpacity, true);
    assert.ok(hoverFill >= idleFill);
    assert.ok(hoverFill <= 1);
    const stacked = 1 - (1 - idleFill) * (1 - hoverBoostFor(idleOpacity));
    assert.ok(Math.abs(stacked - hoverFill) < 1e-9);
  }
  assert.ok(overlayDimmingAlpha(0) < overlayDimmingAlpha(0.7));
  assert.equal(normalizePrefs({ overlayIdleOpacity: 0 }).overlayIdleOpacity, 0);
  assert.equal(normalizePrefs({ overlayIdleOpacity: 1 }).overlayIdleOpacity, 1);
});

test("new caption turns fade in from above instead of sliding into the clipped bottom edge", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const css = readFileSync(join(root, "apps/desktop/src/styles.css"), "utf8");
  const overlay = readFileSync(join(root, "apps/desktop/src-tauri/native/DootOverlay.swift"), "utf8");
  assert.match(css, /@keyframes caption-turn-in \{[\s\S]*translateY\(-6px\)/);
  assert.doesNotMatch(css, /caption-turn-in \{[\s\S]*translateY\(6px\)/);
  assert.match(overlay, /offset\(y: -8\)/);
  assert.doesNotMatch(overlay, /offset\(y: 6\)/);
});

test("native overlay glass does not use CSS backdrop-filter; previews still do", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../apps/desktop/src/styles.css"), "utf8");
  const nativeRule = css.match(/^\.caption-window \{[\s\S]*?^\}/m);
  assert.ok(nativeRule);
  assert.doesNotMatch(nativeRule[0], /backdrop-filter/);
  assert.match(css, /html\.web-preview \.caption-window,\s*\.settings-overlay-preview \.caption-window \{[\s\S]*backdrop-filter: blur\(calc\(28px \* var\(--overlay-vibrancy-alpha/);
});

test("Setup and Connection request Screen Recording instead of only opening Preferences", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const commands = readFileSync(join(root, "apps/desktop/src-tauri/src/commands.rs"), "utf8");
  const setup = readFileSync(join(root, "apps/desktop/src/settings/SetupSection.tsx"), "utf8");
  const settings = readFileSync(join(root, "apps/desktop/src/settings/SettingsApp.tsx"), "utf8");
  const tauri = readFileSync(join(root, "apps/desktop/src/lib/tauri.ts"), "utf8");
  assert.match(commands, /CGRequestScreenCaptureAccess\(\)/);
  assert.match(commands, /fn request_screen_recording/);
  assert.doesNotMatch(commands, /com\.apple\.preference\.security\?Privacy_ScreenCapture/);
  assert.match(tauri, /invoke\("request_screen_recording"\)/);
  assert.match(setup, /requestScreenRecording/);
  assert.match(setup, /openAudioSettings/);
  assert.match(settings, /requestScreenRecording/);
  assert.match(settings, /openAudioSettings/);
});

test("overlay window is a nonactivating HUD NSPanel on macOS and WS_EX_NOACTIVATE on Windows", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const chrome = readFileSync(join(root, "apps/desktop/src-tauri/src/overlay_chrome.rs"), "utf8");
  const lib = readFileSync(join(root, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
  const overlayShow = lib.match(/fn show_overlay\([\s\S]*?\n\}/);
  assert.ok(overlayShow);
  assert.match(chrome, /DootHudPanel/);
  assert.match(chrome, /NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL/);
  assert.match(chrome, /_setPreventsActivation/);
  assert.doesNotMatch(chrome, /AnyObject::set_class/);
  assert.match(chrome, /orderFrontRegardless/);
  assert.match(chrome, /WS_EX_NOACTIVATE/);
  assert.match(chrome, /SW_SHOWNOACTIVATE/);
  assert.doesNotMatch(chrome, /Effect::HudWindow/);
  const overlay = readFileSync(join(root, "apps/desktop/src-tauri/native/DootOverlay.swift"), "utf8");
  assert.match(overlay, /NSVisualEffectView/);
  assert.match(overlay, /blendingMode = \.behindWindow/);
  assert.match(overlay, /state = \.active/);
  assert.match(overlay, /underPageBackgroundColor/);
  assert.match(overlay, /overlayDimmingAlpha/);
  assert.match(overlay, /overlayVibrancyAlpha/);
  assert.match(overlay, /material\.alphaValue/);
  assert.doesNotMatch(overlay, /material\.addSubview\(hosting\)/);
  assert.doesNotMatch(overlay, /0\.08 \+ idle \* 0\.82/);
  assert.match(overlay, /previewAppearance/);
  assert.match(overlay, /applyPreviewToSnapshot/);
  assert.match(overlay, /applyGlassAppearance\(\)/);
  assert.match(overlay, /overlayFill\.opacity\(dimming\)/);
  assert.doesNotMatch(overlay, /offset\(y: 6\)/);
  assert.doesNotMatch(overlay, /LazyVStack/);
  assert.match(overlay, /disablesAnimations/);
  assert.match(overlay, /offset\(y: -8\)/);
  assert.doesNotMatch(overlay, /effectIsInteractive/);
  assert.doesNotMatch(overlay, /ultraThinMaterial/);
  assert.doesNotMatch(overlay, /value: fill/);
  assert.doesNotMatch(overlay, /overlayFill\.opacity\(fill\)/);
  const conf = readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8");
  assert.match(conf, /"maxWidth": 960/);
  assert.match(conf, /"maxHeight": 420/);
  assert.match(chrome, /overlay_logical_size/);
  assert.match(lib, /show_overlay_without_activating/);
  assert.match(lib, /skip_initial_state\("main"\)/);
  assert.match(lib, /restore_state\(StateFlags::POSITION \| StateFlags::SIZE\)/);
  assert.match(lib, /WindowEvent::Resized/);
  assert.match(lib, /native_ui::attach_overlay/);
  const nativeUi = readFileSync(join(root, "apps/desktop/src/lib/native-ui.ts"), "utf8");
  assert.match(nativeUi, /userAgent/);
  assert.match(nativeUi, /isMacHost/);
  const picker = readFileSync(join(root, "apps/desktop/src-tauri/native/DootNative.swift"), "utf8");
  assert.match(picker, /LanguageMenuRow/);
  assert.match(picker, /preferredEdge: \.maxY/);
  assert.match(picker, /dootSettingsWillHide/);
  assert.match(picker, /in: 0\.\.\.100/);
  assert.doesNotMatch(picker, /in: 30\.\.\.100/);
  assert.doesNotMatch(picker, /listStyle\(\.plain\)/);
  assert.doesNotMatch(picker, /frame\(width: 245, height: 300\)/);
  assert.doesNotMatch(overlayShow[0], /set_focus/);
});

test("menu bar and tray actions are not dismissed by overlay show-on-click", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const lib = readFileSync(join(root, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
  const chrome = readFileSync(join(root, "apps/desktop/src-tauri/src/overlay_chrome.rs"), "utf8");
  const appMenu = lib.match(/\.menu\(\|app\| \{[\s\S]*?\.on_menu_event/);
  assert.ok(appMenu);
  assert.match(appMenu[0], /MenuItemBuilder::with_id\("toggle-capture", "Start Capturing"\)/);
  assert.match(appMenu[0], /\.item\(&capture_item\)/);
  assert.match(lib, /show_menu_on_left_click\(true\)/);
  assert.doesNotMatch(lib, /TrayIconEvent::Click[\s\S]*show_overlay\(tray\.app_handle\(\)\)/);
  assert.match(lib, /hide_overlay_without_activating/);
  assert.match(chrome, /orderOut/);
  const menuHandlers = lib.match(/on_menu_event\(\|app, event\| handle_menu_event/g) ?? [];
  assert.equal(
    menuHandlers.length,
    1,
    "Tauri delivers every menu click to every global handler; a second tray handler would hide then immediately show the overlay",
  );
  const trayMenu = lib.match(/TrayIconBuilder::with_id\("doot"\)[\s\S]*?tray\.build\(app\)\?/);
  assert.ok(trayMenu);
  assert.doesNotMatch(trayMenu[0], /on_menu_event/);
  const toggle = lib.match(/fn toggle_overlay\([\s\S]*?\n\}/);
  assert.ok(toggle);
  assert.match(toggle[0], /overlay_hidden/);
  assert.doesNotMatch(toggle[0], /is_visible/);
  const nativeUi = readFileSync(join(root, "apps/desktop/src-tauri/src/native_ui.rs"), "utf8");
  assert.match(nativeUi, /CaptureMenuItems/);
  assert.match(nativeUi, /for item in items\.iter\(\)/);
});

test("Settings About shows version in the Settings window instead of a separate About panel", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const native = readFileSync(join(root, "apps/desktop/src-tauri/native/DootNative.swift"), "utf8");
  assert.match(native, /about = "About"/);
  assert.match(native, /struct AboutView/);
  assert.match(native, /model\.appVersion/);
  assert.match(native, /navigate\(\.about\)/);
  assert.doesNotMatch(native, /orderFrontStandardAboutPanel/);
  const lib = readFileSync(join(root, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
  assert.match(lib, /MenuItemBuilder::with_id\("open-about", "About Doot"\)/);
  assert.doesNotMatch(lib, /\.about\(None\)/);
  assert.match(lib, /"open-about" =>/);
  const settings = readFileSync(join(root, "apps/desktop/src/settings/SettingsApp.tsx"), "utf8");
  assert.match(settings, /settings:\/\/section/);
  const bridge = readFileSync(join(root, "apps/desktop/src/lib/native-settings.ts"), "utf8");
  assert.match(bridge, /getVersion\(\)/);
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
