import { describe, expect, it } from 'vitest';
import {
  type AccountForm,
  type JournalForm,
  accountFormError,
  accountFormFrom,
  accountPayload,
  journalFormError,
  journalFormFromDetail,
  journalPayload,
  journalTotals,
  newAccountForm,
  newJournalForm,
  submitJournal,
} from '@/lib/finance/ledger-form';
import { LEDGER_MESSAGES, type JournalDetail, type LedgerAccount, createAccountInput, saveJournalInput, updateAccountInput } from '@/lib/finance/ledger';

const CASH = '44444444-4444-4444-8444-444444444444';
const SALES = '55555555-5555-4555-8555-555555555555';
const JOURNAL = '33333333-3333-4333-8333-333333333333';
const today = '2026-10-12';

const equipment: LedgerAccount = {
  id: JOURNAL, code: '1500', name: 'Equipment', type: 'asset', active: true, stands_for: 'own', system_key: null,
  bank_account_id: null, category_id: null, default_for: null, debit_total: 0, credit_total: 0, balance: 0,
};

/** A form a person has filled in: RM 100 from cash to sales. */
const filled = (form: Partial<JournalForm> = {}): JournalForm => ({
  ...newJournalForm(today, 'k'),
  description: 'Owner’s capital',
  lines: [
    { key: 'k-1', account_id: CASH, debit: '100', credit: '', note: '' },
    { key: 'k-2', account_id: SALES, debit: '', credit: '100', note: 'owner' },
  ],
  ...form,
});

describe('the account form', () => {
  it('is new and empty, with the kind of account still to be chosen', () => {
    expect(newAccountForm()).toEqual({ code: '', name: '', type: '' });
  });
  it('shows a saved account as it is', () => {
    expect(accountFormFrom(equipment)).toEqual({ id: JOURNAL, code: '1500', name: 'Equipment', type: 'asset' });
  });
  it('sends a new account’s code, name and type', () => {
    expect(accountPayload({ code: '1500', name: 'Equipment', type: 'asset' })).toEqual({ code: '1500', name: 'Equipment', type: 'asset' });
  });
  it('sends a saved account’s code and name only: its kind is fixed', () => {
    expect(accountPayload(accountFormFrom(equipment))).toEqual({ id: JOURNAL, code: '1500', name: 'Equipment' });
  });
  it('says the first thing wrong, in the schema’s own sentence', () => {
    const form: AccountForm = { code: '1500', name: 'Equipment', type: 'asset' };
    expect(accountFormError(form)).toBeNull();
    expect(accountFormError({ ...form, code: '' })).toBe(LEDGER_MESSAGES.code);
    expect(accountFormError({ ...form, code: '12345678901' })).toBe(LEDGER_MESSAGES.code);
    expect(accountFormError({ ...form, name: ' ' })).toBe(LEDGER_MESSAGES.name);
    expect(accountFormError({ ...form, type: '' })).toBe(LEDGER_MESSAGES.type);
    expect(accountFormError({ ...form, code: '', name: '' })).toBe(LEDGER_MESSAGES.code);
  });
  it('does not ask a saved account for its kind', () => {
    expect(accountFormError({ ...accountFormFrom(equipment), type: '' as never })).toBeNull();
  });
  it('sends what the schemas accept', () => {
    expect(createAccountInput.safeParse(accountPayload({ code: '1', name: 'x', type: 'income' })).success).toBe(true);
    expect(updateAccountInput.safeParse(accountPayload(accountFormFrom(equipment))).success).toBe(true);
  });
});

describe('a new journal form', () => {
  it('is dated today, with no description and two empty lines', () => {
    expect(newJournalForm(today, 'k')).toEqual({
      journal_date: today,
      description: '',
      lines: [
        { key: 'k-1', account_id: '', debit: '', credit: '', note: '' },
        { key: 'k-2', account_id: '', debit: '', credit: '', note: '' },
      ],
    });
  });
});

describe('a saved draft as the form shows it', () => {
  const detail: JournalDetail = {
    id: JOURNAL, journal_no: null, journal_date: '2026-10-01', description: 'Capital', status: 'draft', reverses_journal_id: null, reversed: false,
    lines: [
      { id: 'l1', position: 0, account_id: CASH, debit: 100.5, credit: 0, note: 'cash in' },
      { id: 'l2', position: 1, account_id: SALES, debit: 0, credit: 100.5, note: null },
    ],
  };
  it('keeps the id, writes a side that is nothing as an empty box, and keys each line by its own id', () => {
    expect(journalFormFromDetail(detail)).toEqual({
      id: JOURNAL,
      journal_date: '2026-10-01',
      description: 'Capital',
      lines: [
        { key: 'l1', account_id: CASH, debit: '100.5', credit: '', note: 'cash in' },
        { key: 'l2', account_id: SALES, debit: '', credit: '100.5', note: '' },
      ],
    });
  });
});

describe('what is sent', () => {
  it('has figures as numbers, an empty box as nothing, and the id only for a saved draft', () => {
    expect(journalPayload(filled())).toEqual({
      journal_date: today,
      description: 'Owner’s capital',
      lines: [
        { account_id: CASH, debit: 100, credit: 0, note: '' },
        { account_id: SALES, debit: 0, credit: 100, note: 'owner' },
      ],
    });
    expect(journalPayload(filled({ id: JOURNAL }))).toMatchObject({ id: JOURNAL });
  });
  it('sends a box that is not a number as NaN, to be refused', () => {
    const payload = journalPayload(filled({ lines: [{ key: 'a', account_id: CASH, debit: '1,200', credit: '', note: '' }] }));
    expect(payload.lines[0].debit).toBeNaN();
  });
  it('is what the schema accepts', () => {
    expect(saveJournalInput.safeParse(journalPayload(filled())).success).toBe(true);
  });
});

describe('totals', () => {
  it('add each side to the sen and say how far apart they are', () => {
    expect(journalTotals(filled())).toEqual({ debit: 100, credit: 100, difference: 0 });
    expect(journalTotals(filled({ lines: [
      { key: 'a', account_id: CASH, debit: '0.1', credit: '', note: '' },
      { key: 'b', account_id: CASH, debit: '0.2', credit: '', note: '' },
      { key: 'c', account_id: SALES, debit: '', credit: '0.3', note: '' },
    ] }))).toEqual({ debit: 0.3, credit: 0.3, difference: 0 });
    expect(journalTotals(filled({ lines: [
      { key: 'a', account_id: CASH, debit: '100.50', credit: '', note: '' },
      { key: 'b', account_id: SALES, debit: '', credit: '40.25', note: '' },
    ] }))).toEqual({ debit: 100.5, credit: 40.25, difference: 60.25 });
  });
  it('count a box that is not a number as nothing', () => {
    expect(journalTotals(filled({ lines: [
      { key: 'a', account_id: CASH, debit: 'abc', credit: '', note: '' },
      { key: 'b', account_id: SALES, debit: '', credit: '12', note: '' },
    ] }))).toEqual({ debit: 0, credit: 12, difference: 12 });
  });
  it('round a figure typed beyond the sen', () => {
    expect(journalTotals(filled({ lines: [{ key: 'a', account_id: CASH, debit: '10.005', credit: '', note: '' }] })).debit).toBe(10.01);
  });
});

describe('what is wrong with a journal form', () => {
  it('nothing, for a balanced journal, saved or posted', () => {
    expect(journalFormError(filled())).toBeNull();
    expect(journalFormError(filled(), true)).toBeNull();
  });
  it('says the first thing the schema refuses', () => {
    expect(journalFormError(filled({ description: ' ' }))).toBe(LEDGER_MESSAGES.description);
    expect(journalFormError(filled({ journal_date: '' }))).toBe(LEDGER_MESSAGES.date);
    const line = (patch: object) => filled({ lines: [{ key: 'a', account_id: CASH, debit: '5', credit: '', note: '', ...patch }] });
    expect(journalFormError(line({ account_id: '' }))).toBe(LEDGER_MESSAGES.account);
    expect(journalFormError(line({ debit: '', credit: '' }))).toBe(LEDGER_MESSAGES.side);
    expect(journalFormError(line({ credit: '5' }))).toBe(LEDGER_MESSAGES.side);
    expect(journalFormError(line({ debit: 'x' }))).toBe(LEDGER_MESSAGES.amount);
  });
  it('lets a draft be saved unbalanced, and with one line', () => {
    const unbalanced = filled({ lines: [
      { key: 'a', account_id: CASH, debit: '100', credit: '', note: '' },
      { key: 'b', account_id: SALES, debit: '', credit: '60', note: '' },
    ] });
    expect(journalFormError(unbalanced)).toBeNull();
    expect(journalFormError(filled({ lines: [filled().lines[0]] }))).toBeNull();
  });
  it('wants two lines and equal sides to post', () => {
    const unbalanced = filled({ lines: [
      { key: 'a', account_id: CASH, debit: '100', credit: '', note: '' },
      { key: 'b', account_id: SALES, debit: '', credit: '60', note: '' },
    ] });
    expect(journalFormError(unbalanced, true)).toBe(LEDGER_MESSAGES.unbalanced);
    expect(journalFormError(filled({ lines: [filled().lines[0]] }), true)).toBe(LEDGER_MESSAGES.lines);
  });
  it('asks the schema before the balance', () => {
    expect(journalFormError(filled({ description: '' }), true)).toBe(LEDGER_MESSAGES.description);
  });
});

describe('submitting', () => {
  it('answers the sentence to show, with nothing to send', () => {
    expect(submitJournal(filled({ description: '' }), false)).toEqual({ error: LEDGER_MESSAGES.description });
    expect(submitJournal(filled({ lines: [filled().lines[0], { ...filled().lines[1], credit: '60' }] }), true)).toEqual({
      error: LEDGER_MESSAGES.unbalanced,
    });
  });
  it('answers the payload when the form can be sent', () => {
    expect(submitJournal(filled(), true)).toEqual({ payload: journalPayload(filled()) });
    expect(submitJournal(filled(), false)).toEqual({ payload: journalPayload(filled()) });
  });
});
