import type { SupabaseClient } from '@supabase/supabase-js';
import { klDay } from '@/lib/crm/deal-stats';
import { listInvoices, type InvoiceDisplayStatus, type InvoiceListRow } from '@/lib/finance/invoices';

/** How many invoices the "Recent invoices" table shows. */
export const RECENT_LISTED = 8;
/** How many customers the "Top customers" list shows. */
export const TOP_CUSTOMERS_LISTED = 5;
/** How many months the "Billed by month" chart covers, ending with this one. */
export const TREND_MONTHS = 6;

/** The statuses in the order the page lists them. */
export const BILLING_STATUSES: readonly InvoiceDisplayStatus[] = ['draft', 'sent', 'overdue', 'paid', 'void'];

/** An invoice that has been posted and not voided: it counts as billed. */
const ISSUED: ReadonlySet<InvoiceDisplayStatus> = new Set(['sent', 'overdue', 'paid']);

/**
 * Kasturi's view of the workspace's sales invoices. The invoices themselves
 * belong to Bendahara, which is where they are created and changed.
 */
export type BillingsModel = {
  /** 'October 2026'. */
  monthTitle: string;
  stats: {
    /** Issued invoices dated in this month. */
    billedThisMonth: number;
    billedThisMonthCount: number;
    /** What is still owed on sent and overdue invoices. */
    outstanding: number;
    outstandingCount: number;
    /** The part of `outstanding` that is past its due date. */
    overdue: number;
    overdueCount: number;
    /** Money received against issued invoices. */
    received: number;
    /** `received` as a share of everything billed, 0 to 100; null when nothing is billed. */
    collectionRate: number | null;
  };
  /** Billed per month, oldest first. `label` is 'Oct'. */
  trend: { month: string; label: string; billed: number }[];
  byStatus: { status: InvoiceDisplayStatus; count: number }[];
  topCustomers: { id: string; name: string; billed: number; outstanding: number }[];
  /** The newest invoices, drafts and void ones included. */
  recent: InvoiceListRow[];
  /** Every invoice in the workspace. */
  total: number;
};

/** Adds ringgit amounts in whole sen, so the total has no floating-point dust. */
function sum(amounts: number[]) {
  return amounts.reduce((total, amount) => total + Math.round(amount * 100), 0) / 100;
}

function shiftMonth(month: string, by: number) {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
}

function monthName(month: string, options: Intl.DateTimeFormatOptions) {
  // en-US, because en-GB shortens September to 'Sept'.
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00.000Z`),
  );
}

/** What is still owed on an invoice; a customer in credit owes nothing. */
function owed(invoice: InvoiceListRow) {
  return Math.max(invoice.balance, 0);
}

/** The figures on Kasturi's Billings page, from the workspace's invoices. */
export function buildBillings(invoices: InvoiceListRow[], now: Date): BillingsModel {
  const month = klDay(now).slice(0, 7);
  const issued = invoices.filter((invoice) => ISSUED.has(invoice.display_status));
  const open = issued.filter((invoice) => invoice.display_status !== 'paid');
  const overdue = open.filter((invoice) => invoice.display_status === 'overdue');
  const thisMonth = issued.filter((invoice) => invoice.invoice_date.slice(0, 7) === month);

  const billed = sum(issued.map((invoice) => invoice.total));
  const received = sum(issued.map((invoice) => invoice.paid));

  const months = Array.from({ length: TREND_MONTHS }, (_, i) => shiftMonth(month, i - (TREND_MONTHS - 1)));

  const customers = new Map<string, { id: string; name: string; rows: InvoiceListRow[] }>();
  for (const invoice of issued) {
    const customer = customers.get(invoice.customer_id) ?? {
      id: invoice.customer_id,
      name: invoice.customer_name,
      rows: [],
    };
    customer.rows.push(invoice);
    customers.set(invoice.customer_id, customer);
  }

  return {
    monthTitle: monthName(month, { month: 'long', year: 'numeric' }),
    stats: {
      billedThisMonth: sum(thisMonth.map((invoice) => invoice.total)),
      billedThisMonthCount: thisMonth.length,
      outstanding: sum(open.map(owed)),
      outstandingCount: open.length,
      overdue: sum(overdue.map(owed)),
      overdueCount: overdue.length,
      received,
      collectionRate: billed > 0 ? Math.min(100, Math.max(0, Math.round((received / billed) * 100))) : null,
    },
    trend: months.map((m) => ({
      month: m,
      label: monthName(m, { month: 'short' }),
      billed: sum(issued.filter((invoice) => invoice.invoice_date.slice(0, 7) === m).map((invoice) => invoice.total)),
    })),
    byStatus: BILLING_STATUSES.map((status) => ({
      status,
      count: invoices.filter((invoice) => invoice.display_status === status).length,
    })),
    topCustomers: [...customers.values()]
      .map(({ id, name, rows }) => ({
        id,
        name,
        billed: sum(rows.map((invoice) => invoice.total)),
        outstanding: sum(rows.filter((invoice) => invoice.display_status !== 'paid').map(owed)),
      }))
      .sort((a, b) => b.billed - a.billed || a.name.localeCompare(b.name))
      .slice(0, TOP_CUSTOMERS_LISTED),
    recent: [...invoices]
      // On the same date the higher invoice number is the newer one; a draft has none yet.
      .sort(
        (a, b) =>
          b.invoice_date.localeCompare(a.invoice_date) ||
          (b.invoice_no ?? '').localeCompare(a.invoice_no ?? '', undefined, { numeric: true }) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, RECENT_LISTED),
    total: invoices.length,
  };
}

/** Reads a workspace's invoices and builds the Billings page from them. */
export async function loadCrmBillings(client: SupabaseClient, orgId: string, now: Date): Promise<BillingsModel> {
  return buildBillings(await listInvoices({ client, orgId }), now);
}
