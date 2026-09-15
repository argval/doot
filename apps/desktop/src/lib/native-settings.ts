import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getName, getVersion } from "@tauri-apps/api/app";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { LANGUAGE_LABELS, formatHistoryExport, historyExportFilename, isHistoryExportFormat, isSupportedLanguage, isSupportedTargetLanguage } from "@doot/protocol";
import { loadPrefs, updatePrefs, subscribeToPrefs, translationModePatch, type DesktopPrefs } from "./prefs";
import { overlayCaptureAction, overlayRecentPair, settingsOverlayPreview } from "./overlay-bridge";
import { deleteHistorySession, fetchHistoryPolicy, fetchHistorySession, fetchHistorySessions, renameHistorySession, saveHistoryPolicy } from "./history";
import { getCaptionRoute, getConnectionStatus, openAudioSettings, requestScreenRecording, subscribeToSessionStatus } from "./tauri";
import { summarizeTiming, summarizeMilliseconds, type CaptionTimingSample, type TranslationTimingSample } from "./timing";
import { speechProviderLabel } from "./speech-labels";

type Args = Record<string, unknown>;
function string(args: Args, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${key}.`);
  return value;
}
function boolean(args: Args, key: string): boolean {
  if (typeof args[key] !== "boolean") throw new Error(`Invalid ${key}.`);
  return args[key];
}
function integer(args: Args, key: string, max: number): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${key}.`);
  return value;
}

export function nativePreferencePatch(args: Args): Partial<DesktopPrefs> {
  const patch: Partial<DesktopPrefs> = {};
  for (const [key, value] of Object.entries(args)) {
    switch (key) {
      case "captionFontSize": {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid text size.");
        const size = Math.round(value);
        if (size < 18 || size > 40) throw new Error("Invalid text size.");
        patch.captionFontSize = size; break;
      }
      case "overlayIdleOpacity": {
        if (typeof value !== "number" || !Number.isFinite(value) || value < -0.05 || value > 1.05) throw new Error("Invalid transparency.");
        patch.overlayIdleOpacity = Math.min(1, Math.max(0, value)); break;
      }
      case "contextHint": patch.contextHint = string(args, key, 80); break;
      case "onboardingComplete": patch.onboardingComplete = boolean(args, key); break;
      default: throw new Error("Unknown native preference.");
    }
  }
  return patch;
}

async function prefsResult(prefs: DesktopPrefs) {
  return { prefs, overlay: settingsOverlayPreview(prefs) };
}

export function formatNativeTimings(samples: CaptionTimingSample[], translations: TranslationTimingSample[]) {
  const lines: string[] = [];
  for (const final of [false, true]) {
    const group = samples.filter((sample) => sample.final === final);
    lines.push(`${final ? "Final" : "Draft"} revisions · ${group.length} samples`);
    for (const field of ["pipelineMs", "desktopMs", "estimatedDisplayLagMs"] as const) {
      const { p50, p95 } = summarizeTiming(group, field);
      lines.push(`${{ pipelineMs: "Audio interval → native caption", desktopMs: "Native caption → paint opportunity", estimatedDisplayLagMs: "Estimated audio → display" }[field]}: p50 ${p50 ?? "—"} / p95 ${p95 ?? "—"} ms`);
    }
    lines.push("");
  }
  const groups = new Map<string, TranslationTimingSample[]>();
  for (const sample of translations) {
    const key = `${sample.sourceLanguage} → ${sample.targetLanguage} · ${sample.speechProvider} → ${sample.translationProvider} · ${sample.urgency}`;
    const group = groups.get(key) ?? []; group.push(sample); groups.set(key, group);
  }
  lines.push("Text request time includes network round trip. Native Live Translate has no separate text request.");
  for (const [label, group] of groups) {
    lines.push("", label, `${group.length} attempts · ${group.filter((s) => s.outcome === "success").length} succeeded · ${group.filter((s) => s.outcome === "reused").length} reused · ${group.filter((s) => s.outcome === "timeout").length} timed out · ${group.filter((s) => s.outcome === "error" || s.outcome === "cancelled").length} failed/cancelled`);
    for (const field of ["queueMs", "requestMs", "sourceToCompleteMs", "completionToCaptionMs"] as const) {
      const { p50, p95 } = summarizeMilliseconds(group.filter((s) => s.outcome === "success").map((s) => s[field]));
      lines.push(`${field}: successful p50 ${p50 ?? "—"} / p95 ${p95 ?? "—"} ms`);
    }
  }
  return { text: lines.join("\n"), json: JSON.stringify({ version: 2, measurement: "paint-opportunity-estimate-and-text-request-timing", samples, translations }, null, 2) };
}

export async function handleNativeSettingsRequest(operation: string, args: Args): Promise<unknown> {
  switch (operation) {
    case "settings": {
      const [prefs, keyStatus, loginStatus, name, version, captureActive] = await Promise.all([
        loadPrefs(), invoke("credential_status").then((keys) => ({ keys, warning: "" }), () => ({ keys: {}, warning: "Allow Doot to access macOS Keychain to manage provider keys." })),
        isEnabled().then((enabled) => ({ enabled, warning: "" }), () => ({ enabled: false, warning: "Could not read the login item status." })),
        getName(), getVersion(), invoke<boolean>("caption_session_active"),
      ]);
      return { ...await prefsResult(prefs), keys: keyStatus.keys, openAtLogin: loginStatus.enabled, warning: [keyStatus.warning, loginStatus.warning].filter(Boolean).join(" "), name, version, labels: LANGUAGE_LABELS, captureActive };
    }
    case "prefs": return prefsResult(await updatePrefs(nativePreferencePatch(args)));
    case "login": {
      const enabled = boolean(args, "enabled");
      if (enabled) await enable(); else await disable();
      return { enabled: await isEnabled() };
    }
    case "key": {
      const provider = string(args, "provider", 32);
      if (!["sarvam", "gemini", "speechmatics", "openai"].includes(provider)) throw new Error("Unknown provider.");
      await invoke("save_service_key", { provider, key: string(args, "key", 4096) });
      return { keys: await invoke("credential_status") };
    }
    case "resetOverlay": await invoke("move_overlay", { direction: "reset" }); return {};
    case "moveOverlay": {
      const direction = string(args, "direction", 16);
      if (!["up", "down", "left", "right", "reset"].includes(direction)) throw new Error("Invalid overlay move.");
      await invoke("move_overlay", { direction });
      return {};
    }
    case "capture": await overlayCaptureAction()(); return {};
    case "translate": {
      if (await invoke<boolean>("caption_session_active")) throw new Error("Stop capture before changing languages.");
      await updatePrefs(translationModePatch(await loadPrefs()));
      return {};
    }
    case "recent": {
      if (await invoke<boolean>("caption_session_active")) throw new Error("Stop capture before changing languages.");
      const pair = overlayRecentPair(args);
      await updatePrefs({ translateEnabled: true, sourceLanguage: pair.source, targetLanguage: pair.target, lastTranslationPair: pair });
      return {};
    }
    case "openSettings": await invoke("open_settings_window"); return {};
    case "audioSettings": await openAudioSettings(); return {};
    case "checkAudio": return { message: await invoke<boolean>("check_system_audio") ? "System audio detected. Nothing was sent or saved." : "No audio detected. Play audio and check your output device and permission." };
    case "readiness": {
      await requestScreenRecording();
      const prefs = await loadPrefs();
      const [status, route] = await Promise.all([getConnectionStatus(), getCaptionRoute(prefs.translateEnabled ? prefs.sourceLanguage : prefs.targetLanguage, prefs.targetLanguage)]);
      return { message: !status.gatewayReachable ? "Caption service is unavailable. Try again." : status.audioPermission === "required" ? "Allow Screen & System Audio Recording, then check again." : `Ready for ${route.description}. Start captions while audio is playing.` };
    }
    case "policy": return fetchHistoryPolicy();
    case "savePolicy": {
      const retentionDays = integer(args, "retentionDays", 90);
      if (![0, 7, 30, 90].includes(retentionDays)) throw new Error("Invalid retention period.");
      return saveHistoryPolicy({ saveHistory: boolean(args, "saveHistory"), retentionDays });
    }
    case "history": {
      const sessions = await fetchHistorySessions(string(args, "query", 200), undefined, integer(args, "page", 100000) * 20, 21);
      return { sessions: sessions.slice(0, 20), hasMore: sessions.length > 20 };
    }
    case "detail": return fetchHistorySession(string(args, "id", 128));
    case "rename": await renameHistorySession(string(args, "id", 128), string(args, "title", 120)); return {};
    case "delete": await deleteHistorySession(string(args, "id", 128)); return {};
    case "export": {
      if (!isHistoryExportFormat(args.format)) throw new Error("Invalid export format.");
      const session = await fetchHistorySession(string(args, "id", 128));
      return { body: formatHistoryExport(session, args.format), filename: historyExportFilename(session, args.format) };
    }
    case "connection": {
      const prefs = await loadPrefs();
      const [connection, route] = await Promise.all([getConnectionStatus(), getCaptionRoute(prefs.translateEnabled ? prefs.sourceLanguage : prefs.targetLanguage, prefs.targetLanguage).then((route) => ({ ok: true, description: route.description }), (error: unknown) => ({ ok: false, description: String(error) }))]);
      return {
        rows: [
          { title: "Selected languages", value: route.ok ? "Configured" : "Unavailable", ok: route.ok },
          { title: "Caption service", value: connection.gatewayReachable ? "Connected" : "Offline", ok: connection.gatewayReachable },
          { title: "System audio", value: connection.capture.state === "capturing" ? "Capturing" : "Idle", ok: connection.capture.state === "capturing" },
          { title: "Audio permission", value: connection.audioPermission === "granted" ? "Ready" : "Allow access", ok: connection.audioPermission === "granted" },
          { title: "Capture backend", value: connection.capture.backend, ok: true },
        ],
        description: `${route.description}\nLast speech provider: ${speechProviderLabel(connection.lastProvider || prefs.lastProvider) ?? "No session yet"}`,
      };
    }
    case "timings": {
      const [samples, translations] = await Promise.all([invoke<CaptionTimingSample[]>("caption_timings"), invoke<TranslationTimingSample[]>("translation_timings")]);
      return formatNativeTimings(samples, translations);
    }
    case "language": {
      const key = string(args, "key", 32), value = string(args, "value", 16);
      if (!["sourceLanguage", "targetLanguage"].includes(key) || !isSupportedLanguage(value)) throw new Error("Invalid language.");
      const active = await invoke<boolean>("caption_session_active");
      if (active) throw new Error("Stop capture before changing languages.");
      const prefs = await loadPrefs();
      if (prefs.translateEnabled && key === "targetLanguage" && !isSupportedTargetLanguage(value)) throw new Error("Translate To cannot be Auto.");
      await updatePrefs(!prefs.translateEnabled ? { sourceLanguage: value, targetLanguage: value } : { [key]: value });
      return {};
    }
    default: throw new Error("Unknown native action.");
  }
}

export async function startNativeSettingsBridge(): Promise<void> {
  await listen<{ id: string; operation: string; args: Args }>("native-ui://request", (event) => {
    const { id, operation, args } = event.payload;
    if (typeof id !== "string" || id.length > 64 || typeof operation !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return;
    void handleNativeSettingsRequest(operation, args).then(
      (result) => invoke("native_ui_receive", { value: { id, ok: true, result } }),
      (error: unknown) => invoke("native_ui_receive", { value: { id, ok: false, error: error instanceof Error ? error.message : String(error) } }),
    ).catch(() => undefined);
  });
  await subscribeToPrefs((prefs) => {
    void prefsResult(prefs).then((result) => invoke("native_ui_receive", { value: { event: "prefs", ...result } })).catch(() => undefined);
  });
  await subscribeToSessionStatus((status) => {
    if (status.state !== "warning") void invoke("native_ui_receive", { value: { event: "session", state: status.state } }).catch(() => undefined);
  });
  await invoke("native_ui_ready");
}
