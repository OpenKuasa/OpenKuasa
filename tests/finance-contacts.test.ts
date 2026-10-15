import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceWriteContext } from '@/lib/finance/result';
import {
  type FinanceContact,
  contactsView,
  createContact,
  createContactInput,
  deleteContact,
  listBillBalances,
  setContactActive,
  updateContact,
  updateContactInput,
} from '@/lib/finance/contacts';

const ID = '11111111-1111-4111-8111-111111111111';

type Call = { table: string; op: string; values?: Record<string, unknown>; filters: Record<string, unknown> };

/** A stand-in Supabase client that records the request and answers with a canned result. */
function fakeClient(answer: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: '', filters: {} };
      calls.push(call);
      const builder = {
        insert(values: Record<string, unknown>) { call.op = 'insert'; call.values = values; return builder; },
        update(values: Record<string, unknown>) { call.op = 'update'; call.values = values; return builder; },
        delete() { call.op = 'delete'; return builder; },
        eq(column: string, value: unknown) { call.filters[column] = value; return builder; },
        select() { return builder; },
        single: async () => answer,
        maybeSingle: async () => answer,
      };
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, calls };
}

const contact: FinanceContact = {
  id: ID, name: 'Lim Hardware Sdn Bhd', is_customer: false, is_supplier: true,
  email: 'sales@limhardware.com.my', phone: null, ssm_no: null, tin: null,
  payment_terms_days: 30, active: true, default_currency: null,
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown) =>
  schema.safeParse(value).error?.issues[0]?.message;

describe('contact schemas', () => {
  const valid = { name: 'Aisyah Trading', is_customer: true, is_supplier: false };

  it('asks for a name', () => {
    expect(first(createContactInput, { ...valid, name: '   ' })).toBe('Enter the contact’s name.');
  });
  it('refuses a contact that is neither customer nor supplier', () => {
    expect(first(createContactInput, { ...valid, is_customer: false })).toBe('Tick Customer, Supplier or both.');
    expect(first(updateContactInput, { id: ID, is_customer: false, is_supplier: false })).toBe('Tick Customer, Supplier or both.');
  });
  it('refuses an email that is not an email, and accepts an empty one', () => {
    expect(first(createContactInput, { ...valid, email: 'not-an-email' })).toBe('Enter a valid email address, or leave it empty.');
    expect(createContactInput.parse({ ...valid, email: '' }).email).toBeNull();
  });
  it('turns empty text into null and trims the rest', () => {
    const parsed = createContactInput.parse({ ...valid, name: '  Aisyah Trading ', phone: '', ssm_no: ' 201901012345 ', tin: '' });
    expect(parsed).toMatchObject({ name: 'Aisyah Trading', phone: null, ssm_no: '201901012345', tin: null, payment_terms_days: 30 });
  });
  it('keeps payment terms between 0 and 365 whole days', () => {
    expect(first(createContactInput, { ...valid, payment_terms_days: -1 })).toBe('Payment terms must be between 0 and 365 days.');
    expect(first(createContactInput, { ...valid, payment_terms_days: 400 })).toBe('Payment terms must be between 0 and 365 days.');
    expect(first(createContactInput, { ...valid, payment_terms_days: 7.5 })).toBe('Payment terms must be between 0 and 365 days.');
  });
});

describe('contact writes', () => {
  it('creates in the caller’s workspace, never one named by the input', async () => {
    const { ctx, calls } = fakeClient({ data: contact, error: null });
    const result = await createContact(ctx, { name: 'Lim Hardware Sdn Bhd', is_customer: false, is_supplier: true, org_id: 'other' } as never);
    expect(result).toEqual({ ok: true, data: contact });
    expect(calls[0]).toMatchObject({ table: 'finance_contacts', op: 'insert' });
    expect(calls[0].values).toMatchObject({ org_id: 'org-1', is_supplier: true });
  });
  it('updates only the fields sent, scoped to the workspace, and stamps updated_at', async () => {
    const { ctx, calls } = fakeClient({ data: contact, error: null });
    await updateContact(ctx, { id: ID, phone: '+60 3-7956 1234' });
    expect(calls[0].filters).toEqual({ id: ID, org_id: 'org-1' });
    expect(Object.keys(calls[0].values!).sort()).toEqual(['phone', 'updated_at']);
  });
  it('says so when there is nothing to update', async () => {
    const { ctx } = fakeClient({ data: contact, error: null });
    expect(await updateContact(ctx, { id: ID })).toEqual({ ok: false, error: 'Nothing to update.' });
  });
  it('says the contact is gone when no row comes back', async () => {
    const { ctx } = fakeClient({ data: null, error: null });
    expect(await updateContact(ctx, { id: ID, name: 'New name' })).toEqual({ ok: false, error: 'That contact no longer exists.' });
    expect(await setContactActive(ctx, { id: ID, active: false })).toEqual({ ok: false, error: 'That contact no longer exists.' });
    expect(await deleteContact(ctx, { id: ID })).toEqual({ ok: false, error: 'That contact no longer exists.' });
  });
  it('explains a delete refused because documents use the contact', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '23503' } });
    expect(await deleteContact(ctx, { id: ID })).toEqual({
      ok: false,
      error: 'This contact is used on bills or other documents. Archive it instead.',
    });
  });
  it('explains the database refusing a contact with no role', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: '23514' } });
    expect(await updateContact(ctx, { id: ID, name: 'X' })).toEqual({ ok: false, error: 'Tick Customer, Supplier or both.' });
  });
  it('explains that a supplier with bills cannot stop being a supplier', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'FIN07' } });
    expect(await updateContact(ctx, { id: ID, is_customer: true, is_supplier: false })).toEqual({
      ok: false,
      error: 'This contact has supplier bills, so it has to stay a supplier.',
    });
  });
  it('explains that a customer with invoices cannot stop being a customer', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'FIN08' } });
    expect(await updateContact(ctx, { id: ID, is_customer: false, is_supplier: true })).toEqual({
      ok: false,
      error: 'This contact has invoices or quotations, so it has to stay a customer.',
    });
    expect(logged).not.toHaveBeenCalled();
  });
  it('hides any other database error behind a general message and logs it', async () => {
    const { ctx } = fakeClient({ data: null, error: { code: 'XX000', message: 'boom' } });
    expect(await createContact(ctx, { name: 'A', is_customer: true, is_supplier: false })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(logged).toHaveBeenCalled();
  });
});

describe('contactsView', () => {
  const customer: FinanceContact = { ...contact, id: 'c1', name: 'Aisyah Trading', is_customer: true, is_supplier: false };
  const archived: FinanceContact = { ...contact, id: 's2', name: 'Old Supplier', active: false };
  const bills = [
    { supplier_id: ID, balance: 2243.6, display_status: 'pending' },
    { supplier_id: ID, balance: 100, display_status: 'overdue' },
    { supplier_id: ID, balance: 780.4, display_status: 'draft' },
    { supplier_id: ID, balance: 0, display_status: 'paid' },
    { supplier_id: 's2', balance: 50, display_status: 'pending' },
  ];

  it('counts active customers and suppliers, and sums open payables only', () => {
    const view = contactsView([contact, customer, archived], bills);
    expect(view.stats).toEqual({ customers: 1, suppliers: 1, receivable: 0, payable: 2393.6 });
  });
  it('counts a payable owed to a supplier that is not among the loaded contacts', () => {
    const view = contactsView([contact], [...bills, { supplier_id: 'not-loaded', balance: 10, display_status: 'overdue' }]);
    expect(view.stats.payable).toBe(2403.6);
  });
  it('gives each contact its payable, including an archived one', () => {
    const view = contactsView([contact, customer, archived], bills);
    const byId = Object.fromEntries(view.rows.map((r) => [r.id, r.payable]));
    expect(byId).toEqual({ [ID]: 2343.6, c1: 0, s2: 50 });
  });
  it('lists the largest balances first and leaves out zero balances', () => {
    const view = contactsView([contact, customer, archived], bills);
    expect(view.topBalances).toEqual([
      { label: 'Lim Hardware Sdn Bhd', balance: 2343.6 },
      { label: 'Old Supplier', balance: 50 },
    ]);
  });
  it('sorts rows by name', () => {
    const view = contactsView([contact, customer, archived], []);
    expect(view.rows.map((r) => r.name)).toEqual(['Aisyah Trading', 'Lim Hardware Sdn Bhd', 'Old Supplier']);
  });
});

describe('listBillBalances', () => {
  type Page = { data: unknown[] | null; error: unknown };

  /** A stand-in list query: from → select → eq → in → order → range, answering one canned page per range call. */
  function fakeListClient(pages: Page[]) {
    const ranges: [number, number][] = [];
    const client = {
      from() {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          in() { return builder; },
          order() { return builder; },
          range(from: number, to: number) {
            ranges.push([from, to]);
            return Promise.resolve(pages[ranges.length - 1] ?? { data: [], error: null });
          },
        };
        return builder;
      },
    };
    return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, ranges };
  }

  const bill = (n: number) => ({ supplier_id: 's1', balance: String(n), display_status: 'pending' });
  const fullPage = Array.from({ length: 1000 }, (_, i) => bill(i + 1));

  it('reads one page when there are fewer than a page, with balances as numbers', async () => {
    const { ctx, ranges } = fakeListClient([{ data: [bill(12.5), bill(7)], error: null }]);
    const rows = await listBillBalances(ctx);
    expect(ranges).toEqual([[0, 999]]);
    expect(rows).toEqual([
      { supplier_id: 's1', balance: 12.5, display_status: 'pending' },
      { supplier_id: 's1', balance: 7, display_status: 'pending' },
    ]);
  });
  it('keeps reading until a short page, so no bill is left out', async () => {
    const { ctx, ranges } = fakeListClient([
      { data: fullPage, error: null },
      { data: [bill(5)], error: null },
    ]);
    const rows = await listBillBalances(ctx);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(rows).toHaveLength(1001);
    expect(rows.every((r) => typeof r.balance === 'number')).toBe(true);
  });
  it('throws a database error instead of swallowing it', async () => {
    const failure = { code: 'XX000', message: 'boom' };
    const { ctx } = fakeListClient([{ data: null, error: failure }]);
    await expect(listBillBalances(ctx)).rejects.toBe(failure);
  });
});
