import { PaymentsInView } from '@/components/finance/payments-in-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listPaymentsIn } from '@/lib/finance/money';
import { paymentsInView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

/**
 * Payments In, read-only for everyone in this stage: the view takes no
 * actions, so nothing here depends on the viewer's role. Recording and voiding
 * a payment arrive with the next stage.
 */
export default async function PaymentsInScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentsInView rows={SAMPLE_PAYMENTS_IN} view={paymentsInView(SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listPaymentsIn(ctx);
  return <PaymentsInView rows={rows} view={paymentsInView(rows, todayUtc())} />;
}
