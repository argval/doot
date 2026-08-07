import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

export const sql = connectionString ? postgres(connectionString, { max: 5 }) : null;
export const db = sql ? drizzle(sql, { schema }) : null;
