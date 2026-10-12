import { describe, expect, it } from 'vitest';
import { createCrmTools } from '@/lib/ai/crm-tools';

const CONTACT = '11111111-1111-4111-8111-111111111111';
const DEAL = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const OTHER_CUSTOMER = '55555555-5555-4555-8555-555555555555';

/** Each table answers with fixed rows, whatever is asked of it. */
function fakeClient(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const rows = () => tables[table] ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'limit', 'range', 'eq', 'in', 'is']) builder[method] = () => builder;
    builder.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    builder.then = (resolve: (value: unknown) => void) =>
      resolve({ data: rows(), count: rows().length, error: null });
    return builder;
  };
  return { from } as never;
}

function invoiceRow(n: number, status: string, total: number, paid: number, customerId = CUSTOMER) {
  return {
    id: `inv-${n}`,
    invoice_no: status === 'draft' ? null : `INV-000${n}`,
    customer_id: customerId,
    customer_name: customerId === CUSTOMER ? 'Aisyah Trading' : 'Zaki Enterprise',
    // The database sends numbers as text.
    invoice_date: `${new Date().toISOString().slice(0, 8)}0${n}`,
    due_date: '2099-01-01',
    total: total.toFixed(2),
    paid: paid.toFixed(2),
    credited: '0.00',
    refunded: '0.00',
    balance: (total - paid).toFixed(2),
    display_status: status,
    einvoice_status: 'none',
    einvoice_uuid: null,
  };
}

const INVOICES = [
  invoiceRow(1, 'sent', 500, 100),
  invoiceRow(2, 'paid', 50, 50),
  invoiceRow(3, 'void', 30, 0),
  invoiceRow(4, 'overdue', 200, 0, OTHER_CUSTOMER),
];

const DEAL_ROW = {
  id: DEAL,
  title: 'POS rollout',
  value_cents: 120000,
  status: 'open',
  contact_id: CONTACT,
  pipeline_id: 'p1',
  stage_id: 's1',
  crm_contacts: { company: 'Aisyah Trading', first_name: 'Aisyah', last_name: 'Rahim' },
};

function tools(tables: Record<string, Record<string, unknown>[]>, canWrite = false) {
  const all = createCrmTools({ client: fakeClient(tables), orgId: 'org1', userId: 'user1', canWrite });
  return (name: string, input: unknown) =>
    (all as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>)[
      name
    ].execute(input, { toolCallId: 't1', messages: [] });
}

const TABLES = {
  finance_invoice_totals: INVOICES,
  crm_deal_invoices: [{ deal_id: DEAL, invoice_id: 'inv-1' }],
  crm_deals: [DEAL_ROW],
  crm_contacts: [{ id: CONTACT, finance_customer_id: CUSTOMER }],
};

describe('Kasturi’s billing lookups', () => {
  it('give the totals, leaving void invoices out of what was billed', async () => {
    const summary = (await tools(TABLES)('getBillingSummary', {})) as Record<string, unknown>;
    expect(summary).toMatchObject({
      billed_this_month_rm: 750,
      invoices_this_month: 3,
      outstanding_rm: 600,
      outstanding_invoices: 2,
      overdue_rm: 200,
      overdue_invoices: 1,
      received_rm: 150,
      collection_rate_pct: 20,
      invoices_by_status: { draft: 0, sent: 1, overdue: 1, paid: 1, void: 1 },
    });
    expect(summary.top_customers).toEqual([
      { customer: 'Aisyah Trading', billed_rm: 550, outstanding_rm: 400 },
      { customer: 'Zaki Enterprise', billed_rm: 200, outstanding_rm: 200 },
    ]);
  });

  it('list invoices with the deal each is linked to, and nothing owed on a void one', async () => {
    const result = (await tools(TABLES)('listBillingInvoices', {})) as {
      total_matching: number;
      invoices: Record<string, unknown>[];
    };
    expect(result.total_matching).toBe(4);
    expect(result.invoices.find((invoice) => invoice.number === 'INV-0001')).toMatchObject({
      customer: 'Aisyah Trading',
      total_rm: 500,
      paid_rm: 100,
      balance_rm: 400,
      status: 'sent',
      deal: 'POS rollout',
    });
    expect(result.invoices.find((invoice) => invoice.number === 'INV-0003')).toMatchObject({
      balance_rm: 0,
      status: 'void',
      deal: null,
    });
  });

  it('narrow to a status, to a contact’s billing customer, or to a deal', async () => {
    const run = tools(TABLES);
    const numbers = async (input: unknown) =>
      ((await run('listBillingInvoices', input)) as { invoices: { number: string }[] }).invoices
        .map((invoice) => invoice.number)
        .sort();
    expect(await numbers({ status: 'overdue' })).toEqual(['INV-0004']);
    expect(await numbers({ contactId: CONTACT })).toEqual(['INV-0001', 'INV-0002', 'INV-0003']);
    expect(await numbers({ dealId: DEAL })).toEqual(['INV-0001']);
  });

  it('say plainly when the contact has no billing customer, instead of listing everyone’s invoices', async () => {
    const result = await tools({ ...TABLES, crm_contacts: [{ id: CONTACT, finance_customer_id: null }] })(
      'listBillingInvoices',
      { contactId: CONTACT },
    );
    expect(result).toEqual({
      total_matching: 0,
      invoices: [],
      note: 'This contact has no billing customer. One is chosen on the contact’s edit form in Kasturi.',
    });
  });

  it('are lookups a viewer has too, and there is no tool that changes an invoice', () => {
    const all = createCrmTools({ client: fakeClient(TABLES), orgId: 'org1', userId: 'user1', canWrite: true });
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['getBillingSummary', 'listBillingInvoices']));
    expect(Object.keys(all).filter((name) => /invoice/i.test(name))).toEqual(['listBillingInvoices']);
    const viewer = createCrmTools({ client: fakeClient(TABLES), orgId: 'org1', userId: 'user1', canWrite: false });
    expect(Object.keys(viewer)).toEqual(expect.arrayContaining(['getBillingSummary', 'listBillingInvoices']));
  });
});
