import { describe, expect, test } from 'vitest';
import { getAllGuides, getGuide, parseGuide } from '@/lib/docs/content';

describe('docs content', () => {
  test('parses a valid guide and its headings', () => {
    const g = parseGuide('x.md', '---\ntitle: Run payroll\ndescription: Pay your team.\norder: 2\nask: How do I run payroll?\n---\n## Before you start\ntext\n## Steps\n### Steps\n```\n## not a heading\n```\n', 'lekiu', 'run-payroll');
    expect(g.title).toBe('Run payroll');
    expect(g.url).toBe('/docs/lekiu/run-payroll');
    expect(g.headings.map((h) => h.id)).toEqual(['before-you-start', 'steps', 'steps-2']);
  });

  test('rejects a missing title, a bad order, an unknown key and an over-long ask, naming the file', () => {
    for (const head of ['description: d\norder: 1\nask: a', 'title: t\ndescription: d\norder: one\nask: a', 'title: t\ndescription: d\norder: 1\nask: a\ncolour: red', `title: t\ndescription: d\norder: 1\nask: ${'a'.repeat(301)}`]) {
      expect(() => parseGuide('bad.md', `---\n${head}\n---\nbody`, 'tuah', 'x')).toThrow(/^bad\.md: /);
    }
  });

  test('every real guide file loads, sits in a known section and has a unique url', () => {
    const guides = getAllGuides();
    expect(guides.length).toBeGreaterThanOrEqual(2);
    expect(new Set(guides.map((g) => g.url)).size).toBe(guides.length);
    expect(getGuide('getting-started', 'openrouter-key')?.ask).toBe('How do I add my OpenRouter key?');
  });

  test('no guide names a slug "ask" and no copy uses purple or violet', () => {
    for (const g of getAllGuides()) {
      expect(g.slug).not.toBe('ask');
      expect(g.body).not.toMatch(/purple|violet/i);
    }
  });
});
