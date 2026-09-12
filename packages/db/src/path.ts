import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveDefaultDbPath(): string {
  const fromEnv = process.env.DOOT_DB_PATH?.trim();
  // Native Doot supplies its OS app-data path explicitly. Keep standalone
  // development on the existing database, separate from the installed app.
  return fromEnv || resolve(dirname(fileURLToPath(import.meta.url)), "../data/doot.db");
}

export function ensureDbDirectory(filePath: string): void {
  if (filePath === ":memory:") return;
  mkdirSync(dirname(filePath), { recursive: true });
}
