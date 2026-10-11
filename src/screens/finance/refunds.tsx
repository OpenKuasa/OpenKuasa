import { RefundsView } from '@/components/finance/refunds-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listInvoices } from '@/lib/finance/invoices';
import { listRefunds } from '@/lib/finance/refunds';
import { refundsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_REFUNDS, SAMPLE_TODAY } from './sales-sample';

/**
 * Refunds, read-only for everyone in this stage: the view takes no actions,
 * so nothing here depends on the viewer's role. The form and the row actions
 * arrive with the next stage.
 */
export default async function RefundsScreen() {
  if (!hasSupabaseEnv()) {
    return <RefundsView rows={SAMPLE_REFUNDS} view={refundsView(SAMPLE_REFUNDS, SAMPLE_INVOICES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // The invoices feed the "In credit" card; the table shows refunds only.
  const [rows, invoices] = await Promise.all([listRefunds(ctx), listInvoices(ctx)]);
  return <RefundsView rows={rows} view={refundsView(rows, invoices, todayUtc())} />;
}
