/**
 * The account form's rules and what the Accounts table on Banking shows,
 * kept out of the components so they can be tested. Pure, with no server
 * imports.
 *
 * `canSignOff` (an owner or admin) is decided on the server and handed down:
 * only their form carries an opening balance and its date, so only their
 * payload does. Anyone else's payload has neither, whatever the form holds.
 *
 * Stage 5a: an account has a currency, chosen when it is added (by anyone who may add one) and only shown after
 * that. An opening balance in another currency carries its rate, the opening balance's and so an owner's or
 * admin's: Bank Negara Malaysia's 17:00 selling rate for the opening date, offered through the one rule, or one
 * typed by hand. The currency part reuses document-currency.ts; a ringgit account's form and payload are what
 * they always were.
 */
import { BANK_ACCOUNT_MESSAGES, type BankAccountKind, createBankAccountInput, updateBankAccountInput } from './bank-accounts';
import type { BankAccountRow } from './banking';
import { BASE_CURRENCY, minorUnits } from './currencies';
import {
  CURRENCY_MESSAGES,
  type CurrencyFields,
  currencyPayload,
  ringgitFields,
  savedFields,
  scaledFromText,
} from './document-currency';
import { money, rm, typedNumber } from './format';
import { ringgitOf, senFromNumber } from './fx-settlement';
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
  /** The opening balance as typed, in the account's currency; empty means none. */
  opening: string;
  /** The date the opening balance was true, YYYY-MM-DD. */
  openingDate: string;
  /**
   * The account's currency and the opening balance's rate (stage 5a). The currency is chosen when the account is
   * added; the rate box is per BNM's unit (1 USD, 100 JPY), as on every document form.
   */
  fx: CurrencyFields;
};

/** A fresh form: a bank account in ringgit, nothing in it, as at the person's own date. */
export function newBankAccountForm(today: string): BankAccountForm {
  return { kind: 'bank', name: '', bankName: '', accountNo: '', opening: '', openingDate: today, fx: ringgitFields() };
}

/** True for an account in another currency than ringgit. */
export function isForeignAccountForm(form: BankAccountForm): boolean {
  return form.fx.currency !== BASE_CURRENCY;
}

/** The opening balance as typed: 0 when empty, NaN when it is not a number. */
function typedOpening(form: BankAccountForm): number {
  return form.opening.trim() === '' ? 0 : (typedNumber(form.opening) ?? Number.NaN);
}

/** True when the form asks for the opening balance's rate: an owner's or admin's form, another currency, a balance. */
export function asksOpeningRate(form: BankAccountForm, canSignOff: boolean): boolean {
  const opening = typedOpening(form);
  return canSignOff && isForeignAccountForm(form) && !Number.isNaN(opening) && opening !== 0;
}

/**
 * "About RM 44,620.00 at this rate." under an opening balance in another currency, worked as the database works
 * `opening_balance_myr` (round(balance x rate, 2), half away from zero), in whole sen and 10^-10 units; null for
 * ringgit, with no balance, or while the rate is not a number.
 */
export function openingRinggitNote(form: BankAccountForm): string | null {
  const opening = typedOpening(form);
  if (!isForeignAccountForm(form) || Number.isNaN(opening) || opening === 0) return null;
  const rateText = currencyPayload(form.fx).fx_rate;
  const rate = rateText === null ? undefined : scaledFromText(rateText);
  if (rate === undefined || rate <= BigInt(0)) return null;
  const sen = senFromNumber(opening);
  const one = BigInt(10) ** BigInt(10);
  const magnitude = ((sen < BigInt(0) ? -sen : sen) * rate * BigInt(2) + one) / (one * BigInt(2));
  return `About ${rm(ringgitOf(sen < BigInt(0) ? -magnitude : magnitude))} at this rate.`;
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
    // The saved rate opens as it was stored (exact text); ringgit, or a foreign account with no balance, has none.
    fx: savedFields({
      currency: account.currency,
      fx_rate: null,
      fx_rate_text: account.opening_rate_text,
      fx_rate_source: account.opening_rate_source,
      fx_rate_date: account.opening_rate_date,
    }),
  };
}

/** The opening balance's rate keys, for an owner's or admin's form with a balance in another currency; else none. */
function ratePayload(
  form: BankAccountForm,
  canSignOff: boolean,
): { opening_rate?: string; opening_rate_source?: 'bnm' | 'manual'; opening_rate_date?: string } {
  if (!asksOpeningRate(form, canSignOff)) return {};
  const fx = currencyPayload(form.fx);
  const rate = fx.fx_rate;
  if (rate === null) return {};
  return {
    opening_rate: rate,
    opening_rate_source: fx.fx_rate_source ?? 'manual',
    ...(fx.fx_rate_date ? { opening_rate_date: fx.fx_rate_date } : {}),
  };
}

/**
 * What is sent to createBankAccountAction or updateBankAccountAction. A cash account
 * has no bank and no number. The opening balance and its date go only from
 * the form of someone who may set them; an empty box is 0 and a box that is
 * not a number goes as NaN, which the schema refuses. A change never carries
 * `kind`, nor the currency (chosen when the account was added). A new account
 * in another currency names it; a ringgit one sends what it always did. The
 * rate goes with an opening balance in another currency, from an owner's or
 * admin's form only.
 */
export function bankAccountPayload(form: BankAccountForm, canSignOff: boolean) {
  const atBank = form.kind === 'bank';
  const details = {
    name: form.name,
    bank_name: atBank ? form.bankName : '',
    account_no: atBank ? form.accountNo : '',
    ...(canSignOff
      ? {
          opening_balance: typedOpening(form),
          opening_date: form.openingDate,
        }
      : {}),
    ...ratePayload(form, canSignOff),
  };
  if (form.id) return { id: form.id, ...details };
  return { kind: form.kind, ...(isForeignAccountForm(form) ? { currency: form.fx.currency } : {}), ...details };
}

/** The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. */
export function bankAccountFormError(form: BankAccountForm, canSignOff: boolean): string | null {
  const payload = bankAccountPayload(form, canSignOff);
  const parsed = 'id' in payload ? updateBankAccountInput.safeParse(payload) : createBankAccountInput.safeParse(payload);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.name;
  // A change does not carry the currency, so the schema cannot ask these of it; the form can.
  if (canSignOff && minorUnits(form.fx.currency) === 0 && !Number.isInteger(typedOpening(form))) {
    return CURRENCY_MESSAGES.wholeUnits(form.fx.currency);
  }
  if (asksOpeningRate(form, canSignOff) && currencyPayload(form.fx).fx_rate === null) return M.rate;
  return null;
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
  /** "RM 1,500.00 as at 30 Sep 2026", or a dash when there is none. In the account's currency. */
  opening: string;
  /** In the account's currency: "RM 1,500.00", "USD 10,000.00". */
  balance: string;
  /** Under a balance in another currency, its ringgit book value ("≈ RM 44,620.00"); null for ringgit. */
  ringgit: string | null;
  /** The account's currency code (stage 5a). */
  currency: string;
  active: boolean;
};

/** True when any account is in another currency than ringgit: the Accounts table then shows a Currency column. */
export function hasForeignAccount(accounts: { currency: string }[]): boolean {
  return accounts.some((a) => a.currency !== BASE_CURRENCY);
}

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
        opening: a.opening_balance === 0 ? '—' : `${money(a.opening_balance, a.currency)} as at ${displayDate(a.opening_date)}`,
        balance: money(a.balance, a.currency),
        ringgit: a.currency === BASE_CURRENCY ? null : `≈ ${rm(a.balance_myr)}`,
        currency: a.currency,
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
  if (account.balance > 0) parts.push(`It still holds ${money(account.balance, account.currency)}, which stays in Total cash.`);
  if (account.balance < 0) parts.push(`It is overdrawn by ${money(-account.balance, account.currency)}, which stays in Total cash.`);
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
  return `${name} is restored. Its account in the Chart of Accounts is restored with it.`;
}

/** What saving the form does to the opening balance in the books. */
export type OpeningChange = {
  /** The amount differs (or is set on a new account): Total cash and the ledger move. */
  balance: boolean;
  /** The date differs, over a balance that is there: the opening entry moves to another day. */
  date: boolean;
  /** The balance as it will be stored, to the sen. */
  amount: number;
  /** The date as typed. */
  openingDate: string;
  /** The account's currency, which the amount is in. */
  currency: string;
};

/**
 * Which of the opening balance and its date saving this form changes. Only an owner or admin sends either. The
 * typed amount is rounded to the sen first, as the schema does, so "300.004" over 300 is no change. A date over a
 * balance of nothing changes nothing in the books. Both can be true; the note then speaks of the balance.
 */
export function bankAccountOpeningChange(form: BankAccountForm, editing: BankAccountRow | null, canSignOff: boolean): OpeningChange {
  const typed = typedOpening(form);
  const amount = Math.round(typed * 100) / 100;
  const out: OpeningChange = { balance: false, date: false, amount, openingDate: form.openingDate, currency: form.fx.currency };
  if (!canSignOff || Number.isNaN(amount)) return out;
  if (!editing) return { ...out, balance: amount !== 0 };
  // Stage 5a: a new rate on a balance in another currency changes its ringgit, so the books move as for a new amount.
  const sent = ratePayload(form, canSignOff).opening_rate;
  const stored = editing.opening_rate_text === null ? undefined : scaledFromText(editing.opening_rate_text);
  const rateMoved = amount !== 0 && isForeignAccountForm(form) && sent !== undefined && scaledFromText(sent) !== stored;
  return {
    ...out,
    balance: amount !== editing.opening_balance || rateMoved,
    date: amount !== 0 && form.openingDate !== editing.opening_date,
  };
}

/** What the screen says after an account was added or changed; it names the books only for what really changed in them. */
export function bankAccountSavedNote(name: string, added: boolean, change: OpeningChange): string {
  const first = added ? `${name} is added.` : `${name} is saved.`;
  if (change.balance) {
    const amount = money(change.amount, change.currency);
    const what = added ? `It starts with ${amount}` : `Its opening balance is now ${amount}`;
    return `${first} ${what}, so Total cash and the Chart of Accounts changed with it.`;
  }
  if (change.date) {
    return `${first} Its opening balance is now dated ${displayDate(change.openingDate)}, so its entry in the Chart of Accounts moved.`;
  }
  return first;
}

