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
} from "../lib/history";

export function HistorySection() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistorySessionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingList(true);
    setError(null);
    void (async () => {
      try {
        const next = await fetchHistorySessions(debouncedQuery, controller.signal);
        if (!controller.signal.aborted) {
          setSessions(next);
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
  }, [debouncedQuery]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setConfirmingDelete(false);
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
        detail={detail}
        loading={loadingDetail}
        error={error}
        confirmingDelete={confirmingDelete}
        deleting={deleting}
        onBack={() => {
          setSelectedId(null);
          setConfirmingDelete(false);
          setError(null);
        }}
        onConfirmingDelete={setConfirmingDelete}
        onDelete={async () => {
          if (!selectedId) return;
          setDeleting(true);
          try {
            await deleteHistorySession(selectedId);
            setSessions((current) => current.filter((session) => session.id !== selectedId));
            setSelectedId(null);
            setDetail(null);
            setConfirmingDelete(false);
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
          placeholder="Search captions or languages"
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
                <strong>{formatSessionWhen(session.startedAtMs)}</strong>
                <em>
                  {formatLanguagePair(session.sourceLanguage, session.targetLanguage)}
                  {" · "}
                  {formatCaptionCount(session.segmentCount)}
                </em>
                {session.preview ? <span>{session.preview}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionDetail({
  detail,
  loading,
  error,
  confirmingDelete,
  deleting,
  onBack,
  onConfirmingDelete,
  onDelete,
}: {
  detail: HistorySessionDetail | null;
  loading: boolean;
  error: string | null;
  confirmingDelete: boolean;
  deleting: boolean;
  onBack: () => void;
  onConfirmingDelete: (confirming: boolean) => void;
  onDelete: () => void;
}) {
  const targetLanguage = detail && isSupportedLanguage(detail.targetLanguage)
    ? detail.targetLanguage
    : "en";

  return (
    <div className="settings-history">
      <button type="button" className="settings-history-back" onClick={onBack}>
        Back to sessions
      </button>
      {error && <p className="settings-error">{error}</p>}
      {loading || !detail ? (
        <p className="settings-footnote">Loading session…</p>
      ) : (
        <>
          <div className="settings-history-meta">
            <p className="settings-history-when">{formatSessionWhen(detail.startedAtMs)}</p>
            <p>
              {formatLanguagePair(detail.sourceLanguage, detail.targetLanguage)}
              {" · "}
              {formatCaptionCount(detail.segmentCount)}
            </p>
          </div>
          <div className="settings-history-actions">
            {HISTORY_EXPORT_FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                onClick={() => downloadHistory(detail, format)}
              >
                {exportLabel(format)}
              </button>
            ))}
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  className="danger"
                  disabled={deleting}
                  onClick={onDelete}
                >
                  {deleting ? "Deleting…" : "Delete session"}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => onConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="danger"
                onClick={() => onConfirmingDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
          <div
            className="settings-history-transcript"
            lang={captionDocumentLang(targetLanguage)}
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

function downloadHistory(session: HistorySessionDetail, format: HistoryExportFormat): void {
  const body = formatHistoryExport(session, format);
  const blob = new Blob([body], { type: historyExportMime(format) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = historyExportFilename(session, format);
  link.click();
  URL.revokeObjectURL(url);
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
