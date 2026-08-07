import { useEffect, useState } from "react";
import { Languages, Mic2, Settings2, Square, Waves } from "lucide-react";
import type { CaptionEvent, SupportedLanguage } from "@doot/protocol";
import { startCaptionSession, stopCaptionSession, subscribeToCaptions } from "./lib/tauri";

const languages: Array<{ id: SupportedLanguage; label: string }> = [
  { id: "en", label: "English" },
  { id: "hi", label: "Hindi" },
  { id: "ta", label: "Tamil" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
];

export function App() {
  const [sourceLanguage, setSourceLanguage] = useState<SupportedLanguage>("auto");
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>("en");
  const [caption, setCaption] = useState<CaptionEvent | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void subscribeToCaptions(setCaption).then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => unsubscribe?.();
  }, []);

  async function toggleSession() {
    setError(null);
    try {
      if (sessionId) {
        await stopCaptionSession(sessionId);
        setSessionId(null);
        return;
      }
      const session = await startCaptionSession(sourceLanguage, targetLanguage);
      setSessionId(session.sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="brand"><span className="brand-mark"><Waves size={17} /></span><span>DOOT</span></div>
        <div className="status"><span className={sessionId ? "status-dot live" : "status-dot"} />{sessionId ? "LISTENING" : "READY"}</div>
      </header>

      <section className="hero">
        <div className="eyebrow"><Mic2 size={14} /> SYSTEM AUDIO CAPTURE</div>
        <h1>Understand what’s<br /><em>being said.</em></h1>
        <p className="lede">A quiet translation layer for videos, streams, meetings, and anything else playing on your computer.</p>
      </section>

      <section className="panel">
        <div className="panel-heading"><span>LIVE SESSION</span><span className="session-badge">LOCAL ENGINE</span></div>
        <div className="language-row">
          <LanguageSelect label="HEARING" value={sourceLanguage} onChange={setSourceLanguage} allowAuto />
          <div className="swap"><Languages size={16} /></div>
          <LanguageSelect label="READING" value={targetLanguage} onChange={setTargetLanguage} />
        </div>
        <button className={sessionId ? "capture-button active" : "capture-button"} onClick={() => void toggleSession()}>
          {sessionId ? <Square size={17} fill="currentColor" /> : <Mic2 size={19} />}
          {sessionId ? "STOP CAPTURING" : "START CAPTURING"}
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="caption-card" aria-live="polite">
        <div className="caption-meta"><span>TRANSLATED CAPTION</span><span>{caption?.isFinal ? "FINAL" : "WAITING FOR AUDIO"}</span></div>
        <p className="caption-text">{caption?.translatedText ?? "Start a session and captions will appear here."}</p>
        {caption && <p className="source-text">{caption.sourceText}</p>}
      </section>

      <footer><span><Settings2 size={14} /> Preferences</span><span>v0.1.0 · Prototype</span></footer>
    </main>
  );
}

function LanguageSelect({ label, value, onChange, allowAuto = false }: { label: string; value: SupportedLanguage; onChange: (value: SupportedLanguage) => void; allowAuto?: boolean }) {
  return <label className="language-select"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value as SupportedLanguage)}>{allowAuto && <option value="auto">Auto-detect</option>}{languages.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}</select></label>;
}
