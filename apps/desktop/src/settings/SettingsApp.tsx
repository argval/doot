import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Captions,
  Info,
  Settings2,
} from "lucide-react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getName, getVersion } from "@tauri-apps/api/app";
import {
  groupedCaptionLanguages,
  LANGUAGE_LABELS,
  SUPPORTED_SOURCE_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  type SupportedLanguage,
} from "@doot/protocol";
import {
  CAPTION_FONT_SIZE_MAX,
  CAPTION_FONT_SIZE_MIN,
  DEFAULT_PREFS,
  OVERLAY_IDLE_OPACITY_MAX,
  OVERLAY_IDLE_OPACITY_MIN,
  loadPrefs,
  subscribeToPrefs,
  updatePrefs,
  type DesktopPrefs,
} from "../lib/prefs";
import { isTauriRuntime } from "../lib/runtime";
import {
  getConnectionStatus,
  type ConnectionStatus,
} from "../lib/tauri";

type SettingsSection = "general" | "captions" | "connection" | "about";

const SOURCE_LANGUAGES = SUPPORTED_SOURCE_LANGUAGES.filter((language) => language !== "auto");
const TARGET_LANGUAGES = SUPPORTED_TARGET_LANGUAGES;

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "captions", label: "Captions", icon: Captions },
  { id: "connection", label: "Connection", icon: Activity },
  { id: "about", label: "About", icon: Info },
];

function sectionTitle(section: SettingsSection): string {
  switch (section) {
    case "general":
      return "General";
    case "captions":
      return "Captions";
    case "connection":
      return "Connection";
    case "about":
      return "About";
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

function captureShortcutLabel(): string {
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") ? "⌘⇧D" : "Ctrl+Shift+D";
}

export function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>("general");
  const [prefs, setPrefs] = useState<DesktopPrefs>(DEFAULT_PREFS);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [appName, setAppName] = useState("Doot");
  const [appVersion, setAppVersion] = useState("0.1.0");

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const loaded = await loadPrefs();
      let openAtLogin = loaded.openAtLogin;
      if (isTauriRuntime()) {
        try {
          openAtLogin = await isEnabled();
        } catch {
          openAtLogin = false;
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
        setPrefs({ ...loaded, openAtLogin });
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
        const status = await getConnectionStatus();
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
  }, [section]);

  const patchPrefs = useCallback(async (patch: Partial<DesktopPrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    await updatePrefs(patch);
  }, []);

  const setOpenAtLogin = useCallback(async (enabled: boolean) => {
    setLoginError(null);
    setPrefs((current) => ({ ...current, openAtLogin: enabled }));
    try {
      if (isTauriRuntime()) {
        if (enabled) {
          await enable();
        } else {
          await disable();
        }
      }
      await updatePrefs({ openAtLogin: enabled });
    } catch (caught) {
      setPrefs((current) => ({ ...current, openAtLogin: !enabled }));
      setLoginError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  return (
    <div className="settings-shell">
      <nav className="settings-sidebar" aria-label="Settings">
        <p className="settings-brand">Doot</p>
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          const selected = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={selected ? "settings-nav-item selected" : "settings-nav-item"}
              aria-current={selected ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <main className="settings-content">
        <h1>{sectionTitle(section)}</h1>
        {section === "general" && (
          <GeneralSection
            openAtLogin={prefs.openAtLogin}
            loginError={loginError}
            onOpenAtLoginChange={(enabled) => void setOpenAtLogin(enabled)}
          />
        )}
        {section === "captions" && (
          <CaptionsSection prefs={prefs} onPatch={(patch) => void patchPrefs(patch)} />
        )}
        {section === "connection" && (
          <ConnectionSection
            prefs={prefs}
            connection={connection}
            error={connectionError}
          />
        )}
        {section === "about" && (
          <AboutSection name={appName} version={appVersion} />
        )}
      </main>
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
  return (
    <>
      <section className="settings-group" aria-label="Startup">
        <label className="settings-row">
          <span>
            <strong>Open at login</strong>
            <em>Start Doot when you sign in to this Mac.</em>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={openAtLogin}
            onChange={(event) => onOpenAtLoginChange(event.target.checked)}
          />
        </label>
      </section>
      {loginError && <p className="settings-error">{loginError}</p>}
      <section className="settings-group" aria-label="Keyboard">
        <div className="settings-row">
          <span>
            <strong>Start or stop capturing</strong>
            <em>Global shortcut. Editing comes later.</em>
          </span>
          <kbd className="settings-shortcut">{captureShortcutLabel()}</kbd>
        </div>
      </section>
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
  const opacityPercent = Math.round(prefs.overlayIdleOpacity * 100);

  return (
    <>
      <section className="settings-group" aria-label="Languages">
        <label className="settings-row">
          <span>
            <strong>From</strong>
            <em>Spoken language. Auto uses Sarvam for English/Indic targets and Gemini otherwise.</em>
          </span>
          <select
            value={prefs.sourceLanguage}
            onChange={(event) => {
              onPatch({ sourceLanguage: event.target.value as SupportedLanguage });
            }}
          >
            <option value="auto">{LANGUAGE_LABELS.auto}</option>
            {groupedCaptionLanguages(SOURCE_LANGUAGES).map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.languages.map((language) => (
                  <option key={language} value={language}>
                    {LANGUAGE_LABELS[language]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>To</strong>
            <em>Translated captions only. Takes effect on the next capture.</em>
          </span>
          <select
            value={prefs.targetLanguage}
            onChange={(event) => {
              onPatch({ targetLanguage: event.target.value as SupportedLanguage });
            }}
          >
            {groupedCaptionLanguages(TARGET_LANGUAGES).map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.languages.map((language) => (
                  <option key={language} value={language}>
                    {LANGUAGE_LABELS[language]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </section>
      <section className="settings-group" aria-label="Overlay">
        <label className="settings-row">
          <span>
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
        <label className="settings-row">
          <span>
            <strong>Idle opacity</strong>
            <em>Hover still steps up one notch. One slider, not two.</em>
          </span>
          <div className="settings-slider">
            <input
              type="range"
              min={OVERLAY_IDLE_OPACITY_MIN}
              max={OVERLAY_IDLE_OPACITY_MAX}
              step={0.01}
              value={prefs.overlayIdleOpacity}
              onChange={(event) => {
                onPatch({ overlayIdleOpacity: Number(event.target.value) });
              }}
            />
            <span className="settings-slider-value">{opacityPercent}%</span>
          </div>
        </label>
      </section>
    </>
  );
}

function ConnectionSection({
  prefs,
  connection,
  error,
}: {
  prefs: DesktopPrefs;
  connection: ConnectionStatus | null;
  error: string | null;
}) {
  const gatewayOk = connection?.gatewayReachable ?? false;
  const capture = connection?.capture;
  const provider = connection?.lastProvider || prefs.lastProvider;

  return (
    <>
      <section className="settings-group" aria-label="Status">
        <div className="settings-row">
          <span>
            <strong>Gateway</strong>
            <em>Local caption service at 127.0.0.1:8787.</em>
          </span>
          <StatusBadge
            ok={gatewayOk}
            label={gatewayOk ? "Reachable" : "Unreachable"}
          />
        </div>
        <div className="settings-row">
          <span>
            <strong>System audio</strong>
            <em>
              {capture
                ? `${capture.backend} · ${capture.sampleRate / 1000} kHz · ${capture.channels === 1 ? "mono" : "stereo"}`
                : "Waiting for capture status."}
            </em>
          </span>
          <StatusBadge
            ok={capture?.state === "capturing"}
            tone={capture?.state === "capturing" ? "live" : "neutral"}
            label={capture?.state === "capturing" ? "Capturing" : "Idle"}
          />
        </div>
        <div className="settings-row">
          <span>
            <strong>Last provider</strong>
            <em>Resolved by the gateway after a session starts.</em>
          </span>
          <span className="settings-value">{provider ?? "—"}</span>
        </div>
      </section>
      {error && <p className="settings-error">{error}</p>}
      <p className="settings-footnote">
        Speech API keys still live in the gateway <code>.env</code>. Settings will
        own them when Doot starts the gateway itself.
      </p>
    </>
  );
}

function AboutSection({ name, version }: { name: string; version: string }) {
  return (
    <section className="settings-about" aria-label="About Doot">
      <p className="settings-about-name">{name}</p>
      <p className="settings-about-tag">Live captions for your desktop.</p>
      <p className="settings-about-version">Version {version}</p>
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
