import * as React from "react";
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
    return "";
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
  captureControl,
  audioLevel = 0,
  statusLabel,
  announcement = "",
}: {
  lines: readonly VisibleCaptionLine[];
  targetLanguage: SupportedLanguage;
  error: string | null;
  statusNotice: string | null;
  placeholder: string;
  listening?: boolean;
  copyRef?: React.Ref<HTMLDivElement>;
  onDragStart?: (event: React.MouseEvent<HTMLElement>) => void;
  onOpenSettings?: () => void;
  showResizeGrip?: boolean;
  captureControl?: React.ReactNode;
  audioLevel?: number;
  statusLabel?: string;
  announcement?: string;
}) {
  const text = lines.at(-1)?.translatedText ?? "";
  const script = targetLanguage !== "auto" ? captionScript(targetLanguage)
    : /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text) ? "rtl"
    : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) ? "cjk"
    : /[\u0900-\u0DFF]/u.test(text) ? "indic" : "latin";

  return (
    <section
      className="caption-window"
      aria-label="Doot live captions"
      lang={captionDocumentLang(targetLanguage)}
      dir={targetLanguage === "auto" ? "auto" : script === "rtl" ? "rtl" : "ltr"}
      data-script={script}
      onMouseDown={onDragStart}
    >
      {captureControl}
      <div ref={copyRef} className="caption-copy">
        {error && lines.length === 0 ? (
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
          <div className="caption-lines" aria-live="off">
            {lines.map((line) => (
              <p
                key={line.utteranceId}
                dir={targetLanguage === "auto" ? "auto" : undefined}
                data-speaker={line.speakerTint}
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
            {listening && !statusLabel && <AudioBars level={audioLevel} />}
            {placeholder}
          </p>
        )}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
      {statusLabel && (
        <div className="caption-status">
          <AudioBars level={audioLevel} />
          <span role="status">{statusLabel}</span>
        </div>
      )}
      {(statusNotice || (error && lines.length > 0)) && (
        <div className="caption-notice" role="status">
          <span>{error ?? statusNotice}</span>
          {onOpenSettings && <button type="button" className="caption-error-action" onMouseDown={(event) => event.stopPropagation()} onClick={onOpenSettings}>Open Settings</button>}
        </div>
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

function AudioBars({ level }: { level: number }) {
  const amplitude = Math.min(1, Math.max(0, Math.sqrt(level) * 3));
  return (
    <span className="audio-bars" aria-hidden="true">
      {[0.6, 1, 0.8, 0.5].map((weight, index) => <span key={index} style={{ height: `${15 + amplitude * weight * 85}%` }} />)}
    </span>
  );
}
