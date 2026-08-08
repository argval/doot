import assert from "node:assert/strict";
import test from "node:test";
import type { CaptionEvent } from "@doot/protocol";
import {
  EMPTY_CAPTION_STATE,
  reduceCaptionEvent,
  selectVisibleCaptions,
} from "../../../apps/desktop/src/captions.js";

test("replaces active revisions and commits only the final revision", () => {
  const first = caption({
    utteranceId: "session:100:0",
    revision: 1,
    sourceText: "ನಾನು Cursor",
  });
  const revised = caption({
    utteranceId: first.utteranceId,
    revision: 2,
    sourceText: "ನಾನು Cursor use ಮಾಡುತ್ತೇನೆ",
  });
  const finalized = caption({
    utteranceId: first.utteranceId,
    revision: 3,
    sourceText: revised.sourceText,
    translatedText: "I use Cursor",
    isFinal: true,
  });

  const active = reduceCaptionEvent(EMPTY_CAPTION_STATE, first);
  const replaced = reduceCaptionEvent(active, revised);
  assert.equal(replaced.active?.sourceText, revised.sourceText);
  assert.equal(replaced.finalized.length, 0);

  const stale = reduceCaptionEvent(replaced, first);
  assert.equal(stale, replaced);

  const committed = reduceCaptionEvent(replaced, finalized);
  assert.equal(committed.active, null);
  assert.deepEqual(committed.finalized, [finalized]);
  assert.deepEqual(selectVisibleCaptions(committed), {
    translatedText: "I use Cursor",
    sourceText: "ನಾನು Cursor use ಮಾಡುತ್ತೇನೆ",
  });
});

test("keeps a newer active utterance when an older translation finishes", () => {
  const older = caption({
    utteranceId: "session:100:0",
    revision: 1,
    sourceText: "older",
  });
  const newer = caption({
    utteranceId: "session:500:1",
    revision: 1,
    sourceText: "newer",
    startMs: 500,
    endMs: 600,
  });
  const olderFinal = caption({
    utteranceId: older.utteranceId,
    revision: 2,
    sourceText: older.sourceText,
    translatedText: "older translated",
    isFinal: true,
  });

  const withOlder = reduceCaptionEvent(EMPTY_CAPTION_STATE, older);
  const withNewer = reduceCaptionEvent(withOlder, newer);
  const finalized = reduceCaptionEvent(withNewer, olderFinal);

  assert.equal(finalized.active?.utteranceId, newer.utteranceId);
  assert.deepEqual(finalized.finalized, [olderFinal]);
});

test("deduplicates stale reconnect revisions for the same utterance identity", () => {
  const original = caption({
    utteranceId: "session:1000:0",
    revision: 2,
    sourceText: "same replayed phrase 42",
    translatedText: "same replayed phrase 42",
    isFinal: true,
    startMs: 1_000,
    endMs: 2_000,
  });
  const replayedPartial = caption({
    utteranceId: original.utteranceId,
    revision: 1,
    sourceText: original.sourceText,
    startMs: 1_900,
    endMs: 2_100,
  });
  const replayedFinal = {
    ...replayedPartial,
    revision: 2,
    translatedText: replayedPartial.sourceText,
    isFinal: true,
  } satisfies CaptionEvent;

  const committed = reduceCaptionEvent(EMPTY_CAPTION_STATE, original);
  const ignoredPartial = reduceCaptionEvent(committed, replayedPartial);
  assert.equal(ignoredPartial.active, null);
  assert.equal(ignoredPartial, committed);

  const deduplicated = reduceCaptionEvent(ignoredPartial, replayedFinal);
  assert.equal(deduplicated.finalized.length, 1);
  assert.equal(
    deduplicated.finalized[0]?.utteranceId,
    replayedFinal.utteranceId,
  );
});

test("bounds finalized utterances during long-running sessions", () => {
  let state = EMPTY_CAPTION_STATE;
  for (let index = 0; index < 100; index += 1) {
    state = reduceCaptionEvent(state, caption({
      sequence: index,
      utteranceId: `session:${index}:0`,
      revision: 2,
      sourceText: `utterance ${index}`,
      translatedText: `utterance ${index}`,
      isFinal: true,
      startMs: index * 1_000,
      endMs: index * 1_000 + 500,
    }));
  }

  assert.ok(state.finalized.length <= 18);
});

function caption(overrides: Partial<CaptionEvent>): CaptionEvent {
  return {
    type: "caption",
    sessionId: "session",
    sequence: 0,
    utteranceId: "session:100:0",
    revision: 1,
    sourceText: "source",
    translatedText: "",
    isFinal: false,
    startMs: 100,
    endMs: 200,
    provider: "mock",
    ...overrides,
  };
}
