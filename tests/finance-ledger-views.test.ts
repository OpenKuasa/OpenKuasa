import { describe, expect, it } from 'vitest';
import type { JournalRow, LedgerAccount, LedgerLine, LedgerSource } from '@/lib/finance/ledger';
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPE_ORDER,
  SOURCE_LABELS,
  SOURCE_PATHS,
  STANDS_FOR_LABELS,
  accountActions,
  accountFromParam,
  accountsCsv,
  entriesCsv,
  filterEntries,
  groupAccounts,
  groupEntries,
  journalActions,
  toolbarError,
  trialBalance,
} from '@/lib/finance/ledger-views';

const account = (code: string, extra: Partial<LedgerAccount> = {}): LedgerAccount => ({
  id: `acc-${code}`, code, name: `Account ${code}`, type: 'asset', active: true, stands_for: 'own', system_key: null,
  bank_account_id: null, category_id: null, default_for: null, debit_total: 0, credit_total: 0, balance: 0, ...extra,
});

const line = (extra: Partial<LedgerLine> = {}): LedgerLine => ({
  entry_key: 'invoice:i1', entry_date: '2026-10-01', source: 'invoice', source_id: 'i1', source_no: 'INV-0001',
  description: 'Invoice INV-0001', account_id: 'acc-1100', debit: 0, credit: 0, ...extra,
});

describe('the words', () => {
  it('label the five kinds of account, in the order books list them', () => {
    expect(ACCOUNT_TYPE_ORDER).toEqual(['asset', 'liability', 'equity', 'income', 'expense']);
    expect(ACCOUNT_TYPE_LABELS).toEqual({ asset: 'Asset', liability: 'Liability', equity: 'Equity', income: 'Income', expense: 'Expense' });
  });
  it('say what an account stands for', () => {
    expect(STANDS_FOR_LABELS).toEqual({ system: 'System', bank: 'Bank or cash account', category: 'Category', own: 'Added by you' });
  });
  it('name every source and send the person to the screen it came from', () => {
    expect(SOURCE_LABELS).toEqual({
      invoice: 'Invoice', credit_note: 'Credit note', payment_in: 'Receipt', refund: 'Refund', bill: 'Supplier bill',
      payment_out: 'Payment', expense: 'Expense', transfer: 'Transfer', opening: 'Opening balance', journal: 'Manual journal',
    });
    expect(SOURCE_PATHS).toEqual({
      invoice: '/finance/invoices', credit_note: '/finance/credit-notes', payment_in: '/finance/cash-receipts', refund: '/finance/refunds',
      bill: '/finance/supplier-bills', payment_out: '/finance/payment-vouchers', expense: '/finance/expenses', transfer: '/finance/banking',
      opening: '/finance/banking', journal: null,
    });
  });
});

describe('what an account row offers', () => {
  it('nothing without the sign-off', () => {
    expect(accountActions(account('1'), false)).toEqual([]);
  });
  it('edit and archive for an account that stands for something, delete too for the workspace’s own', () => {
    expect(accountActions(account('1', { stands_for: 'bank' }), true)).toEqual(['edit', 'archive']);
    expect(accountActions(account('1', { stands_for: 'category' }), true)).toEqual(['edit', 'archive']);
    expect(accountActions(account('1', { stands_for: 'system' }), true)).toEqual(['edit', 'archive']);
    expect(accountActions(account('1', { stands_for: 'own' }), true)).toEqual(['edit', 'archive', 'delete']);
  });
  it('unarchive for an archived account', () => {
    expect(accountActions(account('1', { active: false, stands_for: 'bank' }), true)).toEqual(['edit', 'unarchive']);
    expect(accountActions(account('1', { active: false }), true)).toEqual(['edit', 'unarchive', 'delete']);
  });
});

describe('groupAccounts', () => {
  it('groups by kind in book order, each with its balances added up, keeping the order given within a kind', () => {
    const groups = groupAccounts([
      account('5000', { type: 'expense', balance: 40.1 }),
      account('1000', { balance: 100.2 }),
      account('1100', { balance: 10.1 }),
      account('2000', { type: 'liability', balance: -5 }),
    ]);
    expect(groups.map((g) => [g.type, g.label, g.accounts.map((a) => a.code), g.total])).toEqual([
      ['asset', 'Asset', ['1000', '1100'], 110.3],
      ['liability', 'Liability', ['2000'], -5],
      ['expense', 'Expense', ['5000'], 40.1],
    ]);
  });
  it('has no group for a kind with no accounts', () => {
    expect(groupAccounts([])).toEqual([]);
  });
});

describe('trialBalance', () => {
  it('adds up the debits and the credits, and says whether they agree', () => {
    expect(trialBalance([account('1', { debit_total: 100.1, credit_total: 0 }), account('2', { debit_total: 0, credit_total: 100.1 })])).toEqual({
      debit: 100.1, credit: 100.1, balanced: true,
    });
    expect(trialBalance([account('1', { debit_total: 100, credit_total: 0 }), account('2', { debit_total: 0, credit_total: 90 })])).toEqual({
      debit: 100, credit: 90, balanced: false,
    });
    expect(trialBalance([])).toEqual({ debit: 0, credit: 0, balanced: true });
  });
  it('is not thrown by sums that are a hair off', () => {
    const rows = [0.1, 0.2].map((n, i) => account(String(i), { debit_total: n }));
    expect(trialBalance([...rows, account('c', { credit_total: 0.3 })])).toEqual({ debit: 0.3, credit: 0.3, balanced: true });
  });
});

describe('groupEntries', () => {
  const accounts = [account('1100', { name: 'Accounts Receivable' }), account('4000', { name: 'Sales', type: 'income' })];

  it('puts an entry’s lines together, debits before credits, with the account’s code and name and the entry’s totals', () => {
    const entries = groupEntries(
      [
        line({ account_id: 'acc-4000', credit: 100 }),
        line({ account_id: 'acc-1100', debit: 100 }),
      ],
      accounts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'invoice:i1', date: '2026-10-01', source: 'invoice', source_id: 'i1', source_no: 'INV-0001',
      description: 'Invoice INV-0001', debit: 100, credit: 100,
    });
    expect(entries[0].lines.map((l) => [l.account_code, l.account_name, l.debit, l.credit])).toEqual([
      ['1100', 'Accounts Receivable', 100, 0],
      ['4000', 'Sales', 0, 100],
    ]);
  });
  it('lists the newest entry first, and keeps entries of one day in key order', () => {
    const entries = groupEntries(
      [
        line({ entry_key: 'bill:b1', entry_date: '2026-10-01', debit: 1 }),
        line({ entry_key: 'invoice:i2', entry_date: '2026-10-05', debit: 2 }),
        line({ entry_key: 'invoice:i1', entry_date: '2026-10-01', debit: 3 }),
      ],
      accounts,
    );
    expect(entries.map((e) => e.key)).toEqual(['invoice:i2', 'bill:b1', 'invoice:i1']);
  });
  it('leaves the account blank for a line with none, or one that is gone', () => {
    const [entry] = groupEntries([line({ account_id: null, debit: 5 }), line({ account_id: 'acc-gone', credit: 5 })], accounts);
    expect(entry.lines.map((l) => [l.account_code, l.account_name])).toEqual([['', ''], ['', '']]);
  });
  it('adds an entry’s sides to the sen', () => {
    const [entry] = groupEntries([line({ debit: 0.1 }), line({ debit: 0.2 }), line({ credit: 0.3 })], accounts);
    expect(entry).toMatchObject({ debit: 0.3, credit: 0.3 });
  });
});

describe('filterEntries', () => {
  const accounts = [account('1100', { name: 'Accounts Receivable' }), account('4000', { name: 'Sales', type: 'income' }), account('5100', { name: 'Utilities' })];
  const entries = groupEntries(
    [
      line({ entry_key: 'invoice:i1', entry_date: '2026-10-01', source_no: 'INV-0001', description: 'Invoice INV-0001 for Lim', account_id: 'acc-1100', debit: 100 }),
      line({ entry_key: 'invoice:i1', entry_date: '2026-10-01', source_no: 'INV-0001', description: 'Invoice INV-0001 for Lim', account_id: 'acc-4000', credit: 100 }),
      line({ entry_key: 'bill:b1', entry_date: '2026-10-10', source: 'bill', source_id: 'b1', source_no: 'BILL-0001', description: 'Bill from TNB', account_id: 'acc-5100', debit: 50 }),
      line({ entry_key: 'bill:b1', entry_date: '2026-10-10', source: 'bill', source_id: 'b1', source_no: 'BILL-0001', description: 'Bill from TNB', account_id: 'acc-1100', credit: 50 }),
    ],
    accounts,
  );
  const open = { query: '', source: 'all' as 'all' | LedgerSource, from: '', to: '', account: '' };

  it('keeps everything for an open filter', () => {
    expect(filterEntries(entries, open)).toHaveLength(2);
  });
  it('matches the number, the description, and the code or name of any account on a line', () => {
    expect(filterEntries(entries, { ...open, query: 'inv-0001' }).map((e) => e.key)).toEqual(['invoice:i1']);
    expect(filterEntries(entries, { ...open, query: 'tnb' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, query: '5100' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, query: ' utilities ' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, query: 'sales' }).map((e) => e.key)).toEqual(['invoice:i1']);
    expect(filterEntries(entries, { ...open, query: 'nothing' })).toEqual([]);
  });
  it('filters by source', () => {
    expect(filterEntries(entries, { ...open, source: 'bill' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, source: 'journal' })).toEqual([]);
  });
  it('filters by date, both ends included', () => {
    expect(filterEntries(entries, { ...open, from: '2026-10-02' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, to: '2026-10-01' }).map((e) => e.key)).toEqual(['invoice:i1']);
    expect(filterEntries(entries, { ...open, from: '2026-10-01', to: '2026-10-10' })).toHaveLength(2);
  });
  it('filters by an account on any line', () => {
    expect(filterEntries(entries, { ...open, account: 'acc-1100' })).toHaveLength(2);
    expect(filterEntries(entries, { ...open, account: 'acc-5100' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, account: 'all' })).toHaveLength(2);
  });
  it('wants every condition at once', () => {
    expect(filterEntries(entries, { ...open, account: 'acc-1100', source: 'bill', query: 'tnb' }).map((e) => e.key)).toEqual(['bill:b1']);
    expect(filterEntries(entries, { ...open, account: 'acc-4000', source: 'bill' })).toEqual([]);
  });
});

describe('what a journal row offers', () => {
  const journal = (extra: Partial<JournalRow> = {}): JournalRow => ({
    id: 'j1', journal_no: null, journal_date: '2026-10-01', description: 'Capital', status: 'draft', reverses_journal_id: null, reversed: false, ...extra,
  });
  it('nothing without the sign-off', () => {
    expect(journalActions(journal(), false)).toEqual([]);
    expect(journalActions(journal({ status: 'posted' }), false)).toEqual([]);
  });
  it('edit, post and delete for a draft', () => {
    expect(journalActions(journal(), true)).toEqual(['edit', 'post', 'delete']);
  });
  it('reverse for a posted journal that has no reversal', () => {
    expect(journalActions(journal({ status: 'posted', journal_no: 'JV-0001' }), true)).toEqual(['reverse']);
  });
  it('nothing for a posted journal that has been reversed', () => {
    expect(journalActions(journal({ status: 'posted', journal_no: 'JV-0001', reversed: true }), true)).toEqual([]);
  });
});

describe('CSV export', () => {
  it('writes one row per ledger line, with the amounts as numbers and a formula-looking description made harmless', () => {
    const accounts = [account('1100', { name: 'Accounts Receivable' }), account('4000', { name: 'Sales, net', type: 'income' })];
    const csv = entriesCsv(
      groupEntries(
        [
          line({ description: '=cmd|calc', account_id: 'acc-1100', debit: 106.5 }),
          line({ description: '=cmd|calc', account_id: 'acc-4000', credit: 106.5 }),
          line({ entry_key: 'journal:j1', entry_date: '2026-09-30', source: 'journal', source_id: 'j1', source_no: null, description: 'Capital', account_id: 'acc-1100', debit: 5 }),
        ],
        accounts,
      ),
    );
    expect(csv).toBe(
      '﻿Date,No.,Source,Description,Account code,Account name,Debit,Credit\r\n' +
        "2026-10-01,INV-0001,Invoice,'=cmd|calc,1100,Accounts Receivable,106.5,0\r\n" +
        "2026-10-01,INV-0001,Invoice,'=cmd|calc,4000,\"Sales, net\",0,106.5\r\n" +
        '2026-09-30,,Manual journal,Capital,1100,Accounts Receivable,5,0\r\n',
    );
  });
  it('writes the accounts as they stand', () => {
    const csv = accountsCsv([
      account('1000', { name: 'Main Bank', stands_for: 'bank', debit_total: 150.5, credit_total: 50.25, balance: 100.25 }),
      account('1500', { name: 'Old van', active: false, debit_total: 0, credit_total: 0, balance: 0 }),
    ]);
    expect(csv).toBe(
      '﻿Code,Name,Type,Stands for,Status,Debit,Credit,Balance\r\n' +
        '1000,Main Bank,Asset,Bank or cash account,Active,150.5,50.25,100.25\r\n' +
        '1500,Old van,Asset,Added by you,Archived,0,0,0\r\n',
    );
  });
});

describe('toolbarError', () => {
  it('shows nothing when there is no error', () => {
    expect(toolbarError(null, false, false)).toBeNull();
    expect(toolbarError(null, true, true)).toBeNull();
  });
  it('shows an error that belongs to no question', () => {
    expect(toolbarError('Nope', false, false)).toBe('Nope');
  });
  it('leaves an error to the question while its row is on screen', () => {
    expect(toolbarError('Nope', true, true)).toBeNull();
  });
  it('shows it in the toolbar once the question’s row is gone after a refresh', () => {
    expect(toolbarError('That journal no longer exists.', true, false)).toBe('That journal no longer exists.');
  });
});

describe('accountFromParam', () => {
  const known = [{ id: 'a1' }, { id: 'a2' }];
  it('is the account named in the address when it is one of the workspace’s', () => {
    expect(accountFromParam('a2', known)).toBe('a2');
  });
  it('is empty for no parameter or an unknown account', () => {
    expect(accountFromParam(null, known)).toBe('');
    expect(accountFromParam('', known)).toBe('');
    expect(accountFromParam('zzz', known)).toBe('');
  });
});
