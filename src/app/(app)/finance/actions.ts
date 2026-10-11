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
  deleteScheduledPayment,
  markPaymentPaid,
  markPaymentPaidInput,
  paymentIdInput,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
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
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = saveBillInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const saved = await saveBill(ctx, parsed.data);
  if (!saved.ok) {
    refresh(PURCHASE_PATHS);
    return saved;
  }
  const posted = await postBill(ctx, { id: saved.data.id });
  refresh(PURCHASE_PATHS);
  return posted.ok ? posted : { ok: false, error: posted.error, draftId: saved.data.id };
}

/**
 * One draft bill with its lines, for the Edit form. A read, but only people
 * who may edit have a use for it. A bill that has gone, or been posted since
 * the list was loaded, answers with that sentence and refreshes the list.
 */
export async function getBillAction(input: unknown): Promise<FinResult<BillDetail>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = billIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: BILL_MESSAGES.gone };
  try {
    const bill = await getBill(ctx, parsed.data.id);
    if (bill?.display_status === 'draft') return { ok: true, data: bill };
    refresh(PURCHASE_PATHS);
    return { ok: false, error: bill ? BILL_MESSAGES.locked : BILL_MESSAGES.gone };
  } catch (error) {
    console.error('[finance] getBill failed:', error);
    return { ok: false, error: READ_FAILED };
  }
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
