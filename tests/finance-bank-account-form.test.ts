import { describe, expect, it } from 'vitest';
import {
  bankAccountActions,
  bankAccountFormError,
  bankAccountPayload,
  bankAccountRows,
  bankAccountArchiveEffect,
  bankAccountArchivedNote,
  bankAccountOpeningChange,
  bankAccountRestoredNote,
  bankAccountSavedNote,
  editBankAccountForm,
  lastFour,
  newBankAccountForm,
  type OpeningChange,
} from '@/lib/finance/bank-account-form';
import { BANK_ACCOUNT_MESSAGES, changesOpeningBalance, createBankAccountInput, setsOpeningBalance, updateBankAccountInput } from '@/lib/finance/bank-accounts';
import type { BankAccountRow } from '@/lib/finance/banking';

const M = BANK_ACCOUNT_MESSAGES;

function account(over: Partial<BankAccountRow> = {}): BankAccountRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Main Bank',
    kind: 'bank',
    bank_name: 'Maybank',
    opening_balance: 0,
    opening_date: '2026-09-30',
    active: true,
    balance: 0,
    to_be_paid: 0,
    last_import_at: null,
    unmatched_lines: 0,
    ...over,
  };
}

describe('the form', () => {
  it('starts as an empty bank account dated with the date it is given', () => {
    expect(newBankAccountForm('2026-10-12')).toEqual({ kind: 'bank', name: '', bankName: '', accountNo: '', opening: '', openingDate: '2026-10-12' });
  });

  it('opens an account with its own values, its number only when one was given', () => {
    const form = editBankAccountForm(account({ opening_balance: -250.5 }), '8001234567');
    expect(form).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'bank',
      name: 'Main Bank',
      bankName: 'Maybank',
      accountNo: '8001234567',
      opening: '-250.5',
      openingDate: '2026-09-30',
    });
    expect(editBankAccountForm(account({ bank_name: null })).bankName).toBe('');
    expect(editBankAccountForm(account()).accountNo).toBe('');
    expect(editBankAccountForm(account()).opening).toBe('');
  });

  it('dates a balance set for the first time from today, and keeps the date of one that is there', () => {
    expect(editBankAccountForm(account(), undefined, '2026-10-12').openingDate).toBe('2026-10-12');
    expect(editBankAccountForm(account({ opening_balance: 300 }), undefined, '2026-10-12').openingDate).toBe('2026-09-30');
    expect(editBankAccountForm(account()).openingDate).toBe('2026-09-30');
  });
});

describe('bankAccountOpeningChange', () => {
  const base = { ...newBankAccountForm('2026-10-12'), name: 'Savings' };
  const held = account({ opening_balance: 300 });
  const form = editBankAccountForm(held);
  const none = { balance: false, date: false };

  it('on a new account: the balance changed when one is typed, never for someone who cannot sign off', () => {
    expect(bankAccountOpeningChange({ ...base, opening: '1500' }, null, true)).toMatchObject({ balance: true, date: false, amount: 1500 });
    expect(bankAccountOpeningChange({ ...base, opening: '-1' }, null, true)).toMatchObject({ balance: true, amount: -1 });
    expect(bankAccountOpeningChange({ ...base, opening: '' }, null, true)).toMatchObject(none);
    expect(bankAccountOpeningChange({ ...base, opening: '1500' }, null, false)).toMatchObject(none);
  });

  it('balance only', () => {
    expect(bankAccountOpeningChange({ ...form, opening: '300.01' }, held, true)).toMatchObject({ balance: true, date: false, amount: 300.01 });
    expect(bankAccountOpeningChange({ ...form, opening: '0' }, held, true)).toMatchObject({ balance: true, date: false, amount: 0 });
  });

  it('date only: a different date over a balance that is there', () => {
    expect(bankAccountOpeningChange({ ...form, openingDate: '2026-10-01' }, held, true)).toMatchObject({
      balance: false,
      date: true,
      openingDate: '2026-10-01',
    });
  });

  it('both', () => {
    expect(bankAccountOpeningChange({ ...form, opening: '500', openingDate: '2026-10-01' }, held, true)).toMatchObject({
      balance: true,
      date: true,
    });
  });

  it('neither: the same form, a date over a balance of nothing, and someone who cannot sign off', () => {
    expect(bankAccountOpeningChange(form, held, true)).toMatchObject(none);
    const empty = account();
    expect(bankAccountOpeningChange({ ...editBankAccountForm(empty), openingDate: '2026-10-01' }, empty, true)).toMatchObject(none);
    expect(bankAccountOpeningChange({ ...form, opening: '999' }, held, false)).toMatchObject(none);
  });

  it('compares the balance to the sen, as the schema stores it', () => {
    expect(bankAccountOpeningChange({ ...form, opening: '300.004' }, held, true)).toMatchObject(none);
    expect(bankAccountOpeningChange({ ...form, opening: '300.006' }, held, true)).toMatchObject({ balance: true });
  });
});

describe('what the screen says after a save', () => {
  const change = (over: Partial<OpeningChange> = {}): OpeningChange => ({ balance: false, date: false, amount: 0, openingDate: '2026-10-01', ...over });

  it('says only that it was added or saved when no opening balance changed', () => {
    expect(bankAccountSavedNote('Savings', true, change())).toBe('Savings is added.');
    expect(bankAccountSavedNote('Savings', false, change())).toBe('Savings is saved.');
  });

  it('names Total cash and the books when the balance changed', () => {
    expect(bankAccountSavedNote('Savings', true, change({ balance: true, amount: 150.5 }))).toBe(
      'Savings is added. It starts with RM 150.50, so Total cash and the Chart of Accounts changed with it.',
    );
    expect(bankAccountSavedNote('Savings', false, change({ balance: true, amount: 0 }))).toBe(
      'Savings is saved. Its opening balance is now RM 0.00, so Total cash and the Chart of Accounts changed with it.',
    );
    expect(bankAccountSavedNote('Savings', false, change({ balance: true, date: true, amount: 5 }))).toContain('Total cash');
  });

  it('says only that the entry moved when only the date did, and not that Total cash changed', () => {
    const note = bankAccountSavedNote('Savings', false, change({ date: true }));
    expect(note).toBe('Savings is saved. Its opening balance is now dated 01 Oct 2026, so its entry in the Chart of Accounts moved.');
    expect(note).not.toContain('Total cash');
  });

  it('says an account was restored', () => {
    expect(bankAccountRestoredNote('Savings')).toBe('Savings is restored. Its account in the Chart of Accounts is restored with it.');
  });
});

describe('bankAccountPayload', () => {
  const typed = { ...newBankAccountForm('2026-10-12'), name: 'Savings', bankName: 'CIMB', accountNo: '8001234567', opening: '1500', openingDate: '2026-09-30' };

  it('a new account from someone who may sign off carries the opening balance and its date', () => {
    expect(bankAccountPayload(typed, true)).toEqual({
      kind: 'bank',
      name: 'Savings',
      bank_name: 'CIMB',
      account_no: '8001234567',
      opening_balance: 1500,
      opening_date: '2026-09-30',
    });
  });

  it('from anyone else it carries neither, whatever the form holds', () => {
    const payload = bankAccountPayload(typed, false);
    expect(payload).toEqual({ kind: 'bank', name: 'Savings', bank_name: 'CIMB', account_no: '8001234567' });
    expect(setsOpeningBalance(createBankAccountInput.parse(payload))).toBe(false);
    const change = bankAccountPayload({ ...typed, id: '11111111-1111-4111-8111-111111111111' }, false);
    expect(changesOpeningBalance(updateBankAccountInput.parse(change))).toBe(false);
  });

  it('a change carries the id and never the kind', () => {
    const payload = bankAccountPayload({ ...typed, id: '11111111-1111-4111-8111-111111111111' }, true);
    expect(payload).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', name: 'Savings', opening_balance: 1500 });
    expect(payload).not.toHaveProperty('kind');
  });

  it('a cash account has no bank and no number', () => {
    expect(bankAccountPayload({ ...typed, kind: 'cash' }, false)).toEqual({ kind: 'cash', name: 'Savings', bank_name: '', account_no: '' });
  });

  it('an empty opening balance is 0, and one that is not a number is sent as NaN', () => {
    expect(bankAccountPayload({ ...typed, opening: '  ' }, true)).toMatchObject({ opening_balance: 0 });
    expect(bankAccountPayload({ ...typed, opening: '-250.50' }, true)).toMatchObject({ opening_balance: -250.5 });
    expect(Number.isNaN((bankAccountPayload({ ...typed, opening: '1,500' }, true) as { opening_balance: number }).opening_balance)).toBe(true);
  });
});

describe('bankAccountFormError', () => {
  const good = { ...newBankAccountForm('2026-10-12'), name: 'Savings' };

  it('passes a form that can be sent', () => {
    expect(bankAccountFormError(good, true)).toBeNull();
    expect(bankAccountFormError(good, false)).toBeNull();
    expect(bankAccountFormError({ ...good, id: '11111111-1111-4111-8111-111111111111', opening: '-10' }, true)).toBeNull();
  });

  it('says what is wrong in the schema’s sentence', () => {
    expect(bankAccountFormError({ ...good, name: ' ' }, false)).toBe(M.name);
    expect(bankAccountFormError({ ...good, accountNo: '1'.repeat(35) }, false)).toBe(M.numberTooLong);
    expect(bankAccountFormError({ ...good, opening: '1,500' }, true)).toBe(M.opening);
    expect(bankAccountFormError({ ...good, opening: '5', openingDate: '' }, true)).toBe(M.date);
  });

  it('does not look at an opening balance the person may not send', () => {
    expect(bankAccountFormError({ ...good, opening: 'abc', openingDate: '' }, false)).toBeNull();
  });
});

describe('lastFour', () => {
  it('shows the end of a number of eight characters or more and nothing of a shorter one', () => {
    expect(lastFour('8001234567')).toBe('•••• 4567');
    expect(lastFour('8001-2345 67')).toBe('•••• 4567');
    expect(lastFour('12345678')).toBe('•••• 5678');
    expect(lastFour('1234567')).toBeNull();
    expect(lastFour('12345')).toBeNull();
    expect(lastFour('1234')).toBeNull();
    expect(lastFour('GB82 WEST 1234 5698')).toBe('•••• 5698');
    expect(lastFour('')).toBeNull();
    expect(lastFour(undefined)).toBeNull();
  });
});

describe('bankAccountRows', () => {
  const accounts = [
    account({ id: 'c', name: 'Till', kind: 'cash', bank_name: null }),
    account({ id: 'z', name: 'Old', active: false, balance: 12 }),
    account({ id: 'b', name: 'Savings', bank_name: null, opening_balance: 1500, balance: 1500 }),
    account({ id: 'a', name: 'Main Bank', balance: -20 }),
  ];

  it('lists active accounts first, bank before cash, then by name', () => {
    expect(bankAccountRows(accounts).map((r) => r.name)).toEqual(['Main Bank', 'Savings', 'Till', 'Old']);
  });

  it('shows the end of a number only to someone who was given the numbers', () => {
    const numbers = { a: '8001234567', b: '5001', c: '999999' };
    expect(bankAccountRows(accounts, numbers).map((r) => r.bank)).toEqual(['Maybank · •••• 4567', '—', 'Cash', 'Maybank']);
    expect(bankAccountRows(accounts).map((r) => r.bank)).toEqual(['Maybank', '—', 'Cash', 'Maybank']);
  });

  it('words the opening balance and the balance', () => {
    const rows = bankAccountRows(accounts);
    expect(rows[1]).toMatchObject({ opening: 'RM 1,500.00 as at 30 Sep 2026', balance: 'RM 1,500.00', active: true });
    expect(rows[0]).toMatchObject({ opening: '—', balance: 'RM -20.00' });
    expect(rows[3].active).toBe(false);
  });
});

describe('the row menu and the archive question', () => {
  it('offers Edit, and Archive or Restore: never Delete', () => {
    expect(bankAccountActions({ active: true })).toEqual(['edit', 'archive']);
    expect(bankAccountActions({ active: false })).toEqual(['edit', 'restore']);
  });

  it('says what the account still holds and what is still to be paid from it', () => {
    expect(bankAccountArchiveEffect(account())).toBe('It will no longer be offered on payment forms, and its account in the Chart of Accounts is archived with it. Its movements stay, and it can be restored.');
    expect(bankAccountArchiveEffect(account({ balance: 925 }))).toContain('It still holds RM 925.00, which stays in Total cash.');
    expect(bankAccountArchiveEffect(account({ balance: -5, to_be_paid: 60 }))).toBe(
      'It will no longer be offered on payment forms, and its account in the Chart of Accounts is archived with it. Its movements stay, and it can be restored. ' +
        'It is overdrawn by RM 5.00, which stays in Total cash. ' +
        'RM 60.00 is still to be paid from it. Pay, reject or delete those payments first; ones waiting for approval hold it too.',
    );
    expect(bankAccountArchiveEffect(account({ to_be_paid: 60 }))).not.toContain('holds');
    expect(bankAccountArchiveEffect(account({ balance: -5 }))).not.toContain('RM -');
  });

  it('says where an archived account went', () => {
    expect(bankAccountArchivedNote('Savings')).toBe('Savings is archived. It stays in the Accounts table, where it can be restored.');
  });
});
