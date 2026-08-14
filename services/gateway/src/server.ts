import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {
  SUPPORTED_TARGET_LANGUAGES,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import { config } from "./config.js";
import {
  registerRealtimeGateway,
  type RealtimeGatewayOptions,
} from "./gateway.js";
import { GeminiProvider } from "./speech/gemini/provider.js";
import { MockProvider } from "./speech/mock/provider.js";
import { ProviderRouter } from "./speech/router.js";
import { SarvamProvider } from "./speech/sarvam/provider.js";
import { GeminiTextTranslator } from "./translation/gemini/provider.js";
import { TranslationRouter } from "./translation/router.js";
import { SarvamTextTranslator } from "./translation/sarvam/provider.js";

export function createProviderRouter(
  credentials: { sarvamApiKey?: string; geminiApiKey?: string } = {},
): ProviderRouter {
  return new ProviderRouter([
    new SarvamProvider(credentials.sarvamApiKey),
    new GeminiProvider(credentials.geminiApiKey),
    new MockProvider(),
  ]);
}

export function createTranslationRouter(
  credentials: { sarvamApiKey?: string; geminiApiKey?: string } = {},
): TranslationRouter {
  return new TranslationRouter([
    new SarvamTextTranslator(credentials.sarvamApiKey),
    new GeminiTextTranslator(credentials.geminiApiKey),
  ]);
}

export async function buildServer(
  router: ProviderRouter = createProviderRouter({
    sarvamApiKey: config.sarvamApiKey,
    geminiApiKey: config.geminiApiKey,
  }),
  translation: TranslationRouter = createTranslationRouter({
    sarvamApiKey: config.sarvamApiKey,
    geminiApiKey: config.geminiApiKey,
  }),
  gatewayOptions: RealtimeGatewayOptions = {},
) {
  const app = Fastify({ logger: { transport: { target: "pino-pretty" } } });
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });

  app.get("/health", async () => {
    const speech = router.languageCoverage();
    const translationTargets = translation.configuredTargetLanguages();
    return {
      status: "ok",
      service: "doot-gateway",
      providers: router.availability(),
      translation: translation.availability(),
      languages: {
        sources: speech.sources,
        targets: uniqueTargets([...speech.targets, ...translationTargets]),
      },
    };
  });
  registerRealtimeGateway(app, router, (request) => translation.translate(request), gatewayOptions);
  return app;
}

function uniqueTargets(
  languages: readonly SupportedTargetLanguage[],
): SupportedTargetLanguage[] {
  const present = new Set(languages);
  return SUPPORTED_TARGET_LANGUAGES.filter((language) => present.has(language));
}
