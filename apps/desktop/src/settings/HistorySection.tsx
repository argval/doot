import { invoke } from "@tauri-apps/api/core";
import { confirmDestructive } from "../lib/native-ui";
import { useEffect, useMemo, useState } from "react";
import {
  HISTORY_EXPORT_FORMATS,
  LANGUAGE_LABELS,
  captionExportText,
  formatHistoryExport,
  historyExportFilename,
  historyExportMime,
  isSupportedLanguage,
  type HistoryExportFormat,
  type HistorySegment,
  type HistorySessionDetail,
  type HistorySessionSummary,
} from "@doot/protocol";
import { captionDocumentLang } from "../overlay/CaptionPanel";
import {
  HistoryRequestError,
  deleteHistorySession,
  fetchHistorySession,
  fetchHistorySessions,
  renameHistorySession,
} from "../lib/history";
import { subscribeToSessionStatus } from "../lib/tauri";
import { isTauriRuntime } from "../lib/runtime";

export function HistorySection() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistorySessionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const reload = () => { setPage(0); setRefresh((value) => value + 1); };
    window.addEventListener("focus", reload);
    let disposed = false;
    let cleanup: (() => void) | undefined;
    if (isTauriRuntime()) void subscribeToSessionStatus((status) => {
      if (status.state === "idle" || status.state === "error") reload();
    }).then((unsubscribe) => { if (disposed) unsubscribe(); else cleanup = unsubscribe; });
    return () => { disposed = true; cleanup?.(); window.removeEventListener("focus", reload); };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query.trim()); setPage(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingList(true);
    setError(null);
    void (async () => {
      try {
        const next = await fetchHistorySessions(debouncedQuery, controller.signal, page * 20, 21);
        if (!controller.signal.aborted) {
          setSessions(next.slice(0, 20));
          setHasMore(next.length > 20);
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setSessions([]);
        setError(historyErrorMessage(caught));
      } finally {
        if (!controller.signal.aborted) {
          setLoadingList(false);
        }
      }
    })();
    return () => controller.abort();
  }, [debouncedQuery, page, refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setLoadingDetail(true);
    setError(null);
    void (async () => {
      try {
        const next = await fetchHistorySession(selectedId, controller.signal);
        if (!controller.signal.aborted) {
          setDetail(next);
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setDetail(null);
        setSelectedId(null);
        setError(historyErrorMessage(caught));
      } finally {
        if (!controller.signal.aborted) {
          setLoadingDetail(false);
        }
      }
    })();
    return () => controller.abort();
  }, [selectedId]);

  const emptyMessage = useMemo(() => {
    if (error) return null;
    if (loadingList) return "Loading caption history…";
    if (debouncedQuery) return `No captions match "${debouncedQuery}".`;
    return "Finished caption sessions will appear here.";
  }, [debouncedQuery, error, loadingList]);

  if (selectedId) {
    return (
      <SessionDetail
        key={selectedId}
        detail={detail}
        loading={loadingDetail}
        error={error}
        deleting={deleting}
        onBack={() => {
          setSelectedId(null);
          setError(null);
        }}
        onRename={async (title) => {
          if (!detail) return;
          await renameHistorySession(detail.id, title);
          setDetail({ ...detail, title: title.trim() });
          setRefresh((value) => value + 1);
        }}
        onDelete={async () => {
          if (!selectedId) return;
          setDeleting(true);
          try {
            if (!await confirmDestructive("Delete this caption session?", "This permanently deletes the saved transcript from this computer.", "Delete Session")) return;
            await deleteHistorySession(selectedId);
            setSessions((current) => current.filter((session) => session.id !== selectedId));
            setSelectedId(null);
            setDetail(null);
            setPage(0);
            setRefresh((value) => value + 1);
          } catch (caught) {
            setError(historyErrorMessage(caught));
          } finally {
            setDeleting(false);
          }
        }}
      />
    );
  }

  return (
    <div className="settings-history">
      <label className="settings-history-search">
        <span className="settings-history-search-label">Search</span>
        <input
          type="search"
          value={query}
          placeholder="Search names, captions, or languages"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error && <p className="settings-error">{error}</p>}
      {sessions.length === 0 ? (
        <p className="settings-footnote">{emptyMessage}</p>
      ) : (
        <ul className="settings-history-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="settings-history-item"
                onClick={() => setSelectedId(session.id)}
              >
                <span className="settings-history-item-copy">
                  <strong>{session.title || formatSessionWhen(session.startedAtMs)}</strong>
                  <em>
                    {session.title ? `${formatSessionWhen(session.startedAtMs)} · ` : ""}
                    {formatLanguagePair(session.sourceLanguage, session.targetLanguage)}
                    {" · "}
                    {formatCaptionCount(session.segmentCount)}
                    {session.interrupted ? " · Interrupted" : ""}
                  </em>
                  {session.preview ? <span>{session.preview}</span> : null}
                </span>
                <span className="settings-chevron" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <nav className="settings-history-actions history-pagination" aria-label="History pages">
        <button type="button" disabled={loadingList || page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span role="status">Page {page + 1}</span>
        <button type="button" disabled={loadingList || !hasMore} onClick={() => setPage(page + 1)}>Next</button>
        <button type="button" disabled={loadingList} onClick={() => { setPage(0); setRefresh((value) => value + 1); }}>Refresh</button>
      </nav>
    </div>
  );
}

function SessionDetail({
  detail,
  loading,
  error,
  deleting,
  onBack,
  onDelete,
  onRename,
}: {
  detail: HistorySessionDetail | null;
  loading: boolean;
  error: string | null;
  deleting: boolean;
  onBack: () => void;
  onDelete: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const targetLanguage = detail && isSupportedLanguage(detail.targetLanguage)
    ? detail.targetLanguage
    : "en";

  return (
    <div className="settings-history">
      <button type="button" className="settings-history-back" onClick={onBack}>
        <span className="settings-chevron" aria-hidden="true" />
        Back to sessions
      </button>
      {error && <p className="settings-error">{error}</p>}
      {loading || !detail ? (
        <p className="settings-footnote">Loading session…</p>
      ) : (
        <>
          <div className="settings-history-meta">
            {detail.interrupted && <p role="status">This session was interrupted. Saved captions are available below; the ending may be incomplete.</p>}
            <form className="history-name" onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              setFeedback("");
              void onRename(name ?? detail.title ?? "")
                .then(() => setFeedback("Session name saved."))
                .catch((error: unknown) => setFeedback(historyErrorMessage(error)))
                .finally(() => setSaving(false));
            }}>
              <label>Session name<input value={name ?? detail.title ?? ""} maxLength={120} placeholder="Untitled session" onChange={(event) => setName(event.target.value)} /></label>
              <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save name"}</button>
            </form>
            <p className="settings-history-when">{formatSessionWhen(detail.startedAtMs)}</p>
            <p>
              {formatLanguagePair(detail.sourceLanguage, detail.targetLanguage)}
              {" · "}
              {formatCaptionCount(detail.segmentCount)}
            </p>
          </div>
          <div className="settings-history-actions">
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(formatHistoryExport(detail, "txt"))
                .then(() => setFeedback("Transcript copied."))
                .catch(() => setFeedback("Could not copy. Export as Text instead."));
            }}>Copy transcript</button>
            {HISTORY_EXPORT_FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                onClick={() => {
                  void downloadHistory(detail, format)
                    .then((saved) => { if (saved) setFeedback("Transcript exported."); })
                    .catch((error: unknown) => setFeedback(error instanceof Error ? error.message : String(error)));
                }}
              >
                {exportLabel(format)}
              </button>
            ))}
            <button type="button" className="danger" disabled={deleting} onClick={onDelete}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
          <p className="settings-footnote" role="status">{feedback}</p>
          <div
            className="settings-history-transcript"
            lang={captionDocumentLang(targetLanguage)}
            dir="auto"
          >
            {detail.segments.length === 0 ? (
              <p className="settings-footnote">This session has no saved captions.</p>
            ) : (
              detail.segments.map((segment) => (
                <HistoryCaption key={segment.id} segment={segment} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function HistoryCaption({ segment }: { segment: HistorySegment }) {
  const translated = captionExportText(segment);
  if (!translated) {
    return null;
  }
  return (
    <p>
      <time dateTime={srtClock(segment.startMs)}>{formatCueTime(segment.startMs)}</time>
      <span>{translated}</span>
    </p>
  );
}

async function downloadHistory(session: HistorySessionDetail, format: HistoryExportFormat): Promise<boolean> {
  const body = formatHistoryExport(session, format);
  if (isTauriRuntime()) return invoke<boolean>("export_document", { body, format, filename: historyExportFilename(session, format) });
  const blob = new Blob([body], { type: historyExportMime(format) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = historyExportFilename(session, format);
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

function historyErrorMessage(caught: unknown): string {
  if (caught instanceof HistoryRequestError) {
    return caught.message;
  }
  if (caught instanceof Error) {
    return caught.message;
  }
  return "Could not load caption history.";
}

function formatSessionWhen(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function formatLanguagePair(source: string, target: string): string {
  const from = languageName(source);
  const to = languageName(target);
  return source === target ? from : `${from} to ${to}`;
}

function languageName(code: string): string {
  if (isSupportedLanguage(code)) {
    return LANGUAGE_LABELS[code];
  }
  return code;
}

function formatCaptionCount(count: number): string {
  return count === 1 ? "1 caption" : `${count} captions`;
}

function exportLabel(format: HistoryExportFormat): string {
  switch (format) {
    case "txt":
      return "Text";
    case "srt":
      return "Subtitles";
    case "json":
      return "JSON";
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

function formatCueTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function srtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `PT${minutes}M${seconds}S`;
}
