/**
 * Expenses. An expense is one `finance_expenses` row: a date, a category, a
 * vendor (a contact or a typed name) and an amount with the SST inside it.
 * An owner or admin approves or rejects it, and an approved one is paid by a
 * payment voucher. This file only reads; the writes arrive with the form.
 * org_id comes from the context.
 */
import type { PaymentMethod } from './money';
import type { FinanceWriteContext } from './result';

/** What a person sets. */
export type ExpenseStatus = 'pending' | 'approved' | 'rejected';

/** How an expense reads: `paid` once posted money out covers an approved one. Never stored. */
export type ExpenseDisplayStatus = ExpenseStatus | 'paid';

export const EXPENSE_PAGE_SIZE = 1000;

export type ExpenseRow = {
  id: string;
  expense_date: string;
  category_id: string;
  category_name: string;
  vendor_id: string | null;
  vendor_name: string;
  /** What was paid or is to be paid, SST included. */
  amount: number;
  /** The part of `amount` that is SST. */
  sst_amount: number;
  notes: string | null;
  status: ExpenseStatus;
  display_status: ExpenseDisplayStatus;
  /** Posted money out against it. */
  paid: number;
  /** What payments not yet posted hold of it. */
  held: number;
  /** How the latest posted payment was made; null while nothing has been paid. */
  method: PaymentMethod | null;
  paid_on: string | null;
};

const EXPENSE_COLUMNS =
  'id,expense_date,category_id,category_name,vendor_id,vendor_name,amount,sst_amount,notes,status,display_status,' +
  'paid,held,method,paid_on';

/** Every expense in the workspace, newest first, read a page at a time. */
export async function listExpenses(ctx: FinanceWriteContext): Promise<ExpenseRow[]> {
  const rows: ExpenseRow[] = [];
  for (let from = 0; ; from += EXPENSE_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_expense_totals')
      .select(EXPENSE_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('expense_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + EXPENSE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => ({
        ...(row as unknown as ExpenseRow),
        amount: Number(row.amount),
        sst_amount: Number(row.sst_amount),
        paid: Number(row.paid),
        held: Number(row.held),
      })),
    );
    if (page.length < EXPENSE_PAGE_SIZE) return rows;
  }
}
