import { QuotationsView } from '@/components/finance/quotations-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listQuotations } from '@/lib/finance/quotations';
import { quotationsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_QUOTATIONS, SAMPLE_TODAY } from './sales-sample';

/**
 * Quotations, read-only for everyone in this stage: the view takes no
 * actions, so nothing here depends on the viewer's role. The form and the row
 * actions arrive with the next stage, given only to people who may edit, as
 * on Invoices.
 */
export default async function QuotationsScreen() {
  if (!hasSupabaseEnv()) {
    return <QuotationsView rows={SAMPLE_QUOTATIONS} view={quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listQuotations(ctx);
  return <QuotationsView rows={rows} view={quotationsView(rows, todayUtc())} />;
}
