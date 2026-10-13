import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JournalFormCard, withTypedSide } from '@/components/finance/journal-form-card';
import { type JournalActions, JournalsView } from '@/components/finance/journals-view';
import type { JournalDetail, JournalRow, LedgerAccount, LedgerLine } from '@/lib/finance/ledger';
import { newJournalForm } from '@/lib/finance/ledger-form';
import { SAMPLE_JOURNALS, SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES } from '@/screens/finance/ledger-sample';

/**
 * The Journals screen, as the server sends it: rendered to a string and read as markup. There is no DOM here
 * (node, no jsdom), so nothing can be pressed or typed: what a press decides is in plain functions
 * (tests/finance-ledger-form.test.ts, tests/finance-ledger-views.test.ts). What still needs a browser is
 * checked by hand.
 */

const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(nav.query) }));

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
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));

const done = <T,>(data: T) => vi.fn(async () => ({ ok: true as const, data }));
const actions: JournalActions = {
  save: done({ id: 'x' }),
  saveAndPost: done({ id: 'x', journal_no: 'JNL-0002' }),
  post: done({ id: 'x', journal_no: 'JNL-0002' }),
  reverse: done({ id: 'x', reversal_id: 'y' }),
  remove: done({ id: 'x' }),
  get: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
};

const accounts = SAMPLE_LEDGER_ACCOUNTS;
const render = (over: { lines?: LedgerLine[]; journals?: JournalRow[]; writer?: boolean; query?: string } = {}) => {
  nav.query = over.query ?? '';
  return renderToStaticMarkup(
    <JournalsView
      lines={over.lines ?? SAMPLE_LEDGER_LINES}
      accounts={accounts}
      journals={over.journals}
      writer={over.writer ? { actions } : undefined}
    />,
  );
};

const draft: JournalRow = {
  id: '44444444-4444-4444-8444-444444444444',
  journal_no: null,
  journal_date: '2026-10-08',
  description: 'Accrue October electricity',
  status: 'draft',
  reverses_journal_id: null,
  reversed: false,
};

describe('the ledger', () => {
  it('shows the entries newest first, each with its date, number, source and description', () => {
    const html = text(render());
    expect(html).toContain('Entries shown 12 of 12');
    expect(html.indexOf('Depreciation of office equipment')).toBeLessThan(html.indexOf('Payment to Kopi Hulu Supplies'));
    expect(html.indexOf('Payment to Kopi Hulu Supplies')).toBeLessThan(html.indexOf('Opening balance of Main Bank'));
    expect(html).toContain('05 Oct 2026');
    expect(html).toContain('JNL-0001');
    expect(html).toContain('Manual journal');
    expect(html).toContain('Supplier bill');
    // An entry with no number shows a dash.
    expect(html).toMatch(/01 Jul 2026 — Opening balance/);
  });

  it('lists the lines of an entry with account code and name, debit and credit', () => {
    const html = text(render());
    expect(html).toContain('6200 Depreciation RM 400.00');
    expect(html).toContain('1500 Accumulated Depreciation');
  });

  it('shows equal total debits and total credits', () => {
    const html = text(render());
    expect(html).toContain('Total debits RM 70,290.00');
    expect(html).toContain('Total credits RM 70,290.00');
    expect(html).not.toContain('Out of balance');
  });

  it('links an automatic entry to the screen it came from, and a manual journal to nothing', () => {
    const html = render();
    expect(html).toContain('href="/finance/invoices"');
    expect(html).toContain('href="/finance/supplier-bills"');
    expect(html).toContain('href="/finance/cash-receipts"');
    expect(html).toContain('href="/finance/payment-vouchers"');
    expect(text(html)).toContain('Open in Cash Receipts');
    expect(text(html)).toContain('Open in Payment Vouchers');
    expect(html).toContain('href="/finance/banking"');
    expect(text(html)).toContain('Open in Invoices');
    expect(text(html)).toContain('Open in Supplier Bills');
    expect(text(render({ lines: SAMPLE_LEDGER_LINES.filter((l) => l.source === 'journal') }))).not.toContain('Open in');
  });

  it('offers the filters and Export, and the accounts as "1100 Main Bank"', () => {
    const html = render();
    // The mocked select draws no trigger, so Source and Account are read through their options.
    for (const label of ['Search the ledger', 'From date', 'To date']) expect(html).toContain(`aria-label="${label}`);
    expect(text(html)).toContain('All sources');
    expect(text(html)).toContain('All accounts');
    expect(html).toContain('data-option="payment_in"');
    expect(html).toContain('data-option="acc-1100"');
    expect(text(html)).toContain('1100 Main Bank');
    expect(text(html)).toContain('Export');
  });

  it('preselects the account named in the address', () => {
    const html = render({ query: 'account=acc-1500' });
    expect(text(html)).toContain('Entries shown 1');
    expect(html).toContain('data-chosen="acc-1500"');
    expect(text(html)).not.toContain('Payment to Kopi Hulu Supplies');
  });

  it('says so when the ledger is empty', () => {
    expect(text(render({ lines: [] }))).toContain('No ledger entries yet.');
  });

  it('shows 50 entries and Show more when there are more, counting all of them', () => {
    const lines: LedgerLine[] = Array.from({ length: 120 }, (_, i) => i).flatMap((i) =>
      [
        { account_id: 'acc-1100', debit: 10, credit: 0 },
        { account_id: 'acc-4000', debit: 0, credit: 10 },
      ].map((side) => ({
        entry_key: `invoice:k${String(i).padStart(3, '0')}`,
        entry_date: '2026-10-01',
        source: 'invoice' as const,
        source_id: `k${i}`,
        source_no: `INV-${i}`,
        description: `Sale ${i}`,
        ...side,
      })),
    );
    const html = text(render({ lines }));
    expect(html).toContain('Entries shown 120');
    expect(html).toContain('Showing 50 of 120 entries');
    expect(html).toContain('Show more');
    expect(html).toContain('Total debits RM 1,200.00');
  });
});

describe('who may change the journals', () => {
  it('gives a member the ledger, filters and Export, but nothing to change', () => {
    const html = render({ journals: SAMPLE_JOURNALS });
    expect(text(html)).not.toContain('New journal');
    expect(text(html)).not.toContain('Reverse');
    expect(items(html)).toEqual([]);
    expect(text(html)).toContain('Export');
  });

  it('gives a sign-off viewer New journal, and Reverse on a posted manual journal not yet reversed', () => {
    const html = text(render({ writer: true, journals: SAMPLE_JOURNALS }));
    expect(html).toContain('New journal');
    expect(html).toContain('Reverse');
    expect(render({ writer: true, journals: SAMPLE_JOURNALS })).toContain('aria-label="Reverse JNL-0001"');
  });

  it('offers no Reverse once the journal is reversed, and none on an automatic entry', () => {
    const reversed = render({ writer: true, journals: [{ ...SAMPLE_JOURNALS[0], reversed: true }] });
    expect(reversed).not.toContain('aria-label="Reverse');
    expect(text(render({ writer: true, journals: SAMPLE_JOURNALS, lines: SAMPLE_LEDGER_LINES.filter((l) => l.source === 'invoice') }))).not.toContain('Reverse');
  });

  it('lists the drafts in their own card with Edit, Post and Delete', () => {
    const html = render({ writer: true, journals: [...SAMPLE_JOURNALS, draft] });
    expect(text(html)).toContain('Draft journals');
    expect(text(html)).toContain('Accrue October electricity');
    expect(items(html)).toEqual(['Edit', 'Post', 'Delete']);
  });

  it('shows no drafts card when there are none', () => {
    expect(text(render({ writer: true, journals: SAMPLE_JOURNALS }))).not.toContain('Draft journals');
  });
});

describe('the journal form', () => {
  const active: LedgerAccount[] = accounts.filter((a) => a.active);
  const card = (editing?: JournalDetail, list = active) =>
    renderToStaticMarkup(<JournalFormCard editing={editing} accounts={list} today="2026-10-12" actions={actions} onClose={() => {}} />);

  it('opens with today’s date, two empty lines and the totals', () => {
    const html = card();
    expect(text(html)).toContain('New journal');
    expect(html).toContain('value="2026-10-12"');
    for (const n of [1, 2]) {
      for (const what of ['Debit', 'Credit', 'Note']) expect(html).toContain(`aria-label="${what} for line ${n}"`);
    }
    expect(html).not.toContain('aria-label="Debit for line 3"');
    expect(html.match(/data-chosen=""/g)).toHaveLength(2);
    expect(html).toContain('inputMode="decimal"');
    expect(text(html)).toContain('Debits RM 0.00');
    expect(text(html)).toContain('Credits RM 0.00');
    expect(text(html)).toContain('Difference RM 0.00');
    expect(text(html)).toContain('Add line');
    expect(text(html)).toContain('Save draft');
    expect(text(html)).toContain('Save and post');
    expect(html).toContain('data-finance-focus');
  });

  it('offers only active accounts, as code and name in code order', () => {
    const html = card(undefined, [...active, { ...accounts[0], id: 'old', code: '6900', name: 'Courier (old)', active: false }]);
    expect(text(html)).toContain('1100 Main Bank');
    expect(html).not.toContain('Courier (old)');
    expect(html.indexOf('1000 Cash in Hand')).toBeLessThan(html.indexOf('1100 Main Bank'));
  });

  it('shows an archived account a saved draft still uses', () => {
    const detail: JournalDetail = {
      ...draft,
      lines: [
        { id: 'l1', position: 1, account_id: 'old', debit: 100, credit: 0, note: null },
        { id: 'l2', position: 2, account_id: 'acc-1100', debit: 0, credit: 90, note: 'rent' },
      ],
    };
    const html = card(detail, [...active, { ...accounts[0], id: 'old', code: '6900', name: 'Courier (old)', active: false }]);
    expect(text(html)).toContain('Edit journal');
    expect(html).toContain('6900 Courier (old)');
    expect(text(html)).toContain('Debits RM 100.00');
    expect(text(html)).toContain('Credits RM 90.00');
    expect(text(html)).toContain('Difference RM 10.00');
  });

  it('typing a figure on one side of a line clears the other side', () => {
    const form = newJournalForm('2026-10-12', 'n');
    const k = form.lines[0].key;
    const credited = withTypedSide(form.lines.map((l) => (l.key === k ? { ...l, credit: '50' } : l)), k, 'debit', '20');
    expect(credited[0]).toMatchObject({ debit: '20', credit: '' });
    // Emptying a box leaves the other side alone.
    const cleared = withTypedSide(credited, k, 'credit', '');
    expect(cleared[0]).toMatchObject({ debit: '20', credit: '' });
    expect(withTypedSide(credited, form.lines[1].key, 'credit', '7')[1]).toMatchObject({ debit: '', credit: '7' });
  });
});
