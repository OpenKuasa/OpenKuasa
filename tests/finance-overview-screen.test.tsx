import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/** The Bendahara Overview, live branch: the cards that have a real source are filled from the books, the rest say why not. */

const state = vi.hoisted(() => ({
  inputs: async (): Promise<unknown> => ({}),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
}));
vi.mock('@/lib/ai/access', () => ({ isLiveChatAllowed: () => true }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ({ orgId: 'org' }) }));
vi.mock('@/lib/finance/view-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  todayUtc: () => '2026-10-23',
}));
vi.mock('@/lib/finance/invoices', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listInvoices: async () => [
    { id: 'i1', number: 'INV-1', customer_name: 'Acme', display_status: 'sent', invoice_date: '2026-10-01', due_date: '2026-10-30', currency: 'MYR', total: 1000, total_myr: 1000, paid: 750, paid_myr: 750, balance: 250 },
  ],
}));
vi.mock('@/lib/finance/bills', async (importOriginal) => ({ ...(await importOriginal<object>()), listBills: async () => [] }));
vi.mock('@/lib/finance/dashboard-data', () => ({ loadDashboardInputs: () => state.inputs() }));
vi.mock('@/components/finance/ask-bendahara-hero', () => ({ AskBendaharaHero: () => null }));
vi.mock('@/components/charts', () => ({
  AreaTrend: () => 'AREA',
  BarGroup: () => 'BAR',
  DonutStat: () => 'DONUT',
  FunnelFlow: () => 'FUNNEL',
  RadialGauge: ({ valueLabel }: { valueLabel: string }) => `GAUGE ${valueLabel}`,
  Sparkline: () => null,
}));

const account = (balance_myr: number, active = true) => ({ id: `a${balance_myr}`, active, balance_myr });
const inputs = {
  lines: [],
  accounts: [],
  receivables: [],
  payables: [],
  bankAccounts: [account(1000), account(234.5), account(999, false)],
  bankTransactions: [],
};

async function render() {
  const { default: OverviewScreen } = await import('@/screens/finance/assistant');
  return renderToStaticMarkup(await OverviewScreen());
}

describe('Bendahara Overview (live)', () => {
  it('fills the cash balance, collection rate and the not-yet cards', async () => {
    state.inputs = async () => inputs;
    const html = await render();
    expect(html).toContain('RM 1,234.50');
    expect(html).toContain('GAUGE 75%');
    expect(html).toContain('Paid of invoiced, last 90 days');
    expect(html).toContain('Nothing records when a customer opens an invoice yet.');
    expect(html).toContain('Invoices post to one sales account, so there are no categories yet.');
    expect(html).toContain('Bendahara&#x27;s agents are coming later.');
    expect(html.match(/Not available yet/g)?.length).toBe(3);
    expect(html).toContain('AREA');
  });

  it("says Couldn't load for a failed bank read, not zero", async () => {
    state.inputs = async () => ({ ...inputs, bankAccounts: null, bankTransactions: null });
    const html = await render();
    expect(html).toContain('Couldn&#x27;t load');
    const cash = html.slice(html.indexOf('Cash balance'), html.indexOf('Revenue · MTD'));
    expect(cash).toContain('—');
    expect(cash).not.toContain('RM ');
    expect(html).toContain('Cash in vs out');
    expect(html).not.toContain('AREA');
  });
});
