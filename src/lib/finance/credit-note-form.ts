/**
 * The credit note form's rules, kept out of the component so they can be
 * tested: which invoices can take a credit note and for how much, what a new
 * form holds, what is wrong with the form, and what is sent to
 * saveCreditNoteAction. Pure. A credit note is one amount against one posted
 * invoice, with a reason: it has no lines and moves no money, so it shares
 * neither the document card nor the payment card.
 *
 * An invoice in another currency (stage 3c) takes a credit note in its own
 * currency, at its own rate: the amount is typed in that currency (whole
 * units for one with no cents), and the form shows about what it takes off in
 * ringgit, worked as the database works it (fx-settlement.ts).
 */
import { amountText, round2, sen } from './allocation-form';
import { CREDIT_NOTE_MESSAGES, type CreditNoteReason, type CreditNoteRow, saveCreditNoteInput } from './credit-notes';
import { BASE_CURRENCY, minorUnits } from './currencies';
import { CURRENCY_MESSAGES } from './document-currency';
import { money, rm, typedNumber } from './format';
import { creditNoteRinggit } from './fx-settlement';
import type { InvoiceListRow } from './invoices';
import { WRITE_FAILED } from './result';

const M = CREDIT_NOTE_MESSAGES;

export type CreditableInvoice = {
  id: string;
  invoice_no: string;
  customer_id: string;
  customer_name: string;
  total: number;
  /** What the invoice's issued credit notes already come to. */
  credited: number;
  /** What a new credit note may be for: the total less what is already credited. */
  creditable: number;
  /** The invoice's currency: total, credited, creditable and balance are in it. */
  currency: string;
  /** The invoice's rate as the database's exact text; "1.0000000000" for ringgit. */
  fx_rate_text: string | null;
  /** What is still owed (posted money in, credit notes and refunds counted), in its currency; below 0 in credit. */
  balance: number;
  /** The same in ringgit: what the invoice still carries. */
  balance_myr: number;
};

export type CreditNoteForm = {
  /** Present when a saved draft is being changed. */
  id?: string;
  invoiceId: string;
  date: string;
  /** Empty until a reason is chosen. */
  reason: CreditNoteReason | '';
  /** The amount as typed. */
  amount: string;
  notes: string;
};

/**
 * The invoices a credit note can go against: posted ("Sent", "Overdue" or
 * "Paid"), and not yet credited for their whole total. All the issued credit
 * notes of an invoice together never exceed its total; what has been paid
 * does not limit it, since crediting a paid invoice is what leaves a customer
 * in credit. A draft credit note is not counted, as the database does not
 * count one until it is issued. `keepId` is the invoice the form is on: it
 * stays in the list with nothing left to credit, so the form can say so,
 * unless it is no longer posted.
 */
export function creditableInvoices(invoices: InvoiceListRow[], keepId?: string): CreditableInvoice[] {
  // Any currency (stage 3c): a credit note on an invoice in another currency is in its currency, at its rate. A
  // posted invoice always has its rate.
  return invoices
    .filter(
      (i) =>
        (i.display_status === 'sent' || i.display_status === 'overdue' || i.display_status === 'paid') &&
        (i.currency === BASE_CURRENCY || i.fx_rate_text !== null),
    )
    .map((i) => ({
      id: i.id,
      invoice_no: i.invoice_no ?? '—',
      customer_id: i.customer_id,
      customer_name: i.customer_name,
      total: i.total,
      credited: i.credited,
      creditable: Math.max(round2(i.total - i.credited), 0),
      currency: i.currency,
      fx_rate_text: i.fx_rate_text,
      balance: i.balance,
      balance_myr: i.balance_myr ?? i.balance,
    }))
    .filter((i) => i.creditable > 0 || i.id === keepId)
    // By number as a number: INV-9999 comes before INV-10000.
    .sort(
      (x, y) => x.customer_name.localeCompare(y.customer_name) || x.invoice_no.localeCompare(y.invoice_no, undefined, { numeric: true }),
    );
}

/** How the form's picker lists an invoice: its number, its customer, and what it has left to credit. */
export function creditableLabel(invoice: CreditableInvoice): string {
  return `${invoice.invoice_no} · ${invoice.customer_name} · ${money(invoice.creditable, invoice.currency)} left to credit`;
}

/**
 * A new credit note dated today, with nothing chosen. With `invoiceId` (the
 * Credit note choice on an invoice's row) that invoice is chosen, when it can
 * still take a credit note. The amount is left for the person: a credit note
 * is seldom for everything an invoice has left.
 */
export function newCreditNoteForm(creditable: CreditableInvoice[], today: string, invoiceId?: string): CreditNoteForm {
  return {
    invoiceId: invoiceId && creditable.some((i) => i.id === invoiceId) ? invoiceId : '',
    date: today,
    reason: '',
    amount: '',
    notes: '',
  };
}

/** A saved draft, as the form shows it. The list row carries everything a credit note has, so nothing more is read. */
export function creditNoteFormFromRow(note: CreditNoteRow): CreditNoteForm {
  return {
    id: note.id,
    invoiceId: note.invoice_id,
    date: note.credit_date,
    reason: note.reason,
    amount: amountText(note.amount),
    notes: note.notes ?? '',
  };
}

/** What is sent to saveCreditNoteAction. The amount is a number; a box that is not a number goes as NaN and is refused. */
export function creditNotePayload(form: CreditNoteForm) {
  return {
    ...(form.id ? { id: form.id } : {}),
    invoice_id: form.invoiceId,
    credit_date: form.date,
    reason: form.reason,
    amount: typedNumber(form.amount) ?? Number.NaN,
    notes: form.notes,
  };
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent. `creditable` is
 * `creditableInvoices` with the form's own invoice kept: an invoice that is
 * not in it was voided since the form opened, and one with less left than
 * the amount was credited meanwhile.
 */
export function creditNoteFormError(form: CreditNoteForm, creditable: CreditableInvoice[]): string | null {
  const parsed = saveCreditNoteInput.safeParse(creditNotePayload(form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.amount;
  const invoice = creditable.find((i) => i.id === form.invoiceId);
  if (!invoice) return M.notPosted;
  if (minorUnits(invoice.currency) === 0 && !Number.isInteger(parsed.data.amount)) return CURRENCY_MESSAGES.wholeUnits(invoice.currency);
  return sen(parsed.data.amount) > sen(invoice.creditable) ? M.tooMuch : null;
}

/** The invoice the form is on, when it is in another currency; null for a ringgit one or none chosen. */
export function foreignCreditable(form: CreditNoteForm, creditable: CreditableInvoice[]): CreditableInvoice | null {
  const invoice = creditable.find((i) => i.id === form.invoiceId);
  return invoice && invoice.currency !== BASE_CURRENCY ? invoice : null;
}

/** The amount box's label: in the chosen invoice's currency. */
export function creditNoteAmountLabel(form: CreditNoteForm, creditable: CreditableInvoice[]): string {
  return `Amount (${foreignCreditable(form, creditable)?.currency ?? 'RM'})`;
}

/**
 * Under the amount, for an invoice in another currency: about what the credit note takes off in ringgit, worked
 * as the database works it when it is issued (at the invoice's rate, or exactly what is still open when it clears
 * the invoice). Null for a ringgit invoice and while the amount is not a number.
 */
export function creditNoteRinggitNote(form: CreditNoteForm, creditable: CreditableInvoice[]): string | null {
  const invoice = foreignCreditable(form, creditable);
  if (!invoice) return null;
  const ringgit = creditNoteRinggit(form.amount.replace(/,/g, '').trim(), invoice.fx_rate_text, invoice.balance, invoice.balance_myr);
  return ringgit === null ? null : `≈ ${rm(ringgit)} at the invoice’s rate. No exchange gain or loss.`;
}

/** What a credit note that was just saved is: what the form held when it was sent, not the row it was opened from. */
export type CreditNoteSaved = {
  /** The number of the invoice chosen in the form. */
  invoice_no: string;
  customer_name: string;
  amount: number;
  /** The invoice's currency, which the amount is in. */
  currency: string;
  /** True when it was saved and issued, false when it was saved as a draft. */
  issued: boolean;
};

/**
 * What the form is about to save, for the note a page shows afterwards. The
 * amount is the one the schema makes of the payload, rounded to the sen as it
 * is stored: 1.005 typed is RM 1.00 saved, and the note must not say RM 1.01.
 * Null while the form has no offered invoice or cannot be sent; a form that
 * `creditNoteFormError` passes always can.
 */
export function creditNoteSaved(form: CreditNoteForm, creditable: CreditableInvoice[], issued: boolean): CreditNoteSaved | null {
  const invoice = creditable.find((i) => i.id === form.invoiceId);
  const parsed = saveCreditNoteInput.safeParse(creditNotePayload(form));
  if (!invoice || !parsed.success) return null;
  return {
    invoice_no: invoice.invoice_no,
    customer_name: invoice.customer_name,
    amount: parsed.data.amount,
    currency: invoice.currency,
    issued,
  };
}

/**
 * The note a page shows once a credit note is saved from an invoice's row:
 * its title, the invoice and customer it is for, and a sentence that leads
 * up to the link to Credit Notes. It names the invoice the credit note went
 * against, which the person may have changed in the form. An issued credit
 * note can only be refunded while its customer is in credit, which one on an
 * invoice that is still owed does not make them, so the note says when.
 */
export function creditNoteSavedNote(saved: CreditNoteSaved): { title: string; subtitle: string; lead: string } {
  const numbered = saved.invoice_no !== '—';
  const invoice = numbered ? saved.invoice_no : 'the invoice';
  return {
    title: saved.issued ? 'Credit note issued' : 'Credit note saved',
    subtitle: `${numbered ? saved.invoice_no : 'The invoice'} to ${saved.customer_name}`,
    lead: saved.issued
      ? `A credit note of ${money(saved.amount, saved.currency)} was issued against ${invoice}. It can be voided, or refunded while the customer is in credit, on`
      : `A draft credit note of ${money(saved.amount, saved.currency)} was saved against ${invoice}. It is issued, changed or deleted on`,
  };
}

/** What the form says when the credit note was saved as a draft but issuing it was refused. */
export function creditNoteSavedNotIssued(error: string): string {
  if (error === WRITE_FAILED) return 'The credit note was saved as a draft, but issuing it failed. Please try again.';
  return `The credit note was saved as a draft, but it was not issued. ${error}`;
}
