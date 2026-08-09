import type {
  TextTranslationProvider,
  TranslationRequest,
} from "./contract.js";
import { TranslationUnavailableError } from "./contract.js";

export class TranslationRouter {
  constructor(private readonly providers: readonly TextTranslationProvider[]) {}

  async translate(request: TranslationRequest): Promise<string> {
    const text = request.text.trim();
    if (!text || request.source === request.target) return text;
    const provider = this.providers.find((candidate) => (
      candidate.configured && candidate.supports({ ...request, text })
    ));
    if (!provider) throw new TranslationUnavailableError(request);
    return provider.translate({ ...request, text });
  }
}
