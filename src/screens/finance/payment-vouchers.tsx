import {
  approveVoucherAction,
  deleteVoucherAction,
  fxSstRateForAction,
  markVoucherPaidAction,
  recordVoucherAction,
  rejectVoucherAction,
  saveVoucherAction,
  submitVoucherAction,
  voidVoucherAction,
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
  save: saveVoucherAction,
  submit: submitVoucherAction,
  approve: approveVoucherAction,
  reject: rejectVoucherAction,
  markPaid: markVoucherPaidAction,
  remove: deleteVoucherAction,
  voidVoucher: voidVoucherAction,
  fxRate: fxSstRateForAction,
};

/**
 * Every movement of money out. Anyone who may edit can record a voucher for
 * a category, save one for a category or for a supplier's bills as a draft,
 * send a draft for approval, and delete one that has not been paid; approving and rejecting
 * one that is waiting, recording one as paid, marking one paid and voiding a
 * paid one are an owner's or admin's (`sign-off-finance`), as the
 * database enforces. A viewer and the demo workspace read.
 */
export default async function PaymentVouchersScreen() {
  if (!hasSupabaseEnv()) {
    return <PaymentVouchersView rows={SAMPLE_PAYMENT_VOUCHERS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listPaymentVouchers(ctx);
  const access = voucherAccess(viewer, rows);
  // The form offers accounts, contacts, expense categories and the bills that can still be paid, with the advice
  // about their purchase orders: the same three reads Payments Out makes for its own form. Anyone without the
  // form has none of those reads made for them.
  const [accounts, contacts, categories, payments, bills, allOrders] = await Promise.all([
    // Stage 5b: every active account; the form offers one in another currency for a category voucher paid now.
    access.readsForm ? listAccounts(ctx) : [],
    access.readsForm ? listContacts(ctx) : [],
    access.readsForm ? listExpenseCategories(ctx) : [],
    access.readsForm ? listPaymentsOut(ctx) : [],
    access.readsForm ? listBills(ctx) : [],
    access.readsForm ? listPurchaseOrders(ctx) : [],
  ]);
  // A closed order can still have unpaid bills; a draft, pending or cancelled one has none that matter.
  const orders = allOrders.filter((o) => o.status === 'approved' || o.status === 'closed');
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
              bills,
              payments,
              orders,
              // Worked out only for someone who can approve, and only when a voucher for bills waits.
              orderNotes: access.readsOrders ? orderNotesByVoucher(payments, bills, orders) : {},
            }
          : undefined
      }
    />
  );
}
