/**
 * Finance contacts: the customers and suppliers on invoices, bills and
 * payments. One Zod schema and one function per write; org_id always comes
 * from the FinanceWriteContext, never from the input.
 */
import { z } from 'zod';
import { isDocumentCurrency } from './currencies';
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
  /** The currency a new quotation for this contact starts in; null for none (ringgit). Fills forms only. */
  default_currency: string | null;
};

export const CONTACT_COLUMNS =
  'id,name,is_customer,is_supplier,email,phone,ssm_no,tin,payment_terms_days,active,default_currency';

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
  hasInvoices: 'This contact has invoices or quotations, so it has to stay a customer.',
  currency: 'Choose a currency from the list, or none.',
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
/** An ISO 4217 code a document may carry, or null for none. */
const currency = z.string({ error: M.currency }).refine(isDocumentCurrency, M.currency).nullable();

const createContactBase = z.object({
    name,
    is_customer: z.boolean({ error: M.role }),
    is_supplier: z.boolean({ error: M.role }),
    email: email.default(null),
    phone: text.default(null),
    ssm_no: text.default(null),
    tin: text.default(null),
    payment_terms_days: terms.default(30),
    default_currency: currency.default(null),
  });
const hasRole = (v: { is_customer: boolean; is_supplier: boolean }) => v.is_customer || v.is_supplier;

export const createContactInput = createContactBase.refine(hasRole, { message: M.role, path: ['is_customer'] });

/**
 * What the finance assistant may send: no default currency. It writes ringgit only, so the key is not in the
 * schema the model sees and a call that carries it is stripped (a new contact has none).
 */
export const createContactToolInput = createContactBase
  .omit({ default_currency: true })
  .refine(hasRole, { message: M.role, path: ['is_customer'] });

const updateContactBase = z.object({
    id,
    name: name.optional(),
    is_customer: z.boolean({ error: M.role }).optional(),
    is_supplier: z.boolean({ error: M.role }).optional(),
    email: email.optional(),
    phone: text.optional(),
    ssm_no: text.optional(),
    tin: text.optional(),
    payment_terms_days: terms.optional(),
    // Absent leaves it as it is: the finance assistant changes contacts without knowing of it.
    default_currency: currency.optional(),
  });

type RolesTicked = { is_customer?: boolean; is_supplier?: boolean };
// The two ticks travel together, so the rule can be checked before the database does.
const ticksTravelTogether = (v: RolesTicked) => (v.is_customer === undefined) === (v.is_supplier === undefined);
const hasARole = (v: RolesTicked) => v.is_customer === undefined || v.is_customer || !!v.is_supplier;

export const updateContactInput = updateContactBase
  .refine(ticksTravelTogether, { message: M.role, path: ['is_customer'] })
  .refine(hasARole, { message: M.role, path: ['is_customer'] });

/** As `updateContactInput`, without the default currency: the finance assistant leaves it alone. */
export const updateContactToolInput = updateContactBase
  .omit({ default_currency: true })
  .refine(ticksTravelTogether, { message: M.role, path: ['is_customer'] })
  .refine(hasARole, { message: M.role, path: ['is_customer'] });

export const setContactActiveInput = z.object({ id, active: z.boolean() });
export const deleteContactInput = z.object({ id });

function contactWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const code = pgCode(error);
  if (code === PG_FOREIGN_KEY) return { ok: false, error: M.inUse };
  if (code === 'FIN07') return { ok: false, error: M.hasBills };
  if (code === 'FIN08') return { ok: false, error: M.hasInvoices };
  // The domain public.finance_currency refuses a code the list in currencies.ts would have refused first.
  if (code === PG_CHECK && /finance_currency/.test(String((error as { message?: unknown } | null)?.message ?? ''))) {
    return { ok: false, error: M.currency };
  }
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
export type InvoiceBalance = { customer_id: string; balance: number; display_status: string };

/** Bills or invoices read per request; the database caps one response, so we page. */
export const BILL_PAGE_SIZE = 1000;

/** Every open document of one totals view with its balance as a number, read a page at a time so no figure is cut short. */
async function listOpenBalances<T extends { balance: number }>(
  ctx: FinanceWriteContext,
  view: 'supplier_bill_totals' | 'finance_invoice_totals',
  columns: string,
  open: string[],
): Promise<T[]> {
  const balances: T[] = [];
  for (let from = 0; ; from += BILL_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from(view)
      .select(columns)
      .eq('org_id', ctx.orgId)
      .in('display_status', open)
      .order('id', { ascending: true })
      .range(from, from + BILL_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of page) balances.push({ ...row, balance: Number(row.balance) } as unknown as T);
    if (page.length < BILL_PAGE_SIZE) return balances;
  }
}

/**
 * What is still owed on each supplier bill, for the Payable figures. Reads
 * every open bill, a page at a time, so the money figures are never cut short.
 */
export async function listBillBalances(ctx: FinanceWriteContext): Promise<BillBalance[]> {
  // In ringgit: these are added up per supplier, and a bill in another currency counts at its rate.
  return listOpenBalances<BillBalance>(ctx, 'supplier_bill_totals', 'supplier_id, balance:balance_myr, display_status', ['pending', 'overdue']);
}

/**
 * What customers still owe on each posted invoice, for the Receivable
 * figures: the invoices that are "Sent" or "Overdue", read the same way.
 */
export async function listInvoiceBalances(ctx: FinanceWriteContext): Promise<InvoiceBalance[]> {
  // In ringgit: these are added up per customer, and an invoice in another currency counts at its rate.
  return listOpenBalances<InvoiceBalance>(ctx, 'finance_invoice_totals', 'customer_id, balance:balance_myr, display_status', ['sent', 'overdue']);
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

export type ContactRow = FinanceContact & { payable: number; receivable: number };

export type ContactsViewData = {
  stats: { customers: number; suppliers: number; receivable: number; payable: number };
  topBalances: { label: string; balance: number }[];
  rows: ContactRow[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Payable counts bills that are pending or overdue; Receivable counts
 * invoices that are sent or overdue. An archived contact still owes, and is
 * still owed, what it was. Both cards are totalled from every open document,
 * not only the contacts loaded.
 */
export function contactsView(
  contacts: FinanceContact[],
  bills: BillBalance[],
  invoices: InvoiceBalance[] = [],
): ContactsViewData {
  const owed = new Map<string, number>();
  for (const bill of bills) {
    if (bill.display_status !== 'pending' && bill.display_status !== 'overdue') continue;
    owed.set(bill.supplier_id, (owed.get(bill.supplier_id) ?? 0) + bill.balance);
  }
  const due = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.display_status !== 'sent' && invoice.display_status !== 'overdue') continue;
    due.set(invoice.customer_id, (due.get(invoice.customer_id) ?? 0) + invoice.balance);
  }
  const rows = [...contacts]
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((c) => ({ ...c, payable: round2(owed.get(c.id) ?? 0), receivable: round2(due.get(c.id) ?? 0) }));
  const active = rows.filter((c) => c.active);
  return {
    stats: {
      customers: active.filter((c) => c.is_customer).length,
      suppliers: active.filter((c) => c.is_supplier).length,
      receivable: round2([...due.values()].reduce((sum, v) => sum + v, 0)),
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
