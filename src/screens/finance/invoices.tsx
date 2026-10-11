import { InvoicesView } from '@/components/finance/invoices-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listInvoices } from '@/lib/finance/invoices';
import { listPaymentsIn } from '@/lib/finance/money';
import { invoicesView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

/**
 * Invoices, read-only for everyone in this stage: the view takes no actions,
 * so nothing here depends on the viewer's role. The forms and row actions
 * arrive with the next stage, given only to people who may edit, as on
 * Supplier Bills.
 */
export default async function InvoicesScreen() {
  if (!hasSupabaseEnv()) {
    return <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // The payments feed "Received (MTD)" and the trend; the table shows invoices only.
  const [rows, payments] = await Promise.all([listInvoices(ctx), listPaymentsIn(ctx)]);
  return <InvoicesView rows={rows} view={invoicesView(rows, payments, todayUtc())} />;
}
