import type { SupabaseClient } from '@supabase/supabase-js';
import { BASE_CURRENCY } from './currencies';

/**
 * Whether this workspace deals in a currency other than ringgit, which is the only time Banking shows the
 * "Exchange rates" card: a ringgit-only workspace has no use for the rates and sees no new card.
 *
 * True when the workspace has at least one contact whose default currency is not MYR or at least one quotation
 * whose currency is not MYR (a contact with no default currency counts as ringgit). Two cheap one-row reads; if
 * either cannot be answered the card is left off and the reason is logged, because this is a side card and
 * Banking must still open.
 */
export async function workspaceUsesForeignCurrency(client: SupabaseClient, orgId: string): Promise<boolean> {
  const [contacts, quotations] = await Promise.all([
    client.from('finance_contacts').select('id').eq('org_id', orgId).neq('default_currency', BASE_CURRENCY).limit(1),
    client.from('finance_quotations').select('id').eq('org_id', orgId).neq('currency', BASE_CURRENCY).limit(1),
  ]);
  const error = contacts.error ?? quotations.error;
  if (error) {
    console.error('[finance] could not tell whether the workspace uses another currency:', error);
    return false;
  }
  return (contacts.data?.length ?? 0) > 0 || (quotations.data?.length ?? 0) > 0;
}
