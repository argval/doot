import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const dbPath = process.env.DOOT_DB_PATH?.trim() || resolve("data", "doot.db");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: dbPath,
  },
});
