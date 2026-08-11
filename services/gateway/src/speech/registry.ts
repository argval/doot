import { GeminiProvider } from "./gemini/provider.js";
import { MockProvider } from "./mock/provider.js";
import { ProviderRouter } from "./router.js";
import { SarvamProvider } from "./sarvam/provider.js";

export interface SpeechProviderCredentials {
  sarvamApiKey?: string;
  geminiApiKey?: string;
}

/** The single composition root for speech adapters. */
export function createProviderRouter(
  credentials: SpeechProviderCredentials = {},
): ProviderRouter {
  return new ProviderRouter([
    new SarvamProvider(credentials.sarvamApiKey),
    new GeminiProvider(credentials.geminiApiKey),
    new MockProvider(),
  ]);
}
