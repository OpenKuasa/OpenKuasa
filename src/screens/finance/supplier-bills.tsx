import {
  deleteBillAction,
  fxSstRateForAction,
  getBillAction,
  postBillAction,
  recordPaymentOutAction,
  saveAndPostBillAction,
  saveBillAction,
  voidBillAction,
} from '@/app/(app)/finance/actions';
import { receiptLinkAction } from '@/app/(app)/finance/receipt-inbox-actions';
import { type BillActions, BillsView } from '@/components/finance/bills-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { type BillDisplayStatus, type BillListRow, listBills, listExpenseCategories } from '@/lib/finance/bills';
import { listContacts } from '@/lib/finance/contacts';
import { purchasesCategoryId } from '@/lib/finance/ledger';
import { type PaymentOutRow, listAccounts, listPaymentsOut } from '@/lib/finance/money';
import { heldByBill } from '@/lib/finance/payment-form';
import { listPurchaseOrders } from '@/lib/finance/purchase-orders';
import { listProducts } from '@/lib/finance/products';
import { attachedReceiptsOrNone, listAttachedReceipts, receiptsByDocument } from '@/lib/finance/receipt-match';
import { billsView, todayUtc } from '@/lib/finance/purchase-views';
import { createClient } from '@/lib/supabase/server';

/* ---- sample data (Rimba Ventures Sdn Bhd), shown when there is no database ---- */

/** The sample is a fixed month, so its figures do not drain away as the calendar moves on. */
const SAMPLE_TODAY = '2026-10-10';

const sample = (
  n: number,
  bill_date: string,
  supplier_name: string,
  due_date: string,
  total: number,
  display_status: BillDisplayStatus,
): BillListRow => ({
  id: `sample-${n}`,
  bill_no: display_status === 'draft' ? null : `BILL-${String(n).padStart(4, '0')}`,
  supplier_id: supplier_name,
  supplier_name,
  bill_date,
  due_date,
  total,
  paid: display_status === 'paid' ? total : 0,
  balance: display_status === 'paid' ? 0 : total,
  display_status,
  purchase_order_id: null,
  purchase_order_no: null,
  category_id: 'sample-purchases',
  category_name: 'Purchases',
  // In ringgit, as every sample bill is.
  currency: 'MYR',
  fx_rate: 1,
  fx_rate_text: '1.0000000000',
  fx_rate_source: null,
  fx_rate_date: null,
  fx_rate_provider: null,
  fx_rate_reference: null,
  subtotal_myr: total,
  sst_myr: 0,
  total_myr: total,
  balance_myr: display_status === 'paid' ? 0 : total,
});

const SAMPLE_BILLS: BillListRow[] = [
  sample(232, '2026-10-08', 'Nusantara Logistics', '2026-10-13', 2600, 'pending'),
  sample(233, '2026-10-07', 'Kedai Kertas Ah Seng', '2026-11-06', 780, 'draft'),
  sample(231, '2026-10-05', 'Lim Hardware Sdn Bhd', '2026-11-04', 3200, 'pending'),
  sample(230, '2026-09-30', 'Printhub Enterprise', '2026-10-30', 1450, 'paid'),
  sample(229, '2026-09-22', 'Suria Utilities Sdn Bhd', '2026-10-06', 1800, 'overdue'),
  sample(228, '2026-09-18', 'Syarikat Maju Jaya', '2026-10-18', 4300, 'pending'),
  sample(227, '2026-09-10', 'Unifi Business (TM)', '2026-10-10', 299, 'paid'),
];

const samplePayment = (n: number, txn_date: string, bill: BillListRow): PaymentOutRow => ({
  allocation_id: `sample-payment-${n}`,
  transaction_id: `sample-payment-${n}`,
  number: `PV-${String(n).padStart(4, '0')}`,
  txn_date,
  method: 'bank_transfer',
  amount: bill.total,
  transaction_amount: bill.total,
  status: 'posted',
  reference: null,
  account_id: 'bank',
  account_name: 'Main Bank',
  bill_id: bill.id,
  bill_no: bill.bill_no,
  supplier_name: bill.supplier_name,
});

const SAMPLE_PAYMENTS: PaymentOutRow[] = [
  samplePayment(118, '2026-10-06', SAMPLE_BILLS[3]),
  samplePayment(117, '2026-10-04', SAMPLE_BILLS[6]),
];

const ACTIONS: BillActions = {
  save: saveBillAction,
  saveAndPost: saveAndPostBillAction,
  post: postBillAction,
  voidBill: voidBillAction,
  remove: deleteBillAction,
  get: getBillAction,
  recordPayment: recordPaymentOutAction,
  // The bill form's rate: the SST rule's (Bank Negara Malaysia's 5 pm selling rate), as invoices are offered.
  fxRate: fxSstRateForAction,
};

export default async function SupplierBillsScreen() {
  if (!hasSupabaseEnv()) {
    return (
      <BillsView
        rows={SAMPLE_BILLS}
        view={billsView(SAMPLE_BILLS, SAMPLE_PAYMENTS, SAMPLE_TODAY)}
        held={heldByBill(SAMPLE_PAYMENTS)}
      />
    );
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The forms offer suppliers, products and accounts; a viewer has no form, so none of them is read for them.
  // The receipts tied to a bill show in its row, for everyone who can see it.
  const [rows, payments, attached, contacts, products, accounts, orders, categories, defaultCategoryId] = await Promise.all([
    listBills(ctx),
    listPaymentsOut(ctx),
    // Without the paperclips the page still loads: a failed read is logged and shows none.
    attachedReceiptsOrNone(() => listAttachedReceipts(ctx)),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    // Stage 5b: every active account; each form offers ringgit ones and those in its documents' currency.
    canEdit ? listAccounts(ctx) : [],
    canEdit ? listPurchaseOrders(ctx) : [],
    canEdit ? listExpenseCategories(ctx) : [],
    // The ledger account behind purchases says which category a new bill starts in.
    canEdit ? purchasesCategoryId(ctx) : null,
  ]);
  // The picker offers approved orders, and keeps the order a draft is already linked to even once it is closed.
  const linked = new Set(rows.flatMap((b) => (b.display_status === 'draft' && b.purchase_order_id ? [b.purchase_order_id] : [])));
  return (
    <BillsView
      rows={rows}
      view={billsView(rows, payments, todayUtc())}
      // Worked out here for everyone: a viewer has no payment rows in the browser, but still sees what is scheduled.
      held={heldByBill(payments)}
      receipts={receiptsByDocument(attached)}
      receiptLinkOf={receiptLinkAction}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              suppliers: contacts.filter((c) => c.is_supplier && c.active),
              products: products.filter((p) => p.active),
              orders: orders
                .filter((o) => o.status === 'approved' || linked.has(o.id))
                .map(({ id, po_no, supplier_id, status, total, billed_total, received_total, currency }) => ({
                  id,
                  po_no,
                  supplier_id,
                  status,
                  total,
                  billed_total,
                  received_total,
                  currency,
                })),
              categories,
              defaultCategoryId: defaultCategoryId ?? '',
              accounts,
              payments,
            }
          : undefined
      }
    />
  );
}
