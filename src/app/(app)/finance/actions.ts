'use server';

import { revalidatePath } from 'next/cache';
import type { ZodType } from 'zod';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import {
  BILL_MESSAGES,
  type BillDetail,
  type SaveAndPostResult,
  billIdInput,
  deleteBill,
  getBill,
  postBill,
  saveBill,
  saveBillInput,
  voidBill,
} from '@/lib/finance/bills';
import {
  createContact,
  createContactInput,
  deleteContact,
  deleteContactInput,
  setContactActive,
  setContactActiveInput,
  updateContact,
  updateContactInput,
} from '@/lib/finance/contacts';
import {
  type SaveAndIssueCreditNoteResult,
  creditNoteIdInput,
  deleteCreditNote,
  issueCreditNote,
  saveCreditNote,
  saveCreditNoteInput,
  voidCreditNote,
} from '@/lib/finance/credit-notes';
import {
  INVOICE_MESSAGES,
  type InvoiceDetail,
  type SaveAndPostInvoiceResult,
  deleteInvoice,
  getInvoice,
  invoiceIdInput,
  postInvoice,
  saveInvoice,
  saveInvoiceInput,
  setEInvoice,
  setEInvoiceInput,
  voidInvoice,
} from '@/lib/finance/invoices';
import {
  deleteScheduledPayment,
  markPaymentPaid,
  markPaymentPaidInput,
  paymentIdInput,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
  voidPaymentIn,
} from '@/lib/finance/money';
import {
  createProduct,
  createProductInput,
  deleteProduct,
  deleteProductInput,
  setProductActive,
  setProductActiveInput,
  updateProduct,
  updateProductInput,
} from '@/lib/finance/products';
import {
  QUOTATION_MESSAGES,
  type QuotationDetail,
  type SaveAndSendQuotationResult,
  acceptQuotation,
  convertQuotation,
  convertQuotationInput,
  declineQuotation,
  deleteQuotation,
  getQuotation,
  quotationIdInput,
  saveQuotation,
  saveQuotationInput,
  sendQuotation,
} from '@/lib/finance/quotations';
import {
  RFQ_MESSAGES,
  type RfqDetail,
  type SaveAndSendRfqResult,
  closeRfq,
  deleteRfq,
  getRfq,
  quoteRfq,
  quoteRfqInput,
  rfqIdInput,
  saveRfq,
  saveRfqInput,
  sendRfq,
} from '@/lib/finance/rfqs';
import { deleteRefund, markRefundPaid, recordRefund, recordRefundInput, voidRefund } from '@/lib/finance/refunds';
import {
  DRAFT_NEEDS_SIGN_OFF,
  type FinResult,
  type FinanceWriteContext,
  NEEDS_SIGN_OFF,
  NOT_ALLOWED,
  PAID_NOW_NEEDS_SIGN_OFF,
  READ_FAILED,
} from '@/lib/finance/result';
import { createClient } from '@/lib/supabase/server';

const FORBIDDEN: FinResult<never> = { ok: false, error: NOT_ALLOWED };

/**
 * Who is writing, or null when the viewer may not change this workspace's data. `signOff` says whether they may
 * also post, pay and void (an owner or admin). The database asks the same question again, in a trigger, and
 * its answer is the one that counts; asking here first gives a sentence without a round trip.
 */
async function writeAccess(): Promise<{ ctx: FinanceWriteContext; signOff: boolean } | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return null;
  return {
    ctx: { client: await createClient(), orgId: viewer.orgId },
    signOff: can(viewer.role, 'sign-off-finance'),
  };
}

/** A write context, or null when the viewer may not change this workspace's data. */
async function writeCtx(): Promise<FinanceWriteContext | null> {
  return (await writeAccess())?.ctx ?? null;
}

/** An action that posts, pays or voids: an owner or admin only. */
const SIGN_OFF = { signOff: true } as const;

function refresh(paths: string[]) {
  for (const path of paths) revalidatePath(path);
}

function firstMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? 'That input was not valid.';
}

/**
 * Guard → parse → write → refresh. A rejected input answers with the schema's
 * own message, which is written for the person filling the form in. The
 * screens are refreshed after every attempt that reached the database, refused
 * or not: when someone else changed or removed the record, the page behind the
 * message shows it as it now is.
 *
 * `needs.signOff` marks an action that posts, pays or voids. Someone who may write but not sign off is told
 * so before anything is read or written. `needs.paidNow` is for the two forms that either pay now or
 * schedule: it is asked of the parsed input, and only paying now needs the sign-off.
 */
async function run<I, O>(
  paths: string[],
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<O>>,
  needs: { signOff?: boolean; paidNow?: (parsed: I) => boolean } = {},
): Promise<FinResult<O>> {
  const access = await writeAccess();
  if (!access) return FORBIDDEN;
  if (needs.signOff && !access.signOff) return { ok: false, error: NEEDS_SIGN_OFF };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  if (needs.paidNow?.(parsed.data) && !access.signOff) return { ok: false, error: PAID_NOW_NEEDS_SIGN_OFF };
  const result = await fn(access.ctx, parsed.data);
  refresh(paths);
  return result;
}

// A contact's name shows on every purchase and sales screen too, and on the cash book: the payer on a
// receipt, the payee on a voucher and the vendor on an expense.
const CONTACT_PATHS = [
  '/finance/customers-suppliers',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/rfqs',
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/cash-receipts',
  '/finance/payment-vouchers',
  '/finance/expenses',
  // Banking names who paid or was paid on every movement.
  '/finance/banking',
];
const PRODUCT_PATHS = ['/finance/products'];
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable. A payment to a
// supplier is also a voucher: Payment Vouchers lists every movement of money out.
const PURCHASE_PATHS = [
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/customers-suppliers',
  '/finance/payment-vouchers',
  // Banking lists every movement of money and the balance of the account it left.
  '/finance/banking',
];
// An invoice or a payment in changes what customers owe, which Customers & Suppliers shows as Receivable.
// It also shows on the three follow-on screens: Quotations names the invoice made from a quotation, Credit
// Notes names each note's invoice, and Refunds adds up what customers are in credit from the invoices.
const SALES_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/quotations',
  '/finance/credit-notes',
  '/finance/refunds',
  // A payment in is a receipt: Cash Receipts lists every movement of money in.
  '/finance/cash-receipts',
  // Banking lists every movement of money and the balance of the account it reached.
  '/finance/banking',
];
// A quotation is on its own screen and moves no figure anywhere else: it is not money owed, and no other
// screen counts or names it. So saving, sending, answering and deleting one refresh Quotations only.
const QUOTATION_PATHS = ['/finance/quotations'];
// An RFQ is likewise on its own screen: it is a request, not money owed, and no other screen counts or names it.
const RFQ_PATHS = ['/finance/rfqs'];
// Making an invoice from a quotation adds a draft to Invoices (its table and its "by status" chart) and puts
// that invoice in the quotation's Invoice column. A draft is not receivable, so nothing else moves.
const CONVERT_PATHS = ['/finance/quotations', '/finance/invoices'];
// A credit note that is issued or voided, and a refund at any step, change what an invoice owes or what its
// customer is in credit. That shows on Invoices (Balance, status, Total receivable, and whether a row offers
// a payment, a credit note or a refund), in the payment form on Payments In (which invoices can be paid, and
// for how much), on Customers & Suppliers (Receivable), on Credit Notes (Refunded, and whether a row offers
// a refund) and on Refunds. Quotations names an invoice by its number only, and Payments Out never shows a
// refund: neither is here.
const CREDIT_PATHS = [
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  '/finance/credit-notes',
  '/finance/refunds',
  // A refund is a voucher: Payment Vouchers lists every movement of money out. (Payments Out still never shows one.)
  '/finance/payment-vouchers',
  // A refund is money out of an account: Banking lists it.
  '/finance/banking',
];
// A draft credit note takes nothing off its invoice and nothing can be refunded against it: saving or
// deleting one moves no figure and no menu anywhere but on Credit Notes.
const CREDIT_NOTE_DRAFT_PATHS = ['/finance/credit-notes'];

/**
 * Saves a document as a draft, then posts it. When the save works and the
 * post is refused, the draft stays: the answer carries the post's message and
 * the draft's id, so the form goes on editing that draft.
 *
 * With `postNeedsSignOff`, someone who may write but not sign off gets the same
 * outcome without the post being tried: the draft is saved, and the answer
 * says who can post it.
 */
async function saveThenPost<I, O>(
  paths: string[],
  schema: ZodType<I>,
  input: unknown,
  save: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<{ id: string }>>,
  post: (ctx: FinanceWriteContext, saved: { id: string }) => Promise<FinResult<O>>,
  postNeedsSignOff = false,
): Promise<FinResult<O> & { draftId?: string }> {
  const access = await writeAccess();
  if (!access) return FORBIDDEN;
  const { ctx } = access;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const saved = await save(ctx, parsed.data);
  if (!saved.ok) {
    refresh(paths);
    return saved;
  }
  if (postNeedsSignOff && !access.signOff) {
    refresh(paths);
    return { ok: false, error: DRAFT_NEEDS_SIGN_OFF, draftId: saved.data.id };
  }
  const posted = await post(ctx, { id: saved.data.id });
  refresh(paths);
  return posted.ok ? posted : { ok: false, error: posted.error, draftId: saved.data.id };
}

/**
 * One draft with its lines, for an Edit form. A read, but only people who may
 * edit have a use for it. A document that has gone, or been posted since the
 * list was loaded, answers with that sentence and refreshes the list.
 */
async function draftForEditing<D extends { display_status?: string; status?: string }>(
  paths: string[],
  schema: ZodType<{ id: string }>,
  input: unknown,
  get: (ctx: FinanceWriteContext, id: string) => Promise<D | null>,
  messages: { gone: string; locked: string },
  label: 'bill' | 'invoice' | 'quotation' | 'RFQ',
): Promise<FinResult<D>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messages.gone };
  try {
    const document = await get(ctx, parsed.data.id);
    // A bill, an invoice or a quotation has a display status; an RFQ has only its stored one, and a draft is a draft in both.
    if (document && (document.display_status ?? document.status) === 'draft') return { ok: true, data: document };
    refresh(paths);
    return { ok: false, error: document ? messages.locked : messages.gone };
  } catch (error) {
    console.error(`[finance] a draft ${label} could not be read:`, error);
    return { ok: false, error: READ_FAILED };
  }
}

export async function createContactAction(input: unknown) {
  return run(CONTACT_PATHS, createContactInput, input, createContact);
}
export async function updateContactAction(input: unknown) {
  return run(CONTACT_PATHS, updateContactInput, input, updateContact);
}
export async function setContactActiveAction(input: unknown) {
  return run(CONTACT_PATHS, setContactActiveInput, input, setContactActive);
}
export async function deleteContactAction(input: unknown) {
  return run(CONTACT_PATHS, deleteContactInput, input, deleteContact);
}

export async function createProductAction(input: unknown) {
  return run(PRODUCT_PATHS, createProductInput, input, createProduct);
}
export async function updateProductAction(input: unknown) {
  return run(PRODUCT_PATHS, updateProductInput, input, updateProduct);
}
export async function setProductActiveAction(input: unknown) {
  return run(PRODUCT_PATHS, setProductActiveInput, input, setProductActive);
}
export async function deleteProductAction(input: unknown) {
  return run(PRODUCT_PATHS, deleteProductInput, input, deleteProduct);
}

/* ---- supplier bills ---------------------------------------------------- */

export async function saveBillAction(input: unknown) {
  return run(PURCHASE_PATHS, saveBillInput, input, saveBill);
}
export async function postBillAction(input: unknown) {
  return run(PURCHASE_PATHS, billIdInput, input, postBill, SIGN_OFF);
}
export async function voidBillAction(input: unknown) {
  return run(PURCHASE_PATHS, billIdInput, input, voidBill, SIGN_OFF);
}
export async function deleteBillAction(input: unknown) {
  return run(PURCHASE_PATHS, billIdInput, input, deleteBill);
}

/**
 * Saves the bill as a draft, then posts it. When the save works and the post
 * is refused, the draft stays: the answer carries the post's message and the
 * draft's id, so the form goes on editing that draft.
 */
export async function saveAndPostBillAction(input: unknown): Promise<SaveAndPostResult> {
  return saveThenPost(PURCHASE_PATHS, saveBillInput, input, saveBill, postBill, true);
}

/**
 * One draft bill with its lines, for the Edit form. A read, but only people
 * who may edit have a use for it. A bill that has gone, or been posted since
 * the list was loaded, answers with that sentence and refreshes the list.
 */
export async function getBillAction(input: unknown): Promise<FinResult<BillDetail>> {
  return draftForEditing(PURCHASE_PATHS, billIdInput, input, getBill, BILL_MESSAGES, 'bill');
}

/* ---- payments out ------------------------------------------------------ */

export async function recordPaymentOutAction(input: unknown) {
  return run(PURCHASE_PATHS, recordPaymentOutInput, input, recordPaymentOut, { paidNow: (payment) => !payment.scheduled });
}
export async function markPaymentPaidAction(input: unknown) {
  return run(PURCHASE_PATHS, markPaymentPaidInput, input, markPaymentPaid, SIGN_OFF);
}
export async function voidPaymentAction(input: unknown) {
  return run(PURCHASE_PATHS, paymentIdInput, input, voidPayment, SIGN_OFF);
}
export async function deleteScheduledPaymentAction(input: unknown) {
  return run(PURCHASE_PATHS, paymentIdInput, input, deleteScheduledPayment);
}

/* ---- invoices ---------------------------------------------------------- */

export async function saveInvoiceAction(input: unknown) {
  return run(SALES_PATHS, saveInvoiceInput, input, saveInvoice);
}
export async function postInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, postInvoice, SIGN_OFF);
}
export async function voidInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, voidInvoice, SIGN_OFF);
}
export async function deleteInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, deleteInvoice);
}
/** What a person has recorded about a posted invoice's e-Invois. Nothing is sent to LHDN. */
export async function setEInvoiceAction(input: unknown) {
  return run(SALES_PATHS, setEInvoiceInput, input, setEInvoice);
}

/** Saves the invoice as a draft, then posts it; see `saveThenPost`. */
export async function saveAndPostInvoiceAction(input: unknown): Promise<SaveAndPostInvoiceResult> {
  return saveThenPost(SALES_PATHS, saveInvoiceInput, input, saveInvoice, postInvoice, true);
}

/** One draft invoice with its lines, for the Edit form; see `draftForEditing`. */
export async function getInvoiceAction(input: unknown): Promise<FinResult<InvoiceDetail>> {
  return draftForEditing(SALES_PATHS, invoiceIdInput, input, getInvoice, INVOICE_MESSAGES, 'invoice');
}

/* ---- quotations -------------------------------------------------------- */

export async function saveQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, saveQuotationInput, input, saveQuotation);
}
/** Marks a draft as sent: it gets its number and is locked. Nothing is emailed. */
export async function sendQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, sendQuotation);
}
/** The customer's answer. It can be corrected from one to the other until an invoice is made. */
export async function acceptQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, acceptQuotation);
}
export async function declineQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, declineQuotation);
}
export async function deleteQuotationAction(input: unknown) {
  return run(QUOTATION_PATHS, quotationIdInput, input, deleteQuotation);
}
/** Makes a draft invoice from an accepted quotation, dated with the date the person sends, and refreshes Invoices as well. */
export async function convertQuotationAction(input: unknown) {
  return run(CONVERT_PATHS, convertQuotationInput, input, convertQuotation);
}

/** Saves the quotation as a draft, then marks it as sent; see `saveThenPost`. */
export async function saveAndSendQuotationAction(input: unknown): Promise<SaveAndSendQuotationResult> {
  return saveThenPost(QUOTATION_PATHS, saveQuotationInput, input, saveQuotation, sendQuotation);
}

/** One draft quotation with its lines, for the Edit form; see `draftForEditing`. */
export async function getQuotationAction(input: unknown): Promise<FinResult<QuotationDetail>> {
  return draftForEditing(QUOTATION_PATHS, quotationIdInput, input, getQuotation, QUOTATION_MESSAGES, 'quotation');
}

/* ---- RFQs -------------------------------------------------------------- */

export async function saveRfqAction(input: unknown) {
  return run(RFQ_PATHS, saveRfqInput, input, saveRfq);
}
/** Marks a draft as sent: it gets its number and is locked. Nothing is emailed. */
export async function sendRfqAction(input: unknown) {
  return run(RFQ_PATHS, rfqIdInput, input, sendRfq);
}
/** The supplier's answer: a price for every line. The RFQ becomes quoted. */
export async function quoteRfqAction(input: unknown) {
  return run(RFQ_PATHS, quoteRfqInput, input, quoteRfq);
}
/** The supplier declined, or the RFQ was not taken up. */
export async function closeRfqAction(input: unknown) {
  return run(RFQ_PATHS, rfqIdInput, input, closeRfq);
}
export async function deleteRfqAction(input: unknown) {
  return run(RFQ_PATHS, rfqIdInput, input, deleteRfq);
}

/** Saves the RFQ as a draft, then marks it as sent; see `saveThenPost`. */
export async function saveAndSendRfqAction(input: unknown): Promise<SaveAndSendRfqResult> {
  return saveThenPost(RFQ_PATHS, saveRfqInput, input, saveRfq, sendRfq);
}

/** One draft RFQ with its lines, for the Edit form; see `draftForEditing`. */
export async function getRfqAction(input: unknown): Promise<FinResult<RfqDetail>> {
  return draftForEditing(RFQ_PATHS, rfqIdInput, input, getRfq, RFQ_MESSAGES, 'RFQ');
}

/**
 * One sent RFQ with its lines, for the Record prices form. `getRfqAction` reads drafts only; this reads the
 * other end of the life of an RFQ, the one awaiting the supplier's answer.
 */
export async function getSentRfqAction(input: unknown): Promise<FinResult<RfqDetail>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = rfqIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: RFQ_MESSAGES.gone };
  try {
    const rfq = await getRfq(ctx, parsed.data.id);
    if (rfq?.status === 'sent') return { ok: true, data: rfq };
    refresh(RFQ_PATHS);
    return { ok: false, error: rfq ? RFQ_MESSAGES.locked : RFQ_MESSAGES.gone };
  } catch (error) {
    console.error('[finance] a sent RFQ could not be read:', error);
    return { ok: false, error: READ_FAILED };
  }
}

/* ---- credit notes ------------------------------------------------------ */

/** Creates a draft credit note, or changes one. A draft moves nothing but its own list. */
export async function saveCreditNoteAction(input: unknown) {
  return run(CREDIT_NOTE_DRAFT_PATHS, saveCreditNoteInput, input, saveCreditNote);
}
/** Issues a draft: it gets its number and is locked, and its invoice owes that much less. */
export async function issueCreditNoteAction(input: unknown) {
  return run(CREDIT_PATHS, creditNoteIdInput, input, issueCreditNote, SIGN_OFF);
}
/** Voids an issued credit note: its invoice owes the amount again. Refused while a refund depends on it. */
export async function voidCreditNoteAction(input: unknown) {
  return run(CREDIT_PATHS, creditNoteIdInput, input, voidCreditNote, SIGN_OFF);
}
export async function deleteCreditNoteAction(input: unknown) {
  return run(CREDIT_NOTE_DRAFT_PATHS, creditNoteIdInput, input, deleteCreditNote);
}

/** Saves the credit note as a draft, then issues it; see `saveThenPost`. */
export async function saveAndIssueCreditNoteAction(input: unknown): Promise<SaveAndIssueCreditNoteResult> {
  return saveThenPost(CREDIT_PATHS, saveCreditNoteInput, input, saveCreditNote, issueCreditNote, true);
}

/* ---- refunds ----------------------------------------------------------- */

/** Records a refund against one invoice or one credit note, paid out now or left pending. */
export async function recordRefundAction(input: unknown) {
  return run(CREDIT_PATHS, recordRefundInput, input, recordRefund, { paidNow: (refund) => !refund.scheduled });
}
/** A pending refund has been paid out. The database looks at the customer's credit again and may refuse. */
export async function markRefundPaidAction(input: unknown) {
  return run(CREDIT_PATHS, markPaymentPaidInput, input, markRefundPaid, SIGN_OFF);
}
/** Voids a refund that was paid out: the customer is in credit by that amount again. */
export async function voidRefundAction(input: unknown) {
  return run(CREDIT_PATHS, paymentIdInput, input, voidRefund, SIGN_OFF);
}
export async function deleteRefundAction(input: unknown) {
  return run(CREDIT_PATHS, paymentIdInput, input, deleteRefund);
}

/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
  return run(SALES_PATHS, recordPaymentInInput, input, recordPaymentIn, SIGN_OFF);
}
/** Voiding money in refreshes the sales screens, and answers in the sentences of a payment in. */
export async function voidPaymentInAction(input: unknown) {
  return run(SALES_PATHS, paymentIdInput, input, voidPaymentIn, SIGN_OFF);
}
