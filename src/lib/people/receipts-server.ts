import 'server-only';
import { serviceClient } from '@/lib/supabase/service';
import { RECEIPT_BUCKET, RECEIPT_TYPES } from './receipts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Exactly what `receiptPath` makes: `<user uuid>/<uuid>.<known extension>`, nothing else. */
const RECEIPT_PATH = new RegExp(`^${UUID}/${UUID}\\.(${[...new Set(Object.values(RECEIPT_TYPES))].join('|')})$`, 'i');

/**
 * Removes a receipt file with the service client (the bucket lets no signed-in
 * user delete). Never throws: a cancelled claim no longer points at the file,
 * so a leftover is unreachable and the cancel stands. Logs one fixed sentence
 * on failure, and never the path, which begins with a user id.
 */
export async function removeReceipt(path: string): Promise<void> {
  // The delete runs with the service role: only a path of the exact shape we make is ever passed to it.
  if (!RECEIPT_PATH.test(path)) {
    console.error('[people/receipts] a receipt file could not be removed.');
    return;
  }
  try {
    const { error } = await serviceClient().storage.from(RECEIPT_BUCKET).remove([path]);
    if (!error) return;
  } catch {
    // Not configured, or the call itself failed: the same outcome.
  }
  console.error('[people/receipts] a receipt file could not be removed.');
}
