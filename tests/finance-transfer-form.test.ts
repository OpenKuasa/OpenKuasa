import { describe, expect, it } from 'vitest';
import type { BankAccountRow, BankTransactionRow } from '@/lib/finance/banking';
import { CURRENCY_MESSAGES } from '@/lib/finance/document-currency';
import { transferRateScaled } from '@/lib/finance/fx-settlement';
import {
  bankRowActions,
  canTransfer,
  needsTwoAmounts,
  newTransferForm,
  recordedTransfer,
  transferAccounts,
  transferEnds,
  transferFormError,
  transferName,
  transferOverdrawNote,
  transferPayload,
  transferRateNote,
  transferRecordedNote,
  transferToOptions,
  transferVoidedNote,
  typedSen,
  voidTransferEffect,
  withTransferFrom,
} from '@/lib/finance/transfer-form';
import { TRANSFER_MESSAGES, recordTransfer, recordTransferInput } from '@/lib/finance/transfers';
import { fakeFinance } from './setup/fake-finance';

const MAIN = '11111111-1111-4111-8111-111111111111';
const SAVINGS = '22222222-2222-4222-8222-222222222222';
const TILL = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const TRANSFER = '55555555-5555-4555-8555-555555555555';

const account = (id: string, name: string, balance: number, over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id, name, kind: 'bank', bank_name: null, opening_balance: 0, opening_date: '2026-01-01', active: true, balance,
  to_be_paid: 0, last_import_at: null, unmatched_lines: 0, currency: 'MYR', opening_rate_text: '1.0000000000',
  opening_rate_source: null, opening_rate_date: null, opening_balance_myr: over.opening_balance ?? 0,
  balance_myr: over.balance ?? balance, ...over,
});
const ACCOUNTS = [account(MAIN, 'Main Bank', 300), account(SAVINGS, 'Savings', 0), account(OLD, 'Old', 50, { active: false }), account(TILL, 'Cash in hand', -20, { kind: 'cash' })];

const side = (direction: 'in' | 'out', over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  transaction_id: direction === 'out' ? 'out-1' : 'in-1',
  account_id: direction === 'out' ? MAIN : SAVINGS,
  account_name: direction === 'out' ? 'Main Bank' : 'Savings',
  account_kind: 'bank', direction, txn_date: '2026-10-01', amount: 500, status: 'posted', number: 'TR-0004', method: 'bank_transfer',
  reference: null, notes: null, party_name: null, kind: 'transfer', category_name: null, documents: null, transfer_id: TRANSFER,
  other_account_name: direction === 'out' ? 'Savings' : 'Main Bank', reconciled: false, created_at: '2026-10-01T02:00:00Z',
  currency: 'MYR', fx_rate_text: '1.0000000000', fx_rate_source: null, amount_myr: over.amount ?? 500, other_currency: 'MYR',
  other_amount: over.amount ?? 500, ...over,
});

describe('the accounts a transfer can use', () => {
  it('are the active ones, in the order given, and a transfer needs two', () => {
    expect(transferAccounts(ACCOUNTS).map((a) => a.name)).toEqual(['Main Bank', 'Savings', 'Cash in hand']);
    expect(canTransfer(ACCOUNTS)).toBe(true);
    expect(canTransfer([account(MAIN, 'Main Bank', 1), account(OLD, 'Old', 1, { active: false })])).toBe(false);
    expect(canTransfer([])).toBe(false);
  });
  it('take an account in another currency too (stage 5c); "To" hides other foreign accounts when "From" is foreign', () => {
    const usd = account('66666666-6666-4666-8666-666666666666', 'USD Current', 10000, { currency: 'USD', balance_myr: 44620 });
    const sgd = account('77777777-7777-4777-8777-777777777777', 'SGD Current', 500, { currency: 'SGD', balance_myr: 1700 });
    const all = [...ACCOUNTS, usd, sgd];
    expect(transferAccounts(all).map((a) => a.name)).toEqual(['Main Bank', 'Savings', 'Cash in hand', 'USD Current', 'SGD Current']);
    expect(transferToOptions(all, MAIN).map((a) => a.name)).toEqual(['Savings', 'Cash in hand', 'USD Current', 'SGD Current']);
    expect(transferToOptions(all, usd.id).map((a) => a.name)).toEqual(['Main Bank', 'Savings', 'Cash in hand']);
    expect(canTransfer([account(MAIN, 'Main Bank', 1), usd])).toBe(true);
    // Two accounts in other currencies cannot move money between them (FIN52): no form is offered for them alone.
    expect(canTransfer([usd, sgd])).toBe(false);
    // Choosing a foreign "From" clears a foreign "To"; a ringgit "To" stays.
    const toSgd = { ...newTransferForm('2026-10-12'), from: MAIN, to: sgd.id };
    expect(withTransferFrom(toSgd, usd.id, all)).toMatchObject({ from: usd.id, to: '' });
    expect(withTransferFrom({ ...toSgd, to: SAVINGS }, usd.id, all)).toMatchObject({ from: usd.id, to: SAVINGS });
  });
  it('“To” leaves out the account chosen in “From”, and choosing that account in “From” clears “To”', () => {
    expect(transferToOptions(ACCOUNTS, MAIN).map((a) => a.name)).toEqual(['Savings', 'Cash in hand']);
    expect(transferToOptions(ACCOUNTS, '').map((a) => a.name)).toEqual(['Main Bank', 'Savings', 'Cash in hand']);
    const form = { ...newTransferForm('2026-10-12'), from: MAIN, to: SAVINGS };
    expect(withTransferFrom(form, SAVINGS, ACCOUNTS)).toMatchObject({ from: SAVINGS, to: '' });
    expect(withTransferFrom(form, TILL, ACCOUNTS)).toMatchObject({ from: TILL, to: SAVINGS });
  });
});

describe('the form', () => {
  const filled = { from: MAIN, to: SAVINGS, amount: '500', toAmount: '', date: '2026-10-12', reference: ' TT-9 ', notes: '' };

  it('starts with nothing chosen, dated the person’s own date', () => {
    expect(newTransferForm('2026-10-12')).toEqual({ from: '', to: '', amount: '', toAmount: '', date: '2026-10-12', reference: '', notes: '' });
  });
  it('sends what the schema takes', () => {
    expect(transferPayload(filled, ACCOUNTS)).toEqual({ from_account_id: MAIN, to_account_id: SAVINGS, amount: 500, txn_date: '2026-10-12', reference: ' TT-9 ', notes: '' });
    // Between two ringgit accounts no to_amount is sent, whatever the box holds: the payload is what it always was.
    expect(transferPayload({ ...filled, toAmount: '99' }, ACCOUNTS)).not.toHaveProperty('to_amount');
    expect(recordTransferInput.parse(transferPayload(filled, ACCOUNTS))).toMatchObject({ amount: 500, reference: 'TT-9', notes: null });
    expect(transferFormError(filled, ACCOUNTS)).toBeNull();
  });
  it('names the first thing wrong, in order: from, to, amount, date', () => {
    expect(transferFormError({ ...filled, from: '', to: '', amount: '' }, ACCOUNTS)).toBe('Choose the account the money leaves.');
    expect(transferFormError({ ...filled, to: '', amount: '' }, ACCOUNTS)).toBe('Choose the account the money goes to.');
    expect(transferFormError({ ...filled, to: MAIN }, ACCOUNTS)).toBe('Choose two different accounts.');
    for (const amount of ['', '0', '-5', '1,500', 'abc', '0.004']) {
      expect(transferFormError({ ...filled, amount }, ACCOUNTS), amount).toBe('Enter an amount above 0.');
    }
    expect(transferFormError({ ...filled, date: '' }, ACCOUNTS)).toBe('Enter a valid date.');
  });
  it('reads a typed comma as not a number, never as some other number', () => {
    expect(Number.isNaN(transferPayload({ ...filled, amount: '1,500' }, ACCOUNTS).amount)).toBe(true);
  });
  it('sends, books and notes one figure for three decimals (half up from the text, as the database rounds)', () => {
    const odd = { ...filled, amount: '1.005' };
    expect(transferPayload(odd, ACCOUNTS).amount).toBe(1.01);
    expect(recordTransferInput.parse(transferPayload(odd, ACCOUNTS)).amount).toBe(1.01);
    expect(recordedTransfer(odd, ACCOUNTS, { transfer_id: TRANSFER, number: 'TR-0009' }).amount).toBe(1.01);
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
  const form = { from: MAIN, to: TILL, amount: '120.505', toAmount: '', date: '2026-10-12', reference: '', notes: '' };
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

describe('a transfer with an account in another currency (stage 5c)', () => {
  const MAYBANK = account(MAIN, 'Maybank', 50000);
  const USD = account('66666666-6666-4666-8666-666666666666', 'USD Account', 0, { currency: 'USD' });
  const IDR = account('88888888-8888-4888-8888-888888888888', 'IDR Account', 0, { currency: 'IDR' });
  const JPY = account('99999999-9999-4999-8999-999999999999', 'JPY Account', 0, { currency: 'JPY' });
  const USD_HELD = account('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'USD Reserve', 10000, { currency: 'USD', balance_myr: 44620 });
  const accounts = [MAYBANK, USD, IDR, JPY, USD_HELD];
  const c51 = { ...newTransferForm('2026-10-12'), from: MAIN, to: USD.id, amount: '4462', toAmount: '1000' };

  it('asks for two amounts only when the two currencies differ', () => {
    expect(needsTwoAmounts(c51, accounts)).toBe(true);
    expect(needsTwoAmounts({ from: MAIN, to: SAVINGS }, ACCOUNTS)).toBe(false);
    expect(needsTwoAmounts({ from: MAIN, to: '' }, accounts)).toBe(false);
  });
  it('sends both amounts (C5.1: RM 4,462.00 leaves Maybank, USD 1,000.00 arrives)', () => {
    expect(transferPayload(c51, accounts)).toEqual({
      from_account_id: MAIN, to_account_id: USD.id, amount: 4462, to_amount: 1000, txn_date: '2026-10-12', reference: '', notes: '',
    });
    expect(recordTransferInput.parse(transferPayload(c51, accounts))).toMatchObject({ amount: 4462, to_amount: 1000 });
    expect(transferFormError(c51, accounts)).toBeNull();
  });
  it('asks for what arrived, refuses two foreign accounts, and keeps whole units for a currency with none', () => {
    expect(transferFormError({ ...c51, toAmount: '' }, accounts)).toBe(TRANSFER_MESSAGES.toAmount);
    expect(transferFormError({ ...c51, toAmount: '0' }, accounts)).toBe(TRANSFER_MESSAGES.toAmount);
    expect(transferFormError({ ...c51, toAmount: '1,000' }, accounts)).toBe(TRANSFER_MESSAGES.toAmount);
    expect(transferFormError({ ...c51, from: USD_HELD.id }, accounts)).toBe(TRANSFER_MESSAGES.twoForeign);
    const whole = CURRENCY_MESSAGES.wholeUnits('JPY');
    expect(transferFormError({ ...c51, to: JPY.id, toAmount: '15000.5' }, accounts)).toBe(whole);
    expect(transferFormError({ ...c51, to: JPY.id, toAmount: '15000' }, accounts)).toBeNull();
    expect(transferFormError({ ...c51, from: JPY.id, to: MAIN, amount: '1.5', toAmount: '0.05' }, accounts)).toBe(whole);
  });
  it('shows the rate the two amounts say, to four places, from whole numbers (C5.1, C5.3, RM 1,000.00 for USD 223.71)', () => {
    expect(transferRateNote(c51, accounts)).toBe('RM 4.4620 per 1 USD');
    // The other way: USD 1,000.00 sold for RM 4,380.00 (C5.2).
    expect(transferRateNote({ ...c51, from: USD_HELD.id, to: MAIN, amount: '1000', toAmount: '4380' }, accounts)).toBe('RM 4.3800 per 1 USD');
    // IDR is quoted per 100: 0.0002839506 per one is 0.0284 per 100.
    expect(transferRateNote({ ...c51, to: IDR.id, amount: '1987654.32', toAmount: '7000000000' }, accounts)).toBe('RM 0.0284 per 100 IDR');
    expect(transferRateNote({ ...c51, amount: '1000', toAmount: '223.71' }, accounts)).toBe('RM 4.4701 per 1 USD');
    expect(transferRateNote({ ...c51, toAmount: '' }, accounts)).toBeNull();
    expect(transferRateNote({ ...c51, to: SAVINGS }, [...accounts, account(SAVINGS, 'Savings', 0)])).toBeNull();
    // The database's figure, to ten places: round(ringgit / foreign, 10).
    expect(transferRateScaled(BigInt(446200), BigInt(100000))).toBe(BigInt('44620000000'));
    expect(transferRateScaled(BigInt(198765432), BigInt(700000000000))).toBe(BigInt(2839506));
    expect(transferRateScaled(BigInt(100000), BigInt(22371))).toBe(BigInt('44700728622'));
  });
  it('reads typed amounts in whole sen, half up, as the database rounds', () => {
    expect(typedSen('4462')).toBe(BigInt(446200));
    expect(typedSen('120.505')).toBe(BigInt(12051));
    expect(typedSen('.5')).toBe(BigInt(50));
    for (const bad of ['', '-5', '1,500', 'abc', '.']) expect(typedSen(bad), bad).toBeNull();
  });
  it('says an overdraw in the account’s own currency', () => {
    expect(transferOverdrawNote({ ...c51, from: USD_HELD.id, to: MAIN, amount: '10000.01', toAmount: '1' }, accounts)).toBe(
      'USD Reserve holds USD 10,000.00. This transfer leaves it overdrawn by USD 0.01.',
    );
  });
  it('names both amounts in the table, the void question and the notes', () => {
    const out = side('out', {
      account_name: 'Maybank', other_account_name: 'USD Account', amount: 4462, number: 'TR-0005', other_currency: 'USD', other_amount: 1000,
    });
    const inn = side('in', {
      account_name: 'USD Account', other_account_name: 'Maybank', amount: 1000, number: 'TR-0005', currency: 'USD',
      fx_rate_text: '4.4620000000', fx_rate_source: 'transfer', amount_myr: 4462, other_currency: 'MYR', other_amount: 4462,
    });
    const named = 'TR-0005 of RM 4,462.00 from Maybank to USD Account as USD 1,000.00';
    expect(transferName(out)).toBe(named);
    expect(transferName(inn)).toBe(named);
    expect(voidTransferEffect(inn, [out, inn])).toBe(
      'Both sides are voided: RM 4,462.00 goes back into Maybank and USD 1,000.00 comes out of USD Account. It keeps its number, and this cannot be undone.',
    );
    expect(transferVoidedNote(out)).toBe(
      `Transfer ${named} is voided: RM 4,462.00 is back in Maybank and USD 1,000.00 out of USD Account. A voided transfer is not listed in the table below.`,
    );
    const written = recordedTransfer(c51, accounts, { transfer_id: TRANSFER, number: 'TR-0005' });
    expect(written).toEqual({
      transferId: TRANSFER, number: 'TR-0005', amount: 4462, date: '2026-10-12', from: 'Maybank', to: 'USD Account',
      arrived: { amount: 1000, fromCurrency: 'MYR', toCurrency: 'USD' },
    });
    expect(transferRecordedNote(written, 2, 2)).toBe(
      'Transfer TR-0005 is recorded: RM 4,462.00 from Maybank to USD Account as USD 1,000.00, dated 12 Oct 2026. Both sides are in the table below.',
    );
  });
  it('the data layer sends to_amount only between two currencies, and words FIN52', async () => {
    const { ctx, calls } = fakeFinance({ data: TRANSFER, error: null });
    await recordTransfer(ctx, transferPayload(c51, accounts));
    expect(calls[0].args?.transfer).toMatchObject({ amount: 4462, to_amount: 1000 });
    const ringgit = fakeFinance({ data: TRANSFER, error: null });
    await recordTransfer(ringgit.ctx, transferPayload({ ...c51, to: SAVINGS }, [...accounts, account(SAVINGS, 'Savings', 0)]));
    expect(ringgit.calls[0].args?.transfer).not.toHaveProperty('to_amount');
    const refused = fakeFinance({ data: null, error: { code: 'FIN52' } });
    expect(await recordTransfer(refused.ctx, transferPayload(c51, accounts))).toEqual({ ok: false, error: TRANSFER_MESSAGES.twoForeign });
    expect(TRANSFER_MESSAGES.twoForeign).toBe(
      'A transfer goes between a ringgit account and another account. Move money between two accounts in other currencies through a ringgit account.',
    );
  });
});
