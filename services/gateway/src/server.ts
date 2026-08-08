import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import {
  registerRealtimeGateway,
  type RealtimeGatewayOptions,
} from "./gateway.js";
import { ProviderRouter } from "./providers.js";
import { SarvamTextTranslator, type TranslateText } from "./translate.js";

export async function buildServer(
  router = new ProviderRouter(config.sarvamApiKey),
  translate: TranslateText = createDefaultTranslator(),
  gatewayOptions: RealtimeGatewayOptions = {},
) {
  const app = Fastify({ logger: { transport: { target: "pino-pretty" } } });
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });

  app.get("/health", async () => ({
    status: "ok",
    service: "doot-gateway",
    providers: {
      sarvam: Boolean(config.sarvamApiKey),
    },
  }));
  registerRealtimeGateway(app, router, translate, gatewayOptions);
  return app;
}

function createDefaultTranslator(): TranslateText {
  const translator = new SarvamTextTranslator(config.sarvamApiKey);
  return (request) => translator.translate(request);
}
