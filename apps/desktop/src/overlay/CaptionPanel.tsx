import type { MouseEvent, Ref } from "react";
import { INDIC_LANGUAGES, type SupportedLanguage } from "@doot/protocol";
import type { VisibleCaptionLine } from "../captions";

const RTL_LANGUAGES = new Set<SupportedLanguage>(["ar", "fa", "he", "ks", "sd", "ur"]);
const CJK_LANGUAGES = new Set<SupportedLanguage>(["ja", "ko", "zh"]);
const INDIC_LANGUAGE_SET = new Set<string>(INDIC_LANGUAGES);

export type CaptionScript = "latin" | "indic" | "cjk" | "rtl";

export function captionScript(language: SupportedLanguage): CaptionScript {
  if (RTL_LANGUAGES.has(language)) {
    return "rtl";
  }
  if (language !== "auto" && INDIC_LANGUAGE_SET.has(language)) {
    return "indic";
  }
  if (CJK_LANGUAGES.has(language)) {
    return "cjk";
  }
  return "latin";
}

export function captionDocumentLang(language: SupportedLanguage): string {
  if (language === "auto") {
    return "en";
  }
  if (language === "od") {
    return "or";
  }
  return language;
}

export function CaptionPanel({
  lines,
  targetLanguage,
  error,
  statusNotice,
  placeholder,
  listening = false,
  copyRef,
  onDragStart,
  onOpenSettings,
  showResizeGrip = false,
}: {
  lines: readonly VisibleCaptionLine[];
  targetLanguage: SupportedLanguage;
  error: string | null;
  statusNotice: string | null;
  placeholder: string;
  listening?: boolean;
  copyRef?: Ref<HTMLDivElement>;
  onDragStart?: (event: MouseEvent<HTMLElement>) => void;
  onOpenSettings?: () => void;
  showResizeGrip?: boolean;
}) {
  const script = captionScript(targetLanguage);

  return (
    <section
      className="caption-window"
      aria-label="Doot live captions"
      lang={captionDocumentLang(targetLanguage)}
      dir={script === "rtl" ? "rtl" : "ltr"}
      data-script={script}
      onMouseDown={onDragStart}
    >
      <span className="caption-grain" aria-hidden="true" />
      <div ref={copyRef} className="caption-copy">
        {error ? (
          <div className="caption-error" aria-live="polite">
            <p className="caption-text error-text">{error}</p>
            {onOpenSettings && (
              <button
                type="button"
                className="caption-error-action"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={onOpenSettings}
              >
                Open Settings
              </button>
            )}
          </div>
        ) : lines.length > 0 ? (
          <div className="caption-lines" aria-live="polite">
            {lines.map((line) => (
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
          <p className={listening ? "caption-text placeholder listening" : "caption-text placeholder"}>
            {listening && <AudioBars />}
            {placeholder}
          </p>
        )}
      </div>
      {!error && statusNotice && (
        <p className="caption-notice" role="status">{statusNotice}</p>
      )}
      {showResizeGrip && (
        <span
          className="resize-grip"
          aria-hidden="true"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M9 1L1 9M9 5L5 9M9 8.2L8.2 9"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </span>
      )}
    </section>
  );
}

function AudioBars() {
  return (
    <span className="audio-bars" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
