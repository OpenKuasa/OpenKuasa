import type { SupabaseClient } from '@supabase/supabase-js';
import { BASE_CURRENCY } from './currencies';

/**
 * Whether this workspace deals in a currency other than ringgit, which is the only time Banking shows the
 * "Exchange rates" card: a ringgit-only workspace has no use for the rates and sees no new card.
 *
 * True when the workspace has at least one contact whose default currency is not MYR, or at least one quotation,
 * invoice, supplier bill or bank or cash account whose currency is not MYR (a contact with no default currency
 * counts as ringgit). Five cheap one-row reads; if any cannot be answered the card is left off and the reason is
 * logged, because this is a side card and Banking must still open.
 */
export async function workspaceUsesForeignCurrency(client: SupabaseClient, orgId: string): Promise<boolean> {
  const answers = await Promise.all([
    client.from('finance_contacts').select('id').eq('org_id', orgId).neq('default_currency', BASE_CURRENCY).limit(1),
    client.from('finance_quotations').select('id').eq('org_id', orgId).neq('currency', BASE_CURRENCY).limit(1),
    client.from('finance_invoices').select('id').eq('org_id', orgId).neq('currency', BASE_CURRENCY).limit(1),
    // A supplier bill in another currency (stage 4a), and a bank or cash account in one (stage 5a).
    client.from('supplier_bills').select('id').eq('org_id', orgId).neq('currency', BASE_CURRENCY).limit(1),
    client.from('finance_accounts').select('id').eq('org_id', orgId).neq('currency', BASE_CURRENCY).limit(1),
  ]);
  const error = answers.find((a) => a.error)?.error;
  if (error) {
    console.error('[finance] could not tell whether the workspace uses another currency:', error);
    return false;
  }
  return answers.some((a) => (a.data?.length ?? 0) > 0);
}
