import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardScreen from '@/screens/finance/dashboard';
import { buildDashboardModel } from '@/lib/finance/dashboard';
import type { DashboardInputs } from '@/lib/finance/dashboard';
import { rm } from '@/lib/finance/format';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_PAYABLES, SAMPLE_RECEIVABLES } from '@/screens/finance/ledger-sample';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from '@/screens/finance/banking-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

const state = vi.hoisted(() => ({
  env: false,
  load: null as null | (() => Promise<unknown>),
  yearEndMonth: 12,
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1' }),
  hasSupabaseEnv: () => state.env,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/finance/dashboard-data', () => ({ loadDashboardInputs: () => state.load!() }));
vi.mock('@/lib/finance/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/settings')>()),
  financeSettingsOrDefault: async () => ({ yearEndMonth: state.yearEndMonth, lockDate: null, updatedAt: null }),
}));
vi.mock('@/lib/people/dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people/dates')>()),
  todayInMalaysia: () => '2026-10-10',
}));

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const sample: DashboardInputs = {
  lines: SAMPLE_LEDGER_LINES,
  accounts: SAMPLE_LEDGER_ACCOUNTS,
  receivables: SAMPLE_RECEIVABLES,
  payables: SAMPLE_PAYABLES,
  bankAccounts: SAMPLE_BANK_ACCOUNTS,
  bankTransactions: SAMPLE_BANK_TRANSACTIONS,
};

beforeEach(() => {
  state.env = false;
  state.load = null;
  state.yearEndMonth = 12;
});

describe('the Dashboard without a database', () => {
  it('shows the books-driven Revenue figure, the cash book heading and no Export button', async () => {
    const model = buildDashboardModel(sample, SAMPLE_TODAY, 'this_month');
    const text = textOf(renderToStaticMarkup(await DashboardScreen({})));
    expect(text).toContain(rm(model.pl.totalIncome));
    expect(text).toContain('Latest cash book activity');
    expect(text).not.toContain('Export');
  });

  it('reads ?period= and names the period', async () => {
    const text = textOf(renderToStaticMarkup(await DashboardScreen({ searchParams: Promise.resolve({ period: 'this_year' }) })));
    expect(text).toContain('financial overview · This year');
    const dflt = textOf(renderToStaticMarkup(await DashboardScreen({})));
    expect(dflt).toContain('financial overview · This month');
  });
});

describe('the Dashboard with a database', () => {
  it('shows one notice when the ledger read fails', async () => {
    state.env = true;
    state.load = async () => {
      throw new Error('boom');
    };
    const text = textOf(renderToStaticMarkup(await DashboardScreen({})));
    expect(text).toContain("Couldn't load your dashboard");
    expect(text).not.toContain('Latest cash book activity');
  });

  it("says Couldn't load for a card whose read failed, not zero", async () => {
    state.env = true;
    state.load = async () => ({ ...sample, bankAccounts: null, bankTransactions: null, receivables: null, payables: null });
    const text = textOf(renderToStaticMarkup(await DashboardScreen({})));
    expect(text).toContain("Couldn't load");
    expect(text).not.toContain('Cash position RM 0.00');
  });

  it("works This year out from the workspace's financial year end", async () => {
    state.env = true;
    state.load = async () => sample;
    state.yearEndMonth = 9;
    const september = buildDashboardModel(sample, '2026-10-10', 'this_year', 9);
    const december = buildDashboardModel(sample, '2026-10-10', 'this_year');
    expect(september.pl.totalIncome).not.toBe(december.pl.totalIncome);
    const text = textOf(renderToStaticMarkup(await DashboardScreen({ searchParams: Promise.resolve({ period: 'this_year' }) })));
    expect(text).toContain(rm(september.pl.totalIncome));
    expect(text).not.toContain(rm(december.pl.totalIncome));
  });

  it('shows one friendly notice for an empty workspace', async () => {
    state.env = true;
    state.load = async () => ({ lines: [], accounts: [], receivables: [], payables: [], bankAccounts: [], bankTransactions: [] });
    const text = textOf(renderToStaticMarkup(await DashboardScreen({})));
    expect(text).toContain('Nothing is recorded yet');
    expect(text).toContain('Invoices');
    expect(text).toContain('Banking');
  });
});
