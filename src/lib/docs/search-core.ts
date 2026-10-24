export type DocsIndexEntry = {
  title: string;
  description: string;
  section: string;
  url: string;
  headings: string[];
};

const MAX_QUERY = 200;
const STOP_WORDS = new Set(['how', 'do', 'i', 'the', 'a', 'to', 'my']);

/** Lowercased words of 2+ characters, without stop words. */
export function queryWords(query: string): string[] {
  const words = query
    .slice(0, MAX_QUERY)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/** 0 means no match. Title 5, heading 3, description 2 per word. */
export function scoreEntry(entry: DocsIndexEntry, query: string): number {
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  const headings = entry.headings.map((h) => h.toLowerCase());
  let score = 0;
  for (const word of queryWords(query)) {
    if (title.includes(word)) score += 5;
    if (headings.some((h) => h.includes(word))) score += 3;
    if (description.includes(word)) score += 2;
  }
  return score;
}

/** Best matches first; ties keep the index (guide) order. */
export function searchIndex(index: DocsIndexEntry[], query: string, limit = 8): DocsIndexEntry[] {
  return index
    .map((entry, i) => ({ entry, i, score: scoreEntry(entry, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.entry);
}
