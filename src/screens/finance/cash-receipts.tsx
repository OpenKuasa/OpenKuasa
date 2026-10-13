import {
  deleteCashReceiptAction,
  postCashReceiptAction,
  saveAndPostCashReceiptAction,
  saveCashReceiptAction,
  voidCashReceiptAction,
} from '@/app/(app)/finance/actions';
import { type CashReceiptActions, CashReceiptsView } from '@/components/finance/cash-receipts-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCashReceipts } from '@/lib/finance/cash-book';
import { receiptInvoicesForForm, receiptPaymentsForForm } from '@/lib/finance/cash-receipt-form';
import { listIncomeCategories } from '@/lib/finance/cash-receipts';
import { listContacts } from '@/lib/finance/contacts';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CASH_RECEIPTS } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: CashReceiptActions = {
  save: saveCashReceiptAction,
  saveAndPost: saveAndPostCashReceiptAction,
  post: postCashReceiptAction,
  voidReceipt: voidCashReceiptAction,
  remove: deleteCashReceiptAction,
};

/**
 * Every movement of money in. Anyone who may edit can save, change and delete
 * a draft receipt; posting one and voiding a posted receipt are an owner's or
 * admin's (`sign-off-finance`), as the database enforces. A viewer and the
 * demo workspace read.
 */
export default async function CashReceiptsScreen() {
  if (!hasSupabaseEnv()) {
    return <CashReceiptsView rows={SAMPLE_CASH_RECEIPTS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The form offers open invoices (worked out from the invoices and the payments against them), accounts,
  // contacts and income categories; anyone without the form has none of those reads made for them.
  const [rows, invoices, payments, accounts, contacts, categories] = await Promise.all([
    listCashReceipts(ctx),
    canEdit ? listInvoices(ctx) : [],
    canEdit ? listPaymentsIn(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
    canEdit ? listContacts(ctx) : [],
    canEdit ? listIncomeCategories(ctx) : [],
  ]);
  return (
    <CashReceiptsView
      rows={rows}
      today={todayUtc()}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              canSignOff: can(viewer.role, 'sign-off-finance'),
              // Only what the form reads goes to the browser.
              invoices: receiptInvoicesForForm(invoices),
              payments: receiptPaymentsForForm(payments),
              accounts,
              contacts: contacts.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })),
              categories,
            }
          : undefined
      }
    />
  );
}
