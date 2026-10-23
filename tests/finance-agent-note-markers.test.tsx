import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillsView } from '@/components/finance/bills-view';
import { ExpensesView } from '@/components/finance/expenses-view';
import { InvoicesView } from '@/components/finance/invoices-view';
import { QuotationsView } from '@/components/finance/quotations-view';
import type { NoteCounts } from '@/lib/finance/agent/notes';
import { billsView } from '@/lib/finance/purchase-views';
import { quotationsView } from '@/lib/finance/sales-followon-views';
import { invoicesView } from '@/lib/finance/sales-views';
import { SAMPLE_EXPENSES } from '@/screens/finance/cash-book-sample';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_QUOTATIONS, SAMPLE_TODAY } from '@/screens/finance/sales-sample';
import { ringgitBill } from './helpers/bill-rows';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectTrigger: Pass, SelectValue: () => null, SelectContent: Pass, SelectItem: Pass };
});

/** Every id has two notes, the newest saying "LATEST <id>". */
const notesFor = (ids: string[]): NoteCounts => Object.fromEntries(ids.map((id) => [id, { count: 2, latest: `LATEST ${id}` }]));
/** Any marker's screen-reader text. */
const NONE = /\d+ agent notes?:/;

const bills = [
  ringgitBill({
    id: 'b1',
    bill_no: 'BILL-0001',
    supplier_id: 's1',
    supplier_name: 'Lim Hardware',
    bill_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 100,
    paid: 0,
    balance: 100,
    display_status: 'pending',
    purchase_order_id: null,
    purchase_order_no: null,
    category_id: null,
    category_name: null,
  }),
];

const screens: { name: string; render: (notes?: NoteCounts) => string; ids: string[] }[] = [
  {
    name: 'Invoices',
    ids: SAMPLE_INVOICES.map((r) => r.id),
    render: (notes) =>
      renderToStaticMarkup(
        <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} agentNotes={notes} />,
      ),
  },
  {
    name: 'Quotations',
    ids: SAMPLE_QUOTATIONS.map((r) => r.id),
    render: (notes) =>
      renderToStaticMarkup(
        <QuotationsView rows={SAMPLE_QUOTATIONS} view={quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY)} agentNotes={notes} />,
      ),
  },
  {
    name: 'Supplier Bills',
    ids: bills.map((r) => r.id),
    render: (notes) =>
      renderToStaticMarkup(<BillsView rows={bills} view={billsView(bills, [], '2026-10-09')} held={{}} agentNotes={notes} />),
  },
  {
    name: 'Expenses',
    ids: SAMPLE_EXPENSES.map((r) => r.id),
    render: (notes) =>
      renderToStaticMarkup(<ExpensesView rows={SAMPLE_EXPENSES} today={SAMPLE_TODAY} followClock={false} agentNotes={notes} />),
  },
];

describe('the agent note marker on list rows', () => {
  for (const s of screens) {
    it(`${s.name}: shows the count with the newest note as its tooltip`, () => {
      const html = s.render(notesFor(s.ids));
      // Read out as text (an aria-label on a plain span is not announced); the visible count stays.
      expect(html).toMatch(/<span class="sr-only">2 agent notes: LATEST [^<]+<\/span>/);
      expect(html).toContain('<span aria-hidden="true">2</span>');
      expect(html).not.toMatch(/<span[^>]*aria-label="[^"]*agent/);
      expect(html).toMatch(/title="LATEST [^"]+"/);
    });

    it(`${s.name}: shows nothing without counts (no database, or the read failed)`, () => {
      const html = s.render(undefined);
      expect(html).not.toMatch(NONE);
      expect(s.render({})).not.toMatch(NONE);
    });
  }

  it('says "note" for a single one', () => {
    const html = renderToStaticMarkup(
      <BillsView rows={bills} view={billsView(bills, [], '2026-10-09')} held={{}} agentNotes={{ b1: { count: 1, latest: 'Due soon' } }} />,
    );
    expect(html).toContain('<span class="sr-only">1 agent note: Due soon</span>');
    expect(html).toContain('title="Due soon"');
  });
});

/* ---- a list screen reads counts for the ids it loaded, and survives a failed read ---- */

const state = vi.hoisted(() => ({
  counts: null as null | ((ids: readonly string[]) => Promise<Record<string, { count: number; latest: string }> | null>),
  seen: [] as { type: string; ids: readonly string[] }[],
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', role: 'member', isDemo: false }),
  hasSupabaseEnv: () => true,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/finance/quotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/quotations')>()),
  listQuotations: async () => SAMPLE_QUOTATIONS,
}));
vi.mock('@/lib/finance/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/contacts')>()),
  listContacts: async () => [],
}));
vi.mock('@/lib/finance/products', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/products')>()),
  listProducts: async () => [],
}));
vi.mock('@/lib/finance/agent/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/agent/notes')>()),
  noteCountsFor: async (_ctx: unknown, type: string, ids: readonly string[]) => {
    state.seen.push({ type, ids });
    return state.counts!(ids);
  },
}));

const QuotationsScreen = (await import('@/screens/finance/quotations')).default;

beforeEach(() => {
  state.seen = [];
});

describe('the Quotations screen and the agent notes', () => {
  it('reads counts for exactly the quotations it loaded', async () => {
    state.counts = async (ids) => ({ [ids[0]]: { count: 3, latest: 'Expires in 3 days' } });
    const html = renderToStaticMarkup(await QuotationsScreen());
    expect(state.seen).toEqual([{ type: 'finance_quotation', ids: SAMPLE_QUOTATIONS.map((q) => q.id) }]);
    expect(html).toContain('3 agent notes: Expires in 3 days');
  });

  it('still renders, with no marker, when the counts could not be read', async () => {
    state.counts = async () => null;
    const html = renderToStaticMarkup(await QuotationsScreen());
    expect(html).toContain(SAMPLE_QUOTATIONS[0].quotation_no ?? '');
    expect(html).not.toMatch(NONE);
  });
});
