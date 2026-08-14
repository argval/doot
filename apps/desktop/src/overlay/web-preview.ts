import type { SupportedLanguage } from "@doot/protocol";
import type { VisibleCaptionLine } from "../captions";

const PREVIEW_LINES: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "preview-1",
    translatedText: "Earlier turns stay on their own lines, a little quieter.",
    isActive: false,
  },
  {
    utteranceId: "preview-2",
    translatedText: "A new speaker or long pause starts the next caption.",
    isActive: false,
  },
  {
    utteranceId: "preview-3",
    translatedText: "The live line keeps updating as speech comes in.",
    isActive: true,
  },
];

const PREVIEW_LINES_INDIC: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "preview-kn-1",
    translatedText: "ಹಿಂದಿನ ವಾಕ್ಯವು ತನ್ನ ಸಾಲಿನಲ್ಲಿಯೇ ಉಳಿಯುತ್ತದೆ.",
    isActive: false,
  },
  {
    utteranceId: "preview-kn-2",
    translatedText: "ಪ್ರತಿ ತಿರುವು ಹೊಸ ಸಾಲಿನಲ್ಲಿ ಕಾಣಿಸಿಕೊಳ್ಳುತ್ತದೆ.",
    isActive: false,
  },
  {
    utteranceId: "preview-kn-3",
    translatedText: "ನೇರ ಶೀರ್ಷಿಕೆ ಮಾತು ಬಂದಂತೆ ನವೀಕರಿಸುತ್ತದೆ.",
    isActive: true,
  },
];

const PREVIEW_ERROR = "Gateway unreachable. Check Settings → Connection.";

export interface OverlayWebPreview {
  lines: readonly VisibleCaptionLine[] | null;
  error: string | null;
  capturing: boolean;
  targetLanguage: SupportedLanguage | null;
}

const IDLE_PREVIEW: OverlayWebPreview = {
  lines: null,
  error: null,
  capturing: false,
  targetLanguage: null,
};

export function overlayWebPreview(): OverlayWebPreview {
  const mode = previewMode();
  if (mode === "captions-indic") {
    return {
      lines: PREVIEW_LINES_INDIC,
      error: null,
      capturing: true,
      targetLanguage: "kn",
    };
  }
  if (mode === "captions") {
    return {
      lines: PREVIEW_LINES,
      error: null,
      capturing: true,
      targetLanguage: null,
    };
  }
  if (mode === "listening") {
    return {
      lines: null,
      error: null,
      capturing: true,
      targetLanguage: null,
    };
  }
  if (mode === "error") {
    return {
      lines: null,
      error: PREVIEW_ERROR,
      capturing: false,
      targetLanguage: null,
    };
  }
  return IDLE_PREVIEW;
}

function previewMode(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  if (!document.documentElement.classList.contains("web-preview")) {
    return null;
  }
  return new URLSearchParams(window.location.search).get("preview");
}
