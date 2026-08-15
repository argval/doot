export const HISTORY_EXPORT_FORMATS = ["txt", "srt", "json"] as const;
export type HistoryExportFormat = (typeof HISTORY_EXPORT_FORMATS)[number];

export interface HistorySegment {
  id: string;
  sequence: number;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
}

export interface HistorySessionSummary {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  startedAtMs: number;
  stoppedAtMs: number | null;
  segmentCount: number;
  preview: string;
}

export interface HistorySessionDetail extends HistorySessionSummary {
  segments: HistorySegment[];
}

export interface HistorySessionListResponse {
  sessions: HistorySessionSummary[];
}

export function isHistoryExportFormat(value: unknown): value is HistoryExportFormat {
  return typeof value === "string"
    && HISTORY_EXPORT_FORMATS.some((format) => format === value);
}

export function captionExportText(segment: Pick<HistorySegment, "translatedText">): string {
  return segment.translatedText.replace(/\s+/g, " ").trim();
}

export function formatHistoryExport(
  session: HistorySessionDetail,
  format: HistoryExportFormat,
): string {
  switch (format) {
    case "txt":
      return formatHistoryTxt(session);
    case "srt":
      return formatHistorySrt(session);
    case "json":
      return `${JSON.stringify(session, null, 2)}\n`;
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

export function historyExportFilename(
  session: Pick<HistorySessionSummary, "startedAtMs" | "sourceLanguage" | "targetLanguage">,
  format: HistoryExportFormat,
): string {
  const started = new Date(session.startedAtMs);
  const stamp = [
    started.getFullYear(),
    pad(started.getMonth() + 1),
    pad(started.getDate()),
    "-",
    pad(started.getHours()),
    pad(started.getMinutes()),
  ].join("");
  const pair = session.sourceLanguage === session.targetLanguage
    ? session.targetLanguage
    : `${session.sourceLanguage}-${session.targetLanguage}`;
  return `doot-${stamp}-${pair}.${format}`;
}

export function historyExportMime(format: HistoryExportFormat): string {
  switch (format) {
    case "json":
      return "application/json;charset=utf-8";
    case "srt":
      return "application/x-subrip;charset=utf-8";
    case "txt":
      return "text/plain;charset=utf-8";
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

function formatHistoryTxt(session: HistorySessionDetail): string {
  const lines = session.segments
    .map((segment) => captionExportText(segment))
    .filter((text) => text.length > 0);
  return lines.length > 0 ? `${lines.join("\n\n")}\n` : "";
}

function formatHistorySrt(session: HistorySessionDetail): string {
  const cues: string[] = [];
  let index = 1;
  for (const segment of session.segments) {
    const text = captionExportText(segment);
    if (!text) continue;
    const endMs = segment.endMs > segment.startMs ? segment.endMs : segment.startMs + 1_000;
    cues.push(`${index}\n${formatSrtTimestamp(segment.startMs)} --> ${formatSrtTimestamp(endMs)}\n${text}`);
    index += 1;
  }
  return cues.length > 0 ? `${cues.join("\n\n")}\n` : "";
}

function formatSrtTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
