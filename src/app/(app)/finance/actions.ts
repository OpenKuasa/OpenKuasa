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
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED, READ_FAILED } from '@/lib/finance/result';
import { createClient } from '@/lib/supabase/server';

const FORBIDDEN: FinResult<never> = { ok: false, error: NOT_ALLOWED };

/** A write context, or null when the viewer may not change this workspace's data. */
async function writeCtx(): Promise<FinanceWriteContext | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return null;
  return { client: await createClient(), orgId: viewer.orgId };
}

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
 */
async function run<I, O>(
  paths: string[],
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<O>>,
): Promise<FinResult<O>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await fn(ctx, parsed.data);
  refresh(paths);
  return result;
}

// A contact's name shows on the bills, invoices and payments screens too.
const CONTACT_PATHS = [
  '/finance/customers-suppliers',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/invoices',
  '/finance/payments-in',
];
const PRODUCT_PATHS = ['/finance/products'];
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable.
const PURCHASE_PATHS = ['/finance/supplier-bills', '/finance/payments-out', '/finance/customers-suppliers'];
// An invoice or a payment in changes what customers owe, which Customers & Suppliers shows as Receivable.
const SALES_PATHS = ['/finance/invoices', '/finance/payments-in', '/finance/customers-suppliers'];

/**
 * Saves a document as a draft, then posts it. When the save works and the
 * post is refused, the draft stays: the answer carries the post's message and
 * the draft's id, so the form goes on editing that draft.
 */
async function saveThenPost<I, O>(
  paths: string[],
  schema: ZodType<I>,
  input: unknown,
  save: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<{ id: string }>>,
  post: (ctx: FinanceWriteContext, saved: { id: string }) => Promise<FinResult<O>>,
): Promise<FinResult<O> & { draftId?: string }> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const saved = await save(ctx, parsed.data);
  if (!saved.ok) {
    refresh(paths);
    return saved;
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
async function draftForEditing<D extends { display_status: string }>(
  paths: string[],
  schema: ZodType<{ id: string }>,
  input: unknown,
  get: (ctx: FinanceWriteContext, id: string) => Promise<D | null>,
  messages: { gone: string; locked: string },
  label: 'bill' | 'invoice',
): Promise<FinResult<D>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messages.gone };
  try {
    const document = await get(ctx, parsed.data.id);
    if (document?.display_status === 'draft') return { ok: true, data: document };
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
  return run(PURCHASE_PATHS, billIdInput, input, postBill);
}
export async function voidBillAction(input: unknown) {
  return run(PURCHASE_PATHS, billIdInput, input, voidBill);
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
  return saveThenPost(PURCHASE_PATHS, saveBillInput, input, saveBill, postBill);
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
  return run(PURCHASE_PATHS, recordPaymentOutInput, input, recordPaymentOut);
}
export async function markPaymentPaidAction(input: unknown) {
  return run(PURCHASE_PATHS, markPaymentPaidInput, input, markPaymentPaid);
}
export async function voidPaymentAction(input: unknown) {
  return run(PURCHASE_PATHS, paymentIdInput, input, voidPayment);
}
export async function deleteScheduledPaymentAction(input: unknown) {
  return run(PURCHASE_PATHS, paymentIdInput, input, deleteScheduledPayment);
}

/* ---- invoices ---------------------------------------------------------- */

export async function saveInvoiceAction(input: unknown) {
  return run(SALES_PATHS, saveInvoiceInput, input, saveInvoice);
}
export async function postInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, postInvoice);
}
export async function voidInvoiceAction(input: unknown) {
  return run(SALES_PATHS, invoiceIdInput, input, voidInvoice);
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
  return saveThenPost(SALES_PATHS, saveInvoiceInput, input, saveInvoice, postInvoice);
}

/** One draft invoice with its lines, for the Edit form; see `draftForEditing`. */
export async function getInvoiceAction(input: unknown): Promise<FinResult<InvoiceDetail>> {
  return draftForEditing(SALES_PATHS, invoiceIdInput, input, getInvoice, INVOICE_MESSAGES, 'invoice');
}

/* ---- payments in ------------------------------------------------------- */

export async function recordPaymentInAction(input: unknown) {
  return run(SALES_PATHS, recordPaymentInInput, input, recordPaymentIn);
}
/** Voiding money in refreshes the sales screens, and answers in the sentences of a payment in. */
export async function voidPaymentInAction(input: unknown) {
  return run(SALES_PATHS, paymentIdInput, input, voidPaymentIn);
}
