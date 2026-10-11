import {
  deleteInvoiceAction,
  getInvoiceAction,
  postInvoiceAction,
  recordPaymentInAction,
  recordRefundAction,
  saveAndIssueCreditNoteAction,
  saveAndPostInvoiceAction,
  saveCreditNoteAction,
  saveInvoiceAction,
  setEInvoiceAction,
  voidInvoiceAction,
} from '@/app/(app)/finance/actions';
import { type InvoiceActions, InvoicesView } from '@/components/finance/invoices-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts, listPaymentsIn } from '@/lib/finance/money';
import { listProducts } from '@/lib/finance/products';
import { listRefunds } from '@/lib/finance/refunds';
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
  creditNote: { save: saveCreditNoteAction, saveAndIssue: saveAndIssueCreditNoteAction },
  recordRefund: recordRefundAction,
};

export default async function InvoicesScreen() {
  if (!hasSupabaseEnv()) {
    return <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payments feed "Received (MTD)" and the trend for everyone. The forms offer customers, products
  // and accounts, and a row offers a refund by what credit notes and pending refunds leave of a customer's
  // credit; a viewer has no form and no menu, so none of them is read for them.
  const [rows, payments, contacts, products, accounts, creditNotes, refunds] = await Promise.all([
    listInvoices(ctx),
    listPaymentsIn(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    canEdit ? listAccounts(ctx) : [],
    canEdit ? listCreditNotes(ctx) : [],
    canEdit ? listRefunds(ctx) : [],
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
              creditNotes,
              refunds,
            }
          : undefined
      }
    />
  );
}
