const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function mergeStreamingText(
  existing: string,
  incoming: string,
  options: { collapseRepeats?: boolean } = {},
): string {
  const collapse = (text: string) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    // First native snapshot should keep emphatic repeats; later merges still
    // collapse Gemini's overlapping re-emits of the same caption.
    if (options.collapseRepeats === false && !existing) return normalized;
    return collapseStutter(normalized);
  };
  const normalized = incoming.replace(/\s+/g, " ").trim();
  if (!existing) return collapse(normalized);
  if (!normalized) return existing;
  if (normalized === existing || existing.startsWith(normalized)) {
    return collapse(existing);
  }
  if (normalized.startsWith(existing)) return collapse(normalized);

  if (containsPhrase(existing, normalized)) return collapse(existing);
  if (containsPhrase(normalized, existing)) return collapse(normalized);

  const existingWords = tokenize(existing);
  const incomingWords = tokenize(normalized);
  if (hasWordPrefix(incomingWords, existingWords)) return collapse(normalized);
  if (hasWordPrefix(existingWords, incomingWords)) return collapse(existing);

  // Providers sometimes replace a cumulative snapshot after correcting a word.
  // A substantial shared prefix identifies that as a revision, not new speech.
  if (hasSubstantialSharedPrefix(existingWords, incomingWords)) {
    return collapse(normalized);
  }

  for (let size = Math.min(incomingWords.length, existingWords.length); size >= 1; size -= 1) {
    if (sameWords(existingWords.slice(-size), incomingWords.slice(0, size))) {
      if (size === incomingWords.length) return collapse(existing);
      return collapse(joinTokens(existing, [...existingWords, ...incomingWords.slice(size)]));
    }
  }

  return collapse(`${existing} ${normalized}`);
}

/** Collapse trailing/internal repeats before translation so MT does not echo stutters. */
export function collapseStutter(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const words = collapseRepeatedTokens(tokenize(normalized));
  if (words.length < 2) return joinTokens(normalized, words);
  const spaced = /\s/.test(normalized);
  let end = words.length;
  for (let n = Math.min(8, Math.floor(end / 2)); n >= (spaced ? 2 : 1); n -= 1) {
    while (
      end >= 2 * n
      && sameWords(words.slice(end - n, end), words.slice(end - 2 * n, end - n))
    ) {
      end -= n;
    }
  }
  return joinTokens(normalized, words.slice(0, end));
}

function tokenize(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (/\s/.test(normalized)) return normalized.split(" ").filter(Boolean);
  const tokens: string[] = [];
  for (const { segment } of wordSegmenter.segment(normalized)) {
    if (segment) tokens.push(segment);
  }
  return tokens.length > 0 ? tokens : [normalized];
}

function joinTokens(sample: string, tokens: string[]): string {
  if (tokens.length === 0) return "";
  return /\s/.test(sample.trim()) ? tokens.join(" ") : tokens.join("");
}

function collapseRepeatedTokens(words: string[]): string[] {
  const collapsed: string[] = [];
  for (const word of words) {
    const last = collapsed.at(-1);
    const previous = collapsed.at(-2);
    if (
      last
      && previous
      && wordsEquivalent(last, word)
      && wordsEquivalent(previous, word)
    ) {
      continue;
    }
    collapsed.push(word);
  }
  return collapsed;
}

function containsPhrase(haystack: string, needle: string): boolean {
  const hayWords = tokenize(haystack);
  const needleWords = tokenize(needle);
  if (needleWords.length === 0 || needleWords.length > hayWords.length) return false;
  for (let start = 0; start <= hayWords.length - needleWords.length; start += 1) {
    if (sameWords(hayWords.slice(start, start + needleWords.length), needleWords)) {
      return true;
    }
  }
  return false;
}

function hasWordPrefix(words: string[], prefix: string[]): boolean {
  return prefix.length <= words.length && sameWords(words.slice(0, prefix.length), prefix);
}

function hasSubstantialSharedPrefix(left: string[], right: string[]): boolean {
  const limit = Math.min(left.length, right.length);
  let size = 0;
  while (size < limit && wordsEquivalent(left[size] ?? "", right[size] ?? "")) size += 1;
  return size > 0 && size * 2 >= limit;
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
