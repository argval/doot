import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Circle, Languages, Square } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
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

const selectableLanguages = SUPPORTED_LANGUAGES.filter(
  (language) => language !== "auto",
);

export function App() {
  const [sourceLanguage, setSourceLanguage] = useState<SupportedLanguage>("auto");
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>("en");
  const [captions, setCaptions] = useState(EMPTY_CAPTION_STATE);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const acceptedSessionIdRef = useRef<string | null>(null);
  const visibleCaptions = selectVisibleCaptions(captions);

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
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsTransitioning(false);
    }
  }, [isTransitioning, session, sourceLanguage, targetLanguage]);

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

  const displayedText = error
    || visibleCaptions.translatedText
    || (session
      ? "Listening to system audio…"
      : "Your live captions will appear here.");
  const showSource = !error
    && visibleCaptions.sourceText
    && visibleCaptions.sourceText !== visibleCaptions.translatedText;

  return (
    <main className="overlay-shell">
      <div className="caption-overlay">
        <div className="language-picker" aria-label="Caption languages">
          <LanguageSelect
            label="From"
            value={sourceLanguage}
            onChange={setSourceLanguage}
            allowAuto
            disabled={session !== null || isTransitioning}
          />
          <span className="language-divider"><Languages size={13} /></span>
          <LanguageSelect
            label="To"
            value={targetLanguage}
            onChange={setTargetLanguage}
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
          <div className="caption-copy">
            <p
              className={error
                ? "caption-text error-text"
                : visibleCaptions.translatedText
                  ? "caption-text"
                  : "caption-text placeholder"}
              aria-live="polite"
            >
              {displayedText}
            </p>
            {showSource && <p className="source-text">{visibleCaptions.sourceText}</p>}
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
  allowAuto = false,
  disabled = false,
}: {
  label: string;
  value: SupportedLanguage;
  onChange: (value: SupportedLanguage) => void;
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
        {selectableLanguages.map((language) => (
          <option key={language} value={language}>
            {LANGUAGE_LABELS[language]}
          </option>
        ))}
      </select>
      <ChevronDown className="select-chevron" size={12} aria-hidden="true" />
    </label>
  );
}
