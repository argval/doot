import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { registerRealtimeGateway } from "./gateway.js";
import { ProviderRouter } from "./providers.js";

export async function buildServer(router = new ProviderRouter(config.sarvamApiKey, config.internationalSttApiKey)) {
  const app = Fastify({ logger: { transport: { target: "pino-pretty" } } });
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });

  app.get("/health", async () => ({
    status: "ok",
    service: "doot-gateway",
    providers: {
      sarvam: Boolean(config.sarvamApiKey),
      internationalStt: Boolean(config.internationalSttApiKey),
    },
  }));
  registerRealtimeGateway(app, router);
  return app;
}
