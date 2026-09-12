import type {
  TextTranslationProvider,
  TranslationRequest,
} from "./contract.js";
import { TranslationUnavailableError } from "./contract.js";

export class TranslationRouter {
  constructor(private readonly providers: readonly TextTranslationProvider[]) {}

  availability(): Record<string, boolean> {
    return Object.fromEntries(
      this.providers.map((provider) => [provider.id, provider.configured]),
    );
  }

  select(request: Pick<TranslationRequest, "source" | "target">): TextTranslationProvider {
    // Preference is explicit; construction order must not change production routes.
    const compatible = this.providers.filter((provider) => (
      provider.configured && provider.supports(request)
    ));
    const provider = compatible.find((candidate) => candidate.id === "sarvam")
      ?? compatible.find((candidate) => candidate.id === "gemini")
      ?? compatible[0];
    if (!provider) throw new TranslationUnavailableError(request);
    return provider;
  }

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim();
    if (!text || request.source === request.target) return text;
    const provider = this.select(request);
    return provider.translate({ ...request, text });
  }
}
