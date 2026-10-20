/**
 * Banking: the workspace's bank and cash accounts with their balances, and
 * every movement of money on them, one row each, the two sides of a transfer
 * between accounts included. This file only reads; accounts, transfers and
 * statements are written by forms that arrive later. org_id comes from the
 * context.
 */
import type { CashBookStatus } from './cash-book';
import { PAYMENT_PAGE_SIZE, type PaymentMethod } from './money';
import type { FinanceWriteContext } from './result';

/**
 * One account, archived ones included, with what the database works out for it. It has the bank's name and no
 * account number: `finance_accounts.account_no` is not readable through the table or this view, and a writer who
 * needs it asks `finance_account_numbers(target_org)`: the Banking loader does so for someone who may write, who sees the
 * end of each number in the Accounts table and the whole of one in the account form.
 */
export type BankAccountRow = {
  id: string;
  name: string;
  kind: 'bank' | 'cash';
  bank_name: string | null;
  /** The balance before anything was recorded here. */
  opening_balance: number;
  opening_date: string;
  active: boolean;
  /** Opening balance, plus posted money in, less posted money out. */
  balance: number;
  /** Scheduled money out: allowed to be paid, not paid yet. */
  to_be_paid: number;
  /** When a statement was last imported for it; null when none has been. */
  last_import_at: string | null;
  /** Lines of its statements that no movement is matched to yet. */
  unmatched_lines: number;
  /**
   * Stage 5a. The account's currency, chosen when it was added. `opening_balance`, `balance` and `to_be_paid` are
   * in it; ringgit is MYR.
   */
  currency: string;
  /** The opening balance's rate per one unit, exact (`opening_rate::text`); "1.0000000000" on ringgit, null with no balance. */
  opening_rate_text: string | null;
  opening_rate_source: 'bnm' | 'manual' | null;
  opening_rate_date: string | null;
  /** The opening balance in ringgit at its rate. */
  opening_balance_myr: number;
  /** The book value in ringgit: the opening balance and every posted movement, each at its own rate. */
  balance_myr: number;
};

/**
 * What a movement is. The first six are the cash book's kinds: money in
 * against invoices or for an income category; money out to a supplier, back
 * to a customer, for approved expenses, or for an expense category.
 * `transfer` is one side of a transfer between two accounts.
 */
export type BankTransactionKind = 'invoice' | 'income' | 'bill' | 'refund' | 'expense' | 'other' | 'transfer';

/** One movement of money. `transaction_id` is the row's key. Every status is included; callers filter. */
export type BankTransactionRow = {
  transaction_id: string;
  account_id: string;
  account_name: string;
  account_kind: 'bank' | 'cash';
  direction: 'in' | 'out';
  txn_date: string;
  amount: number;
  status: CashBookStatus;
  /** Both sides of a transfer carry the same `TR-` number. */
  number: string | null;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  /** Who paid or was paid: the contact's name, or the name that was typed. A transfer names nobody. */
  party_name: string | null;
  kind: BankTransactionKind;
  category_name: string | null;
  /** The numbers of the bills, invoices or credit notes it pays. */
  documents: string | null;
  transfer_id: string | null;
  /** The account at the other end of a transfer. */
  other_account_name: string | null;
  /** A statement line is matched to it. */
  reconciled: boolean;
  /** When it was recorded: the order of two movements on one day. */
  created_at: string;
  /** Stage 5a. The movement's currency, always its account's: `amount` is in it. */
  currency: string;
  /** Its rate per one unit, exact (`fx_rate::text`); "1.0000000000" on a ringgit account. */
  fx_rate_text: string | null;
  fx_rate_source: 'bnm' | 'manual' | 'transfer' | null;
  /** The movement in ringgit: the amount itself on a ringgit account. */
  amount_myr: number;
  /** The other side of a transfer: its account's currency and its amount (equal to this side's between two ringgit accounts). */
  other_currency: string | null;
  other_amount: number | null;
};

const ACCOUNT_COLUMNS =
  'id,name,kind,bank_name,opening_balance,opening_date,active,balance,to_be_paid,last_import_at,unmatched_lines,' +
  'currency,opening_rate_text:opening_rate::text,opening_rate_source,opening_rate_date,opening_balance_myr,balance_myr';
const TRANSACTION_COLUMNS =
  'transaction_id,account_id,account_name,account_kind,direction,txn_date,amount,status,number,method,reference,notes,' +
  'party_name,kind,category_name,documents,transfer_id,other_account_name,reconciled,created_at,' +
  'currency,fx_rate_text:fx_rate::text,fx_rate_source,amount_myr,other_currency,other_amount';

/** Every account of the workspace, bank accounts first, then by name. */
export async function listBankAccounts(ctx: FinanceWriteContext): Promise<BankAccountRow[]> {
  const { data, error } = await ctx.client
    .from('finance_account_balances')
    .select(ACCOUNT_COLUMNS)
    .eq('org_id', ctx.orgId)
    .order('kind', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    ...(row as unknown as BankAccountRow),
    opening_balance: Number(row.opening_balance),
    balance: Number(row.balance),
    to_be_paid: Number(row.to_be_paid),
    unmatched_lines: Number(row.unmatched_lines),
    currency: (row.currency as string | null | undefined) ?? 'MYR',
    opening_rate_text: (row.opening_rate_text as string | null | undefined) ?? null,
    opening_rate_source: (row.opening_rate_source as 'bnm' | 'manual' | null | undefined) ?? null,
    opening_rate_date: (row.opening_rate_date as string | null | undefined) ?? null,
    opening_balance_myr: Number(row.opening_balance_myr ?? row.opening_balance),
    balance_myr: Number(row.balance_myr ?? row.balance),
  }));
}

/** Every movement of money in the workspace, newest first, read a page at a time. */
export async function listBankTransactions(ctx: FinanceWriteContext): Promise<BankTransactionRow[]> {
  const rows: BankTransactionRow[] = [];
  for (let from = 0; ; from += PAYMENT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_bank_transactions')
      .select(TRANSACTION_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('txn_date', { ascending: false })
      .order('transaction_id', { ascending: true })
      .range(from, from + PAYMENT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as BankTransactionRow),
        amount: Number(row.amount),
        currency: (row.currency as string | null | undefined) ?? 'MYR',
        fx_rate_text: (row.fx_rate_text as string | null | undefined) ?? null,
        fx_rate_source: (row.fx_rate_source as BankTransactionRow['fx_rate_source'] | undefined) ?? null,
        amount_myr: Number(row.amount_myr ?? row.amount),
        other_currency: (row.other_currency as string | null | undefined) ?? null,
        other_amount: row.other_amount === null || row.other_amount === undefined ? null : Number(row.other_amount),
      })),
    );
    if (page.length < PAYMENT_PAGE_SIZE) break;
  }
  // A movement recorded between two page requests can arrive on both: keep the first.
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.transaction_id) && !!seen.add(row.transaction_id));
}
