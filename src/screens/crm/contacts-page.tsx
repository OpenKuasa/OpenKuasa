import ContactsScreen from '@/screens/reach/contacts';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  CrmContactFormError,
  createCrmContact,
  deleteCrmContact,
  getCrmContact,
  listCrmContacts,
  parseCrmContactFields,
  parseCrmContactForm,
  readContactId,
  updateCrmContact,
} from '@/lib/crm/contacts';
import {
  completeFollowUp,
  createFollowUp,
  listOpenFollowUps,
  parseFollowUpForm,
  readFollowUpId,
} from '@/lib/crm/follow-ups';
import { importCrmContacts, planImport, type ImportMapping } from '@/lib/crm/import';
import {
  listBillingCustomers,
  readBillingCustomerId,
  setContactBillingCustomer,
  type BillingCustomerChoice,
} from '@/lib/crm/invoice-links';
import type { CrmContactActions, CrmFormState } from '@/lib/crm/form-state';
import { loadRecordNotes, readOpenParam, OPEN_PARAM } from '@/lib/crm/notes';
import { runCrmWrite } from '@/lib/crm/run-write';
import { errorCodeOf } from '@/lib/ai/call-log';
import { createClient } from '@/lib/supabase/server';
import { CouldntLoad } from '@/components/crm/couldnt-load';

const CONTACTS_PATH = '/crm/contacts';

/**
 * How many contacts the page loads. Filtering and search run in the browser
 * over these, so this is also how far they reach; past it, they need to move
 * into the database with indexes behind them.
 */
const CONTACTS_LOADED = 500;

/** Runs one write and reports its outcome to the form; see `runCrmWrite`. */
function runWrite(formData: FormData, failure: string, write: () => Promise<string | void>) {
  return runCrmWrite(CONTACTS_PATH, formData, failure, write);
}

/** The import card sends the table it read and which column feeds which field. */
function readImportPayload(formData: FormData): { table: string[][]; mapping: ImportMapping } {
  const invalid = new CrmContactFormError('That file could not be read. Choose it again.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get('payload') ?? ''));
  } catch {
    throw invalid;
  }

  const { table, mapping } = (parsed ?? {}) as { table?: unknown; mapping?: unknown };
  const isTable =
    Array.isArray(table) &&
    table.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
  const isMapping =
    typeof mapping === 'object' &&
    mapping !== null &&
    Object.values(mapping).every(
      (index) => index === null || (Number.isInteger(index) && (index as number) >= 0),
    );
  if (!isTable || !isMapping) throw invalid;

  return { table: table as string[][], mapping: mapping as ImportMapping };
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

async function saveContactAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not save the contact.', async () => {
    // Undefined when the form did not offer the picker: the link is left alone.
    const customerId = readBillingCustomerId(formData);
    if (formData.has('contactId')) {
      const contactId = readContactId(formData);
      await updateCrmContact(supabase, orgId, contactId, parseCrmContactFields(formData));
      if (customerId !== undefined) {
        await setContactBillingCustomer(supabase, orgId, contactId, customerId);
      }
    } else {
      // Whoever adds a contact starts as the person in charge of it.
      await createCrmContact(supabase, {
        ...parseCrmContactForm(formData, orgId, userId),
        ...(customerId ? { finance_customer_id: customerId } : {}),
      });
    }
  });
}

async function deleteContactAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not delete the contact.', () =>
    deleteCrmContact(supabase, orgId, readContactId(formData)),
  );
}

async function addFollowUpAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not save the follow-up.', () =>
    createFollowUp(supabase, parseFollowUpForm(formData, orgId, userId)),
  );
}

async function completeFollowUpAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not update the follow-up.', () =>
    completeFollowUp(supabase, orgId, readFollowUpId(formData)),
  );
}

async function importContactsAction(_prev: CrmFormState, formData: FormData) {
  'use server';
  const { orgId, userId } = await getViewer();
  const supabase = await createClient();

  return runWrite(formData, 'Could not import the contacts.', async () => {
    // Every row is checked again here; the browser's preview is only a preview.
    const { table, mapping } = readImportPayload(formData);
    const plan = planImport(table, mapping);
    const { imported, duplicates } = await importCrmContacts(supabase, orgId, userId, plan.rows);

    const parts = [`Imported ${plural(imported, 'contact', 'contacts')}.`];
    if (duplicates > 0) {
      parts.push(`${plural(duplicates, 'was', 'were')} already in this workspace.`);
    }
    if (plan.skipped.length > 0) {
      parts.push(`${plural(plan.skipped.length, 'row was', 'rows were')} skipped.`);
    }
    return parts.join(' ');
  });
}

async function loadContactNotesAction(contactId: string) {
  'use server';
  // The workspace is the viewer's, never the caller's input; the database's row security applies too.
  const { orgId } = await getViewer();
  const supabase = await createClient();
  return loadRecordNotes(supabase, orgId, { contactId });
}

const ACTIONS: CrmContactActions = {
  notes: loadContactNotesAction,
  save: saveContactAction,
  remove: deleteContactAction,
  addFollowUp: addFollowUpAction,
  completeFollowUp: completeFollowUpAction,
  importContacts: importContactsAction,
};

export default async function CrmContactsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  // No project configured (dev / preview / tests): the sample view.
  if (!hasSupabaseEnv()) return <ContactsScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId, role } = await getViewer();
  const supabase = await createClient();
  const openId = readOpenParam((await searchParams)?.[OPEN_PARAM]);

  let live: Awaited<ReturnType<typeof listCrmContacts>> | null = null;
  let followUps: Awaited<ReturnType<typeof listOpenFollowUps>> = {};
  let billingCustomers: BillingCustomerChoice[] = [];
  let openContact: Awaited<ReturnType<typeof getCrmContact>> = null;
  try {
    // Fetched together: each trip to the database costs about the same.
    [live, followUps, billingCustomers] = await Promise.all([
      listCrmContacts(supabase, orgId, CONTACTS_LOADED),
      // Follow-ups are an extra; the contacts still show if they cannot load.
      listOpenFollowUps(supabase, orgId, CONTACTS_LOADED).catch((error) => {
        console.error('[crm/contacts] could not load follow-ups', errorCodeOf(error));
        return {};
      }),
      // Only the form needs these; the contacts still show if they cannot load.
      role === 'viewer'
        ? []
        : listBillingCustomers(supabase, orgId).catch((error) => {
            console.error('[crm/contacts] could not load billing customers', errorCodeOf(error));
            return [];
          }),
    ]);
    // A contact opened by link that is beyond the ones loaded is read by its id.
    // An unknown or foreign id opens nothing, and so does a read that fails.
    if (role !== 'viewer' && openId && !live.contacts.some((contact) => contact.id === openId)) {
      openContact = await getCrmContact(supabase, orgId, openId).catch((error) => {
        console.error('[crm/contacts] could not load the linked contact', errorCodeOf(error));
        return null;
      });
    }
  } catch (error) {
    // The CRM migration is applied to a database separately from a deploy, so
    // the table can be missing for a while. The page says so; it never shows sample data in its place.
    console.error('[crm/contacts] could not load contacts', errorCodeOf(error));
  }

  if (!live) {
    return (
      <CouldntLoad
        title="Contacts"
        subtitle="All your leads and customers in one place."
        thing="contacts"
      />
    );
  }
  return (
    <ContactsScreen
      contacts={live.contacts}
      totalContacts={live.total}
      followUps={followUps}
      billingCustomers={billingCustomers}
      openId={openId}
      openContact={openContact}
      // Viewers can read contacts but the database refuses their writes.
      actions={role === 'viewer' ? undefined : ACTIONS}
    />
  );
}
