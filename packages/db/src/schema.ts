import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date();
}

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(uuid),
  title: text("title").notNull().default(""),
  sourceLanguage: text("source_language").notNull(),
  targetLanguage: text("target_language").notNull(),
  provider: text("provider").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  stoppedAt: integer("stopped_at", { mode: "timestamp_ms" }),
  interrupted: integer("interrupted", { mode: "boolean" }).notNull().default(false),
});

export const historyPolicy = sqliteTable("history_policy", {
  id: integer("id").primaryKey(),
  saveHistory: integer("save_history", { mode: "boolean" }).notNull(),
  retentionDays: integer("retention_days").notNull(),
});

export const captionSegments = sqliteTable("caption_segments", {
  id: text("id").primaryKey().$defaultFn(uuid),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  sequence: integer("sequence").notNull(),
  sourceText: text("source_text").notNull(),
  translatedText: text("translated_text").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
}, (table) => [index("caption_session_sequence").on(table.sessionId, table.sequence)]);
