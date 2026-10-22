import { describe, expect, it } from 'vitest';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from '@/screens/finance/banking-sample';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_RECEIVABLES } from '@/screens/finance/ledger-sample';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import {
  buildDashboardModel,
  collectionRate,
  parseDashboardPeriod,
  percentChange,
  previousPeriod,
  trendPeriod,
  weeklyCash,
  type DashboardInputs,
} from '@/lib/finance/dashboard';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { LedgerAccount, LedgerLine } from '@/lib/finance/ledger';
import { aged, monthlyTotals, periodFor, profitAndLoss } from '@/lib/finance/reports';

const TODAY = '2026-10-23';

const empty: DashboardInputs = {
  lines: [],
  accounts: [],
  receivables: [],
  payables: [],
  bankAccounts: [],
  bankTransactions: [],
};

const txn = (over: Partial<BankTransactionRow>): BankTransactionRow =>
  ({
    transaction_id: 't',
    account_id: 'a',
    account_name: 'Main',
    account_kind: 'bank',
    direction: 'in',
    txn_date: '2026-10-20',
    amount: 100,
    amount_myr: 100,
    status: 'posted',
    kind: 'invoice',
    party_name: 'Acme',
    documents: null,
    created_at: '2026-10-20T10:00:00Z',
    ...over,
  }) as BankTransactionRow;

const bankAccount = (over: Partial<BankAccountRow>): BankAccountRow =>
  ({ ...SAMPLE_BANK_ACCOUNTS[0], ...over }) as BankAccountRow;

const invoice = (over: Partial<InvoiceListRow>): InvoiceListRow =>
  ({
    display_status: 'sent',
    invoice_date: '2026-10-01',
    currency: 'MYR',
    total: 1000,
    total_myr: 1000,
    paid: 0,
    paid_myr: 0,
    ...over,
  }) as InvoiceListRow;

describe('parseDashboardPeriod', () => {
  it('falls back to this month', () => {
    expect(parseDashboardPeriod(undefined)).toBe('this_month');
    expect(parseDashboardPeriod('garbage')).toBe('this_month');
    expect(parseDashboardPeriod(['this_year'])).toBe('this_month');
  });
  it('reads a known key', () => {
    expect(parseDashboardPeriod('this_quarter')).toBe('this_quarter');
  });
});

describe('previousPeriod', () => {
  it('is the same length, ending the month before', () => {
    expect(previousPeriod({ from: '2026-07', to: '2026-09' })).toEqual({ from: '2026-04', to: '2026-06' });
    expect(previousPeriod({ from: '2026-01', to: '2026-01' })).toEqual({ from: '2025-12', to: '2025-12' });
  });
});

describe('trendPeriod', () => {
  it('runs eight months to this month', () => {
    expect(trendPeriod('2026-02-15')).toEqual({ from: '2025-07', to: '2026-02' });
  });
});

describe('percentChange', () => {
  it('is a whole percent, null off zero', () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });
});

describe('buildDashboardModel', () => {
  const inputs: DashboardInputs = {
    lines: SAMPLE_LEDGER_LINES,
    accounts: SAMPLE_LEDGER_ACCOUNTS,
    receivables: SAMPLE_RECEIVABLES,
    payables: [],
    bankAccounts: SAMPLE_BANK_ACCOUNTS,
    bankTransactions: SAMPLE_BANK_TRANSACTIONS,
  };

  it('matches Reports', () => {
    const model = buildDashboardModel(inputs, TODAY, 'this_year');
    const { totals } = monthlyTotals(SAMPLE_LEDGER_LINES);
    expect(model.pl).toEqual(profitAndLoss(SAMPLE_LEDGER_ACCOUNTS, totals, periodFor('this_year', TODAY, totals)));
    expect(model.receivable).toEqual(aged(SAMPLE_RECEIVABLES, TODAY));
    expect(model.isEmpty).toBe(false);
  });

  it('delta is null when the previous period is zero', () => {
    const accounts = [{ id: 'rev', code: '4000', name: 'Sales', type: 'income', stands_for: 'system' }] as LedgerAccount[];
    const lines: LedgerLine[] = [
      { entry_key: 'k', entry_date: '2026-10-05', source: 'journal', source_id: 's', source_no: null, description: 'x', account_id: 'rev', debit: 0, credit: 500 },
    ];
    const model = buildDashboardModel({ ...empty, lines, accounts }, TODAY, 'this_month');
    expect(model.deltas.revenue).toBeNull();
  });

  it('uses ringgit for foreign accounts and leaves out inactive ones', () => {
    const model = buildDashboardModel(
      {
        ...empty,
        bankAccounts: [
          bankAccount({ id: 'usd', balance: 1000, balance_myr: 4700, active: true }),
          bankAccount({ id: 'old', balance: 99, balance_myr: 99, active: false }),
        ],
      },
      TODAY,
      'this_month',
    );
    expect(model.cashPosition).toBe(4700);
    expect(model.bankAccounts?.map((a) => a.id)).toEqual(['usd']);
    expect(model.bankAccounts?.[0].balance).toBe(4700);
  });

  it('recentCash drops transfers and drafts, orders, and caps at 8', () => {
    const rows = [
      txn({ transaction_id: 'transfer', kind: 'transfer' }),
      txn({ transaction_id: 'draft', status: 'draft' as BankTransactionRow['status'] }),
      txn({ transaction_id: 'old', txn_date: '2026-10-01' }),
      txn({ transaction_id: 'early', created_at: '2026-10-20T08:00:00Z' }),
      ...Array.from({ length: 9 }, (_, i) =>
        txn({ transaction_id: `r${i}`, txn_date: '2026-10-21', created_at: `2026-10-21T0${i}:00:00Z` }),
      ),
    ];
    const model = buildDashboardModel({ ...empty, bankTransactions: rows }, TODAY, 'this_month');
    const ids = model.recentCash!.map((r) => r.id);
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe('r8');
    expect(ids).not.toContain('transfer');
    expect(ids).not.toContain('draft');
    expect(ids).not.toContain('old');
  });

  it('trend crosses a year', () => {
    const model = buildDashboardModel(inputs, '2026-02-15', 'this_month');
    expect(model.series).toHaveLength(8);
    expect(model.series[0].month).toBe('2025-07');
    expect(model.cashTrend).toHaveLength(8);
    expect(model.cashTrend[0].label).toBe(model.series[0].label);
  });

  it('empty inputs give zeros, not NaN', () => {
    const model = buildDashboardModel(empty, TODAY, 'this_month');
    expect(model.isEmpty).toBe(true);
    expect(model.pl.margin).toBeNull();
    expect(model.cashPosition).toBe(0);
    expect(JSON.stringify(model)).not.toContain('NaN');
  });

  it('failed reads stay null', () => {
    const model = buildDashboardModel(
      { ...empty, bankAccounts: null, receivables: null, bankTransactions: null },
      TODAY,
      'this_month',
    );
    expect(model.cashPosition).toBeNull();
    expect(model.bankAccounts).toBeNull();
    expect(model.receivable).toBeNull();
    expect(model.recentCash).toBeNull();
    expect(model.payable).not.toBeNull();
  });
});

describe('weeklyCash', () => {
  it('uses amount_myr, skips transfers, and fills empty weeks', () => {
    const weeks = weeklyCash(
      [
        txn({ amount: 100, amount_myr: 470, txn_date: '2026-10-21' }),
        txn({ kind: 'transfer', amount: 999, amount_myr: 999, txn_date: '2026-10-21' }),
      ],
      TODAY,
    );
    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toEqual({ weekStart: '2026-10-19', label: '19 Oct', in: 470, out: 0 });
    expect(weeks[0].weekStart).toBe('2026-08-31');
    expect(weeks.slice(0, 7).every((w) => w.in === 0 && w.out === 0)).toBe(true);
  });
});

describe('collectionRate', () => {
  it('is paid over total of posted invoices in the window', () => {
    const rows = [
      invoice({ total_myr: 600, paid_myr: 150 }),
      invoice({ total_myr: 400, paid_myr: 100 }),
      invoice({ display_status: 'draft', total_myr: 5000, paid_myr: 0 }),
      invoice({ invoice_date: '2026-06-01', total_myr: 9000, paid_myr: 9000 }),
    ];
    expect(collectionRate(rows, TODAY)).toBe(25);
  });
  it('is null with nothing to collect', () => {
    expect(collectionRate([], TODAY)).toBeNull();
  });
  it('uses ringgit for a foreign invoice', () => {
    expect(collectionRate([invoice({ currency: 'USD', total: 200, total_myr: 940, paid: 100, paid_myr: 470 })], TODAY)).toBe(50);
  });
});
