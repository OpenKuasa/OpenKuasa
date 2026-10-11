import { CreditNotesView } from '@/components/finance/credit-notes-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { creditNotesView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CREDIT_NOTES, SAMPLE_TODAY } from './sales-sample';

/**
 * Credit Notes, read-only for everyone in this stage: the view takes no
 * actions, so nothing here depends on the viewer's role. The form and the row
 * actions arrive with the next stage.
 */
export default async function CreditNotesScreen() {
  if (!hasSupabaseEnv()) {
    return <CreditNotesView rows={SAMPLE_CREDIT_NOTES} view={creditNotesView(SAMPLE_CREDIT_NOTES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listCreditNotes(ctx);
  return <CreditNotesView rows={rows} view={creditNotesView(rows, todayUtc())} />;
}
