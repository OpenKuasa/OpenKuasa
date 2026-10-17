import { describe, expect, it } from 'vitest';
import { CrmContactFormError } from '@/lib/crm/contacts';
import {
  INVOICE_LINK_MESSAGES,
  MAX_DEAL_INVOICES,
  dealBilling,
  dealInvoiceChoices,
  readBillingCustomerId,
  readDealInvoiceIds,
  setContactBillingCustomer,
  setDealInvoices,
} from '@/lib/crm/invoice-links';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { ringgitRow } from './helpers/invoice-rows';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const DEAL = '22222222-2222-4222-8222-222222222222';
const uuid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function invoice(id: string, status: InvoiceListRow['display_status'], total: number, balance: number): InvoiceListRow {
  return ringgitRow({
    id,
    invoice_no: status === 'draft' ? null : `INV-${id.slice(-2)}`,
    customer_id: CUSTOMER,
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-05',
    due_date: '2026-11-04',
    total,
    paid: total - balance,
    credited: 0,
    refunded: 0,
    balance,
    display_status: status,
    einvoice_status: 'none',
    einvoice_uuid: null,
  });
}

type Result = { data?: unknown; error?: { code?: string } | null };

/** A stand-in for the Supabase client: answers each table's calls in turn and keeps what was written. */
function fakeClient(answers: Result[]) {
  const seen: { op: string; table: string; payload?: unknown; filters: unknown[][] }[] = [];
  const from = (table: string) => {
    const call = { op: 'select', table, payload: undefined as unknown, filters: [] as unknown[][] };
    seen.push(call);
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    for (const method of ['eq', 'in']) {
      builder[method] = (...args: unknown[]) => {
        call.filters.push([method, ...args]);
        return builder;
      };
    }
    for (const op of ['insert', 'update', 'delete']) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: null, ...answers.shift() });
    return builder;
  };
  return { client: { from } as never, seen };
}

describe('reading the link fields off a form', () => {
  it('a form without the picker leaves the contact’s billing customer alone', () => {
    expect(readBillingCustomerId(form([['firstName', 'Aisyah']]))).toBeUndefined();
  });

  it('"None" clears it, a customer sets it, anything else is refused', () => {
    expect(readBillingCustomerId(form([['billingCustomerId', '']]))).toBeNull();
    expect(readBillingCustomerId(form([['billingCustomerId', CUSTOMER]]))).toBe(CUSTOMER);
    expect(() => readBillingCustomerId(form([['billingCustomerId', 'x']]))).toThrow(INVOICE_LINK_MESSAGES.customer);
  });

  it('a deal form without the picker leaves its invoices alone', () => {
    expect(readDealInvoiceIds(form([['invoiceIds', uuid(1)]]))).toBeUndefined();
  });

  it('the picker with nothing ticked means no invoices, and repeats are dropped', () => {
    expect(readDealInvoiceIds(form([['invoiceLinks', '1']]))).toEqual([]);
    expect(
      readDealInvoiceIds(form([['invoiceLinks', '1'], ['invoiceIds', uuid(1)], ['invoiceIds', uuid(1)], ['invoiceIds', uuid(2)]])),
    ).toEqual([uuid(1), uuid(2)]);
  });

  it('refuses something that is not an invoice id, and too many', () => {
    expect(() => readDealInvoiceIds(form([['invoiceLinks', '1'], ['invoiceIds', 'nope']]))).toThrow(
      INVOICE_LINK_MESSAGES.invoice,
    );
    const many: [string, string][] = Array.from({ length: MAX_DEAL_INVOICES + 1 }, (_, i) => ['invoiceIds', uuid(i)]);
    expect(() => readDealInvoiceIds(form([['invoiceLinks', '1'], ...many]))).toThrow(INVOICE_LINK_MESSAGES.tooMany);
  });
});

describe('what a deal’s invoices add up to', () => {
  it('counts posted invoices as billed; drafts and void ones only as linked', () => {
    const invoices = [
      invoice(uuid(1), 'sent', 1000.1, 400.1),
      invoice(uuid(2), 'paid', 250.2, 0),
      invoice(uuid(3), 'draft', 9000, 9000),
      invoice(uuid(4), 'void', 7000, 7000),
      invoice(uuid(5), 'overdue', 80, 80),
    ];
    const totals = dealBilling(
      [
        { dealId: DEAL, invoiceId: uuid(1) },
        { dealId: DEAL, invoiceId: uuid(2) },
        { dealId: DEAL, invoiceId: uuid(3) },
        { dealId: DEAL, invoiceId: uuid(4) },
        { dealId: 'other', invoiceId: uuid(5) },
        // A link whose invoice was not loaded is skipped.
        { dealId: 'gone', invoiceId: uuid(9) },
      ],
      invoices,
    );
    expect(totals).toEqual({
      [DEAL]: { count: 4, billed: 1250.3, outstanding: 400.1 },
      other: { count: 1, billed: 80, outstanding: 80 },
    });
  });
});

describe('the invoices a deal form offers', () => {
  it('names each one, says which deal has it, and hides void ones that are not linked', () => {
    const choices = dealInvoiceChoices(
      [invoice(uuid(1), 'sent', 10, 10), invoice(uuid(2), 'draft', 20, 20), invoice(uuid(3), 'void', 30, 30), invoice(uuid(4), 'void', 40, 40)],
      [
        { dealId: DEAL, invoiceId: uuid(1) },
        { dealId: DEAL, invoiceId: uuid(4) },
      ],
      (amount) => `RM ${amount}`,
    );
    expect(choices).toEqual([
      { id: uuid(1), label: 'INV-01 · Aisyah Trading · RM 10', customerId: CUSTOMER, dealId: DEAL },
      { id: uuid(2), label: 'Draft · Aisyah Trading · RM 20', customerId: CUSTOMER, dealId: null },
      { id: uuid(4), label: 'INV-04 · Aisyah Trading · RM 40', customerId: CUSTOMER, dealId: DEAL },
    ]);
  });
});

describe('saving a contact’s billing customer', () => {
  it('writes only the link, to that contact in that workspace', async () => {
    const { client, seen } = fakeClient([{ data: [{ id: 'c1' }] }]);
    await setContactBillingCustomer(client, 'org1', 'c1', CUSTOMER);
    expect(seen[0].table).toBe('crm_contacts');
    expect(seen[0].op).toBe('update');
    expect(seen[0].payload).toMatchObject({ finance_customer_id: CUSTOMER });
    expect(Object.keys(seen[0].payload as object).sort()).toEqual(['finance_customer_id', 'updated_at']);
    expect(seen[0].filters).toEqual([
      ['eq', 'id', 'c1'],
      ['eq', 'org_id', 'org1'],
    ]);
  });

  it('says so when the customer has gone, or the contact has', async () => {
    await expect(
      setContactBillingCustomer(fakeClient([{ error: { code: '23503' } }]).client, 'org1', 'c1', CUSTOMER),
    ).rejects.toThrow(INVOICE_LINK_MESSAGES.customer);
    await expect(setContactBillingCustomer(fakeClient([{ data: [] }]).client, 'org1', 'c1', null)).rejects.toThrow(
      CrmContactFormError,
    );
  });
});

describe('saving a deal’s invoices', () => {
  it('removes the links no longer wanted and adds the new ones, leaving the rest', async () => {
    const { client, seen } = fakeClient([{ data: [{ invoice_id: uuid(1) }, { invoice_id: uuid(2) }] }, {}, {}]);
    await setDealInvoices(client, 'org1', DEAL, [uuid(2), uuid(3)], 'user1');
    expect(seen.map((call) => call.op)).toEqual(['select', 'delete', 'insert']);
    expect(seen[1].filters).toEqual([
      ['eq', 'org_id', 'org1'],
      ['eq', 'deal_id', DEAL],
      ['in', 'invoice_id', [uuid(1)]],
    ]);
    expect(seen[2].payload).toEqual([{ org_id: 'org1', deal_id: DEAL, invoice_id: uuid(3), created_by: 'user1' }]);
  });

  it('writes nothing when nothing changed', async () => {
    const { client, seen } = fakeClient([{ data: [{ invoice_id: uuid(1) }] }]);
    await setDealInvoices(client, 'org1', DEAL, [uuid(1)]);
    expect(seen).toHaveLength(1);
  });

  it('refuses an invoice another deal already has, as a plain message', async () => {
    const { client } = fakeClient([{ data: [] }, { error: { code: '23505' } }]);
    await expect(setDealInvoices(client, 'org1', DEAL, [uuid(1)])).rejects.toThrow(INVOICE_LINK_MESSAGES.taken);
  });

  it('says so when an invoice has gone', async () => {
    const { client } = fakeClient([{ data: [] }, { error: { code: '23503' } }]);
    await expect(setDealInvoices(client, 'org1', DEAL, [uuid(1)])).rejects.toThrow(INVOICE_LINK_MESSAGES.invoice);
  });
});
