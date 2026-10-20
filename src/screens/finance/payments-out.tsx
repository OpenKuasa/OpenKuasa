import {
  deleteScheduledPaymentAction,
  fxSstRateForAction,
  markPaymentPaidAction,
  recordPaymentOutAction,
  voidPaymentAction,
} from '@/app/(app)/finance/actions';
import { type PaymentActions, PaymentsView } from '@/components/finance/payments-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listBills } from '@/lib/finance/bills';
import { type PaymentMethod, type PaymentOutRow, listAccounts, listPaymentsOut } from '@/lib/finance/money';
import { listPurchaseOrders } from '@/lib/finance/purchase-orders';
import { paymentsView, todayUtc } from '@/lib/finance/purchase-views';
import { createClient } from '@/lib/supabase/server';

/* ---- sample data (Rimba Ventures Sdn Bhd), shown when there is no database ---- */

/** The sample is a fixed month, so its figures do not drain away as the calendar moves on. */
const SAMPLE_TODAY = '2026-10-10';

const sample = (
  n: number,
  txn_date: string,
  supplier_name: string,
  bill_no: string,
  method: PaymentMethod,
  amount: number,
  status: 'posted' | 'scheduled' = 'posted',
): PaymentOutRow => ({
  allocation_id: `sample-${n}`,
  transaction_id: `sample-${n}`,
  number: status === 'posted' ? `PV-${String(n).padStart(4, '0')}` : null,
  txn_date,
  method,
  amount,
  transaction_amount: amount,
  status,
  reference: null,
  account_id: method === 'cash' ? 'cash' : 'bank',
  account_name: method === 'cash' ? 'Cash in hand' : 'Main Bank',
  bill_id: `sample-bill-${n}`,
  bill_no,
  supplier_name,
});

/** Earlier months, so the trend has a shape: [month, paid electronically, paid in cash]. */
const SAMPLE_HISTORY: [string, number, number][] = [
  ['2026-03', 7200, 2100],
  ['2026-04', 8000, 1800],
  ['2026-05', 8600, 2400],
  ['2026-06', 9100, 2000],
  ['2026-07', 9800, 1600],
  ['2026-08', 10200, 2100],
  ['2026-09', 6200, 1900],
];

const SAMPLE_PAYMENTS: PaymentOutRow[] = [
  sample(121, '2026-10-12', 'Syarikat Maju Jaya', 'BILL-0228', 'bank_transfer', 4300, 'scheduled'),
  sample(120, '2026-10-10', 'Suria Utilities Sdn Bhd', 'BILL-0229', 'bank_transfer', 1800, 'scheduled'),
  sample(119, '2026-10-07', 'Nusantara Logistics', 'BILL-0225', 'fpx', 1180),
  sample(118, '2026-10-06', 'Printhub Enterprise', 'BILL-0230', 'bank_transfer', 1450),
  sample(117, '2026-10-04', 'Unifi Business (TM)', 'BILL-0227', 'duitnow', 299),
  sample(116, '2026-10-02', 'Kedai Kertas Ah Seng', 'BILL-0224', 'cash', 1650),
  sample(115, '2026-09-28', 'Lim Hardware Sdn Bhd', 'BILL-0221', 'cheque', 4200),
  ...SAMPLE_HISTORY.flatMap(([month, electronic, cash], i) => [
    sample(100 - i * 2, `${month}-15`, 'Lim Hardware Sdn Bhd', `BILL-${String(200 - i * 2).padStart(4, '0')}`, 'bank_transfer', electronic),
    sample(99 - i * 2, `${month}-20`, 'Kedai Kertas Ah Seng', `BILL-${String(199 - i * 2).padStart(4, '0')}`, 'cash', cash),
  ]),
].sort((x, y) => y.txn_date.localeCompare(x.txn_date));

const ACTIONS: PaymentActions = {
  record: recordPaymentOutAction,
  markPaid: markPaymentPaidAction,
  voidPayment: voidPaymentAction,
  remove: deleteScheduledPaymentAction,
  fxRate: fxSstRateForAction,
};

export default async function PaymentsOutScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentsView rows={SAMPLE_PAYMENTS} view={paymentsView(SAMPLE_PAYMENTS, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payment form offers open bills and accounts; a viewer has no form, so neither is read for them.
  // The purchase orders are read for the same people, to say when a bill being paid is over its order.
  const [rows, bills, accounts, orders] = await Promise.all([
    listPaymentsOut(ctx),
    canEdit ? listBills(ctx) : [],
    // Stage 5b: every active account; each form offers ringgit ones and those in its documents' currency.
    canEdit ? listAccounts(ctx) : [],
    canEdit ? listPurchaseOrders(ctx) : [],
  ]);
  return (
    <PaymentsView
      rows={rows}
      view={paymentsView(rows, todayUtc())}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              bills,
              accounts,
              // A closed order can still have unpaid bills; a draft, pending or cancelled one has none that matter.
              orders: orders.filter((o) => o.status === 'approved' || o.status === 'closed'),
            }
          : undefined
      }
    />
  );
}
