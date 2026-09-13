import type {
  TextTranslationProvider,
  TranslationRequest,
} from "../contract.js";
import { isRecord } from "../../util.js";
import {
  isSarvamTranslationSource,
  isSarvamTranslationTarget,
  SARVAM_TRANSLATION_TARGET_LANGUAGES,
  toSarvamTranslationLanguageCode,
} from "./languages.js";

const SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate";
const TRANSLATION_TIMEOUT_MS = 2_000;

export class SarvamTextTranslator implements TextTranslationProvider {
  id = "sarvam";
  configured: boolean;
  readonly targetLanguages = SARVAM_TRANSLATION_TARGET_LANGUAGES;

  constructor(
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.configured = Boolean(apiKey);
  }

  supports(request: Pick<TranslationRequest, "source" | "target">): boolean {
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
    const startedAt = performance.now();
    const deadlineMs = request.deadlineMs ?? TRANSLATION_TIMEOUT_MS;
    const primary = await this.requestTranslation({
      text,
      targetLanguageCode,
      model: "mayura:v1",
      mode: "modern-colloquial",
      deadlineMs,
      signal: request.signal,
    });
    if (primary.ok) return primary.text;

    if (primary.status !== 400 && primary.status !== 422) {
      throw new Error(primary.message);
    }
    if (request.urgency === "draft") {
      throw new Error(primary.message);
    }

    request.signal?.throwIfAborted();
    const remainingMs = Math.floor(deadlineMs - (performance.now() - startedAt));
    if (remainingMs < 200) throw new Error(primary.message);

    const fallback = await this.requestTranslation({
      text,
      targetLanguageCode,
      model: "sarvam-translate:v1",
      mode: "formal",
      deadlineMs: remainingMs,
      signal: request.signal,
    });
    if (fallback.ok) return fallback.text;
    throw new Error(fallback.message);
  }

  private async requestTranslation(options: {
    text: string;
    targetLanguageCode: string;
    model: "mayura:v1" | "sarvam-translate:v1";
    mode: "modern-colloquial" | "formal";
    deadlineMs: number;
    signal: AbortSignal | undefined;
  }): Promise<TranslationResult> {
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
        signal: AbortSignal.any([
          AbortSignal.timeout(options.deadlineMs),
          ...(options.signal ? [options.signal] : []),
        ]),
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
      if (isTimeoutError(error)) {
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "TimeoutError" || error.name === "AbortError");
}
