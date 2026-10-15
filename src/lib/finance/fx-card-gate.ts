import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whether this workspace deals in a currency other than ringgit, which is the only time Banking shows the
 * "Exchange rates" card: a ringgit-only workspace has no use for the rates and sees no new card.
 *
 * Stage 1 (the rates) adds neither a contact's default currency nor a quotation's currency, so no workspace can
 * deal in another currency yet and this answers false for every workspace. Stage 2 implements it: true when the
 * workspace has at least one contact whose default currency is not MYR or at least one quotation whose currency
 * is not MYR. Until then the card is built, tested and never drawn on a live screen.
 */
// The arguments are what stage 2 will read with; stage 1 answers without them.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function workspaceUsesForeignCurrency(_client: SupabaseClient, _orgId: string): Promise<boolean> {
  return false;
}
