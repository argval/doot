import { migrateDb } from "@doot/db/migrate";
import { config } from "./config.js";
import { buildServer } from "./server.js";

const db = await migrateDb();
const app = await buildServer(undefined, undefined, { db });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
