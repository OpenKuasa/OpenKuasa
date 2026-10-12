import type { SupabaseClient } from '@supabase/supabase-js';
import { CrmContactFormError } from '@/lib/crm/contacts';

/**
 * Kasturi's broadcasts: a message written once for a chosen set of contacts.
 * Here a broadcast is the message and the rule for who it is for; the
 * recipients are worked out from the workspace's contacts each time. Nothing
 * in this file sends anything.
 */

/** The same limits as the table's check constraints. */
export const BROADCAST_NAME_MAX = 120;
export const BROADCAST_SUBJECT_MAX = 200;
export const BROADCAST_BODY_MAX = 10000;
export const BROADCAST_TAGS_MAX = 20;
/** How many broadcasts the screen loads. */
export const BROADCASTS_LOADED = 500;
/** How many contacts an audience is worked out over. */
export const AUDIENCE_CONTACTS_MAX = 5000;
const CONTACT_PAGE_SIZE = 1000;

/** The contact statuses an audience can be narrowed to. Archived contacts are never in one. */
export const AUDIENCE_STATUSES = ['lead', 'contacted', 'qualified', 'customer'] as const;
export type AudienceStatus = (typeof AUDIENCE_STATUSES)[number];

export const AUDIENCE_STATUS_LABELS: Record<AudienceStatus, string> = {
  lead: 'New leads',
  contacted: 'Contacted',
  qualified: 'Qualified',
  customer: 'Customers',
};

export const BROADCAST_MESSAGES = {
  name: 'Enter a name for the broadcast.',
  nameTooLong: `Keep the name to ${BROADCAST_NAME_MAX} characters or fewer.`,
  subject: 'Enter a subject.',
  subjectTooLong: `Keep the subject to ${BROADCAST_SUBJECT_MAX} characters or fewer.`,
  body: 'Write the message.',
  bodyTooLong: `Keep the message to ${BROADCAST_BODY_MAX.toLocaleString('en-MY')} characters or fewer.`,
  tooManyTags: `Choose at most ${BROADCAST_TAGS_MAX} tags.`,
  gone: 'That broadcast no longer exists.',
} as const;

const M = BROADCAST_MESSAGES;

/** Who a broadcast is for. Empty `statuses` means any status; empty `tags` means no tag is needed. */
export type BroadcastAudience = {
  statuses: AudienceStatus[];
  /** A contact needs at least one of these. Compared without regard to case. */
  tags: string[];
};

export type Broadcast = {
  id: string;
  name: string;
  subject: string;
  body: string;
  audience: BroadcastAudience;
  /** `YYYY-MM-DD` it was last changed. */
  updatedDay: string;
};

/** The columns a person fills in on the form. */
export type BroadcastFields = {
  name: string;
  subject: string;
  body: string;
  audience_statuses: AudienceStatus[];
  audience_tags: string[];
};

/** What an audience needs to know about a contact. */
export type AudienceContact = {
  id: string;
  name: string;
  email: string;
  company: string;
  /** The stored status: 'lead', 'customer', 'archived', … */
  status: string;
  tags: string[];
};

type BroadcastRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  audience_statuses: string[] | null;
  audience_tags: string[] | null;
  updated_at: string;
};

const BROADCAST_COLUMNS = 'id,name,subject,body,audience_statuses,audience_tags,updated_at';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shape the Contacts page asks of an email. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function read(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

/** One line of text: runs of spaces and line breaks become one space. */
function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function isAudienceStatus(value: string): value is AudienceStatus {
  return (AUDIENCE_STATUSES as readonly string[]).includes(value);
}

/** Tags as typed or ticked, with blanks and repeats (ignoring case) dropped. */
function uniqueTags(values: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = oneLine(value);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

/** Validates the add and edit form. Statuses and tags arrive as repeated fields. */
export function parseBroadcastForm(formData: FormData): BroadcastFields {
  const name = oneLine(read(formData, 'name'));
  const subject = oneLine(read(formData, 'subject'));
  // The message keeps its line breaks.
  const body = read(formData, 'body').replace(/\r\n/g, '\n');
  const statuses = [...new Set(formData.getAll('statuses').map(String))].filter(isAudienceStatus);
  const tags = uniqueTags(formData.getAll('tags').map(String));

  if (!name) throw new CrmContactFormError(M.name);
  if (name.length > BROADCAST_NAME_MAX) throw new CrmContactFormError(M.nameTooLong);
  if (!subject) throw new CrmContactFormError(M.subject);
  if (subject.length > BROADCAST_SUBJECT_MAX) throw new CrmContactFormError(M.subjectTooLong);
  if (!body) throw new CrmContactFormError(M.body);
  if (body.length > BROADCAST_BODY_MAX) throw new CrmContactFormError(M.bodyTooLong);
  if (tags.length > BROADCAST_TAGS_MAX) throw new CrmContactFormError(M.tooManyTags);

  return {
    name,
    subject,
    body,
    // Kept in the order the screen lists them.
    audience_statuses: AUDIENCE_STATUSES.filter((status) => statuses.includes(status)),
    audience_tags: tags,
  };
}

/** The id of the broadcast an edit or delete form is about. */
export function readBroadcastId(formData: FormData): string {
  const id = read(formData, 'broadcastId');
  if (!UUID.test(id)) throw new CrmContactFormError(M.gone);
  return id;
}

/**
 * The contacts a broadcast is for, by name. Never an archived contact, and
 * never one without a usable email. When two contacts share an email, only
 * the first (in the order given) is kept, so nobody gets the message twice.
 */
export function audienceFor(contacts: AudienceContact[], audience: BroadcastAudience): AudienceContact[] {
  const statuses = new Set<string>(audience.statuses);
  const tags = new Set(audience.tags.map((tag) => tag.toLowerCase()));
  const emails = new Set<string>();
  const recipients: AudienceContact[] = [];
  for (const contact of contacts) {
    const email = contact.email.trim().toLowerCase();
    if (contact.status === 'archived' || !EMAIL.test(email)) continue;
    if (statuses.size > 0 && !statuses.has(contact.status)) continue;
    if (tags.size > 0 && !contact.tags.some((tag) => tags.has(tag.toLowerCase()))) continue;
    if (emails.has(email)) continue;
    emails.add(email);
    recipients.push(contact);
  }
  return recipients.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** 'Customers, Qualified · tagged vip or wholesale', or 'All contacts'. */
export function audienceSummary(audience: BroadcastAudience): string {
  const who =
    audience.statuses.length > 0
      ? audience.statuses.map((status) => AUDIENCE_STATUS_LABELS[status]).join(', ')
      : 'All contacts';
  return audience.tags.length > 0 ? `${who} · tagged ${audience.tags.join(' or ')}` : who;
}

/** Every tag in use on a contact that could be in an audience, by name; the first spelling is kept. */
export function audienceTagOptions(contacts: AudienceContact[]): string[] {
  return uniqueTags(contacts.filter((contact) => contact.status !== 'archived').flatMap((contact) => contact.tags)).sort(
    (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

/**
 * One CSV cell. A value that a spreadsheet would run as a formula is made
 * plain text first: names and companies come from public forms.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The recipients as a CSV file: name, email, company, status, tags. */
export function recipientsCsv(recipients: AudienceContact[]): string {
  const rows = recipients.map((contact) =>
    [contact.name, contact.email, contact.company, contact.status, contact.tags.join('; ')].map(cell).join(','),
  );
  return ['name,email,company,status,tags', ...rows].join('\r\n');
}

export function mapBroadcast(row: BroadcastRow): Broadcast {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    audience: {
      statuses: AUDIENCE_STATUSES.filter((status) => (row.audience_statuses ?? []).includes(status)),
      tags: row.audience_tags ?? [],
    },
    updatedDay: row.updated_at.slice(0, 10),
  };
}

/** The workspace's broadcasts, newest first. */
export async function listBroadcasts(client: SupabaseClient, orgId: string): Promise<Broadcast[]> {
  const { data, error } = await client
    .from('crm_broadcasts')
    .select(BROADCAST_COLUMNS)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(BROADCASTS_LOADED);
  if (error) throw error;
  return ((data ?? []) as unknown as BroadcastRow[]).map(mapBroadcast);
}

/**
 * The workspace's contacts as an audience sees them, oldest first (so the
 * contact kept for a shared email is the one made first), read a page at a
 * time up to `AUDIENCE_CONTACTS_MAX`. `complete` is false when there are more.
 */
export async function listAudienceContacts(
  client: SupabaseClient,
  orgId: string,
): Promise<{ contacts: AudienceContact[]; complete: boolean }> {
  type Row = {
    id: string;
    first_name: string;
    last_name: string | null;
    email: string | null;
    company: string | null;
    status: string;
    tags: string[] | null;
  };
  const contacts: AudienceContact[] = [];
  for (let from = 0; from < AUDIENCE_CONTACTS_MAX; from += CONTACT_PAGE_SIZE) {
    const { data, error } = await client
      .from('crm_contacts')
      .select('id,first_name,last_name,email,company,status,tags')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + CONTACT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    contacts.push(
      ...page.map((row) => ({
        id: row.id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
        email: row.email ?? '',
        company: row.company ?? '',
        status: row.status,
        tags: row.tags ?? [],
      })),
    );
    if (page.length < CONTACT_PAGE_SIZE) return { contacts, complete: true };
  }
  return { contacts, complete: false };
}

export async function createBroadcast(
  client: SupabaseClient,
  orgId: string,
  fields: BroadcastFields,
  userId?: string | null,
): Promise<void> {
  const { error } = await client
    .from('crm_broadcasts')
    .insert({ org_id: orgId, ...fields, ...(userId ? { created_by: userId } : {}) });
  if (error) throw error;
}

/** Nothing in the database maintains `updated_at`, so the write sets it. */
export async function updateBroadcast(
  client: SupabaseClient,
  orgId: string,
  id: string,
  fields: BroadcastFields,
): Promise<void> {
  const { data, error } = await client
    .from('crm_broadcasts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}

export async function deleteBroadcast(client: SupabaseClient, orgId: string, id: string): Promise<void> {
  const { data, error } = await client
    .from('crm_broadcasts')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new CrmContactFormError(M.gone);
}
