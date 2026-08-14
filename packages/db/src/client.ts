import { drizzle } from "drizzle-orm/tursodatabase/database";
import { ensureDbDirectory, resolveDefaultDbPath } from "./path.js";

export { resolveDefaultDbPath } from "./path.js";

export function createDb(filePath: string = resolveDefaultDbPath()) {
  ensureDbDirectory(filePath);
  return drizzle(filePath);
}

export type DootDb = ReturnType<typeof createDb>;
