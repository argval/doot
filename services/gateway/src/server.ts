import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import {
  registerRealtimeGateway,
  type RealtimeGatewayOptions,
} from "./gateway.js";
import { createProviderRouter } from "./speech/registry.js";
import type { ProviderRouter } from "./speech/router.js";
import type { TranslateText } from "./translation/contract.js";
import { createTranslationRouter } from "./translation/registry.js";

export async function buildServer(
  router: ProviderRouter = createProviderRouter({
    sarvamApiKey: config.sarvamApiKey,
    elevenLabsApiKey: config.elevenLabsApiKey,
    openAIApiKey: config.openAIApiKey,
    openAISafetyIdentifier: config.openAISafetyIdentifier,
  }),
  translate: TranslateText = createDefaultTranslator(),
  gatewayOptions: RealtimeGatewayOptions = {},
) {
  const app = Fastify({ logger: { transport: { target: "pino-pretty" } } });
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });

  app.get("/health", async () => ({
    status: "ok",
    service: "doot-gateway",
    providers: router.availability(),
  }));
  registerRealtimeGateway(app, router, translate, gatewayOptions);
  return app;
}

function createDefaultTranslator(): TranslateText {
  const translator = createTranslationRouter({
    sarvamApiKey: config.translationApiKey ?? config.sarvamApiKey,
  });
  return (request) => translator.translate(request);
}
