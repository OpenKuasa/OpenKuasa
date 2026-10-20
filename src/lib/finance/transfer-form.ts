/**
 * The transfer form's rules, and every sentence Banking says about a
 * transfer, kept out of the components so they can be tested. Pure, with no
 * server imports.
 *
 * Only someone who may sign off (an owner or admin, decided on the server) is
 * given the form or the "Void transfer" menu; nothing here decides that.
 *
 * Stage 5c (20261122120000): a transfer goes between a ringgit account and an
 * account in another currency, either way, or between two ringgit accounts.
 * With an account in another currency it moves two amounts, each in its own
 * account's currency: what left and what arrived. The rate is not typed: it
 * is what the two amounts say, shown as a note. Money is worked in whole sen
 * (bigint), never with floating-point arithmetic.
 */
import type { BankAccountRow, BankTransactionRow } from './banking';
import { BASE_CURRENCY, minorUnits, quoteUnit } from './currencies';
import { CURRENCY_MESSAGES } from './document-currency';
import { money, typedNumber } from './format';
import { ringgitOf, senFromNumber, transferRateScaled } from './fx-settlement';
import { TRANSFER_MESSAGES, recordTransferInput } from './transfers';
import { displayDate } from './view-helpers';

const M = TRANSFER_MESSAGES;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const TEN_THOUSAND = BigInt(10_000);
const MILLION = BigInt(1_000_000);

export type TransferForm = {
  /** The account the money leaves; empty until one is chosen. */
  from: string;
  /** The account the money goes to; empty until one is chosen. */
  to: string;
  /** The amount as typed, in the "From" account's currency. */
  amount: string;
  /** Stage 5c: what arrived, as typed, in the "To" account's currency; used only when the two currencies differ. */
  toAmount: string;
  /** The date the money moved, YYYY-MM-DD. */
  date: string;
  reference: string;
  notes: string;
};

type AccountCurrency = Pick<BankAccountRow, 'id' | 'currency'>;

/**
 * What a person typed into an amount box, in whole sen, rounded half up to two places as the database rounds it;
 * null when it is not a plain number (digits with an optional point: "1,500" and "-5" are not).
 */
export function typedSen(value: string): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const fraction = m[2] ?? '';
  const sen = BigInt(`${m[1] || '0'}${fraction.slice(0, 2).padEnd(2, '0')}`);
  return fraction.length > 2 && fraction[2] >= '5' ? sen + ONE : sen;
}

/** An account's currency; ringgit when it is not found. */
function currencyOf(accounts: AccountCurrency[], id: string): string {
  return accounts.find((a) => a.id === id)?.currency ?? BASE_CURRENCY;
}

/**
 * The accounts a transfer can use: every active one, in the order the screen lists them. Stage 5c: one in another
 * currency too; which pairs are allowed is "To"'s business (transferToOptions).
 */
export function transferAccounts(accounts: BankAccountRow[]): BankAccountRow[] {
  return accounts.filter((a) => a.active);
}

/**
 * A transfer needs two accounts to move money between, one of them in ringgit: two accounts in other currencies
 * cannot move money between them directly (FIN52).
 */
export function canTransfer(accounts: BankAccountRow[]): boolean {
  const active = transferAccounts(accounts);
  return active.length >= 2 && active.some((a) => a.currency === BASE_CURRENCY);
}

/** A fresh form: nothing chosen, dated the person's own date. */
export function newTransferForm(today: string): TransferForm {
  return { from: '', to: '', amount: '', toAmount: '', date: today, reference: '', notes: '' };
}

/**
 * What "To" offers: every active account but the one chosen in "From"; when "From" is in another currency, ringgit
 * accounts only (a transfer goes between a ringgit account and another: FIN52).
 */
export function transferToOptions(accounts: BankAccountRow[], from: string): BankAccountRow[] {
  const fromForeign = from !== '' && currencyOf(accounts, from) !== BASE_CURRENCY;
  return transferAccounts(accounts).filter((a) => a.id !== from && (!fromForeign || a.currency === BASE_CURRENCY));
}

/**
 * The form after "From" was chosen: "To" is cleared when it now names the same account, or when both would be in
 * other currencies, so the screen never holds a pair that cannot be sent.
 */
export function withTransferFrom(form: TransferForm, from: string, accounts: AccountCurrency[]): TransferForm {
  const bothForeign =
    form.to !== '' && currencyOf(accounts, from) !== BASE_CURRENCY && currencyOf(accounts, form.to) !== BASE_CURRENCY;
  return { ...form, from, to: form.to === from || bothForeign ? '' : form.to };
}

/** Stage 5c: true when "From" and "To" are both chosen and their currencies differ, so what arrived is typed too. */
export function needsTwoAmounts(form: Pick<TransferForm, 'from' | 'to'>, accounts: AccountCurrency[]): boolean {
  return form.from !== '' && form.to !== '' && currencyOf(accounts, form.from) !== currencyOf(accounts, form.to);
}

/** A typed amount as sent: rounded to the sen from its text; anything else as typed (NaN for no number), for the schema. */
function sentAmount(text: string): number {
  const sen = typedSen(text);
  return sen === null ? (typedNumber(text) ?? Number.NaN) : ringgitOf(sen);
}

/**
 * What is sent to recordTransferAction. A box that is not a number goes as NaN, which the schema refuses.
 * `to_amount` is sent only when the two accounts' currencies differ: between two ringgit accounts the payload is
 * what it always was. A plain number is rounded to the sen from its text (half up, as the database rounds), so
 * what is sent, what the notes say (recordedTransfer) and what is booked are one figure: "1.005" goes as 1.01.
 */
export function transferPayload(form: TransferForm, accounts: AccountCurrency[]) {
  return {
    from_account_id: form.from,
    to_account_id: form.to,
    amount: sentAmount(form.amount),
    ...(needsTwoAmounts(form, accounts) ? { to_amount: sentAmount(form.toAmount) } : {}),
    txn_date: form.date,
    reference: form.reference,
    notes: form.notes,
  };
}

/** An amount with a fraction typed for a currency with no minor unit (JPY): its sentence; null otherwise. */
function wholeUnitsProblem(text: string, currency: string): string | null {
  if (minorUnits(currency) !== 0) return null;
  const sen = typedSen(text);
  return sen !== null && sen % HUNDRED !== ZERO ? CURRENCY_MESSAGES.wholeUnits(currency) : null;
}

/** The first thing wrong with the form, in the schema's own sentence, or null when it can be sent. */
export function transferFormError(form: TransferForm, accounts: AccountCurrency[]): string | null {
  if (!form.from) return M.from;
  if (!form.to) return M.to;
  const fromCurrency = currencyOf(accounts, form.from);
  const toCurrency = currencyOf(accounts, form.to);
  if (form.from !== form.to && fromCurrency !== BASE_CURRENCY && toCurrency !== BASE_CURRENCY) return M.twoForeign;
  const parsed = recordTransferInput.safeParse(transferPayload(form, accounts));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  return (
    wholeUnitsProblem(form.amount, fromCurrency) ??
    (needsTwoAmounts(form, accounts) ? wholeUnitsProblem(form.toAmount, toCurrency) : null)
  );
}

/** A rate in 10^-10 units shown to four places, half up. */
function fourPlaces(scaled: bigint): string {
  const q = (scaled * TWO + MILLION) / (MILLION * TWO);
  return `${q / TEN_THOUSAND}.${(q % TEN_THOUSAND).toString().padStart(4, '0')}`;
}

/**
 * Stage 5c: the rate the two amounts say, before it is recorded: "RM 4.4620 per 1 USD" (per 100 for a currency
 * BNM quotes per 100: "RM 0.0284 per 100 IDR"), to four places. The database keeps it to ten
 * (round(ringgit / foreign, 10)) on the side in the other currency. Null between two accounts in one currency, or
 * while either amount is not a number above 0.
 */
export function transferRateNote(form: TransferForm, accounts: AccountCurrency[]): string | null {
  if (!needsTwoAmounts(form, accounts)) return null;
  const fromCurrency = currencyOf(accounts, form.from);
  const leaving = typedSen(form.amount);
  const arriving = typedSen(form.toAmount);
  if (leaving === null || arriving === null || leaving <= ZERO || arriving <= ZERO) return null;
  const fromRinggit = fromCurrency === BASE_CURRENCY;
  const ringgit = fromRinggit ? leaving : arriving;
  const foreign = fromRinggit ? arriving : leaving;
  const currency = fromRinggit ? currencyOf(accounts, form.to) : fromCurrency;
  const unit = quoteUnit(currency);
  return `RM ${fourPlaces(transferRateScaled(ringgit, foreign) * BigInt(unit))} per ${unit} ${currency}`;
}

/**
 * What to say, before it is recorded, when the transfer is for more than the "From" account holds, in that
 * account's currency: null when the account covers it, when no account is chosen, or while the amount is not a
 * number above 0. It is a note, not a refusal: an overdraft is a real thing, and the balance on screen can be a
 * moment old.
 */
export function transferOverdrawNote(form: TransferForm, accounts: BankAccountRow[]): string | null {
  const account = accounts.find((a) => a.id === form.from);
  const amount = typedSen(form.amount);
  if (!account || amount === null || amount <= ZERO) return null;
  const balance = senFromNumber(account.balance);
  const after = balance - amount;
  if (after >= ZERO) return null;
  const shown = (sen: bigint) => money(ringgitOf(sen), account.currency);
  if (balance < ZERO) {
    return `${account.name} is already overdrawn by ${shown(-balance)}. This transfer takes that to ${shown(-after)}.`;
  }
  return `${account.name} holds ${shown(balance)}. This transfer leaves it overdrawn by ${shown(-after)}.`;
}

/** One side of a posted transfer, as the Transactions table holds it. */
type TransferSide = Pick<
  BankTransactionRow,
  'transaction_id' | 'transfer_id' | 'direction' | 'amount' | 'number' | 'txn_date' | 'account_name' | 'other_account_name' | 'reconciled' | 'kind'
> &
  Partial<Pick<BankTransactionRow, 'currency' | 'other_currency' | 'other_amount'>>;

/** The two accounts of a transfer, read from either side's row. */
export function transferEnds(row: TransferSide): { from: string; to: string } {
  const other = row.other_account_name ?? 'another account';
  return row.direction === 'out' ? { from: row.account_name, to: other } : { from: other, to: row.account_name };
}

/**
 * What left and what arrived, each in its own account's currency, read from either side's row. A row that names
 * no currencies is ringgit on both sides, one amount.
 */
function transferAmounts(row: TransferSide): { left: string; arrived: string; twoCurrencies: boolean } {
  const mine = { amount: row.amount, currency: row.currency ?? BASE_CURRENCY };
  const other = { amount: row.other_amount ?? row.amount, currency: row.other_currency ?? mine.currency };
  const out = row.direction === 'out' ? mine : other;
  const inn = row.direction === 'out' ? other : mine;
  return { left: money(out.amount, out.currency), arrived: money(inn.amount, inn.currency), twoCurrencies: out.currency !== inn.currency };
}

/**
 * How a transfer is named in a question and to a screen reader: "TR-0004 of RM 500.00 from Main Bank to Savings";
 * with an account in another currency both amounts, "TR-0005 of RM 4,462.00 from Maybank to USD Account as
 * USD 1,000.00".
 */
export function transferName(row: TransferSide): string {
  const { from, to } = transferEnds(row);
  const { left, arrived, twoCurrencies } = transferAmounts(row);
  return `${row.number ?? 'the transfer'} of ${left} from ${from} to ${to}${twoCurrencies ? ` as ${arrived}` : ''}`;
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
  const { left, arrived, twoCurrencies } = transferAmounts(row);
  const back = twoCurrencies
    ? `${left} goes back into ${from} and ${arrived} comes out of ${to}`
    : `${left} goes back into ${from} and comes out of ${to}`;
  const parts = [`Both sides are voided: ${back}. It keeps its number, and this cannot be undone.`];
  const matched = rows.filter((r) => r.transfer_id === row.transfer_id && r.reconciled).length;
  if (matched === 1) parts.push('A statement line is matched to it; that line goes back to unmatched.');
  if (matched > 1) parts.push('Statement lines are matched to both sides; they go back to unmatched.');
  return parts.join(' ');
}

/** What the screen says once a transfer was voided. Its rows have left the table, which lists posted movements only. */
export function transferVoidedNote(row: TransferSide): string {
  const { from, to } = transferEnds(row);
  const { left, arrived, twoCurrencies } = transferAmounts(row);
  const back = twoCurrencies ? `${left} is back in ${from} and ${arrived} out of ${to}` : `${left} is back in ${from} and out of ${to}`;
  return `Transfer ${transferName(row)} is voided: ${back}. A voided transfer is not listed in the table below.`;
}

/** A transfer that was just recorded, kept so the note can be worked out again whenever the table changes. */
export type RecordedTransferNote = {
  transferId: string;
  number: string | null;
  /** What left, in the "From" account's currency. */
  amount: number;
  date: string;
  from: string;
  to: string;
  /** Stage 5c, only when the two accounts' currencies differ: what arrived, and both currencies. */
  arrived?: { amount: number; fromCurrency: string; toCurrency: string };
};

/** What to remember of a transfer the form just recorded. `form` is what was sent; the names are the accounts' own. */
export function recordedTransfer(
  form: TransferForm,
  accounts: BankAccountRow[],
  saved: { transfer_id: string; number: string | null },
): RecordedTransferNote {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'another account';
  const stored = (text: string) => ringgitOf(typedSen(text) ?? ZERO);
  return {
    transferId: saved.transfer_id,
    number: saved.number,
    amount: stored(form.amount),
    date: form.date,
    from: name(form.from),
    to: name(form.to),
    ...(needsTwoAmounts(form, accounts)
      ? { arrived: { amount: stored(form.toAmount), fromCurrency: currencyOf(accounts, form.from), toCurrency: currencyOf(accounts, form.to) } }
      : {}),
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
  const left = money(written.amount, written.arrived?.fromCurrency ?? BASE_CURRENCY);
  const arrived = written.arrived ? ` as ${money(written.arrived.amount, written.arrived.toCurrency)}` : '';
  const first = `${what} is recorded: ${left} from ${written.from} to ${written.to}${arrived}, dated ${displayDate(written.date)}.`;
  if (shown >= 2) return `${first} Both sides are in the table below.`;
  if (listed < 2) return `${first} Both balances have changed.`;
  if (shown === 1) return `${first} One side is in the table below; clear the search and the filters, or choose View all, to see the other.`;
  return `${first} Clear the search and the filters, or choose View all, to see its two sides in the table below.`;
}
