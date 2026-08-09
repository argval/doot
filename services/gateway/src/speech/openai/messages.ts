import { isRecord } from "../../util.js";

export type OpenAITranslateServerEvent =
  | { type: "session.created" }
  | { type: "session.updated" }
  | { type: "session.closed" }
  | { type: "session.input_transcript.delta"; delta: string }
  | { type: "session.output_transcript.delta"; delta: string }
  | { type: "session.output_audio.delta" }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "ignored" };

export function parseOpenAITranslateMessage(raw: string): OpenAITranslateServerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "ignored" };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { type: "ignored" };
  }

  switch (parsed.type) {
    case "session.created":
    case "session.updated":
    case "session.closed":
      return { type: parsed.type };
    case "session.input_transcript.delta":
      return {
        type: "session.input_transcript.delta",
        delta: typeof parsed.delta === "string" ? parsed.delta : "",
      };
    case "session.output_transcript.delta":
      return {
        type: "session.output_transcript.delta",
        delta: typeof parsed.delta === "string" ? parsed.delta : "",
      };
    case "session.output_audio.delta":
      return { type: "session.output_audio.delta" };
    case "error":
      return {
        type: "error",
        message: readOpenAIErrorMessage(parsed),
        retryable: isRetryableOpenAIError(parsed),
      };
    default:
      return { type: "ignored" };
  }
}

function readOpenAIErrorMessage(payload: Record<string, unknown>): string {
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  if (isRecord(payload.error)) {
    if (typeof payload.error.message === "string" && payload.error.message.trim()) {
      return payload.error.message;
    }
  }
  return "OpenAI realtime translate reported an error";
}

function isRetryableOpenAIError(payload: Record<string, unknown>): boolean {
  const error = isRecord(payload.error) ? payload.error : payload;
  const code = typeof error.code === "string" ? error.code : "";
  return code === "rate_limit_exceeded"
    || code === "server_error"
    || code === "service_unavailable"
    || code === "timeout";
}
