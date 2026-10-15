/**
 * Bendahara (finance) tools for Ask-Bendahara and Tuah. Each tool wraps an
 * existing `@/lib/finance/*` capability function, run as the signed-in user and
 * narrowed to their workspace — the `org_id` is the caller's, never the model's.
 * Reads return the rows the capability returns; changes return its `FinResult`
 * (so an `ok:false` reaches the model), and each change waits for the user's
 * approval before it runs (see `FINANCE_WRITE_TOOL_NAMES`).
 *
 * Contacts and items use finance-scoped tool names (`listFinanceContacts`,
 * `createFinanceContact`, `listFinanceItems`, …) so the toolkit never clashes
 * with the reach/crm `listContacts`/`createContact` when Tuah combines every
 * product. Each write tool's `inputSchema` is the capability's own Zod input;
 * the capability re-parses it, which is idempotent for these schemas.
 */

import { tool } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  deleteInvoice,
  getInvoice,
  invoiceIdInput,
  listInvoices,
  postInvoice,
  saveInvoice,
  saveInvoiceInput,
  setEInvoice,
  setEInvoiceInput,
  voidInvoice,
} from '@/lib/finance/invoices';
import {
  billIdInput,
  deleteBill,
  getBill,
  listBills,
  postBill,
  saveBill,
  saveBillInput,
  voidBill,
} from '@/lib/finance/bills';
import {
  acceptQuotation,
  convertQuotation,
  convertQuotationInput,
  declineQuotation,
  deleteQuotation,
  listQuotations,
  quotationIdInput,
  saveQuotationInRinggit,
  saveQuotationToolInput,
  sendQuotation,
} from '@/lib/finance/quotations';
import {
  creditNoteIdInput,
  deleteCreditNote,
  issueCreditNote,
  listCreditNotes,
  saveCreditNote,
  saveCreditNoteInput,
  voidCreditNote,
} from '@/lib/finance/credit-notes';
import {
  deleteRefund,
  listRefunds,
  markRefundPaid,
  recordRefund,
  recordRefundInput,
  voidRefund,
} from '@/lib/finance/refunds';
import {
  createContact,
  createContactToolInput,
  deleteContact,
  deleteContactInput,
  listBillBalances,
  listContacts,
  listInvoiceBalances,
  setContactActive,
  setContactActiveInput,
  updateContact,
  updateContactToolInput,
} from '@/lib/finance/contacts';
import {
  createProduct,
  createProductInput,
  deleteProduct,
  deleteProductInput,
  listProducts,
  setProductActive,
  setProductActiveInput,
  updateProduct,
  updateProductInput,
} from '@/lib/finance/products';
import {
  deleteScheduledPayment,
  listAccounts,
  listPaymentsIn,
  listPaymentsOut,
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
import { listContras } from '@/lib/finance/contras';
import type { FinanceWriteContext } from '@/lib/finance/result';

/** Who is asking, and whether they may change anything. */
export type FinanceAccess = {
  client: SupabaseClient;
  orgId: string;
  canWrite: boolean;
};

/** Finance tools that change data: each one pauses for the user's approval before running. */
export const FINANCE_WRITE_TOOL_NAMES = [
  'saveInvoice',
  'postInvoice',
  'voidInvoice',
  'deleteInvoice',
  'setEInvoice',
  'saveQuotation',
  'sendQuotation',
  'acceptQuotation',
  'declineQuotation',
  'convertQuotation',
  'deleteQuotation',
  'saveCreditNote',
  'issueCreditNote',
  'voidCreditNote',
  'deleteCreditNote',
  'recordRefund',
  'markRefundPaid',
  'voidRefund',
  'deleteRefund',
  'saveBill',
  'postBill',
  'voidBill',
  'deleteBill',
  'recordPaymentIn',
  'recordPaymentOut',
  'markPaymentPaid',
  'voidPayment',
  'voidPaymentIn',
  'deleteScheduledPayment',
  'createFinanceContact',
  'updateFinanceContact',
  'setFinanceContactActive',
  'deleteFinanceContact',
  'createFinanceItem',
  'updateFinanceItem',
  'setFinanceItemActive',
  'deleteFinanceItem',
] as const;

const idInput = z.object({ id: z.string().describe('The row id from a lookup.') });

export function createBendaharaTools(access: FinanceAccess) {
  const ctx: FinanceWriteContext = { client: access.client, orgId: access.orgId };

  const read = {
    getFinanceOverview: tool({
      description:
        'A money snapshot for the owner: total receivables (money owed to the business) and payables ' +
        '(money it owes), how many of each are overdue, and the bank and cash accounts. Amounts in ringgit.',
      inputSchema: z.object({}),
      execute: async () => {
        const [receivable, payable, accounts] = await Promise.all([
          listInvoiceBalances(ctx),
          listBillBalances(ctx),
          listAccounts(ctx),
        ]);
        // Balances are numeric(14,2) ringgit; round the float sum to 2dp (as the finance views do).
        const total = (rows: { balance: number }[]) =>
          Math.round(rows.reduce((n, r) => n + r.balance, 0) * 100) / 100;
        const overdue = (rows: { display_status: string }[]) =>
          rows.filter((r) => r.display_status === 'overdue').length;
        return {
          receivables: { total: total(receivable), overdue_count: overdue(receivable) },
          payables: { total: total(payable), overdue_count: overdue(payable) },
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
        };
      },
    }),
    listInvoices: tool({
      description: "The workspace's sales invoices with status and totals.",
      inputSchema: z.object({}),
      execute: async () => listInvoices(ctx),
    }),
    getInvoice: tool({
      description: 'One sales invoice in full, by id, with its lines.',
      inputSchema: idInput,
      execute: async ({ id }) => getInvoice(ctx, id),
    }),
    listInvoiceBalances: tool({
      description: 'Outstanding receivable balance per customer, with a display status (open/overdue/paid).',
      inputSchema: z.object({}),
      execute: async () => listInvoiceBalances(ctx),
    }),
    listQuotations: tool({
      description: 'Sales quotations with status (draft/sent/accepted/declined) and totals.',
      inputSchema: z.object({}),
      execute: async () => listQuotations(ctx),
    }),
    listCreditNotes: tool({
      description: 'Credit notes issued against invoices, with status and totals.',
      inputSchema: z.object({}),
      execute: async () => listCreditNotes(ctx),
    }),
    listRefunds: tool({
      description: 'Refunds to customers, with status and amount.',
      inputSchema: z.object({}),
      execute: async () => listRefunds(ctx),
    }),
    listBills: tool({
      description: "The workspace's supplier bills (purchases) with status and totals.",
      inputSchema: z.object({}),
      execute: async () => listBills(ctx),
    }),
    getBill: tool({
      description: 'One supplier bill in full, by id, with its lines.',
      inputSchema: idInput,
      execute: async ({ id }) => getBill(ctx, id),
    }),
    listBillBalances: tool({
      description: 'Outstanding payable balance per supplier, with a display status (open/overdue/paid).',
      inputSchema: z.object({}),
      execute: async () => listBillBalances(ctx),
    }),
    listPaymentsIn: tool({
      description: 'Payments received from customers.',
      inputSchema: z.object({}),
      execute: async () => listPaymentsIn(ctx),
    }),
    listPaymentsOut: tool({
      description: 'Payments made to suppliers.',
      inputSchema: z.object({}),
      execute: async () => listPaymentsOut(ctx),
    }),
    listContraEntries: tool({
      description:
        'Contra entries: a contact who is both a customer and a supplier has invoices set off against bills, with no ' +
        'money moving. Each with its number (CT-), date, contact, amount in ringgit, status (draft/posted/void) and ' +
        'the invoices and bills it sets off with the amount on each. Read only: contra entries are recorded on the ' +
        'Contra Entries screen by an owner or admin.',
      inputSchema: z.object({}),
      execute: async () => listContras(ctx),
    }),
    listFinanceContacts: tool({
      description: 'Finance contacts: customers and suppliers, with their kind and contact details.',
      inputSchema: z.object({}),
      execute: async () => listContacts(ctx),
    }),
    listFinanceItems: tool({
      description: 'Sellable/purchasable items (products and services) with their default prices.',
      inputSchema: z.object({}),
      execute: async () => listProducts(ctx),
    }),
    listAccounts: tool({
      description: 'Bank and cash accounts money is received into or paid out of.',
      inputSchema: z.object({}),
      execute: async () => listAccounts(ctx),
    }),
  };

  if (!access.canWrite) return read;

  // Every write returns the capability's FinResult (ok/data or ok:false/error),
  // which the tool returns verbatim so a refusal reaches the model.
  const write = {
    // Invoices
    saveInvoice: tool({
      description: 'Create or edit a DRAFT sales invoice (customer, dates, line items). Omit id to create.',
      inputSchema: saveInvoiceInput,
      execute: async (input) => saveInvoice(ctx, input),
    }),
    postInvoice: tool({
      description: 'Post (finalise) a draft invoice: it gets an invoice number and can no longer be edited. Carries e-Invoice/LHDN weight.',
      inputSchema: invoiceIdInput,
      execute: async (input) => postInvoice(ctx, input),
    }),
    voidInvoice: tool({
      description: 'Void a posted invoice.',
      inputSchema: invoiceIdInput,
      execute: async (input) => voidInvoice(ctx, input),
    }),
    deleteInvoice: tool({
      description: 'Delete a draft invoice.',
      inputSchema: invoiceIdInput,
      execute: async (input) => deleteInvoice(ctx, input),
    }),
    setEInvoice: tool({
      description: 'Record the e-Invoice (e-Invois) status and UUID on a posted invoice.',
      inputSchema: setEInvoiceInput,
      execute: async (input) => setEInvoice(ctx, input),
    }),
    // Quotations
    saveQuotation: tool({
      description: 'Create or edit a DRAFT sales quotation. Omit id to create.',
      inputSchema: saveQuotationToolInput,
      execute: async (input) => saveQuotationInRinggit(ctx, input),
    }),
    sendQuotation: tool({
      description: 'Mark a quotation as sent to the customer.',
      inputSchema: quotationIdInput,
      execute: async (input) => sendQuotation(ctx, input),
    }),
    acceptQuotation: tool({
      description: 'Mark a quotation as accepted.',
      inputSchema: quotationIdInput,
      execute: async (input) => acceptQuotation(ctx, input),
    }),
    declineQuotation: tool({
      description: 'Mark a quotation as declined.',
      inputSchema: quotationIdInput,
      execute: async (input) => declineQuotation(ctx, input),
    }),
    convertQuotation: tool({
      description: 'Convert an accepted quotation into a draft invoice dated as given.',
      inputSchema: convertQuotationInput,
      execute: async (input) => convertQuotation(ctx, input),
    }),
    deleteQuotation: tool({
      description: 'Delete a draft quotation.',
      inputSchema: quotationIdInput,
      execute: async (input) => deleteQuotation(ctx, input),
    }),
    // Credit notes
    saveCreditNote: tool({
      description: 'Create or edit a DRAFT credit note against an invoice. Omit id to create.',
      inputSchema: saveCreditNoteInput,
      execute: async (input) => saveCreditNote(ctx, input),
    }),
    issueCreditNote: tool({
      description: 'Issue (finalise) a draft credit note.',
      inputSchema: creditNoteIdInput,
      execute: async (input) => issueCreditNote(ctx, input),
    }),
    voidCreditNote: tool({
      description: 'Void an issued credit note.',
      inputSchema: creditNoteIdInput,
      execute: async (input) => voidCreditNote(ctx, input),
    }),
    deleteCreditNote: tool({
      description: 'Delete a draft credit note.',
      inputSchema: creditNoteIdInput,
      execute: async (input) => deleteCreditNote(ctx, input),
    }),
    // Refunds
    recordRefund: tool({
      description: 'Record a refund to a customer (money paid back).',
      inputSchema: recordRefundInput,
      execute: async (input) => recordRefund(ctx, input),
    }),
    markRefundPaid: tool({
      description: 'Mark a refund as paid, from a bank or cash account.',
      inputSchema: markPaymentPaidInput,
      execute: async (input) => markRefundPaid(ctx, input),
    }),
    voidRefund: tool({
      description: 'Void a refund.',
      inputSchema: paymentIdInput,
      execute: async (input) => voidRefund(ctx, input),
    }),
    deleteRefund: tool({
      description: 'Delete a draft refund.',
      inputSchema: paymentIdInput,
      execute: async (input) => deleteRefund(ctx, input),
    }),
    // Bills (purchases)
    saveBill: tool({
      description: 'Create or edit a DRAFT supplier bill. Omit id to create.',
      inputSchema: saveBillInput,
      execute: async (input) => saveBill(ctx, input),
    }),
    postBill: tool({
      description: 'Post (finalise) a draft supplier bill.',
      inputSchema: billIdInput,
      execute: async (input) => postBill(ctx, input),
    }),
    voidBill: tool({
      description: 'Void a posted supplier bill.',
      inputSchema: billIdInput,
      execute: async (input) => voidBill(ctx, input),
    }),
    deleteBill: tool({
      description: 'Delete a draft supplier bill.',
      inputSchema: billIdInput,
      execute: async (input) => deleteBill(ctx, input),
    }),
    // Payments
    recordPaymentIn: tool({
      description: 'Record a payment received from a customer against their invoices.',
      inputSchema: recordPaymentInInput,
      execute: async (input) => recordPaymentIn(ctx, input),
    }),
    recordPaymentOut: tool({
      description: 'Record a payment made to a supplier against their bills.',
      inputSchema: recordPaymentOutInput,
      execute: async (input) => recordPaymentOut(ctx, input),
    }),
    markPaymentPaid: tool({
      description: 'Mark a scheduled payment out as paid.',
      inputSchema: markPaymentPaidInput,
      execute: async (input) => markPaymentPaid(ctx, input),
    }),
    voidPayment: tool({
      description: 'Void a payment out.',
      inputSchema: paymentIdInput,
      execute: async (input) => voidPayment(ctx, input),
    }),
    voidPaymentIn: tool({
      description: 'Void a payment in.',
      inputSchema: paymentIdInput,
      execute: async (input) => voidPaymentIn(ctx, input),
    }),
    deleteScheduledPayment: tool({
      description: 'Delete a scheduled payment out that has not been paid yet.',
      inputSchema: paymentIdInput,
      execute: async (input) => deleteScheduledPayment(ctx, input),
    }),
    // Contacts (customers / suppliers)
    createFinanceContact: tool({
      description: 'Add a finance contact (a customer or a supplier).',
      inputSchema: createContactToolInput,
      execute: async (input) => createContact(ctx, createContactToolInput.parse(input)),
    }),
    updateFinanceContact: tool({
      description: 'Edit a finance contact.',
      inputSchema: updateContactToolInput,
      execute: async (input) => updateContact(ctx, updateContactToolInput.parse(input)),
    }),
    setFinanceContactActive: tool({
      description: 'Activate or deactivate a finance contact.',
      inputSchema: setContactActiveInput,
      execute: async (input) => setContactActive(ctx, input),
    }),
    deleteFinanceContact: tool({
      description: 'Delete a finance contact that has no documents.',
      inputSchema: deleteContactInput,
      execute: async (input) => deleteContact(ctx, input),
    }),
    // Items (products / services)
    createFinanceItem: tool({
      description: 'Add a sellable/purchasable item with a default price.',
      inputSchema: createProductInput,
      execute: async (input) => createProduct(ctx, input),
    }),
    updateFinanceItem: tool({
      description: 'Edit an item.',
      inputSchema: updateProductInput,
      execute: async (input) => updateProduct(ctx, input),
    }),
    setFinanceItemActive: tool({
      description: 'Activate or deactivate an item.',
      inputSchema: setProductActiveInput,
      execute: async (input) => setProductActive(ctx, input),
    }),
    deleteFinanceItem: tool({
      description: 'Delete an item that is not used on any document.',
      inputSchema: deleteProductInput,
      execute: async (input) => deleteProduct(ctx, input),
    }),
  };

  return { ...read, ...write };
}
