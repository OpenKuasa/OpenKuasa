import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContraFormCard } from '@/components/finance/contra-form-card';
import { CONTRA_MEMBER_NOTE, type ContraActions, ContrasView } from '@/components/finance/contras-view';
import { CONTRA_FORM_MESSAGES, type ContraParty } from '@/lib/finance/contra-form';
import type { ContraAction } from '@/lib/finance/contras';
import { SAMPLE_CONTRAS } from '@/screens/finance/contra-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The Contra Entries screen, as the server sends it: rendered to a string and read as markup. There is no DOM here
 * (node, no jsdom), so nothing can be pressed or typed: what a press decides is in plain functions
 * (tests/finance-contra-form.test.ts). What still needs a browser is checked by hand.
 */

// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

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

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** The menu items of each table row that has any, by the row's number cell (a dash for a draft). */
const menus = (html: string) =>
  [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell);
      const items = [...row.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));
      return [text(cells[1] ?? ''), items] as const;
    })
    .filter(([, items]) => items.length > 0);

const done = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
const actions: ContraActions = {
  save: done({ id: 'x' }),
  saveAndPost: done({ id: 'x', contra_no: 'CT-0007' }),
  post: done({ id: 'x', contra_no: 'CT-0007' }),
  voidContra: done({ id: 'x' }),
  remove: done({ id: 'x' }),
};

const party: ContraParty = {
  id: 'sample-contact-lim',
  name: 'Lim Hardware',
  invoices: [{ id: 'i1', number: 'INV-0040', due_date: '2026-10-31', overdue: false, balance: 500, held: 0, payable: 500 }],
  bills: [{ id: 'b1', number: 'BILL-0030', due_date: '2026-10-20', overdue: true, balance: 300, held: 100, payable: 200 }],
};

const render = (over: { writer?: boolean; parties?: ContraParty[]; memberNote?: boolean; ask?: { kind: ContraAction; id: string } } = {}) =>
  renderToStaticMarkup(
    <ContrasView
      rows={SAMPLE_CONTRAS}
      today={SAMPLE_TODAY}
      followClock={false}
      writer={over.writer ? { actions, parties: over.parties ?? [party] } : undefined}
      memberNote={over.memberNote}
      initialAsk={over.ask}
    />,
  );

describe('the contra list', () => {
  it('lists every contra entry, newest first, with its contact, invoices, bills, amount and status', () => {
    const html = text(render());
    expect(html).toContain('Contra Entries');
    expect(html.indexOf('Tan & Sons Trading')).toBeLessThan(html.indexOf('CT-0005'));
    expect(html).toContain('CT-0005 Lim Hardware Letter LH/10/26 INV-0027, INV-0029 BILL-0017 RM 1,800.00 Posted');
    expect(html).toContain('BILL-0012, BILL-0014');
    expect(html).toContain('Showing 4 of 4 contra entries');
  });

  it('counts this month’s posted ones, what they set off, and the drafts', () => {
    const html = text(render());
    expect(html).toContain('Posted this month 1');
    expect(html).toContain('2 posted in all');
    expect(html).toContain('Set off this month RM 1,800.00');
    expect(html).toContain('Drafts 1');
  });

  it('has a status filter, a search and Export for everybody', () => {
    const html = render();
    for (const value of ['all', 'draft', 'posted', 'void']) expect(html).toContain(`data-option="${value}"`);
    expect(html).toContain('aria-label="Search contra entries by number, contact, reference, invoice or bill"');
    expect(text(html)).toContain('Export');
  });

  it('gives a viewer, a member and the demo workspace no New button and no menus', () => {
    const html = render();
    expect(text(html)).not.toContain('New contra entry');
    expect(html).not.toContain('role="menuitem"');
    expect(text(html)).not.toContain(CONTRA_MEMBER_NOTE);
  });

  it('tells a member who records contra entries', () => {
    expect(text(render({ memberNote: true }))).toContain(CONTRA_MEMBER_NOTE);
  });

  it('offers an owner or admin Edit, Post and Delete on a draft, Void on a posted one, and nothing on a void one', () => {
    const html = render({ writer: true });
    expect(text(html)).toContain('New contra entry');
    expect(menus(html)).toEqual([
      ['—', ['Edit', 'Post', 'Delete']],
      ['CT-0005', ['Void']],
      ['CT-0004', ['Void']],
    ]);
  });

  it('asks before voiding, saying what is owed again', () => {
    const html = text(render({ writer: true, ask: { kind: 'void', id: 'sample-contra-5' } }));
    expect(html).toContain('Void CT-0005? Lim Hardware will owe you RM 1,800.00 again on INV-0027, INV-0029, and you will owe them RM 1,800.00 again on BILL-0017. The books reverse it. This cannot be undone.');
    expect(html).toContain('Void contra entry');
  });

  it('asks before posting a draft, saying what it sets off', () => {
    const html = text(render({ writer: true, ask: { kind: 'post', id: 'sample-contra-6' } }));
    expect(html).toContain('They will owe you RM 2,750.00 less on INV-0031, and you will owe them RM 2,750.00 less on BILL-0019.');
    expect(html).toContain('Post contra entry');
  });
});

describe('the contra form', () => {
  const card = (parties: ContraParty[], editing?: (typeof SAMPLE_CONTRAS)[number]) =>
    text(renderToStaticMarkup(<ContraFormCard parties={parties} editing={editing} today={SAMPLE_TODAY} actions={actions} onClose={() => {}} />));

  it('says why there is nothing to record when no contact can have a contra entry', () => {
    expect(card([])).toContain(CONTRA_FORM_MESSAGES.nobody);
  });

  it('lists the chosen contact’s invoices and bills with what each can take, and the two sides against the amount', () => {
    const html = card([party]);
    expect(html).toContain('Lim Hardware (1 invoice, 1 bill)');
    expect(html).toContain('INV-0040 RM 500.00 owed · due 31 Oct 2026');
    expect(html).toContain('BILL-0030 RM 200.00 can be set off (RM 300.00 owed, RM 100.00 in payments not yet paid) · due 20 Oct 2026, overdue');
    expect(html).toContain('Invoices RM 0.00 of RM 0.00 · Bills RM 0.00 of RM 0.00');
    expect(html).toContain('Save draft');
    expect(html).toContain('Save and post');
  });

  it('opens a draft with its amounts, and says which of its lines can no longer be set off', () => {
    const draft = { ...SAMPLE_CONTRAS[1], status: 'draft' as const, contra_no: null };
    const html = card([party], draft);
    expect(html).toContain('Edit contra entry');
    expect(html).toContain('INV-0027, INV-0029 and BILL-0017 can no longer be set off');
  });
});
