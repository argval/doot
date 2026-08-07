import { useEffect, useState } from "react";
import { ChevronDown, Languages } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CaptionEvent, SupportedLanguage } from "@doot/protocol";
import { subscribeToCaptions } from "./lib/tauri";

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

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void subscribeToCaptions(setCaption).then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => unsubscribe?.();
  }, []);

  return (
    <main className="overlay-shell">
      <div className="caption-overlay">
        <div className="language-picker" aria-label="Caption languages">
          <LanguageSelect label="From" value={sourceLanguage} onChange={setSourceLanguage} allowAuto />
          <span className="language-divider"><Languages size={13} /></span>
          <LanguageSelect label="To" value={targetLanguage} onChange={setTargetLanguage} />
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
          <p className={caption?.translatedText ? "caption-text" : "caption-text placeholder"} aria-live="polite">
            {caption?.translatedText ?? "Your live captions will appear here."}
          </p>
          {caption?.sourceText && <p className="source-text">{caption.sourceText}</p>}
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
}: {
  label: string;
  value: SupportedLanguage;
  onChange: (value: SupportedLanguage) => void;
  allowAuto?: boolean;
}) {
  return (
    <label className="language-select">
      <span>{label}</span>
      <select
        value={value}
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
