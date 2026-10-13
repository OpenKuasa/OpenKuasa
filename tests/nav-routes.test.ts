import { describe, expect, it } from 'vitest';

import { navEntries, parseNavSource } from '../scripts/nav-routes.mjs';

// Mirrors the shape of src/config/nav.ts: a top-level array whose entries open
// with `  {` then `    key: '...'`, each carrying `slug: '...'` items. The parser
// is anchored to that exact indentation, so the sample must match it.
const SAMPLE = [
  'export const nav = [',
  '  {',
  "    key: 'reach',",
  '    items: [',
  "      { label: 'Overview', slug: 'assistant' },",
  "      { label: 'Leads', slug: 'leads' },",
  '    ],',
  '  },',
  '  {',
  "    key: 'crm',",
  '    items: [',
  "      { label: 'Contacts', slug: 'contacts' },",
  '    ],',
  '  },',
  '];',
  '',
].join('\n');

const EXPECTED = [
  { key: 'reach', slugs: ['assistant', 'leads'] },
  { key: 'crm', slugs: ['contacts'] },
];

describe('parseNavSource', () => {
  it('reads the key and slugs of every nav block', () => {
    expect(parseNavSource(SAMPLE)).toEqual(EXPECTED);
  });

  // The Windows failure this whole module exists to prevent: a CRLF working
  // copy must parse to exactly the same routes as an LF one. Without the
  // normalise, the LF-anchored split matches nothing and this returns [].
  it('reads the same blocks when the source uses CRLF line endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    expect(parseNavSource(crlf)).toEqual(EXPECTED);
  });
});

describe('navEntries', () => {
  // Guards the parser against the real nav.ts, not just the sample: if a
  // reformat ever breaks the anchored pattern, this drops to [] and fails.
  it('parses real routes out of src/config/nav.ts', () => {
    const entries = navEntries(process.cwd());
    const reach = entries.find((entry) => entry.key === 'reach');
    expect(reach).toBeDefined();
    expect(reach?.slugs).toContain('assistant');
  });
});
