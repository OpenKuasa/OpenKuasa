import {
  deleteContraAction,
  postContraAction,
  saveAndPostContraAction,
  saveContraAction,
  voidContraAction,
} from '@/app/(app)/finance/actions';
import { type ContraActions, ContrasView } from '@/components/finance/contras-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listBills } from '@/lib/finance/bills';
import { listContacts } from '@/lib/finance/contacts';
import { contraParties } from '@/lib/finance/contra-form';
import { listContras } from '@/lib/finance/contras';
import { listInvoices } from '@/lib/finance/invoices';
import { listPaymentsIn, listPaymentsOut } from '@/lib/finance/money';
import { payableBills } from '@/lib/finance/payment-form';
import { receivableInvoices } from '@/lib/finance/receipt-form';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CONTRAS } from './contra-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: ContraActions = {
  save: saveContraAction,
  saveAndPost: saveAndPostContraAction,
  post: postContraAction,
  voidContra: voidContraAction,
  remove: deleteContraAction,
};

/**
 * Every contra entry of the workspace. Recording, posting, voiding and deleting one is an owner's or admin's
 * (`sign-off-finance`), as the database enforces; a member reads them and is told who records them, and a viewer
 * and the demo workspace only read.
 */
export default async function ContraEntriesScreen() {
  if (!hasSupabaseEnv()) {
    return <ContrasView rows={SAMPLE_CONTRAS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canSignOff = !viewer.isDemo && can(viewer.role, 'sign-off-finance');
  // What the form offers (contacts, and the invoices and bills that can still be set off, after what payments not
  // yet posted hold) is read only for someone who can record a contra entry.
  const [rows, contacts, invoices, bills, paymentsIn, paymentsOut] = await Promise.all([
    listContras(ctx),
    canSignOff ? listContacts(ctx) : [],
    canSignOff ? listInvoices(ctx) : [],
    canSignOff ? listBills(ctx) : [],
    canSignOff ? listPaymentsIn(ctx) : [],
    canSignOff ? listPaymentsOut(ctx) : [],
  ]);
  const drafts = rows.filter((r) => r.status === 'draft').map((r) => r.contact_id);
  return (
    <ContrasView
      rows={rows}
      today={todayUtc()}
      writer={
        canSignOff
          ? {
              actions: ACTIONS,
              // Only what the form reads goes to the browser.
              parties: contraParties(contacts, receivableInvoices(invoices, paymentsIn), payableBills(bills, paymentsOut), drafts),
            }
          : undefined
      }
      memberNote={!viewer.isDemo && !canSignOff && can(viewer.role, 'edit-data')}
    />
  );
}
