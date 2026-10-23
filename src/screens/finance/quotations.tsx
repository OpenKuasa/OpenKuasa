import {
  acceptQuotationAction,
  convertQuotationAction,
  declineQuotationAction,
  deleteQuotationAction,
  fxSstRateForAction,
  getQuotationAction,
  saveAndSendQuotationAction,
  saveQuotationAction,
  sendQuotationAction,
} from '@/app/(app)/finance/actions';
import { type QuotationActions, QuotationsView } from '@/components/finance/quotations-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listProducts } from '@/lib/finance/products';
import { listQuotations } from '@/lib/finance/quotations';
import { quotationsView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { noteCountsFor } from '@/lib/finance/agent/notes';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_QUOTATIONS, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: QuotationActions = {
  save: saveQuotationAction,
  saveAndPost: saveAndSendQuotationAction,
  send: sendQuotationAction,
  accept: acceptQuotationAction,
  decline: declineQuotationAction,
  remove: deleteQuotationAction,
  get: getQuotationAction,
  convert: convertQuotationAction,
  fxRate: fxSstRateForAction,
};

export default async function QuotationsScreen() {
  if (!hasSupabaseEnv()) {
    return <QuotationsView rows={SAMPLE_QUOTATIONS} view={quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The form offers customers and products; a viewer has no form, so neither is read for them.
  const [rows, contacts, products] = await Promise.all([
    listQuotations(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
  ]);
  // The agent's notes on the documents just loaded (only those ids). A failed read is logged and shows no marker.
  const agentNotes = (await noteCountsFor(ctx, 'finance_quotation', rows.map((r) => r.id))) ?? undefined;
  return (
    <QuotationsView
      rows={rows}
      agentNotes={agentNotes}
      view={quotationsView(rows, todayUtc())}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              customers: contacts.filter((c) => c.is_customer && c.active),
              products: products.filter((p) => p.active),
            }
          : undefined
      }
    />
  );
}
