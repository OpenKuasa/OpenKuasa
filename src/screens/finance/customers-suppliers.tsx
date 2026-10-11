import {
  createContactAction,
  deleteContactAction,
  setContactActiveAction,
  updateContactAction,
} from '@/app/(app)/finance/actions';
import { type ContactActions, ContactsView } from '@/components/finance/contacts-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  type BillBalance,
  type FinanceContact,
  type InvoiceBalance,
  contactsView,
  listBillBalances,
  listContacts,
  listInvoiceBalances,
} from '@/lib/finance/contacts';
import { createClient } from '@/lib/supabase/server';

/* ---- sample data (Rimba Ventures Sdn Bhd), shown when there is no database ---- */

const sample = (
  id: string,
  name: string,
  role: 'customer' | 'supplier',
  email: string,
  phone: string,
  ssm_no: string,
  active = true,
): FinanceContact => ({
  id,
  name,
  is_customer: role === 'customer',
  is_supplier: role === 'supplier',
  email,
  phone,
  ssm_no,
  tin: null,
  payment_terms_days: 30,
  active,
});

const SAMPLE_CONTACTS: FinanceContact[] = [
  sample('1', 'Aisyah Trading', 'customer', 'accounts@aisyahtrading.my', '+60 12-345 6789', '201901012345'),
  sample('2', 'Lim Hardware', 'supplier', 'sales@limhardware.com.my', '+60 3-7956 1234', '198701004567'),
  sample('3', 'Zaki Enterprise', 'customer', 'zaki@zakient.my', '+60 13-221 4455', '202001098765'),
  sample('4', 'Nusantara Logistics', 'supplier', 'orders@nusantara.my', '+60 3-5121 8800', '201501076543'),
  sample('5', 'Nurul Boutique', 'customer', 'hello@nurulboutique.my', '+60 11-2345 6781', '202201054321'),
  sample('6', 'Langkawi Fresh', 'supplier', 'billing@langkawifresh.my', '+60 4-966 5566', '201801033221'),
  sample('7', 'Seri Mutiara Enterprise', 'customer', 'admin@serimutiara.my', '+60 19-887 6543', '201701011223', false),
  // Customers of the Invoices sample that the contacts above did not include.
  sample('8', 'Nusantara Logistics', 'customer', 'finance@nusantara.my', '+60 3-5121 8801', '201501076544'),
  sample('9', 'Lim Hardware Sdn Bhd', 'customer', 'accounts@limhardware.com.my', '+60 3-7956 1235', '198701004568'),
];

const SAMPLE_BILLS: BillBalance[] = [
  { supplier_id: '2', balance: 2300, display_status: 'pending' },
  { supplier_id: '4', balance: 540, display_status: 'pending' },
  { supplier_id: '6', balance: 95, display_status: 'overdue' },
];

// The open (sent and overdue) invoices of the Invoices sample, in
// sales-sample.ts, customer by customer and amount by amount, so both sample
// screens show the same total receivable.
const SAMPLE_INVOICES: InvoiceBalance[] = [
  { customer_id: '3', balance: 2500, display_status: 'sent' }, // Zaki Enterprise, INV-1041 less RM 1,000 paid
  { customer_id: '5', balance: 8900, display_status: 'overdue' }, // Nurul Boutique, INV-1040
  { customer_id: '8', balance: 6400, display_status: 'sent' }, // Nusantara Logistics, INV-1037
  { customer_id: '9', balance: 3180, display_status: 'overdue' }, // Lim Hardware Sdn Bhd, INV-1035
];

const ACTIONS: ContactActions = {
  create: createContactAction,
  update: updateContactAction,
  setActive: setContactActiveAction,
  remove: deleteContactAction,
};

export default async function CustomersSuppliersScreen() {
  if (!hasSupabaseEnv()) {
    return <ContactsView view={contactsView(SAMPLE_CONTACTS, SAMPLE_BILLS, SAMPLE_INVOICES)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const [contacts, bills, invoices] = await Promise.all([
    listContacts(ctx),
    listBillBalances(ctx),
    listInvoiceBalances(ctx),
  ]);
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  return <ContactsView view={contactsView(contacts, bills, invoices)} actions={canEdit ? ACTIONS : undefined} />;
}
