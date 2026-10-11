/**
 * Finance contacts: the customers and suppliers on invoices, bills and
 * payments. One Zod schema and one function per write; org_id always comes
 * from the FinanceWriteContext, never from the input.
 */
import { z } from 'zod';
import {
  type FinResult,
  type FinanceWriteContext,
  PG_CHECK,
  PG_FOREIGN_KEY,
  pgCode,
  writeFailed,
} from './result';

export type FinanceContact = {
  id: string;
  name: string;
  is_customer: boolean;
  is_supplier: boolean;
  email: string | null;
  phone: string | null;
  ssm_no: string | null;
  tin: string | null;
  payment_terms_days: number;
  active: boolean;
};

export const CONTACT_COLUMNS =
  'id,name,is_customer,is_supplier,email,phone,ssm_no,tin,payment_terms_days,active';

export const CONTACT_NAME_MAX = 160;
/** Contacts loaded for the screen; the footer says so when there are more. */
export const CONTACT_LIMIT = 1000;

export const CONTACT_MESSAGES = {
  name: 'Enter the contact’s name.',
  nameTooLong: `Keep the name to ${CONTACT_NAME_MAX} characters or fewer.`,
  role: 'Tick Customer, Supplier or both.',
  email: 'Enter a valid email address, or leave it empty.',
  tooLong: 'That is too long. Keep it to 80 characters or fewer.',
  terms: 'Payment terms must be between 0 and 365 days.',
  gone: 'That contact no longer exists.',
  inUse: 'This contact is used on bills or other documents. Archive it instead.',
  hasBills: 'This contact has supplier bills, so it has to stay a supplier.',
  hasInvoices: 'This contact has invoices, so it has to stay a customer.',
} as const;

const M = CONTACT_MESSAGES;

const name = z.string({ error: M.name }).trim().min(1, M.name).max(CONTACT_NAME_MAX, M.nameTooLong);
/** Optional text: trimmed, and an empty box is stored as null. */
const text = z
  .string({ error: M.tooLong })
  .trim()
  .max(80, M.tooLong)
  .transform((v) => (v === '' ? null : v))
  .nullable();
const email = z
  .string({ error: M.email })
  .trim()
  .max(160, M.email)
  .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), M.email)
  .transform((v) => (v === '' ? null : v))
  .nullable();
const terms = z.number({ error: M.terms }).int(M.terms).min(0, M.terms).max(365, M.terms);
const id = z.string({ error: M.gone }).uuid(M.gone);

export const createContactInput = z
  .object({
    name,
    is_customer: z.boolean({ error: M.role }),
    is_supplier: z.boolean({ error: M.role }),
    email: email.default(null),
    phone: text.default(null),
    ssm_no: text.default(null),
    tin: text.default(null),
    payment_terms_days: terms.default(30),
  })
  .refine((v) => v.is_customer || v.is_supplier, { message: M.role, path: ['is_customer'] });

export const updateContactInput = z
  .object({
    id,
    name: name.optional(),
    is_customer: z.boolean({ error: M.role }).optional(),
    is_supplier: z.boolean({ error: M.role }).optional(),
    email: email.optional(),
    phone: text.optional(),
    ssm_no: text.optional(),
    tin: text.optional(),
    payment_terms_days: terms.optional(),
  })
  // The two ticks travel together, so the rule can be checked before the database does.
  .refine((v) => (v.is_customer === undefined) === (v.is_supplier === undefined), {
    message: M.role,
    path: ['is_customer'],
  })
  .refine((v) => v.is_customer === undefined || v.is_customer || v.is_supplier, {
    message: M.role,
    path: ['is_customer'],
  });

export const setContactActiveInput = z.object({ id, active: z.boolean() });
export const deleteContactInput = z.object({ id });

function contactWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const code = pgCode(error);
  if (code === PG_FOREIGN_KEY) return { ok: false, error: M.inUse };
  if (code === 'FIN07') return { ok: false, error: M.hasBills };
  if (code === 'FIN08') return { ok: false, error: M.hasInvoices };
  if (code === PG_CHECK) return { ok: false, error: M.role };
  return writeFailed(fnName, error);
}

export async function listContacts(ctx: FinanceWriteContext): Promise<FinanceContact[]> {
  const { data, error } = await ctx.client
    .from('finance_contacts')
    .select(CONTACT_COLUMNS)
    .eq('org_id', ctx.orgId)
    .order('name', { ascending: true })
    .range(0, CONTACT_LIMIT - 1);
  if (error) throw error;
  return (data ?? []) as unknown as FinanceContact[];
}

export type BillBalance = { supplier_id: string; balance: number; display_status: string };

/** Bills read per request; the database caps one response, so we page. */
export const BILL_PAGE_SIZE = 1000;

/**
 * What is still owed on each supplier bill, for the Payable figures. Reads
 * every open bill, a page at a time, so the money figures are never cut short.
 */
export async function listBillBalances(ctx: FinanceWriteContext): Promise<BillBalance[]> {
  const bills: BillBalance[] = [];
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('supplier_bill_totals')
      .select('supplier_id, balance, display_status')
      .eq('org_id', ctx.orgId)
      .in('display_status', ['pending', 'overdue'])
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    for (const row of page) bills.push({ ...row, balance: Number(row.balance) } as BillBalance);
    if (page.length < BILL_PAGE_SIZE) return bills;
  }
}

export async function createContact(
  ctx: FinanceWriteContext,
  input: z.input<typeof createContactInput>,
): Promise<FinResult<FinanceContact>> {
  const values = createContactInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_contacts')
    .insert({ ...values, org_id: ctx.orgId })
    .select(CONTACT_COLUMNS)
    .single();
  if (error || !data) return contactWriteFailed('createContact', error);
  return { ok: true, data: data as unknown as FinanceContact };
}

export async function updateContact(
  ctx: FinanceWriteContext,
  input: z.input<typeof updateContactInput>,
): Promise<FinResult<FinanceContact>> {
  const { id: contactId, ...fields } = updateContactInput.parse(input);
  if (Object.values(fields).every((v) => v === undefined)) {
    return { ok: false, error: 'Nothing to update.' };
  }
  const { data, error } = await ctx.client
    .from('finance_contacts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('org_id', ctx.orgId)
    .select(CONTACT_COLUMNS)
    .maybeSingle();
  if (error) return contactWriteFailed('updateContact', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: data as unknown as FinanceContact };
}

/** Archive a contact (it leaves the pickers but keeps its documents), or bring it back. */
export async function setContactActive(
  ctx: FinanceWriteContext,
  input: z.input<typeof setContactActiveInput>,
): Promise<FinResult<FinanceContact>> {
  const { id: contactId, active } = setContactActiveInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_contacts')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('org_id', ctx.orgId)
    .select(CONTACT_COLUMNS)
    .maybeSingle();
  if (error) return contactWriteFailed('setContactActive', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: data as unknown as FinanceContact };
}

export async function deleteContact(
  ctx: FinanceWriteContext,
  input: z.input<typeof deleteContactInput>,
): Promise<FinResult<{ id: string }>> {
  const { id: contactId } = deleteContactInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_contacts')
    .delete()
    .eq('id', contactId)
    .eq('org_id', ctx.orgId)
    .select('id')
    .maybeSingle();
  if (error) return contactWriteFailed('deleteContact', error);
  if (!data) return { ok: false, error: M.gone };
  return { ok: true, data: { id: data.id } };
}

/* ---- what the screen shows ------------------------------------------- */

export type ContactRow = FinanceContact & { payable: number };

export type ContactsViewData = {
  stats: { customers: number; suppliers: number; receivable: number; payable: number };
  topBalances: { label: string; balance: number }[];
  rows: ContactRow[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Receivable stays 0 until invoices exist (the sales stage). Payable counts
 * bills that are pending or overdue; an archived supplier still owes what it owes.
 */
export function contactsView(contacts: FinanceContact[], bills: BillBalance[]): ContactsViewData {
  const owed = new Map<string, number>();
  for (const bill of bills) {
    if (bill.display_status !== 'pending' && bill.display_status !== 'overdue') continue;
    owed.set(bill.supplier_id, (owed.get(bill.supplier_id) ?? 0) + bill.balance);
  }
  const rows = [...contacts]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((c) => ({ ...c, payable: round2(owed.get(c.id) ?? 0) }));
  const active = rows.filter((c) => c.active);
  return {
    stats: {
      customers: active.filter((c) => c.is_customer).length,
      suppliers: active.filter((c) => c.is_supplier).length,
      receivable: 0,
      payable: round2([...owed.values()].reduce((sum, v) => sum + v, 0)),
    },
    topBalances: rows
      .filter((c) => c.payable > 0)
      .sort((x, y) => y.payable - x.payable)
      .slice(0, 5)
      .map((c) => ({ label: c.name, balance: c.payable })),
    rows,
  };
}
