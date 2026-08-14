import "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import {
  isAudioSampleRate,
  isChannelCount,
  isProviderId,
  isSupportedLanguage,
  type ClientMessage,
  type ProviderId,
  type ServerMessage,
  type StartSessionRequest,
} from "@doot/protocol";
import { WebSocket } from "ws";
import {
  ProviderRouter,
} from "./speech/router.js";
import type {
  ProviderStreamEvent,
  ProviderStreamSession,
} from "./speech/contract.js";
import {
  TranslationUnavailableError,
  type TranslateText,
} from "./translation/contract.js";
import { isRecord } from "./util.js";

const maxAudioChunkBytes = 256 * 1024;
const maxBase64Length = Math.ceil(maxAudioChunkBytes / 3) * 4;

export interface RealtimeGatewayOptions {
  utteranceGraceMs?: number;
  maxUtteranceMs?: number;
}

interface ActiveUtterance {
  id: string;
  sequence: number;
  revision: number;
  sourceText: string;
  startMs: number;
  endMs: number;
  graceTimer: NodeJS.Timeout | null;
  safetyTimer: NodeJS.Timeout | null;
  draftTimer: NodeJS.Timeout | null;
  draftMaxWaitTimer: NodeJS.Timeout | null;
  draftSourceText: string | null;
  draftTranslatedText: string | null;
  nativeTranslatedText: string | null;
}

interface SessionState {
  request: StartSessionRequest;
  providerId: ProviderId;
  nativeTranslation: boolean;
  providerSession: ProviderStreamSession | null;
  activeUtterance: ActiveUtterance | null;
  nextSequence: number;
  speechActive: boolean;
  pendingSpeechStartMs: number | null;
  lastAudioTimestampMs: number;
  lastAudioSequence: number;
  pendingFinalizations: Promise<void>;
  closing: boolean;
  closed: boolean;
}

interface RequiredGatewayOptions {
  utteranceGraceMs: number;
  maxUtteranceMs: number;
}

export function registerRealtimeGateway(
  app: FastifyInstance,
  router: ProviderRouter,
  translator: TranslateText,
  options: RealtimeGatewayOptions = {},
): void {
  const gatewayOptions: RequiredGatewayOptions = {
    utteranceGraceMs: options.utteranceGraceMs ?? 350,
    maxUtteranceMs: options.maxUtteranceMs ?? 60_000,
  };

  app.get("/v1/realtime", { websocket: true }, (socket: WebSocket, request) => {
    const sessions = new Map<string, SessionState>();
    let messageChain = Promise.resolve();
    app.log.info({ ip: request.ip }, "realtime client connected");

    socket.on("message", (raw) => {
      messageChain = messageChain
        .then(() => handleMessage(
          router,
          translator,
          gatewayOptions,
          socket,
          sessions,
          raw.toString(),
        ))
        .catch((error: unknown) => {
          app.log.error({ err: error }, "realtime message handler failed");
          send(socket, {
            type: "error",
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Realtime handler failed",
            retryable: true,
          });
        });
    });

    socket.on("error", (error) => {
      app.log.warn({ err: error }, "realtime socket error");
    });

    socket.on("close", () => {
      for (const session of sessions.values()) {
        disposeSession(session);
      }
      sessions.clear();
      app.log.info("realtime client disconnected");
    });
  });
}

async function handleMessage(
  router: ProviderRouter,
  translator: TranslateText,
  options: RequiredGatewayOptions,
  socket: WebSocket,
  sessions: Map<string, SessionState>,
  raw: string,
): Promise<void> {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    send(socket, {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Message does not match the realtime protocol",
      retryable: false,
    });
    return;
  }
  const message = parsed.message;

  if (message.type === "start_session") {
    await startSession(router, translator, options, socket, sessions, message);
    return;
  }

  const session = sessions.get(message.sessionId);
  if (!session) {
    send(socket, {
      type: "error",
      sessionId: message.sessionId,
      code: "SESSION_NOT_FOUND",
      message: "Start the session before sending audio",
      retryable: false,
    });
    return;
  }

  if (message.type === "audio_chunk") {
    if (session.closing || message.sequence <= session.lastAudioSequence) return;
    session.lastAudioSequence = message.sequence;
    session.lastAudioTimestampMs = message.timestampMs;
    session.providerSession?.pushAudio(
      Buffer.from(message.dataBase64, "base64"),
      message.timestampMs,
    );
    return;
  }

  await stopSession(translator, socket, session);
  sessions.delete(message.sessionId);
  send(socket, { type: "session_stopped", sessionId: message.sessionId });
}

async function startSession(
  router: ProviderRouter,
  translator: TranslateText,
  options: RequiredGatewayOptions,
  socket: WebSocket,
  sessions: Map<string, SessionState>,
  request: StartSessionRequest,
): Promise<void> {
  const previous = sessions.get(request.sessionId);
  if (previous) {
    disposeSession(previous);
    sessions.delete(request.sessionId);
  }

  try {
    const provider = router.select(
      request.sourceLanguage,
      request.provider,
      request.sampleRate,
      request.channels,
      request.targetLanguage,
    );
    const session: SessionState = {
      request,
      providerId: provider.id,
      nativeTranslation: provider.capabilities.nativeTranslation === true,
      providerSession: null,
      activeUtterance: null,
      nextSequence: 0,
      speechActive: false,
      pendingSpeechStartMs: null,
      lastAudioTimestampMs: 0,
      lastAudioSequence: -1,
      pendingFinalizations: Promise.resolve(),
      closing: false,
      closed: false,
    };
    sessions.set(request.sessionId, session);
    const providerSession = await provider.openSession({
      sessionId: request.sessionId,
      source: request.sourceLanguage,
      target: request.targetLanguage,
      sampleRate: request.sampleRate,
      channels: request.channels,
      onEvent: (event) => {
        handleProviderEvent(translator, options, socket, session, event);
      },
    });
    if (
      session.closed
      || sessions.get(request.sessionId) !== session
      || socket.readyState !== WebSocket.OPEN
    ) {
      await providerSession.close();
      return;
    }
    session.providerSession = providerSession;
    send(socket, {
      type: "session_started",
      sessionId: request.sessionId,
      provider: provider.id,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
    });
  } catch (error) {
    const session = sessions.get(request.sessionId);
    if (session) disposeSession(session);
    sessions.delete(request.sessionId);
    send(socket, {
      type: "error",
      sessionId: request.sessionId,
      code: "PROVIDER_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Requested provider is unavailable",
      retryable: false,
    });
  }
}

function handleProviderEvent(
  translator: TranslateText,
  options: RequiredGatewayOptions,
  socket: WebSocket,
  session: SessionState,
  event: ProviderStreamEvent,
): void {
  if (session.closed) return;

  switch (event.type) {
    case "speech_start": {
      session.speechActive = true;
      session.pendingSpeechStartMs = event.timestampMs;
      cancelGraceTimer(session.activeUtterance);
      return;
    }
    case "speech_end": {
      session.speechActive = false;
      if (session.activeUtterance) {
        session.activeUtterance.endMs = Math.max(
          session.activeUtterance.endMs,
          event.timestampMs,
        );
        scheduleGraceFinalization(translator, options, socket, session);
      } else {
        session.pendingSpeechStartMs = null;
      }
      return;
    }
    case "transcript": {
      updateActiveUtterance(translator, options, socket, session, event);
      if (event.isFinal && !session.nativeTranslation && session.activeUtterance) {
        session.speechActive = false;
        session.activeUtterance.endMs = Math.max(
          session.activeUtterance.endMs,
          event.timestampMs,
        );
        void finalizeActiveUtterance(translator, socket, session);
      }
      return;
    }
    case "translation": {
      updateNativeTranslation(translator, options, socket, session, event);
      return;
    }
    case "warning": {
      send(socket, {
        type: "error",
        sessionId: session.request.sessionId,
        code: "PROVIDER_WARNING",
        message: event.message,
        retryable: true,
      });
      return;
    }
    case "error": {
      send(socket, {
        type: "error",
        sessionId: session.request.sessionId,
        code: "PROVIDER_ERROR",
        message: event.message,
        retryable: event.retryable,
      });
      return;
    }
    case "state":
      return;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function updateActiveUtterance(
  translator: TranslateText,
  options: RequiredGatewayOptions,
  socket: WebSocket,
  session: SessionState,
  event: Extract<ProviderStreamEvent, { type: "transcript" }>,
): void {
  const transcript = normalizeTranscript(event.text);
  if (!transcript) return;

  let utterance = session.activeUtterance;
  if (!utterance) {
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    utterance = {
      id: `${session.request.sessionId}:${event.timestampMs}:${sequence}`,
      sequence,
      revision: 0,
      sourceText: "",
      startMs: session.pendingSpeechStartMs ?? event.timestampMs,
      endMs: event.timestampMs,
      graceTimer: null,
      safetyTimer: null,
      draftTimer: null,
      draftMaxWaitTimer: null,
      draftSourceText: null,
      draftTranslatedText: null,
      nativeTranslatedText: null,
    };
    session.activeUtterance = utterance;
    session.pendingSpeechStartMs = null;
    utterance.safetyTimer = setTimeout(() => {
      void finalizeActiveUtterance(translator, socket, session);
    }, options.maxUtteranceMs);
  }

  // Realtime `transcript.final` is the provider's authoritative complete
  // utterance, whereas partials can be overlapping incremental fragments.
  const mergedText = event.isFinal
    ? transcript
    : mergeProviderTranscript(utterance.sourceText, transcript);
  utterance.endMs = Math.max(utterance.endMs, event.timestampMs);
  if (mergedText === utterance.sourceText) return;

  utterance.sourceText = mergedText;
  utterance.revision += 1;
  // Keep the last good draft on-screen while a newer translation is in flight.
  const provisionalTranslated = session.nativeTranslation
    ? utterance.nativeTranslatedText ?? ""
    : utterance.draftTranslatedText
      && utterance.draftSourceText
      && mergedText.startsWith(utterance.draftSourceText)
      ? utterance.draftTranslatedText
      : "";
  sendCaption(
    socket,
    session,
    utterance,
    provisionalTranslated,
    false,
    utterance.revision,
  );
  if (!session.nativeTranslation) {
    scheduleDraftTranslation(translator, socket, session, utterance);
  }

  if (!session.speechActive) {
    scheduleGraceFinalization(translator, options, socket, session);
  }
}

function updateNativeTranslation(
  translator: TranslateText,
  options: RequiredGatewayOptions,
  socket: WebSocket,
  session: SessionState,
  event: Extract<ProviderStreamEvent, { type: "translation" }>,
): void {
  const translated = normalizeTranscript(event.text);
  if (!translated) return;

  let utterance = session.activeUtterance;
  if (!utterance) {
    // Native providers (Gemini) can emit translated text before source text.
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    utterance = {
      id: `${session.request.sessionId}:${event.timestampMs}:${sequence}`,
      sequence,
      revision: 0,
      sourceText: "",
      startMs: session.pendingSpeechStartMs ?? event.timestampMs,
      endMs: event.timestampMs,
      graceTimer: null,
      safetyTimer: null,
      draftTimer: null,
      draftMaxWaitTimer: null,
      draftSourceText: null,
      draftTranslatedText: null,
      nativeTranslatedText: null,
    };
    session.activeUtterance = utterance;
    session.pendingSpeechStartMs = null;
    utterance.safetyTimer = setTimeout(() => {
      void finalizeActiveUtterance(translator, socket, session);
    }, options.maxUtteranceMs);
  }

  // Native translation events are provider-normalized cumulative snapshots.
  const mergedText = translated;
  utterance.endMs = Math.max(utterance.endMs, event.timestampMs);
  if (mergedText !== utterance.nativeTranslatedText) {
    utterance.nativeTranslatedText = mergedText;
    utterance.draftTranslatedText = mergedText;
    utterance.draftSourceText = utterance.sourceText;
    if (!event.isFinal) {
      utterance.revision += 1;
      sendCaption(
        socket,
        session,
        utterance,
        mergedText,
        false,
        utterance.revision,
      );
    }
  }

  if (event.isFinal && session.activeUtterance === utterance) {
    session.speechActive = false;
    void finalizeActiveUtterance(translator, socket, session);
  }
}

const DRAFT_TRANSLATE_MS = 120;
const DRAFT_MAX_WAIT_MS = 450;

function scheduleDraftTranslation(
  translator: TranslateText,
  socket: WebSocket,
  session: SessionState,
  utterance: ActiveUtterance,
): void {
  if (utterance.draftTimer) clearTimeout(utterance.draftTimer);
  utterance.draftTimer = setTimeout(() => {
    utterance.draftTimer = null;
    clearDraftMaxWait(utterance);
    void runDraftTranslation(translator, socket, session, utterance);
  }, DRAFT_TRANSLATE_MS);

  // Continuous speech keeps resetting the trailing timer; force a draft at least
  // this often so English updates without waiting for a pause.
  if (!utterance.draftMaxWaitTimer) {
    utterance.draftMaxWaitTimer = setTimeout(() => {
      utterance.draftMaxWaitTimer = null;
      if (utterance.draftTimer) {
        clearTimeout(utterance.draftTimer);
        utterance.draftTimer = null;
      }
      void runDraftTranslation(translator, socket, session, utterance);
    }, DRAFT_MAX_WAIT_MS);
  }
}

function clearDraftMaxWait(utterance: ActiveUtterance): void {
  if (!utterance.draftMaxWaitTimer) return;
  clearTimeout(utterance.draftMaxWaitTimer);
  utterance.draftMaxWaitTimer = null;
}

async function runDraftTranslation(
  translator: TranslateText,
  socket: WebSocket,
  session: SessionState,
  utterance: ActiveUtterance,
): Promise<void> {
  if (
    session.closed
    || session.closing
    || session.activeUtterance !== utterance
    || !utterance.sourceText
  ) {
    return;
  }

  const sourceText = utterance.sourceText;
  const request = session.request;
  let translatedText = "";
  try {
    translatedText = await translator({
      text: sourceText,
      source: request.sourceLanguage,
      target: request.targetLanguage,
    });
  } catch {
    // Draft misses are fine; the final pass still reports translation errors.
    return;
  }

  if (
    session.closed
    || session.activeUtterance !== utterance
    || utterance.sourceText !== sourceText
  ) {
    return;
  }

  utterance.revision += 1;
  utterance.draftSourceText = sourceText;
  utterance.draftTranslatedText = translatedText;
  sendCaption(
    socket,
    session,
    utterance,
    utterance.draftTranslatedText,
    false,
    utterance.revision,
  );
}

function scheduleGraceFinalization(
  translator: TranslateText,
  options: RequiredGatewayOptions,
  socket: WebSocket,
  session: SessionState,
): void {
  const utterance = session.activeUtterance;
  if (!utterance || session.closing) return;
  cancelGraceTimer(utterance);
  utterance.graceTimer = setTimeout(() => {
    utterance.graceTimer = null;
    void finalizeActiveUtterance(translator, socket, session);
  }, options.utteranceGraceMs);
}

function finalizeActiveUtterance(
  translator: TranslateText,
  socket: WebSocket,
  session: SessionState,
): Promise<void> {
  const utterance = session.activeUtterance;
  if (!utterance || !utterance.sourceText) return session.pendingFinalizations;

  session.activeUtterance = null;
  clearUtteranceTimers(utterance);
  session.providerSession?.commitAudioThrough(utterance.endMs);
  const request = session.request;
  const finalize = async () => {
    let translatedText = session.nativeTranslation
      ? utterance.nativeTranslatedText ?? ""
      : utterance.draftTranslatedText ?? "";
    if (session.nativeTranslation) {
      if (session.closed) return;
      sendCaption(
        socket,
        session,
        utterance,
        translatedText,
        true,
        utterance.revision + 1,
      );
      return;
    }
    const canReuseDraft = Boolean(
      utterance.draftTranslatedText
      && utterance.draftSourceText === utterance.sourceText,
    );
    if (canReuseDraft && utterance.draftTranslatedText) {
      translatedText = utterance.draftTranslatedText;
    } else {
      try {
        translatedText = await translator({
          text: utterance.sourceText,
          source: request.sourceLanguage,
          target: request.targetLanguage,
        });
      } catch (error) {
        if (!session.closed) {
          send(socket, {
            type: "error",
            sessionId: request.sessionId,
            code: error instanceof TranslationUnavailableError
              ? "TRANSLATION_UNAVAILABLE"
              : "TRANSLATION_ERROR",
            message: error instanceof Error ? error.message : "Caption translation failed",
            retryable: !(error instanceof TranslationUnavailableError),
          });
        }
      }
    }
    if (session.closed) return;
    sendCaption(
      socket,
      session,
      utterance,
      translatedText,
      true,
      utterance.revision + 1,
    );
  };

  session.pendingFinalizations = session.pendingFinalizations.then(finalize, finalize);
  return session.pendingFinalizations;
}

async function stopSession(
  translator: TranslateText,
  socket: WebSocket,
  session: SessionState,
): Promise<void> {
  if (session.closing) {
    await session.pendingFinalizations;
    return;
  }
  session.closing = true;
  cancelGraceTimer(session.activeUtterance);

  try {
    await session.providerSession?.flush();
  } catch (error) {
    send(socket, {
      type: "error",
      sessionId: session.request.sessionId,
      code: "PROVIDER_FLUSH_ERROR",
      message: error instanceof Error ? error.message : "Speech provider flush failed",
        retryable: false,
    });
  } finally {
    try {
      await session.providerSession?.close();
    } catch (error) {
      send(socket, {
        type: "error",
        sessionId: session.request.sessionId,
        code: "PROVIDER_CLOSE_ERROR",
        message: error instanceof Error ? error.message : "Speech provider close failed",
        retryable: true,
      });
    }
    session.providerSession = null;
  }
  await finalizeActiveUtterance(translator, socket, session);
  await session.pendingFinalizations;
  session.closed = true;
  clearUtteranceTimers(session.activeUtterance);
  session.activeUtterance = null;
}

function sendCaption(
  socket: WebSocket,
  session: SessionState,
  utterance: ActiveUtterance,
  translatedText: string,
  isFinal: boolean,
  revision: number,
): void {
  send(socket, {
    type: "caption",
    sessionId: session.request.sessionId,
    sequence: utterance.sequence,
    utteranceId: utterance.id,
    revision,
    sourceText: utterance.sourceText,
    translatedText,
    isFinal,
    startMs: utterance.startMs,
    endMs: utterance.endMs,
    provider: session.providerId,
  });
}

function mergeProviderTranscript(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (existing === incoming || incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;

  const existingWords = existing.split(/\s+/);
  const incomingWords = incoming.split(/\s+/);
  if (hasWordPrefix(incomingWords, existingWords)) return incoming;
  if (hasWordPrefix(existingWords, incomingWords)) return existing;
  for (
    let overlap = Math.min(existingWords.length, incomingWords.length);
    overlap > 0;
    overlap -= 1
  ) {
    if (sameWords(
      existingWords.slice(-overlap),
      incomingWords.slice(0, overlap),
    )) {
      return [...existingWords, ...incomingWords.slice(overlap)].join(" ");
    }
  }
  return `${existing} ${incoming}`;
}

function hasWordPrefix(words: string[], prefix: string[]): boolean {
  return prefix.length <= words.length && sameWords(words.slice(0, prefix.length), prefix);
}

function sameWords(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((word, index) => wordsEquivalent(word, right[index] ?? ""));
}

function wordsEquivalent(left: string, right: string): boolean {
  const normalizeWord = (word: string) => word
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
  const normalizedLeft = normalizeWord(left);
  return normalizedLeft.length > 0 && normalizedLeft === normalizeWord(right);
}

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cancelGraceTimer(utterance: ActiveUtterance | null): void {
  if (!utterance?.graceTimer) return;
  clearTimeout(utterance.graceTimer);
  utterance.graceTimer = null;
}

function clearUtteranceTimers(utterance: ActiveUtterance | null): void {
  if (!utterance) return;
  if (utterance.graceTimer) clearTimeout(utterance.graceTimer);
  if (utterance.safetyTimer) clearTimeout(utterance.safetyTimer);
  if (utterance.draftTimer) clearTimeout(utterance.draftTimer);
  if (utterance.draftMaxWaitTimer) clearTimeout(utterance.draftMaxWaitTimer);
  utterance.graceTimer = null;
  utterance.safetyTimer = null;
  utterance.draftTimer = null;
  utterance.draftMaxWaitTimer = null;
}

function disposeSession(session: SessionState): void {
  session.closed = true;
  session.closing = true;
  clearUtteranceTimers(session.activeUtterance);
  session.activeUtterance = null;
  const providerSession = session.providerSession;
  session.providerSession = null;
  if (providerSession) void providerSession.close();
}

export function parseClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!isRecord(value) || typeof value.type !== "string") return { ok: false };

  if (value.type === "start_session") {
    if (
      !isSessionId(value.sessionId)
      || !isSupportedLanguage(value.sourceLanguage)
      || !isSupportedLanguage(value.targetLanguage)
      || !isAudioSampleRate(value.sampleRate)
      || !isChannelCount(value.channels)
      || (value.provider !== undefined && !isProviderId(value.provider))
    ) return { ok: false };

    return {
      ok: true,
      message: {
        type: "start_session",
        sessionId: value.sessionId,
        sourceLanguage: value.sourceLanguage,
        targetLanguage: value.targetLanguage,
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        sampleRate: value.sampleRate,
        channels: value.channels,
      },
    };
  }

  if (value.type === "audio_chunk") {
    if (
      !isSessionId(value.sessionId)
      || !isNonNegativeInteger(value.sequence)
      || !isNonNegativeInteger(value.timestampMs)
      || value.encoding !== "pcm_s16le"
      || !isBase64Chunk(value.dataBase64)
    ) return { ok: false };

    return {
      ok: true,
      message: {
        type: "audio_chunk",
        sessionId: value.sessionId,
        sequence: value.sequence,
        timestampMs: value.timestampMs,
        encoding: value.encoding,
        dataBase64: value.dataBase64,
      },
    };
  }

  if (value.type === "stop_session" && isSessionId(value.sessionId)) {
    return {
      ok: true,
      message: { type: "stop_session", sessionId: value.sessionId },
    };
  }

  return { ok: false };
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBase64Chunk(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxBase64Length
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && Buffer.byteLength(value, "base64") <= maxAudioChunkBytes;
}

function send(socket: WebSocket, event: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // The peer may close between the ready-state check and send.
  }
}
