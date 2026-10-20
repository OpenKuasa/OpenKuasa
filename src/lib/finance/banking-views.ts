/**
 * What the Banking screen shows, worked out from the accounts and the
 * movements the data layer reads. Pure, with no server imports, so the client
 * view and the tests both use it. `today` is always a YYYY-MM-DD date.
 *
 * Only a posted movement changes a balance, so the table, the running
 * balance, the chart and the gauge are all built from posted rows.
 */
import type { BankAccountRow, BankTransactionKind, BankTransactionRow } from './banking';
import { BASE_CURRENCY } from './currencies';
import { toCsv } from './csv';
import { money, rm } from './format';
import { PAYMENT_METHOD_LABELS } from './money';
import { type Stat, count, displayDate, lastMonths, monthOf, round2, sum, thousands } from './view-helpers';

export const BANK_KIND_LABELS: Record<BankTransactionKind, string> = {
  invoice: 'Payment received',
  income: 'Receipt',
  bill: 'Supplier payment',
  refund: 'Refund',
  expense: 'Expense',
  other: 'Other payment',
  transfer: 'Transfer',
};

/**
 * One line that says what a movement was: a transfer names the account at
 * its other end; anything else names who paid or was paid, or failing that
 * what kind of movement it is, and then the documents it pays or its category.
 */
export function bankDescription(row: BankTransactionRow): string {
  if (row.kind === 'transfer') {
    const other = row.other_account_name ?? 'another account';
    // Stage 5c: a transfer between a ringgit account and one in another currency names what the other side moved,
    // in its own currency: "Transfer to USD Account (USD 1,000.00)".
    const otherSide =
      row.other_currency && row.other_currency !== row.currency && row.other_amount !== null
        ? ` (${money(row.other_amount, row.other_currency)})`
        : '';
    return row.direction === 'out' ? `Transfer to ${other}${otherSide}` : `Transfer from ${other}${otherSide}`;
  }
  const what = row.documents ?? row.category_name;
  const who = row.party_name ?? BANK_KIND_LABELS[row.kind];
  return what ? `${who} · ${what}` : who;
}

/** Money in adds to an account and money out takes from it, in the account's own currency. */
export function signedAmount(row: BankTransactionRow): number {
  return row.direction === 'in' ? row.amount : -row.amount;
}

/** The same in ringgit (stage 5a): what every total across accounts adds, since two accounts' currencies may differ. */
export function signedRinggit(row: BankTransactionRow): number {
  return row.direction === 'in' ? row.amount_myr : -row.amount_myr;
}

/** "≈ RM 44,620.00": an account's book value in ringgit, said under a balance in another currency; null for ringgit. */
export function ringgitNote(account: Pick<BankAccountRow, 'currency' | 'balance_myr'>): string | null {
  return account.currency === BASE_CURRENCY ? null : `≈ ${rm(account.balance_myr)}`;
}

export type Reconciliation = 'Reconciled' | 'Unreconciled';

/**
 * A posted movement with the balance of its account once it had happened, and
 * its reconciliation status: null (a dash) on a cash account and on a bank
 * account that has never had a statement imported, which has nothing to match.
 */
export type LedgerRow = BankTransactionRow & { balance: number; reconciliation: Reconciliation | null };

/** Plain code-unit comparison: `localeCompare` sorts `.` before `+`, which would swap two timestamps in one second. */
const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Oldest first: by date, then by when it was recorded, then by id, so two movements on one day keep one order. */
function byTime(x: BankTransactionRow, y: BankTransactionRow): number {
  return compare(x.txn_date, y.txn_date) || compare(x.created_at, y.created_at) || compare(x.transaction_id, y.transaction_id);
}

/** A bank account with a statement imported is one whose movements can be reconciled. */
const hasStatement = (account: BankAccountRow | undefined): boolean => account?.kind === 'bank' && account.last_import_at !== null;

/** What the account select calls an account: an archived one says so. */
export function accountOptionLabel(account: BankAccountRow): string {
  return account.active ? account.name : `${account.name} (archived)`;
}

/**
 * The posted movements, newest first, each with its account's balance after
 * it. An account starts from its opening balance, whatever its opening date:
 * the opening balance is the balance before anything recorded here. The
 * balance on the newest row of an account is therefore the account's balance.
 */
export function withRunningBalance(accounts: BankAccountRow[], rows: BankTransactionRow[]): LedgerRow[] {
  const running = new Map(accounts.map((a) => [a.id, a.opening_balance]));
  const statements = new Set(accounts.filter(hasStatement).map((a) => a.id));
  const posted = rows.filter((r) => r.status === 'posted').sort(byTime);
  const ledger = posted.map((row): LedgerRow => {
    const balance = round2((running.get(row.account_id) ?? 0) + signedAmount(row));
    running.set(row.account_id, balance);
    const reconciliation = row.account_kind === 'bank' && statements.has(row.account_id) ? (row.reconciled ? 'Reconciled' : 'Unreconciled') : null;
    return { ...row, balance, reconciliation };
  });
  return ledger.reverse();
}

export type AccountTile = {
  id: string;
  name: string;
  kind: 'bank' | 'cash';
  balance: string;
  /** Under the balance: when a statement was last imported, or that none has been. */
  note: string;
};

export type BankingViewData = {
  /** The first card: every account added up. */
  total: Stat;
  /** One per account that is active, or archived with money still in it. */
  tiles: AccountTile[];
  /** The last eight months, oldest first, in RM thousands: all accounts added up at the end of each month. */
  trend: { label: string; balance: number }[];
  /** Whether there is a balance to draw: an opening balance or a posted movement. */
  hasTrend: boolean;
  /**
   * Posted movements this month on bank accounts that have had a statement imported: how many have a statement
   * line matched to them. The label is empty while no bank account has had a statement imported.
   */
  gauge: { percent: number; label: string; reconciled: number; total: number };
  /** Whether any bank account has a posted movement this month. */
  hasGauge: boolean;
  /** What the gauge's card says when there is nothing to draw. */
  gaugeEmpty: string;
};

function statementNote(account: BankAccountRow): string {
  if (account.kind === 'cash') return 'Cash account';
  if (!account.last_import_at) return 'No statement yet';
  const imported = `Last import ${displayDate(account.last_import_at.slice(0, 10))}`;
  return account.unmatched_lines ? `${imported} · ${account.unmatched_lines} to match` : imported;
}

/** Under a tile's balance: its ringgit book value first for an account in another currency, then its statements. */
function accountNote(account: BankAccountRow): string {
  const ringgit = ringgitNote(account);
  return ringgit ? `${ringgit} · ${statementNote(account)}` : statementNote(account);
}

export function bankingView(accounts: BankAccountRow[], rows: BankTransactionRow[], today: string): BankingViewData {
  const posted = rows.filter((r) => r.status === 'posted');
  // Stage 5a: accounts may be in different currencies, so every total adds ringgit (each account's book value).
  const totalNow = sum(accounts, (a) => a.balance_myr);
  // Scheduled money out is on ringgit accounts only (a foreign one is paid now), so this is ringgit already.
  const toBePaid = sum(accounts, (a) => a.to_be_paid);
  const shown = accounts.filter((a) => a.active || a.balance !== 0);

  // The balance at the end of a month is today's balance with everything dated after that month taken back out.
  const trend = lastMonths(today).map(({ key, label }) => {
    const later = posted.filter((r) => monthOf(r.txn_date) > key);
    return { label, balance: thousands(totalNow - sum(later, signedRinggit)) };
  });

  const month = lastMonths(today, 1)[0];
  const statements = new Set(accounts.filter(hasStatement).map((a) => a.id));
  const atBank = posted.filter((r) => r.account_kind === 'bank' && statements.has(r.account_id) && monthOf(r.txn_date) === month.key);
  const reconciled = atBank.filter((r) => r.reconciled).length;
  // Never 100 while something is unmatched, never 0 while something is matched.
  const raw = atBank.length ? Math.round((reconciled / atBank.length) * 100) : 0;
  const percent = reconciled === 0 || reconciled === atBank.length ? raw : Math.min(99, Math.max(1, raw));

  return {
    total: {
      label: 'Total cash',
      value: rm(totalNow),
      delta: toBePaid > 0 ? `${rm(toBePaid)} to be paid` : count(shown.length, 'account'),
      deltaTone: 'flat',
    },
    tiles: shown.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: money(a.balance, a.currency), note: accountNote(a) })),
    trend,
    hasTrend: posted.length > 0 || accounts.some((a) => a.opening_balance !== 0),
    gauge: {
      percent,
      label: statements.size ? `${reconciled} of ${count(atBank.length, `${month.label} movement`)}` : '',
      reconciled,
      total: atBank.length,
    },
    hasGauge: atBank.length > 0,
    gaugeEmpty: statements.size ? 'No bank movements this month to reconcile.' : 'No statement imported yet.',
  };
}

/** A cash account, or a bank account with no statement imported, has nothing to match: null. */
export function reconcileLabel(row: LedgerRow): Reconciliation | null {
  return row.reconciliation;
}

export type BankFilter = 'all' | 'reconciled' | 'unreconciled';

/**
 * Ledger rows of one account (or of all), matching the reconciliation
 * filter, whose description, number, reference or account contains the
 * search text. A cash movement shows under `all` only.
 */
export function filterLedger(rows: LedgerRow[], query: string, accountId: string = 'all', filter: BankFilter = 'all'): LedgerRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (accountId === 'all' || r.account_id === accountId) &&
      (filter === 'all' || reconcileLabel(r)?.toLowerCase() === filter) &&
      `${bankDescription(r)} ${r.number ?? ''} ${r.reference ?? ''} ${r.account_name}`.toLowerCase().includes(q),
  );
}

/**
 * The table as a CSV file, its columns in the table's order. Amounts are numbers, so a spreadsheet can add them up.
 * Each amount is in its account's currency; once a movement in another currency is listed, a Currency and a
 * Ringgit column are appended (a ringgit-only file reads as it always has).
 */
export function bankingCsv(rows: LedgerRow[]): string {
  const foreign = rows.some((r) => r.currency !== BASE_CURRENCY);
  return toCsv(
    [
      'Date', 'No.', 'Description', 'Account', 'Method', 'Reference', 'Money In', 'Money Out', 'Account balance', 'Status',
      ...(foreign ? ['Currency', 'Ringgit'] : []),
    ],
    rows.map((r) => [
      r.txn_date,
      r.number,
      bankDescription(r),
      r.account_name,
      PAYMENT_METHOD_LABELS[r.method],
      r.reference,
      r.direction === 'in' ? r.amount : null,
      r.direction === 'out' ? r.amount : null,
      r.balance,
      reconcileLabel(r),
      ...(foreign ? [r.currency, r.amount_myr] : []),
    ]),
  );
}
