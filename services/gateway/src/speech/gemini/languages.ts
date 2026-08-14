import {
  INTERNATIONAL_LANGUAGES,
  type SupportedLanguage,
  type SupportedTargetLanguage,
} from "@doot/protocol";

export const GEMINI_LIVE_TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
export const GEMINI_LIVE_TRANSLATE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Indic languages Gemini Live Translate covers in addition to the international set. */
const GEMINI_LIVE_INDIC_LANGUAGES = [
  "hi",
  "bn",
  "gu",
  "kn",
  "ml",
  "mr",
  "pa",
  "ta",
  "te",
  "ur",
  "ne",
  "sd",
] as const satisfies readonly SupportedLanguage[];

export const GEMINI_LIVE_SOURCE_LANGUAGES = [
  "auto",
  ...INTERNATIONAL_LANGUAGES,
  ...GEMINI_LIVE_INDIC_LANGUAGES,
] as const satisfies readonly SupportedLanguage[];

export const GEMINI_LIVE_TARGET_LANGUAGES = [
  ...INTERNATIONAL_LANGUAGES,
  ...GEMINI_LIVE_INDIC_LANGUAGES,
] as const satisfies readonly SupportedTargetLanguage[];

/** Map doot language ids onto Gemini Live Translate BCP-47 codes. */
export function toGeminiLanguageCode(
  language: SupportedLanguage | SupportedTargetLanguage,
): string {
  if (language === "zh") return "zh-Hans";
  if (language === "pt") return "pt-BR";
  return language;
}

/** Normalize BCP-47 / Gemini codes down to doot language ids. */
export function normalizeGeminiLanguageCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const primary = code.trim().toLowerCase().split(/[-_]/)[0];
  return primary || undefined;
}

export function geminiLanguageCodeMatches(
  code: string | undefined,
  expected: SupportedLanguage | SupportedTargetLanguage,
): boolean {
  const normalized = normalizeGeminiLanguageCode(code);
  if (!normalized) return true; // unknown — allow and rely on content filters
  return normalized === expected;
}

const LANGUAGE_MARKERS: Record<string, RegExp> = {
  en: /\b(the|and|that|with|from|this|have|will|would|they|their|when|than|today|country|little|tougher|invoke|enemies|ran|run|know)\b/gi,
  es: /\b(el|la|los|las|un|una|del|que|por|para|como|pero|aunque|también|despues|después|permite|años|anos|vigente|aun|aún|migrantes|catorce|arrestar|deportar|esta|este|ley|sigue|hoy|mayores|siglos|cargos|acargos)\b/gi,
  fr: /\b(le|les|une|des|dans|pour|avec|est|sont|pas|plus|comme|cette|cet|ces|encore|après|apres|vigueur|siècles|siecles|loi|permet|arrêter|arreter|deux|migrants)\b/gi,
  de: /\b(der|die|das|und|ist|nicht|mit|von|für|den|dem|ein|eine|auch|dieses|diese|dieser|gesetz|noch|kraft|erlaubt|migranten|verhaften|heute|jahrhunderte)\b/gi,
  hi: /[\u0900-\u097F]/g,
};

/** Marker density score for Gemini source-leak filtering (higher = stronger match). */
export function geminiLanguageScore(text: string, language: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  const pattern = LANGUAGE_MARKERS[language];
  if (!pattern) return 0;
  return normalized.match(pattern)?.length ?? 0;
}

export function looksLikeGeminiLanguage(text: string, language: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const score = geminiLanguageScore(normalized, language);
  if (language === "hi") return score >= 2;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // Short fragments need fewer hits; longer ones need a clearer signal.
  const threshold = words.length <= 4 ? 1 : Math.max(2, Math.floor(words.length * 0.18));
  return score >= threshold;
}

function splitGeminiCaptionParts(text: string): string[] {
  // Sentence endings only — do not split on ", Capital" (German nouns break that).
  // Include Hindi danda । so Devanagari + Latin mixes can be filtered per clause.
  return text
    .split(/(?<=[.!?…।])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Keep only caption segments that match the requested target language.
 * Gemini Live Translate often leaks source-language text into outputTranscription
 * for Spanish, French, German, and other international pairs — not Spanish alone.
 */
export function filterGeminiTranslationToTarget(
  text: string,
  target: SupportedTargetLanguage,
  source: SupportedLanguage,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (source === target || source === "auto") return normalized;
  if (!LANGUAGE_MARKERS[target]) return normalized;

  const parts = splitGeminiCaptionParts(normalized);
  const kept: string[] = [];
  for (const part of parts) {
    const targetScore = geminiLanguageScore(part, target);
    const sourceScore = geminiLanguageScore(part, source);
    // Prefer target when both Romance markers fire; drop clear source leaks.
    if (targetScore > sourceScore) {
      kept.push(part);
      continue;
    }
    if (targetScore > 0 && sourceScore === 0) {
      kept.push(part);
      continue;
    }
    // Short English Gemini chunks often lack function-word markers ("opportunity").
    // Keep marker-less Latin only when targeting English from a non-English source.
    if (
      sourceScore === 0
      && targetScore === 0
      && target === "en"
      && source !== "en"
      && /[A-Za-z]/.test(part)
    ) {
      kept.push(part);
    }
  }

  if (kept.length === 0) return "";
  return kept.join(" ").replace(/\s+/g, " ").trim();
}