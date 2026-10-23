import {
  deleteInvoiceAction,
  fxSstRateForAction,
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
import { type InvoiceActions, InvoicesView, type InvoicesWriter } from '@/components/finance/invoices-view';
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
import { noteCountsFor } from '@/lib/finance/agent/notes';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: InvoiceActions = {
  save: saveInvoiceAction,
  saveAndPost: saveAndPostInvoiceAction,
  fxRate: fxSstRateForAction,
  post: postInvoiceAction,
  voidInvoice: voidInvoiceAction,
  remove: deleteInvoiceAction,
  get: getInvoiceAction,
  recordPayment: recordPaymentInAction,
  setEInvoice: setEInvoiceAction,
  creditNote: { save: saveCreditNoteAction, saveAndIssue: saveAndIssueCreditNoteAction },
  recordRefund: recordRefundAction,
};

/**
 * The credit notes and the refunds, which only decide whether a row offers "Refund" and feed its card.
 * Null when either cannot be read: the invoices themselves were read, so the page shows without that
 * choice. Empty lists would not do: the menu would offer a refund that no pending refund is counted against.
 * "Credit note" is decided from the invoice rows and stays.
 */
async function readFollowOn(ctx: Parameters<typeof listCreditNotes>[0]): Promise<InvoicesWriter['followOn']> {
  try {
    const [creditNotes, refunds] = await Promise.all([listCreditNotes(ctx), listRefunds(ctx)]);
    return { creditNotes, refunds };
  } catch (error) {
    console.error('[finance] InvoicesScreen: credit notes or refunds could not be read:', error);
    return null;
  }
}

export default async function InvoicesScreen() {
  if (!hasSupabaseEnv()) {
    return <InvoicesView rows={SAMPLE_INVOICES} view={invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The payments feed "Received (MTD)" and the trend for everyone. The forms offer customers, products
  // and accounts, and a row offers a refund by what credit notes and pending refunds leave of a customer's
  // credit; a viewer has no form and no menu, so none of them is read for them. A failure of the last
  // read costs a writer the "Refund" choice it decides, not the page; any other failure is the page's.
  const [rows, payments, contacts, products, accounts, followOn] = await Promise.all([
    listInvoices(ctx),
    listPaymentsIn(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    // Stage 5b: every active account; each form offers ringgit ones and those in its documents' currency.
    canEdit ? listAccounts(ctx) : [],
    canEdit ? readFollowOn(ctx) : null,
  ]);
  // The agent's notes on the documents just loaded (only those ids). A failed read is logged and shows no marker.
  const agentNotes = (await noteCountsFor(ctx, 'finance_invoice', rows.map((r) => r.id))) ?? undefined;
  return (
    <InvoicesView
      rows={rows}
      agentNotes={agentNotes}
      view={invoicesView(rows, payments, todayUtc())}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              customers: contacts.filter((c) => c.is_customer && c.active),
              products: products.filter((p) => p.active),
              accounts,
              payments,
              followOn,
            }
          : undefined
      }
    />
  );
}
