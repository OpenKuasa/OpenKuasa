/**
 * The refund form's rules, kept out of the component so they can be tested:
 * what can be refunded and for how much, what a new form holds, what is
 * wrong with the form, and what is sent to recordRefundAction. Pure. A
 * refund is one payment out against one invoice or one credit note, with a
 * reason, so it does not share the payment card, which splits one payment
 * across many documents.
 */
import { amountText, defaultAccount, sen } from './allocation-form';
import type { CreditNoteRow } from './credit-notes';
import { rm, typedNumber } from './format';
import type { InvoiceListRow } from './invoices';
import type { FinanceAccount, PaymentMethod } from './money';
import { REFUND_MESSAGES, type RefundReason, type RefundRow, recordRefundInput } from './refunds';
import { isPendingRefund } from './sales-followon-views';
import { inCredit } from './sales-views';

const M = REFUND_MESSAGES;

/** One thing a refund can be put against: an invoice whose customer is in credit, or one of its issued credit notes. */
export type RefundTarget = {
  /** The value of the form's picker: `invoice:<id>` or `note:<id>`. */
  key: string;
  kind: 'invoice' | 'credit_note';
  /** The invoice's id or the credit note's id, by `kind`. */
  id: string;
  /** INV-0007 or CN-0003. */
  number: string;
  /** The invoice the credit sits on, whichever the refund is put against. */
  invoice_id: string;
  invoice_no: string;
  customer_name: string;
  /** The most a new refund against it may be. */
  refundable: number;
};

export type RefundForm = {
  /** The key of what the refund is put against; empty until chosen. */
  target: string;
  /** The amount as typed. */
  amount: string;
  /** Empty until a reason is chosen. */
  reason: RefundReason | '';
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  /** True for a refund still to be paid out: it holds the customer's credit until it is marked paid or deleted. */
  scheduled: boolean;
};

export const invoiceTargetKey = (invoiceId: string) => `invoice:${invoiceId}`;
export const noteTargetKey = (creditNoteId: string) => `note:${creditNoteId}`;

/** What refunds not yet paid out add up to, in sen, by whatever `of` picks from each. */
function pendingSen(refunds: RefundRow[], of: (refund: RefundRow) => string | null): Map<string, number> {
  const held = new Map<string, number>();
  for (const refund of refunds) {
    const id = of(refund);
    if (id !== null && isPendingRefund(refund)) held.set(id, (held.get(id) ?? 0) + sen(refund.amount));
  }
  return held;
}

/**
 * Everything a refund can be recorded against, and the most each can take:
 * exactly what the database allows, so the form offers nothing it would
 * refuse.
 *
 * An invoice: what its customer is in credit there (its balance below zero,
 * which already has every refund that was paid out in it), less refunds that
 * are still pending against the invoice or against any of its credit notes.
 * A refund row names its invoice whichever of the two it was put against, so
 * one sum covers both.
 *
 * An issued credit note of such an invoice: the same figure, and also no more
 * than the note's amount less every refund standing against the note itself,
 * paid out (`refunded`) or pending.
 *
 * Listed by customer, then invoice; an invoice first, then its credit notes.
 */
export function refundTargets(invoices: InvoiceListRow[], creditNotes: CreditNoteRow[], refunds: RefundRow[]): RefundTarget[] {
  const pendingOnInvoice = pendingSen(refunds, (r) => r.invoice_id);
  const pendingOnNote = pendingSen(refunds, (r) => r.credit_note_id);
  const targets: RefundTarget[] = [];
  // By number as a number: INV-9999 comes before INV-10000.
  const byNumber = (x: string | null, y: string | null) => (x ?? '').localeCompare(y ?? '', undefined, { numeric: true });
  const ordered = [...invoices].sort(
    (x, y) => x.customer_name.localeCompare(y.customer_name) || byNumber(x.invoice_no, y.invoice_no),
  );
  for (const invoice of ordered) {
    const free = sen(inCredit(invoice)) - (pendingOnInvoice.get(invoice.id) ?? 0);
    if (free <= 0) continue;
    const shared = { invoice_id: invoice.id, invoice_no: invoice.invoice_no ?? '—', customer_name: invoice.customer_name };
    targets.push({
      key: invoiceTargetKey(invoice.id),
      kind: 'invoice',
      id: invoice.id,
      number: shared.invoice_no,
      ...shared,
      refundable: free / 100,
    });
    const notes = creditNotes
      .filter((n) => n.invoice_id === invoice.id && n.status === 'issued')
      .sort((x, y) => byNumber(x.credit_note_no, y.credit_note_no));
    for (const note of notes) {
      const left = sen(note.amount) - sen(note.refunded) - (pendingOnNote.get(note.id) ?? 0);
      const refundable = Math.min(free, left);
      if (refundable <= 0) continue;
      targets.push({
        key: noteTargetKey(note.id),
        kind: 'credit_note',
        id: note.id,
        number: note.credit_note_no ?? '—',
        ...shared,
        refundable: refundable / 100,
      });
    }
  }
  return targets;
}

/** How the form's picker lists a target: its number (a credit note with its invoice), the customer, and what can be refunded. */
export function refundTargetLabel(target: RefundTarget): string {
  const number = target.kind === 'invoice' ? target.number : `${target.number} on ${target.invoice_no}`;
  return `${number} · ${target.customer_name} · ${rm(target.refundable)} can be refunded`;
}

/**
 * A fresh form: paid out now, from the first bank account, by bank transfer.
 * With `preselect` (the Refund choice on an invoice's or a credit note's
 * row), or when only one thing can be refunded, that is chosen and the
 * amount is all it can take, which is what a refund most often is.
 */
export function newRefundForm(targets: RefundTarget[], accounts: FinanceAccount[], today: string, preselect?: string): RefundForm {
  const chosen = targets.find((t) => t.key === preselect) ?? (targets.length === 1 ? targets[0] : undefined);
  return {
    target: chosen?.key ?? '',
    amount: chosen ? amountText(chosen.refundable) : '',
    reason: '',
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
    scheduled: false,
  };
}

/** Choosing what to refund sets the amount to all it can take; the person can then lower it. */
export function chooseRefundTarget(form: RefundForm, target: RefundTarget): RefundForm {
  return target.key === form.target ? form : { ...form, target: target.key, amount: amountText(target.refundable) };
}

/**
 * After a refresh, the chosen target may no longer be offered: its credit was
 * refunded or went in another tab. The choice goes, so the picker does not
 * show something that cannot be saved. The same form when it is still there.
 */
export function keepRefundTarget(form: RefundForm, targets: RefundTarget[]): RefundForm {
  return form.target === '' || targets.some((t) => t.key === form.target) ? form : { ...form, target: '' };
}

/**
 * What is sent to recordRefundAction: the invoice or the credit note, never
 * both. The amount is a number; a box that is not a number goes as NaN and
 * is refused.
 */
export function refundPayload(form: RefundForm, targets: RefundTarget[]) {
  const target = targets.find((t) => t.key === form.target);
  return {
    invoice_id: target?.kind === 'invoice' ? target.id : null,
    credit_note_id: target?.kind === 'credit_note' ? target.id : null,
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reason: form.reason,
    amount: typedNumber(form.amount) ?? Number.NaN,
    reference: form.reference,
    notes: form.notes,
    scheduled: form.scheduled,
  };
}

/** What a refund that was just recorded is: what the form held when it was sent, not the row it was opened from. */
export type RefundSaved = {
  /** What it was put against: the target chosen in the form. */
  target: RefundTarget;
  amount: number;
  /** True when it was left pending, false when it was paid out. */
  scheduled: boolean;
};

/**
 * What the form is about to record, for the note a page shows afterwards.
 * The amount is the one the schema makes of the payload, rounded to the sen
 * as it is stored: 1.005 typed is RM 1.00 recorded, and the note must not say
 * RM 1.01. Null while the form has no target or cannot be sent; a form that
 * `refundFormError` passes always can.
 */
export function refundSaved(form: RefundForm, targets: RefundTarget[]): RefundSaved | null {
  const target = targets.find((t) => t.key === form.target);
  const parsed = recordRefundInput.safeParse(refundPayload(form, targets));
  return target && parsed.success ? { target, amount: parsed.data.amount, scheduled: parsed.data.scheduled } : null;
}

/**
 * The note a page shows once a refund is recorded from a row: who it is for,
 * and a sentence that leads up to the link to Refunds. It names what the
 * refund was put against, which the person may have changed in the form.
 */
export function refundSavedNote(saved: RefundSaved): { subtitle: string; lead: string } {
  const { target } = saved;
  const numbered = target.number !== '—';
  const against =
    target.kind === 'invoice'
      ? numbered
        ? target.number
        : 'the invoice'
      : `${numbered ? target.number : 'the credit note'} on ${target.invoice_no === '—' ? 'its invoice' : target.invoice_no}`;
  return {
    subtitle: `For ${target.customer_name}`,
    lead: saved.scheduled
      ? `${rm(saved.amount)} was left pending against ${against}. It is marked as paid or deleted on`
      : `${rm(saved.amount)} was paid out against ${against}. It can be voided on`,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent. What is being refunded
 * comes first, as it is first on the form.
 */
export function refundFormError(form: RefundForm, targets: RefundTarget[]): string | null {
  const target = targets.find((t) => t.key === form.target);
  if (!target) return M.document;
  const parsed = recordRefundInput.safeParse(refundPayload(form, targets));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  return sen(parsed.data.amount) > sen(target.refundable) ? M.tooMuch : null;
}
