'use server';

import { revalidatePath } from 'next/cache';
import type { ZodType } from 'zod';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import {
  BANK_ACCOUNT_MESSAGES,
  changesOpeningBalance,
  createBankAccount,
  createBankAccountInput,
  setBankAccountActive,
  setBankAccountActiveInput,
  setsOpeningBalance,
  updateBankAccount,
  updateBankAccountInput,
} from '@/lib/finance/bank-accounts';
import {
  CATEGORY_MESSAGES,
  createCategory,
  createCategoryInput,
  renameCategory,
  renameCategoryInput,
  setCategoryActive,
  setCategoryActiveInput,
} from '@/lib/finance/categories';
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
  type SaveAndPostCashReceiptResult,
  cashReceiptIdInput,
  deleteCashReceipt,
  postCashReceipt,
  saveCashReceipt,
  saveCashReceiptInput,
  voidCashReceipt,
} from '@/lib/finance/cash-receipts';
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
import { markExpensePaid, markExpensePaidInput } from '@/lib/finance/expense-payment';
import {
  EXPENSE_MESSAGES,
  approveExpense,
  deleteExpense,
  expenseDecisionInput,
  expenseIdInput,
  rejectExpense,
  saveExpense,
  saveExpenseInput,
} from '@/lib/finance/expenses';
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
  LEDGER_MESSAGES,
  type JournalDetail,
  type SaveAndPostJournalResult,
  accountIdInput,
  createAccount,
  createAccountInput,
  deleteAccount,
  deleteJournal,
  getJournal,
  journalIdInput,
  postJournal,
  reverseJournal,
  reverseJournalInput,
  saveJournal,
  saveJournalInput,
  setAccountActive,
  setAccountActiveInput,
  updateAccount,
  updateAccountInput,
} from '@/lib/finance/ledger';
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
  convertRfq,
  deleteRfq,
  getRfq,
  getRfqGroup,
  quoteRfq,
  quoteRfqInput,
  rfqIdInput,
  saveRfq,
  saveRfqInput,
  sendRfq,
} from '@/lib/finance/rfqs';
import {
  PURCHASE_ORDER_MESSAGES,
  type PurchaseOrderDetail,
  type SaveAndSubmitPurchaseOrderResult,
  billFromPurchaseOrder,
  billFromPurchaseOrderInput,
  cancelPurchaseOrder,
  closePurchaseOrder,
  decidePurchaseOrder,
  decidePurchaseOrderInput,
  deletePurchaseOrder,
  getPurchaseOrder,
  purchaseOrderIdInput,
  receivePurchaseOrder,
  receivePurchaseOrderInput,
  savePurchaseOrder,
  savePurchaseOrderInput,
  submitPurchaseOrder,
  withdrawPurchaseOrder,
} from '@/lib/finance/purchase-orders';
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
import {
  VOUCHER_MESSAGES,
  approveVoucher,
  deleteVoucher,
  deleteVoucherInput,
  markVoucherPaid,
  markVoucherPaidInput,
  recordVoucher,
  recordVoucherInput,
  rejectVoucher,
  saveVoucher,
  saveVoucherInput,
  submitVoucher,
  voidVoucher,
  voidVoucherInput,
  voucherDecisionInput,
} from '@/lib/finance/vouchers';
import { TRANSFER_MESSAGES, recordTransfer, recordTransferInput, voidTransfer, voidTransferInput } from '@/lib/finance/transfers';
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
/** Approving, rejecting or closing a purchase order: an owner or admin only, told so in the order's own words. */
const PURCHASE_ORDER_SIGN_OFF = { signOff: true, signOffError: PURCHASE_ORDER_MESSAGES.needsSignOff } as const;

/** Every ledger action: changing accounts and journals is an owner's or admin's, told so in the ledger's own words. */
const LEDGER_SIGN_OFF = { signOff: true, signOffError: LEDGER_MESSAGES.needsSignOff } as const;

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
 * so before anything is read or written, in `needs.signOffError` when the action has its own sentence for it. `needs.paidNow` is for the forms that either pay now or
 * schedule: it is asked of the parsed input, and only paying now needs the sign-off (`needs.paidNowError` when the form has its own sentence for it).
 */
async function run<I, O>(
  paths: string[],
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<O>>,
  needs: { signOff?: boolean; signOffError?: string; paidNow?: (parsed: I) => boolean; paidNowError?: string } = {},
): Promise<FinResult<O>> {
  const access = await writeAccess();
  if (!access) return FORBIDDEN;
  if (needs.signOff && !access.signOff) return { ok: false, error: needs.signOffError ?? NEEDS_SIGN_OFF };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  if (needs.paidNow?.(parsed.data) && !access.signOff) return { ok: false, error: needs.paidNowError ?? PAID_NOW_NEEDS_SIGN_OFF };
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
  // A purchase order names its supplier.
  '/finance/purchase-orders',
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
  // A ledger entry's description carries the customer's or supplier's name.
  '/finance/journals',
];
const PRODUCT_PATHS = ['/finance/products'];
// The three ledger screens read the books, which every document that posts, voids, pays or is deleted changes:
// Chart of Accounts shows each account's balance, Journals lists the manual entries beside them and Reports
// works the statements out of every line. So every list below that belongs to such an action ends with these three.
const LEDGER_PATHS = ['/finance/chart-of-accounts', '/finance/journals', '/finance/reports'];
// A bank or cash account is on Banking, and in the account picker of every form that records money: the payment forms on
// Supplier Bills, Payments Out, Invoices and Payments In, the refund forms on Credit Notes and Refunds, and the
// receipt form on Cash Receipts. A new, renamed, archived or restored account must appear, change or go there.
// Cash Receipts and Payment Vouchers also name each movement's account. The three ledger screens end the list: each
// bank or cash account has a ledger account that is renamed and archived with it, and an opening balance is an
// entry in the books, which Reports works its statements from.
const BANK_ACCOUNT_PATHS = [
  '/finance/banking',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/cash-receipts',
  '/finance/payment-vouchers',
  ...LEDGER_PATHS,
];
// A transfer between two accounts is on Banking, where both balances move, and in the books: one entry, debit the
// account it reached and credit the one it left, and a second entry that reverses it when it is voided. It is on
// no other screen: Cash Receipts and Payment Vouchers leave both sides of a transfer out, and no document is paid.
const TRANSFER_PATHS = ['/finance/banking', ...LEDGER_PATHS];
// A bill or a payment changes what is owed, which Customers & Suppliers shows as Payable. A payment to a
// supplier is also a voucher: Payment Vouchers lists every movement of money out.
const PURCHASE_PATHS = [
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/customers-suppliers',
  '/finance/payment-vouchers',
  // Banking lists every movement of money and the balance of the account it left.
  '/finance/banking',
  ...LEDGER_PATHS,
];
// A bill saved, posted, voided or deleted changes the billed total of the purchase order it is raised against
// (drafts count), so Purchase Orders refreshes with the purchase screens. A payment does not, so it keeps PURCHASE_PATHS.
// Receipts Inbox names the bill a receipt is tied to: posting gives a draft its number, and deleting a draft sends
// its receipt back to Unmatched. KEEP IN STEP with RECEIPT_BILL_PATHS in src/lib/finance/receipt-match.ts.
const BILL_PATHS = [...PURCHASE_PATHS, '/finance/purchase-orders', '/finance/receipts-inbox'];
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
  ...LEDGER_PATHS,
];
// A quotation is on its own screen and moves no figure anywhere else: it is not money owed, and no other
// screen counts or names it. So saving, sending, answering and deleting one refresh Quotations only.
const QUOTATION_PATHS = ['/finance/quotations'];
// An RFQ is likewise on its own screen: it is a request, not money owed, and no other screen counts or names it.
const RFQ_PATHS = ['/finance/rfqs'];
// A purchase order is on its own screen, and two others read it: RFQs shows its number and decides "Make purchase
// order" from it, and the bill form on Supplier Bills lists the approved orders. So its own writes refresh all three.
// Its billed total moves when a bill does (BILL_PATHS).
const PURCHASE_ORDER_PATHS = ['/finance/purchase-orders', '/finance/rfqs', '/finance/supplier-bills'];
// Making a purchase order from an RFQ adds a draft to Purchase Orders and puts that order in the RFQ's column.
const CONVERT_RFQ_PATHS = ['/finance/rfqs', '/finance/purchase-orders'];
// Raising a bill from an order adds a draft to Supplier Bills and moves the order's billed total. A draft bill is
// not payable, so nothing else moves.
const ORDER_BILL_PATHS = ['/finance/purchase-orders', '/finance/supplier-bills'];
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
  ...LEDGER_PATHS,
];
// A draft credit note takes nothing off its invoice and nothing can be refunded against it: saving or
// deleting one moves no figure and no menu anywhere but on Credit Notes, and nothing reaches the books until
// it is issued.
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
 * One document with its lines, for a form that works on it in one status: a draft for an Edit form, a sent RFQ
 * for "Record prices", an approved purchase order for "Record delivery". A read, but only people who may edit
 * have a use for it. A document that has gone, or left that status since the list was loaded, answers with that
 * sentence and refreshes the list. With `wanted` null any status will do: a document read only to copy from.
 */
async function documentInStatus<D extends { display_status?: string; status?: string }>(
  paths: string[],
  schema: ZodType<{ id: string }>,
  input: unknown,
  get: (ctx: FinanceWriteContext, id: string) => Promise<D | null>,
  messages: { gone: string; locked: string },
  label: 'bill' | 'invoice' | 'quotation' | 'RFQ' | 'purchase order' | 'journal',
  wanted: string | null,
): Promise<FinResult<D>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: messages.gone };
  try {
    const document = await get(ctx, parsed.data.id);
    // A bill, an invoice or a quotation has a display status; an RFQ or an order has only its stored one, and a draft is a draft in both.
    if (document && (wanted === null || (document.display_status ?? document.status) === wanted)) return { ok: true, data: document };
    refresh(paths);
    return { ok: false, error: document ? messages.locked : messages.gone };
  } catch (error) {
    console.error(`[finance] ${wanted === null ? 'a' : `a ${wanted}`} ${label} could not be read:`, error);
    return { ok: false, error: READ_FAILED };
  }
}

/** One draft with its lines, for an Edit form; see `documentInStatus`. */
function draftForEditing<D extends { display_status?: string; status?: string }>(
  paths: string[],
  schema: ZodType<{ id: string }>,
  input: unknown,
  get: (ctx: FinanceWriteContext, id: string) => Promise<D | null>,
  messages: { gone: string; locked: string },
  label: 'bill' | 'invoice' | 'quotation' | 'RFQ' | 'purchase order' | 'journal',
): Promise<FinResult<D>> {
  return documentInStatus(paths, schema, input, get, messages, label, 'draft');
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

/* ---- bank and cash accounts (Banking) ---------------------------------- */

// Not the chart of accounts: a ledger account is created, changed and archived by the actions further down
// (createAccountAction and its neighbours, from ledger.ts), which are an owner's or admin's altogether.

/**
 * Guard → parse → write → refresh for the two account forms. Anyone who may write adds and changes an account;
 * an opening balance is an owner's or admin's, and `opening` says whether the parsed input carries one. Someone
 * who may not is told so before anything is written. The database refuses the same thing (FIN14).
 */
async function runBankAccount<I, O>(
  schema: ZodType<I>,
  input: unknown,
  fn: (ctx: FinanceWriteContext, parsed: I) => Promise<FinResult<O>>,
  opening: (parsed: I) => boolean,
): Promise<FinResult<O>> {
  const access = await writeAccess();
  if (!access) return FORBIDDEN;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  if (opening(parsed.data) && !access.signOff) return { ok: false, error: BANK_ACCOUNT_MESSAGES.needsSignOff };
  const result = await fn(access.ctx, parsed.data);
  refresh(BANK_ACCOUNT_PATHS);
  return result;
}

export async function createBankAccountAction(input: unknown) {
  return runBankAccount(createBankAccountInput, input, createBankAccount, setsOpeningBalance);
}
export async function updateBankAccountAction(input: unknown) {
  return runBankAccount(updateBankAccountInput, input, updateBankAccount, changesOpeningBalance);
}
/** Archives or restores an account. The database refuses an archive while money is still to be paid from it. */
export async function setBankAccountActiveAction(input: unknown) {
  return run(BANK_ACCOUNT_PATHS, setBankAccountActiveInput, input, setBankAccountActive);
}

/* ---- transfers between accounts (Banking) ------------------------------- */

/** Recording and voiding a transfer: an owner or admin only, told so in the transfer's own words. */
const TRANSFER_SIGN_OFF = { signOff: true, signOffError: TRANSFER_MESSAGES.needsSignOff } as const;

/** Moves money between two active accounts: both sides are posted at once with one TR- number. */
export async function recordTransferAction(input: unknown) {
  return run(TRANSFER_PATHS, recordTransferInput, input, recordTransfer, TRANSFER_SIGN_OFF);
}
/** Voids both sides of a posted transfer. */
export async function voidTransferAction(input: unknown) {
  return run(TRANSFER_PATHS, voidTransferInput, input, voidTransfer, TRANSFER_SIGN_OFF);
}

/* ---- supplier bills ---------------------------------------------------- */

export async function saveBillAction(input: unknown) {
  return run(BILL_PATHS, saveBillInput, input, saveBill);
}
export async function postBillAction(input: unknown) {
  return run(BILL_PATHS, billIdInput, input, postBill, SIGN_OFF);
}
export async function voidBillAction(input: unknown) {
  return run(BILL_PATHS, billIdInput, input, voidBill, SIGN_OFF);
}
export async function deleteBillAction(input: unknown) {
  return run(BILL_PATHS, billIdInput, input, deleteBill);
}

/**
 * Saves the bill as a draft, then posts it. When the save works and the post
 * is refused, the draft stays: the answer carries the post's message and the
 * draft's id, so the form goes on editing that draft.
 */
export async function saveAndPostBillAction(input: unknown): Promise<SaveAndPostResult> {
  return saveThenPost(BILL_PATHS, saveBillInput, input, saveBill, postBill, true);
}

/**
 * One draft bill with its lines, for the Edit form. A read, but only people
 * who may edit have a use for it. A bill that has gone, or been posted since
 * the list was loaded, answers with that sentence and refreshes the list.
 */
export async function getBillAction(input: unknown): Promise<FinResult<BillDetail>> {
  return draftForEditing(BILL_PATHS, billIdInput, input, getBill, BILL_MESSAGES, 'bill');
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
  return documentInStatus(RFQ_PATHS, rfqIdInput, input, getRfq, RFQ_MESSAGES, 'RFQ', 'sent');
}

/**
 * One RFQ with its lines, in whatever status, for New RFQ to copy to another supplier. Nothing is changed;
 * `getRfqAction` and `getSentRfqAction` read one status each.
 */
export async function getRfqForCopyAction(input: unknown): Promise<FinResult<RfqDetail>> {
  return documentInStatus(RFQ_PATHS, rfqIdInput, input, getRfq, RFQ_MESSAGES, 'RFQ', null);
}

/**
 * Every RFQ of one RFQ's group that has gone to its supplier, with its lines, for Compare quotes. Nothing
 * is changed. Fewer than two means the group came apart since the page loaded (its first RFQ was a draft,
 * and was deleted), so there is nothing to compare: the page is refreshed and its menu stops offering it.
 */
export async function getRfqComparisonAction(input: unknown): Promise<FinResult<RfqDetail[]>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = rfqIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: RFQ_MESSAGES.gone };
  try {
    const group = await getRfqGroup(ctx, parsed.data.id);
    if (group.length >= 2) return { ok: true, data: group };
    refresh(RFQ_PATHS);
    return { ok: false, error: group.length ? RFQ_MESSAGES.nothingToCompare : RFQ_MESSAGES.gone };
  } catch (error) {
    console.error('[finance] an RFQ comparison could not be read:', error);
    return { ok: false, error: READ_FAILED };
  }
}

/** Makes a draft purchase order from a quoted RFQ, and refreshes Purchase Orders as well. */
export async function convertRfqAction(input: unknown) {
  return run(CONVERT_RFQ_PATHS, rfqIdInput, input, convertRfq);
}

/* ---- purchase orders --------------------------------------------------- */

export async function savePurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, savePurchaseOrderInput, input, savePurchaseOrder);
}
/** Sends a draft for approval: it gets its number the first time, and is locked. */
export async function submitPurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, submitPurchaseOrder);
}
/**
 * Approves an order, or rejects it back to draft with a reason: an owner or admin only. The database also refuses
 * an approval by the person who raised or submitted the order, unless they own the workspace.
 */
export async function decidePurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, decidePurchaseOrderInput, input, decidePurchaseOrder, PURCHASE_ORDER_SIGN_OFF);
}
/** Takes an order back from approval. The raiser may; so may an owner or admin, which the database decides. */
export async function withdrawPurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, withdrawPurchaseOrder);
}
/** What has arrived on an approved order. */
export async function receivePurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, receivePurchaseOrderInput, input, receivePurchaseOrder);
}
/** No more deliveries or bills are expected: an owner or admin only. */
export async function closePurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, closePurchaseOrder, PURCHASE_ORDER_SIGN_OFF);
}
export async function cancelPurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, cancelPurchaseOrder);
}
export async function deletePurchaseOrderAction(input: unknown) {
  return run(PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, deletePurchaseOrder);
}
/** Raises a draft bill from an approved order, and refreshes Supplier Bills as well. */
export async function billFromPurchaseOrderAction(input: unknown) {
  return run(ORDER_BILL_PATHS, billFromPurchaseOrderInput, input, billFromPurchaseOrder);
}

/** Saves the order as a draft, then submits it for approval; see `saveThenPost`. */
export async function saveAndSubmitPurchaseOrderAction(input: unknown): Promise<SaveAndSubmitPurchaseOrderResult> {
  return saveThenPost(PURCHASE_ORDER_PATHS, savePurchaseOrderInput, input, savePurchaseOrder, submitPurchaseOrder);
}

/** One draft purchase order with its lines, for the Edit form; see `documentInStatus`. */
export async function getPurchaseOrderAction(input: unknown): Promise<FinResult<PurchaseOrderDetail>> {
  return draftForEditing(PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, getPurchaseOrder, PURCHASE_ORDER_MESSAGES, 'purchase order');
}

/** One approved purchase order with its lines, for the "Record delivery" card; see `documentInStatus`. */
export async function getApprovedPurchaseOrderAction(input: unknown): Promise<FinResult<PurchaseOrderDetail>> {
  return documentInStatus(
    PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, getPurchaseOrder, PURCHASE_ORDER_MESSAGES, 'purchase order', 'approved',
  );
}

/** One purchase order awaiting approval with its lines, for the Approve and Reject cards; see `documentInStatus`. */
export async function getPendingPurchaseOrderAction(input: unknown): Promise<FinResult<PurchaseOrderDetail>> {
  return documentInStatus(
    PURCHASE_ORDER_PATHS, purchaseOrderIdInput, input, getPurchaseOrder, PURCHASE_ORDER_MESSAGES, 'purchase order', 'pending_approval',
  );
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

/* ---- cash receipts ----------------------------------------------------- */

// Every receipt action refreshes the sales screens, whatever the receipt is for. A receipt against invoices
// moves what they owe once it is posted or voided, and while it is a draft it holds its part of each, which
// changes what the payment forms on Invoices and Payments In offer and adds a Draft row to Payments In. A
// receipt for income shows on Cash Receipts and Banking only, both of which are in the list; and one save can
// turn a draft of one kind into the other.

/** Creates a draft receipt, or changes one. Nothing is posted: anyone who may write can do this. */
export async function saveCashReceiptAction(input: unknown) {
  return run(SALES_PATHS, saveCashReceiptInput, input, saveCashReceipt);
}
/** Posts a draft: it gets its RC- number and is locked. */
export async function postCashReceiptAction(input: unknown) {
  return run(SALES_PATHS, cashReceiptIdInput, input, postCashReceipt, SIGN_OFF);
}
/** Voids a posted receipt of either kind; the invoices it paid owe that amount again. */
export async function voidCashReceiptAction(input: unknown) {
  return run(SALES_PATHS, cashReceiptIdInput, input, voidCashReceipt, SIGN_OFF);
}
export async function deleteCashReceiptAction(input: unknown) {
  return run(SALES_PATHS, cashReceiptIdInput, input, deleteCashReceipt);
}

/** Saves the receipt as a draft, then posts it; see `saveThenPost`. Someone who may not sign off keeps the draft. */
export async function saveAndPostCashReceiptAction(input: unknown): Promise<SaveAndPostCashReceiptResult> {
  return saveThenPost(SALES_PATHS, saveCashReceiptInput, input, saveCashReceipt, postCashReceipt, true);
}

/* ---- expenses ---------------------------------------------------------- */

// An expense is on Expenses. Receipts Inbox names the expense a receipt is tied to (its category), and deleting
// an expense sends its receipt back to Unmatched. Payment Vouchers and Banking name the category of the expenses
// a voucher pays, which changes when a rejected expense that a voided voucher still names is edited. An approved
// expense is two lines of the books (its category's account and Accrued Expenses), so approving or rejecting one
// moves Chart of Accounts, Journals and Reports (LEDGER_PATHS): they end the list, as every action that changes the books does.
// KEEP IN STEP with RECEIPT_EXPENSE_PATHS in src/lib/finance/receipt-match.ts.
const EXPENSE_PATHS = [
  '/finance/expenses',
  '/finance/receipts-inbox',
  '/finance/payment-vouchers',
  '/finance/banking',
  ...LEDGER_PATHS,
];
/** Approving or rejecting an expense: an owner or admin only, told so in the expense's own words. */
const EXPENSE_DECIDE = { signOff: true, signOffError: EXPENSE_MESSAGES.needsDecider } as const;

/**
 * Creates an expense, or changes one that is pending or was rejected. Anyone who may write can do this. The
 * database approves it in the same call when the person saving is an owner or admin, and leaves it pending
 * otherwise; the answer says which.
 */
export async function saveExpenseAction(input: unknown) {
  return run(EXPENSE_PATHS, saveExpenseInput, input, saveExpense);
}
/** Approves a pending expense as the person was shown it (every field the row showed, `updated_at` included): an owner or admin only, which the expense's own guard enforces. */
export async function approveExpenseAction(input: unknown) {
  return run(EXPENSE_PATHS, expenseDecisionInput, input, approveExpense, EXPENSE_DECIDE);
}
/** Rejects a pending expense, or an approved one that no payment stands against: an owner or admin only. */
export async function rejectExpenseAction(input: unknown) {
  return run(EXPENSE_PATHS, expenseDecisionInput, input, rejectExpense, EXPENSE_DECIDE);
}
/** Deletes a pending or rejected expense. */
export async function deleteExpenseAction(input: unknown) {
  return run(EXPENSE_PATHS, expenseIdInput, input, deleteExpense);
}
/**
 * Marks an approved expense paid, in full or in part: a payment voucher against it, paid now, from the account
 * chosen. Paying is a sign-off: an owner or admin only, which the database enforces on the voucher (FIN14). The
 * voucher shows on Payment Vouchers and Banking and moves the books, all of which EXPENSE_PATHS already refreshes.
 */
export async function markExpensePaidAction(input: unknown) {
  return run(EXPENSE_PATHS, markExpensePaidInput, input, markExpensePaid, SIGN_OFF);
}

/* ---- categories (the Categories card on Expenses) ----------------------- */

// A category's name is in the picker of every form that files something under one, and on every row that names
// one: Expenses (the form, the filter, each row, the chart), Cash Receipts (the income picker and each row),
// Supplier Bills (a bill's category), Payment Vouchers and Banking (a voucher's category), and Receipts Inbox
// (the expense a receipt is tied to, and the two forms it opens). An added, renamed, archived or restored
// category must appear, change or go there. The three ledger screens end the list: each category has an account
// in the Chart of Accounts that is made, renamed and archived with it, and Journals and Reports name that account.
const CATEGORY_PATHS = [
  '/finance/expenses',
  '/finance/cash-receipts',
  '/finance/supplier-bills',
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/receipts-inbox',
  ...LEDGER_PATHS,
];
/** Adding, renaming, archiving and restoring a category: an owner or admin only, told so in the category's own words. */
const CATEGORY_SIGN_OFF = { signOff: true, signOffError: CATEGORY_MESSAGES.needsSignOff } as const;

/** Adds an expense or income category. The database makes its account in the Chart of Accounts in the same write. */
export async function createCategoryAction(input: unknown) {
  return run(CATEGORY_PATHS, createCategoryInput, input, createCategory, CATEGORY_SIGN_OFF);
}
/** Renames a category. Everything filed under it shows the new name. */
export async function renameCategoryAction(input: unknown) {
  return run(CATEGORY_PATHS, renameCategoryInput, input, renameCategory, CATEGORY_SIGN_OFF);
}
/** Archives or restores a category. The two the books lean on are not archived, which the data layer sees to. */
export async function setCategoryActiveAction(input: unknown) {
  return run(CATEGORY_PATHS, setCategoryActiveInput, input, setCategoryActive, CATEGORY_SIGN_OFF);
}

/* ---- payment vouchers -------------------------------------------------- */

// A voucher is on Payment Vouchers. One that is waiting or still to be paid stands against the account it will
// leave, which Banking will not archive while it does. A voucher that pays expenses holds its part of each, which
// Expenses shows; one that pays supplier bills holds its part of each bill, which Supplier Bills and Payments
// Out show, and once approved it is a payment still to be paid on Payments Out; a refund that was waiting is on
// Refunds. A refund that is a draft or waiting holds credit on its invoice, which Invoices, Credit Notes,
// Payments In and Customers & Suppliers count (the same four CREDIT_PATHS lists), so deleting or rejecting one
// refreshes them. A voucher recorded as paid, marked paid or voided moves the books (LEDGER_PATHS): they end the
// list, as every action that changes the books does.
const VOUCHER_PATHS = [
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/expenses',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/refunds',
  '/finance/invoices',
  '/finance/credit-notes',
  '/finance/payments-in',
  '/finance/customers-suppliers',
  ...LEDGER_PATHS,
];
/** Approving or rejecting a voucher: an owner or admin only, told so in the voucher's own words. */
const VOUCHER_DECIDE = { signOff: true, signOffError: VOUCHER_MESSAGES.needsDecider } as const;

/**
 * Records a voucher for a category. Anyone who may write can do this. The database approves it in the same call
 * when the person recording it is an owner or admin, and makes it wait for approval otherwise; the answer says which.
 * Recording it as paid now (`paid_now`) is a sign-off: an owner or admin only, asked here before anything is
 * written, because the database would quietly make a member's wait for approval instead.
 */
export async function recordVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, recordVoucherInput, input, recordVoucher, {
    paidNow: (voucher) => voucher.paid_now === true,
    paidNowError: VOUCHER_MESSAGES.paidNowNeedsSignOff,
  });
}
/**
 * Saves a voucher for a category or for a supplier's bills as a draft, or changes a draft, and sends it for approval
 * in the same call when asked. Anyone who may write can do this: it never schedules, pays or approves.
 */
export async function saveVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, saveVoucherInput, input, saveVoucher);
}
/** Sends a draft for approval from its row, as the person was shown it. Anyone who may write can do this. */
export async function submitVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, voucherDecisionInput, input, submitVoucher);
}
/** Approves a voucher that is waiting, as the person was shown it (every field the row showed): an owner or admin only, which the guard on payments enforces. */
export async function approveVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, voucherDecisionInput, input, approveVoucher, VOUCHER_DECIDE);
}
/** Rejects a voucher that is waiting, as the person was shown it: an owner or admin only. */
export async function rejectVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, voucherDecisionInput, input, rejectVoucher, VOUCHER_DECIDE);
}
/** Deletes a voucher that has not been paid, while it still has the status the person was shown. */
export async function deleteVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, deleteVoucherInput, input, deleteVoucher);
}
/**
 * Marks a voucher that is "To be paid" as paid on the day given: a voucher for a category or one that pays expenses.
 * Paying is a sign-off: an owner or admin only, which the database enforces (FIN14).
 */
export async function markVoucherPaidAction(input: unknown) {
  return run(VOUCHER_PATHS, markVoucherPaidInput, input, markVoucherPaid, SIGN_OFF);
}
/**
 * Voids a paid voucher of those two kinds, which is also how a wrong "Mark paid" on Expenses is undone: the expense
 * is owed that amount again. Voiding is a sign-off: an owner or admin only.
 */
export async function voidVoucherAction(input: unknown) {
  return run(VOUCHER_PATHS, voidVoucherInput, input, voidVoucher, SIGN_OFF);
}

/* ---- chart of accounts and journals ------------------------------------ */

// Every ledger action is an owner's or admin's, and says so before anything is parsed or called. Each
// refreshes the two ledger screens, a refusal included: a journal someone else posted or deleted shows as it now is.

/**
 * Someone who may not write is refused; someone who may write but not sign off is told so in the ledger's
 * own words. Null when the viewer may go on. For the two actions that cannot go through `run`.
 */
async function ledgerGate(): Promise<FinResult<never> | null> {
  const access = await writeAccess();
  if (!access) return FORBIDDEN;
  return access.signOff ? null : { ok: false, error: LEDGER_MESSAGES.needsSignOff };
}

export async function createAccountAction(input: unknown) {
  return run(LEDGER_PATHS, createAccountInput, input, createAccount, LEDGER_SIGN_OFF);
}
export async function updateAccountAction(input: unknown) {
  return run(LEDGER_PATHS, updateAccountInput, input, updateAccount, LEDGER_SIGN_OFF);
}
export async function setAccountActiveAction(input: unknown) {
  return run(LEDGER_PATHS, setAccountActiveInput, input, setAccountActive, LEDGER_SIGN_OFF);
}
export async function deleteAccountAction(input: unknown) {
  return run(LEDGER_PATHS, accountIdInput, input, deleteAccount, LEDGER_SIGN_OFF);
}

/** Creates a draft journal, or changes one. Nothing reaches the books until it is posted. */
export async function saveJournalAction(input: unknown) {
  return run(LEDGER_PATHS, saveJournalInput, input, saveJournal, LEDGER_SIGN_OFF);
}
/** Posts a draft: it gets its number, enters the books and is locked. */
export async function postJournalAction(input: unknown) {
  return run(LEDGER_PATHS, journalIdInput, input, postJournal, LEDGER_SIGN_OFF);
}
/** Makes the draft that undoes a posted journal; posting that draft is a separate step. */
export async function reverseJournalAction(input: unknown) {
  return run(LEDGER_PATHS, reverseJournalInput, input, reverseJournal, LEDGER_SIGN_OFF);
}
export async function deleteJournalAction(input: unknown) {
  return run(LEDGER_PATHS, journalIdInput, input, deleteJournal, LEDGER_SIGN_OFF);
}

/** Saves the journal as a draft, then posts it; see `saveThenPost`. A draft is kept when posting is refused. */
export async function saveAndPostJournalAction(input: unknown): Promise<SaveAndPostJournalResult> {
  const refused = await ledgerGate();
  if (refused) return refused;
  return saveThenPost(LEDGER_PATHS, saveJournalInput, input, saveJournal, postJournal);
}

/** One draft journal with its lines, for an Edit form; see `documentInStatus`. */
export async function getJournalAction(input: unknown): Promise<FinResult<JournalDetail>> {
  const refused = await ledgerGate();
  if (refused) return refused;
  return draftForEditing(LEDGER_PATHS, journalIdInput, input, getJournal, LEDGER_MESSAGES, 'journal');
}
