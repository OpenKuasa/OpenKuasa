import { describe, expect, it } from 'vitest';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from '@/screens/finance/banking-sample';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_RECEIVABLES } from '@/screens/finance/ledger-sample';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import {
  buildDashboardModel,
  collectionRate,
  deltaChip,
  parseDashboardPeriod,
  percentChange,
  previousPeriod,
  trendPeriod,
  weeklyCash,
  type DashboardInputs,
} from '@/lib/finance/dashboard';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { LedgerAccount, LedgerLine } from '@/lib/finance/ledger';
import { aged, cashFlow, cashMovements, monthlyTotals, periodFor, profitAndLoss } from '@/lib/finance/reports';

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
  it('moves the whole period back one unit of its key', () => {
    expect(previousPeriod({ from: '2026-10', to: '2026-10' }, 'this_month')).toEqual({ from: '2026-09', to: '2026-09' });
    expect(previousPeriod({ from: '2026-10', to: '2026-10' }, 'this_quarter')).toEqual({ from: '2026-07', to: '2026-07' });
    expect(previousPeriod({ from: '2026-01', to: '2026-10' }, 'this_year')).toEqual({ from: '2025-01', to: '2025-10' });
    expect(previousPeriod({ from: '2026-01', to: '2026-01' }, 'this_month')).toEqual({ from: '2025-12', to: '2025-12' });
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

  it('uses ringgit for foreign accounts; cash counts every account like Banking, and an archived zero one is not listed', () => {
    const model = buildDashboardModel(
      {
        ...empty,
        bankAccounts: [
          bankAccount({ id: 'usd', balance: 1000, balance_myr: 4700, active: true }),
          bankAccount({ id: 'old', balance: 99, balance_myr: 99, active: false }),
          bankAccount({ id: 'zero', balance: 0, balance_myr: 0, active: false }),
        ],
      },
      TODAY,
      'this_month',
    );
    expect(model.cashPosition).toBe(4799);
    expect(model.bankAccounts?.map((a) => a.id)).toEqual(['usd', 'old']);
    expect(model.bankAccounts?.[0].balance).toBe(4700);
  });

  it('formats a delta chip: none without a comparison, flat and a true minus sign', () => {
    expect(deltaChip(null, 'up')).toEqual({ delta: undefined, tone: 'flat' });
    expect(deltaChip(0, 'up')).toEqual({ delta: '0%', tone: 'flat' });
    expect(deltaChip(12, 'up')).toEqual({ delta: '+12%', tone: 'up' });
    expect(deltaChip(-5, 'up')).toEqual({ delta: '−5%', tone: 'down' });
    expect(deltaChip(-5, 'down')).toEqual({ delta: '−5%', tone: 'up' });
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
    const nulls: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'number') expect(Number.isFinite(value), path).toBe(true);
      else if (value === null) nulls.push(path);
      else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(model, 'model');
    // The only nulls an empty workspace may show are the declared ones: no margin, nothing to compare to.
    expect(nulls.sort()).toEqual(
      ['model.deltas.expenses', 'model.deltas.net', 'model.deltas.revenue', 'model.pl.margin'].sort(),
    );
  });

  it('delta is a whole percent when the previous period has money', () => {
    const accounts = [{ id: 'rev', code: '4000', name: 'Sales', type: 'income', stands_for: 'system' }] as LedgerAccount[];
    const line = (entry_date: string, credit: number): LedgerLine => ({
      entry_key: entry_date, entry_date, source: 'journal', source_id: 's', source_no: null, description: 'x', account_id: 'rev', debit: 0, credit,
    });
    const model = buildDashboardModel(
      { ...empty, lines: [line('2026-09-10', 100), line('2026-10-05', 110)], accounts },
      TODAY,
      'this_month',
    );
    expect(model.deltas.revenue).toBe(10);
  });

  it('cashTrend closing agrees with Reports', () => {
    const model = buildDashboardModel(inputs, TODAY, 'this_month');
    const movements = cashMovements(SAMPLE_LEDGER_LINES, SAMPLE_LEDGER_ACCOUNTS);
    const withMoves = model.series.filter((p) => movements.some((m) => m.month === p.month));
    expect(withMoves.length).toBeGreaterThan(0);
    for (const p of withMoves) {
      const i = model.series.indexOf(p);
      const flow = cashFlow(movements, { from: p.month, to: p.month });
      expect(model.cashTrend[i].balance).toBe(flow.closing);
      expect(model.cashTrend[i].net).toBe(flow.net);
    }
  });

  it('isEmpty is true only when every read succeeded and all are empty', () => {
    expect(buildDashboardModel(empty, TODAY, 'this_month').isEmpty).toBe(true);
    expect(buildDashboardModel({ ...empty, bankAccounts: null }, TODAY, 'this_month').isEmpty).toBe(false);
    expect(buildDashboardModel({ ...empty, receivables: null }, TODAY, 'this_month').isEmpty).toBe(false);
    expect(buildDashboardModel({ ...empty, payables: null }, TODAY, 'this_month').isEmpty).toBe(false);
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
  it('counts 89 days back, not 90, and leaves out voids', () => {
    const rows = [
      invoice({ invoice_date: '2026-07-25', total_myr: 1000, paid_myr: 1000 }),
      invoice({ invoice_date: '2026-07-26', total_myr: 1000, paid_myr: 0 }),
      invoice({ display_status: 'void', total_myr: 1000, paid_myr: 1000 }),
    ];
    expect(collectionRate(rows, TODAY)).toBe(0);
    expect(collectionRate([rows[0]], TODAY)).toBeNull();
  });
  it('is null with nothing to collect', () => {
    expect(collectionRate([], TODAY)).toBeNull();
  });
  it('uses ringgit for a foreign invoice', () => {
    expect(collectionRate([invoice({ currency: 'USD', total: 200, total_myr: 940, paid: 100, paid_myr: 470 })], TODAY)).toBe(50);
  });
});
