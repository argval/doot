import type {
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

export interface TranslationRequest {
  text: string;
  source: SupportedLanguage;
  target: SupportedLanguage;
  /** Wall-clock budget for this call. Drafts are shorter than finals. */
  deadlineMs?: number;
  /** Drafts skip slow fallbacks; finals may retry. */
  urgency?: "draft" | "final";
}

export type TranslateText = (request: TranslationRequest) => Promise<string>;

export interface TextTranslationProvider {
  id: string;
  configured: boolean;
  targetLanguages: readonly SupportedTargetLanguage[];
  supports(request: Pick<TranslationRequest, "source" | "target">): boolean;
  translate(request: TranslationRequest): Promise<string>;
}

export class TranslationUnavailableError extends Error {
  constructor(request: Pick<TranslationRequest, "source" | "target">) {
    super(`No configured translation provider supports ${request.source} → ${request.target}`);
    this.name = "TranslationUnavailableError";
  }
}
