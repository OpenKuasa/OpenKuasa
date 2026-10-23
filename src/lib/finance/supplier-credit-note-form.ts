/**
 * The supplier credit note screens' rules, kept out of the components so they
 * can be tested: which bills can take a credit note and for how much, what a
 * form holds and what is wrong with it, which bills a note's open credit can
 * go on, and what each row's menu offers. Pure. Supplier credit notes are in
 * ringgit, so only ringgit bills are offered.
 */
import type { Slice } from '@/components/charts';
import { amountText, round2, sen } from './allocation-form';
import type { BillListRow } from './bills';
import { BASE_CURRENCY } from './currencies';
import { toCsv } from './csv';
import { rm, rmShort, typedNumber } from './format';
import {
  SUPPLIER_CREDIT_MESSAGES,
  SUPPLIER_CREDIT_REASONS,
  SUPPLIER_CREDIT_REASON_LABELS,
  type SupplierCreditNoteRow,
  type SupplierCreditReason,
  type SupplierCreditStatus,
  applySupplierCreditInput,
  creditOnOtherBills,
  saveSupplierCreditNoteInput,
} from './supplier-credit-notes';
import { WRITE_FAILED } from './result';
import { type Stat, count, lastMonths, monthOf, sum, thousands } from './view-helpers';

const M = SUPPLIER_CREDIT_MESSAGES;

/** A posted bill: what the database lets a credit note go against, or credit go on. */
const posted = (b: BillListRow) => b.display_status === 'pending' || b.display_status === 'overdue' || b.display_status === 'paid';

export type CreditableBill = {
  id: string;
  bill_no: string;
  supplier_id: string;
  supplier_name: string;
  total: number;
  /** What the bill's issued credit notes already come to. */
  credited: number;
  /** What a new credit note may be for: the total less what is already credited. */
  creditable: number;
};

/**
 * The bills a credit note can go against: posted, in ringgit, and not yet credited for their whole total by issued
 * notes (a draft is not counted, as the database does not count one until it is issued). What has been paid does
 * not limit it: a paid bill is the overpaid case. `keepId` is the bill the form is on: it stays in the list with
 * nothing left, so the form can say so, unless it is no longer posted.
 */
export function creditableBills(bills: BillListRow[], notes: SupplierCreditNoteRow[], keepId?: string): CreditableBill[] {
  const issued = new Map<string, number>();
  for (const n of notes) if (n.status === 'issued') issued.set(n.bill_id, round2((issued.get(n.bill_id) ?? 0) + n.amount));
  return bills
    .filter((b) => posted(b) && b.currency === BASE_CURRENCY)
    .map((b) => {
      const credited = issued.get(b.id) ?? 0;
      return {
        id: b.id,
        bill_no: b.bill_no ?? '—',
        supplier_id: b.supplier_id,
        supplier_name: b.supplier_name,
        total: b.total,
        credited,
        creditable: Math.max(round2(b.total - credited), 0),
      };
    })
    .filter((b) => b.creditable > 0 || b.id === keepId)
    .sort((x, y) => x.supplier_name.localeCompare(y.supplier_name) || x.bill_no.localeCompare(y.bill_no, undefined, { numeric: true }));
}

/** How the form's picker lists a bill. */
export function creditableBillLabel(bill: CreditableBill): string {
  return `${bill.bill_no} · ${bill.supplier_name} · ${rm(bill.creditable)} left to credit`;
}

export type SupplierCreditForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  billId: string;
  date: string;
  /** Empty until a reason is chosen. */
  reason: SupplierCreditReason | '';
  /** The amount as typed. */
  amount: string;
  supplierRef: string;
  notes: string;
};

/** A new credit note dated today. With `billId` (Credit note on a bill's row) that bill is chosen, when it can still take one. */
export function newSupplierCreditForm(creditable: CreditableBill[], today: string, billId?: string): SupplierCreditForm {
  return {
    billId: billId && creditable.some((b) => b.id === billId) ? billId : '',
    date: today,
    reason: '',
    amount: '',
    supplierRef: '',
    notes: '',
  };
}

/** A saved draft, as the form shows it. */
export function supplierCreditFormFromRow(note: SupplierCreditNoteRow): SupplierCreditForm {
  return {
    id: note.id,
    billId: note.bill_id,
    date: note.credit_date,
    reason: note.reason,
    amount: amountText(note.amount),
    supplierRef: note.supplier_ref ?? '',
    notes: note.notes ?? '',
  };
}

/** What is sent to the save action. A box that is not a number goes as NaN and is refused. */
export function supplierCreditPayload(form: SupplierCreditForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    bill_id: form.billId,
    credit_date: form.date,
    reason: form.reason,
    amount: typedNumber(form.amount) ?? Number.NaN,
    supplier_ref: form.supplierRef,
    notes: form.notes,
  };
}

/** The first thing wrong with the form, in the sentence the schema or the database would use, or null. */
export function supplierCreditFormError(form: SupplierCreditForm, creditable: CreditableBill[]): string | null {
  const parsed = saveSupplierCreditNoteInput.safeParse(supplierCreditPayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  const bill = creditable.find((b) => b.id === form.billId);
  if (!bill) return M.notPosted;
  return sen(parsed.data.amount) > sen(bill.creditable) ? M.tooMuch : null;
}

/** What was just saved, for the note Supplier Bills shows after saving from a bill's row. */
export type SupplierCreditSaved = { bill_no: string; supplier_name: string; amount: number; issued: boolean };

export function supplierCreditSaved(form: SupplierCreditForm, creditable: CreditableBill[], issued: boolean): SupplierCreditSaved | null {
  const bill = creditable.find((b) => b.id === form.billId);
  const parsed = saveSupplierCreditNoteInput.safeParse(supplierCreditPayload(form));
  if (!bill || !parsed.success) return null;
  return { bill_no: bill.bill_no, supplier_name: bill.supplier_name, amount: parsed.data.amount, issued };
}

/** The note's title, subtitle and the sentence that leads up to the link to Supplier Credit Notes. */
export function supplierCreditSavedNote(saved: SupplierCreditSaved): { title: string; subtitle: string; lead: string } {
  return {
    title: saved.issued ? 'Supplier credit note issued' : 'Supplier credit note saved',
    subtitle: `${saved.bill_no} from ${saved.supplier_name}`,
    lead: saved.issued
      ? `A credit note of ${rm(saved.amount)} was issued against ${saved.bill_no} and put on it up to what it owed. Any credit left over is applied to a later bill on`
      : `A draft credit note of ${rm(saved.amount)} was saved against ${saved.bill_no}. It is issued, changed or deleted on`,
  };
}

/** What the form says when the note was saved as a draft but issuing it was refused. */
export function supplierCreditSavedNotIssued(error: string): string {
  if (error === WRITE_FAILED) return 'The credit note was saved as a draft, but issuing it failed. Please try again.';
  return `The credit note was saved as a draft, but it was not issued. ${error}`;
}

/* ---- applying credit -------------------------------------------------- */

export type CreditTarget = { id: string; bill_no: string; due_date: string; balance: number };

/**
 * The bills a note's open credit can go on: posted, in ringgit, from the note's supplier, still owing something
 * after payments not yet made (`held`, by bill id), and not already holding this note's credit (that is taken off
 * and applied again). Oldest due first, as a person would settle them.
 */
export function creditTargets(note: SupplierCreditNoteRow, bills: BillListRow[], held: Record<string, number> = {}): CreditTarget[] {
  const already = new Set(note.applications.map((a) => a.bill_id));
  return bills
    .filter(
      (b) =>
        (b.display_status === 'pending' || b.display_status === 'overdue') &&
        b.currency === BASE_CURRENCY &&
        b.supplier_id === note.supplier_id &&
        !already.has(b.id),
    )
    .map((b) => ({ id: b.id, bill_no: b.bill_no ?? '—', due_date: b.due_date, balance: round2(b.balance - (held[b.id] ?? 0)) }))
    .filter((b) => b.balance > 0)
    .sort((x, y) => x.due_date.localeCompare(y.due_date) || x.bill_no.localeCompare(y.bill_no, undefined, { numeric: true }));
}

/** The amount the apply box starts at: the smaller of the note's open credit and what the bill still owes. */
export function defaultApplyAmount(note: SupplierCreditNoteRow, target: CreditTarget | undefined): string {
  return target ? amountText(Math.min(note.open_amount, target.balance)) : '';
}

/** The first thing wrong with applying, or null. */
export function applyCreditError(note: SupplierCreditNoteRow, targets: CreditTarget[], billId: string, amount: string): string | null {
  const parsed = applySupplierCreditInput.safeParse({ credit_note_id: note.id, bill_id: billId, amount: typedNumber(amount) ?? Number.NaN });
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  const target = targets.find((t) => t.id === billId);
  if (!target) return M.applyBill;
  return sen(parsed.data.amount) > sen(Math.min(note.open_amount, target.balance)) ? M.tooMuchApplied : null;
}

/* ---- the row ---------------------------------------------------------- */

export type SupplierCreditAction = 'edit' | 'issue' | 'delete' | 'apply' | 'unapply' | 'void';

/**
 * What a note's row menu offers. A draft is edited and deleted by anyone who may write, and issued by an owner or
 * admin. An issued note, for an owner or admin: apply its open credit while there is some and a bill can take it,
 * take credit off a later bill (one item per bill, `unapply`), and void it. A void note offers nothing.
 */
export function supplierCreditActions(note: SupplierCreditNoteRow, canSignOff: boolean, hasTargets: boolean): SupplierCreditAction[] {
  if (note.status === 'draft') return canSignOff ? ['edit', 'issue', 'delete'] : ['edit', 'delete'];
  if (note.status !== 'issued' || !canSignOff) return [];
  const actions: SupplierCreditAction[] = [];
  if (note.open_amount > 0 && hasTargets) actions.push('apply');
  if (creditOnOtherBills(note).length > 0) actions.push('unapply');
  actions.push('void');
  return actions;
}

/** How a question or a menu names one note: its number, or "the draft credit note", and its supplier. */
export function supplierCreditName(note: Pick<SupplierCreditNoteRow, 'credit_note_no' | 'supplier_name'>): string {
  return `${note.credit_note_no ?? 'the draft credit note'} from ${note.supplier_name}`;
}

/** Where its credit went, for the line under the amount: "BILL-0001 RM 50.00, BILL-0004 RM 30.00". */
export function appliedText(note: Pick<SupplierCreditNoteRow, 'applications'>): string | null {
  if (note.applications.length === 0) return null;
  return note.applications.map((a) => `${a.bill_no ?? '—'} ${rm(a.amount)}`).join(', ');
}

/* ---- the screen's figures, filter and export ---------------------------- */

export type SupplierCreditViewData = {
  stats: Stat[];
  /** The last eight months, oldest first, in RM thousands: issued notes by their date. */
  trend: { label: string; credited: number }[];
  hasTrend: boolean;
  /** Issued notes dated this calendar year, in RM, per reason. */
  byReason: Slice[];
  hasReasons: boolean;
  creditedYtd: string;
};

export const SUPPLIER_CREDIT_STATUS_LABELS: Record<SupplierCreditStatus, string> = { draft: 'Draft', issued: 'Issued', void: 'Void' };

const REASON_COLORS: Record<SupplierCreditReason, string> = {
  overpaid: 'var(--chart-1)',
  returned_goods: 'var(--chart-3)',
  short_delivery: 'var(--chart-4)',
  other: 'var(--chart-2)',
};

const yearOf = (iso: string) => iso.slice(0, 4);
const amountOf = (n: SupplierCreditNoteRow) => n.amount;

export function supplierCreditView(rows: SupplierCreditNoteRow[], today: string): SupplierCreditViewData {
  const issued = rows.filter((n) => n.status === 'issued');
  const mtd = issued.filter((n) => monthOf(n.credit_date) === monthOf(today));
  const ytd = issued.filter((n) => yearOf(n.credit_date) === yearOf(today));
  const open = sum(issued, (n) => n.open_amount);
  let hasTrend = false;
  const trend = lastMonths(today).map(({ key, label }) => {
    const inMonth = issued.filter((n) => monthOf(n.credit_date) === key);
    if (inMonth.length > 0) hasTrend = true;
    return { label, credited: thousands(sum(inMonth, amountOf)) };
  });
  const all = SUPPLIER_CREDIT_REASONS.map((reason) => ({
    key: reason,
    label: SUPPLIER_CREDIT_REASON_LABELS[reason],
    value: sum(ytd.filter((n) => n.reason === reason), amountOf),
    color: REASON_COLORS[reason],
  }));
  const used = all.filter((s) => s.value > 0);
  return {
    stats: [
      { label: 'Credited (MTD)', value: rmShort(sum(mtd, amountOf)), delta: count(mtd.length, 'credit note'), deltaTone: 'flat' },
      { label: 'Open credit', value: rmShort(open), delta: 'still to apply', deltaTone: 'flat' },
      { label: 'Issued', value: String(issued.length), delta: 'in all', deltaTone: 'flat' },
      { label: 'Drafts', value: String(rows.filter((n) => n.status === 'draft').length), delta: 'not yet issued', deltaTone: 'flat' },
    ],
    trend,
    hasTrend,
    byReason: used.length ? used : all,
    hasReasons: ytd.length > 0,
    creditedYtd: rmShort(sum(ytd, amountOf)),
  };
}

/** `open` is every note that is not void: what the table shows until a status is chosen. */
export type SupplierCreditFilter = 'open' | SupplierCreditStatus;

/** Notes matching the status filter whose number, supplier, bill number or supplier's reference contains the search text. */
export function filterSupplierCredits(rows: SupplierCreditNoteRow[], query: string, filter: SupplierCreditFilter): SupplierCreditNoteRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (n) =>
      (filter === 'open' ? n.status !== 'void' : n.status === filter) &&
      `${n.credit_note_no ?? ''} ${n.supplier_name} ${n.bill_no ?? ''} ${n.supplier_ref ?? ''}`.toLowerCase().includes(q),
  );
}

/** The table as a CSV file. Amounts are numbers. */
export function supplierCreditsCsv(rows: SupplierCreditNoteRow[]): string {
  return toCsv(
    ['No.', 'Date', 'Supplier', 'Bill', "Supplier's ref.", 'Reason', 'Amount', 'Applied', 'Open', 'Status'],
    rows.map((n) => [
      n.credit_note_no,
      n.credit_date,
      n.supplier_name,
      n.bill_no,
      n.supplier_ref,
      SUPPLIER_CREDIT_REASON_LABELS[n.reason],
      n.amount,
      n.status === 'issued' ? n.applied : null,
      n.status === 'issued' ? n.open_amount : null,
      SUPPLIER_CREDIT_STATUS_LABELS[n.status],
    ]),
  );
}
