import {
  LANGUAGE_LABELS,
  SUPPORTED_TARGET_LANGUAGES,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import type {
  TextTranslationProvider,
  TranslationRequest,
} from "../contract.js";
import { isRecord } from "../../util.js";

export const GEMINI_TEXT_TRANSLATE_MODEL = "gemini-2.5-flash";
const GEMINI_TRANSLATE_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_TRANSLATE_MODEL}:generateContent`;
const TRANSLATION_TIMEOUT_MS = 12_000;

export class GeminiTextTranslator implements TextTranslationProvider {
  id = "gemini";
  configured: boolean;
  readonly targetLanguages: readonly SupportedTargetLanguage[] = SUPPORTED_TARGET_LANGUAGES;

  constructor(
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.configured = Boolean(apiKey);
  }

  supports(request: TranslationRequest): boolean {
    return this.configured;
  }

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim();
    if (!text) return "";
    if (request.source !== "auto" && request.source === request.target) return text;
    if (!this.apiKey) throw new Error("Gemini translation is not configured");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${GEMINI_TRANSLATE_URL}?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are a live-caption translator. Reply with only the translated caption text. Preserve names, numbers, and code-mixed words. Do not add quotes or notes.",
            }],
          },
          contents: [{
            parts: [{ text: translationPrompt(request.source, request.target, text) }],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1024,
          },
        }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readGeminiTranslationError(body, response.status));
      }
      const translated = readGeminiTranslationText(body);
      if (!translated) {
        throw new Error("Gemini translation returned an invalid response");
      }
      return unwrapTranslation(translated);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Gemini translation timed out");
      }
      throw error instanceof Error ? error : new Error("Gemini translation failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function translationPrompt(
  source: TranslationRequest["source"],
  target: TranslationRequest["target"],
  text: string,
): string {
  const targetLabel = LANGUAGE_LABELS[target];
  if (source === "auto") {
    return `Detect the source language and translate this caption into ${targetLabel}:\n\n${text}`;
  }
  return `Translate this ${LANGUAGE_LABELS[source]} caption into ${targetLabel}:\n\n${text}`;
}

function unwrapTranslation(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readGeminiTranslationText(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.candidates)) return undefined;
  const first = body.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) {
    return undefined;
  }
  const texts = first.content.parts.flatMap((part) => {
    if (!isRecord(part) || typeof part.text !== "string") return [];
    const value = part.text.trim();
    return value ? [value] : [];
  });
  return texts.join(" ").trim() || undefined;
}

function readGeminiTranslationError(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  return `Gemini translation failed (HTTP ${status})`;
}
