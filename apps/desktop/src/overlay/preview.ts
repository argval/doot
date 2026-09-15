import type { SupportedLanguage } from "@doot/protocol";
import type { VisibleCaptionLine } from "../captions";
import { captionScript } from "./CaptionPanel";

const PREVIEW_LATIN: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-1",
    translatedText: "Earlier turns stay on their own lines, a little quieter.",
    isActive: false,
    speakerTint: 2,
  },
  {
    utteranceId: "settings-preview-2",
    translatedText: "The live caption keeps updating as you speak.",
    isActive: true,
  },
];

const PREVIEW_INDIC: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-kn-1",
    translatedText: "ಹಿಂದಿನ ವಾಕ್ಯವು ತನ್ನ ಸಾಲಿನಲ್ಲಿಯೇ ಉಳಿಯುತ್ತದೆ.",
    isActive: false,
  },
  {
    utteranceId: "settings-preview-kn-2",
    translatedText: "ನೇರ ಶೀರ್ಷಿಕೆ ಮಾತು ಬಂದಂತೆ ನವೀಕರಿಸುತ್ತದೆ.",
    isActive: true,
  },
];

const PREVIEW_CJK: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-ja-1",
    translatedText: "前の発話は少し控えめに残ります。",
    isActive: false,
  },
  {
    utteranceId: "settings-preview-ja-2",
    translatedText: "ライブ字幕は話している最中に更新されます。",
    isActive: true,
  },
];

const PREVIEW_RTL: readonly VisibleCaptionLine[] = [
  {
    utteranceId: "settings-preview-ar-1",
    translatedText: "تبقى الجمل السابقة في أسطرها بهدوء أكبر.",
    isActive: false,
  },
  {
    utteranceId: "settings-preview-ar-2",
    translatedText: "يتحدّث السطر المباشر أثناء الكلام.",
    isActive: true,
  },
];

export function previewTargetLanguage(language: SupportedLanguage): SupportedLanguage {
  switch (captionScript(language)) {
    case "indic": return "kn";
    case "cjk": return "ja";
    case "rtl": return "ar";
    default: return "en";
  }
}

export function previewLinesFor(language: SupportedLanguage): readonly VisibleCaptionLine[] {
  switch (captionScript(previewTargetLanguage(language))) {
    case "indic":
      return PREVIEW_INDIC;
    case "cjk":
      return PREVIEW_CJK;
    case "rtl":
      return PREVIEW_RTL;
    default:
      return PREVIEW_LATIN;
  }
}

