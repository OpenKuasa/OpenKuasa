/**
 * The refund form's rules, kept out of the component so they can be tested:
 * what can be refunded and for how much, what a new form holds, what is
 * wrong with the form, and what is sent to recordRefundAction. Pure. A
 * refund is one payment out against one invoice or one credit note, with a
 * reason, so it does not share the payment card, which splits one payment
 * across many documents.
 *
 * An invoice in another currency, or a credit note on one (stage 3c), is
 * refunded from a ringgit account: the amount is in the invoice's currency
 * (whole units for one with no cents), the form also asks for the ringgit
 * that left the account, and such a refund is paid out now, never left
 * pending (FIN47). The form shows about what the invoice carried for it and
 * the realised gain or loss, worked as the database works it
 * (fx-settlement.ts).
 */
import { amountText, defaultAccount, sen } from './allocation-form';
import type { CreditNoteRow } from './credit-notes';
import { BASE_CURRENCY, minorUnits } from './currencies';
import { CURRENCY_MESSAGES } from './document-currency';
import { money, rm, typedNumber } from './format';
import { refundPreview } from './fx-settlement';
import type { InvoiceListRow } from './invoices';
import type { FinanceAccount, PaymentMethod } from './money';
import { REFUND_MESSAGES, type RefundReason, type RefundRow, recordRefundInput } from './refunds';
import { isPendingRefund } from './sales-followon-views';
import { inCredit, inCreditRinggit } from './sales-views';

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
  /** The most a new refund against it may be, in `currency`. */
  refundable: number;
  /** The invoice's currency, which `refundable` and the amount are in. */
  currency: string;
  /** The invoice's rate as the database's exact text; "1.0000000000" for ringgit. */
  fx_rate_text: string | null;
  /** What the customer is in credit on the invoice (posted figures only), in its currency and in ringgit. */
  credit: number;
  credit_myr: number;
};

export type RefundForm = {
  /** The key of what the refund is put against; empty until chosen. */
  target: string;
  /** The amount as typed, in the chosen invoice's currency. */
  amount: string;
  /** For an invoice in another currency: the ringgit that left the account, as typed. */
  ringgit: string;
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
    // Any currency (stage 3c): a posted invoice always has its rate.
    if (invoice.currency !== BASE_CURRENCY && invoice.fx_rate_text === null) continue;
    const free = sen(inCredit(invoice)) - (pendingOnInvoice.get(invoice.id) ?? 0);
    if (free <= 0) continue;
    const shared = {
      invoice_id: invoice.id,
      invoice_no: invoice.invoice_no ?? '—',
      customer_name: invoice.customer_name,
      currency: invoice.currency,
      fx_rate_text: invoice.fx_rate_text,
      credit: inCredit(invoice),
      credit_myr: inCreditRinggit(invoice),
    };
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
  return `${number} · ${target.customer_name} · ${money(target.refundable, target.currency)} can be refunded`;
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
    ringgit: '',
    reason: '',
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
    scheduled: false,
  };
}

/**
 * Choosing what to refund sets the amount to all it can take; the person can then lower it. The ringgit paid out
 * starts again, and a refund on an invoice in another currency is paid out now.
 */
export function chooseRefundTarget(form: RefundForm, target: RefundTarget): RefundForm {
  if (target.key === form.target) return form;
  const foreign = target.currency !== BASE_CURRENCY;
  return {
    ...form,
    target: target.key,
    amount: amountText(target.refundable),
    ringgit: '',
    scheduled: foreign ? false : form.scheduled,
  };
}

/** The chosen target when its invoice is in another currency; null for a ringgit one or none chosen. */
export function foreignRefundTarget(form: RefundForm, targets: RefundTarget[]): RefundTarget | null {
  const target = targets.find((t) => t.key === form.target);
  return target && target.currency !== BASE_CURRENCY ? target : null;
}

/** The ringgit box, as typed. */
export function withRefundRinggit(form: RefundForm, text: string): RefundForm {
  return { ...form, ringgit: text };
}

/** The amount box's label: in the chosen invoice's currency. */
export function refundAmountLabel(form: RefundForm, targets: RefundTarget[]): string {
  return `Amount refunded (${foreignRefundTarget(form, targets)?.currency ?? 'RM'})`;
}

/**
 * Under the ringgit box: what the database will make of the refund, worked in whole sen (fx-settlement.ts), as
 * "about" (a payment or a credit note posted first can change it). Empty for a ringgit refund and while a figure
 * is not a number.
 */
export function refundPreviewNotes(form: RefundForm, targets: RefundTarget[]): string[] {
  const target = foreignRefundTarget(form, targets);
  if (!target) return [];
  const preview = refundPreview(
    form.ringgit.replace(/,/g, '').trim(),
    form.amount.replace(/,/g, '').trim(),
    target.fx_rate_text,
    target.credit,
    target.credit_myr,
  );
  if (!preview) return [];
  const at = `The invoice carries about ${rm(preview.carried)} for what is refunded.`;
  if (preview.realised === 0) return [at, 'No exchange gain or loss.'];
  const word = preview.realised > 0 ? 'gain' : 'loss';
  return [at, `Realised exchange ${word} of about ${rm(Math.abs(preview.realised))}.`];
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
  // For an invoice in another currency the ringgit paid out goes as the text typed (commas dropped), so no float
  // stands between the box and the database.
  const foreign = target !== undefined && target.currency !== BASE_CURRENCY;
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
    ...(foreign ? { amount_myr: form.ringgit.replace(/,/g, '').trim() } : {}),
  };
}

/** What a refund that was just recorded is: what the form held when it was sent, not the row it was opened from. */
export type RefundSaved = {
  /** What it was put against: the target chosen in the form. */
  target: RefundTarget;
  /** In the target's currency. */
  amount: number;
  /** For an invoice in another currency: the ringgit paid out; null (or absent) for a ringgit refund. */
  ringgit?: string | null;
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
  return target && parsed.success
    ? { target, amount: parsed.data.amount, ringgit: parsed.data.amount_myr ?? null, scheduled: parsed.data.scheduled }
    : null;
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
  const amount =
    saved.ringgit === null || saved.ringgit === undefined ? money(saved.amount, target.currency) : `${money(saved.amount, target.currency)} (${rm(Number(saved.ringgit))})`;
  return {
    subtitle: `For ${target.customer_name}`,
    lead: saved.scheduled
      ? `${amount} was saved to pay later, against ${against}. It is marked as paid or deleted on`
      : `${amount} was paid out against ${against}. It can be voided on`,
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
  // An invoice in another currency is refunded now (FIN47): the difference is decided when the money moves.
  if (target.currency !== BASE_CURRENCY && form.scheduled) return M.payNow;
  const parsed = recordRefundInput.safeParse(refundPayload(form, targets));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  if (minorUnits(target.currency) === 0 && !Number.isInteger(parsed.data.amount)) return CURRENCY_MESSAGES.wholeUnits(target.currency);
  return sen(parsed.data.amount) > sen(target.refundable) ? M.tooMuch : null;
}
