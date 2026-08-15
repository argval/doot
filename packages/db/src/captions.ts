import { and, eq, isNull } from "drizzle-orm";
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
): Promise<void> {
  await db.update(sessions)
    .set({ stoppedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.stoppedAt)));
}
