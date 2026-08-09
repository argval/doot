import { DeepLTextTranslator } from "./deepl/provider.js";
import { TranslationRouter } from "./router.js";
import { SarvamTextTranslator } from "./sarvam/provider.js";

export interface TranslationProviderCredentials {
  sarvamApiKey?: string;
  deepLApiKey?: string;
}

/** The single composition root for translation adapters. */
export function createTranslationRouter(
  credentials: TranslationProviderCredentials = {},
): TranslationRouter {
  return new TranslationRouter([
    // Indic pairs stay on Sarvam; DeepL covers the international launch lane.
    new SarvamTextTranslator(credentials.sarvamApiKey),
    new DeepLTextTranslator(credentials.deepLApiKey),
  ]);
}
