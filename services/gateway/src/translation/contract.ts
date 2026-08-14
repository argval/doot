import type {
  SupportedLanguage,
  SupportedTargetLanguage,
} from "@doot/protocol";

export interface TranslationRequest {
  text: string;
  source: SupportedLanguage;
  target: SupportedTargetLanguage;
}

export type TranslateText = (request: TranslationRequest) => Promise<string>;

export interface TextTranslationProvider {
  id: string;
  configured: boolean;
  targetLanguages: readonly SupportedTargetLanguage[];
  supports(request: TranslationRequest): boolean;
  translate(request: TranslationRequest): Promise<string>;
}

export class TranslationUnavailableError extends Error {
  constructor(request: Pick<TranslationRequest, "source" | "target">) {
    super(`No configured translation provider supports ${request.source} → ${request.target}`);
    this.name = "TranslationUnavailableError";
  }
}
