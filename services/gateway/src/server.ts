import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { registerRealtimeGateway } from "./gateway.js";
import { ProviderRouter } from "./providers.js";

const app = Fastify({ logger: { transport: { target: "pino-pretty" } } });
await app.register(websocket);

app.get("/health", async () => ({ status: "ok", service: "doot-gateway" }));
registerRealtimeGateway(app, new ProviderRouter(config.sarvamApiKey, config.internationalSttApiKey));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
