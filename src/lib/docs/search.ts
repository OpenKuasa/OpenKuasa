import 'server-only';
import { getAllGuides, type Guide } from './content';
import { queryWords, scoreFields, type DocsIndexEntry } from './search-core';

/** Compact index for the browser: titles, descriptions and headings, no body text. */
export function buildDocsIndex(): DocsIndexEntry[] {
  return getAllGuides().map((g) => ({
    title: g.title,
    description: g.description,
    section: g.section,
    url: g.url,
    headings: g.headings.map((h) => h.text),
  }));
}

export type DocsPassage = { title: string; url: string; heading: string | null; text: string };

const MAX_TEXT = 1200;

type Section = { heading: string | null; id: string | null; text: string };

/** Split a guide body at its ## headings, taken from guide.headings (the parsed Markdown). */
function splitSections(guide: Guide): Section[] {
  const h2s = guide.headings.filter((h) => h.depth === 2);
  const sections: Section[] = [{ heading: null, id: null, text: guide.body.slice(0, h2s[0]?.start ?? guide.body.length) }];
  h2s.forEach((h, i) => {
    sections.push({ heading: h.text, id: h.id, text: guide.body.slice(h.end, h2s[i + 1]?.start ?? guide.body.length) });
  });
  return sections.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text || s.heading);
}

/** Best-matching guide sections for a question. Title 5, heading 3, description 2, body 1 per word. */
export function searchDocsPassages(query: string, limit = 4): DocsPassage[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits: { passage: DocsPassage; score: number; order: number }[] = [];
  let order = 0;
  for (const guide of getAllGuides()) {
    for (const section of splitSections(guide)) {
      const score = scoreFields(
        {
          title: guide.title,
          headings: section.heading ? [section.heading] : [],
          description: guide.description,
          body: section.text,
        },
        words,
      );
      order += 1;
      if (score === 0) continue;
      hits.push({
        score,
        order,
        passage: {
          title: guide.title,
          url: section.id ? `${guide.url}#${section.id}` : guide.url,
          heading: section.heading,
          text: section.text.slice(0, MAX_TEXT),
        },
      });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((h) => h.passage);
}
