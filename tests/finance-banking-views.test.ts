import { describe, expect, it } from 'vitest';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import {
  accountOptionLabel,
  bankDescription,
  bankingCsv,
  bankingView,
  filterLedger,
  reconcileLabel,
  signedAmount,
  signedRinggit,
  withRunningBalance,
} from '@/lib/finance/banking-views';
import { CSV_BOM } from '@/lib/finance/csv';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from '@/screens/finance/banking-sample';
import { SAMPLE_CASH_RECEIPTS, SAMPLE_PAYMENT_VOUCHERS } from '@/screens/finance/cash-book-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

const TODAY = '2026-10-10';

const account = (id: string, patch: Partial<BankAccountRow> = {}): BankAccountRow => {
  const row = {
    id,
    name: id === 'till' ? 'Cash in hand' : id === 'bank' ? 'Main Bank' : 'Savings',
    kind: id === 'till' ? ('cash' as const) : ('bank' as const),
    bank_name: null,
    opening_balance: 0,
    opening_date: '2026-01-01',
    active: true,
    balance: 0,
    to_be_paid: 0,
    last_import_at: null,
    unmatched_lines: 0,
    currency: 'MYR',
    opening_rate_text: '1.0000000000',
    opening_rate_source: null,
    opening_rate_date: null,
    ...patch,
  };
  // A ringgit account's ringgit figures are its own unless a case says otherwise.
  return { ...row, opening_balance_myr: patch.opening_balance_myr ?? row.opening_balance, balance_myr: patch.balance_myr ?? row.balance };
};

let made = 0;
const txn = (patch: Partial<BankTransactionRow> = {}): BankTransactionRow => {
  made += 1;
  const row = {
    transaction_id: `t${String(made).padStart(3, '0')}`,
    account_id: 'bank',
    account_name: 'Main Bank',
    account_kind: 'bank' as const,
    direction: 'in' as const,
    txn_date: '2026-10-05',
    amount: 100,
    status: 'posted' as const,
    number: 'RC-0001',
    method: 'fpx' as const,
    reference: null,
    notes: null,
    party_name: 'Aisyah Trading',
    kind: 'invoice' as const,
    category_name: null,
    documents: 'INV-0012',
    transfer_id: null,
    other_account_name: null,
    reconciled: false,
    created_at: '2026-10-05T02:00:00Z',
    currency: 'MYR',
    fx_rate_text: '1.0000000000',
    fx_rate_source: null,
    other_currency: null,
    other_amount: null,
    ...patch,
  };
  // A ringgit movement's ringgit is its amount unless a case says otherwise.
  return { ...row, amount_myr: patch.amount_myr ?? row.amount };
};

describe('bankDescription', () => {
  it('names the account at the other end of a transfer, by direction', () => {
    const out = txn({ kind: 'transfer', direction: 'out', party_name: null, documents: null, other_account_name: 'Savings' });
    expect(bankDescription(out)).toBe('Transfer to Savings');
    expect(bankDescription({ ...out, direction: 'in', other_account_name: 'Main Bank' })).toBe('Transfer from Main Bank');
    expect(bankDescription({ ...out, other_account_name: null })).toBe('Transfer to another account');
    // Two ringgit sides name no amount, whatever the row carries.
    expect(bankDescription({ ...out, other_currency: 'MYR', other_amount: out.amount })).toBe('Transfer to Savings');
  });
  it('names what the other side moved when its currency differs (stage 5c)', () => {
    const out = txn({
      kind: 'transfer', direction: 'out', party_name: null, documents: null, other_account_name: 'USD Account', amount: 4462,
      other_currency: 'USD', other_amount: 1000,
    });
    expect(bankDescription(out)).toBe('Transfer to USD Account (USD 1,000.00)');
    const inn = txn({
      kind: 'transfer', direction: 'in', party_name: null, documents: null, other_account_name: 'Maybank', amount: 1000, currency: 'USD',
      amount_myr: 4462, other_currency: 'MYR', other_amount: 4462,
    });
    expect(bankDescription(inn)).toBe('Transfer from Maybank (RM 4,462.00)');
  });
  it('names who paid or was paid and what for, and falls back to the kind', () => {
    expect(bankDescription(txn())).toBe('Aisyah Trading · INV-0012');
    expect(bankDescription(txn({ kind: 'other', direction: 'out', party_name: 'Maybank', documents: null, category_name: 'Bank charges' }))).toBe(
      'Maybank · Bank charges',
    );
    expect(bankDescription(txn({ kind: 'income', party_name: null, documents: null, category_name: 'Sales' }))).toBe('Receipt · Sales');
    expect(bankDescription(txn({ kind: 'expense', direction: 'out', party_name: null, documents: null, category_name: null }))).toBe('Expense');
  });
});

describe('accountOptionLabel', () => {
  it('marks an archived account', () => {
    expect(accountOptionLabel(account('savings'))).toBe('Savings');
    expect(accountOptionLabel(account('savings', { active: false }))).toBe('Savings (archived)');
  });
});

describe('withRunningBalance', () => {
  it('starts each account from its opening balance and adds posted movements in date order, newest first', () => {
    const accounts = [account('bank', { opening_balance: 1000 }), account('till', { opening_balance: 50 })];
    const rows = [
      txn({ transaction_id: 'c', txn_date: '2026-10-07', direction: 'out', amount: 300.1 }),
      txn({ transaction_id: 'a', txn_date: '2026-10-05', amount: 200.2 }),
      txn({ transaction_id: 'b', txn_date: '2026-10-06', account_id: 'till', account_kind: 'cash', amount: 25 }),
    ];
    expect(withRunningBalance(accounts, rows).map((r) => [r.transaction_id, r.balance])).toEqual([
      ['c', 900.1],
      ['b', 75],
      ['a', 1200.2],
    ]);
  });
  it('orders two movements on one day by when they were recorded, then by id', () => {
    const rows = [
      txn({ transaction_id: 'z', created_at: '2026-10-05T01:00:00Z', amount: 10 }),
      txn({ transaction_id: 'b', created_at: '2026-10-05T03:00:00Z', direction: 'out', amount: 4 }),
      txn({ transaction_id: 'a', created_at: '2026-10-05T03:00:00Z', amount: 1 }),
    ];
    expect(withRunningBalance([account('bank')], rows).map((r) => [r.transaction_id, r.balance])).toEqual([
      ['b', 7],
      ['a', 11],
      ['z', 10],
    ]);
  });
  it('orders two movements recorded in the same second by their fractions, not by how the text sorts', () => {
    const rows = [
      txn({ transaction_id: 'b', created_at: '2026-10-05T03:00:00.5+00:00', direction: 'out', amount: 4 }),
      txn({ transaction_id: 'a', created_at: '2026-10-05T03:00:00+00:00', amount: 10 }),
    ];
    expect(withRunningBalance([account('bank')], rows).map((r) => [r.transaction_id, r.balance])).toEqual([
      ['b', 6],
      ['a', 10],
    ]);
  });
  it('lets a balance go below nothing', () => {
    const rows = [txn({ transaction_id: 'a', amount: 30 }), txn({ transaction_id: 'b', txn_date: '2026-10-06', direction: 'out', amount: 100 })];
    expect(withRunningBalance([account('bank', { opening_balance: 20 })], rows).map((r) => [r.transaction_id, r.balance])).toEqual([
      ['b', -50],
      ['a', 50],
    ]);
  });
  it('leaves out everything that is not posted, and does not drift on sen', () => {
    const rows = [
      txn({ amount: 0.1 }),
      txn({ amount: 0.2 }),
      txn({ status: 'void', amount: 999 }),
      txn({ status: 'scheduled', direction: 'out', amount: 999 }),
      txn({ status: 'draft', amount: 999 }),
      txn({ status: 'pending_approval', direction: 'out', amount: 999 }),
    ];
    const ledger = withRunningBalance([account('bank')], rows);
    expect(ledger).toHaveLength(2);
    expect(ledger[0].balance).toBe(0.3);
  });
  it('starts an account it was not told about from nothing', () => {
    expect(withRunningBalance([], [txn({ amount: 5 })])[0].balance).toBe(5);
  });
  it('counts a transfer on both of its accounts, so the total does not move', () => {
    const accounts = [account('bank', { opening_balance: 500 }), account('savings')];
    const rows = [
      txn({ kind: 'transfer', direction: 'out', amount: 200, transfer_id: 'x' }),
      txn({ kind: 'transfer', direction: 'in', amount: 200, transfer_id: 'x', account_id: 'savings', account_name: 'Savings' }),
    ];
    const ledger = withRunningBalance(accounts, rows);
    expect(ledger.map((r) => r.balance).sort((x, y) => x - y)).toEqual([200, 300]);
    expect(rows.reduce((total, r) => total + signedAmount(r), 0)).toBe(0);
  });
});

describe('bankingView', () => {
  const accounts = [
    account('bank', { balance: 12000, to_be_paid: 960, last_import_at: '2026-10-07T03:00:00Z', unmatched_lines: 2 }),
    account('savings', { balance: 3000 }),
    account('till', { balance: 500.5 }),
    account('old', { name: 'Old account', active: false, balance: 0 }),
  ];
  const rows = [
    txn({ txn_date: '2026-10-08', amount: 2000, reconciled: false }),
    txn({ txn_date: '2026-10-02', direction: 'out', amount: 500, reconciled: true }),
    txn({ txn_date: '2026-10-01', amount: 40, account_id: 'till', account_kind: 'cash' }),
    txn({ txn_date: '2026-09-30', amount: 1000, reconciled: true }),
    txn({ txn_date: '2026-08-15', direction: 'out', amount: 4000 }),
    txn({ txn_date: '2026-10-09', status: 'scheduled', direction: 'out', amount: 960 }),
    txn({ txn_date: '2026-10-09', status: 'void', amount: 77 }),
  ];
  const view = bankingView(accounts, rows, TODAY);

  it('adds every account up and says what is to be paid', () => {
    expect(view.total).toEqual({ label: 'Total cash', value: 'RM 15,500.50', delta: 'RM 960.00 to be paid', deltaTone: 'flat' });
    expect(bankingView([account('bank', { balance: 10 })], [], TODAY).total.delta).toBe('1 account');
  });
  it('gives a tile to each active account, and to an archived one only while it holds money', () => {
    expect(view.tiles).toEqual([
      { id: 'bank', name: 'Main Bank', kind: 'bank', balance: 'RM 12,000.00', note: 'Last import 07 Oct 2026 · 2 to match' },
      { id: 'savings', name: 'Savings', kind: 'bank', balance: 'RM 3,000.00', note: 'No statement yet' },
      { id: 'till', name: 'Cash in hand', kind: 'cash', balance: 'RM 500.50', note: 'Cash account' },
    ]);
    const kept = bankingView([account('old', { active: false, balance: 12, last_import_at: '2026-01-02T00:00:00Z' })], [], TODAY);
    expect(kept.tiles).toEqual([{ id: 'old', name: 'Savings', kind: 'bank', balance: 'RM 12.00', note: 'Last import 02 Jan 2026' }]);
  });
  it('draws the total at the end of each of the last eight months by taking later movements back out', () => {
    expect(view.trend.map((m) => m.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    // Today 15,500.50. October moved +2000 -500 +40 = +1540: September ended on 13,960.50.
    // September moved +1000: August ended on 12,960.50. August moved -4000: July ended on 16,960.50.
    expect(view.trend.map((m) => m.balance)).toEqual([17, 17, 17, 17, 17, 13, 14, 15.5]);
    expect(view.hasTrend).toBe(true);
  });
  it('has nothing to draw for accounts with no opening balance and no posted movement', () => {
    expect(bankingView([account('bank')], [txn({ status: 'draft' })], TODAY).hasTrend).toBe(false);
    expect(bankingView([account('bank', { opening_balance: 5, balance: 5 })], [], TODAY).hasTrend).toBe(true);
  });
  it('counts how many of this month\'s posted bank movements are reconciled, leaving cash out', () => {
    expect(view.gauge).toEqual({ percent: 50, label: '1 of 2 Oct movements', reconciled: 1, total: 2 });
    expect(view.hasGauge).toBe(true);
    const none = bankingView(accounts, rows.filter((r) => r.account_kind === 'cash'), TODAY);
    expect(none.gauge).toEqual({ percent: 0, label: '0 of 0 Oct movements', reconciled: 0, total: 0 });
    expect(none.hasGauge).toBe(false);
    expect(none.gaugeEmpty).toBe('No bank movements this month to reconcile.');
    expect(bankingView(accounts, [txn({ txn_date: '2026-10-01', reconciled: true })], TODAY).gauge.label).toBe('1 of 1 Oct movement');
  });
});

describe('the reconciliation gauge', () => {
  const bank = account('bank', { last_import_at: '2026-10-07T03:00:00Z' });
  const month = (n: number, matched: number) =>
    Array.from({ length: n }, (_, i) => txn({ txn_date: '2026-10-03', reconciled: i < matched }));
  it('is never 100 while something is unmatched, and never 0 while something is matched', () => {
    expect(bankingView([bank], month(200, 199), TODAY).gauge.percent).toBe(99);
    expect(bankingView([bank], month(201, 1), TODAY).gauge.percent).toBe(1);
    expect(bankingView([bank], month(5, 0), TODAY).gauge.percent).toBe(0);
    expect(bankingView([bank], month(5, 5), TODAY).gauge.percent).toBe(100);
    expect(bankingView([bank], month(3, 1), TODAY).gauge.percent).toBe(33);
  });
  it('leaves out an account that has never had a statement imported, and says so when none has', () => {
    const never = account('savings');
    const rows = [...month(2, 1), txn({ account_id: 'savings', account_name: 'Savings', txn_date: '2026-10-04' })];
    expect(bankingView([bank, never], rows, TODAY).gauge).toEqual({ percent: 50, label: '1 of 2 Oct movements', reconciled: 1, total: 2 });
    const noImport = bankingView([never, account('bank')], rows, TODAY);
    expect(noImport.hasGauge).toBe(false);
    expect(noImport.gauge.label).toBe('');
    expect(noImport.gaugeEmpty).toBe('No statement imported yet.');
  });
});

describe('reconcileLabel and filterLedger', () => {
  const rows = withRunningBalance(
    [account('bank', { last_import_at: '2026-10-07T03:00:00Z' }), account('till'), account('savings')],
    [
      txn({ transaction_id: 'r', reconciled: true, number: 'RC-0007', reference: 'IBG 5521' }),
      txn({ transaction_id: 'u', party_name: 'Zaki Enterprise' }),
      txn({ transaction_id: 'c', account_id: 'till', account_name: 'Cash in hand', account_kind: 'cash', reconciled: true }),
      txn({ transaction_id: 'n', account_id: 'savings', account_name: 'Savings', party_name: 'Never Imported' }),
    ],
  );
  const ids = (found: { transaction_id: string }[]) => found.map((r) => r.transaction_id).sort();
  it('gives a cash movement, and a movement on an account with no statement imported, no status', () => {
    expect(rows.map((r) => [r.transaction_id, reconcileLabel(r)]).sort()).toEqual([
      ['c', null],
      ['n', null],
      ['r', 'Reconciled'],
      ['u', 'Unreconciled'],
    ]);
  });
  it('filters by account, by status and by text', () => {
    expect(ids(filterLedger(rows, ''))).toEqual(['c', 'n', 'r', 'u']);
    expect(ids(filterLedger(rows, '', 'till'))).toEqual(['c']);
    expect(ids(filterLedger(rows, '', 'all', 'reconciled'))).toEqual(['r']);
    expect(ids(filterLedger(rows, '', 'all', 'unreconciled'))).toEqual(['u']);
    expect(ids(filterLedger(rows, '  zaki '))).toEqual(['u']);
    expect(ids(filterLedger(rows, 'rc-0007'))).toEqual(['r']);
    expect(ids(filterLedger(rows, 'ibg 55'))).toEqual(['r']);
    expect(ids(filterLedger(rows, 'cash in hand'))).toEqual(['c']);
    expect(ids(filterLedger(rows, 'nothing like this'))).toEqual([]);
  });
  it('lists a movement with no status under neither Reconciled nor Unreconciled', () => {
    expect(ids(filterLedger(rows, '', 'savings', 'unreconciled'))).toEqual([]);
    expect(ids(filterLedger(rows, '', 'till', 'reconciled'))).toEqual([]);
  });
  it('applies an account and a status together', () => {
    expect(ids(filterLedger(rows, '', 'bank', 'unreconciled'))).toEqual(['u']);
    expect(ids(filterLedger(rows, '', 'bank', 'reconciled'))).toEqual(['r']);
    expect(ids(filterLedger(rows, 'zaki', 'bank', 'reconciled'))).toEqual([]);
  });
});

describe('bankingCsv', () => {
  it('writes the table with amounts as numbers, in the column they belong to', () => {
    const ledger = withRunningBalance(
      [account('bank', { opening_balance: 100, last_import_at: '2026-10-07T03:00:00Z' })],
      [txn({ direction: 'out', amount: 25, number: 'PV-0003', kind: 'other', party_name: 'Maybank', documents: null, category_name: 'Bank charges' })],
    );
    expect(bankingCsv(ledger)).toBe(
      `${CSV_BOM}Date,No.,Description,Account,Method,Reference,Money In,Money Out,Account balance,Status\r\n` +
        '2026-10-05,PV-0003,Maybank · Bank charges,Main Bank,FPX,,,25,75,Unreconciled\r\n',
    );
  });
});

describe('the sample shown when there is no database', () => {
  it('is every sample receipt and voucher once, and three transfers of two sides each', () => {
    const ids = SAMPLE_BANK_TRANSACTIONS.map((t) => t.transaction_id);
    expect(new Set(ids).size).toBe(ids.length);
    const transfers = SAMPLE_BANK_TRANSACTIONS.filter((t) => t.kind === 'transfer');
    expect(transfers).toHaveLength(6);
    expect(SAMPLE_BANK_TRANSACTIONS.length - transfers.length).toBe(SAMPLE_CASH_RECEIPTS.length + SAMPLE_PAYMENT_VOUCHERS.length);
    for (const receipt of SAMPLE_CASH_RECEIPTS) {
      expect(SAMPLE_BANK_TRANSACTIONS.find((t) => t.transaction_id === receipt.transaction_id)).toMatchObject({
        direction: 'in', amount: receipt.amount, status: receipt.status,
      });
    }
    for (const voucher of SAMPLE_PAYMENT_VOUCHERS) {
      expect(SAMPLE_BANK_TRANSACTIONS.find((t) => t.transaction_id === voucher.transaction_id)).toMatchObject({
        direction: 'out', amount: voucher.amount, status: voucher.status,
      });
    }
    expect(transfers.reduce((total, t) => total + signedAmount(t), 0)).toBe(0);
  });
  it('gives each account the balance its movements run to, and none is overdrawn', () => {
    const ledger = withRunningBalance(SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS);
    for (const a of SAMPLE_BANK_ACCOUNTS) {
      const newest = ledger.find((r) => r.account_id === a.id);
      expect(newest?.balance, a.name).toBe(a.balance);
      expect(a.balance, a.name).toBeGreaterThan(0);
    }
  });
  it('has something on every card', () => {
    const view = bankingView(SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS, SAMPLE_TODAY);
    expect(view.tiles).toHaveLength(3);
    expect(view.hasTrend).toBe(true);
    expect(view.hasGauge).toBe(true);
    expect(view.gauge.reconciled).toBeGreaterThan(0);
    expect(view.gauge.reconciled).toBeLessThan(view.gauge.total);
    expect(view.total.delta).toMatch(/to be paid$/);
  });
});

describe('Banking with an account in another currency (stage 5a)', () => {
  // Maybank RM 1,000.00 and a USD account of USD 10,000.00 opened at 4.4620 (RM 44,620.00): the plan's Review Focus 4.
  const maybank = account('bank', { opening_balance: 1000, balance: 1000 });
  const usd = account('usd', {
    name: 'USD Current', currency: 'USD', opening_balance: 10000, balance: 10000, opening_rate_text: '4.4620000000',
    opening_rate_source: 'bnm', opening_rate_date: '2026-10-16', opening_balance_myr: 44620, balance_myr: 44620,
  });

  it('adds ringgit for Total cash, never the currency balance', () => {
    expect(bankingView([maybank, usd], [], TODAY).total.value).toBe('RM 45,620.00');
  });

  it('shows the tile in its own currency, with its ringgit book value beneath', () => {
    const tile = bankingView([maybank, usd], [], TODAY).tiles.find((t) => t.id === 'usd')!;
    expect(tile.balance).toBe('USD 10,000.00');
    expect(tile.note).toBe('≈ RM 44,620.00 · No statement yet');
    expect(bankingView([maybank, usd], [], TODAY).tiles.find((t) => t.id === 'bank')!).toMatchObject({ balance: 'RM 1,000.00', note: 'No statement yet' });
  });

  it('takes the trend back in ringgit: a later movement on a foreign account comes off at its ringgit', () => {
    // A movement in USD the database would one day post (stage 5b): USD 100.00 in at 4.4620, RM 446.20, dated this month.
    const later = txn({ account_id: 'usd', currency: 'USD', amount: 100, amount_myr: 446.2, txn_date: '2026-10-05' });
    expect(signedRinggit(later)).toBe(446.2);
    expect(signedRinggit({ ...later, direction: 'out' })).toBe(-446.2);
    const withIt = { ...usd, balance: 10100, balance_myr: 45066.2 };
    const trend = bankingView([maybank, withIt], [later], TODAY).trend;
    // September's end: RM 46,066.20 now, less the RM 446.20 that arrived in October.
    expect(trend[trend.length - 2].balance).toBe(45.6);
    expect(trend[trend.length - 1].balance).toBe(46.1);
  });

  it('a ringgit-only workspace reads as it always did: the CSV has no Currency column', () => {
    const ledger = withRunningBalance([maybank], [txn({ amount: 50 })]);
    expect(bankingCsv(ledger)).not.toContain('Currency');
    const foreign = withRunningBalance([usd], [txn({ account_id: 'usd', currency: 'USD', amount: 100, amount_myr: 446.2 })]);
    expect(bankingCsv(foreign).split('\n')[0]).toContain('Currency,Ringgit');
  });
});
