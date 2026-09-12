import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { DootDb } from "./client.js";
import { captionSegments, historyPolicy, sessions } from "./schema.js";

export interface HistoryPolicy { saveHistory: boolean; retentionDays: number }
export const DEFAULT_HISTORY_POLICY: HistoryPolicy = { saveHistory: true, retentionDays: 0 };

export async function getHistoryPolicy(db: DootDb): Promise<HistoryPolicy> {
  const [row] = await db.select().from(historyPolicy).where(eq(historyPolicy.id, 1));
  return row ? { saveHistory: row.saveHistory, retentionDays: row.retentionDays } : { ...DEFAULT_HISTORY_POLICY };
}

export async function setHistoryPolicy(db: DootDb, policy: HistoryPolicy): Promise<void> {
  if (typeof policy.saveHistory !== "boolean" || ![0, 7, 30, 90].includes(policy.retentionDays)) {
    throw new Error("Choose whether to save history and a retention of 0, 7, 30, or 90 days.");
  }
  await db.transaction(async (tx) => {
    await tx.insert(historyPolicy).values({ id: 1, ...policy })
      .onConflictDoUpdate({ target: historyPolicy.id, set: policy });
    await deleteExpiredHistory(tx, policy.retentionDays, Date.now());
  });
}

export async function pruneHistory(db: DootDb, days: number, now = Date.now()): Promise<void> {
  await db.transaction((tx) => deleteExpiredHistory(tx, days, now));
}

async function deleteExpiredHistory(db: Pick<DootDb, "select" | "delete">, days: number, now: number): Promise<void> {
  if (![7, 30, 90].includes(days)) return;
  const expired = db.select({ id: sessions.id }).from(sessions)
    .where(and(isNotNull(sessions.stoppedAt), lt(sessions.stoppedAt, new Date(now - days * 86_400_000))));
  await db.delete(captionSegments).where(inArray(captionSegments.sessionId, expired));
  await db.delete(sessions).where(inArray(sessions.id, expired));
}
