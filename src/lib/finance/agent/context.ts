import type { SupabaseClient } from '@supabase/supabase-js';
import { readBack, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import { FINANCE_FOCUS } from '@/lib/agents/types';
import { FINANCE_FOCUS_MENU } from '@/lib/finance/agent/checks';
import { BASE_CURRENCY } from '@/lib/finance/currencies';

/** An SST tax type a workspace can be registered for. */
export type FinanceAgentTaxType = 'service' | 'sales';

/**
 * Everything Bendahara's scan needs, read once per run with the service client. Amounts are
 * ringgit: invoices and bills carry the views' `balance_myr`; expenses and bank lines their
 * stored ringgit. Names are plain data (never escaped here).
 */
export type FinanceAgentRaw = {
  /** Null unless the owner confirmed a focus (`focus_confirmed_at` is set). */
  plan: FocusPlan | null;
  /** Posted invoices (shown Sent or Overdue) that still have money owed. */
  invoices: { id: string; invoiceNo: string | null; customer: string | null; dueDate: string | null; balance: number }[];
  /** Posted supplier bills (shown Pending or Overdue) that still have money to pay. */
  bills: { id: string; billNo: string | null; supplier: string | null; dueDate: string | null; balance: number }[];
  /** Draft invoices and draft supplier bills, with when they were last changed. */
  drafts: { kind: 'invoice' | 'bill'; id: string; party: string | null; updatedAt: string }[];
  /** Expense claims still waiting for approval. */
  expenses: { id: string; amount: number; vendor: string | null; createdAt: string }[];
  /** Quotations sent and not yet answered. */
  quotations: { id: string; quotationNo: string | null; customer: string | null; validUntil: string | null }[];
  /** Imported statement lines on active accounts with nothing matched; `amount` is money in or out, in the account's `currency`. */
  bankLines: { accountId: string; account: string; currency: string; lineDate: string; amount: number }[];
  /** Null when the workspace has no SST settings or no registration number. */
  sst: {
    periodStartMonth: number;
    taxes: FinanceAgentTaxType[];
    /** Returns marked filed, by tax type and period start. */
    filed: { taxType: string; periodStart: string }[];
  } | null;
};

/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;

type Rows = { data: unknown[] | null; error: unknown };

/** Throws on any read error, so a run never works from a partial snapshot. */
function rowsOf(result: Rows): Record<string, unknown>[] {
  if (result.error) throw result.error;
  return (result.data ?? []) as Record<string, unknown>[];
}

/** Reads every page of a query, so the 1000-row response cap cannot hide older rows. */
async function readAll(page: (from: number, to: number) => PromiseLike<Rows>): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = rowsOf(await page(from, from + PAGE - 1));
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Service-role read of the workspace for Bendahara's agent. Reads ONLY the columns
 * `service_role` was granted for it (the finance agent service-reads migration); add a grant
 * before adding a column here. `service` MUST be the service-role client.
 */
export async function buildFinanceAgentContext(
  service: SupabaseClient,
  orgId: string,
): Promise<{ context: string; raw: FinanceAgentRaw }> {
  const config = await service
    .from('agent_configs')
    .select('focus_plan,focus_confirmed_at')
    .eq('org_id', orgId)
    .eq('agent_key', FINANCE_FOCUS)
    .maybeSingle();
  if (config.error) throw config.error;
  const row = config.data as { focus_plan: unknown; focus_confirmed_at: string | null } | null;
  // Re-validated on every read: the stored plan is never trusted as-is.
  const plan = row?.focus_confirmed_at ? validatePlan(FINANCE_FOCUS_MENU, row.focus_plan).plan : null;

  const [invoiceRows, billRows, draftInvoiceRows, draftBillRows, expenseRows, quotationRows, lineRows, accountRows, contactRows] =
    await Promise.all([
      readAll((from, to) =>
        service
          .from('finance_invoice_totals')
          .select('id,invoice_no,customer_id,due_date,display_status,balance_myr')
          .eq('org_id', orgId)
          .in('display_status', ['sent', 'overdue'])
          .gt('balance_myr', 0)
          .order('due_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('supplier_bill_totals')
          .select('id,bill_no,supplier_id,due_date,display_status,balance_myr')
          .eq('org_id', orgId)
          .in('display_status', ['pending', 'overdue'])
          .gt('balance_myr', 0)
          .order('due_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('finance_invoices')
          .select('id,customer_id,updated_at')
          .eq('org_id', orgId)
          .eq('status', 'draft')
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('supplier_bills')
          .select('id,supplier_id,updated_at')
          .eq('org_id', orgId)
          .eq('status', 'draft')
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('finance_expenses')
          .select('id,amount,vendor_id,vendor_name,created_at')
          .eq('org_id', orgId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('finance_quotations')
          .select('id,quotation_no,customer_id,valid_until')
          .eq('org_id', orgId)
          .eq('status', 'sent')
          .order('valid_until', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('finance_statement_lines')
          .select('id,account_id,line_date,money_in,money_out')
          .eq('org_id', orgId)
          .is('transaction_id', null)
          .order('line_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('finance_accounts')
          .select('id,name,active,currency')
          .eq('org_id', orgId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('finance_contacts')
          .select('id,name')
          .eq('org_id', orgId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);

  const sstSettings = await service
    .from('finance_sst_settings')
    .select('period_start_month,service_tax_no,sales_tax_no')
    .eq('org_id', orgId)
    .maybeSingle();
  if (sstSettings.error) throw sstSettings.error;
  const settings = sstSettings.data as {
    period_start_month: number | null;
    service_tax_no: string | null;
    sales_tax_no: string | null;
  } | null;
  const taxes: FinanceAgentTaxType[] = [];
  if (settings && str(settings.service_tax_no)) taxes.push('service');
  if (settings && str(settings.sales_tax_no)) taxes.push('sales');
  let sst: FinanceAgentRaw['sst'] = null;
  const startMonth = Number(settings?.period_start_month);
  if (taxes.length > 0 && Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12) {
    const filedRows = await readAll((from, to) =>
      service
        .from('finance_sst_returns')
        .select('tax_type,period_start')
        .eq('org_id', orgId)
        .order('period_start', { ascending: true })
        .order('tax_type', { ascending: true })
        .range(from, to),
    );
    sst = {
      periodStartMonth: startMonth,
      taxes,
      filed: filedRows.map((r) => ({ taxType: String(r.tax_type), periodStart: String(r.period_start) })),
    };
  }

  const contacts = new Map(contactRows.map((c) => [String(c.id), str(c.name)]));
  const nameOf = (id: unknown) => (typeof id === 'string' ? (contacts.get(id) ?? null) : null);
  const activeAccounts = new Map(
    accountRows
      .filter((a) => a.active === true)
      .map((a) => [String(a.id), { name: str(a.name) ?? 'Bank account', currency: str(a.currency) ?? BASE_CURRENCY }]),
  );

  const raw: FinanceAgentRaw = {
    plan,
    invoices: invoiceRows.map((r) => ({
      id: String(r.id),
      invoiceNo: str(r.invoice_no),
      customer: nameOf(r.customer_id),
      dueDate: str(r.due_date),
      balance: num(r.balance_myr),
    })),
    bills: billRows.map((r) => ({
      id: String(r.id),
      billNo: str(r.bill_no),
      supplier: nameOf(r.supplier_id),
      dueDate: str(r.due_date),
      balance: num(r.balance_myr),
    })),
    drafts: [
      ...draftInvoiceRows.map((r) => ({
        kind: 'invoice' as const,
        id: String(r.id),
        party: nameOf(r.customer_id),
        updatedAt: String(r.updated_at),
      })),
      ...draftBillRows.map((r) => ({
        kind: 'bill' as const,
        id: String(r.id),
        party: nameOf(r.supplier_id),
        updatedAt: String(r.updated_at),
      })),
    ],
    expenses: expenseRows.map((r) => ({
      id: String(r.id),
      amount: num(r.amount),
      // The table's own vendor_name is empty when the vendor is a contact.
      vendor: nameOf(r.vendor_id) ?? str(r.vendor_name),
      createdAt: String(r.created_at),
    })),
    quotations: quotationRows.map((r) => ({
      id: String(r.id),
      quotationNo: str(r.quotation_no),
      customer: nameOf(r.customer_id),
      validUntil: str(r.valid_until),
    })),
    bankLines: lineRows
      .filter((r) => activeAccounts.has(String(r.account_id)))
      .map((r) => ({
        accountId: String(r.account_id),
        account: activeAccounts.get(String(r.account_id))!.name,
        currency: activeAccounts.get(String(r.account_id))!.currency,
        lineDate: String(r.line_date),
        amount: num(r.money_in) + num(r.money_out),
      })),
    sst,
  };

  // Counts only: no names, no ids, never the focus text.
  let context =
    `Unpaid invoices: ${raw.invoices.length}. Unpaid supplier bills: ${raw.bills.length}. ` +
    `Drafts: ${raw.drafts.length}. Expense claims waiting: ${raw.expenses.length}. ` +
    `Quotations awaiting an answer: ${raw.quotations.length}. Unmatched bank lines: ${raw.bankLines.length}.`;
  if (plan) {
    context += `\nWhat the owner asked to watch:\n${readBack(FINANCE_FOCUS_MENU, plan)
      .map((line) => `- ${line}`)
      .join('\n')}`;
  }
  return { context, raw };
}
