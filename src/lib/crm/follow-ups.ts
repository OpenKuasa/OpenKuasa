import type { SupabaseClient } from '@supabase/supabase-js';
import { CrmContactFormError } from '@/lib/crm/contacts';

/** A reminder to get back to a contact, as the screen shows it. */
export type CrmFollowUp = {
  id: string;
  contactId: string;
  title: string;
  /** Formatted for display, e.g. '12 Oct 2026'; null when no due date. */
  due: string | null;
  /** True when the due date is before today (UTC date comparison). */
  overdue: boolean;
};

/** A follow-up is a `crm_activities` row with `type = 'task'`. */
export type CrmFollowUpInsert = {
  org_id: string;
  contact_id: string;
  type: 'task';
  title: string;
  /** ISO string, midnight UTC of the chosen date. */
  due_at: string | null;
  /** Present only when an owner id is given. */
  owner_user_id?: string;
};

type CrmFollowUpRow = {
  id: string;
  contact_id: string;
  title: string;
  due_at: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TITLE_LENGTH = 200;

/** Postgres foreign-key violation: the contact was deleted meanwhile. */
const FOREIGN_KEY_VIOLATION = '23503';

function readString(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

/** `YYYY-MM-DD` -> ISO string at midnight UTC; rejects dates that do not exist. */
export function parseDueDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new CrmContactFormError('Enter a valid due date.');

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 30 Feb over to March, and maps years 0-99 to 1900-1999.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new CrmContactFormError('Enter a valid due date.');
  }
  return date.toISOString();
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

/** Midnight UTC of the date `value` falls on. */
function utcDay(value: Date) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** Reads `contactId` (UUID), `title` (required, trimmed, max 200 chars) and `dueDate` (optional, `YYYY-MM-DD`). */
export function parseFollowUpForm(
  formData: FormData,
  orgId: string,
  ownerUserId?: string | null,
): CrmFollowUpInsert {
  const contactId = readString(formData, 'contactId');
  const title = readString(formData, 'title');
  const dueDate = readString(formData, 'dueDate');

  if (!UUID.test(contactId)) throw new CrmContactFormError('That contact could not be found.');
  if (!title) throw new CrmContactFormError('Enter what to follow up on.');
  if (title.length > MAX_TITLE_LENGTH) {
    throw new CrmContactFormError('Keep the follow-up under 200 characters.');
  }

  return {
    org_id: orgId,
    contact_id: contactId,
    type: 'task',
    title,
    due_at: dueDate ? parseDueDate(dueDate) : null,
    ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
  };
}

/** Reads `followUpId`, which must be a UUID. */
export function readFollowUpId(formData: FormData): string {
  const id = readString(formData, 'followUpId');
  if (!UUID.test(id)) throw new CrmContactFormError('That follow-up could not be found.');
  return id;
}

export async function createFollowUp(
  client: SupabaseClient,
  payload: CrmFollowUpInsert,
): Promise<void> {
  const { error } = await client.from('crm_activities').insert(payload);

  if (error) {
    if (error.code === FOREIGN_KEY_VIOLATION) {
      throw new CrmContactFormError('That contact no longer exists.');
    }
    throw error;
  }
}

/** Marks a follow-up done: sets completed_at and updated_at to now, scoped by id AND org_id, only where type = 'task'. */
export async function completeFollowUp(
  client: SupabaseClient,
  orgId: string,
  id: string,
): Promise<void> {
  // Nothing in the database maintains updated_at.
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('crm_activities')
    .update({ completed_at: now, updated_at: now })
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('type', 'task')
    .select('id');

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new CrmContactFormError('That follow-up no longer exists.');
  }
}

/**
 * Open (not completed) follow-ups for a workspace's contacts, grouped by contact id,
 * soonest due first with undated ones last. At most `limit` rows (default 200).
 */
export async function listOpenFollowUps(
  client: SupabaseClient,
  orgId: string,
  limit = 200,
  now: Date = new Date(),
): Promise<Record<string, CrmFollowUp[]>> {
  const { data, error } = await client
    .from('crm_activities')
    .select('id,contact_id,title,due_at')
    .eq('org_id', orgId)
    .eq('type', 'task')
    .is('completed_at', null)
    .not('contact_id', 'is', null)
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw error;

  const today = utcDay(now);
  const byContact: Record<string, CrmFollowUp[]> = {};

  for (const row of (data ?? []) as unknown as CrmFollowUpRow[]) {
    const dueAt = row.due_at ? new Date(row.due_at) : null;
    (byContact[row.contact_id] ??= []).push({
      id: row.id,
      contactId: row.contact_id,
      title: row.title,
      due: dueAt ? formatDate(dueAt) : null,
      overdue: dueAt ? utcDay(dueAt) < today : false,
    });
  }
  return byContact;
}
