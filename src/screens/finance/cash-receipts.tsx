import { CashReceiptsView } from '@/components/finance/cash-receipts-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCashReceipts } from '@/lib/finance/cash-book';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CASH_RECEIPTS } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Every movement of money in. Read-only for everyone until the receipt form arrives. */
export default async function CashReceiptsScreen() {
  if (!hasSupabaseEnv()) {
    return <CashReceiptsView rows={SAMPLE_CASH_RECEIPTS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listCashReceipts(ctx);
  return <CashReceiptsView rows={rows} today={todayUtc()} />;
}
