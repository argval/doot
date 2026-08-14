export function mergeStreamingText(existing: string, incoming: string): string {
  const normalized = incoming.replace(/\s+/g, " ").trim();
  if (!existing) return collapseStutter(normalized);
  if (!normalized) return existing;
  if (normalized === existing || existing.startsWith(normalized)) {
    return collapseStutter(existing);
  }
  if (normalized.startsWith(existing)) return collapseStutter(normalized);

  if (containsPhrase(existing, normalized)) return collapseStutter(existing);
  if (containsPhrase(normalized, existing)) return collapseStutter(normalized);

  const existingWords = existing.split(/\s+/);
  const incomingWords = normalized.split(/\s+/);
  if (hasWordPrefix(incomingWords, existingWords)) return collapseStutter(normalized);
  if (hasWordPrefix(existingWords, incomingWords)) return collapseStutter(existing);

  for (let size = Math.min(incomingWords.length, existingWords.length); size >= 1; size -= 1) {
    if (sameWords(existingWords.slice(-size), incomingWords.slice(0, size))) {
      if (size === incomingWords.length) return collapseStutter(existing);
      return collapseStutter([...existingWords, ...incomingWords.slice(size)].join(" "));
    }
  }

  return collapseStutter(`${existing} ${normalized}`);
}

function containsPhrase(haystack: string, needle: string): boolean {
  const hayWords = haystack.split(/\s+/);
  const needleWords = needle.split(/\s+/);
  if (needleWords.length === 0 || needleWords.length > hayWords.length) return false;
  for (let start = 0; start <= hayWords.length - needleWords.length; start += 1) {
    if (sameWords(hayWords.slice(start, start + needleWords.length), needleWords)) {
      return true;
    }
  }
  return false;
}

function collapseStutter(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return words.join(" ");
  let end = words.length;
  for (let n = Math.min(8, Math.floor(end / 2)); n >= 2; n -= 1) {
    while (
      end >= 2 * n
      && sameWords(words.slice(end - n, end), words.slice(end - 2 * n, end - n))
    ) {
      end -= n;
    }
  }
  return words.slice(0, end).join(" ");
}

function hasWordPrefix(words: string[], prefix: string[]): boolean {
  return prefix.length <= words.length && sameWords(words.slice(0, prefix.length), prefix);
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
