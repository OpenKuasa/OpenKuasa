import {
  approveVoucherAction,
  deleteVoucherAction,
  recordVoucherAction,
  rejectVoucherAction,
} from '@/app/(app)/finance/actions';
import { PaymentVouchersView, type VoucherActions } from '@/components/finance/payment-vouchers-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listBills } from '@/lib/finance/bills';
import { listPaymentVouchers } from '@/lib/finance/cash-book';
import { listContacts } from '@/lib/finance/contacts';
import { listExpenseCategories } from '@/lib/finance/expenses';
import { listAccounts, listPaymentsOut } from '@/lib/finance/money';
import { listPurchaseOrders } from '@/lib/finance/purchase-orders';
import { todayUtc } from '@/lib/finance/view-helpers';
import { orderNotesByVoucher, voucherAccess } from '@/lib/finance/voucher-form';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PAYMENT_VOUCHERS } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: VoucherActions = {
  record: recordVoucherAction,
  approve: approveVoucherAction,
  reject: rejectVoucherAction,
  remove: deleteVoucherAction,
};

/**
 * Every movement of money out. Anyone who may edit can record a voucher for
 * a category and delete one that has not been paid; approving and rejecting
 * one that is waiting are an owner's or admin's (`sign-off-finance`), as the
 * database enforces. A viewer and the demo workspace read.
 */
export default async function PaymentVouchersScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentVouchersView rows={SAMPLE_PAYMENT_VOUCHERS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // The form offers accounts, contacts and expense categories; anyone without the form has none of those reads made for them.
  const rows = await listPaymentVouchers(ctx);
  const access = voucherAccess(viewer, rows);
  const [accounts, contacts, categories] = await Promise.all([
    access.readsForm ? listAccounts(ctx) : [],
    access.readsForm ? listContacts(ctx) : [],
    access.readsForm ? listExpenseCategories(ctx) : [],
  ]);
  // The purchase orders behind the bills a waiting voucher pays are read only for someone who can approve it,
  // and only when such a voucher is waiting: the same three reads Payments Out makes for its own note.
  const [payments, bills, orders] = access.readsOrders
    ? await Promise.all([listPaymentsOut(ctx), listBills(ctx), listPurchaseOrders(ctx)])
    : [[], [], []];
  return (
    <PaymentVouchersView
      rows={rows}
      today={todayUtc()}
      writer={
        access.writer
          ? {
              actions: ACTIONS,
              canDecide: access.canDecide,
              accounts,
              // Only what the form reads goes to the browser.
              contacts: contacts.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })),
              categories,
              // A closed order can still have unpaid bills; a draft, pending or cancelled one has none that matter.
              orderNotes: orderNotesByVoucher(
                payments,
                bills,
                orders.filter((o) => o.status === 'approved' || o.status === 'closed'),
              ),
            }
          : undefined
      }
    />
  );
}
