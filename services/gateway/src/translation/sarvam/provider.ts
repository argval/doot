import type {
  TextTranslationProvider,
  TranslationRequest,
} from "../contract.js";
import { isRecord } from "../../util.js";
import {
  isSarvamTranslationSource,
  isSarvamTranslationTarget,
  toSarvamTranslationLanguageCode,
} from "./languages.js";

const SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate";
const TRANSLATION_TIMEOUT_MS = 12_000;

export class SarvamTextTranslator implements TextTranslationProvider {
  id = "sarvam";
  configured: boolean;

  constructor(
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.configured = Boolean(apiKey);
  }

  supports(request: TranslationRequest): boolean {
    return this.configured
      && isSarvamTranslationSource(request.source)
      && isSarvamTranslationTarget(request.target);
  }

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim();
    if (!text) return "";
    if (request.source !== "auto" && request.source === request.target) return text;
    if (!this.apiKey) throw new Error("Sarvam translation is not configured");

    const targetLanguageCode = toSarvamTranslationLanguageCode(request.target);
    const primary = await this.requestTranslation({
      text,
      targetLanguageCode,
      model: "mayura:v1",
      mode: "modern-colloquial",
    });
    if (primary.ok) return primary.text;

    if (primary.status !== 400 && primary.status !== 422) {
      throw new Error(primary.message);
    }

    const fallback = await this.requestTranslation({
      text,
      targetLanguageCode,
      model: "sarvam-translate:v1",
      mode: "formal",
    });
    if (fallback.ok) return fallback.text;
    throw new Error(fallback.message);
  }

  private async requestTranslation(options: {
    text: string;
    targetLanguageCode: string;
    model: "mayura:v1" | "sarvam-translate:v1";
    mode: "modern-colloquial" | "formal";
  }): Promise<TranslationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);
    try {
      const response = await this.fetcher(SARVAM_TRANSLATE_URL, {
        method: "POST",
        headers: {
          "Api-Subscription-Key": this.apiKey ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: options.text,
          source_language_code: "auto",
          target_language_code: options.targetLanguageCode,
          model: options.model,
          mode: options.mode,
          output_script: "fully-native",
        }),
        signal: controller.signal,
      });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: readTranslationError(body, response.status),
        };
      }
      if (!isRecord(body) || typeof body.translated_text !== "string") {
        return {
          ok: false,
          status: 502,
          message: "Sarvam translation returned an invalid response",
        };
      }
      return { ok: true, text: body.translated_text.trim() };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          status: 504,
          message: "Sarvam translation timed out",
        };
      }
      return {
        ok: false,
        status: 502,
        message: error instanceof Error ? error.message : "Sarvam translation failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

type TranslationResult =
  | { ok: true; text: string }
  | { ok: false; status: number; message: string };

function readTranslationError(body: unknown, status: number): string {
  if (isRecord(body)) {
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (isRecord(body.error) && typeof body.error.message === "string") {
      return body.error.message;
    }
  }
  return `Sarvam translation failed (HTTP ${status})`;
}
