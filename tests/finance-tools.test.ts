import { describe, expect, it, vi } from 'vitest';

// Keep the real Zod input schemas; override only the fns we invoke.
vi.mock('@/lib/finance/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finance/invoices')>();
  return {
    ...actual,
    listInvoices: async (ctx: { orgId: string }) => ({ echoedOrg: ctx.orgId }),
  };
});

const { createBendaharaTools } = await import('@/lib/ai/finance-tools');

const viewer = () => ({ client: {} as never, orgId: 'org1', canWrite: false });
const exec = (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });

const READ_NAMES = [
  'getFinanceOverview',
  'listInvoices',
  'getInvoice',
  'listInvoiceBalances',
  'listQuotations',
  'listCreditNotes',
  'listRefunds',
  'listBills',
  'getBill',
  'listBillBalances',
  'listPaymentsIn',
  'listPaymentsOut',
  'listFinanceContacts',
  'listFinanceItems',
  'listAccounts',
];

describe('Bendahara read tools', () => {
  it('exposes every finance lookup', () => {
    const tools = createBendaharaTools(viewer());
    for (const name of READ_NAMES) expect(Object.keys(tools), name).toContain(name);
  });

  it('gives a viewer no change tools at all', () => {
    const names = Object.keys(createBendaharaTools(viewer()));
    for (const write of ['postInvoice', 'voidInvoice', 'recordPaymentIn', 'createFinanceContact']) {
      expect(names, write).not.toContain(write);
    }
  });

  it('runs lookups with the caller ctx (org never from the model)', async () => {
    const tools = createBendaharaTools(viewer());
    expect(await exec(tools.listInvoices, {})).toEqual({ echoedOrg: 'org1' });
  });
});
