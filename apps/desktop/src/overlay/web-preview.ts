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

export function webPreviewCaptionLines(): readonly VisibleCaptionLine[] | null {
  return previewMode() === "captions-indic"
    ? PREVIEW_LINES_INDIC
    : previewMode() === "captions"
    ? PREVIEW_LINES
    : null;
}

export function webPreviewTargetLanguage(): SupportedLanguage | null {
  return previewMode() === "captions-indic" ? "kn" : null;
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
