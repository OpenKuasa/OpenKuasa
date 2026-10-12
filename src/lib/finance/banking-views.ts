/**
 * What the Banking screen shows, worked out from the accounts and the
 * movements the data layer reads. Pure, with no server imports, so the client
 * view and the tests both use it. `today` is always a YYYY-MM-DD date.
 *
 * Only a posted movement changes a balance, so the table, the running
 * balance, the chart and the gauge are all built from posted rows.
 */
import type { BankAccountRow, BankTransactionKind, BankTransactionRow } from './banking';
import { toCsv } from './csv';
import { rm, rmShort } from './format';
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
    return row.direction === 'out' ? `Transfer to ${other}` : `Transfer from ${other}`;
  }
  const what = row.documents ?? row.category_name;
  const who = row.party_name ?? BANK_KIND_LABELS[row.kind];
  return what ? `${who} · ${what}` : who;
}

/** Money in adds to an account and money out takes from it. */
export function signedAmount(row: BankTransactionRow): number {
  return row.direction === 'in' ? row.amount : -row.amount;
}

/** A posted movement with the balance of its account once it had happened. */
export type LedgerRow = BankTransactionRow & { balance: number };

/** Oldest first: by date, then by when it was recorded, then by id, so two movements on one day keep one order. */
function byTime(x: BankTransactionRow, y: BankTransactionRow): number {
  return (
    x.txn_date.localeCompare(y.txn_date) ||
    x.created_at.localeCompare(y.created_at) ||
    x.transaction_id.localeCompare(y.transaction_id)
  );
}

/**
 * The posted movements, newest first, each with its account's balance after
 * it. An account starts from its opening balance, whatever its opening date:
 * the opening balance is the balance before anything recorded here. The
 * balance on the newest row of an account is therefore the account's balance.
 */
export function withRunningBalance(accounts: BankAccountRow[], rows: BankTransactionRow[]): LedgerRow[] {
  const running = new Map(accounts.map((a) => [a.id, a.opening_balance]));
  const posted = rows.filter((r) => r.status === 'posted').sort(byTime);
  const ledger = posted.map((row) => {
    const balance = round2((running.get(row.account_id) ?? 0) + signedAmount(row));
    running.set(row.account_id, balance);
    return { ...row, balance };
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
  /** Posted movements on bank accounts dated this month: how many have a statement line matched to them. */
  gauge: { percent: number; label: string; reconciled: number; total: number };
  /** Whether any bank account has a posted movement this month. */
  hasGauge: boolean;
};

function accountNote(account: BankAccountRow): string {
  if (account.kind === 'cash') return 'Cash account';
  if (!account.last_import_at) return 'No statement yet';
  const imported = `Last import ${displayDate(account.last_import_at.slice(0, 10))}`;
  return account.unmatched_lines ? `${imported} · ${account.unmatched_lines} to match` : imported;
}

export function bankingView(accounts: BankAccountRow[], rows: BankTransactionRow[], today: string): BankingViewData {
  const posted = rows.filter((r) => r.status === 'posted');
  const totalNow = sum(accounts, (a) => a.balance);
  const toBePaid = sum(accounts, (a) => a.to_be_paid);
  const shown = accounts.filter((a) => a.active || a.balance !== 0);

  // The balance at the end of a month is today's balance with everything dated after that month taken back out.
  const trend = lastMonths(today).map(({ key, label }) => {
    const later = posted.filter((r) => monthOf(r.txn_date) > key);
    return { label, balance: thousands(totalNow - sum(later, signedAmount)) };
  });

  const month = lastMonths(today, 1)[0];
  const atBank = posted.filter((r) => r.account_kind === 'bank' && monthOf(r.txn_date) === month.key);
  const reconciled = atBank.filter((r) => r.reconciled).length;

  return {
    total: {
      label: 'Total cash',
      value: rmShort(totalNow),
      delta: toBePaid > 0 ? `${rm(toBePaid)} to be paid` : count(shown.length, 'account'),
      deltaTone: 'flat',
    },
    tiles: shown.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: rmShort(a.balance), note: accountNote(a) })),
    trend,
    hasTrend: posted.length > 0 || accounts.some((a) => a.opening_balance !== 0),
    gauge: {
      percent: atBank.length ? Math.round((reconciled / atBank.length) * 100) : 0,
      label: `${reconciled} of ${count(atBank.length, `${month.label} movement`)}`,
      reconciled,
      total: atBank.length,
    },
    hasGauge: atBank.length > 0,
  };
}

/** A cash account has no statement, so its movements have no reconciliation status: null. */
export function reconcileLabel(row: BankTransactionRow): 'Reconciled' | 'Unreconciled' | null {
  if (row.account_kind === 'cash') return null;
  return row.reconciled ? 'Reconciled' : 'Unreconciled';
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

/** The table as a CSV file, its columns in the table's order. Amounts are numbers, so a spreadsheet can add them up. */
export function bankingCsv(rows: LedgerRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Description', 'Account', 'Method', 'Reference', 'Money In', 'Money Out', 'Balance', 'Status'],
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
    ]),
  );
}
