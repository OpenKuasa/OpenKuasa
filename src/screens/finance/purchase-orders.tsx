import {
  billFromPurchaseOrderAction,
  cancelPurchaseOrderAction,
  closePurchaseOrderAction,
  decidePurchaseOrderAction,
  deletePurchaseOrderAction,
  fxSstRateForAction,
  getApprovedPurchaseOrderAction,
  getPendingPurchaseOrderAction,
  getPrintablePurchaseOrderAction,
  getPurchaseOrderAction,
  receivePurchaseOrderAction,
  saveAndSubmitPurchaseOrderAction,
  savePurchaseOrderAction,
  submitPurchaseOrderAction,
  withdrawPurchaseOrderAction,
} from '@/app/(app)/finance/actions';
import { type PurchaseOrderActions, PurchaseOrdersView } from '@/components/finance/purchase-orders-view';
import { LetterheadProvider } from '@/components/people/letter-head';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { listProducts } from '@/lib/finance/products';
import { listPurchaseOrders } from '@/lib/finance/purchase-orders';
import { getLetterhead } from '@/lib/people/letterhead-data';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_PURCHASE_ORDERS } from './purchases-sample';

const ACTIONS: PurchaseOrderActions = {
  save: savePurchaseOrderAction,
  saveAndPost: saveAndSubmitPurchaseOrderAction,
  fxRate: fxSstRateForAction,
  submit: submitPurchaseOrderAction,
  decide: decidePurchaseOrderAction,
  withdraw: withdrawPurchaseOrderAction,
  receive: receivePurchaseOrderAction,
  close: closePurchaseOrderAction,
  cancel: cancelPurchaseOrderAction,
  remove: deletePurchaseOrderAction,
  billFrom: billFromPurchaseOrderAction,
  get: getPurchaseOrderAction,
  getApproved: getApprovedPurchaseOrderAction,
  getPending: getPendingPurchaseOrderAction,
  getPrintable: getPrintablePurchaseOrderAction,
};

export default async function PurchaseOrdersScreen() {
  if (!hasSupabaseEnv()) {
    return <PurchaseOrdersView rows={SAMPLE_PURCHASE_ORDERS} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The form offers suppliers and products, and Print the letterhead; a viewer has none of them, so none is read for them.
  const [rows, contacts, products, letterhead] = await Promise.all([
    listPurchaseOrders(ctx),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listProducts(ctx) : [],
    canEdit ? getLetterhead({ ...ctx, isDemo: viewer.isDemo }) : null,
  ]);
  return (
    <LetterheadProvider head={letterhead} workspaceName={viewer.orgName}>
      <PurchaseOrdersView
        rows={rows}
        writer={
          canEdit
            ? {
                viewer: {
                  userId: viewer.userId,
                  canSignOff: can(viewer.role, 'sign-off-finance'),
                  isOwner: viewer.role === 'owner',
                },
                actions: ACTIONS,
                suppliers: contacts.filter((c) => c.is_supplier && c.active),
                products: products.filter((p) => p.active),
              }
            : undefined
        }
      />
    </LetterheadProvider>
  );
}
