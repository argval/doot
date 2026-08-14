import type { CaptionEvent } from "@doot/protocol";

const MAX_FINALIZED_UTTERANCES = 18;
/** Recent speaker turns / pause-separated sections kept on-screen. */
const MAX_VISIBLE_UTTERANCES = 4;

export interface CaptionState {
  finalized: CaptionEvent[];
  active: CaptionEvent | null;
}

export interface VisibleCaptionLine {
  utteranceId: string;
  translatedText: string;
  isActive: boolean;
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

/**
 * Overlay turns: each VAD-finalized utterance is its own line.
 * Short pauses stay on one line because the gateway coalesces them into
 * a single utterance. Speaker changes and long pauses become new lines.
 */
export function selectVisibleCaptions(state: CaptionState): {
  lines: VisibleCaptionLine[];
} {
  const utterances = state.active
    ? [...state.finalized, state.active]
    : state.finalized;
  const recent = utterances.slice(-MAX_VISIBLE_UTTERANCES);
  const lines: VisibleCaptionLine[] = [];

  for (const utterance of recent) {
    const translatedText = utterance.translatedText.trim();
    if (!translatedText) continue;

    const previous = lines[lines.length - 1];
    if (
      previous
      && normalizeVisible(previous.translatedText) === normalizeVisible(translatedText)
    ) {
      // Avoid "where is this / where is this" when consecutive Gemini turns stutter.
      lines[lines.length - 1] = toVisibleLine(state, utterance, translatedText);
      continue;
    }

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

function normalizeVisible(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function revisionFor(state: CaptionState, utteranceId: string): number {
  if (state.active?.utteranceId === utteranceId) return state.active.revision;
  const finalized = state.finalized.find(
    (utterance) => utterance.utteranceId === utteranceId,
  );
  return finalized?.revision ?? -1;
}
