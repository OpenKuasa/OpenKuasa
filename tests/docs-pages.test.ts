import { expect, test } from 'vitest';
import { getAllGuides } from '@/lib/docs/content';

test('every guide has a static page param and the sitemap lists it', async () => {
  const { generateStaticParams } = await import('@/app/docs/[section]/[slug]/page');
  const params = await generateStaticParams();
  const urls = (await import('@/app/sitemap')).default().map((e) => e.url);
  for (const g of getAllGuides()) {
    expect(params).toContainEqual({ section: g.section, slug: g.slug });
    expect(urls).toContain(`https://openkuasa.com${g.url}`);
  }
  expect(urls).toContain('https://openkuasa.com/docs');
});

test('llms.txt links the docs', async () => {
  const body = await (await import('@/app/llms.txt/route')).GET().text();
  expect(body).toContain('https://openkuasa.com/docs');
});

test('guide headings render with the ids search links to', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { GuideBody } = await import('@/components/docs/guide-body');
  for (const g of getAllGuides()) {
    const html = renderToStaticMarkup(createElement(GuideBody, { guide: g }));
    const ids = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(g.headings.map((h) => h.id));
  }
  const html = renderToStaticMarkup(
    createElement(GuideBody, {
      guide: {
        body: 'Intro\n\n## Same\n\n```\n## not a heading\n```\n\n### Same\n\n<b>raw</b> [out](https://example.com)\n\n![A chart](/x.png)',
      },
    }),
  );
  expect([...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1])).toEqual(['same', 'same-2']);
  expect(html).not.toContain('<b>');
  expect(html).toContain('target="_blank" rel="noreferrer"');
  expect(html).toContain('loading="lazy"');
});

test('Ask Sari links to the docs ask route with the question', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AskSariBox } = await import('@/components/docs/ask-sari-box');
  const html = renderToStaticMarkup(createElement(AskSariBox, { question: 'How do I add my key?' }));
  expect(html).toContain('href="/docs/ask?q=How%20do%20I%20add%20my%20key%3F"');
  expect(html).toContain('Still stuck? Ask Sari');
});

test('every section with guides has a page param; empty sections do not', async () => {
  const { DOC_SECTIONS } = await import('@/lib/docs/sections');
  const { generateStaticParams, dynamicParams } = await import('@/app/docs/[section]/page');
  const params = await generateStaticParams();
  const withGuides = new Set(getAllGuides().map((g) => g.section));
  expect(dynamicParams).toBe(false);
  for (const s of DOC_SECTIONS) {
    if (withGuides.has(s.key)) expect(params).toContainEqual({ section: s.key });
    else expect(params).not.toContainEqual({ section: s.key });
  }
  expect(params).not.toContainEqual({ section: 'nope' });
});

test('the loader and GuideBody agree on what counts as a heading', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { parseGuide } = await import('@/lib/docs/content');
  const { GuideBody } = await import('@/components/docs/guide-body');
  const raw = [
    '---',
    'title: T',
    'description: D',
    'order: 1',
    'ask: Q?',
    '---',
    ' ## Indented one',
    '',
    '##   ',
    '',
    '- item',
    '',
    '  ## In a list',
    '',
    '## Real `code` **bold**',
    '',
    '### Sub',
    '',
  ].join('\n');
  const guide = parseGuide('t/x.md', raw, 'getting-started', 'x');
  const html = renderToStaticMarkup(createElement(GuideBody, { guide }));
  const ids = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toEqual(guide.headings.map((h) => h.id));
  // Parsed Markdown: an indented `##` is still a heading; one inside a list or empty is not.
  expect(ids).toEqual(['indented-one', 'real-code-bold', 'sub']);
});
