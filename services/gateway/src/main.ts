import { createInterface } from "node:readline";
import { once } from "node:events";
import { migrateDb } from "@doot/db/migrate";
import { recoverInterruptedSessions } from "@doot/db/captions";
import { getHistoryPolicy, pruneHistory } from "@doot/db/privacy";
import { config } from "./config.js";
import { buildServer, createProviderRouter, createTranslationRouter } from "./server.js";

const managed = process.argv.includes("--managed");
const control = managed ? createInterface({ input: process.stdin }) : null;
let parentClosed = false;
control?.once("close", () => { parentClosed = true; });
let startup: { authToken: string; dbPath: string; migrationsFolder: string; sarvamApiKey?: string; geminiApiKey?: string; speechmaticsApiKey?: string; openaiApiKey?: string } | undefined;
if (control) {
  const [line] = await once(control, "line");
  if (typeof line !== "string" || line.length > 32_768) throw new Error("Invalid desktop startup configuration");
  startup = JSON.parse(line);
  if (!startup || typeof startup.authToken !== "string" || startup.authToken.length < 32 || typeof startup.dbPath !== "string" || typeof startup.migrationsFolder !== "string") throw new Error("Invalid desktop startup configuration");
}
const authToken = startup?.authToken ?? config.authToken;
if (!authToken && process.env.DOOT_ALLOW_UNAUTHENTICATED !== "1") {
  throw new Error("Set DOOT_GATEWAY_TOKEN, or launch the gateway through Doot. For isolated local development only, set DOOT_ALLOW_UNAUTHENTICATED=1.");
}
if (!authToken && config.host !== "127.0.0.1") throw new Error("Unauthenticated development must bind to 127.0.0.1");
const db = await migrateDb(startup?.dbPath, startup?.migrationsFolder);
await recoverInterruptedSessions(db);
await pruneHistory(db, (await getHistoryPolicy(db)).retentionDays);
const credentials = startup ?? config;
const app = await buildServer(createProviderRouter(credentials), createTranslationRouter(credentials), { db, authToken });
const retention = setInterval(() => { void getHistoryPolicy(db).then((policy) => pruneHistory(db, policy.retentionDays)).catch(() => {}); }, 3_600_000);
retention.unref();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(retention);
  control?.close();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
control?.on("line", (line) => { if (line === "stop") void shutdown(); });
control?.on("close", () => { void shutdown(); });
if (parentClosed) await shutdown();
await app.listen({ host: managed ? "127.0.0.1" : config.host, port: managed ? 0 : config.port });
const address = app.server.address();
if (typeof address !== "object" || !address) throw new Error("Gateway did not bind a port");
console.log(JSON.stringify({ type: "ready", port: address.port }));
