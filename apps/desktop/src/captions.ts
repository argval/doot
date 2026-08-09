import type { CaptionEvent } from "@doot/protocol";

const MAX_FINALIZED_UTTERANCES = 18;
const MAX_VISIBLE_UTTERANCES = 2;

export interface CaptionState {
  finalized: CaptionEvent[];
  active: CaptionEvent | null;
}

export const EMPTY_CAPTION_STATE: CaptionState = {
  finalized: [],
  active: null,
};

export function reduceCaptionEvent(
  current: CaptionState,
  event: CaptionEvent,
): CaptionState {
  const knownRevision = revisionFor(current, event.utteranceId);
  if (event.revision <= knownRevision) return current;

  const finalizedIndex = current.finalized.findIndex(
    (utterance) => utterance.utteranceId === event.utteranceId,
  );
  if (!event.isFinal && finalizedIndex >= 0) {
    return current;
  }

  if (!event.isFinal) {
    return {
      finalized: current.finalized,
      active: event,
    };
  }

  const finalized = finalizedIndex >= 0
    ? current.finalized.map((utterance, index) => (
      index === finalizedIndex ? event : utterance
    ))
    : [...current.finalized, event];
  return {
    finalized: finalized.slice(-MAX_FINALIZED_UTTERANCES),
    active: current.active?.utteranceId === event.utteranceId
      ? null
      : current.active,
  };
}

/** Primary overlay line only — translations, never the source transcript. */
export function selectVisibleCaptions(state: CaptionState): {
  translatedText: string;
} {
  const utterances = state.active
    ? [...state.finalized, state.active]
    : state.finalized;
  const recent = utterances.slice(-MAX_VISIBLE_UTTERANCES);
  const translatedText = recent
    .map((utterance) => utterance.translatedText)
    .filter(Boolean)
    .join(" ");
  return { translatedText };
}

function revisionFor(state: CaptionState, utteranceId: string): number {
  if (state.active?.utteranceId === utteranceId) return state.active.revision;
  const finalized = state.finalized.find(
    (utterance) => utterance.utteranceId === utteranceId,
  );
  return finalized?.revision ?? -1;
}
