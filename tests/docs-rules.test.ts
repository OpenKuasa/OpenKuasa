import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GuideBody } from '@/components/docs/guide-body';
import { getAllGuides, parseGuide } from '@/lib/docs/content';
import { guideImages, guideLinks, HELD_SLUGS, liveScreenPaths, loadHeldSlugs, missingHeldGuides } from '@/lib/docs/rules';

/** The file a guide lives in, for failure messages. */
const fileOf = (g: { section: string; slug: string }) => `content/docs/${g.section}/${g.slug}.md`;

describe('every guide follows the rules', () => {
  test('every guide screen is a live screen', () => {
    const live = liveScreenPaths();
    for (const g of getAllGuides()) if (g.screen) expect(live.has(g.screen), `${fileOf(g)}: screen ${g.screen}`).toBe(true);
  });

  test('every image exists under /docs-media with alt text', () => {
    for (const g of getAllGuides()) {
      for (const i of guideImages(g.body)) {
        expect(i.src.startsWith('/docs-media/'), `${fileOf(g)}: ${i.src} must be under /docs-media/`).toBe(true);
        expect(existsSync(join('public', i.src)), `${fileOf(g)}: ${i.src} is not in public/`).toBe(true);
        expect(i.alt.trim(), `${fileOf(g)}: ${i.src} needs alt text`).not.toBe('');
      }
    }
  });

  test('orders are unique within a section', () => {
    const seen = new Map<string, string>();
    for (const g of getAllGuides()) {
      const key = `${g.section}#${g.order}`;
      const other = seen.get(key);
      expect(other, `${fileOf(g)}: order ${g.order} is also used by ${other}`).toBeUndefined();
      seen.set(key, fileOf(g));
    }
  });

  test('links to other guides resolve', () => {
    const guides = new Map(getAllGuides().map((g) => [g.url, g]));
    for (const g of getAllGuides()) {
      for (const link of guideLinks(g.body)) {
        const target = guides.get(link.path);
        expect(target, `${fileOf(g)}: ${link.href} is not a guide`).toBeDefined();
        if (target && link.hash) {
          expect(target.headings.map((h) => h.id), `${fileOf(g)}: ${link.href} has no such heading`).toContain(link.hash);
        }
      }
    }
  });

  test('held guides stay out when DOCS_HOLD=1', () => {
    if (process.env.DOCS_HOLD !== '1') return;
    for (const g of getAllGuides()) {
      expect(HELD_SLUGS.has(`${g.section}/${g.slug}`), `${fileOf(g)} is a held topic`).toBe(false);
    }
  });

  test('every held entry names a guide when the held guides are here', () => {
    if (process.env.DOCS_HOLD === '1') return;
    const missing = missingHeldGuides(HELD_SLUGS, getAllGuides().map((g) => `${g.section}/${g.slug}`));
    expect(missing, `content/docs/held lists guides that do not exist: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the rule helpers', () => {
  test('live screens: nav items that are live, Tuah, and the account pages', () => {
    const live = liveScreenPaths();
    expect(live.has('/command')).toBe(true);
    expect(live.has('/account/ai')).toBe(true);
    expect(live.has('/people/payroll')).toBe(true);
    expect(live.has('/finance/invoices')).toBe(true);
    expect(live.has('/finance/nope')).toBe(false);
    expect(live.has('/')).toBe(false);
    // 'reach/reports' is live but not a nav item; it is served at /crm/reports.
    expect(live.has('/reach/reports')).toBe(false);
    expect(live.has('/crm/reports')).toBe(true);
  });

  test('images, including reference-style ones, with their alt text', () => {
    const body = '![A chart](/docs-media/a/b.png)\n\n![][pic]\n\n`![not](/code.png)`\n\n[pic]: /docs-media/c.png\n';
    expect(guideImages(body)).toEqual([
      { alt: 'A chart', src: '/docs-media/a/b.png' },
      { alt: '', src: '/docs-media/c.png' },
    ]);
  });

  test('guide links: only /docs/<section>/<slug>, with any #heading split off', () => {
    const body = 'See [one](/docs/lekiu/leave#steps), [two][ref], [home](/docs), [ask](/docs/ask?q=x) and [web](https://x.com/docs/a/b).\n\n[ref]: /docs/getting-started/get-the-app\n';
    expect(guideLinks(body)).toEqual([
      { href: '/docs/lekiu/leave#steps', path: '/docs/lekiu/leave', hash: 'steps' },
      { href: '/docs/getting-started/get-the-app', path: '/docs/getting-started/get-the-app', hash: null },
    ]);
  });
});

describe('held topics', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const held = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), 'held-'));
    mkdirSync(join(dir, 'held'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'held', name), text);
    return join(dir, 'held');
  };

  test('a missing folder holds nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'held-'));
    expect(loadHeldSlugs(join(dir, 'held')).size).toBe(0);
  });

  test('each section file adds its slugs', () => {
    const slugs = loadHeldSlugs(held({ 'lekiu.json': '["payroll","payment-vouchers"]', 'bendahara.json': '["invoices"]' }));
    expect([...slugs].sort()).toEqual(['bendahara/invoices', 'lekiu/payment-vouchers', 'lekiu/payroll']);
  });

  test.each([
    ['nope.json', '["a"]', 'nope.json'],
    ['lekiu.json', '{"a":1}', 'lekiu.json'],
    ['lekiu.json', '["ok", 2]', 'lekiu.json'],
    ['lekiu.json', '["Not A Slug"]', 'lekiu.json'],
    ['lekiu.json', 'not json', 'lekiu.json'],
    ['lekiu.txt', '[]', 'lekiu.txt'],
  ])('%s with %s fails naming the file', (name, text, named) => {
    expect(() => loadHeldSlugs(held({ [name]: text }))).toThrow(named);
  });

  test('missing held guides: none on a branch without the held guides, else every typo', () => {
    const held = new Set(['lekiu/payroll', 'lekiu/my-payslips']);
    expect(missingHeldGuides(held, ['lekiu/leave'])).toEqual([]);
    expect(missingHeldGuides(held, ['lekiu/leave', 'lekiu/payroll', 'lekiu/my-payslips'])).toEqual([]);
    expect(missingHeldGuides(new Set(['lekiu/payroll', 'lekiu/my-payslip']), ['lekiu/payroll', 'lekiu/my-payslips'])).toEqual([
      'lekiu/my-payslip',
    ]);
  });

  test('the held folder is not read as a docs section', async () => {
    // The loader throws on an unknown folder; content/docs/held must not count as one.
    const real = 'content/docs/held';
    const made = !existsSync(real);
    if (made) mkdirSync(real);
    dir = mkdtempSync(join(tmpdir(), 'held-'));
    try {
      vi.resetModules();
      const fresh = await import('@/lib/docs/content');
      expect(() => fresh.getAllGuides()).not.toThrow();
    } finally {
      if (made) rmSync(real, { recursive: true });
    }
  });
});

test('headings come from the parsed markdown: list, html comment, escaped # and "## #" do not shift ids', () => {
  const raw = [
    '---',
    'title: T',
    'description: D',
    'order: 1',
    'ask: Q?',
    '---',
    'Intro',
    '',
    '- ## In a list',
    '- item',
    '',
    '<!--',
    '## Inside a comment',
    '-->',
    '',
    '\\## Escaped',
    '',
    '## #',
    '',
    '## Steps',
    '',
    '1. One',
    '2. Two',
    '',
    '### Steps',
    '',
    'Set up',
    '------',
    '',
    '## Real `code` **bold**',
    '',
  ].join('\n');
  const guide = parseGuide('t/x.md', raw, 'getting-started', 'x');
  const html = renderToStaticMarkup(createElement(GuideBody, { guide }));
  const rendered = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);
  expect(guide.headings.map((h) => h.id)).toEqual(['steps', 'steps-2', 'set-up', 'real-code-bold']);
  expect(guide.headings.map((h) => h.text)).toEqual(['Steps', 'Steps', 'Set up', 'Real code bold']);
  expect(rendered).toEqual(guide.headings.map((h) => h.id));
});
