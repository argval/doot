import type { CaptionEvent } from "@doot/protocol";

export interface CaptionObservation { caption: CaptionEvent; receivedAtMs: number }
export interface CaptionReference { sourceText: string; boundariesMs: number[] }

export function parseReference(value: unknown): CaptionReference {
  if (!value || typeof value !== "object" || !("sourceText" in value)
    || typeof value.sourceText !== "string" || !value.sourceText.trim() || value.sourceText.length > 5000
    || !("boundariesMs" in value) || !Array.isArray(value.boundariesMs)
    || value.boundariesMs.length > 1000
    || !value.boundariesMs.every((time: unknown) => typeof time === "number" && Number.isFinite(time) && time >= 0)
    || value.boundariesMs.some((time: number, index: number, times: number[]) => index > 0 && time <= times[index - 1]!)) {
    throw new Error("Reference needs sourceText (1–5000 characters) and strictly increasing, nonnegative boundariesMs.");
  }
  return { sourceText: value.sourceText, boundariesMs: value.boundariesMs as number[] };
}

export function summarizeCaptions(observations: CaptionObservation[], reference?: CaptionReference) {
  const turns = new Map<string, { caption: CaptionEvent; firstSourceMs: number | null; firstTranslationMs: number | null; finalMs: number | null }>();
  for (const { caption, receivedAtMs } of observations) {
    let turn = turns.get(caption.utteranceId);
    if (!turn) {
      turn = { caption, firstSourceMs: null, firstTranslationMs: null, finalMs: null };
      turns.set(caption.utteranceId, turn);
    } else if (caption.revision <= turn.caption.revision) continue;
    turn.caption = caption;
    if (caption.sourceText.trim() && turn.firstSourceMs === null) turn.firstSourceMs = receivedAtMs;
    if (caption.translatedText.trim() && turn.firstTranslationMs === null) turn.firstTranslationMs = receivedAtMs;
    if (caption.isFinal) turn.finalMs = receivedAtMs;
  }
  const ordered = [...turns.values()].sort((left, right) => left.caption.sequence - right.caption.sequence);
  const finalized = ordered.filter((turn) => turn.caption.isFinal);
  const sourceText = finalized.map((turn) => turn.caption.sourceText).join(" ");
  const sourceToTranslation = ordered.flatMap((turn) => turn.firstSourceMs !== null && turn.firstTranslationMs !== null
    ? [Math.max(0, turn.firstTranslationMs - turn.firstSourceMs)] : []);
  return {
    finalTranslation: finalized.map((turn) => turn.caption.translatedText).join("\n"),
    finalSourceText: sourceText,
    finalizedTurns: finalized.length,
    unfinishedTurns: ordered.length - finalized.length,
    sourceToFirstTranslationMs: percentiles(sourceToTranslation),
    // Provider endMs is audio-duration-aware, but not forced-aligned to words.
    // This is an estimate, not ground truth audio-to-display latency.
    estimatedFinalLagMs: percentiles(finalized.map((turn) => turn.finalMs! - turn.caption.endMs)),
    turns: ordered.map((turn) => ({
      utteranceId: turn.caption.utteranceId, sequence: turn.caption.sequence,
      startMs: turn.caption.startMs, endMs: turn.caption.endMs,
      firstSourceMs: turn.firstSourceMs, firstTranslationMs: turn.firstTranslationMs, finalMs: turn.finalMs,
      sourceText: turn.caption.sourceText, translatedText: turn.caption.translatedText,
    })),
    ...(reference ? { referenceScores: {
      sourceWordErrorRate: errorRate(words(reference.sourceText), words(sourceText)),
      sourceCharacterErrorRate: errorRate([...normalize(reference.sourceText).replace(/\s/gu, "")], [...normalize(sourceText).replace(/\s/gu, "")]),
      estimatedBoundaryScore: scoreBoundaries(reference.boundariesMs, finalized.map((turn) => turn.caption.endMs)),
    } } : {}),
  };
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1]!) : null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
}

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\p{P}/gu, " ").replace(/\s+/gu, " ").trim();
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
function words(text: string): string[] {
  return [...wordSegmenter.segment(normalize(text))].filter((part) => part.isWordLike).map((part) => part.segment);
}

function errorRate(reference: string[], actual: string[]): number | null {
  if (!reference.length) return actual.length ? null : 0;
  // ponytail: quadratic time, linear memory; these are short evaluation clips.
  // Skip oversized output rather than let a runaway provider stall a benchmark.
  if (actual.length > 10_000) return null;
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= actual.length; column += 1) {
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1,
        previous[column - 1]! + (reference[row - 1] === actual[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[actual.length]! / reference.length;
}

/** One-to-one matching, so duplicate boundaries count as false positives. */
function scoreBoundaries(reference: number[], actual: number[]) {
  const toleranceMs = 300;
  const sorted = [...actual].sort((a, b) => a - b);
  let expected = 0;
  let observed = 0;
  let matched = 0;
  while (expected < reference.length && observed < sorted.length) {
    const difference = sorted[observed]! - reference[expected]!;
    if (Math.abs(difference) <= toleranceMs) { matched += 1; expected += 1; observed += 1; }
    else if (difference < 0) observed += 1;
    else expected += 1;
  }
  const precision = actual.length ? matched / actual.length : reference.length ? 0 : 1;
  const recall = reference.length ? matched / reference.length : actual.length ? 0 : 1;
  return { toleranceMs, matched, missed: reference.length - matched, extra: actual.length - matched,
    precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}
