import { isRecord } from "../../util.js";

export type ElevenLabsMessage =
  | { kind: "session_started"; messageType: "session_started" }
  | {
    kind: "transcript";
    messageType: string;
    text: string;
    committed: boolean;
    languageCode?: string;
  }
  | {
    kind: "error";
    messageType: string;
    message: string;
    retryable: boolean;
  }
  | { kind: "unknown"; messageType?: string }
  | { kind: "invalid" };

const errorMessageTypes = new Set([
  "auth_error",
  "quota_exceeded",
  "transcriber_error",
  "input_error",
  "error",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

const retryableErrorMessageTypes = new Set([
  "transcriber_error",
  "error",
  "commit_throttled",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "insufficient_audio_activity",
]);

export function parseElevenLabsMessage(raw: string): ElevenLabsMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(payload) || typeof payload.message_type !== "string") {
    return { kind: "unknown" };
  }

  const messageType = payload.message_type;
  if (messageType === "session_started") {
    return { kind: "session_started", messageType };
  }
  if (
    messageType === "partial_transcript"
    || messageType === "final_transcript"
    || messageType === "committed_transcript"
    || messageType === "committed_transcript_with_timestamps"
  ) {
    const languageCode = typeof payload.language_code === "string"
      ? payload.language_code
      : undefined;
    return {
      kind: "transcript",
      messageType,
      text: typeof payload.text === "string" ? payload.text.trim() : "",
      committed: messageType.startsWith("committed_transcript"),
      ...(languageCode ? { languageCode } : {}),
    };
  }
  if (errorMessageTypes.has(messageType)) {
    const message = typeof payload.error === "string"
      ? payload.error
      : typeof payload.message === "string"
        ? payload.message
        : `ElevenLabs realtime error: ${messageType}`;
    return {
      kind: "error",
      messageType,
      message,
      retryable: retryableErrorMessageTypes.has(messageType),
    };
  }
  return { kind: "unknown", messageType };
}
