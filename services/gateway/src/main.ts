import { config } from "./config.js";
import { ProviderRouter } from "./providers.js";
import { buildServer } from "./server.js";

const app = await buildServer(new ProviderRouter(config.sarvamApiKey, config.internationalSttApiKey));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
