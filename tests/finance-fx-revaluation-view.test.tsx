import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FX_MEMBER_NOTE, type FxRevaluationActions, FxRevaluationView } from '@/components/finance/fx-revaluation-view';
import { FX_REVALUATION_MESSAGES, type RevaluationItem, type RevaluationRun } from '@/lib/finance/fx-revaluation';
import { SAMPLE_FX_ITEMS, SAMPLE_FX_MONTH_END, SAMPLE_FX_RUNS } from '@/screens/finance/fx-revaluation-sample';

/**
 * The FX Revaluation screen, as the server sends it: rendered to a string and read as markup. There is no DOM here
 * (node, no jsdom), so nothing can be typed or pressed: what typing and Post decide is in plain functions
 * (tests/finance-fx-revaluation-views.test.ts). What still needs a browser is checked by hand.
 */

// A closed select draws no options. Here its options are drawn in place, and the chosen one is marked.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-chosen={value}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <span data-option={value}>{children}</span>,
  };
});

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const E = SAMPLE_FX_MONTH_END;
const DIGEST = '0123456789abcdef0123456789abcdef';
/** The sample's items as a live preview gives them: with the server's digest. */
const LIVE = SAMPLE_FX_ITEMS.map((i) => ({ ...i, digest: DIGEST }));

const preview = vi.fn(async () => ({ ok: true as const, data: [] as RevaluationItem[] }));
const post = vi.fn(async () => ({ ok: true as const, data: { id: 'r', revaluation_no: 'FX-0002' } }));
const OWNER: FxRevaluationActions = { preview, post };
const READER: FxRevaluationActions = { preview };

const render = (over: Partial<Parameters<typeof FxRevaluationView>[0]> = {}) =>
  renderToStaticMarkup(
    <FxRevaluationView monthEnds={[E, '2026-08-31']} periodEnd={E} items={LIVE} runs={SAMPLE_FX_RUNS} actions={OWNER} {...over} />,
  );

/** The Post button's opening tag, or null when there is none. */
const postButton = (html: string) => /<button([^>]*)>(?:(?!<\/button>)[\s\S])*Post revaluation<\/button>/.exec(html)?.[1] ?? null;
const disabled = (tag: string | null) => tag !== null && / disabled=""/.test(tag);

describe('the FX Revaluation screen', () => {
  it('keeps its title and says what it is, and offers the month ends with the shown one chosen', () => {
    const html = render();
    expect(text(html)).toContain(
      'FX Revaluation Foreign-currency balances at a month end, in ringgit. Posted on the month end and reversed the next day.',
    );
    expect(html).toContain(`data-chosen="${E}"`);
    expect([...html.matchAll(/data-option="([\d-]+)">([^<]+)</g)].map(([, v, l]) => [v, l])).toEqual([
      [E, '30 September 2026'],
      ['2026-08-31', '31 August 2026'],
    ]);
  });

  it('shows the tiles, the closing rate with BNM\'s source and date, and the items by kind', () => {
    const t = text(render());
    expect(t).toContain('Unrealised gain or loss −RM 52.40 5 of 5 to post');
    expect(t).toContain('Currencies 1 USD');
    expect(t).toContain("Closing rate (RM per USD) Bank Negara Malaysia's 5 pm selling rate of 30 September 2026.");
    expect(t).toContain('Invoices +RM 140.00');
    expect(t).toContain('INV-0012 Harbour Freight Pte Ltd USD USD 600.00 4.4800 RM 2,520.00 RM 2,688.00 RM 168.00 RM 0.00 RM 168.00 +RM 168.00');
    expect(t).toContain('Supplier bills −RM 302.40');
    expect(t).toContain('Bank and cash accounts +RM 110.00');
    expect(t).toContain('SGD account Converted: no SGD left; the ringgit left is the gain or loss on converting.');
  });

  it('gives an owner or admin a rate box and Post', () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*id="fx-closing-USD"[^>]*value="4.48"/);
    expect(postButton(html)).not.toBeNull();
    expect(disabled(postButton(html))).toBe(false);
    expect(text(html)).not.toContain(FX_MEMBER_NOTE);
  });

  it('shows a member the rates read only, no Post, and who posts', () => {
    const html = render({ actions: READER, memberNote: true });
    expect(html).not.toContain('<input');
    expect(postButton(html)).toBeNull();
    expect(text(html)).toContain(`reversed the next day. ${FX_MEMBER_NOTE}`);
    expect(text(html)).toContain('Closing rate (RM per USD) 4.48');
  });

  it('shows a viewer or a demo guest the same, without the member line', () => {
    const html = render({ actions: READER });
    expect(html).not.toContain('<input');
    expect(postButton(html)).toBeNull();
    expect(text(html)).not.toContain(FX_MEMBER_NOTE);
  });

  it('shows the sample read only, with its month end alone', () => {
    const html = renderToStaticMarkup(<FxRevaluationView monthEnds={[E]} periodEnd={E} items={SAMPLE_FX_ITEMS} runs={SAMPLE_FX_RUNS} />);
    expect(html).not.toContain('<input');
    expect(postButton(html)).toBeNull();
    expect(text(html)).toContain('FX-0001 31 Aug 2026');
  });

  it('shows a ringgit-only workspace only that there is nothing to revalue: no figure, no field, no picker', () => {
    const html = render({ items: [], runs: [], ringgitOnly: true });
    expect(text(html)).toContain('No foreign-currency invoices, bills or accounts. Nothing to revalue.');
    expect(html).not.toContain('data-chosen');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<table');
    expect(postButton(html)).toBeNull();
    expect(text(html)).not.toMatch(/RM \d/);
  });

  it('says a month end with no foreign item has nothing to revalue, and still shows the history', () => {
    const t = text(render({ items: [] }));
    expect(t).toContain('No foreign-currency invoices, bills or accounts at 30 September 2026. Nothing to revalue.');
    expect(t).toContain('Posted revaluations');
    expect(t).toContain('FX-0001');
  });

  it('keeps Post from an earlier month end than one already posted, with FIN54\'s sentence', () => {
    const later: RevaluationRun = { ...SAMPLE_FX_RUNS[0], id: 'later', revaluation_no: 'FX-0003', period_end: '2026-10-31' };
    const html = render({ runs: [later] });
    expect(disabled(postButton(html))).toBe(true);
    expect(text(html)).toContain('FX-0003 for 31 Oct 2026 is already posted. Month ends are revalued in order, so an earlier one cannot be revalued now.');
  });

  it('keeps Post when nothing is left to post, with FIN56\'s sentence', () => {
    const settled = LIVE.map((i) => ({ ...i, earlier_myr: i.difference as number, posted_myr: 0, gain: 0 }));
    const html = render({ items: settled });
    expect(disabled(postButton(html))).toBe(true);
    expect(text(html)).toContain(FX_REVALUATION_MESSAGES.nothing(E));
  });

  it('keeps Post from a preview the server gave no digest for', () => {
    expect(disabled(postButton(render({ items: SAMPLE_FX_ITEMS })))).toBe(true);
  });

  it('says why a preview could not be worked out', () => {
    expect(text(render({ items: null, itemsError: 'Choose the last day of a month, on or before today.' }))).toContain(
      'Choose the last day of a month, on or before today.',
    );
  });

  it('lists the posted runs with who posted them and their net, and says when they could not be read', () => {
    const run = { ...SAMPLE_FX_RUNS[0], posted_by: 'u1' };
    const t = text(render({ runs: [run], postedBy: { u1: 'Aminah Ismail' } }));
    expect(t).toContain('FX-0001 31 Aug 2026 Aminah Ismail 2 Sep 2026 −RM 1,520.00 2 lines Export');
    expect(text(render({ runs: null }))).toContain('Posted revaluations could not be loaded. Please try again.');
  });

  it('renders names and references from the database as text', () => {
    const html = render({ items: [{ ...LIVE[0], party: '<img src=x onerror=alert(1)>', reference: '<b>INV</b>' }] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;INV&lt;/b&gt;');
  });

  it('shows gains in green and losses in red, and no purple or violet anywhere', () => {
    const html = render();
    expect(html).toContain('text-emerald-600');
    expect(html).toContain('text-red-600');
    expect(html).not.toMatch(/purple|violet|indigo|fuchsia/i);
  });
});
