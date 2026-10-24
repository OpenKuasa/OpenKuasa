export type DocsIndexEntry = {
  title: string;
  description: string;
  section: string;
  url: string;
  headings: string[];
};

const MAX_QUERY = 200;
const STOP_WORDS = new Set([
  "how",
  "do",
  "i",
  "the",
  "a",
  "to",
  "my",
  "is",
  "in",
  "of",
  "for",
  "can",
  "what",
  "and",
  "on",
  "it",
  "an",
  "be",
  "we",
  "you",
  "your",
  "me",
  "with",
]);

/** Lowercased words of 2+ characters, without stop words. */
export function queryWords(query: string): string[] {
  const words = query
    .slice(0, MAX_QUERY)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/** True when a word in the text starts with `word` (so "pay" finds "payslip", "app" misses "happy"). */
export function hasWordStart(text: string, word: string): boolean {
  return text.split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(word));
}

/** Weight per word: title 5, heading 3, description 2, body 1 (body only when given). */
export function scoreFields(
  fields: {
    title: string;
    headings: string[];
    description: string;
    body?: string;
  },
  words: string[],
): number {
  const title = fields.title.toLowerCase();
  const headings = fields.headings.map((h) => h.toLowerCase());
  const description = fields.description.toLowerCase();
  const body = fields.body?.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (hasWordStart(title, word)) score += 5;
    if (headings.some((h) => hasWordStart(h, word))) score += 3;
    if (hasWordStart(description, word)) score += 2;
    if (body !== undefined && hasWordStart(body, word)) score += 1;
  }
  return score;
}

/** 0 means no match. */
export function scoreEntry(entry: DocsIndexEntry, query: string): number {
  return scoreFields(entry, queryWords(query));
}

/** Best matches first; ties keep the index (guide) order. */
export function searchIndex(
  index: DocsIndexEntry[],
  query: string,
  limit = 8,
): DocsIndexEntry[] {
  return index
    .map((entry, i) => ({ entry, i, score: scoreEntry(entry, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.entry);
}
