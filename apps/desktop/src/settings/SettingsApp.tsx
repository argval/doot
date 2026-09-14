import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Activity,
  Captions,
  History,
  Info,
  KeyRound,
  Languages,
  Circle,
  Search,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getName, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  type SupportedLanguage,
  type CaptionRoute,
} from "@doot/protocol";
import {
  CAPTION_FONT_SIZE_MAX,
  CAPTION_FONT_SIZE_MIN,
  CONTEXT_HINT_MAX_CHARS,
  DEFAULT_PREFS,
  OVERLAY_IDLE_OPACITY_MAX,
  OVERLAY_IDLE_OPACITY_MIN,
  hoverBoostFor,
  loadPrefs,
  subscribeToPrefs,
  updatePrefs,
  type DesktopPrefs,
} from "../lib/prefs";
import { isTauriRuntime } from "../lib/runtime";
import {
  getConnectionStatus,
  getCaptionRoute,
  openAudioSettings,
  type ConnectionStatus,
} from "../lib/tauri";
import { captionScript, CaptionPanel } from "../overlay/CaptionPanel";
import { HistorySection } from "./HistorySection";
import { SetupSection } from "./SetupSection";
import { PrivacySection } from "./PrivacySection";
import { SettingsGroup, SettingsRow, SettingsSwitch, SettingsToolbar } from "./SettingsChrome";
import type { VisibleCaptionLine } from "../captions";
import { summarizeTiming, summarizeMilliseconds, type CaptionTimingSample, type TranslationTimingSample } from "../lib/timing";
import { interactionShortcutLabel } from "../lib/shortcut";
import { speechProviderLabel } from "../lib/speech-labels";

type SettingsSection = "setup" | "general" | "captions" | "history" | "privacy" | "connection" | "about";

const OVERLAY_TRANSPARENCY_MIN = Math.round((1 - OVERLAY_IDLE_OPACITY_MAX) * 100);
const OVERLAY_TRANSPARENCY_MAX = Math.round((1 - OVERLAY_IDLE_OPACITY_MIN) * 100);

const PREVIEW_LATIN: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-1",
    translatedText: "Earlier turns stay on their own lines, a little quieter.",
    isActive: false,
    speakerTint: 2,
  },
  {
    utteranceId: "settings-preview-2",
    translatedText: "The live caption keeps updating as you speak.",
    isActive: true,
  },
];

const PREVIEW_INDIC: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-kn-1",
    translatedText: "ಹಿಂದಿನ ವಾಕ್ಯವು ತನ್ನ ಸಾಲಿನಲ್ಲಿಯೇ ಉಳಿಯುತ್ತದೆ.",
    isActive: false,
  },
  {
    utteranceId: "settings-preview-kn-2",
    translatedText: "ನೇರ ಶೀರ್ಷಿಕೆ ಮಾತು ಬಂದಂತೆ ನವೀಕರಿಸುತ್ತದೆ.",
    isActive: true,
  },
];

const PREVIEW_CJK: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-ja-1",
    translatedText: "前の発話は少し控えめに残ります。",
    isActive: false,
  },
  {
    utteranceId: "settings-preview-ja-2",
    translatedText: "ライブ字幕は話している最中に更新されます。",
    isActive: true,
  },
];

const PREVIEW_RTL: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-ar-1",
    translatedText: "تبقى الجمل السابقة في أسطرها بهدوء أكبر.",
    isActive: false,
  },
  {
    utteranceId: "settings-preview-ar-2",
    translatedText: "يتحدّث السطر المباشر أثناء الكلام.",
    isActive: true,
  },
];

function previewTargetLanguage(language: SupportedLanguage): SupportedLanguage {
  switch (captionScript(language)) {
    case "indic": return "kn";
    case "cjk": return "ja";
    case "rtl": return "ar";
    default: return "en";
  }
}

function previewLinesFor(language: SupportedLanguage): readonly VisibleCaptionLine[] {
  switch (captionScript(previewTargetLanguage(language))) {
    case "indic":
      return PREVIEW_INDIC;
    case "cjk":
      return PREVIEW_CJK;
    case "rtl":
      return PREVIEW_RTL;
    default:
      return PREVIEW_LATIN;
  }
}

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: typeof KeyRound;
  keywords: string;
}> = [
  { id: "setup", label: "Setup", icon: KeyRound, keywords: "key api sarvam gemini permission audio" },
  { id: "general", label: "General", icon: SlidersHorizontal, keywords: "login startup overlay position click-through" },
  { id: "captions", label: "Captions", icon: Captions, keywords: "opacity transparency text size font preview context names show match" },
  { id: "history", label: "History", icon: History, keywords: "sessions transcript export" },
  { id: "privacy", label: "Privacy", icon: Shield, keywords: "save retention history" },
  { id: "connection", label: "Connection", icon: Activity, keywords: "gateway audio permission route timing" },
  { id: "about", label: "About", icon: Info, keywords: "version" },
];

export function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>("general");
  const [sectionHistory, setSectionHistory] = useState<SettingsSection[]>(["general"]);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [navQuery, setNavQuery] = useState("");
  const [prefs, setPrefs] = useState<DesktopPrefs>(DEFAULT_PREFS);
  const [openAtLogin, setOpenAtLoginEnabled] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [route, setRoute] = useState<CaptionRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [appName, setAppName] = useState("Doot");
  const [appVersion, setAppVersion] = useState("0.1.0");

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const loaded = await loadPrefs();
      let loginEnabled = false;
      if (isTauriRuntime()) {
        try {
          loginEnabled = await isEnabled();
        } catch {
          loginEnabled = false;
        }
        try {
          const [name, version] = await Promise.all([getName(), getVersion()]);
          if (!disposed) {
            setAppName(name);
            setAppVersion(version);
          }
        } catch {
          // Keep bundled defaults when app metadata is unavailable.
        }
      }
      if (!disposed) {
        setPrefs(loaded);
        if (!loaded.onboardingComplete) {
          setSection("setup");
          setSectionHistory(["setup"]);
          setSectionIndex(0);
        }
        setOpenAtLoginEnabled(loginEnabled);
      }
    })();

    void subscribeToPrefs((next) => {
      if (!disposed) {
        setPrefs(next);
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unsubscribe = cleanup;
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (section !== "connection") {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = isTauriRuntime() ? await getConnectionStatus() : null;
        if (!cancelled) {
          setConnection(status);
          setConnectionError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setConnection(null);
          setConnectionError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [section, refreshKey]);

  const patchPrefs = useCallback(async (patch: Partial<DesktopPrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    await updatePrefs(patch);
  }, []);

  useEffect(() => {
    if (section !== "connection") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await getCaptionRoute(
          prefs.translateEnabled ? prefs.sourceLanguage : prefs.targetLanguage,
          prefs.targetLanguage,
        );
        if (!cancelled) { setRoute(next); setRouteError(null); }
      } catch (error) {
        if (!cancelled) {
          setRoute(null);
          setRouteError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    setRoute(null);
    setRouteError(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [section, prefs.translateEnabled, prefs.sourceLanguage, prefs.targetLanguage, refreshKey]);

  const setOpenAtLogin = useCallback(async (enabled: boolean) => {
    setLoginError(null);
    setOpenAtLoginEnabled(enabled);
    try {
      if (isTauriRuntime()) {
        if (enabled) {
          await enable();
        } else {
          await disable();
        }
      }
    } catch (caught) {
      setOpenAtLoginEnabled(!enabled);
      setLoginError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const visibleSections = useMemo(() => {
    const query = navQuery.trim().toLowerCase();
    if (!query) {
      return SECTIONS;
    }
    return SECTIONS.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(query));
  }, [navQuery]);

  const goToSection = useCallback((next: SettingsSection) => {
    if (next === section) {
      return;
    }
    setSectionHistory((history) => [...history.slice(0, sectionIndex + 1), next]);
    setSectionIndex(sectionIndex + 1);
    setSection(next);
  }, [section, sectionIndex]);

  const goHistory = useCallback((direction: -1 | 1) => {
    setSectionIndex((index) => {
      const nextIndex = index + direction;
      const next = sectionHistory[nextIndex];
      if (!next) {
        return index;
      }
      setSection(next);
      return nextIndex;
    });
  }, [sectionHistory]);

  return (
    <div className="settings-shell">
      <nav className="settings-sidebar" aria-label="Settings" data-tauri-drag-region>
        <label className="settings-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={navQuery}
            onChange={(event) => setNavQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search settings"
          />
        </label>
        <div className="settings-nav">
          {visibleSections.length === 0 && <p className="settings-search-empty">No matching settings</p>}
          {visibleSections.map((item) => {
            const Icon = item.icon;
            const selected = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={selected ? "settings-nav-item selected" : "settings-nav-item"}
                aria-current={selected ? "page" : undefined}
                onClick={() => goToSection(item.id)}
              >
                <span className="settings-nav-icon" data-tone={item.id}><Icon size={12} aria-hidden="true" /></span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="settings-pane">
        <SettingsToolbar
          canBack={sectionIndex > 0}
          canForward={sectionIndex < sectionHistory.length - 1}
          onBack={() => goHistory(-1)}
          onForward={() => goHistory(1)}
        />
        <main className={section === "history" ? "settings-content history" : "settings-content"}>
          <h1 className="sr-only">{SECTIONS.find((item) => item.id === section)?.label}</h1>
          {section === "setup" && <SetupSection prefs={prefs} onComplete={() => goToSection("captions")} />}
          {section === "privacy" && <PrivacySection />}
          {section === "general" && (
            <GeneralSection
              openAtLogin={openAtLogin}
              loginError={loginError}
              onOpenAtLoginChange={(enabled) => void setOpenAtLogin(enabled)}
            />
          )}
          {section === "captions" && (
            <CaptionsSection prefs={prefs} onPatch={(patch) => void patchPrefs(patch)} />
          )}
          {section === "history" && <HistorySection />}
          {section === "connection" && (
            <ConnectionSection
              prefs={prefs}
              connection={connection}
              error={connectionError}
              route={route}
              routeError={routeError}
              onRefresh={() => setRefreshKey((value) => value + 1)}
            />
          )}
          {section === "about" && (
            <AboutSection name={appName} version={appVersion} />
          )}
        </main>
      </div>
    </div>
  );
}

function GeneralSection({
  openAtLogin,
  loginError,
  onOpenAtLoginChange,
}: {
  openAtLogin: boolean;
  loginError: string | null;
  onOpenAtLoginChange: (enabled: boolean) => void;
}) {
  const [positionError, setPositionError] = useState<string | null>(null);
  return (
    <>
      <SettingsGroup label="Startup" aria-label="Startup">
        <label className="settings-row">
          <span className="settings-row-copy">
            <strong>Open at login</strong>
            <em>Start Doot when you sign in to this computer.</em>
          </span>
          <SettingsSwitch checked={openAtLogin} onChange={onOpenAtLoginChange} />
        </label>
      </SettingsGroup>
      {loginError && <p className="settings-error">{loginError}</p>}
      <SettingsGroup label="Overlay" aria-label="Overlay">
        <SettingsRow
          title="Reset overlay"
          subtitle={`Alt+Arrow keys move the overlay. ${interactionShortcutLabel()} toggles click-through. The tray also provides Unlock Overlay.`}
          chevron
          disabled={!isTauriRuntime()}
          onClick={() => {
            void invoke("move_overlay", { direction: "reset" })
              .then(() => setPositionError(null))
              .catch((error: unknown) => setPositionError(String(error)));
          }}
        />
      </SettingsGroup>
      {positionError && <p role="alert" className="settings-error">{positionError}</p>}
    </>
  );
}

function CaptionsSection({
  prefs,
  onPatch,
}: {
  prefs: DesktopPrefs;
  onPatch: (patch: Partial<DesktopPrefs>) => void;
}) {
  const transparency = Math.round((1 - prefs.overlayIdleOpacity) * 100);
  const glassStrength = prefs.overlayIdleOpacity / OVERLAY_IDLE_OPACITY_MAX;
  const previewLanguage = previewTargetLanguage(prefs.targetLanguage);

  return (
    <>
      <p className="settings-preview-label">Overlay preview · {previewLanguage === "kn" ? "Kannada" : previewLanguage === "ja" ? "Japanese" : previewLanguage === "ar" ? "Arabic" : "English"} script sample</p>
      <div
        className="settings-overlay-preview"
        style={{
          "--caption-font-size": `${prefs.captionFontSize}px`,
          "--overlay-idle-alpha": String(prefs.overlayIdleOpacity),
          "--overlay-hover-boost": String(hoverBoostFor(prefs.overlayIdleOpacity)),
          "--overlay-blur": `${glassStrength * 36}px`,
          "--overlay-frame-alpha": String(glassStrength),
        } as CSSProperties}
      >
        <div className="language-picker" aria-hidden="true">
          <span className="language-select">
            <input readOnly tabIndex={-1} value="English" aria-hidden="true" />
          </span>
          <span className="language-translate active"><Languages size={13} /></span>
          <span className="capture-toggle"><Circle size={11} /></span>
        </div>
        <CaptionPanel
          lines={previewLinesFor(prefs.targetLanguage)}
          targetLanguage={previewLanguage}
          error={null}
          statusNotice={null}
          placeholder="Your live captions will appear here."
        />
      </div>
      <SettingsGroup label="Idle look" aria-label="Idle look">
        <label className="settings-row">
          <span className="settings-row-copy">
            <strong>Transparency</strong>
            <em>How translucent the overlay is while idle. It becomes slightly more visible on hover.</em>
          </span>
          <div className="settings-slider">
            <input
              type="range"
              min={OVERLAY_TRANSPARENCY_MIN}
              max={OVERLAY_TRANSPARENCY_MAX}
              step={1}
              value={transparency}
              aria-label="Idle transparency"
              aria-valuetext={`${transparency}% transparent`}
              onChange={(event) => {
                onPatch({ overlayIdleOpacity: 1 - Number(event.target.value) / 100 });
              }}
            />
            <span className="settings-slider-value">{transparency}%</span>
          </div>
        </label>
      </SettingsGroup>
      <SettingsGroup label="Text" aria-label="Caption text">
        <label className="settings-row">
          <span className="settings-row-copy">
            <strong>Text size</strong>
            <em>Caption type size. Resizing the window does not change this.</em>
          </span>
          <div className="settings-slider">
            <input
              type="range"
              min={CAPTION_FONT_SIZE_MIN}
              max={CAPTION_FONT_SIZE_MAX}
              step={1}
              value={prefs.captionFontSize}
              onChange={(event) => {
                onPatch({ captionFontSize: Number(event.target.value) });
              }}
            />
            <span className="settings-slider-value">{prefs.captionFontSize}px</span>
          </div>
        </label>
        <label className="settings-row settings-row-stack">
          <span className="settings-row-copy">
            <strong>What's playing?</strong>
            <em>Optional hint for the next capture — a match, show, or stream. Leave blank to infer names from speech.</em>
          </span>
          <input
            type="text"
            maxLength={CONTEXT_HINT_MAX_CHARS}
            value={prefs.contextHint}
            placeholder="Premier League, Bleach, …"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              onPatch({ contextHint: event.target.value });
            }}
          />
        </label>
      </SettingsGroup>
    </>
  );
}

function ConnectionSection({
  prefs,
  connection,
  error,
  route,
  routeError,
  onRefresh,
}: {
  prefs: DesktopPrefs;
  connection: ConnectionStatus | null;
  error: string | null;
  route: CaptionRoute | null;
  routeError: string | null;
  onRefresh: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const gatewayOk = connection?.gatewayReachable ?? Boolean(route);
  const capture = connection?.capture;
  const provider = speechProviderLabel(connection?.lastProvider || prefs.lastProvider);

  return (
    <>
      <p className="settings-intro">Check that Doot can hear this computer and provide captions in your chosen languages.</p>
      <SettingsGroup label="Status" aria-label="Status">
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Selected languages</strong>
            <em>{route ? "Your language selection is configured." : routeError ? "These languages need speech service setup. See connection details below." : "Checking selected languages…"}</em>
          </span>
          <StatusBadge ok={Boolean(route)} label={route ? "Configured" : routeError ? "Unavailable" : "Checking"} />
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Caption service</strong>
            <em>{gatewayOk ? "Doot can reach the caption service." : "Doot could not start its caption service. Check Setup, then try again."}</em>
          </span>
          <StatusBadge
            ok={gatewayOk}
            label={gatewayOk ? "Connected" : "Offline"}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>System audio</strong>
            <em>
              {capture?.state === "capturing" ? "Listening to audio playing on this computer." : "Play audio, then start captions from the overlay."}
            </em>
          </span>
          <StatusBadge
            ok={capture?.state === "capturing"}
            tone={capture?.state === "capturing" ? "live" : "neutral"}
            label={capture?.state === "capturing" ? "Capturing" : "Idle"}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>Audio permission</strong>
            <em>{connection?.audioPermission === "required" ? "Allow Doot in Screen & System Audio Recording, then restart capture." : connection?.audioPermission === "granted" ? "Doot has permission to capture system audio." : connection?.audioPermission === "not-required" ? "System audio capture needs no additional permission." : "Permission can be checked in the desktop app."}</em>
          </span>
          <StatusBadge ok={connection?.audioPermission === "granted" || connection?.audioPermission === "not-required"} tone={connection ? "status" : "neutral"} label={connection?.audioPermission === "required" ? "Allow access" : connection ? "Ready" : "Desktop only"} />
        </div>
      </SettingsGroup>
      {error && <p className="settings-error">{error}</p>}
      <SettingsGroup label="Actions" aria-label="Connection actions">
        <SettingsRow title="Check again" chevron onClick={onRefresh} />
        {isTauriRuntime() && (
          <SettingsRow
            title="Open system audio settings"
            chevron
            onClick={() => {
              void openAudioSettings().catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Could not open system settings."));
            }}
          />
        )}
      </SettingsGroup>
      {actionError && <p role="alert" className="settings-error">{actionError}</p>}
      <details className="connection-details"><summary>Connection details</summary>
        <p>{route?.description ?? routeError ?? "Checking configuration…"}</p>
        <p>Last speech provider: {provider ?? "No session yet"}</p>
        <p>Doot manages its own caption service. Add or change provider keys in Setup; stop capture before changing keys.</p>
      </details>
      <TimingDiagnostics />
    </>
  );
}

function TimingDiagnostics() {
  const [samples, setSamples] = useState<CaptionTimingSample[]>([]);
  const [translations, setTranslations] = useState<TranslationTimingSample[]>([]);
  const [notice, setNotice] = useState("");
  const groups = new Map<string, TranslationTimingSample[]>();
  for (const sample of translations) {
    const label = `${sample.sourceLanguage} → ${sample.targetLanguage} · ${sample.speechProvider} → ${sample.translationProvider} · ${sample.urgency}`;
    const group = groups.get(label) ?? [];
    group.push(sample);
    groups.set(label, group);
  }
  return <details className="connection-details"><summary>Caption timing diagnostics</summary>
    <p>Read the last 500 visible revisions from this app run. No audio, captions, keys, or session identifiers are included. These are estimates from provider audio intervals and a browser paint opportunity, not physical display measurements.</p>
    {[false, true].map((final) => {
      const group = samples.filter((sample) => sample.final === final);
      return <div key={String(final)}><strong>{final ? "Final" : "Draft"} revisions · {group.length} samples</strong>
        {(["pipelineMs", "desktopMs", "estimatedDisplayLagMs"] as const).map((field, index) => {
          const { p50, p95 } = summarizeTiming(group, field);
          return <p key={field}>{["Audio interval → native caption", "Native caption → paint opportunity", "Estimated audio → display"][index]}: p50 {p50 ?? "—"} / p95 {p95 ?? "—"} ms</p>;
        })}</div>;
    })}
    <p>Text translation keeps the last 500 attempts, including failures and reused drafts. Request time includes the network round trip. Native Live Translate has no separate text request.</p>
    {[...groups].map(([label, group]) => <div key={label}>
      <strong>{label}</strong>
      <p>{group.length} attempts · {group.filter((sample) => sample.outcome === "success").length} succeeded · {group.filter((sample) => sample.outcome === "reused").length} reused · {group.filter((sample) => sample.outcome === "timeout").length} timed out · {group.filter((sample) => sample.outcome === "error" || sample.outcome === "cancelled").length} failed/cancelled</p>
      {(["queueMs", "requestMs", "sourceToCompleteMs", "completionToCaptionMs"] as const).map((field, index) => {
        const { p50, p95 } = summarizeMilliseconds(group.filter((sample) => sample.outcome === "success").map((sample) => sample[field]));
        return <p key={field}>{["Queue → request", "Request → response", "Source revision → response", "Response → caption event"][index]}: successful p50 {p50 ?? "—"} / p95 {p95 ?? "—"} ms</p>;
      })}
    </div>)}
    <div className="settings-history-actions">
      <button disabled={!isTauriRuntime()} onClick={() => { void Promise.all([invoke<CaptionTimingSample[]>("caption_timings"), invoke<TranslationTimingSample[]>("translation_timings")]).then(([captions, requests]) => { setSamples(captions); setTranslations(requests); }).catch((error: unknown) => setNotice(String(error))); }}>Read timings</button>
      <button disabled={!samples.length && !translations.length} onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ version: 2, measurement: "paint-opportunity-estimate-and-text-request-timing", samples, translations }, null, 2)).then(() => setNotice("Timing diagnostics copied.")).catch(() => setNotice("Could not copy diagnostics.")); }}>Copy diagnostics</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </details>;
}

function AboutSection({ name, version }: { name: string; version: string }) {
  return (
    <section className="settings-about" aria-label="About Doot">
      <div className="settings-about-hero">
        <span className="settings-about-mark" aria-hidden="true">D</span>
        <p className="settings-about-name">{name}</p>
        <p className="settings-about-tag">Live captions for your desktop.</p>
      </div>
      <SettingsGroup aria-label="Version">
        <SettingsRow title="Version">
          <span className="settings-value">{version}</span>
        </SettingsRow>
      </SettingsGroup>
    </section>
  );
}

function StatusBadge({
  ok,
  label,
  tone = "status",
}: {
  ok: boolean;
  label: string;
  tone?: "status" | "live" | "neutral";
}) {
  const className = tone === "live"
    ? "settings-badge live"
    : tone === "neutral"
    ? "settings-badge"
    : ok
    ? "settings-badge ok"
    : "settings-badge down";
  return <span className={className}>{label}</span>;
}
