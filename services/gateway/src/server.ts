import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerRealtimeGateway } from "./gateway.js";
import { ProviderRouter } from "./providers.js";

export async function buildServer(router = new ProviderRouter()) {
  const app = Fastify({ logger: { transport: { target: "pino-pretty" } } });
  await app.register(websocket, { options: { maxPayload: 384 * 1024 } });

  app.get("/health", async () => ({ status: "ok", service: "doot-gateway" }));
  registerRealtimeGateway(app, router);
  return app;
}
