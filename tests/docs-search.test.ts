import { describe, expect, test } from 'vitest';
import { buildDocsIndex, searchDocsPassages } from '@/lib/docs/search';
import { scoreEntry, searchIndex } from '@/lib/docs/search-core';

describe('docs search', () => {
  test('finds the key guide from a natural question', () => {
    expect(searchDocsPassages('how do I add my openrouter key')[0].url).toMatch(
      /^\/docs\/getting-started\/openrouter-key/,
    );
  });
  test('empty, stop-word-only and very long queries do not throw', () => {
    expect(searchDocsPassages('')).toEqual([]);
    expect(searchDocsPassages('how do i')).toEqual([]);
    expect(() => searchDocsPassages('x'.repeat(500))).not.toThrow();
  });
  test('every result points inside /docs and passage text is capped', () => {
    for (const p of searchDocsPassages('app key install', 10)) {
      expect(p.url.startsWith('/docs/')).toBe(true);
      expect(p.text.length).toBeLessThanOrEqual(1200);
    }
  });
  test('the browser index carries no body text', () => {
    expect(JSON.stringify(buildDocsIndex())).not.toContain('openrouter.ai/keys'); // a phrase only in a guide body
  });
  test('index search ranks title above description and respects the limit', () => {
    const index = [
      { title: 'Other', description: 'about payroll', section: 's', url: '/docs/s/a', headings: [] },
      { title: 'Payroll', description: 'x', section: 's', url: '/docs/s/b', headings: [] },
    ];
    expect(scoreEntry(index[1], 'payroll')).toBe(5);
    expect(searchIndex(index, 'payroll').map((e) => e.url)).toEqual(['/docs/s/b', '/docs/s/a']);
    expect(searchIndex(index, 'payroll', 1)).toHaveLength(1);
    expect(searchIndex(index, 'how do i')).toEqual([]);
  });
});
