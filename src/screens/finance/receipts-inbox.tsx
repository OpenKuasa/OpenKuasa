import {
  deleteReceiptAction,
  receiptLinkAction,
  registerReceiptAction,
  reviewReceiptAction,
} from '@/app/(app)/finance/receipt-inbox-actions';
import { type ReceiptInboxActions, ReceiptsInboxView } from '@/components/finance/receipts-inbox-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { receiptsInboxView } from '@/lib/finance/receipt-views';
import { listInboxReceipts } from '@/lib/finance/receipts';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INBOX_RECEIPTS } from './receipts-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: ReceiptInboxActions = {
  register: registerReceiptAction,
  review: reviewReceiptAction,
  remove: deleteReceiptAction,
};

/**
 * Every receipt in the inbox. Anyone who may edit adds receipts, reviews them
 * and deletes one that is tied to nothing; the bucket and the database decide
 * the same again. Anyone who can see a receipt can download its file. A
 * viewer and the demo workspace read: the demo's guests are anonymous
 * accounts, which the bucket refuses, so they get no upload area and are told
 * why. A session that still owes a second factor never gets this far
 * (`getViewer` sends it to verify first).
 */
export default async function ReceiptsInboxScreen() {
  if (!hasSupabaseEnv()) {
    return (
      <ReceiptsInboxView
        rows={SAMPLE_INBOX_RECEIPTS}
        view={receiptsInboxView(SAMPLE_INBOX_RECEIPTS)}
        today={SAMPLE_TODAY}
        followClock={false}
      />
    );
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listInboxReceipts(ctx);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  return (
    <ReceiptsInboxView
      rows={rows}
      view={receiptsInboxView(rows)}
      today={todayUtc()}
      linkOf={receiptLinkAction}
      writer={canEdit ? { orgId: viewer.orgId, actions: ACTIONS } : undefined}
      demo={viewer.isDemo}
    />
  );
}
