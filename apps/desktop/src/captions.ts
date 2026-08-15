import type { CaptionEvent } from "@doot/protocol";

const MAX_HISTORY_UTTERANCES = 18;
/** Recent speaker turns / pause-separated sections kept on-screen. */
const MAX_VISIBLE_UTTERANCES = 4;

export interface CaptionState {
  /** Completed turns plus an older turn whose final translation is still settling. */
  history: CaptionEvent[];
  active: CaptionEvent | null;
}

export interface VisibleCaptionLine {
  utteranceId: string;
  translatedText: string;
  isActive: boolean;
}

export const EMPTY_CAPTION_STATE: CaptionState = {
  history: [],
  active: null,
};

export function reduceCaptionEvent(
  current: CaptionState,
  event: CaptionEvent,
): CaptionState {
  const knownRevision = revisionFor(current, event.utteranceId);
  if (event.revision <= knownRevision) return current;

  const historyIndex = current.history.findIndex(
    (utterance) => utterance.utteranceId === event.utteranceId,
  );
  if (!event.isFinal && historyIndex >= 0) {
    if (current.history[historyIndex]?.isFinal) return current;
    return {
      history: upsertUtterance(current.history, event),
      active: current.active,
    };
  }

  if (!event.isFinal) {
    const history = current.active && current.active.utteranceId !== event.utteranceId
      ? upsertUtterance(current.history, current.active)
      : current.history;
    return {
      history: history.slice(-MAX_HISTORY_UTTERANCES),
      active: event,
    };
  }

  const history = upsertUtterance(current.history, event);
  return {
    history: history.slice(-MAX_HISTORY_UTTERANCES),
    active: current.active?.utteranceId === event.utteranceId
      ? null
      : current.active,
  };
}

/**
 * Overlay turns: each provider-finalized speech interval is its own line.
 * Pauses below the provider's VAD threshold remain in the active interval.
 */
export function selectVisibleCaptions(state: CaptionState): {
  lines: VisibleCaptionLine[];
} {
  const utterances = state.active
    ? [...state.history, state.active]
    : state.history;
  const recent = utterances.slice(-MAX_VISIBLE_UTTERANCES);
  const lines: VisibleCaptionLine[] = [];

  for (const utterance of recent) {
    const translatedText = utterance.translatedText.trim();
    if (!translatedText) continue;
    lines.push(toVisibleLine(state, utterance, translatedText));
  }

  return { lines };
}

function toVisibleLine(
  state: CaptionState,
  utterance: CaptionEvent,
  translatedText: string,
): VisibleCaptionLine {
  return {
    utteranceId: utterance.utteranceId,
    translatedText,
    isActive: state.active?.utteranceId === utterance.utteranceId,
  };
}

function revisionFor(state: CaptionState, utteranceId: string): number {
  if (state.active?.utteranceId === utteranceId) return state.active.revision;
  const finalized = state.history.find(
    (utterance) => utterance.utteranceId === utteranceId,
  );
  return finalized?.revision ?? -1;
}

function upsertUtterance(
  utterances: CaptionEvent[],
  event: CaptionEvent,
): CaptionEvent[] {
  const index = utterances.findIndex(
    (utterance) => utterance.utteranceId === event.utteranceId,
  );
  if (index < 0) return [...utterances, event];
  return utterances.map((utterance, currentIndex) => (
    currentIndex === index ? event : utterance
  ));
}
