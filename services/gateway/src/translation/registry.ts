import { TranslationRouter } from "./router.js";
import { SarvamTextTranslator } from "./sarvam/provider.js";

export interface TranslationProviderCredentials {
  sarvamApiKey?: string;
}

/** The single composition root for translation adapters. */
export function createTranslationRouter(
  credentials: TranslationProviderCredentials = {},
): TranslationRouter {
  return new TranslationRouter([
    new SarvamTextTranslator(credentials.sarvamApiKey),
  ]);
}
