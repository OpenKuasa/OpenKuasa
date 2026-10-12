import { PaymentVouchersView } from '@/components/finance/payment-vouchers-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listPaymentVouchers } from '@/lib/finance/cash-book';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENT_VOUCHERS } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

/** Every movement of money out. Read-only for everyone until the voucher form and approval arrive. */
export default async function PaymentVouchersScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentVouchersView rows={SAMPLE_PAYMENT_VOUCHERS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listPaymentVouchers(ctx);
  return <PaymentVouchersView rows={rows} today={todayUtc()} />;
}
