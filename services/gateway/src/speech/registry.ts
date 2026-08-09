import { ElevenLabsProvider } from "./elevenlabs/provider.js";
import { MockProvider } from "./mock/provider.js";
import { ProviderRouter } from "./router.js";
import { SarvamProvider } from "./sarvam/provider.js";

export interface SpeechProviderCredentials {
  sarvamApiKey?: string;
  elevenLabsApiKey?: string;
}

/** The single composition root for speech adapters. */
export function createProviderRouter(
  credentials: SpeechProviderCredentials = {},
): ProviderRouter {
  return new ProviderRouter([
    new ElevenLabsProvider(credentials.elevenLabsApiKey),
    new SarvamProvider(credentials.sarvamApiKey),
    new MockProvider(),
  ]);
}
