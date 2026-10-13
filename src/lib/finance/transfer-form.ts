/**
 * The transfer form's rules, and every sentence Banking says about a
 * transfer, kept out of the components so they can be tested. Pure, with no
 * server imports.
 *
 * Only someone who may sign off (an owner or admin, decided on the server) is
 * given the form or the "Void transfer" menu; nothing here decides that.
 */
import type { BankAccountRow, BankTransactionRow } from './banking';
import { rm, typedNumber } from './format';
import { TRANSFER_MESSAGES, recordTransferInput } from './transfers';
import { displayDate, round2 } from './view-helpers';

const M = TRANSFER_MESSAGES;

export type TransferForm = {
  /** The account the money leaves; empty until one is chosen. */
  from: string;
  /** The account the money goes to; empty until one is chosen. */
  to: string;
  /** The amount as typed. */
  amount: string;
  /** The date the money moved, YYYY-MM-DD. */
  date: string;
  reference: string;
  notes: string;
};

/** The accounts a transfer can use: active ones, in the order the screen lists them. */
export function transferAccounts(accounts: BankAccountRow[]): BankAccountRow[] {
  return accounts.filter((a) => a.active);
}

/** A transfer needs two accounts to move money between. */
export function canTransfer(accounts: BankAccountRow[]): boolean {
  return transferAccounts(accounts).length >= 2;
}

/** A fresh form: nothing chosen, dated the person's own date. */
export function newTransferForm(today: string): TransferForm {
  return { from: '', to: '', amount: '', date: today, reference: '', notes: '' };
}

/** What "To" offers: every active account but the one chosen in "From". */
export function transferToOptions(accounts: BankAccountRow[], from: string): BankAccountRow[] {
  return transferAccounts(accounts).filter((a) => a.id !== from);
}

/**
 * The form after "From" was chosen: "To" is cleared when it now names the same account, so the two can never be
 * equal on screen.
 */
export function withTransferFrom(form: TransferForm, from: string): TransferForm {
  return { ...form, from, to: form.to === from ? '' : form.to };
}

/** What is sent to recordTransferAction. A box that is not a number goes as NaN, which the schema refuses. */
export function transferPayload(form: TransferForm) {
  return {
    from_account_id: form.from,
    to_account_id: form.to,
    amount: typedNumber(form.amount) ?? Number.NaN,
    txn_date: form.date,
    reference: form.reference,
    notes: form.notes,
  };
}

/** The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. */
export function transferFormError(form: TransferForm): string | null {
  if (!form.from) return M.from;
  if (!form.to) return M.to;
  const parsed = recordTransferInput.safeParse(transferPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? M.amount);
}

/**
 * What to say, before it is recorded, when the transfer is for more than the "From" account holds: null when the
 * account covers it, when no account is chosen, or while the amount is not a number above 0. It is a note, not a
 * refusal: an overdraft is a real thing, and the balance on screen can be a moment old.
 */
export function transferOverdrawNote(form: TransferForm, accounts: BankAccountRow[]): string | null {
  const account = accounts.find((a) => a.id === form.from);
  const amount = typedNumber(form.amount);
  if (!account || amount === null || amount <= 0) return null;
  const after = round2(account.balance - round2(amount));
  if (after >= 0) return null;
  if (account.balance < 0) {
    return `${account.name} is already overdrawn by ${rm(-account.balance)}. This transfer takes that to ${rm(-after)}.`;
  }
  return `${account.name} holds ${rm(account.balance)}. This transfer leaves it overdrawn by ${rm(-after)}.`;
}

/** One side of a posted transfer, as the Transactions table holds it. */
type TransferSide = Pick<
  BankTransactionRow,
  'transaction_id' | 'transfer_id' | 'direction' | 'amount' | 'number' | 'txn_date' | 'account_name' | 'other_account_name' | 'reconciled' | 'kind'
>;

/** The two accounts of a transfer, read from either side's row. */
export function transferEnds(row: TransferSide): { from: string; to: string } {
  const other = row.other_account_name ?? 'another account';
  return row.direction === 'out' ? { from: row.account_name, to: other } : { from: other, to: row.account_name };
}

/** How a transfer is named in a question and to a screen reader: "TR-0004 of RM 500.00 from Main Bank to Savings". */
export function transferName(row: TransferSide): string {
  const { from, to } = transferEnds(row);
  return `${row.number ?? 'the transfer'} of ${rm(row.amount)} from ${from} to ${to}`;
}

export type BankRowAction = 'void-transfer';

/**
 * What a row of the Transactions table offers someone who may sign off. Only a side of a transfer has anything:
 * every other movement is changed on the screen that recorded it. The table lists posted movements only, so a
 * transfer that is listed can be voided.
 */
export function bankRowActions(row: Pick<BankTransactionRow, 'kind' | 'transfer_id'>, canSignOff: boolean): BankRowAction[] {
  return canSignOff && row.kind === 'transfer' && row.transfer_id ? ['void-transfer'] : [];
}

/**
 * What voiding does, for the question in the row. `rows` is every movement the screen holds: the other side is
 * looked up there to say whether a statement line is matched to either.
 */
export function voidTransferEffect(row: TransferSide, rows: Pick<BankTransactionRow, 'transfer_id' | 'reconciled'>[]): string {
  const { from, to } = transferEnds(row);
  const parts = [
    `Both sides are voided: ${rm(row.amount)} goes back into ${from} and comes out of ${to}. It keeps its number, and this cannot be undone.`,
  ];
  const matched = rows.filter((r) => r.transfer_id === row.transfer_id && r.reconciled).length;
  if (matched === 1) parts.push('A statement line is matched to it; that line goes back to unmatched.');
  if (matched > 1) parts.push('Statement lines are matched to both sides; they go back to unmatched.');
  return parts.join(' ');
}

/** What the screen says once a transfer was voided. Its rows have left the table, which lists posted movements only. */
export function transferVoidedNote(row: TransferSide): string {
  const { from, to } = transferEnds(row);
  return `Transfer ${transferName(row)} is voided: ${rm(row.amount)} is back in ${from} and out of ${to}. A voided transfer is not listed in the table below.`;
}

/** A transfer that was just recorded, kept so the note can be worked out again whenever the table changes. */
export type RecordedTransferNote = {
  transferId: string;
  number: string | null;
  amount: number;
  date: string;
  from: string;
  to: string;
};

/** What to remember of a transfer the form just recorded. `form` is what was sent; the names are the accounts' own. */
export function recordedTransfer(
  form: TransferForm,
  accounts: BankAccountRow[],
  saved: { transfer_id: string; number: string | null },
): RecordedTransferNote {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'another account';
  return {
    transferId: saved.transfer_id,
    number: saved.number,
    amount: round2(typedNumber(form.amount) ?? 0),
    date: form.date,
    from: name(form.from),
    to: name(form.to),
  };
}

/**
 * What the screen says after a transfer was recorded, worked out at render from the rows the table shows now.
 * `shown` is how many of its two sides are on screen and `listed` how many the table holds at all (it lists posted
 * movements; both are there once the page has refreshed). Both on screen: it says where they are. Otherwise the
 * first reason that hides one is given: the page has not refreshed yet, or the search, a filter or the ten-row
 * limit keeps a side out.
 */
export function transferRecordedNote(written: RecordedTransferNote, shown: number, listed: number): string {
  const what = written.number ? `Transfer ${written.number}` : 'The transfer';
  const first = `${what} is recorded: ${rm(written.amount)} from ${written.from} to ${written.to}, dated ${displayDate(written.date)}.`;
  if (shown >= 2) return `${first} Both sides are in the table below.`;
  if (listed < 2) return `${first} Both balances have changed.`;
  if (shown === 1) return `${first} One side is in the table below; clear the search and the filters, or choose View all, to see the other.`;
  return `${first} Clear the search and the filters, or choose View all, to see its two sides in the table below.`;
}
