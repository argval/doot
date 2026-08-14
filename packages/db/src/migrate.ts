import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/tursodatabase/migrator";
import { createDb, resolveDefaultDbPath, type DootDb } from "./client.js";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const migrationsFolder = resolve(packageRoot, "drizzle");

export async function migrateDb(filePath: string = resolveDefaultDbPath()): Promise<DootDb> {
  const db = createDb(filePath);
  await db.run("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder });
  return db;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const dbPath = resolveDefaultDbPath();
  await migrateDb(dbPath);
  console.log(`Migrated Turso database at ${dbPath}`);
}
