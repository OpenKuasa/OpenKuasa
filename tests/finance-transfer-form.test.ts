import { describe, expect, it } from 'vitest';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import {
  bankRowActions,
  canTransfer,
  newTransferForm,
  recordedTransfer,
  transferAccounts,
  transferEnds,
  transferFormError,
  transferName,
  transferOverdrawNote,
  transferPayload,
  transferRecordedNote,
  transferToOptions,
  transferVoidedNote,
  voidTransferEffect,
  withTransferFrom,
} from '@/lib/finance/transfer-form';
import { recordTransferInput } from '@/lib/finance/transfers';

const MAIN = '11111111-1111-4111-8111-111111111111';
const SAVINGS = '22222222-2222-4222-8222-222222222222';
const TILL = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const TRANSFER = '55555555-5555-4555-8555-555555555555';

const account = (id: string, name: string, balance: number, over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id, name, kind: 'bank', bank_name: null, opening_balance: 0, opening_date: '2026-01-01', active: true, balance,
  to_be_paid: 0, last_import_at: null, unmatched_lines: 0, ...over,
});
const ACCOUNTS = [account(MAIN, 'Main Bank', 300), account(SAVINGS, 'Savings', 0), account(OLD, 'Old', 50, { active: false }), account(TILL, 'Cash in hand', -20, { kind: 'cash' })];

const side = (direction: 'in' | 'out', over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  transaction_id: direction === 'out' ? 'out-1' : 'in-1',
  account_id: direction === 'out' ? MAIN : SAVINGS,
  account_name: direction === 'out' ? 'Main Bank' : 'Savings',
  account_kind: 'bank', direction, txn_date: '2026-10-01', amount: 500, status: 'posted', number: 'TR-0004', method: 'bank_transfer',
  reference: null, notes: null, party_name: null, kind: 'transfer', category_name: null, documents: null, transfer_id: TRANSFER,
  other_account_name: direction === 'out' ? 'Savings' : 'Main Bank', reconciled: false, created_at: '2026-10-01T02:00:00Z', ...over,
});

describe('the accounts a transfer can use', () => {
  it('are the active ones, in the order given, and a transfer needs two', () => {
    expect(transferAccounts(ACCOUNTS).map((a) => a.name)).toEqual(['Main Bank', 'Savings', 'Cash in hand']);
    expect(canTransfer(ACCOUNTS)).toBe(true);
    expect(canTransfer([account(MAIN, 'Main Bank', 1), account(OLD, 'Old', 1, { active: false })])).toBe(false);
    expect(canTransfer([])).toBe(false);
  });
  it('“To” leaves out the account chosen in “From”, and choosing that account in “From” clears “To”', () => {
    expect(transferToOptions(ACCOUNTS, MAIN).map((a) => a.name)).toEqual(['Savings', 'Cash in hand']);
    expect(transferToOptions(ACCOUNTS, '').map((a) => a.name)).toEqual(['Main Bank', 'Savings', 'Cash in hand']);
    const form = { ...newTransferForm('2026-10-12'), from: MAIN, to: SAVINGS };
    expect(withTransferFrom(form, SAVINGS)).toMatchObject({ from: SAVINGS, to: '' });
    expect(withTransferFrom(form, TILL)).toMatchObject({ from: TILL, to: SAVINGS });
  });
});

describe('the form', () => {
  const filled = { from: MAIN, to: SAVINGS, amount: '500', date: '2026-10-12', reference: ' TT-9 ', notes: '' };

  it('starts with nothing chosen, dated the person’s own date', () => {
    expect(newTransferForm('2026-10-12')).toEqual({ from: '', to: '', amount: '', date: '2026-10-12', reference: '', notes: '' });
  });
  it('sends what the schema takes', () => {
    expect(transferPayload(filled)).toEqual({ from_account_id: MAIN, to_account_id: SAVINGS, amount: 500, txn_date: '2026-10-12', reference: ' TT-9 ', notes: '' });
    expect(recordTransferInput.parse(transferPayload(filled))).toMatchObject({ amount: 500, reference: 'TT-9', notes: null });
    expect(transferFormError(filled)).toBeNull();
  });
  it('names the first thing wrong, in order: from, to, amount, date', () => {
    expect(transferFormError({ ...filled, from: '', to: '', amount: '' })).toBe('Choose the account the money leaves.');
    expect(transferFormError({ ...filled, to: '', amount: '' })).toBe('Choose the account the money goes to.');
    expect(transferFormError({ ...filled, to: MAIN })).toBe('Choose two different accounts.');
    for (const amount of ['', '0', '-5', '1,500', 'abc', '0.004']) {
      expect(transferFormError({ ...filled, amount }), amount).toBe('Enter an amount above 0.');
    }
    expect(transferFormError({ ...filled, date: '' })).toBe('Enter a valid date.');
  });
  it('reads a typed comma as not a number, never as some other number', () => {
    expect(Number.isNaN(transferPayload({ ...filled, amount: '1,500' }).amount)).toBe(true);
  });
});

describe('a transfer for more than the account holds', () => {
  const form = (from: string, amount: string) => ({ ...newTransferForm('2026-10-12'), from, amount });

  it('says what it leaves the account at, and is silent when the account covers it', () => {
    expect(transferOverdrawNote(form(MAIN, '500'), ACCOUNTS)).toBe('Main Bank holds RM 300.00. This transfer leaves it overdrawn by RM 200.00.');
    expect(transferOverdrawNote(form(MAIN, '300'), ACCOUNTS)).toBeNull();
    expect(transferOverdrawNote(form(MAIN, '300.004'), ACCOUNTS)).toBeNull();
    expect(transferOverdrawNote(form(SAVINGS, '0.01'), ACCOUNTS)).toBe('Savings holds RM 0.00. This transfer leaves it overdrawn by RM 0.01.');
  });
  it('says so differently for an account that is already overdrawn', () => {
    expect(transferOverdrawNote(form(TILL, '30'), ACCOUNTS)).toBe('Cash in hand is already overdrawn by RM 20.00. This transfer takes that to RM 50.00.');
  });
  it('says nothing while there is no account or no amount above 0', () => {
    for (const f of [form('', '500'), form(MAIN, ''), form(MAIN, '1,500'), form(MAIN, '0'), form(MAIN, '-1'), form('gone', '5')]) {
      expect(transferOverdrawNote(f, ACCOUNTS)).toBeNull();
    }
  });
});

describe('a transfer in the Transactions table', () => {
  it('is named the same from either side', () => {
    expect(transferEnds(side('out'))).toEqual({ from: 'Main Bank', to: 'Savings' });
    expect(transferEnds(side('in'))).toEqual({ from: 'Main Bank', to: 'Savings' });
    expect(transferName(side('in'))).toBe('TR-0004 of RM 500.00 from Main Bank to Savings');
    expect(transferName(side('out', { other_account_name: null, number: null }))).toBe('the transfer of RM 500.00 from Main Bank to another account');
  });
  it('offers Void transfer to someone who may sign off, on a side of a transfer only', () => {
    expect(bankRowActions(side('out'), true)).toEqual(['void-transfer']);
    expect(bankRowActions(side('in'), true)).toEqual(['void-transfer']);
    expect(bankRowActions(side('out'), false)).toEqual([]);
    expect(bankRowActions({ kind: 'transfer', transfer_id: null }, true)).toEqual([]);
    for (const kind of ['invoice', 'income', 'bill', 'refund', 'expense', 'other'] as const) {
      expect(bankRowActions({ kind, transfer_id: null }, true), kind).toEqual([]);
    }
  });
  it('says what voiding does, and that a matched statement line is unmatched', () => {
    const plain = 'Both sides are voided: RM 500.00 goes back into Main Bank and comes out of Savings. It keeps its number, and this cannot be undone.';
    expect(voidTransferEffect(side('in'), [side('in'), side('out')])).toBe(plain);
    expect(voidTransferEffect(side('in'), [side('in'), side('out', { reconciled: true })])).toBe(
      `${plain} A statement line is matched to it; that line goes back to unmatched.`,
    );
    expect(voidTransferEffect(side('out', { reconciled: true }), [side('in', { reconciled: true }), side('out', { reconciled: true })])).toBe(
      `${plain} Statement lines are matched to both sides; they go back to unmatched.`,
    );
    // Another transfer's matched line is not this one's.
    expect(voidTransferEffect(side('in'), [side('in'), side('out'), side('out', { transfer_id: 'other', reconciled: true })])).toBe(plain);
  });
  it('says what was voided and that it has left the table', () => {
    expect(transferVoidedNote(side('out'))).toBe(
      'Transfer TR-0004 of RM 500.00 from Main Bank to Savings is voided: RM 500.00 is back in Main Bank and out of Savings. A voided transfer is not listed in the table below.',
    );
  });
});

describe('what the screen says after a transfer was recorded', () => {
  const form = { from: MAIN, to: TILL, amount: '120.505', date: '2026-10-12', reference: '', notes: '' };
  const written = recordedTransfer(form, ACCOUNTS, { transfer_id: TRANSFER, number: 'TR-0005' });
  const first = 'Transfer TR-0005 is recorded: RM 120.51 from Main Bank to Cash in hand, dated 12 Oct 2026.';

  it('remembers the transfer in the accounts’ own names and the amount as it was stored', () => {
    expect(written).toEqual({ transferId: TRANSFER, number: 'TR-0005', amount: 120.51, date: '2026-10-12', from: 'Main Bank', to: 'Cash in hand' });
    expect(recordedTransfer({ ...form, to: 'gone' }, ACCOUNTS, { transfer_id: TRANSFER, number: null }).to).toBe('another account');
  });
  it('says where both sides are when both are on screen', () => {
    expect(transferRecordedNote(written, 2, 2)).toBe(`${first} Both sides are in the table below.`);
  });
  it('does not point at the table before the page has refreshed', () => {
    expect(transferRecordedNote(written, 0, 0)).toBe(`${first} Both balances have changed.`);
  });
  it('says how to see a side that the search, a filter or the ten-row limit hides', () => {
    expect(transferRecordedNote(written, 1, 2)).toBe(
      `${first} One side is in the table below; clear the search and the filters, or choose View all, to see the other.`,
    );
    expect(transferRecordedNote(written, 0, 2)).toBe(
      `${first} Clear the search and the filters, or choose View all, to see its two sides in the table below.`,
    );
  });
  it('still reads as a sentence when the number could not be read back', () => {
    expect(transferRecordedNote({ ...written, number: null }, 2, 2)).toBe(
      'The transfer is recorded: RM 120.51 from Main Bank to Cash in hand, dated 12 Oct 2026. Both sides are in the table below.',
    );
  });
});
