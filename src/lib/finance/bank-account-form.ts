/**
 * The account form's rules and what the Accounts table on Banking shows,
 * kept out of the components so they can be tested. Pure, with no server
 * imports.
 *
 * `canSignOff` (an owner or admin) is decided on the server and handed down:
 * only their form carries an opening balance and its date, so only their
 * payload does. Anyone else's payload has neither, whatever the form holds.
 */
import { BANK_ACCOUNT_MESSAGES, type BankAccountKind, createBankAccountInput, updateBankAccountInput } from './bank-accounts';
import type { BankAccountRow } from './banking';
import { rm, typedNumber } from './format';
import { displayDate } from './view-helpers';

const M = BANK_ACCOUNT_MESSAGES;

export type BankAccountForm = {
  /** Present when an account is being changed. */
  id?: string;
  name: string;
  /** Chosen when the account is added; shown, not changeable, after that. */
  kind: BankAccountKind;
  bankName: string;
  accountNo: string;
  /** The opening balance as typed; empty means none. */
  opening: string;
  /** The date the opening balance was true, YYYY-MM-DD. */
  openingDate: string;
};

/** A fresh form: a bank account, nothing in it, as at the person's own date. */
export function newBankAccountForm(today: string): BankAccountForm {
  return { kind: 'bank', name: '', bankName: '', accountNo: '', opening: '', openingDate: today };
}

/**
 * The form for an account being changed. `accountNo` is its number, which only someone who may write is given.
 * `today` is the person's own date: an account with no opening balance yet is dated from it, not from the day it was
 * added, since a balance first set now is a balance as at now.
 */
export function editBankAccountForm(account: BankAccountRow, accountNo?: string, today?: string): BankAccountForm {
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    bankName: account.bank_name ?? '',
    accountNo: accountNo ?? '',
    opening: account.opening_balance === 0 ? '' : String(account.opening_balance),
    openingDate: account.opening_balance === 0 && today ? today : account.opening_date,
  };
}

/**
 * What is sent to createBankAccountAction or updateBankAccountAction. A cash account
 * has no bank and no number. The opening balance and its date go only from
 * the form of someone who may set them; an empty box is 0 and a box that is
 * not a number goes as NaN, which the schema refuses. A change never carries
 * `kind`.
 */
export function bankAccountPayload(form: BankAccountForm, canSignOff: boolean) {
  const atBank = form.kind === 'bank';
  const details = {
    name: form.name,
    bank_name: atBank ? form.bankName : '',
    account_no: atBank ? form.accountNo : '',
    ...(canSignOff
      ? {
          opening_balance: form.opening.trim() === '' ? 0 : (typedNumber(form.opening) ?? Number.NaN),
          opening_date: form.openingDate,
        }
      : {}),
  };
  return form.id ? { id: form.id, ...details } : { kind: form.kind, ...details };
}

/** The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. */
export function bankAccountFormError(form: BankAccountForm, canSignOff: boolean): string | null {
  const payload = bankAccountPayload(form, canSignOff);
  const parsed = 'id' in payload ? updateBankAccountInput.safeParse(payload) : createBankAccountInput.safeParse(payload);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? M.name);
}

/**
 * The end of an account number, for a list: "•••• 4567". Spaces and dashes
 * are not counted. A number shorter than eight characters shows nothing of
 * itself: four of five would be most of it.
 */
export function lastFour(accountNo: string | undefined): string | null {
  const plain = (accountNo ?? '').replace(/[\s-]/g, '');
  return plain.length >= 8 ? `•••• ${plain.slice(-4)}` : null;
}

export type BankAccountListRow = {
  id: string;
  name: string;
  kind: BankAccountKind;
  /** The bank's name, with the end of the account number for someone who was given the numbers; a dash when neither. */
  bank: string;
  /** "RM 1,500.00 as at 30 Sep 2026", or a dash when there is none. */
  opening: string;
  balance: string;
  active: boolean;
};

/**
 * Every account for the Accounts table: active ones first, then bank before
 * cash, then by name. `numbers` is by account id and is empty for anyone who
 * may not write, so they see the bank's name only.
 */
export function bankAccountRows(accounts: BankAccountRow[], numbers: Record<string, string> = {}): BankAccountListRow[] {
  return [...accounts]
    .sort(
      (x, y) =>
        Number(y.active) - Number(x.active) || x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id),
    )
    .map((a) => {
      const end = a.kind === 'bank' ? lastFour(numbers[a.id]) : null;
      const bank = a.kind === 'cash' ? 'Cash' : [a.bank_name, end].filter(Boolean).join(' · ');
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        bank: bank || '—',
        opening: a.opening_balance === 0 ? '—' : `${rm(a.opening_balance)} as at ${displayDate(a.opening_date)}`,
        balance: rm(a.balance),
        active: a.active,
      };
    });
}

export type BankAccountAction = 'edit' | 'archive' | 'restore';

/** What an account's row menu offers someone who may write: an account is archived, never deleted. */
export function bankAccountActions(account: { active: boolean }): BankAccountAction[] {
  return ['edit', account.active ? 'archive' : 'restore'];
}

/**
 * What archiving does, for the question in the row. It says what the account
 * still holds, and names money that is still to be paid from it, which the
 * database will refuse the archive over.
 */
export function bankAccountArchiveEffect(account: BankAccountRow): string {
  const parts = ['It will no longer be offered on payment forms, and its account in the Chart of Accounts is archived with it. Its movements stay, and it can be restored.'];
  if (account.balance > 0) parts.push(`It still holds ${rm(account.balance)}, which stays in Total cash.`);
  if (account.balance < 0) parts.push(`It is overdrawn by ${rm(-account.balance)}, which stays in Total cash.`);
  if (account.to_be_paid > 0) {
    parts.push(
      `${rm(account.to_be_paid)} is still to be paid from it. Pay, reject or delete those payments first; ones waiting for approval hold it too.`,
    );
  }
  return parts.join(' ');
}

/** What the screen says once an account was archived, when it then drops out of the tiles. */
export function bankAccountArchivedNote(name: string): string {
  return `${name} is archived. It stays in the Accounts table, where it can be restored.`;
}

/** What the screen says once an account was restored. */
export function bankAccountRestoredNote(name: string): string {
  return `${name} is restored. It is offered on payment forms again, and so is its account in the Chart of Accounts.`;
}

/**
 * Whether saving this form sets or changes an opening balance in the books: only an owner or admin sends one, and
 * only a balance other than none, or a different one from the account's, moves Total cash and the ledger.
 */
export function bankAccountOpeningChanged(form: BankAccountForm, editing: BankAccountRow | null, canSignOff: boolean): boolean {
  if (!canSignOff) return false;
  const typed = form.opening.trim() === '' ? 0 : (typedNumber(form.opening) ?? Number.NaN);
  if (!editing) return typed !== 0;
  return typed !== editing.opening_balance || (typed !== 0 && form.openingDate !== editing.opening_date);
}

/** What the screen says after an account was added or changed, naming what else changed when an opening balance did. */
export function bankAccountSavedNote(name: string, added: boolean, openingChanged: boolean): string {
  const first = added ? `${name} is added.` : `${name} is saved.`;
  return openingChanged ? `${first} Its opening balance changed, so Total cash and the Chart of Accounts changed with it.` : first;
}
