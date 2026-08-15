import type { FastifyInstance, FastifyReply } from "fastify";
import type { DootDb } from "@doot/db";
import {
  deleteCaptionSession,
  getCaptionSession,
  listCaptionSessions,
  type StoredCaptionSession,
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
  app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin === "string" && origin.length > 0) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Vary", "Origin");
      }
      reply.header("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
    });

    async function allowPreflight(_request: unknown, reply: FastifyReply) {
      return reply.code(204).send();
    }
    scope.options("/sessions", allowPreflight);
    scope.options("/sessions/:id", allowPreflight);
    scope.options("/sessions/:id/export", allowPreflight);

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

export function toHistorySummary(session: StoredCaptionSession): HistorySessionSummary {
  return {
    id: session.id,
    sourceLanguage: session.sourceLanguage,
    targetLanguage: session.targetLanguage,
    provider: session.provider,
    startedAtMs: session.startedAt.getTime(),
    stoppedAtMs: session.stoppedAt?.getTime() ?? null,
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
