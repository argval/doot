import "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { DootDb } from "@doot/db";
import {
  createCaptionSession,
  saveCaptionSegment,
  stopCaptionSession,
} from "@doot/db/captions";
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
import { mergeStreamingText } from "./merge-text.js";

const maxAudioChunkBytes = 256 * 1024;
const maxBase64Length = Math.ceil(maxAudioChunkBytes / 3) * 4;
const MAX_COMPLETED_PROVIDER_TURNS = 32;

export interface RealtimeGatewayOptions {
  db?: DootDb;
  utteranceGraceMs?: number;
}

interface ActiveUtterance {
  id: string;
  sequence: number;
  revision: number;
  sourceText: string;
  startMs: number;
  endMs: number;
  providerTurnId: string | null;
  graceTimer: NodeJS.Timeout | null;
  draftTimer: NodeJS.Timeout | null;
  draftMaxWaitTimer: NodeJS.Timeout | null;
  draftInFlight: boolean;
  draftInFlightSourceText: string | null;
  draftPending: boolean;
  draftCompletion: Promise<void> | null;
  draftSourceText: string | null;
  draftTranslatedText: string | null;
  nativeTranslatedText: string | null;
}

interface SessionState {
  request: StartSessionRequest;
  providerId: ProviderId;
  db: DootDb | null;
  storedSessionId: string | null;
  reportPersistenceError: (error: unknown, operation: string) => void;
  nativeTranslation: boolean;
  providerSession: ProviderStreamSession | null;
  activeUtterance: ActiveUtterance | null;
  nextSequence: number;
  speechActive: boolean;
  pendingSpeechStartMs: number | null;
  pendingSpeechTurnId: string | null;
  completedProviderTurnIds: string[];
  lastAudioTimestampMs: number;
  lastAudioSequence: number;
  pendingFinalizations: Promise<void>;
  pendingPersistence: Promise<void>;
  closing: boolean;
  closed: boolean;
}

interface RequiredGatewayOptions {
  db: DootDb | null;
  utteranceGraceMs: number;
  onPersistenceError: (
    error: unknown,
    sessionId: string,
    operation: string,
  ) => void;
}

export function registerRealtimeGateway(
  app: FastifyInstance,
  router: ProviderRouter,
  translator: TranslateText,
  options: RealtimeGatewayOptions = {},
): void {
  const gatewayOptions: RequiredGatewayOptions = {
    db: options.db ?? null,
    utteranceGraceMs: options.utteranceGraceMs ?? 350,
    onPersistenceError: (error, sessionId, operation) => {
      app.log.error({ err: error, operation, sessionId }, "caption persistence failed");
    },
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
        void finishStoredSession(session).catch((error) => {
          session.reportPersistenceError(error, "close session");
        });
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
    void finishStoredSession(previous).catch((error) => {
      previous.reportPersistenceError(error, "replace session");
    });
    sessions.delete(request.sessionId);
  }

  let session: SessionState | null = null;
  try {
    const provider = router.select(
      request.sourceLanguage,
      request.provider,
      request.sampleRate,
      request.channels,
      request.targetLanguage,
    );
    const openedSession: SessionState = {
      request,
      providerId: provider.id,
      db: options.db,
      storedSessionId: null,
      reportPersistenceError: (error, operation) => {
        options.onPersistenceError(error, request.sessionId, operation);
      },
      nativeTranslation: provider.capabilities.nativeTranslation === true,
      providerSession: null,
      activeUtterance: null,
      nextSequence: 0,
      speechActive: false,
      pendingSpeechStartMs: null,
      pendingSpeechTurnId: null,
      completedProviderTurnIds: [],
      lastAudioTimestampMs: 0,
      lastAudioSequence: -1,
      pendingFinalizations: Promise.resolve(),
      pendingPersistence: Promise.resolve(),
      closing: false,
      closed: false,
    };
    session = openedSession;
    sessions.set(request.sessionId, openedSession);
    const providerSession = await provider.openSession({
      sessionId: request.sessionId,
      source: request.sourceLanguage,
      target: request.targetLanguage,
      sampleRate: request.sampleRate,
      channels: request.channels,
      onEvent: (event) => {
        handleProviderEvent(translator, options, socket, openedSession, event);
      },
    });
    if (
      openedSession.closed
      || sessions.get(request.sessionId) !== openedSession
      || socket.readyState !== WebSocket.OPEN
    ) {
      await providerSession.close();
      return;
    }
    openedSession.providerSession = providerSession;
  } catch (error) {
    if (session) {
      disposeSession(session);
      if (sessions.get(request.sessionId) === session) {
        sessions.delete(request.sessionId);
      }
    }
    send(socket, {
      type: "error",
      sessionId: request.sessionId,
      code: "PROVIDER_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Requested provider is unavailable",
      retryable: false,
    });
    return;
  }

  if (!session) return;

  try {
    await persistSession(session);
  } catch (error) {
    session.reportPersistenceError(error, "create session");
  }

  if (
    session.closed
    || sessions.get(request.sessionId) !== session
    || socket.readyState !== WebSocket.OPEN
  ) {
    disposeSession(session);
    if (sessions.get(request.sessionId) === session) {
      sessions.delete(request.sessionId);
    }
    void finishStoredSession(session).catch((error) => {
      session.reportPersistenceError(error, "close abandoned session");
    });
    return;
  }

  send(socket, {
    type: "session_started",
    sessionId: request.sessionId,
    provider: session.providerId,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
  });
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
      if (isCompletedProviderTurn(session, event.turnId)) return;
      if (
        event.turnId
        && session.pendingSpeechTurnId
        && event.turnId !== session.pendingSpeechTurnId
        && !session.activeUtterance
      ) {
        // ponytail: real adapters preserve late finals; discard a generic
        // textless interval rather than letting it corrupt the newer turn.
        rememberCompletedProviderTurn(session, session.pendingSpeechTurnId);
      }
      const activeTurnId = session.activeUtterance?.providerTurnId;
      const changedTurn = Boolean(
        event.turnId && activeTurnId && event.turnId !== activeTurnId,
      );
      if (session.activeUtterance && (!session.speechActive || changedTurn)) {
        void finalizeActiveUtterance(translator, socket, session);
      }
      session.speechActive = true;
      session.pendingSpeechStartMs = event.timestampMs;
      session.pendingSpeechTurnId = event.turnId ?? null;
      cancelGraceTimer(session.activeUtterance);
      return;
    }
    case "speech_end": {
      if (isCompletedProviderTurn(session, event.turnId)) {
        if (!session.activeUtterance && !session.pendingSpeechTurnId) {
          session.speechActive = false;
        }
        return;
      }
      if (
        event.turnId
        && session.activeUtterance?.providerTurnId
        && event.turnId !== session.activeUtterance.providerTurnId
      ) return;
      session.speechActive = false;
      if (session.activeUtterance) {
        session.activeUtterance.endMs = Math.max(
          session.activeUtterance.endMs,
          event.timestampMs,
        );
        scheduleGraceFinalization(translator, options, socket, session);
      }
      return;
    }
    case "transcript": {
      const accepted = updateActiveUtterance(
        translator,
        options,
        socket,
        session,
        event,
      );
      if (
        accepted
        && event.isFinal
        && !session.nativeTranslation
        && session.activeUtterance
      ) {
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
): boolean {
  const transcript = normalizeTranscript(event.text);
  if (!transcript) return false;
  if (isCompletedProviderTurn(session, event.turnId)) return false;

  let utterance = session.activeUtterance;
  if (
    utterance
    && event.turnId
    && utterance.providerTurnId
    && event.turnId !== utterance.providerTurnId
  ) {
    void finalizeActiveUtterance(translator, socket, session);
    utterance = null;
  }
  if (!utterance) {
    utterance = openActiveUtterance(session, event.timestampMs, event.turnId);
  } else if (!utterance.providerTurnId && event.turnId) {
    utterance.providerTurnId = event.turnId;
  }

  // Realtime `transcript.final` is the provider's authoritative complete
  // utterance, whereas partials can be overlapping incremental fragments.
  const mergedText = event.isFinal
    ? transcript
    : mergeStreamingText(utterance.sourceText, transcript);
  utterance.endMs = Math.max(utterance.endMs, event.timestampMs);
  if (mergedText === utterance.sourceText) return true;

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
  return true;
}

function openActiveUtterance(
  session: SessionState,
  timestampMs: number,
  providerTurnId?: string,
): ActiveUtterance {
  const sequence = session.nextSequence;
  session.nextSequence += 1;
  const pendingStartMatches = session.pendingSpeechStartMs !== null
    && (
      !providerTurnId
      || !session.pendingSpeechTurnId
      || providerTurnId === session.pendingSpeechTurnId
    );
  const utterance: ActiveUtterance = {
    id: `${session.request.sessionId}:${timestampMs}:${sequence}`,
    sequence,
    revision: 0,
    sourceText: "",
    startMs: pendingStartMatches ? session.pendingSpeechStartMs! : timestampMs,
    endMs: timestampMs,
    providerTurnId: providerTurnId ?? null,
    graceTimer: null,
    draftTimer: null,
    draftMaxWaitTimer: null,
    draftInFlight: false,
    draftInFlightSourceText: null,
    draftPending: false,
    draftCompletion: null,
    draftSourceText: null,
    draftTranslatedText: null,
    nativeTranslatedText: null,
  };
  session.activeUtterance = utterance;
  if (pendingStartMatches) {
    session.pendingSpeechStartMs = null;
    session.pendingSpeechTurnId = null;
  }
  return utterance;
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
  if (isCompletedProviderTurn(session, event.turnId)) return;

  let utterance = session.activeUtterance;
  if (
    utterance
    && event.turnId
    && utterance.providerTurnId
    && event.turnId !== utterance.providerTurnId
  ) {
    void finalizeActiveUtterance(translator, socket, session);
    utterance = null;
  }
  if (!utterance) {
    // Native providers (Gemini) can emit translated text before source text.
    utterance = openActiveUtterance(session, event.timestampMs, event.turnId);
  } else if (!utterance.providerTurnId && event.turnId) {
    utterance.providerTurnId = event.turnId;
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
    queueDraftTranslation(translator, socket, session, utterance);
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
      queueDraftTranslation(translator, socket, session, utterance);
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
  utterance.draftInFlight = true;
  utterance.draftPending = false;
  const sourceText = utterance.sourceText;
  utterance.draftInFlightSourceText = sourceText;
  const request = session.request;
  let translatedText: string | null = null;
  try {
    translatedText = await translator({
      text: sourceText,
      source: request.sourceLanguage,
      target: request.targetLanguage,
    });
  } catch {
    // Draft misses are fine; the final pass still reports translation errors.
  } finally {
    utterance.draftInFlight = false;
    utterance.draftInFlightSourceText = null;
  }

  if (
    translatedText === null
    || session.closed
    || utterance.sourceText !== sourceText
  ) {
    if (
      utterance.draftPending
      && !session.closed
      && !session.closing
      && session.activeUtterance === utterance
    ) {
      queueDraftTranslation(translator, socket, session, utterance);
    }
    return;
  }

  utterance.draftSourceText = sourceText;
  utterance.draftTranslatedText = translatedText;
  if (session.activeUtterance === utterance) {
    utterance.revision += 1;
    sendCaption(
      socket,
      session,
      utterance,
      utterance.draftTranslatedText,
      false,
      utterance.revision,
    );
  }
}

function queueDraftTranslation(
  translator: TranslateText,
  socket: WebSocket,
  session: SessionState,
  utterance: ActiveUtterance,
): void {
  if (
    session.closed
    || session.closing
    || session.activeUtterance !== utterance
    || !utterance.sourceText
  ) {
    return;
  }
  if (utterance.draftInFlight) {
    utterance.draftPending = true;
    return;
  }

  const completion = runDraftTranslation(translator, socket, session, utterance);
  utterance.draftCompletion = completion;
  void completion.finally(() => {
    if (utterance.draftCompletion === completion) utterance.draftCompletion = null;
  });
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
  if (
    !utterance
    || (!utterance.sourceText && !utterance.nativeTranslatedText)
  ) return session.pendingFinalizations;

  session.activeUtterance = null;
  if (utterance.providerTurnId) {
    rememberCompletedProviderTurn(session, utterance.providerTurnId);
  }
  clearUtteranceTimers(utterance);
  session.providerSession?.commitAudioThrough(utterance.endMs);
  const request = session.request;
  const finalize = async () => {
    if (
      utterance.draftCompletion
      && utterance.draftInFlightSourceText === utterance.sourceText
    ) {
      await utterance.draftCompletion;
    }
    let translatedText = session.nativeTranslation
      ? utterance.nativeTranslatedText ?? ""
      : utterance.draftTranslatedText ?? "";
    if (!session.nativeTranslation) {
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
    }
    if (session.closed) return;
    queueFinalizedCaption(session, utterance, translatedText);
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
  try {
    await finishStoredSession(session);
  } catch (error) {
    session.reportPersistenceError(error, "stop session");
  }
  session.closed = true;
  clearUtteranceTimers(session.activeUtterance);
  session.activeUtterance = null;
}

async function persistSession(session: SessionState): Promise<void> {
  if (!session.db) return;
  session.storedSessionId = await createCaptionSession(session.db, {
    sourceLanguage: session.request.sourceLanguage,
    targetLanguage: session.request.targetLanguage,
    provider: session.providerId,
  });
}

async function persistFinalizedCaption(
  session: SessionState,
  utterance: ActiveUtterance,
  translatedText: string,
): Promise<void> {
  if (!session.db || !session.storedSessionId) return;
  await saveCaptionSegment(session.db, {
    sessionId: session.storedSessionId,
    sequence: utterance.sequence,
    sourceText: utterance.sourceText,
    translatedText,
    startMs: utterance.startMs,
    endMs: utterance.endMs,
  });
}

function queueFinalizedCaption(
  session: SessionState,
  utterance: ActiveUtterance,
  translatedText: string,
): void {
  if (!session.db || !session.storedSessionId) return;
  const persist = async () => {
    try {
      await persistFinalizedCaption(session, utterance, translatedText);
    } catch (error) {
      // ponytail: log without a retry queue; add an outbox if local writes prove unreliable.
      session.reportPersistenceError(error, "save finalized caption");
    }
  };
  session.pendingPersistence = session.pendingPersistence.then(persist, persist);
}

async function stopStoredSession(session: SessionState): Promise<void> {
  if (!session.db || !session.storedSessionId) return;
  await stopCaptionSession(session.db, session.storedSessionId);
}

async function finishStoredSession(session: SessionState): Promise<void> {
  await session.pendingPersistence;
  await stopStoredSession(session);
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

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isCompletedProviderTurn(
  session: SessionState,
  turnId: string | undefined,
): boolean {
  return Boolean(turnId && session.completedProviderTurnIds.includes(turnId));
}

function rememberCompletedProviderTurn(session: SessionState, turnId: string): void {
  if (session.completedProviderTurnIds.includes(turnId)) return;
  session.completedProviderTurnIds.push(turnId);
  if (session.completedProviderTurnIds.length > MAX_COMPLETED_PROVIDER_TURNS) {
    session.completedProviderTurnIds.shift();
  }
}

function cancelGraceTimer(utterance: ActiveUtterance | null): void {
  if (!utterance?.graceTimer) return;
  clearTimeout(utterance.graceTimer);
  utterance.graceTimer = null;
}

function clearUtteranceTimers(utterance: ActiveUtterance | null): void {
  if (!utterance) return;
  if (utterance.graceTimer) clearTimeout(utterance.graceTimer);
  if (utterance.draftTimer) clearTimeout(utterance.draftTimer);
  if (utterance.draftMaxWaitTimer) clearTimeout(utterance.draftMaxWaitTimer);
  utterance.graceTimer = null;
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
