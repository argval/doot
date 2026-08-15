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
  assert.equal(replaced.history.length, 0);
  assert.deepEqual(selectVisibleCaptions(replaced), {
    lines: [],
  });

  const stale = reduceCaptionEvent(replaced, first);
  assert.equal(stale, replaced);

  const committed = reduceCaptionEvent(replaced, finalized);
  assert.equal(committed.active, null);
  assert.deepEqual(committed.history, [finalized]);
  assert.deepEqual(selectVisibleCaptions(committed), {
    lines: [{
      utteranceId: finalized.utteranceId,
      translatedText: "I use Cursor",
      isActive: false,
    }],
  });
});

test("keeps the overlay focused on the newest few utterance turns", () => {
  let state = EMPTY_CAPTION_STATE;
  for (let index = 0; index < 6; index += 1) {
    state = reduceCaptionEvent(state, caption({
      sequence: index,
      utteranceId: `session:${index}:0`,
      revision: 1,
      sourceText: `source ${index}`,
      translatedText: `english ${index}`,
      isFinal: true,
      startMs: index * 1_000,
      endMs: index * 1_000 + 500,
    }));
  }

  assert.deepEqual(
    selectVisibleCaptions(state).lines.map((line) => line.translatedText),
    ["english 2", "english 3", "english 4", "english 5"],
  );
});

test("puts speaker turns and long-pause sections on separate overlay lines", () => {
  let state = EMPTY_CAPTION_STATE;
  state = reduceCaptionEvent(state, caption({
    utteranceId: "session:100:0",
    translatedText: "How was your day?",
    isFinal: true,
    startMs: 100,
    endMs: 1_400,
  }));
  state = reduceCaptionEvent(state, caption({
    utteranceId: "session:2200:1",
    sequence: 1,
    translatedText: "It was good, thanks.",
    isFinal: true,
    startMs: 2_200,
    endMs: 3_400,
  }));

  const visible = selectVisibleCaptions(state);
  assert.deepEqual(
    visible.lines.map((line) => line.translatedText),
    ["How was your day?", "It was good, thanks."],
  );
  assert.equal(visible.lines[0]?.utteranceId, "session:100:0");
  assert.equal(visible.lines[1]?.utteranceId, "session:2200:1");
  assert.equal(visible.lines.every((line) => !line.isActive), true);
});

test("starts a new overlay line when speech resumes after a pause", () => {
  let state = reduceCaptionEvent(EMPTY_CAPTION_STATE, caption({
    utteranceId: "session:100:0",
    translatedText: "First section of the talk.",
    isFinal: true,
    startMs: 100,
    endMs: 2_000,
  }));
  state = reduceCaptionEvent(state, caption({
    utteranceId: "session:5000:1",
    sequence: 1,
    translatedText: "After a long pause.",
    isFinal: false,
    startMs: 5_000,
    endMs: 5_400,
  }));

  const visible = selectVisibleCaptions(state);
  assert.deepEqual(
    visible.lines.map((line) => line.translatedText),
    ["First section of the talk.", "After a long pause."],
  );
  assert.equal(visible.lines[0]?.isActive, false);
  assert.equal(visible.lines[1]?.isActive, true);
});

test("keeps one overlay line while a single speaker's utterance revises", () => {
  let state = reduceCaptionEvent(EMPTY_CAPTION_STATE, caption({
    utteranceId: "session:100:0",
    revision: 1,
    translatedText: "I went to the",
  }));
  state = reduceCaptionEvent(state, caption({
    utteranceId: "session:100:0",
    revision: 2,
    translatedText: "I went to the store today",
  }));

  const visible = selectVisibleCaptions(state);
  assert.equal(visible.lines.length, 1);
  assert.deepEqual(visible.lines[0], {
    utteranceId: "session:100:0",
    translatedText: "I went to the store today",
    isActive: true,
  });
});

test("keeps a newer active utterance when an older translation finishes", () => {
  const older = caption({
    utteranceId: "session:100:0",
    revision: 1,
    sourceText: "older",
    translatedText: "older draft",
  });
  const newer = caption({
    utteranceId: "session:500:1",
    revision: 1,
    sourceText: "newer",
    translatedText: "newer draft",
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
  assert.deepEqual(
    selectVisibleCaptions(withNewer).lines.map((line) => line.translatedText),
    ["older draft", "newer draft"],
  );
  const finalized = reduceCaptionEvent(withNewer, olderFinal);

  assert.equal(finalized.active?.utteranceId, newer.utteranceId);
  assert.deepEqual(finalized.history, [olderFinal]);
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
  assert.equal(deduplicated.history.length, 1);
  assert.equal(
    deduplicated.history[0]?.utteranceId,
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

  assert.ok(state.history.length <= 18);
});

test("keeps identical translated text on distinct utterance lines", () => {
  let state = EMPTY_CAPTION_STATE;
  state = reduceCaptionEvent(state, caption({
    utteranceId: "session:1:0",
    revision: 1,
    translatedText: "Where is this",
    isFinal: true,
    startMs: 100,
    endMs: 200,
  }));
  state = reduceCaptionEvent(state, caption({
    utteranceId: "session:2:1",
    sequence: 1,
    revision: 1,
    translatedText: "Where is this",
    isFinal: true,
    startMs: 300,
    endMs: 400,
  }));

  assert.deepEqual(selectVisibleCaptions(state), {
    lines: [
      {
        utteranceId: "session:1:0",
        translatedText: "Where is this",
        isActive: false,
      },
      {
        utteranceId: "session:2:1",
        translatedText: "Where is this",
        isActive: false,
      },
    ],
  });
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
