import 'server-only';
import { serviceClient } from '@/lib/supabase/service';
import { RECEIPT_BUCKET } from './receipts';

/**
 * Removes a receipt file with the service client (the bucket lets no signed-in
 * user delete). Never throws: a cancelled claim no longer points at the file,
 * so a leftover is unreachable and the cancel stands. Logs one fixed sentence
 * on failure, and never the path, which begins with a user id.
 */
export async function removeReceipt(path: string): Promise<void> {
  try {
    const { error } = await serviceClient().storage.from(RECEIPT_BUCKET).remove([path]);
    if (!error) return;
  } catch {
    // Not configured, or the call itself failed: the same outcome.
  }
  console.error('[people/receipts] a receipt file could not be removed.');
}
