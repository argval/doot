import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Circle, Languages, Square, Settings2, History, MousePointer2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  type SupportedLanguage,
} from "@doot/protocol";
import {
  EMPTY_CAPTION_STATE,
  reduceCaptionEvent,
  selectVisibleCaptions,
} from "./captions";
import { CaptionPanel } from "./overlay/CaptionPanel";
import { overlayWebPreview } from "./overlay/web-preview";
import { captureShortcutLabel, interactionShortcutLabel } from "./lib/shortcut";
import { isTauriRuntime } from "./lib/runtime";
import { captionTimingSample } from "./lib/timing";
import {
  openSettingsWindow,
  startCaptionSession,
  stopCaptionSession,
  subscribeToCaptions,
  subscribeToCaptureToggle,
  subscribeToSessionStatus,
  subscribeToAudioActivity,
  getCaptionRoute,
  type DesktopSession,
} from "./lib/tauri";
import {
  DEFAULT_PREFS,
  applyOverlayAppearance,
  translationModePatch,
  rememberPair,
  loadPrefs,
  subscribeToPrefs,
  updatePrefs,
  type DesktopPrefs,
} from "./lib/prefs";

const selectableSourceLanguages = SUPPORTED_LANGUAGES.filter(
  (language) => language !== "auto",
);
const selectableTargetLanguages = SUPPORTED_TARGET_LANGUAGES;

export function App() {
  const [prefs, setPrefs] = useState<DesktopPrefs>(DEFAULT_PREFS);
  const [captions, setCaptions] = useState(EMPTY_CAPTION_STATE);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState("idle");
  const [audio, setAudio] = useState({ level: 0, silentForMs: 0 });
  const [routeError, setRouteError] = useState<string | null>(null);
  const [clickThrough, setClickThrough] = useState(false);
  const [persistentNotice, setPersistentNotice] = useState<string | null>(null);
  const acceptedSessionIdRef = useRef<string | null>(null);
  const lastProviderRef = useRef<string | null>(DEFAULT_PREFS.lastProvider);
  const captionCopyRef = useRef<HTMLDivElement>(null);
  const measuredRevisions = useRef(new Set<string>());
  const toggleCaptureRef = useRef<() => Promise<void>>(async () => {});
  const preview = overlayWebPreview();
  const visibleLines = preview.lines ?? selectVisibleCaptions(captions).lines;
  const sourceLanguage = prefs.sourceLanguage;
  const targetLanguage = preview.targetLanguage ?? prefs.targetLanguage;
  const capturing = session !== null || preview.capturing;
  const overlayError = preview.error ?? error;
  const listening = capturing && visibleLines.length === 0 && !overlayError;
  const languagesLocked = capturing || isTransitioning;
  const translating = prefs.translateEnabled;
  const sessionSource = translating ? sourceLanguage : targetLanguage;
  const statusLabel = preview.status ?? (captureState === "finalizing" ? "Finalizing captions…" : isTransitioning ? (capturing ? "Stopping…" : "Starting…")
    : captureState === "reconnecting" ? "Reconnecting…"
    : captureState === "starting" ? "Starting…"
    : capturing ? (audio.silentForMs >= 5000 ? "No audio detected" : "Listening")
    : "Stopped");
  const providerLabel = session?.provider || prefs.lastProvider;
  const captureHint = capturing
    ? `Stop capturing (${captureShortcutLabel()})${providerLabel ? ` · ${providerLabel}` : ""}`
    : `Start capturing (${captureShortcutLabel()})`;

  const applyPrefs = useCallback((next: DesktopPrefs) => {
    lastProviderRef.current = next.lastProvider;
    setPrefs(next);
    applyOverlayAppearance(next);
  }, []);

  const persistLanguage = useCallback(async (
    key: "sourceLanguage" | "targetLanguage",
    value: SupportedLanguage,
  ) => {
    const syncBoth = !translating && key === "targetLanguage";
    setPrefs((current) => {
      const next = syncBoth
        ? { ...current, sourceLanguage: value, targetLanguage: value }
        : { ...current, [key]: value };
      applyOverlayAppearance(next);
      return next;
    });
    await updatePrefs(
      syncBoth
        ? { sourceLanguage: value, targetLanguage: value }
        : { [key]: value },
    );
  }, [translating]);

  const toggleTranslate = useCallback(async () => {
    if (languagesLocked) {
      return;
    }
    const patch = translationModePatch(prefs);
    setPrefs((current) => ({ ...current, ...patch }));
    await updatePrefs(patch);
  }, [languagesLocked, prefs]);

  const toggleCapture = useCallback(async () => {
    if (isTransitioning) return;
    if (!isTauriRuntime()) {
      setError("System audio capture needs the Doot desktop app.");
      return;
    }

    setIsTransitioning(true);
    setError(null);
    setStatusNotice(null);
    try {
      if (session) {
        const stoppingId = session.sessionId;
        acceptedSessionIdRef.current = stoppingId;
        await stopCaptionSession(stoppingId);
        if (acceptedSessionIdRef.current === stoppingId) {
          acceptedSessionIdRef.current = null;
        }
        setSession(null);
      } else {
        setPersistentNotice(null);
        setCaptions(EMPTY_CAPTION_STATE);
        setAudio({ level: 0, silentForMs: 0 });
        setCaptureState("starting");
        const next = await startCaptionSession(sessionSource, targetLanguage);
        acceptedSessionIdRef.current = next.sessionId;
        setSession(next);
        if (prefs.translateEnabled) void updatePrefs({ recentPairs: rememberPair(prefs), lastTranslationPair: { source: prefs.sourceLanguage, target: prefs.targetLanguage === "auto" ? "en" : prefs.targetLanguage } });
        if (next.provider && next.provider !== lastProviderRef.current) {
          lastProviderRef.current = next.provider;
          void updatePrefs({ lastProvider: next.provider });
        }
      }
    } catch (caught) {
      setCaptureState("idle");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsTransitioning(false);
    }
  }, [isTransitioning, session, sessionSource, targetLanguage, prefs]);

  useEffect(() => { toggleCaptureRef.current = toggleCapture; }, [toggleCapture]);

  useEffect(() => {
    if (capturing || !isTauriRuntime()) return;
    let cancelled = false;
    setRouteError(null);
    const timer = window.setTimeout(() => {
      void getCaptionRoute(sessionSource, targetLanguage).catch((error: unknown) => {
        if (!cancelled) setRouteError(error instanceof Error ? error.message : "This language pair is unavailable.");
      });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [capturing, sessionSource, targetLanguage]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void loadPrefs().then((loaded) => {
      if (!disposed) {
        applyPrefs(loaded);
        if (!loaded.onboardingComplete && isTauriRuntime()) void openSettingsWindow().catch(() => undefined);
      }
    });
    void subscribeToPrefs((next) => {
      if (!disposed) {
        applyPrefs(next);
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
  }, [applyPrefs]);

  const openSettings = useCallback(() => {
    if (!isTauriRuntime()) {
      window.location.assign("/?window=settings");
      return;
    }
    void openSettingsWindow().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const subscriptions = [
      listen<boolean>("overlay://click-through", (event) => setClickThrough(event.payload)),
      subscribeToAudioActivity((activity) => {
        if (activity.sessionId === acceptedSessionIdRef.current) {
          setAudio(activity);
          if (activity.droppedAudioMs) setPersistentNotice(`Audio buffer overflow: ${(activity.droppedAudioMs / 1000).toFixed(1)}s skipped.`);
        }
      }),
      subscribeToCaptions((event) => {
        if (
          acceptedSessionIdRef.current
          && event.sessionId !== acceptedSessionIdRef.current
        ) {
          return;
        }
        setCaptions((current) => reduceCaptionEvent(current, event));
        setError(null);
        setStatusNotice(null);
        setCaptureState((current) => current === "finalizing" ? current : "capturing");
        if (event.provider && event.provider !== lastProviderRef.current) {
          lastProviderRef.current = event.provider;
          void updatePrefs({ lastProvider: event.provider });
        }
      }),
      subscribeToCaptureToggle(() => {
        void toggleCaptureRef.current();
      }),
      subscribeToSessionStatus((status) => {
        if (
          status.sessionId
          && acceptedSessionIdRef.current
          && status.sessionId !== acceptedSessionIdRef.current
        ) {
          return;
        }
        if (status.state === "idle") {
          setCaptureState("idle");
          setSession(null);
          setError(null);
          setStatusNotice(null);
        }
        if (status.state === "warning") {
          if (status.code === "HISTORY_SAVE_FAILED") setPersistentNotice(status.message ?? "Some captions could not be saved.");
          setStatusNotice(status.message ?? "Caption provider warning");
          if (/reconnect/i.test(status.message ?? "")) setCaptureState("reconnecting");
        }
        if (status.state === "starting" || status.state === "reconnecting" || status.state === "finalizing") {
          setCaptureState(status.state);
          setStatusNotice(status.message ?? null);
        }
        if (status.state === "error") {
          setCaptureState("idle");
          setError(status.message ?? "Caption session failed");
          setSession(null);
          setStatusNotice(null);
        }
        if (status.state === "capturing") {
          setCaptureState("capturing");
          setError(null);
          setStatusNotice(null);
        }
      }),
    ];

    void Promise.all(subscriptions)
      .then((registeredCleanups) => {
        if (disposed) {
          registeredCleanups.forEach((cleanup) => cleanup());
        } else {
          cleanups.push(...registeredCleanups);
        }
      })
      .catch((caught: unknown) => {
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  const placeholder = statusLabel === "No audio detected" ? "Play audio on this computer to see captions."
    : statusLabel === "Starting…" ? "Connecting to captions…"
    : statusLabel === "Reconnecting…" ? "Restoring the connection…"
    : capturing ? "Listening to system audio…" : "Start captions for audio playing on this computer.";
  const displayedText = overlayError
    || (visibleLines.length > 0
      ? visibleLines.map((line) => line.translatedText).join("\n")
      : placeholder);

  useLayoutEffect(() => {
    const captionCopy = captionCopyRef.current;
    if (captionCopy) {
      captionCopy.scrollTop = captionCopy.scrollHeight;
    }
  }, [displayedText]);

  useEffect(() => {
    if (!isTauriRuntime() || document.visibilityState === "hidden") return;
    const visible = new Set(selectVisibleCaptions(captions).lines.map((line) => line.utteranceId));
    const candidates = [...captions.history, ...(captions.active ? [captions.active] : [])]
      .filter((event) => event.timing && visible.has(event.utteranceId) && !measuredRevisions.current.has(`${event.utteranceId}:${event.revision}`));
    let frame = requestAnimationFrame(() => {
      // Two frames give the committed caption a paint opportunity. This is not
      // a compositor/display timestamp; hidden and superseded revisions are skipped.
      frame = requestAnimationFrame(() => {
        for (const event of candidates) {
          const sample = captionTimingSample(event.provider, event.isFinal, event.timing, Date.now());
          measuredRevisions.current.add(`${event.utteranceId}:${event.revision}`);
          if (sample) void invoke("record_caption_timing", { sample }).catch(() => undefined);
        }
        if (measuredRevisions.current.size > 500) measuredRevisions.current = new Set([...measuredRevisions.current].slice(-250));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [captions]);

  return (
    <main className="overlay-shell" onKeyDown={(event) => {
      if (!event.altKey || !event.key.startsWith("Arrow") || !isTauriRuntime()) return;
      event.preventDefault();
      void invoke("move_overlay", { direction: event.key.slice(5).toLowerCase() }).catch((error: unknown) => setError(String(error)));
    }}>
      <div className="caption-overlay">
        <div className="language-picker" aria-label="Caption languages">
          {prefs.recentPairs.length > 0 && (
            <label className="recent-pairs" title="Recent translation pairs">
              <History size={13} aria-hidden="true" />
              <select aria-label="Recent translation pairs" value="" disabled={languagesLocked} onChange={(event) => {
                const pair = prefs.recentPairs[Number(event.target.value)];
                if (pair) void updatePrefs({ translateEnabled: true, sourceLanguage: pair.source, targetLanguage: pair.target, lastTranslationPair: pair })
                  .then(applyPrefs)
                  .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not save the language pair."));
              }}>
                <option value="" disabled>Recent pairs</option>
                {prefs.recentPairs.map((pair, index) => <option key={`${pair.source}-${pair.target}`} value={index}>{LANGUAGE_LABELS[pair.source]} → {LANGUAGE_LABELS[pair.target]}</option>)}
              </select>
            </label>
          )}
          {translating
            ? (
              <LanguageSelect
                label="From"
                value={sourceLanguage}
                onChange={(language) => void persistLanguage("sourceLanguage", language)}
                languages={selectableSourceLanguages}
                allowAuto
                disabled={languagesLocked}
              />
            )
            : (
              <LanguageSelect
                value={targetLanguage}
                onChange={(language) => void persistLanguage("targetLanguage", language)}
                languages={selectableTargetLanguages}
                allowAuto
                disabled={languagesLocked}
              />
            )}
          <button
            type="button"
            className={translating ? "language-translate active" : "language-translate"}
            disabled={languagesLocked}
            aria-pressed={translating}
            aria-label={translating ? "Show captions in one language" : "Translate captions"}
            title={translating ? "Captions in one language" : "Translate captions"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void toggleTranslate()}
          >
            <Languages size={13} />
          </button>
          {translating && (
            <LanguageSelect
              label="To"
              value={targetLanguage}
              onChange={(language) => void persistLanguage("targetLanguage", language)}
              languages={selectableTargetLanguages}
              disabled={languagesLocked}
            />
          )}
          <button type="button" className="language-translate" aria-label="Open Settings" title="Open Settings" onClick={openSettings}><Settings2 size={14} /></button>
          <button type="button" className="language-translate" aria-label="Enable click-through" title={`Click-through · unlock with ${interactionShortcutLabel()}`} onClick={() => { if (isTauriRuntime()) void invoke("set_overlay_click_through", { enabled: true }).catch((error: unknown) => setError(String(error))); }}><MousePointer2 size={14} /></button>
        </div>

        <CaptionPanel
          lines={visibleLines}
          targetLanguage={targetLanguage}
          error={overlayError}
          statusNotice={clickThrough ? `Click-through · ${interactionShortcutLabel()} to unlock` : persistentNotice ?? statusNotice ?? (!capturing ? routeError : null)}
          statusLabel={statusLabel}
          audioLevel={preview.audioLevel ?? (capturing && captureState === "capturing" ? audio.level : 0)}
          announcement={captions.history.filter((caption) => caption.isFinal).at(-1)?.translatedText ?? ""}
          placeholder={placeholder}
          listening={listening}
          copyRef={captionCopyRef}
          showResizeGrip
          onOpenSettings={openSettings}
          captureControl={(
            <button
              type="button"
              className={capturing ? "capture-toggle active" : "capture-toggle"}
              disabled={isTransitioning}
              aria-pressed={capturing}
              aria-label={capturing ? "Stop capturing" : "Start capturing"}
              title={captureHint}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void toggleCapture()}
            >
              {capturing
                ? <Square size={10} fill="currentColor" />
                : <Circle size={11} fill="currentColor" />}
            </button>
          )}
          onDragStart={(event) => {
            if (event.button !== 0 || !isTauriRuntime()) {
              return;
            }
            void getCurrentWindow().startDragging().catch(() => undefined);
          }}
        />
      </div>
    </main>
  );
}

function LanguageSelect({
  label,
  value,
  onChange,
  languages,
  allowAuto = false,
  disabled = false,
}: {
  label?: string;
  value: SupportedLanguage;
  onChange: (value: SupportedLanguage) => void;
  languages: readonly SupportedLanguage[];
  allowAuto?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const choices = allowAuto ? ["auto" as const, ...languages.filter((language) => language !== "auto")] : languages;
  const match = (text: string) => choices.find((language) => LANGUAGE_LABELS[language].toLocaleLowerCase() === text.trim().toLocaleLowerCase() || language === text.trim().toLowerCase());
  const commit = () => { if (draft !== null) { const language = match(draft); if (language) onChange(language); } setDraft(null); };
  return (
    <label className="language-select">
      {label ? <span>{label}</span> : null}
      <input
        list={id}
        value={draft ?? LANGUAGE_LABELS[value]}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-label={label ?? "Caption language"}
        title={disabled ? "Stop to change languages" : "Type to find a language"}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => { setDraft(event.target.value); const language = match(event.target.value); if (language && LANGUAGE_LABELS[language] === event.target.value) onChange(language); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setDraft(null); }}
        onMouseDown={(event) => event.stopPropagation()}
      />
      <datalist id={id}>{choices.map((language) => <option key={language} value={LANGUAGE_LABELS[language]} />)}</datalist>
      <ChevronDown className="select-chevron" size={12} aria-hidden="true" />
    </label>
  );
}
