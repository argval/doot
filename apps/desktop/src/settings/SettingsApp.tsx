import { useCallback, useEffect, useState, type CSSProperties } from "react";
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
  hoverBoostFor,
  concreteCaptionLanguage,
  loadPrefs,
  subscribeToPrefs,
  updatePrefs,
  type DesktopPrefs,
} from "../lib/prefs";
import { isTauriRuntime } from "../lib/runtime";
import { captureShortcutLabel } from "../lib/shortcut";
import {
  getConnectionStatus,
  type ConnectionStatus,
} from "../lib/tauri";
import { captionScript, CaptionPanel } from "../overlay/CaptionPanel";
import type { VisibleCaptionLine } from "../captions";

type SettingsSection = "general" | "captions" | "connection" | "about";

const SOURCE_LANGUAGES = SUPPORTED_SOURCE_LANGUAGES.filter((language) => language !== "auto");
const TARGET_LANGUAGES = SUPPORTED_TARGET_LANGUAGES;

const OPACITY_PRESETS = [
  { id: "ghost", label: "Ghost", value: 0.22 },
  { id: "balanced", label: "Balanced", value: 0.42 },
  { id: "solid", label: "Solid", value: 0.62 },
] as const;

const PREVIEW_LATIN: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-1",
    translatedText: "Earlier turns stay on their own lines, a little quieter.",
    isActive: false,
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
  return language === "auto" ? "en" : language;
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

function selectedOpacityPreset(opacity: number): (typeof OPACITY_PRESETS)[number]["id"] | null {
  const match = OPACITY_PRESETS.find((preset) => Math.abs(preset.value - opacity) < 0.015);
  return match?.id ?? null;
}

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
            <em>Start Doot when you sign in to this computer.</em>
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
  const opacityPreset = selectedOpacityPreset(prefs.overlayIdleOpacity);
  const previewLanguage = previewTargetLanguage(prefs.targetLanguage);

  return (
    <>
      <p className="settings-preview-label">Overlay preview</p>
      <div
        className="settings-overlay-preview"
        style={{
          "--caption-font-size": `${prefs.captionFontSize}px`,
          "--overlay-idle-alpha": String(prefs.overlayIdleOpacity),
          "--overlay-hover-boost": String(hoverBoostFor(prefs.overlayIdleOpacity)),
        } as CSSProperties}
      >
        <CaptionPanel
          lines={previewLinesFor(prefs.targetLanguage)}
          targetLanguage={previewLanguage}
          error={null}
          statusNotice={null}
          placeholder="Your live captions will appear here."
        />
      </div>
      <section className="settings-group" aria-label="Languages">
        <label className="settings-row">
          <span>
            <strong>Translate</strong>
            <em>When off, captions stay in one language. When on, pick From and To.</em>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={prefs.translateEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              onPatch({
                translateEnabled: enabled,
                sourceLanguage: enabled ? "auto" : prefs.targetLanguage,
                targetLanguage: enabled
                  ? concreteCaptionLanguage(prefs.targetLanguage)
                  : prefs.targetLanguage,
              });
            }}
          />
        </label>
        {prefs.translateEnabled && (
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
        )}
        <label className="settings-row">
          <span>
            <strong>{prefs.translateEnabled ? "To" : "Language"}</strong>
            <em>
              {prefs.translateEnabled
                ? "Translated captions only. Takes effect on the next capture."
                : "Caption language, including Auto detect. Same spoken language, no translation."}
            </em>
          </span>
          <select
            value={prefs.targetLanguage}
            onChange={(event) => {
              const language = event.target.value as SupportedLanguage;
              onPatch(
                prefs.translateEnabled
                  ? { targetLanguage: language }
                  : { sourceLanguage: language, targetLanguage: language },
              );
            }}
          >
            {!prefs.translateEnabled && (
              <option value="auto">{LANGUAGE_LABELS.auto}</option>
            )}
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
        <div className="settings-row">
          <span>
            <strong>Idle look</strong>
            <em>Ghost, Balanced, or Solid. Hover still steps up one notch.</em>
          </span>
          <div className="settings-presets" role="group" aria-label="Idle opacity presets">
            {OPACITY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={opacityPreset === preset.id ? "selected" : undefined}
                aria-pressed={opacityPreset === preset.id}
                onClick={() => onPatch({ overlayIdleOpacity: preset.value })}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <label className="settings-row">
          <span>
            <strong>Idle opacity</strong>
            <em>Fine-tune the idle glass. One slider, not two.</em>
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
