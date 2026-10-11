import { recordPaymentInAction, voidPaymentInAction } from '@/app/(app)/finance/actions';
import { type PaymentInActions, PaymentsInView } from '@/components/finance/payments-in-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { paymentsInView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: PaymentInActions = {
  record: recordPaymentInAction,
  voidPayment: voidPaymentInAction,
};

export default async function PaymentsInScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentsInView rows={SAMPLE_PAYMENTS_IN} view={paymentsInView(SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payment form offers open invoices and accounts; a viewer has no form, so neither is read for them.
  const [rows, invoices, accounts] = await Promise.all([
    listPaymentsIn(ctx),
    canEdit ? listInvoices(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <PaymentsInView
      rows={rows}
      view={paymentsInView(rows, todayUtc())}
      writer={canEdit ? { actions: ACTIONS, invoices, accounts } : undefined}
    />
  );
}
