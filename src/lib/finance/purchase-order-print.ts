import type { OrgRole } from '@/lib/auth/current-org';
import { roleLabel } from '@/lib/auth/permissions';
import { rm, unitPrice } from '@/lib/finance/format';
import type { PurchaseOrderDetail } from '@/lib/finance/purchase-orders';
import { count, displayDate } from '@/lib/finance/view-helpers';
import type { Letterhead } from '@/lib/people/letterhead-data';
import { clockTime, malaysiaDate } from '@/lib/people/dates';
import { letterHeadLines } from '@/lib/people/letter-marks';

/** A person named on the printout, as their profile and membership read; null for what could not be read. `role` is null once they have left this workspace. */
export type PrintPerson = { full_name: string | null; email: string | null; job_title: string | null; role: OrgRole | null };

/** An approved or closed order with what only its printout needs. */
export type PrintablePurchaseOrder = PurchaseOrderDetail & {
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  supplier: { name: string; ssm_no: string | null; phone: string | null; email: string | null };
  /** Whoever submitted, raised and approved the order, by user id. Someone whose profile cannot be read is missing. */
  people: Record<string, PrintPerson>;
};

/** What the printed purchase order says, in the order it is laid out. */
export type PurchaseOrderPrint = {
  po_no: string;
  date: string;
  /** The supplier: name, then "SSM …", then phone and email on one line, each only when there is one. */
  to: string[];
  /** The order's delivery address, else the workspace's own; null when neither has one. */
  deliver_to: string | null;
  /** Expected delivery, payment terms and our RFQ, in that order, each only when the order has one. */
  details: { label: string; value: string }[];
  lines: { no: number; description: string; quantity: string; unit: string; unit_price: string; sst: string; amount: string }[];
  /** Subtotal, SST and total. */
  totals: { label: string; value: string }[];
  notes: string | null;
  quote_line: string;
  /** Prepared by, then Approved by. Blank parts stay blank: the lines to sign on are printed whatever is known. */
  signatures: { label: 'Prepared by' | 'Approved by'; name: string; designation: string; date: string }[];
};

const filled = (value: string | null | undefined): value is string => !!value && value.trim() !== '';

/** The workspace's address as its letterhead writes it, without the registration number; null when it has none. */
function workspaceAddress(head: Letterhead | null): string | null {
  return head ? (letterHeadLines({ ...head, registration_no: null }).details[0] ?? null) : null;
}

/** "14 Oct 2026, 3:42 pm" in Kuala Lumpur, wherever the printing is done; empty when there is no time. */
function malaysianTime(iso: string | null): string {
  if (!iso) return '';
  const [hour, minute] = clockTime(iso).split(':');
  const h = Number(hour);
  return `${displayDate(malaysiaDate(iso))}, ${h % 12 || 12}:${minute} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * A signature block: the person's name and job title (else role). Blank when they can no longer be read, or have left
 * this workspace: a profile stays readable to anyone sharing another workspace with them.
 */
function signature(label: 'Prepared by' | 'Approved by', person: PrintPerson | undefined, at: string | null) {
  const role = person?.role;
  const name = person && role ? (filled(person.full_name) ? person.full_name.trim() : (person.email?.split('@')[0].trim() ?? '')) : '';
  const designation = person && role ? (filled(person.job_title) ? person.job_title.trim() : roleLabel(role)) : '';
  return { label, name, designation, date: malaysianTime(at) };
}

/** The wording of a printed purchase order. `head` is the workspace's letterhead, null when it could not be read. */
export function purchaseOrderPrint(order: PrintablePurchaseOrder, head: Letterhead | null): PurchaseOrderPrint {
  const { supplier } = order;
  const contact = [supplier.phone, supplier.email].filter(filled).join(' · ');
  return {
    po_no: order.po_no ?? '',
    date: displayDate(order.po_date),
    to: [supplier.name, ...(filled(supplier.ssm_no) ? [`SSM ${supplier.ssm_no}`] : []), ...(contact ? [contact] : [])],
    deliver_to: filled(order.delivery_address) ? order.delivery_address.trim() : workspaceAddress(head),
    details: [
      ...(order.expected_date ? [{ label: 'Expected delivery', value: displayDate(order.expected_date) }] : []),
      ...(order.payment_terms_days === null
        ? []
        : [{ label: 'Payment terms', value: order.payment_terms_days === 0 ? 'Cash on delivery' : count(order.payment_terms_days, 'day') }]),
      ...(order.rfq_no ? [{ label: 'Our RFQ', value: order.rfq_no }] : []),
    ],
    lines: order.lines.map((line, index) => ({
      no: index + 1,
      description: line.description,
      quantity: line.quantity.toLocaleString('en-MY', { maximumFractionDigits: 4 }),
      unit: [line.uom, ...(filled(line.pack_size) ? [`(${line.pack_size})`] : [])].filter(filled).join(' '),
      unit_price: unitPrice(line.unit_price),
      sst: line.sst_rate > 0 ? `${line.sst_rate}%` : '—',
      amount: rm(line.amount),
    })),
    totals: [
      { label: 'Subtotal', value: rm(order.subtotal) },
      { label: 'SST', value: rm(order.sst_total) },
      { label: 'Total', value: rm(order.total) },
    ],
    notes: filled(order.notes) ? order.notes.trim() : null,
    quote_line: `Please quote ${order.po_no} on your delivery order and invoice.`,
    // Whoever put the order forward for approval prepared it; an order with no submitter falls back to its raiser, with no time.
    signatures: [
      order.submitted_by
        ? signature('Prepared by', order.people[order.submitted_by], order.submitted_at)
        : signature('Prepared by', order.created_by ? order.people[order.created_by] : undefined, null),
      signature('Approved by', order.approved_by ? order.people[order.approved_by] : undefined, order.approved_at),
    ],
  };
}
