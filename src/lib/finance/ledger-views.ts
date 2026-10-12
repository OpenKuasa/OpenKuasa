/**
 * What the Chart of Accounts and Journals screens show, worked out from the rows the data layer reads: the
 * words, the groups, the filters, what a row's menu offers and the CSV files. Pure, with no server imports,
 * so the client views and the tests both use it.
 */
import { toCsv } from './csv';
import type { AccountStandsFor, AccountType, JournalRow, LedgerAccount, LedgerLine, LedgerSource } from './ledger';
import { round2, sum } from './view-helpers';

export const ACCOUNT_TYPE_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
};

export const STANDS_FOR_LABELS: Record<AccountStandsFor, string> = {
  system: 'System',
  bank: 'Bank or cash account',
  category: 'Category',
  own: 'Added by you',
};

export const SOURCE_LABELS: Record<LedgerSource, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  payment_in: 'Receipt',
  refund: 'Refund',
  bill: 'Supplier bill',
  payment_out: 'Payment',
  expense: 'Expense',
  transfer: 'Transfer',
  opening: 'Opening balance',
  journal: 'Manual journal',
};

/**
 * The screen each kind of entry comes from; a manual journal is on Journals itself. A receipt or payment opens
 * Cash Receipts or Payment Vouchers, which list every movement of money; Payments In and Payments Out list only
 * those against invoices and bills, so they would not find a receipt for other income.
 */
export const SOURCE_PATHS: Record<LedgerSource, string | null> = {
  invoice: '/finance/invoices',
  credit_note: '/finance/credit-notes',
  payment_in: '/finance/cash-receipts',
  refund: '/finance/refunds',
  bill: '/finance/supplier-bills',
  payment_out: '/finance/payment-vouchers',
  expense: '/finance/expenses',
  transfer: '/finance/banking',
  opening: '/finance/banking',
  journal: null,
};

/* ---- Chart of Accounts ------------------------------------------------ */

export type AccountAction = 'edit' | 'archive' | 'unarchive' | 'delete';

/**
 * What an account's row menu offers, in order: nothing without the sign-off. Any account can be renamed and
 * archived; only one the workspace added itself is deleted, since the others stand for a bank account, a
 * category or a system role. The database asks again (an account in use is archived, not deleted) and its
 * answer counts; this keeps the menu from offering what it would always refuse.
 */
export function accountActions(account: Pick<LedgerAccount, 'active' | 'stands_for'>, canSignOff: boolean): AccountAction[] {
  if (!canSignOff) return [];
  const actions: AccountAction[] = ['edit', account.active ? 'archive' : 'unarchive'];
  if (account.stands_for === 'own') actions.push('delete');
  return actions;
}

export type AccountGroup = { type: AccountType; label: string; accounts: LedgerAccount[]; total: number };

/** The accounts by kind in the order books list them, each kind's balances added up. A kind with no accounts has no group. */
export function groupAccounts(accounts: LedgerAccount[]): AccountGroup[] {
  return ACCOUNT_TYPE_ORDER.flatMap((type) => {
    const ofType = accounts.filter((a) => a.type === type);
    return ofType.length === 0
      ? []
      : [{ type, label: ACCOUNT_TYPE_LABELS[type], accounts: ofType, total: sum(ofType, (a) => a.balance) }];
  });
}

/** The trial balance: every account's debits and credits added up, and whether the two agree. */
export function trialBalance(accounts: LedgerAccount[]): { debit: number; credit: number; balanced: boolean } {
  const debit = sum(accounts, (a) => a.debit_total);
  const credit = sum(accounts, (a) => a.credit_total);
  return { debit, credit, balanced: debit === credit };
}

/** The accounts table as a CSV file. Amounts are numbers, so a spreadsheet can add them up. */
export function accountsCsv(accounts: LedgerAccount[]): string {
  return toCsv(
    ['Code', 'Name', 'Type', 'Stands for', 'Status', 'Debit', 'Credit', 'Balance'],
    accounts.map((a) => [
      a.code,
      a.name,
      ACCOUNT_TYPE_LABELS[a.type],
      STANDS_FOR_LABELS[a.stands_for],
      a.active ? 'Active' : 'Archived',
      a.debit_total,
      a.credit_total,
      a.balance,
    ]),
  );
}

/* ---- the ledger ------------------------------------------------------- */

export type LedgerEntryLine = LedgerLine & { account_code: string; account_name: string };

/** One document's (or journal's) lines together. */
export type LedgerEntry = {
  key: string;
  date: string;
  source: LedgerSource;
  source_id: string;
  source_no: string | null;
  description: string;
  lines: LedgerEntryLine[];
  debit: number;
  credit: number;
};

/**
 * The lines grouped into entries by their key, newest first (the same day in key order), each entry's debit
 * lines before its credit lines, and each line carrying its account's code and name. A line whose account is
 * not known has them empty.
 */
export function groupEntries(lines: LedgerLine[], accounts: Pick<LedgerAccount, 'id' | 'code' | 'name'>[]): LedgerEntry[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const entries = new Map<string, LedgerEntry>();
  for (const line of lines) {
    const account = line.account_id ? byId.get(line.account_id) : undefined;
    let entry = entries.get(line.entry_key);
    if (!entry) {
      entry = {
        key: line.entry_key,
        date: line.entry_date,
        source: line.source,
        source_id: line.source_id,
        source_no: line.source_no,
        description: line.description,
        lines: [],
        debit: 0,
        credit: 0,
      };
      entries.set(line.entry_key, entry);
    }
    entry.lines.push({ ...line, account_code: account?.code ?? '', account_name: account?.name ?? '' });
    entry.debit = round2(entry.debit + line.debit);
    entry.credit = round2(entry.credit + line.credit);
  }
  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      // Array.prototype.sort is stable, so lines on one side keep the order they were read in.
      lines: [...entry.lines].sort((a, b) => Number(b.debit > 0) - Number(a.debit > 0)),
    }))
    .sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date < b.date ? 1 : -1));
}

export type EntryFilter = {
  query: string;
  source: 'all' | LedgerSource;
  /** YYYY-MM-DD, or empty for no start. */
  from: string;
  /** YYYY-MM-DD, or empty for no end. */
  to: string;
  /** An account id; empty (or "all") for any account. */
  account: string;
};

/**
 * The entries matching every condition: the search text appears in the number, the description or the code
 * or name of any account on a line; the dates are inclusive; an account filter keeps an entry with a line on it.
 */
export function filterEntries(entries: LedgerEntry[], filter: EntryFilter): LedgerEntry[] {
  const q = filter.query.trim().toLowerCase();
  const anyAccount = filter.account === '' || filter.account === 'all';
  return entries.filter((entry) => {
    if (filter.source !== 'all' && entry.source !== filter.source) return false;
    if (filter.from !== '' && entry.date < filter.from) return false;
    if (filter.to !== '' && entry.date > filter.to) return false;
    if (!anyAccount && !entry.lines.some((l) => l.account_id === filter.account)) return false;
    if (q === '') return true;
    const text = [entry.source_no ?? '', entry.description, ...entry.lines.flatMap((l) => [l.account_code, l.account_name])]
      .join(' ')
      .toLowerCase();
    return text.includes(q);
  });
}

/** The ledger as a CSV file, one row per line. Amounts are numbers (0 on the side a line is not on). */
export function entriesCsv(entries: LedgerEntry[]): string {
  return toCsv(
    ['Date', 'No.', 'Source', 'Description', 'Account code', 'Account name', 'Debit', 'Credit'],
    entries.flatMap((entry) =>
      entry.lines.map((l) => [
        entry.date,
        entry.source_no,
        SOURCE_LABELS[entry.source],
        entry.description,
        l.account_code,
        l.account_name,
        l.debit,
        l.credit,
      ]),
    ),
  );
}

/* ---- Journals --------------------------------------------------------- */

export type JournalAction = 'edit' | 'post' | 'delete' | 'reverse';

/**
 * What a journal's row menu offers, in order: nothing without the sign-off. A draft is edited, posted or
 * deleted; a posted journal is reversed, once. The database asks again and its answer counts.
 */
export function journalActions(journal: Pick<JournalRow, 'status' | 'reversed'>, canSignOff: boolean): JournalAction[] {
  if (!canSignOff) return [];
  if (journal.status === 'draft') return ['edit', 'post', 'delete'];
  return journal.reversed ? [] : ['reverse'];
}

/* ---- shared by both screens ------------------------------------------- */

/**
 * The error to show in a screen's toolbar. A question asked in a row shows its own refusal in that row; but a
 * refusal that came because the row had gone or changed refreshes the page and takes the row with it, so the
 * message moves to the toolbar rather than vanish.
 */
export function toolbarError(error: string | null, questionOpen: boolean, questionInView: boolean): string | null {
  if (!error) return null;
  return questionOpen && questionInView ? null : error;
}

/** The account the address names (`?account=`) when it is one of the workspace's, otherwise none (empty). */
export function accountFromParam(param: string | null, accounts: { id: string }[]): string {
  return param && accounts.some((a) => a.id === param) ? param : '';
}
