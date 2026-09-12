import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import type { DootDb } from "./client.js";
import { captionSegments, sessions } from "./schema.js";

export async function createCaptionSession(
  db: DootDb,
  session: {
    sourceLanguage: string;
    targetLanguage: string;
    provider: string;
  },
): Promise<string> {
  const [created] = await db.insert(sessions).values(session).returning({
    id: sessions.id,
  });
  if (!created) throw new Error("Failed to create caption session");
  return created.id;
}

export async function saveCaptionSegment(
  db: DootDb,
  segment: {
    sessionId: string;
    sequence: number;
    sourceText: string;
    translatedText: string;
    startMs: number;
    endMs: number;
  },
): Promise<void> {
  await db.insert(captionSegments).values(segment);
}

export async function stopCaptionSession(
  db: DootDb,
  sessionId: string,
  interrupted = false,
): Promise<void> {
  await db.update(sessions)
    .set({ stoppedAt: new Date(), interrupted })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.stoppedAt)));
}

/** Run once on gateway startup, before accepting any new sessions. */
export async function recoverInterruptedSessions(db: DootDb): Promise<void> {
  await db.update(sessions).set({ stoppedAt: new Date(), interrupted: true })
    .where(isNull(sessions.stoppedAt));
}

export interface StoredCaptionSegment {
  id: string;
  sequence: number;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
}

export interface StoredCaptionSession {
  id: string;
  title: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  startedAt: Date;
  stoppedAt: Date | null;
  interrupted: boolean;
  segmentCount: number;
  preview: string;
  segments: StoredCaptionSegment[];
}

export type StoredCaptionSummary = Omit<StoredCaptionSession, "segments">;

export async function listCaptionSessions(
  db: DootDb,
  options: {
    query?: string;
    languageCodes?: readonly string[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<StoredCaptionSummary[]> {
  const limit = clampInt(options.limit ?? 100, 1, 200);
  const offset = clampInt(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const ids = await matchingSessionIds(db, options.query ?? "", options.languageCodes ?? []);
  if (ids !== null && ids.length === 0) {
    return [];
  }

  return db.select({
    ...getTableColumns(sessions),
    segmentCount: sql<number>`(select count(*) from caption_segments where session_id = sessions.id)`.mapWith(Number),
    preview: sql<string>`coalesce((select substr(trim(translated_text), 1, 240) from caption_segments where session_id = sessions.id and trim(translated_text) != '' order by sequence limit 1), '')`,
  }).from(sessions)
    .where(ids ? and(isNotNull(sessions.stoppedAt), inArray(sessions.id, ids)) : isNotNull(sessions.stoppedAt))
    .orderBy(desc(sessions.startedAt), sql`sessions.rowid desc`)
    .limit(limit)
    .offset(offset);

}

export async function getCaptionSession(
  db: DootDb,
  sessionId: string,
): Promise<StoredCaptionSession | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!row) return null;
  const [session] = await attachSegments(db, [row]);
  return session ?? null;
}

export async function deleteCaptionSession(
  db: DootDb,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: sessions.id }).from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return false;
  await db.transaction(async (tx) => {
    await tx.delete(captionSegments).where(eq(captionSegments.sessionId, sessionId));
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
  });
  return true;
}

export async function renameCaptionSession(db: DootDb, sessionId: string, title: string): Promise<boolean> {
  if (title.trim().length > 120) throw new Error("Session names must be 120 characters or fewer.");
  const rows = await db.update(sessions).set({ title: title.trim() })
    .where(eq(sessions.id, sessionId)).returning({ id: sessions.id });
  return rows.length > 0;
}

async function matchingSessionIds(
  db: DootDb,
  query: string,
  languageCodes: readonly string[],
): Promise<string[] | null> {
  const raw = query.trim();
  const needle = sanitizeLike(raw);
  if (!needle && languageCodes.length === 0) {
    return raw ? [] : null;
  }

  const ids = new Set<string>();
  if (needle) {
    const pattern = `%${needle}%`;
    const titleHits = await db.select({ id: sessions.id }).from(sessions).where(like(sessions.title, pattern));
    for (const hit of titleHits) ids.add(hit.id);
    const textHits = await db.select({ sessionId: captionSegments.sessionId })
      .from(captionSegments)
      .where(or(
        like(captionSegments.sourceText, pattern),
        like(captionSegments.translatedText, pattern),
      ))
      .groupBy(captionSegments.sessionId);
    for (const hit of textHits) {
      ids.add(hit.sessionId);
    }
  }

  if (languageCodes.length > 0) {
    const languageHits = await db.select({ id: sessions.id })
      .from(sessions)
      .where(or(
        inArray(sessions.sourceLanguage, [...languageCodes]),
        inArray(sessions.targetLanguage, [...languageCodes]),
      ));
    for (const hit of languageHits) {
      ids.add(hit.id);
    }
  }

  return [...ids];
}

async function attachSegments(
  db: DootDb,
  rows: Array<typeof sessions.$inferSelect>,
): Promise<StoredCaptionSession[]> {
  if (rows.length === 0) return [];

  const stored = await db.select({
    id: captionSegments.id,
    sessionId: captionSegments.sessionId,
    sequence: captionSegments.sequence,
    sourceText: captionSegments.sourceText,
    translatedText: captionSegments.translatedText,
    startMs: captionSegments.startMs,
    endMs: captionSegments.endMs,
  }).from(captionSegments)
    .where(inArray(captionSegments.sessionId, rows.map((row) => row.id)))
    .orderBy(captionSegments.sequence);

  const bySession = new Map<string, StoredCaptionSegment[]>();
  for (const segment of stored) {
    const list = bySession.get(segment.sessionId) ?? [];
    list.push({
      id: segment.id,
      sequence: segment.sequence,
      sourceText: segment.sourceText,
      translatedText: segment.translatedText,
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
    bySession.set(segment.sessionId, list);
  }

  return rows.map((row) => {
    const segments = bySession.get(row.id) ?? [];
    const previewSegment = segments.find((segment) => segment.translatedText.trim().length > 0);
    return {
      id: row.id,
      title: row.title,
      sourceLanguage: row.sourceLanguage,
      targetLanguage: row.targetLanguage,
      provider: row.provider,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
      interrupted: row.interrupted,
      segmentCount: segments.length,
      preview: previewSegment?.translatedText.trim() ?? "",
      segments,
    };
  });
}

function sanitizeLike(value: string): string {
  return value.replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
