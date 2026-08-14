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
import { createProviderRouter } from "./speech/registry.js";
import type { ProviderRouter } from "./speech/router.js";
import type { TranslateText } from "./translation/contract.js";
import { createTranslationRouter } from "./translation/registry.js";
import type { TranslationRouter } from "./translation/router.js";

const defaultTranslationRouter = createTranslationRouter({
  sarvamApiKey: config.translationApiKey ?? config.sarvamApiKey,
  geminiApiKey: config.geminiApiKey,
});

export async function buildServer(
  router: ProviderRouter = createProviderRouter({
    sarvamApiKey: config.sarvamApiKey,
    geminiApiKey: config.geminiApiKey,
  }),
  translate: TranslateText = (request) => defaultTranslationRouter.translate(request),
  gatewayOptions: RealtimeGatewayOptions = {},
  translation: TranslationRouter = defaultTranslationRouter,
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
  registerRealtimeGateway(app, router, translate, gatewayOptions);
  return app;
}

function uniqueTargets(
  languages: readonly SupportedTargetLanguage[],
): SupportedTargetLanguage[] {
  const present = new Set(languages);
  return SUPPORTED_TARGET_LANGUAGES.filter((language) => present.has(language));
}
