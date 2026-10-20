import {
  deleteRefundAction,
  fxSstRateForAction,
  markRefundPaidAction,
  recordRefundAction,
  voidRefundAction,
} from '@/app/(app)/finance/actions';
import { type RefundActions, RefundsView } from '@/components/finance/refunds-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts } from '@/lib/finance/money';
import { listRefunds } from '@/lib/finance/refunds';
import { refundsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_REFUNDS, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: RefundActions = {
  record: recordRefundAction,
  markPaid: markRefundPaidAction,
  voidRefund: voidRefundAction,
  remove: deleteRefundAction,
  fxRate: fxSstRateForAction,
};

export default async function RefundsScreen() {
  if (!hasSupabaseEnv()) {
    return <RefundsView rows={SAMPLE_REFUNDS} view={refundsView(SAMPLE_REFUNDS, SAMPLE_INVOICES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The invoices feed the "In credit" card for everyone. The refund form also offers issued credit notes and
  // accounts; a viewer has no form, so neither is read for them.
  const [rows, invoices, creditNotes, accounts] = await Promise.all([
    listRefunds(ctx),
    listInvoices(ctx),
    canEdit ? listCreditNotes(ctx) : [],
    // Stage 5b: every active account; each form offers ringgit ones and those in its documents' currency.
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <RefundsView
      rows={rows}
      view={refundsView(rows, invoices, todayUtc())}
      writer={canEdit ? { actions: ACTIONS, invoices, creditNotes, accounts } : undefined}
    />
  );
}
