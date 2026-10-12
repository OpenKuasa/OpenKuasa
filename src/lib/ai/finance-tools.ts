/**
 * Bendahara (finance) tools for Ask-Bendahara and Tuah. Each tool wraps an
 * existing `@/lib/finance/*` capability function, run as the signed-in user and
 * narrowed to their workspace — the `org_id` is the caller's, never the model's.
 * Reads return the rows the capability returns; changes return its `FinResult`
 * (so an `ok:false` reaches the model), and each change waits for the user's
 * approval before it runs (see `FINANCE_WRITE_TOOL_NAMES` in products.ts).
 *
 * Contacts and items use finance-scoped tool names (`listFinanceContacts`,
 * `listFinanceItems`, …) so the toolkit never clashes with the reach/crm
 * `listContacts`/`createContact` when Tuah combines every product.
 */

import { tool } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getInvoice, listInvoices } from '@/lib/finance/invoices';
import { getBill, listBills } from '@/lib/finance/bills';
import { listQuotations } from '@/lib/finance/quotations';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listRefunds } from '@/lib/finance/refunds';
import {
  listBillBalances,
  listContacts,
  listInvoiceBalances,
} from '@/lib/finance/contacts';
import { listProducts } from '@/lib/finance/products';
import { listAccounts, listPaymentsIn, listPaymentsOut } from '@/lib/finance/money';
import type { FinanceWriteContext } from '@/lib/finance/result';

/** Who is asking, and whether they may change anything. */
export type FinanceAccess = {
  client: SupabaseClient;
  orgId: string;
  canWrite: boolean;
};

const idInput = z.object({ id: z.string().describe('The row id from a lookup.') });

export function createBendaharaTools(access: FinanceAccess) {
  const ctx: FinanceWriteContext = { client: access.client, orgId: access.orgId };

  const read = {
    getFinanceOverview: tool({
      description:
        'A money snapshot for the owner: total receivables (money owed to the business) and payables ' +
        '(money it owes), how many of each are overdue, and the bank and cash accounts. Amounts in sen.',
      inputSchema: z.object({}),
      execute: async () => {
        const [receivable, payable, accounts] = await Promise.all([
          listInvoiceBalances(ctx),
          listBillBalances(ctx),
          listAccounts(ctx),
        ]);
        const sum = (rows: { balance: number }[]) => rows.reduce((n, r) => n + r.balance, 0);
        const overdue = (rows: { display_status: string }[]) =>
          rows.filter((r) => r.display_status === 'overdue').length;
        return {
          receivables: { total_sen: sum(receivable), overdue_count: overdue(receivable) },
          payables: { total_sen: sum(payable), overdue_count: overdue(payable) },
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
  // Write tools are added in the next task.
  return read;
}
