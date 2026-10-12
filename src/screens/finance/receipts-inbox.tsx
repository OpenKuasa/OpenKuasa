import { ReceiptsInboxView } from '@/components/finance/receipts-inbox-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { receiptsInboxView } from '@/lib/finance/receipt-views';
import { listInboxReceipts } from '@/lib/finance/receipts';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INBOX_RECEIPTS } from './receipts-sample';

/** Every receipt in the inbox. Read-only for everyone until uploading and matching arrive. */
export default async function ReceiptsInboxScreen() {
  if (!hasSupabaseEnv()) {
    return <ReceiptsInboxView rows={SAMPLE_INBOX_RECEIPTS} view={receiptsInboxView(SAMPLE_INBOX_RECEIPTS)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listInboxReceipts(ctx);
  return <ReceiptsInboxView rows={rows} view={receiptsInboxView(rows)} />;
}
