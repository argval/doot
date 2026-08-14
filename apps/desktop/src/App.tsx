import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Circle, Languages, Square } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  groupedCaptionLanguages,
  LANGUAGE_LABELS,
  SUPPORTED_SOURCE_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  type SupportedLanguage,
} from "@doot/protocol";
import {
  EMPTY_CAPTION_STATE,
  reduceCaptionEvent,
  selectVisibleCaptions,
} from "./captions";
import {
  startCaptionSession,
  stopCaptionSession,
  subscribeToCaptions,
  subscribeToCaptureToggle,
  subscribeToSessionStatus,
  type DesktopSession,
} from "./lib/tauri";
import {
  DEFAULT_PREFS,
  applyOverlayAppearance,
  loadPrefs,
  subscribeToPrefs,
  updatePrefs,
  type DesktopPrefs,
} from "./lib/prefs";

const selectableSourceLanguages = SUPPORTED_SOURCE_LANGUAGES.filter(
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
  const acceptedSessionIdRef = useRef<string | null>(null);
  const lastProviderRef = useRef<string | null>(DEFAULT_PREFS.lastProvider);
  const captionCopyRef = useRef<HTMLDivElement>(null);
  const visibleLines = selectVisibleCaptions(captions).lines;
  const sourceLanguage = prefs.sourceLanguage;
  const targetLanguage = prefs.targetLanguage;

  const applyPrefs = useCallback((next: DesktopPrefs) => {
    lastProviderRef.current = next.lastProvider;
    setPrefs(next);
    applyOverlayAppearance(next);
  }, []);

  const persistLanguage = useCallback(async (
    key: "sourceLanguage" | "targetLanguage",
    value: SupportedLanguage,
  ) => {
    setPrefs((current) => {
      const next = { ...current, [key]: value };
      applyOverlayAppearance(next);
      return next;
    });
    await updatePrefs({ [key]: value });
  }, []);

  const toggleCapture = useCallback(async () => {
    if (isTransitioning) return;

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
        setCaptions(EMPTY_CAPTION_STATE);
        const next = await startCaptionSession(sourceLanguage, targetLanguage);
        acceptedSessionIdRef.current = next.sessionId;
        setSession(next);
        if (next.provider && next.provider !== lastProviderRef.current) {
          lastProviderRef.current = next.provider;
          void updatePrefs({ lastProvider: next.provider });
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsTransitioning(false);
    }
  }, [isTransitioning, session, sourceLanguage, targetLanguage]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void loadPrefs().then((loaded) => {
      if (!disposed) {
        applyPrefs(loaded);
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

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const subscriptions = [
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
        if (event.provider && event.provider !== lastProviderRef.current) {
          lastProviderRef.current = event.provider;
          void updatePrefs({ lastProvider: event.provider });
        }
      }),
      subscribeToCaptureToggle(() => {
        void toggleCapture();
      }),
      subscribeToSessionStatus((status) => {
        if (
          status.sessionId
          && acceptedSessionIdRef.current
          && status.sessionId !== acceptedSessionIdRef.current
          && status.state !== "idle"
        ) {
          return;
        }
        if (status.state === "idle") {
          setSession(null);
          setError(null);
          setStatusNotice(null);
        }
        if (status.state === "warning") {
          setStatusNotice(status.message ?? "Caption provider warning");
        }
        if (status.state === "error") {
          setError(status.message ?? "Caption session failed");
          setSession(null);
          setStatusNotice(null);
        }
        if (status.state === "capturing") {
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
  }, [toggleCapture]);

  const placeholder = session
    ? "Listening to system audio…"
    : "Your live captions will appear here.";
  const displayedText = error
    || (visibleLines.length > 0
      ? visibleLines.map((line) => line.translatedText).join("\n")
      : placeholder);

  useLayoutEffect(() => {
    const captionCopy = captionCopyRef.current;
    if (captionCopy) {
      captionCopy.scrollTop = captionCopy.scrollHeight;
    }
  }, [displayedText]);

  return (
    <main className="overlay-shell">
      <div className="caption-overlay">
        <div className="language-picker" aria-label="Caption languages">
          <LanguageSelect
            label="From"
            value={sourceLanguage}
            onChange={(language) => void persistLanguage("sourceLanguage", language)}
            languages={selectableSourceLanguages}
            allowAuto
            disabled={session !== null || isTransitioning}
          />
          <span className="language-divider"><Languages size={13} /></span>
          <LanguageSelect
            label="To"
            value={targetLanguage}
            onChange={(language) => void persistLanguage("targetLanguage", language)}
            languages={selectableTargetLanguages}
            disabled={session !== null || isTransitioning}
          />
          <button
            type="button"
            className={session ? "capture-toggle active" : "capture-toggle"}
            disabled={isTransitioning}
            aria-label={session ? "Stop capturing" : "Start capturing"}
            title={session ? "Stop capturing (⌘⇧D)" : "Start capturing (⌘⇧D)"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void toggleCapture()}
          >
            {session
              ? <Square size={10} fill="currentColor" />
              : <Circle size={11} fill="currentColor" />}
          </button>
        </div>

        <section
          className="caption-window"
          aria-label="Doot live captions"
          onMouseDown={(event) => {
            if (event.button === 0) {
              void getCurrentWindow().startDragging().catch(() => undefined);
            }
          }}
        >
          <div ref={captionCopyRef} className="caption-copy">
            {error ? (
              <p className="caption-text error-text" aria-live="polite">{error}</p>
            ) : visibleLines.length > 0 ? (
              <div className="caption-lines" aria-live="polite">
                {visibleLines.map((line) => (
                  <p
                    key={line.utteranceId}
                    className={line.isActive
                      ? "caption-text caption-turn live"
                      : "caption-text caption-turn"}
                  >
                    {line.translatedText}
                  </p>
                ))}
              </div>
            ) : (
              <p className="caption-text placeholder">{placeholder}</p>
            )}
          </div>
          {!error && statusNotice && (
            <p className="caption-notice" role="status">{statusNotice}</p>
          )}
        </section>
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
  label: string;
  value: SupportedLanguage;
  onChange: (value: SupportedLanguage) => void;
  languages: readonly SupportedLanguage[];
  allowAuto?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="language-select">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as SupportedLanguage)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {allowAuto && <option value="auto">{LANGUAGE_LABELS.auto}</option>}
        {groupedCaptionLanguages(languages).map((group) => (
          <optgroup key={group.id} label={group.label}>
            {group.languages.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_LABELS[language]}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown className="select-chevron" size={12} aria-hidden="true" />
    </label>
  );
}
