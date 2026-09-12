import type { CaptionEvent } from "@doot/protocol";
import type { NativeCaptionTiming } from "./lib/timing";

export type DesktopCaptionEvent = CaptionEvent & { timing?: NativeCaptionTiming };

const MAX_HISTORY_UTTERANCES = 18;
/** Recent speaker turns / pause-separated sections kept on-screen. */
const MAX_VISIBLE_UTTERANCES = 4;

export interface CaptionState {
  /** Completed turns plus an older turn whose final translation is still settling. */
  history: DesktopCaptionEvent[];
  active: DesktopCaptionEvent | null;
}

export type SpeakerTint = 1 | 2 | 3;

export interface VisibleCaptionLine {
  utteranceId: string;
  translatedText: string;
  isActive: boolean;
  /** Settled diarized lines only. The live line stays citron via `.live`. */
  speakerTint?: SpeakerTint;
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
  const latestSequence = Math.max(current.active?.sequence ?? -1, current.history.at(-1)?.sequence ?? -1);
  if (!event.isFinal && (historyIndex >= 0 || event.sequence < latestSequence)) {
    if (current.history[historyIndex]?.isFinal) return current;
    return {
      history: upsertUtterance(current.history, event).slice(-MAX_HISTORY_UTTERANCES),
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
  const isActive = state.active?.utteranceId === utterance.utteranceId;
  const speakerTint = speakerTintFor(utterance.speakerId, isActive);
  return {
    utteranceId: utterance.utteranceId,
    translatedText,
    isActive,
    ...(speakerTint ? { speakerTint } : {}),
  };
}

/** Map a provider speaker label onto the three overlay bar tints. Live lines stay citron. */
export function speakerTintFor(
  speakerId: string | undefined,
  isActive: boolean,
): SpeakerTint | undefined {
  if (isActive || !speakerId) return undefined;
  let hash = 0;
  for (let index = 0; index < speakerId.length; index += 1) {
    hash = (hash * 31 + speakerId.charCodeAt(index)) >>> 0;
  }
  return ((hash % 3) + 1) as SpeakerTint;
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
  if (index < 0) return [...utterances, event].sort((left, right) => left.sequence - right.sequence);
  return utterances.map((utterance, currentIndex) => (
    currentIndex === index ? event : utterance
  ));
}
