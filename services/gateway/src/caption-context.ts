import { LANGUAGE_LABELS, type SupportedLanguage } from "@doot/protocol";
import { GEMINI_TEXT_TRANSLATE_MODEL } from "./translation/gemini/provider.js";
import { isRecord } from "./util.js";

export const CONTEXT_HINT_MAX_CHARS = 80;
const CONTEXT_HINT_REJECT_CHARS = 200;
const MAX_RECENT_LINES = 12;
const MAX_NAMES = 48;
const MAX_NAME_CHARS = 48;
const MIN_NAME_CHARS = 2;
const MIN_FINALS_FOR_INFER = 2;
const MIN_CHARS_FOR_INFER = 24;
const INFER_EVERY_FINALS = 6;
const INFER_EVERY_MS = 8_000;
const INFER_TIMEOUT_MS = 1_500;

const GEMINI_CONTEXT_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_TRANSLATE_MODEL}:generateContent`;

export interface CanonicalName {
  heard: string;
  canonical: string;
}

export interface InferCaptionContextInput {
  hint: string;
  title: string | null;
  lines: readonly string[];
  knownNames: readonly CanonicalName[];
  targetLanguage: SupportedLanguage;
}

export interface CaptionContextInference {
  title?: string | null;
  names?: CanonicalName[];
}

export type InferCaptionContext = (
  input: InferCaptionContextInput,
) => Promise<CaptionContextInference | null>;

export function normalizeContextHint(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, CONTEXT_HINT_MAX_CHARS);
}

/** Reject oversized or non-string hints; empty after trim is omitted. */
export function readOptionalContextHint(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > CONTEXT_HINT_REJECT_CHARS) return false;
  const hint = normalizeContextHint(value);
  return hint || undefined;
}

export function applyCanonicalNames(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  if (!text || names.size === 0) return text;
  const entries = [...names.entries()]
    .filter(([heard, canonical]) => heard && canonical && heard !== canonical.toLocaleLowerCase())
    .sort((left, right) => right[0].length - left[0].length);
  let result = text;
  for (const [heard, canonical] of entries) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_'\\-])${escapeRegExp(heard)}(?![\\p{L}\\p{N}_'\\-])`,
      "giu",
    );
    result = result.replace(pattern, canonical);
  }
  return result;
}

export function parseCaptionContextResponse(
  value: unknown,
  recentLines: readonly string[],
): { title: string | null; names: CanonicalName[] } {
  const record = asJsonObject(value);
  const title = typeof record?.title === "string"
    ? normalizeContextHint(record.title) || null
    : null;
  const haystack = recentLines.join("\n").toLocaleLowerCase();
  const names: CanonicalName[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record?.names)) {
    for (const entry of record.names) {
      if (!isRecord(entry)) continue;
      const pair = sanitizeNamePair(entry.heard, entry.canonical);
      if (!pair) continue;
      if (!haystack.includes(pair.heard.toLocaleLowerCase())) continue;
      const key = pair.heard.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(pair);
      if (names.length >= MAX_NAMES) break;
    }
  }
  return { title, names };
}

export class SessionCaptionContext {
  readonly hint: string;
  private title: string | null;
  private readonly names = new Map<string, string>();
  private readonly recent: string[] = [];
  private finalsSinceInfer = 0;
  private lastInferAt = 0;
  private inFlight = false;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    hint: string,
    private readonly infer: InferCaptionContext | null,
    private readonly targetLanguage: SupportedLanguage,
  ) {
    this.hint = hint;
    this.title = hint || null;
  }

  apply(text: string): string {
    return applyCanonicalNames(text, this.names);
  }

  translationFields(): { contextHint?: string; canonicalNames?: CanonicalName[] } {
    const canonicalNames = [...this.names.entries()].map(([heard, canonical]) => ({
      heard,
      canonical,
    }));
    return {
      ...(this.hint ? { contextHint: this.hint } : {}),
      ...(canonicalNames.length ? { canonicalNames } : {}),
    };
  }

  noteFinal(text: string): void {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line || this.closed) return;
    this.recent.push(line);
    if (this.recent.length > MAX_RECENT_LINES) this.recent.shift();
    this.finalsSinceInfer += 1;
    this.maybeInfer();
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: wait for the in-flight inference to settle. */
  async flush(): Promise<void> {
    await this.pending;
  }

  private maybeInfer(): void {
    if (!this.infer || this.closed || this.inFlight) return;
    const joinedLen = this.recent.reduce((total, line) => total + line.length, 0);
    if (this.recent.length < MIN_FINALS_FOR_INFER && joinedLen < MIN_CHARS_FOR_INFER) return;
    const now = Date.now();
    if (
      this.lastInferAt !== 0
      && this.finalsSinceInfer < INFER_EVERY_FINALS
      && now - this.lastInferAt < INFER_EVERY_MS
    ) {
      return;
    }
    this.inFlight = true;
    this.lastInferAt = now;
    this.finalsSinceInfer = 0;
    const input: InferCaptionContextInput = {
      hint: this.hint,
      title: this.title,
      lines: [...this.recent],
      knownNames: [...this.names.entries()].map(([heard, canonical]) => ({ heard, canonical })),
      targetLanguage: this.targetLanguage,
    };
    this.pending = this.infer(input)
      .then((result) => {
        if (this.closed || !result) return;
        this.merge(result, input.lines);
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
      });
  }

  private merge(result: CaptionContextInference, lines: readonly string[]): void {
    const parsed = parseCaptionContextResponse(result, lines);
    if (parsed.title) this.title = parsed.title;
    const canonicalValues = new Set(
      [...this.names.values()].map((value) => value.toLocaleLowerCase()),
    );
    for (const pair of parsed.names) {
      const key = pair.heard.toLocaleLowerCase();
      if (canonicalValues.has(key)) continue;
      if (this.names.size >= MAX_NAMES && !this.names.has(key)) {
        const oldest = this.names.keys().next().value;
        if (oldest) this.names.delete(oldest);
      }
      this.names.set(key, pair.canonical);
      canonicalValues.add(pair.canonical.toLocaleLowerCase());
    }
  }
}

export function createGeminiCaptionContextInferrer(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): InferCaptionContext {
  return async (input) => {
    const response = await fetcher(`${GEMINI_CONTEXT_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "You identify the show, film, sport, or program in live captions and correct proper-name spellings. Reply with JSON only.",
          }],
        },
        contents: [{ parts: [{ text: contextPrompt(input) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return null;
    const text = readGeminiText(body);
    if (!text) return null;
    const parsed = parseJsonPayload(text);
    if (!parsed) return null;
    return parseCaptionContextResponse(parsed, input.lines);
  };
}

function contextPrompt(input: InferCaptionContextInput): string {
  const targetLabel = LANGUAGE_LABELS[input.targetLanguage] ?? input.targetLanguage;
  const names = input.knownNames
    .slice(0, 24)
    .map((pair) => `${pair.heard} → ${pair.canonical}`)
    .join("; ");
  const lines = input.lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return [
    `Return JSON {"title": string|null, "names": [{"heard": string, "canonical": string}]}.`,
    `Captions are in ${targetLabel}. Use official ${targetLabel} spellings (Yhwach not Yohaba; Kylian Mbappé not Mbappe).`,
    "Only include names that appear in the captions. Skip if unsure. Do not invent names.",
    "heard is the spelling as it appears; canonical is the official form.",
    `User hint: ${input.hint || "(none)"}`,
    `Already identified title: ${input.title || "(unknown)"}`,
    `Already known names: ${names || "(none)"}`,
    "Recent captions:",
    lines,
  ].join("\n");
}

function sanitizeNamePair(heard: unknown, canonical: unknown): CanonicalName | null {
  if (typeof heard !== "string" || typeof canonical !== "string") return null;
  const heardName = heard.replace(/\s+/g, " ").trim();
  const canonicalName = canonical.replace(/\s+/g, " ").trim();
  if (
    heardName.length < MIN_NAME_CHARS
    || canonicalName.length < MIN_NAME_CHARS
    || heardName.length > MAX_NAME_CHARS
    || canonicalName.length > MAX_NAME_CHARS
  ) {
    return null;
  }
  if (heardName.toLocaleLowerCase() === canonicalName.toLocaleLowerCase()) return null;
  return { heard: heardName, canonical: canonicalName };
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const parsed = parseJsonPayload(value);
    return isRecord(parsed) ? parsed : null;
  }
  return isRecord(value) ? value : null;
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readGeminiText(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.candidates)) return undefined;
  const first = body.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) {
    return undefined;
  }
  const texts = first.content.parts.flatMap((part) => {
    if (!isRecord(part) || typeof part.text !== "string") return [];
    const value = part.text.trim();
    return value ? [value] : [];
  });
  return texts.join(" ").trim() || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
