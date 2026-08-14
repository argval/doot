import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function resolveDefaultDbPath(): string {
  const fromEnv = process.env.DOOT_DB_PATH?.trim();
  return fromEnv || resolve(packageRoot, "data", "doot.db");
}

export function ensureDbDirectory(filePath: string): void {
  if (filePath === ":memory:") return;
  mkdirSync(dirname(filePath), { recursive: true });
}
