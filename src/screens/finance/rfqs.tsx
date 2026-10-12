import {
  closeRfqAction,
  convertRfqAction,
  deleteRfqAction,
  getRfqAction,
  getSentRfqAction,
  quoteRfqAction,
  saveAndSendRfqAction,
  saveRfqAction,
  sendRfqAction,
} from '@/app/(app)/finance/actions';
import { type RfqActions, RfqsView } from '@/components/finance/rfqs-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listProducts } from '@/lib/finance/products';
import { listRfqs } from '@/lib/finance/rfqs';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_RFQS } from './purchases-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: RfqActions = {
  save: saveRfqAction,
  saveAndPost: saveAndSendRfqAction,
  send: sendRfqAction,
  quote: quoteRfqAction,
  close: closeRfqAction,
  convert: convertRfqAction,
  remove: deleteRfqAction,
  get: getRfqAction,
  getSent: getSentRfqAction,
};

export default async function RfqsScreen() {
  if (!hasSupabaseEnv()) {
    return <RfqsView rows={SAMPLE_RFQS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The form offers suppliers and products; a viewer has no form, so neither is read for them.
  const [rows, contacts, products] = await Promise.all([
    listRfqs(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
  ]);
  return (
    <RfqsView
      rows={rows}
      today={todayUtc()}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              suppliers: contacts.filter((c) => c.is_supplier && c.active),
              products: products.filter((p) => p.active),
            }
          : undefined
      }
    />
  );
}
