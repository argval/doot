import type { FastifyInstance } from "fastify";
import type { DootDb } from "@doot/db";
import { getHistoryPolicy, setHistoryPolicy } from "@doot/db/privacy";
import {
  deleteCaptionSession,
  getCaptionSession,
  listCaptionSessions,
  renameCaptionSession,
  type StoredCaptionSession,
  type StoredCaptionSummary,
} from "@doot/db/captions";
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  formatHistoryExport,
  historyExportFilename,
  historyExportMime,
  isHistoryExportFormat,
  type HistoryExportFormat,
  type HistorySessionDetail,
  type HistorySessionSummary,
} from "@doot/protocol";

const HISTORY_UNAVAILABLE = {
  error: "history_unavailable",
  message: "Caption history is not available.",
};

export function registerHistoryRoutes(app: FastifyInstance, db: DootDb | undefined): void {
  app.get("/v1/history/policy", async (_request, reply) => {
    if (!db) return reply.code(503).send(HISTORY_UNAVAILABLE);
    return getHistoryPolicy(db);
  });
  app.patch("/v1/history/policy", async (request, reply) => {
    if (!db) return reply.code(503).send(HISTORY_UNAVAILABLE);
    const body = request.body;
    if (typeof body !== "object" || body === null || !("saveHistory" in body) || typeof body.saveHistory !== "boolean"
      || !("retentionDays" in body) || typeof body.retentionDays !== "number" || ![0, 7, 30, 90].includes(body.retentionDays)) {
      return reply.code(400).send({ message: "Choose valid history preferences." });
    }
    await setHistoryPolicy(db, { saveHistory: body.saveHistory, retentionDays: body.retentionDays });
    return reply.code(204).send();
  });
  app.register(async (scope) => {
    scope.get("/sessions", async (request, reply) => {
      if (!db) {
        return reply.code(503).send(HISTORY_UNAVAILABLE);
      }
      const query = readString(request.query, "q");
      const sessions = await listCaptionSessions(db, {
        query,
        languageCodes: languageCodesMatching(query),
        limit: readInt(request.query, "limit"),
        offset: readInt(request.query, "offset"),
      });
      return { sessions: sessions.map(toHistorySummary) };
    });

    scope.get("/sessions/:id", async (request, reply) => {
      if (!db) {
        return reply.code(503).send(HISTORY_UNAVAILABLE);
      }
      const session = await getCaptionSession(db, readId(request.params));
      if (!session) {
        return reply.code(404).send({ error: "not_found" });
      }
      return toHistoryDetail(session);
    });

    scope.patch("/sessions/:id", async (request, reply) => {
      if (!db) return reply.code(503).send(HISTORY_UNAVAILABLE);
      const body = request.body;
      if (typeof body !== "object" || body === null || !("title" in body)
        || typeof body.title !== "string" || body.title.trim().length > 120) {
        return reply.code(400).send({ message: "Enter a session name of 120 characters or fewer." });
      }
      if (!await renameCaptionSession(db, readId(request.params), body.title)) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    });

    scope.get("/sessions/:id/export", async (request, reply) => {
      if (!db) {
        return reply.code(503).send(HISTORY_UNAVAILABLE);
      }
      const formatValue = readString(request.query, "format") || "txt";
      if (!isHistoryExportFormat(formatValue)) {
        return reply.code(400).send({ error: "invalid_format" });
      }
      const session = await getCaptionSession(db, readId(request.params));
      if (!session) {
        return reply.code(404).send({ error: "not_found" });
      }
      const detail = toHistoryDetail(session);
      const format: HistoryExportFormat = formatValue;
      const body = formatHistoryExport(detail, format);
      reply.header("Content-Type", historyExportMime(format));
      reply.header(
        "Content-Disposition",
        `attachment; filename="${historyExportFilename(detail, format)}"`,
      );
      return reply.send(body);
    });

    scope.delete("/sessions/:id", async (request, reply) => {
      if (!db) {
        return reply.code(503).send(HISTORY_UNAVAILABLE);
      }
      const deleted = await deleteCaptionSession(db, readId(request.params));
      if (!deleted) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    });
  }, { prefix: "/v1/history" });
}

export function languageCodesMatching(query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SUPPORTED_LANGUAGES.filter((code) => {
    if (code === needle) return true;
    const label = LANGUAGE_LABELS[code].toLowerCase();
    if (label === needle) return true;
    return needle.length >= 3 && label.includes(needle);
  });
}

export function toHistorySummary(session: StoredCaptionSummary): HistorySessionSummary {
  return {
    id: session.id,
    title: session.title,
    sourceLanguage: session.sourceLanguage,
    targetLanguage: session.targetLanguage,
    provider: session.provider,
    startedAtMs: session.startedAt.getTime(),
    stoppedAtMs: session.stoppedAt?.getTime() ?? null,
    interrupted: session.interrupted,
    segmentCount: session.segmentCount,
    preview: session.preview,
  };
}

export function toHistoryDetail(session: StoredCaptionSession): HistorySessionDetail {
  return {
    ...toHistorySummary(session),
    segments: session.segments,
  };
}

function readId(params: unknown): string {
  if (typeof params !== "object" || params === null || !("id" in params)) {
    return "";
  }
  return typeof params.id === "string" ? params.id : "";
}

function readString(query: unknown, key: string): string {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return "";
  }
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readInt(query: unknown, key: string): number | undefined {
  const raw = readString(query, key);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
