import type {
  TextTranslationProvider,
  TranslationRequest,
} from "../contract.js";
import { isRecord } from "../../util.js";
import {
  isDeepLTranslationSource,
  isDeepLTranslationTarget,
  resolveDeepLApiBaseUrl,
  toDeepLSourceLanguageCode,
  toDeepLTargetLanguageCode,
} from "./languages.js";

const TRANSLATION_TIMEOUT_MS = 12_000;

export class DeepLTextTranslator implements TextTranslationProvider {
  id = "deepl";
  configured: boolean;

  constructor(
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.configured = Boolean(apiKey);
  }

  supports(request: TranslationRequest): boolean {
    return this.configured
      && isDeepLTranslationSource(request.source)
      && isDeepLTranslationTarget(request.target);
  }

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim();
    if (!text) return "";
    if (request.source !== "auto" && request.source === request.target) return text;
    if (!this.apiKey) throw new Error("DeepL translation is not configured");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);
    try {
      const sourceLanguageCode = toDeepLSourceLanguageCode(request.source);
      const body: Record<string, unknown> = {
        text: [text],
        target_lang: toDeepLTargetLanguageCode(request.target),
      };
      if (sourceLanguageCode) body.source_lang = sourceLanguageCode;

      const response = await this.fetcher(
        `${resolveDeepLApiBaseUrl(this.apiKey)}/v2/translate`,
        {
          method: "POST",
          headers: {
            Authorization: `DeepL-Auth-Key ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readDeepLError(payload, response.status));
      }

      const translated = readDeepLTranslation(payload);
      if (translated === null) {
        throw new Error("DeepL translation returned an invalid response");
      }
      return translated;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("DeepL translation timed out");
      }
      throw error instanceof Error ? error : new Error("DeepL translation failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readDeepLTranslation(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.translations)) return null;
  const first = body.translations[0];
  if (!isRecord(first) || typeof first.text !== "string") return null;
  return first.text.trim();
}

function readDeepLError(body: unknown, status: number): string {
  if (isRecord(body)) {
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (isRecord(body.error) && typeof body.error.message === "string") {
      return body.error.message;
    }
  }
  return `DeepL translation failed (HTTP ${status})`;
}
