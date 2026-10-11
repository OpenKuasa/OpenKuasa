import {
  deleteInvoiceAction,
  getInvoiceAction,
  postInvoiceAction,
  recordPaymentInAction,
  saveAndPostInvoiceAction,
  saveInvoiceAction,
  setEInvoiceAction,
  voidInvoiceAction,
} from '@/app/(app)/finance/actions';
import { type InvoiceActions, InvoicesView } from '@/components/finance/invoices-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { listProducts } from '@/lib/finance/products';
import { invoicesView } from '@/lib/finance/sales-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: InvoiceActions = {
  save: saveInvoiceAction,
  saveAndPost: saveAndPostInvoiceAction,
  post: postInvoiceAction,
  voidInvoice: voidInvoiceAction,
  remove: deleteInvoiceAction,
  get: getInvoiceAction,
  recordPayment: recordPaymentInAction,
  setEInvoice: setEInvoiceAction,
};

export default async function InvoicesScreen() {
  if (!hasSupabaseEnv()) {
    return <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payments feed "Received (MTD)" and the trend for everyone. The forms offer customers, products
  // and accounts; a viewer has no form, so none of them is read for them.
  const [rows, payments, contacts, products, accounts] = await Promise.all([
    listInvoices(ctx),
    listPaymentsIn(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <InvoicesView
      rows={rows}
      view={invoicesView(rows, payments, todayUtc())}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              customers: contacts.filter((c) => c.is_customer && c.active),
              products: products.filter((p) => p.active),
              accounts,
              payments,
            }
          : undefined
      }
    />
  );
}
