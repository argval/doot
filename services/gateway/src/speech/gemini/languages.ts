import type {
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

export const GEMINI_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
export const GEMINI_LIVE_TRANSLATE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const GEMINI_POC_SOURCE_LANGUAGES = [
  "en",
  "hi",
  "es",
  "fr",
  "de",
] as const satisfies readonly SupportedLanguage[];

export const GEMINI_POC_TARGET_LANGUAGES = [
  "en",
  "hi",
  "es",
] as const satisfies readonly SupportedTargetLanguage[];
