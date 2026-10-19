import { type BillListRow, billRinggit } from './bills';
import { type EInvoiceStatus, type InvoiceListRow, invoiceRinggit } from './invoices';
import { round2 } from './view-helpers';

/** How many rows each list on the Ask Bendahara dashboard shows. */
export const OVERVIEW_LIST_LIMIT = 5;

export type OpenTotals = {
  /** Ringgit still owed on open documents. */
  total: number;
  /** The part of `total` that is past its due date. */
  overdue: number;
  openCount: number;
  overdueCount: number;
};

export type OverdueInvoice = {
  id: string;
  number: string;
  customer: string;
  balance: number;
  daysOverdue: number;
};

export type UnpaidBill = {
  id: string;
  number: string;
  supplier: string;
  balance: number;
  dueDate: string;
  overdue: boolean;
};

export type EInvoiceEntry = {
  id: string;
  number: string;
  customer: string;
  status: Exclude<EInvoiceStatus, 'none'>;
};

export type FinanceOverview = {
  /** True when there is nothing open to show: no receivable, payable or recorded e-Invois. */
  isEmpty: boolean;
  receivable: OpenTotals;
  payable: OpenTotals;
  overdueInvoices: OverdueInvoice[];
  outstandingByCustomer: { label: string; amount: number }[];
  unpaidBills: UnpaidBill[];
  eInvoices: EInvoiceEntry[];
};

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The dashboard figures of the Ask Bendahara screen, from the invoices and
 * bills already read. Pure: money is in ringgit (an invoice in another
 * currency counts its ringgit balance, worked out by the database), and a
 * document only counts while it is open (invoice sent/overdue, bill
 * pending/overdue) with something left to pay; a customer in credit is not
 * netted off what others owe.
 */
export function buildFinanceOverview(
  invoices: InvoiceListRow[],
  bills: BillListRow[],
  today: string,
  options: { limit?: number } = {},
): FinanceOverview {
  const limit = options.limit ?? OVERVIEW_LIST_LIMIT;

  // Every figure below adds invoices up, so each invoice's balance is its balance in ringgit.
  const inRinggit = invoices.map((i) => ({ ...i, balance: invoiceRinggit(i).balance }));
  const openInvoices = inRinggit.filter(
    (i) => (i.display_status === 'sent' || i.display_status === 'overdue') && i.balance > 0,
  );
  const overdueInvoices = openInvoices.filter((i) => i.display_status === 'overdue');
  // The same for bills: each balance in ringgit (a foreign draft with no rate counts nothing; it is a draft).
  const billsInRinggit = bills.map((b) => ({ ...b, balance: billRinggit(b).balance }));
  const openBills = billsInRinggit.filter(
    (b) => (b.display_status === 'pending' || b.display_status === 'overdue') && b.balance > 0,
  );
  const overdueBills = openBills.filter((b) => b.display_status === 'overdue');

  const totals = <T extends { balance: number }>(open: T[], overdue: T[]): OpenTotals => ({
    total: round2(open.reduce((s, r) => s + r.balance, 0)),
    overdue: round2(overdue.reduce((s, r) => s + r.balance, 0)),
    openCount: open.length,
    overdueCount: overdue.length,
  });

  const byCustomer = new Map<string, { label: string; amount: number }>();
  for (const i of openInvoices) {
    const entry = byCustomer.get(i.customer_id) ?? { label: i.customer_name, amount: 0 };
    entry.amount += i.balance;
    byCustomer.set(i.customer_id, entry);
  }

  const receivable = totals(openInvoices, overdueInvoices);
  const payable = totals(openBills, overdueBills);
  const eInvoices = invoices
    .filter(
      (i) =>
        i.einvoice_status !== 'none' && i.display_status !== 'draft' && i.display_status !== 'void',
    )
    .sort((a, b) => b.invoice_date.localeCompare(a.invoice_date))
    .slice(0, limit)
    .map((i) => ({
      id: i.id,
      number: i.invoice_no ?? 'Draft',
      customer: i.customer_name,
      status: i.einvoice_status as Exclude<EInvoiceStatus, 'none'>,
    }));

  return {
    isEmpty: receivable.openCount === 0 && payable.openCount === 0 && eInvoices.length === 0,
    receivable,
    payable,
    overdueInvoices: overdueInvoices
      .map((i) => ({
        id: i.id,
        number: i.invoice_no ?? 'Draft',
        customer: i.customer_name,
        balance: round2(i.balance),
        daysOverdue: Math.max(0, daysBetween(i.due_date, today)),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance)
      .slice(0, limit),
    outstandingByCustomer: [...byCustomer.values()]
      .map((c) => ({ label: c.label, amount: round2(c.amount) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit),
    unpaidBills: openBills
      .map((b) => ({
        id: b.id,
        number: b.bill_no ?? 'Draft',
        supplier: b.supplier_name,
        balance: round2(b.balance),
        dueDate: b.due_date,
        overdue: b.display_status === 'overdue',
      }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, limit),
    eInvoices,
  };
}
