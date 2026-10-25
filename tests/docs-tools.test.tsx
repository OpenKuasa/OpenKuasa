import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { z } from 'zod';
import { createDocsTools, DOCS_HINT, DOCS_TOOL_NAMES } from '@/lib/ai/docs-tools';
import {
  BENDAHARA_SYSTEM,
  JEBAT_SYSTEM,
  KASTURI_SYSTEM,
  LEKIR_SYSTEM,
  LEKIU_SYSTEM,
  SPECIALIST_DOCS_HINT,
  TUAH_SYSTEM,
  subAgentSystem,
  tuahSystem,
  tuahTeamSystem,
} from '@/lib/ai/agents/prompts';
import { ReplyText } from '@/components/chat/reply-text';
import { liveStepStatus, toolMeta } from '@/components/chat/tool-parts';
import { SpecialistCard } from '@/components/chat/specialist-card';

type Results = { results: { title: string; url: string; heading: string | null; text: string }[] };
const search = (query: string) =>
  createDocsTools().searchDocs.execute!({ query }, { toolCallId: 't', messages: [] } as never) as Promise<Results>;

describe('searchDocs', () => {
  test('returns guide passages inside /docs', async () => {
    const out = await search('add openrouter key');
    expect(out.results[0].url).toMatch(/^\/docs\/getting-started\/openrouter-key/);
    expect(out.results.length).toBeLessThanOrEqual(4);
  });

  test('a one-letter or 200-character query does not throw, and every url is inside /docs', async () => {
    for (const query of ['a', 'x'.repeat(200), 'how do I']) {
      const out = await search(query);
      expect(out.results.length).toBeLessThanOrEqual(4);
      for (const r of out.results) expect(r.url.startsWith('/docs/')).toBe(true);
    }
  });

  test('rejects an empty or over-long query', () => {
    const schema = (createDocsTools().searchDocs as unknown as { inputSchema: z.ZodType }).inputSchema;
    expect(schema.safeParse({ query: '' }).success).toBe(false);
    expect(schema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ query: 'x'.repeat(200) }).success).toBe(true);
  });

  test('the names list matches the tools, and nothing needs approval', () => {
    const tools = createDocsTools();
    expect(Object.keys(tools)).toEqual([...DOCS_TOOL_NAMES]);
    expect((tools.searchDocs as { needsApproval?: unknown }).needsApproval).toBeUndefined();
  });
});

describe('the docs hint', () => {
  const team = [{ name: 'Jebat', area: 'marketing' }];
  const screen = { key: 'finance', product: 'Bendahara', item: 'Invoices' } as const;

  test('every assistant prompt carries it', () => {
    for (const s of [
      JEBAT_SYSTEM,
      KASTURI_SYSTEM,
      BENDAHARA_SYSTEM,
      LEKIR_SYSTEM,
      LEKIU_SYSTEM,
      TUAH_SYSTEM,
      tuahSystem(null),
      tuahSystem(screen),
      tuahTeamSystem(team, true, null),
      tuahTeamSystem(team, false, screen),
    ]) {
      expect(s).toContain(DOCS_HINT);
      expect(s).toContain('searchDocs');
    }
  });

  test('specialists put the guide path in their report for Tuah to pass on', () => {
    for (const s of [subAgentSystem('reach', true), subAgentSystem('finance', false)]) {
      expect(s).toContain(SPECIALIST_DOCS_HINT);
      expect(s).toContain('include its /docs/ path in your report for Tuah to pass on');
      expect(s).toContain('searchDocs');
      expect(s).not.toContain(DOCS_HINT);
    }
  });

  test('sits before the per-screen part, so it is in the cached text', () => {
    const withScreen = tuahTeamSystem(team, true, screen);
    expect(withScreen.indexOf(DOCS_HINT)).toBeLessThan(withScreen.indexOf('CONTEXT'));
    expect(tuahTeamSystem(team, true, null)).toBe(withScreen.slice(0, withScreen.indexOf('\n\nCONTEXT')));
    expect(tuahSystem(screen).startsWith(TUAH_SYSTEM)).toBe(true);
  });
});

describe('reply text links /docs paths and nothing else', () => {
  const html = (text: string) => renderToStaticMarkup(<ReplyText text={text} />);

  test('a /docs path is a link; a full URL stays text', () => {
    const out = html('See /docs/getting-started/openrouter-key and https://evil.com');
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain('href="/docs/getting-started/openrouter-key">/docs/getting-started/openrouter-key</a>');
    expect(out).not.toContain('href="https://evil.com"');
    expect(out).toContain('https://evil.com');
  });

  test('keeps an #id, stops at trailing punctuation', () => {
    const out = html('Steps: /docs/getting-started/openrouter-key#add-the-key.');
    expect(out).toContain('href="/docs/getting-started/openrouter-key#add-the-key"');
    expect(out).toContain('</a>.');
  });

  test('no link while the reply is still arriving, and no prefetch once it is', () => {
    const text = 'See /docs/getting-started/openrouter-key';
    expect(renderToStaticMarkup(<ReplyText text={text} arriving />)).not.toContain('<a');
    expect(renderToStaticMarkup(<ReplyText text={`**Key**\n${text}`} arriving />)).not.toContain('<a');
    expect(html(text)).toContain('href="/docs/getting-started/openrouter-key"');
  });

  test('links inside a marked reply too', () => {
    const out = html('**Done.**\n\n- Read /docs/products/tuah first');
    expect(out).toContain('<strong');
    expect(out).toContain('href="/docs/products/tuah"');
  });

  test('not a link: a path glued to a word, other paths, a deeper path, uppercase', () => {
    for (const text of [
      'x/docs/getting-started/openrouter-key',
      'go to /account/ai',
      'https://openkuasa.com/docs/getting-started/openrouter-key',
      '/docs/a/b/c',
      '/docs/Getting/Started',
      '/docs//evil.com',
      '/docs/a',
    ]) {
      expect(html(text), text).not.toContain('<a');
    }
  });
});

describe('a guide search shows as a lookup, not a change', () => {
  test('it has its own entry', () => {
    const meta = toolMeta('searchDocs');
    expect(meta.isFallback).toBe(false);
    expect(meta.label).toBe('Guides');
    expect(liveStepStatus('searchDocs')).toBe('Reading the guides…');
  });

  test('a specialist running one is not preparing a change', () => {
    const out = renderToStaticMarkup(
      <SpecialistCard
        agent="Kasturi"
        work={{ agent: 'Kasturi', product: 'crm', status: 'working', steps: [{ tool: 'searchDocs', done: false }], answer: '', proposals: [] }}
      />,
    );
    expect(out).toContain('Reading the guides…');
    expect(out.toLowerCase()).not.toContain('change');
  });
});
