/**
 * The account form's and the journal form's rules, kept out of the components so they can be tested: what a
 * new form holds, what is wrong with it, and what is sent to the server actions. Pure.
 *
 * A journal's boxes are text: a debit or credit box left empty is nothing, and a box that is not a number goes
 * as NaN and is refused with the amount sentence. The totals under the lines count such a box as nothing, so
 * the person sees the figure they have typed so far.
 */
import { typedNumber } from './format';
import {
  type AccountType,
  type JournalDetail,
  type LedgerAccount,
  LEDGER_MESSAGES,
  createAccountInput,
  saveJournalInput,
  updateAccountInput,
} from './ledger';

export type AccountForm = {
  /** Present when a saved account is being renamed. */
  id?: string;
  code: string;
  name: string;
  /** Empty until chosen; a saved account's kind is fixed, so the form of a saved account does not show it. */
  type: AccountType | '';
};

/** A new account: nothing typed, and the kind still to be chosen. */
export function newAccountForm(): AccountForm {
  return { code: '', name: '', type: '' };
}

/** A saved account, as the form shows it. */
export function accountFormFrom(account: Pick<LedgerAccount, 'id' | 'code' | 'name' | 'type'>): AccountForm {
  return { id: account.id, code: account.code, name: account.name, type: account.type };
}

/** What is sent to createAccountAction, or to updateAccountAction for a saved account (which cannot change its kind). */
export function accountPayload(form: AccountForm) {
  return form.id
    ? { id: form.id, code: form.code, name: form.name }
    : { code: form.code, name: form.name, type: form.type };
}

/** The first thing wrong with the account form, in the schema's own sentence, or null when it can be sent. */
export function accountFormError(form: AccountForm): string | null {
  const parsed = form.id ? updateAccountInput.safeParse(accountPayload(form)) : createAccountInput.safeParse(accountPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? LEDGER_MESSAGES.name);
}

/* ---- journals --------------------------------------------------------- */

export type JournalLineDraft = {
  /** Identifies the row in the form; never sent. */
  key: string;
  /** Empty until an account is chosen. */
  account_id: string;
  /** The box as typed. Empty when the line is on the other side. */
  debit: string;
  credit: string;
  note: string;
};

export type JournalForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  journal_date: string;
  description: string;
  lines: JournalLineDraft[];
};

const emptyJournalLine = (key: string): JournalLineDraft => ({ key, account_id: '', debit: '', credit: '', note: '' });

/** A new journal dated today with no description and two empty lines, keyed `${key}-1` and `${key}-2`. */
export function newJournalForm(today: string, key: string): JournalForm {
  return {
    journal_date: today,
    description: '',
    lines: [emptyJournalLine(`${key}-1`), emptyJournalLine(`${key}-2`)],
  };
}

/** A figure as a box shows it: a side that is nothing is an empty box. */
const boxOf = (n: number) => (n === 0 ? '' : String(n));

/** A saved draft, as the form shows it. Each line is keyed by its own id. */
export function journalFormFromDetail(journal: JournalDetail): JournalForm {
  return {
    id: journal.id,
    journal_date: journal.journal_date,
    description: journal.description,
    lines: journal.lines.map((l) => ({
      key: l.id,
      account_id: l.account_id,
      debit: boxOf(l.debit),
      credit: boxOf(l.credit),
      note: l.note ?? '',
    })),
  };
}

/** What a debit or credit box holds: nothing for an empty box, NaN for text that is not a number (refused). */
function typedAmount(text: string): number {
  return text.trim() === '' ? 0 : (typedNumber(text) ?? Number.NaN);
}

/** What is sent to saveJournalAction. Figures are numbers; an empty box is 0 and a box that is not a number goes as NaN. */
export function journalPayload(form: JournalForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    journal_date: form.journal_date,
    description: form.description,
    lines: form.lines.map((l) => ({
      account_id: l.account_id,
      debit: typedAmount(l.debit),
      credit: typedAmount(l.credit),
      note: l.note,
    })),
  };
}

/** A typed box in whole sen; a box that is not a number, or is negative, counts as nothing. */
function sen(text: string): number {
  const n = typedNumber(text);
  return n === null || n < 0 ? 0 : Math.round(n * 100);
}

/**
 * The two sides added up to the sen, and how far apart they are (always 0 or more: the screen says "out of
 * balance by", and a journal can be posted only when it is 0).
 */
export function journalTotals(form: JournalForm): { debit: number; credit: number; difference: number } {
  const debit = form.lines.reduce((total, l) => total + sen(l.debit), 0);
  const credit = form.lines.reduce((total, l) => total + sen(l.credit), 0);
  return { debit: debit / 100, credit: credit / 100, difference: Math.abs(debit - credit) / 100 };
}

/**
 * The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. A draft may
 * be saved unbalanced and with one line; a journal being posted needs two lines and equal sides, and saying
 * so here saves a draft the database would then refuse to post.
 */
export function journalFormError(form: JournalForm, posting = false): string | null {
  const parsed = saveJournalInput.safeParse(journalPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? LEDGER_MESSAGES.lines;
  if (posting) {
    if (form.lines.length < 2) return LEDGER_MESSAGES.lines;
    if (journalTotals(form).difference !== 0) return LEDGER_MESSAGES.unbalanced;
  }
  return null;
}

/**
 * What "Save" and "Save and post" do with the form: the sentence to show, with nothing to send, or the payload
 * for saveJournalAction (or saveAndPostJournalAction). The card calls this and nothing else, so a bad form is
 * refused before any call is made.
 */
export function submitJournal(
  form: JournalForm,
  posting: boolean,
): { error: string } | { payload: ReturnType<typeof journalPayload> } {
  const error = journalFormError(form, posting);
  return error ? { error } : { payload: journalPayload(form) };
}
