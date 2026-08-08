import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Circle, Languages, Square } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CaptionEvent, SupportedLanguage } from "@doot/protocol";
import {
  startCaptionSession,
  stopCaptionSession,
  subscribeToCaptions,
  subscribeToCaptureToggle,
  subscribeToSessionStatus,
  type DesktopSession,
} from "./lib/tauri";

const languages: Array<{ id: SupportedLanguage; label: string }> = [
  { id: "en", label: "English" },
  { id: "hi", label: "Hindi" },
  { id: "ta", label: "Tamil" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
];

const MAX_TRANSCRIPT_CHARACTERS = 520;
const MAX_OVERLAP_WORDS = 12;
const EMPTY_TRANSCRIPT: CaptionTranscript = {
  translatedText: "",
  sourceText: "",
};

interface CaptionTranscript {
  translatedText: string;
  sourceText: string;
}

export function App() {
  const [sourceLanguage, setSourceLanguage] = useState<SupportedLanguage>("auto");
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>("en");
  const [transcript, setTranscript] = useState<CaptionTranscript>(EMPTY_TRANSCRIPT);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const toggleCapture = useCallback(async () => {
    if (isTransitioning) return;

    setIsTransitioning(true);
    setError(null);
    setStatusNotice(null);
    try {
      if (session) {
        await stopCaptionSession(session.sessionId);
        setSession(null);
        setTranscript(EMPTY_TRANSCRIPT);
      } else {
        setTranscript(EMPTY_TRANSCRIPT);
        setSession(await startCaptionSession(sourceLanguage, targetLanguage));
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
        setTranscript((current) => appendCaptionEvent(current, event));
        setError(null);
        setStatusNotice(null);
      }),
      subscribeToCaptureToggle(() => {
        void toggleCapture();
      }),
      subscribeToSessionStatus((status) => {
        if (status.state === "idle") {
          setSession(null);
          setTranscript(EMPTY_TRANSCRIPT);
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
            {session ? <Square size={10} fill="currentColor" /> : <Circle size={11} fill="currentColor" />}
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
              className={error ? "caption-text error-text" : transcript.translatedText ? "caption-text" : "caption-text placeholder"}
              aria-live="polite"
            >
              {error ?? transcript.translatedText ?? (session ? "Listening to system audio…" : "Your live captions will appear here.")}
            </p>
            {!error
              && transcript.sourceText
              && transcript.sourceText !== transcript.translatedText
              && <p className="source-text">{transcript.sourceText}</p>}
          </div>
          {!error && statusNotice && <p className="caption-notice" role="status">{statusNotice}</p>}
        </section>
      </div>
    </main>
  );
}

function appendCaptionEvent(current: CaptionTranscript, event: CaptionEvent): CaptionTranscript {
  return {
    translatedText: mergeCaptionText(current.translatedText, event.translatedText),
    sourceText: event.sourceText
      ? mergeCaptionText(current.sourceText, event.sourceText)
      : current.sourceText,
  };
}

function mergeCaptionText(existing: string, incoming: string): string {
  const cleanIncoming = normalizeCaptionText(incoming);
  if (!cleanIncoming) return existing;
  if (!existing) return trimTranscript(cleanIncoming);

  const cleanExisting = normalizeCaptionText(existing);
  if (
    cleanExisting === cleanIncoming
    || cleanExisting.endsWith(cleanIncoming)
  ) {
    return existing;
  }

  const existingWords = existing.split(/\s+/);
  const incomingWords = cleanIncoming.split(/\s+/);
  const overlapLimit = Math.min(MAX_OVERLAP_WORDS, existingWords.length, incomingWords.length);

  for (let overlap = overlapLimit; overlap > 0; overlap -= 1) {
    const matches = incomingWords
      .slice(0, overlap)
      .every((word, index) => normalizeCaptionWord(word) === normalizeCaptionWord(existingWords[existingWords.length - overlap + index] ?? ""));
    if (matches) {
      const continuation = incomingWords.slice(overlap).join(" ");
      return continuation ? trimTranscript(`${existing} ${continuation}`) : existing;
    }
  }

  return trimTranscript(`${existing} ${cleanIncoming}`);
}

function normalizeCaptionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCaptionWord(value: string): string {
  return value.toLocaleLowerCase().replace(/[.,!?;:()[\]{}"'“”‘’…।]/g, "");
}

function trimTranscript(value: string): string {
  if (value.length <= MAX_TRANSCRIPT_CHARACTERS) return value;

  const firstVisibleCharacter = value.indexOf(" ", value.length - MAX_TRANSCRIPT_CHARACTERS);
  return `…${value.slice(firstVisibleCharacter >= 0 ? firstVisibleCharacter + 1 : -MAX_TRANSCRIPT_CHARACTERS)}`;
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
        {allowAuto && <option value="auto">Auto</option>}
        {languages.map((language) => (
          <option key={language.id} value={language.id}>{language.label}</option>
        ))}
      </select>
      <ChevronDown className="select-chevron" size={12} aria-hidden="true" />
    </label>
  );
}
