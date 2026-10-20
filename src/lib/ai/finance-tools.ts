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
  saveInvoiceInRinggit,
  saveInvoiceToolInput,
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
  saveBillInRinggit,
  saveBillToolInput,
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
  saveCreditNoteInRinggit,
  saveCreditNoteInput,
  voidCreditNote,
} from '@/lib/finance/credit-notes';
import {
  deleteRefund,
  listRefunds,
  markRefundPaid,
  recordRefundInRinggit,
  recordRefundToolInput,
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
  recordPaymentInRinggit,
  recordPaymentInToolInput,
  recordPaymentOutInRinggit,
  recordPaymentOutToolInput,
  voidPayment,
  voidPaymentIn,
} from '@/lib/finance/money';
import { listContras } from '@/lib/finance/contras';
import {
  getJournal,
  journalIdInput,
  listJournals,
  listLedgerAccounts,
  listLedgerLines,
  postJournal,
  reverseJournal,
  reverseJournalInput,
  saveJournal,
  saveJournalInput,
  type LedgerAccount,
} from '@/lib/finance/ledger';
import { filterEntries, groupEntries } from '@/lib/finance/ledger-views';
import { getPurchaseOrder, listPurchaseOrders } from '@/lib/finance/purchase-orders';
import { listOpenBills, listOpenInvoices } from '@/lib/finance/reports-data';
import {
  aged,
  balanceSheet,
  cashFlow,
  cashMovements,
  monthlyTotals,
  openPayables,
  openReceivables,
  periodFor,
  profitAndLoss,
  trialBalance,
} from '@/lib/finance/reports';
import {
  billFromPurchaseOrderInRinggit,
  billFromPurchaseOrderInput,
  cancelPurchaseOrder,
  closePurchaseOrder,
  decidePurchaseOrder,
  decidePurchaseOrderInput,
  purchaseOrderIdInput,
  receivePurchaseOrder,
  receivePurchaseOrderInput,
  savePurchaseOrderInRinggit,
  savePurchaseOrderToolInput,
  submitPurchaseOrder,
} from '@/lib/finance/purchase-orders';
import {
  closeRfq,
  convertRfq,
  getRfq,
  getRfqGroup,
  listRfqs,
  quoteRfq,
  quoteRfqInput,
  rfqIdInput,
  saveRfqInRinggit,
  saveRfqToolInput,
  sendRfq,
} from '@/lib/finance/rfqs';
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
  'saveRfq',
  'sendRfq',
  'quoteRfq',
  'convertRfq',
  'closeRfq',
  'savePurchaseOrder',
  'submitPurchaseOrder',
  'receivePurchaseOrder',
  'billFromPurchaseOrder',
  'decidePurchaseOrder',
  'closePurchaseOrder',
  'cancelPurchaseOrder',
  'saveJournal',
  'postJournal',
  'reverseJournal',
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

  // Report assembly mirrors src/screens/finance/reports.tsx; the tools return the library's
  // statement objects verbatim, so the chat can never disagree with the Reports screen.
  const reportAccounts = (accounts: LedgerAccount[]) => accounts.map(({ id, code, name, type }) => ({ id, code, name, type }));
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const periodInput = z.object({
    period: z
      .enum(['this_month', 'last_month', 'this_quarter', 'this_year', 'last_year', 'all_time'])
      .describe('Which period to report on.'),
  });
  const statementData = async () => {
    const [lines, ledgerAccounts] = await Promise.all([listLedgerLines(ctx), listLedgerAccounts(ctx)]);
    const { totals } = monthlyTotals(lines);
    return { lines, ledgerAccounts, totals };
  };

  const read = {
    getFinanceOverview: tool({
      description:
        'A money snapshot for the owner: total receivables (money owed to the business) and payables ' +
        '(money it owes), how many of each are overdue, and the bank and cash accounts. Amounts in ringgit. ' +
        'Accounts may be in another currency (currency field); amounts on them are in that currency.',
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
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, currency: a.currency })),
        };
      },
    }),
    listInvoices: tool({
      description:
        "The workspace's sales invoices with status and totals. total, paid, credited, refunded and balance are in the " +
        "invoice's currency (its currency field); total_myr and balance_myr are the same in ringgit. Add up ringgit only.",
      inputSchema: z.object({}),
      execute: async () => listInvoices(ctx),
    }),
    getInvoice: tool({
      description:
        "One sales invoice in full, by id, with its lines. Amounts are in the invoice's currency; total_myr, sst_myr and " +
        'balance_myr are in ringgit.',
      inputSchema: idInput,
      execute: async ({ id }) => getInvoice(ctx, id),
    }),
    listInvoiceBalances: tool({
      description:
        'Outstanding receivable balance per invoice with its customer and a display status (open/overdue/paid). ' +
        'Balances are in ringgit (an invoice in another currency at its own rate).',
      inputSchema: z.object({}),
      execute: async () => listInvoiceBalances(ctx),
    }),
    listQuotations: tool({
      description: 'Sales quotations with status (draft/sent/accepted/declined) and totals.',
      inputSchema: z.object({}),
      execute: async () => listQuotations(ctx),
    }),
    listCreditNotes: tool({
      description:
        "Credit notes issued against invoices, with status and totals. amount and refunded are in the invoice's currency " +
        '(its currency field); amount_myr is what it took off in ringgit. Add up ringgit only.',
      inputSchema: z.object({}),
      execute: async () => listCreditNotes(ctx),
    }),
    listRefunds: tool({
      description:
        "Refunds to customers, with status and amount. amount is in the invoice's currency (its currency field); " +
        'amount_myr is the ringgit paid out for it. transaction_amount is in transaction_currency (the account\'s ' +
        'currency); transaction_amount_myr is its ringgit. Add up ringgit only.',
      inputSchema: z.object({}),
      execute: async () => listRefunds(ctx),
    }),
    listBills: tool({
      description:
        "The workspace's supplier bills (purchases) with status and totals. total, paid and balance are in the bill's " +
        "currency (its currency field); total_myr and balance_myr are the same in ringgit. Add up ringgit only.",
      inputSchema: z.object({}),
      execute: async () => listBills(ctx),
    }),
    getBill: tool({
      description:
        "One supplier bill in full, by id, with its lines. Amounts are in the bill's currency; total_myr, sst_myr and " +
        'balance_myr are in ringgit.',
      inputSchema: idInput,
      execute: async ({ id }) => getBill(ctx, id),
    }),
    listBillBalances: tool({
      description:
        'Outstanding payable balance per supplier, with a display status (open/overdue/paid). Balances are in ringgit ' +
        '(a bill in another currency at its own rate).',
      inputSchema: z.object({}),
      execute: async () => listBillBalances(ctx),
    }),
    listPaymentsIn: tool({
      description:
        "Payments received from customers, one row per invoice a payment pays. amount is in the invoice's currency " +
        '(currency); amount_myr is the ringgit received for it. transaction_amount is in transaction_currency (the ' +
        "account's currency); transaction_amount_myr is its ringgit. Add up ringgit only.",
      inputSchema: z.object({}),
      execute: async () => listPaymentsIn(ctx),
    }),
    listPaymentsOut: tool({
      description:
        'Payments made to suppliers, one row per bill a payment pays. amount is in the bill\'s currency (currency); ' +
        'amount_myr is the ringgit paid for it. transaction_amount is in transaction_currency (the account\'s ' +
        'currency); transaction_amount_myr is its ringgit. Add up ringgit only.',
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
    listRfqs: tool({
      description:
        'Requests for quotation (RFQs) with status (draft/sent/quoted/closed) and the supplier being asked. Each total is ' +
        "in the RFQ's currency (its currency field); total_myr is the same in ringgit at the RFQ's indicative rate, null " +
        'when it has none. Compare or add up ringgit only.',
      inputSchema: z.object({}),
      execute: async () => listRfqs(ctx),
    }),
    getRfq: tool({
      description:
        "One RFQ in full, by id, with its lines and any prices recorded. Prices and totals are in the RFQ's currency " +
        "(its currency field), not necessarily ringgit; total_myr is the total in ringgit at the RFQ's indicative rate, " +
        'null when it has none.',
      inputSchema: idInput,
      execute: async ({ id }) => getRfq(ctx, id),
    }),
    getRfqGroup: tool({
      description:
        'All the sent RFQs copied from one request, by the id of any of them, to compare suppliers\u2019 quotes side by side. ' +
        "Each RFQ's prices are in its own currency (its currency field); compare across currencies by total_myr only, " +
        'and not at all for an RFQ whose total_myr is null.',
      inputSchema: idInput,
      execute: async ({ id }) => getRfqGroup(ctx, id),
    }),
    listPurchaseOrders: tool({
      description:
        'Purchase orders with status (draft/pending_approval/approved/closed/cancelled), delivery (pending/partial/delivered), ' +
        "and total, received and billed figures in the order's currency (its currency field); total_myr is the total in " +
        "ringgit at the order's indicative rate, null when it has none. Add up ringgit only. Set awaiting_approval to " +
        'list only those waiting for approval.',
      inputSchema: z.object({ awaiting_approval: z.boolean().optional().describe('Only orders waiting for approval.') }),
      execute: async ({ awaiting_approval }) => {
        const rows = await listPurchaseOrders(ctx);
        return awaiting_approval ? rows.filter((r) => r.status === 'pending_approval') : rows;
      },
    }),
    getPurchaseOrder: tool({
      description:
        "One purchase order in full, by id, with its lines and received quantities. Prices and totals are in the order's " +
        "currency (its currency field), not necessarily ringgit; total_myr is the total in ringgit at the order's " +
        'indicative rate, null when it has none.',
      inputSchema: idInput,
      execute: async ({ id }) => getPurchaseOrder(ctx, id),
    }),
    listLedgerAccounts: tool({
      description:
        'The chart of accounts with each account\u2019s balance (debit_total, credit_total, balance in ringgit), its type and what it stands for. ' +
        'This is the books\u2019 accounts, not the bank/cash accounts in listAccounts.',
      inputSchema: z.object({}),
      execute: async () => listLedgerAccounts(ctx),
    }),
    listLedgerEntries: tool({
      description:
        'Ledger entries, grouped by document/journal, optionally for one account and/or a date range. account is a ledger-account id from listLedgerAccounts; ' +
        'from/to are YYYY-MM-DD.',
      inputSchema: z.object({
        account: z.string().optional().describe('A ledger-account id from listLedgerAccounts.'),
        from: z.string().optional().describe('Start date, YYYY-MM-DD.'),
        to: z.string().optional().describe('End date, YYYY-MM-DD.'),
      }),
      execute: async ({ account, from, to }) => {
        const [lines, accounts] = await Promise.all([listLedgerLines(ctx), listLedgerAccounts(ctx)]);
        const entries = groupEntries(lines, accounts);
        return filterEntries(entries, { query: '', source: 'all', from: from ?? '', to: to ?? '', account: account ?? '' });
      },
    }),
    listJournals: tool({
      description: 'Manual journal entries with status (draft/posted/void) and their number.',
      inputSchema: z.object({}),
      execute: async () => listJournals(ctx),
    }),
    getJournal: tool({
      description: 'One manual journal in full, by id, with its debit and credit lines.',
      inputSchema: idInput,
      execute: async ({ id }) => getJournal(ctx, id),
    }),
    profitAndLoss: tool({
      description: 'Profit and loss (income statement) for a period. Returns the statement the books compute; amounts in ringgit.',
      inputSchema: periodInput,
      execute: async ({ period }) => {
        const { ledgerAccounts, totals } = await statementData();
        return profitAndLoss(reportAccounts(ledgerAccounts), totals, periodFor(period, todayIso(), totals));
      },
    }),
    balanceSheet: tool({
      description: 'Balance sheet as at the end of a period.',
      inputSchema: periodInput,
      execute: async ({ period }) => {
        const { ledgerAccounts, totals } = await statementData();
        return balanceSheet(reportAccounts(ledgerAccounts), totals, periodFor(period, todayIso(), totals));
      },
    }),
    trialBalance: tool({
      description: 'Trial balance for a period.',
      inputSchema: periodInput,
      execute: async ({ period }) => {
        const { ledgerAccounts, totals } = await statementData();
        return trialBalance(reportAccounts(ledgerAccounts), totals, periodFor(period, todayIso(), totals));
      },
    }),
    agedReceivables: tool({
      description: 'Aged receivables: what customers owe, by how overdue.',
      inputSchema: z.object({}),
      execute: async () => aged(openReceivables(await listOpenInvoices(ctx)), todayIso()),
    }),
    agedPayables: tool({
      description: 'Aged payables: what the business owes suppliers, by how overdue.',
      inputSchema: z.object({}),
      execute: async () => aged(openPayables(await listOpenBills(ctx)), todayIso()),
    }),
    cashFlow: tool({
      description: 'Cash flow for a period.',
      inputSchema: periodInput,
      execute: async ({ period }) => {
        const { lines, ledgerAccounts, totals } = await statementData();
        return cashFlow(cashMovements(lines, ledgerAccounts), periodFor(period, todayIso(), totals));
      },
    }),
    listFinanceItems: tool({
      description: 'Sellable/purchasable items (products and services) with their default prices.',
      inputSchema: z.object({}),
      execute: async () => listProducts(ctx),
    }),
    listAccounts: tool({
      description:
        'Bank and cash accounts money is received into or paid out of. Accounts may be in another currency ' +
        '(currency field); amounts on them are in that currency. Record payments only on ringgit (MYR) accounts.',
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
      description:
        'Create or edit a DRAFT sales invoice in ringgit (customer, dates, line items). Omit id to create. An invoice in ' +
        'another currency is edited on the Invoices screen.',
      inputSchema: saveInvoiceToolInput,
      execute: async (input) => saveInvoiceInRinggit(ctx, input),
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
      description:
        'Convert an accepted quotation into a draft invoice dated as given. A quotation in another currency becomes an ' +
        "invoice in that currency at Bank Negara Malaysia's selling rate for that date.",
      inputSchema: convertQuotationInput,
      execute: async (input) => convertQuotation(ctx, input),
    }),
    deleteQuotation: tool({
      description: 'Delete a draft quotation.',
      inputSchema: quotationIdInput,
      execute: async (input) => deleteQuotation(ctx, input),
    }),
    // Requests for quotation
    saveRfq: tool({
      description:
        'Create or edit a DRAFT request for quotation in ringgit (supplier, lines). Omit id to create. An RFQ in another ' +
        'currency is edited on the RFQs screen.',
      inputSchema: saveRfqToolInput,
      execute: async (input) => saveRfqInRinggit(ctx, input),
    }),
    sendRfq: tool({
      description: 'Mark a draft RFQ as sent to the supplier (it gets its number).',
      inputSchema: rfqIdInput,
      execute: async (input) => sendRfq(ctx, input),
    }),
    quoteRfq: tool({
      description: "Record the supplier's prices per line on a sent RFQ and mark it quoted.",
      inputSchema: quoteRfqInput,
      execute: async (input) => quoteRfq(ctx, input),
    }),
    convertRfq: tool({
      description:
        "Make a draft purchase order from a quoted RFQ. An RFQ in another currency becomes an order in that currency at " +
        "Bank Negara Malaysia's selling rate for today when it has one; otherwise with no rate, which the order needs " +
        'before it is submitted.',
      inputSchema: rfqIdInput,
      execute: async (input) => convertRfq(ctx, input),
    }),
    closeRfq: tool({
      description: 'Close an RFQ that was declined or not taken up.',
      inputSchema: rfqIdInput,
      execute: async (input) => closeRfq(ctx, input),
    }),
    // Purchase orders (decide/close/cancel are sign-off tools, added separately)
    savePurchaseOrder: tool({
      description:
        'Create or edit a DRAFT purchase order in ringgit (supplier, lines). Omit id to create. An order in another ' +
        'currency is edited on the Purchase Orders screen.',
      inputSchema: savePurchaseOrderToolInput,
      execute: async (input) => savePurchaseOrderInRinggit(ctx, input),
    }),
    submitPurchaseOrder: tool({
      description: 'Submit a draft purchase order for approval (it gets its number).',
      inputSchema: purchaseOrderIdInput,
      execute: async (input) => submitPurchaseOrder(ctx, input),
    }),
    receivePurchaseOrder: tool({
      description: 'Record a delivery against an approved purchase order (received quantity per line).',
      inputSchema: receivePurchaseOrderInput,
      execute: async (input) => receivePurchaseOrder(ctx, input),
    }),
    billFromPurchaseOrder: tool({
      description:
        'Create a DRAFT supplier bill from an approved purchase order in ringgit. A bill from an order in another ' +
        'currency is made on the Purchase Orders screen.',
      inputSchema: billFromPurchaseOrderInput,
      execute: async (input) => billFromPurchaseOrderInRinggit(ctx, input),
    }),
    decidePurchaseOrder: tool({
      description: 'Approve or reject a purchase order waiting for approval. Set approve false and give a reason to reject. The business’s owner or an admin only, and never your own order (the books enforce both).',
      inputSchema: decidePurchaseOrderInput,
      execute: async (input) => decidePurchaseOrder(ctx, input),
    }),
    closePurchaseOrder: tool({
      description: 'Close an approved purchase order.',
      inputSchema: purchaseOrderIdInput,
      execute: async (input) => closePurchaseOrder(ctx, input),
    }),
    cancelPurchaseOrder: tool({
      description: 'Cancel a purchase order.',
      inputSchema: purchaseOrderIdInput,
      execute: async (input) => cancelPurchaseOrder(ctx, input),
    }),
    // Manual journals
    saveJournal: tool({
      description: 'Create or edit a DRAFT manual journal (balanced debit and credit lines). Omit id to create.',
      inputSchema: saveJournalInput,
      execute: async (input) => saveJournal(ctx, input),
    }),
    postJournal: tool({
      description: 'Post a draft manual journal to the books (it gets its number and locks). Owner or admin only (the books enforce it).',
      inputSchema: journalIdInput,
      execute: async (input) => postJournal(ctx, input),
    }),
    reverseJournal: tool({
      description: 'Create the reversing draft of a posted journal (post it separately to undo the entry).',
      inputSchema: reverseJournalInput,
      execute: async (input) => reverseJournal(ctx, input),
    }),
    // Credit notes
    saveCreditNote: tool({
      description:
        'Create or edit a DRAFT credit note against an invoice, in ringgit. Omit id to create. Invoices in ringgit only: ' +
        'a credit note on an invoice in another currency is recorded on the Credit Notes screen.',
      inputSchema: saveCreditNoteInput,
      execute: async (input) => saveCreditNoteInRinggit(ctx, input),
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
      description:
        'Record a refund to a customer (money paid back), in ringgit. Invoices in ringgit only: a refund on an invoice ' +
        'in another currency is recorded on the Refunds screen, where the ringgit paid out is entered.',
      inputSchema: recordRefundToolInput,
      execute: async (input) => recordRefundInRinggit(ctx, input),
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
      description:
        'Create or edit a DRAFT supplier bill in ringgit. Omit id to create. A bill in another currency is edited on ' +
        'the Supplier Bills screen.',
      inputSchema: saveBillToolInput,
      execute: async (input) => saveBillInRinggit(ctx, input),
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
      description:
        'Record a payment received from a customer against their invoices, in ringgit. Invoices in ringgit only: ' +
        'a payment of an invoice in another currency is recorded on the Invoices screen, where the ringgit received is entered.',
      inputSchema: recordPaymentInToolInput,
      execute: async (input) => recordPaymentInRinggit(ctx, input),
    }),
    recordPaymentOut: tool({
      description:
        'Record a payment made to a supplier against their bills, in ringgit. Bills in ringgit only: a payment of a ' +
        'bill in another currency is recorded on the Payments Out screen, where the ringgit paid out is entered.',
      inputSchema: recordPaymentOutToolInput,
      execute: async (input) => recordPaymentOutInRinggit(ctx, input),
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
