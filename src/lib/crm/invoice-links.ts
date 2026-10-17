import type { SupabaseClient } from '@supabase/supabase-js';
import { CrmContactFormError } from '@/lib/crm/contacts';
import { type InvoiceListRow, invoiceRinggit } from '@/lib/finance/invoices';

/**
 * Kasturi's links to Bendahara's invoices. A contact is billed through one of
 * Bendahara's customers (`crm_contacts.finance_customer_id`), and an invoice
 * can belong to one deal (`crm_deal_invoices`). Both are Kasturi's own data:
 * nothing here writes to a Bendahara table.
 */

/** How many customers the "Billing customer" picker offers. */
export const BILLING_CUSTOMERS_OFFERED = 1000;
/** How many invoices one deal can have linked. */
export const MAX_DEAL_INVOICES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export const INVOICE_LINK_MESSAGES = {
  customer: 'That billing customer could not be found. Choose another.',
  invoice: 'One of those invoices could not be found. Choose again.',
  taken: 'One of those invoices is already linked to another deal.',
  tooMany: `Link at most ${MAX_DEAL_INVOICES} invoices to a deal.`,
} as const;

/** A Bendahara customer, as the contact form's picker lists it. */
export type BillingCustomerChoice = { id: string; name: string };

/** One invoice-to-deal link. */
export type DealInvoiceLink = { dealId: string; invoiceId: string };

/** What a deal's linked invoices add up to. Void and draft invoices are not billed. */
export type DealBilling = { count: number; billed: number; outstanding: number };

/** An invoice the deal form can tick. */
export type DealInvoiceChoice = {
  id: string;
  /** 'INV-0004 · Aisyah Trading · RM 1,240.00', or 'Draft · …' before posting. */
  label: string;
  customerId: string;
  /** The deal it is linked to now, if any. */
  dealId: string | null;
};

/**
 * The form's "Billing customer" value: an id, or null for "None". Returns
 * undefined when the form has no such field, so other callers of the contact
 * write (import, the assistant) leave an existing link alone.
 */
export function readBillingCustomerId(formData: FormData): string | null | undefined {
  if (!formData.has('billingCustomerId')) return undefined;
  const id = String(formData.get('billingCustomerId') ?? '').trim();
  if (!id) return null;
  if (!UUID.test(id)) throw new CrmContactFormError(INVOICE_LINK_MESSAGES.customer);
  return id;
}

/**
 * The invoices ticked on the deal form. Returns undefined when the form did
 * not show the picker (a hidden `invoiceLinks` field marks that it did), so a
 * save from anywhere else leaves the deal's links alone.
 */
export function readDealInvoiceIds(formData: FormData): string[] | undefined {
  if (!formData.has('invoiceLinks')) return undefined;
  const ids = [...new Set(formData.getAll('invoiceIds').map((value) => String(value).trim()))];
  if (ids.some((id) => !UUID.test(id))) throw new CrmContactFormError(INVOICE_LINK_MESSAGES.invoice);
  if (ids.length > MAX_DEAL_INVOICES) throw new CrmContactFormError(INVOICE_LINK_MESSAGES.tooMany);
  return ids;
}

/** Adds ringgit amounts in whole sen, so the total has no floating-point dust. */
function sum(amounts: number[]) {
  return amounts.reduce((total, amount) => total + Math.round(amount * 100), 0) / 100;
}

const BILLED: ReadonlySet<string> = new Set(['sent', 'overdue', 'paid']);

/** Each deal's linked invoices, added up in ringgit (an invoice in another currency at its rate). Deals with no link are absent. */
export function dealBilling(
  links: DealInvoiceLink[],
  invoices: Pick<InvoiceListRow, 'id' | 'total_myr' | 'balance_myr' | 'display_status'>[],
): Record<string, DealBilling> {
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice] as const));
  const rows = new Map<string, (typeof invoices)[number][]>();
  for (const link of links) {
    const invoice = byId.get(link.invoiceId);
    if (!invoice) continue;
    rows.set(link.dealId, [...(rows.get(link.dealId) ?? []), invoice]);
  }
  const result: Record<string, DealBilling> = {};
  for (const [dealId, linked] of rows) {
    const billed = linked.filter((invoice) => BILLED.has(invoice.display_status));
    result[dealId] = {
      count: linked.length,
      billed: sum(billed.map((invoice) => invoiceRinggit(invoice).total)),
      outstanding: sum(
        billed
          .filter((invoice) => invoice.display_status !== 'paid')
          .map((invoice) => Math.max(invoiceRinggit(invoice).balance, 0)),
      ),
    };
  }
  return result;
}

/** The invoices the deal form offers, newest first; void ones are left out unless already linked. Each total is in its own currency. */
export function dealInvoiceChoices(
  invoices: InvoiceListRow[],
  links: DealInvoiceLink[],
  format: (amount: number, currency: string) => string,
): DealInvoiceChoice[] {
  const dealOf = new Map(links.map((link) => [link.invoiceId, link.dealId] as const));
  return invoices
    .filter((invoice) => invoice.display_status !== 'void' || dealOf.has(invoice.id))
    .map((invoice) => ({
      id: invoice.id,
      label: `${invoice.invoice_no ?? 'Draft'} · ${invoice.customer_name} · ${format(invoice.total, invoice.currency)}`,
      customerId: invoice.customer_id,
      dealId: dealOf.get(invoice.id) ?? null,
    }));
}

/** Bendahara's active customers, by name, for the contact form's picker. */
export async function listBillingCustomers(
  client: SupabaseClient,
  orgId: string,
): Promise<BillingCustomerChoice[]> {
  const { data, error } = await client
    .from('finance_contacts')
    .select('id,name')
    .eq('org_id', orgId)
    .eq('is_customer', true)
    .eq('active', true)
    .order('name', { ascending: true })
    .limit(BILLING_CUSTOMERS_OFFERED);
  if (error) throw error;
  return (data ?? []) as BillingCustomerChoice[];
}

/** Every invoice-to-deal link in the workspace. */
export async function listDealInvoiceLinks(client: SupabaseClient, orgId: string): Promise<DealInvoiceLink[]> {
  const { data, error } = await client
    .from('crm_deal_invoices')
    .select('deal_id,invoice_id')
    .eq('org_id', orgId)
    .limit(10_000);
  if (error) throw error;
  return ((data ?? []) as { deal_id: string; invoice_id: string }[]).map((row) => ({
    dealId: row.deal_id,
    invoiceId: row.invoice_id,
  }));
}

/** Sets or clears the customer a contact is billed through. */
export async function setContactBillingCustomer(
  client: SupabaseClient,
  orgId: string,
  contactId: string,
  customerId: string | null,
): Promise<void> {
  const { data, error } = await client
    .from('crm_contacts')
    .update({ finance_customer_id: customerId, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('org_id', orgId)
    .select('id');
  // The customer was deleted meanwhile, or is not this workspace's.
  if (error?.code === FOREIGN_KEY_VIOLATION) throw new CrmContactFormError(INVOICE_LINK_MESSAGES.customer);
  if (error) throw error;
  if (!data || data.length === 0) throw new CrmContactFormError('That contact no longer exists.');
}

/**
 * Makes `invoiceIds` the invoices linked to a deal: links no longer wanted are
 * removed, new ones added. An invoice linked to another deal is refused, not
 * moved, so one deal's edit never changes another's.
 */
export async function setDealInvoices(
  client: SupabaseClient,
  orgId: string,
  dealId: string,
  invoiceIds: string[],
  userId?: string | null,
): Promise<void> {
  const { data, error } = await client
    .from('crm_deal_invoices')
    .select('invoice_id')
    .eq('org_id', orgId)
    .eq('deal_id', dealId);
  if (error) throw error;

  const current = new Set(((data ?? []) as { invoice_id: string }[]).map((row) => row.invoice_id));
  const wanted = new Set(invoiceIds);
  const removed = [...current].filter((id) => !wanted.has(id));
  const added = [...wanted].filter((id) => !current.has(id));

  if (removed.length > 0) {
    const { error: removeError } = await client
      .from('crm_deal_invoices')
      .delete()
      .eq('org_id', orgId)
      .eq('deal_id', dealId)
      .in('invoice_id', removed);
    if (removeError) throw removeError;
  }
  if (added.length > 0) {
    const { error: addError } = await client.from('crm_deal_invoices').insert(
      added.map((invoiceId) => ({
        org_id: orgId,
        deal_id: dealId,
        invoice_id: invoiceId,
        ...(userId ? { created_by: userId } : {}),
      })),
    );
    if (addError?.code === UNIQUE_VIOLATION) throw new CrmContactFormError(INVOICE_LINK_MESSAGES.taken);
    // The invoice or the deal was deleted meanwhile, or is not this workspace's.
    if (addError?.code === FOREIGN_KEY_VIOLATION) throw new CrmContactFormError(INVOICE_LINK_MESSAGES.invoice);
    if (addError) throw addError;
  }
}
