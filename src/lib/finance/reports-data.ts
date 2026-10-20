/**
 * The light reads behind the aged tables on Reports: only the columns an aged table needs, and only the rows that
 * can be open, where listInvoices and listBills read every invoice and bill ever (and listBills three more tables).
 * The filters here are an optimisation; openReceivables and openPayables in reports.ts are the rule, and apply it again.
 */
import type { BillBalance, InvoiceBalance } from './reports';
import type { FinanceWriteContext } from './result';

export const OPEN_PAGE_SIZE = 1000;

// An aged table adds invoices up, so its balance is the invoice's balance in ringgit (its own balance for ringgit).
const INVOICE_COLUMNS = 'customer_id,customer_name,due_date,balance:balance_myr,display_status';
// And for bills (stage 4a). The open filter below stays on the bill's own balance column: PostgREST filters by
// column, not by the alias.
const BILL_COLUMNS = 'supplier_id,supplier_name,due_date,balance:balance_myr,display_status';

/** Every posted invoice with a balance that is not zero (a negative one is a customer in credit), a page at a time. Throws when a read fails. */
export async function listOpenInvoices(ctx: FinanceWriteContext): Promise<InvoiceBalance[]> {
  const rows: InvoiceBalance[] = [];
  for (let from = 0; ; from += OPEN_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_invoice_totals')
      .select(INVOICE_COLUMNS)
      .eq('org_id', ctx.orgId)
      .neq('balance_myr', 0)
      .in('display_status', ['sent', 'overdue', 'paid'])
      .order('due_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + OPEN_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((r) => ({ ...(r as unknown as InvoiceBalance), balance: Number(r.balance) })));
    if (page.length < OPEN_PAGE_SIZE) return rows;
  }
}

/** Every pending or overdue supplier bill with a balance above zero, a page at a time. Throws when a read fails. */
export async function listOpenBills(ctx: FinanceWriteContext): Promise<BillBalance[]> {
  const rows: BillBalance[] = [];
  for (let from = 0; ; from += OPEN_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('supplier_bill_totals')
      .select(BILL_COLUMNS)
      .eq('org_id', ctx.orgId)
      .gt('balance', 0)
      .in('display_status', ['pending', 'overdue'])
      .order('due_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + OPEN_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map((r) => ({ ...(r as unknown as BillBalance), balance: Number(r.balance) })));
    if (page.length < OPEN_PAGE_SIZE) return rows;
  }
}

/**
 * What the Balance Sheet's note and the FX Revaluation screen need to know about foreign money in the books
 * (stage 6b): the first date a foreign item entered them (a posted or voided foreign invoice or bill, a foreign
 * account's opening balance, a posted or voided movement on a foreign account), and the month ends that have a
 * posted FX revaluation (20261123100000). Four one-row reads ordered by date, and the runs' month ends. Throws
 * when a read fails; a caller then shows nothing for it.
 */
export type FxBooks = { firstForeignDate: string | null; revaluedMonthEnds: string[] };

export async function readFxBooks(ctx: FinanceWriteContext): Promise<FxBooks> {
  const foreign = (table: string, column: string) =>
    ctx.client.from(table).select(column).eq('org_id', ctx.orgId).neq('currency', 'MYR');
  const [invoices, bills, accounts, movements, runs] = await Promise.all([
    foreign('finance_invoices', 'invoice_date').in('status', ['posted', 'void']).order('invoice_date', { ascending: true }).limit(1),
    foreign('supplier_bills', 'bill_date').in('status', ['posted', 'void']).order('bill_date', { ascending: true }).limit(1),
    foreign('finance_accounts', 'opening_date').neq('opening_balance', 0).order('opening_date', { ascending: true }).limit(1),
    // A movement's currency is its account's (20261122110000), so this is money on a foreign account.
    foreign('finance_transactions', 'txn_date').in('status', ['posted', 'void']).order('txn_date', { ascending: true }).limit(1),
    ctx.client.from('finance_fx_revaluations').select('period_end').eq('org_id', ctx.orgId).order('period_end', { ascending: false }),
  ]);
  const error = invoices.error ?? bills.error ?? accounts.error ?? movements.error ?? runs.error;
  if (error) throw error;
  const dateOf = (rows: unknown, column: string) => ((rows ?? []) as Record<string, string>[]).map((r) => r[column]);
  const dates = [
    ...dateOf(invoices.data, 'invoice_date'),
    ...dateOf(bills.data, 'bill_date'),
    ...dateOf(accounts.data, 'opening_date'),
    ...dateOf(movements.data, 'txn_date'),
  ].sort();
  return {
    firstForeignDate: dates[0] ?? null,
    revaluedMonthEnds: [...new Set(dateOf(runs.data, 'period_end'))],
  };
}
