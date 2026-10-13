/**
 * The light reads behind the aged tables on Reports: only the columns an aged table needs, and only the rows that
 * can be open, where listInvoices and listBills read every invoice and bill ever (and listBills three more tables).
 * The filters here are an optimisation; openReceivables and openPayables in reports.ts are the rule, and apply it again.
 */
import type { BillBalance, InvoiceBalance } from './reports';
import type { FinanceWriteContext } from './result';

export const OPEN_PAGE_SIZE = 1000;

const INVOICE_COLUMNS = 'customer_id,customer_name,due_date,balance,display_status';
const BILL_COLUMNS = 'supplier_id,supplier_name,due_date,balance,display_status';

/** Every posted invoice with a balance that is not zero (a negative one is a customer in credit), a page at a time. Throws when a read fails. */
export async function listOpenInvoices(ctx: FinanceWriteContext): Promise<InvoiceBalance[]> {
  const rows: InvoiceBalance[] = [];
  for (let from = 0; ; from += OPEN_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_invoice_totals')
      .select(INVOICE_COLUMNS)
      .eq('org_id', ctx.orgId)
      .neq('balance', 0)
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
