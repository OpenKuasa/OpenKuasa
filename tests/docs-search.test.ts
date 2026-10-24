import { describe, expect, test } from 'vitest';
import { getAllGuides } from '@/lib/docs/content';
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
  test('common question words do not drive ranking', () => {
    const index = [
      { title: 'Things in the app', description: 'what is it', section: 's', url: '/docs/s/a', headings: [] },
      { title: 'Payroll', description: 'x', section: 's', url: '/docs/s/b', headings: [] },
    ];
    expect(scoreEntry(index[0], 'what is my')).toBe(0);
    expect(searchIndex(index, 'what is my payroll can you')[0].url).toBe('/docs/s/b');
    expect(searchDocsPassages('what is in of for can and on it')).toEqual([]);
  });
  test('matching is on word starts, not inside words', () => {
    const happy = { title: 'Happy', description: 'x', section: 's', url: '/docs/s/h', headings: [] };
    const pay = { title: 'Payslips', description: 'x', section: 's', url: '/docs/s/p', headings: [] };
    expect(scoreEntry(happy, 'app')).toBe(0);
    expect(scoreEntry(pay, 'pay')).toBe(5);
  });
  test('every passage anchor is a real heading id of its guide', () => {
    const guides = getAllGuides();
    for (const p of searchDocsPassages('the and key app install add', 50)) {
      const [path, id] = p.url.split('#');
      if (!id) continue;
      const guide = guides.find((g) => g.url === path);
      expect(guide?.headings.map((h) => h.id)).toContain(id);
    }
  });
});
