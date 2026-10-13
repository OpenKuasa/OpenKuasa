'use client';

import { discardReceiptAction } from '@/app/(app)/people/pay-actions';
import type { CapResult } from '@/lib/people/capabilities';
import { uploadReceipt } from '@/lib/people/receipts';
import { createClient } from '@/lib/supabase/client';

const UPLOAD_FAILED = 'That file could not be uploaded.';

/** Uploads into the signed-in user's own receipts folder with the browser's client. */
export async function uploadOwnReceipt(file: File): Promise<CapResult<{ path: string }>> {
  try {
    const client = createClient();
    const { data } = await client.auth.getUser();
    if (!data.user) return { ok: false, error: UPLOAD_FAILED };
    return await uploadReceipt(client, data.user.id, file, file.type, file.name);
  } catch {
    return { ok: false, error: UPLOAD_FAILED };
  }
}

/**
 * Asks the server to remove an upload no claim carries. Best effort and silent: the server decides whether the file
 * may go, and a browser closed before this runs leaves its upload behind, which is accepted.
 */
export function discardUploadedReceipt(path: string): void {
  void discardReceiptAction({ path }).catch(() => {});
}
