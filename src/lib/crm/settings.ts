import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveNotificationPrefs } from '@/config/account';
import { klDay } from '@/lib/crm/deal-stats';

/**
 * Kasturi's settings: the workspace's one deal rule, each person's own Kasturi
 * notifications, and the export of the workspace's contacts. Company details,
 * the team and the pipelines are not settings of Kasturi's: they are changed
 * where they live (Account, and the Deals screen), and only shown here.
 */

/** The database's code for "this workspace requires a reason to mark a deal lost". */
export const LOST_REASON_REQUIRED_CODE = 'KR001';
export const LOST_REASON_REQUIRED_MESSAGE =
  'This workspace requires a reason to mark a deal lost. Enter one and try again.';

export type CrmSettings = { requireLostReason: boolean };

export const DEFAULT_CRM_SETTINGS: CrmSettings = { requireLostReason: false };

/**
 * The Kasturi events a person can be told about in the app. Each is one of the
 * kinds listed on Account > Notifications; the switch here is that kind's
 * in-app switch, so the two screens always agree.
 */
export const KASTURI_NOTIFICATIONS = [
  {
    id: 'new_leads',
    field: 'notifyNewLeads',
    name: 'New leads',
    help: 'When someone sends one of your lead forms, or asks for a person in a landing page’s chat.',
  },
  {
    id: 'deal_stages',
    field: 'notifyDealWon',
    name: 'Deals won',
    help: 'When someone else in the workspace wins a deal.',
  },
] as const;

export type KasturiNotificationId = (typeof KASTURI_NOTIFICATIONS)[number]['id'];
export type MyKasturiNotifications = Record<KasturiNotificationId, boolean> & {
  /** False when the person has switched every in-app notification off on Account > Notifications. */
  inAppOn: boolean;
};

const UNIQUE_VIOLATION = '23505';

export function parseCrmSettingsForm(formData: FormData): CrmSettings {
  return { requireLostReason: formData.get('requireLostReason') === 'on' };
}

/** The workspace's settings: the defaults until an owner or admin saves their own. */
export async function loadCrmSettings(client: SupabaseClient, orgId: string): Promise<CrmSettings> {
  const { data, error } = await client
    .from('crm_settings')
    .select('require_lost_reason')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { require_lost_reason: boolean | null } | null;
  return row ? { requireLostReason: row.require_lost_reason === true } : DEFAULT_CRM_SETTINGS;
}

/**
 * Saves the workspace's one settings row. An upsert is not used: it would
 * have to be allowed to write `org_id` on an update, which nobody is. Nothing
 * in the database maintains `updated_at`, so the write sets it.
 */
export async function saveCrmSettings(
  client: SupabaseClient,
  orgId: string,
  settings: CrmSettings,
  userId?: string | null,
): Promise<void> {
  const columns = { require_lost_reason: settings.requireLostReason, updated_by: userId ?? null };
  const update = () =>
    client
      .from('crm_settings')
      .update({ ...columns, updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .select('org_id');

  const updated = await update();
  if (updated.error) throw updated.error;
  if (updated.data && updated.data.length > 0) return;

  const inserted = await client.from('crm_settings').insert({ org_id: orgId, ...columns });
  if (!inserted.error) return;
  // Someone else saved the first settings a moment ago: write over theirs.
  if (inserted.error.code !== UNIQUE_VIOLATION) throw inserted.error;
  const again = await update();
  if (again.error) throw again.error;
}

/** Which Kasturi notifications the person gets in the app, from their stored preferences. */
export function myKasturiNotifications(storedPrefs: unknown): MyKasturiNotifications {
  const prefs = resolveNotificationPrefs(storedPrefs);
  return {
    inAppOn: prefs.channels.inapp,
    new_leads: prefs.events.new_leads.inapp,
    deal_stages: prefs.events.deal_stages.inapp,
  };
}

export function parseMyNotificationsForm(formData: FormData): Record<KasturiNotificationId, boolean> {
  return {
    new_leads: formData.get('notifyNewLeads') === 'on',
    deal_stages: formData.get('notifyDealWon') === 'on',
  };
}

/**
 * The person's stored preferences with the two Kasturi switches set. Only the
 * in-app switch of each kind is touched: everything else they chose on
 * Account > Notifications is kept as it was.
 */
export function withKasturiNotifications(
  storedPrefs: unknown,
  choice: Record<KasturiNotificationId, boolean>,
): ReturnType<typeof resolveNotificationPrefs> {
  const prefs = resolveNotificationPrefs(storedPrefs);
  return {
    ...prefs,
    events: {
      ...prefs.events,
      new_leads: { ...prefs.events.new_leads, inapp: choice.new_leads },
      deal_stages: { ...prefs.events.deal_stages, inapp: choice.deal_stages },
    },
  };
}

export async function loadMyKasturiNotifications(
  client: SupabaseClient,
  userId: string,
): Promise<MyKasturiNotifications> {
  const { data, error } = await client
    .from('profiles')
    .select('notification_prefs')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return myKasturiNotifications((data as { notification_prefs?: unknown } | null)?.notification_prefs);
}

/** Saves the person's two Kasturi switches into their own preferences. */
export async function saveMyKasturiNotifications(
  client: SupabaseClient,
  userId: string,
  choice: Record<KasturiNotificationId, boolean>,
): Promise<void> {
  const current = await client.from('profiles').select('notification_prefs').eq('user_id', userId).maybeSingle();
  if (current.error) throw current.error;
  const stored = (current.data as { notification_prefs?: unknown } | null)?.notification_prefs;
  const { data, error } = await client
    .from('profiles')
    .update({ notification_prefs: withKasturiNotifications(stored, choice) })
    .eq('user_id', userId)
    .select('user_id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('profile not found');
}

/* ---- export ---------------------------------------------------------- */

/** The most contacts one export holds. */
export const EXPORT_CONTACTS_MAX = 50000;
const EXPORT_PAGE_SIZE = 1000;

export type ExportContact = {
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  country: string | null;
  status: string;
  source: string | null;
  tags: string[] | null;
  created_at: string;
};

const EXPORT_COLUMNS = 'first_name,last_name,email,phone,company,country,status,source,tags,created_at';

/**
 * One CSV cell, always in quotes so no spreadsheet setting can split it. A
 * value a spreadsheet would work out is made plain text with an apostrophe in
 * front: names and companies come from public forms, and a phone number such
 * as +60-12-345 6789 would otherwise show as a sum. The contacts import drops
 * that apostrophe again, so the file imports unchanged.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The contacts as a CSV file, one line each, with a heading line. */
export function contactsCsv(contacts: ExportContact[]): string {
  const rows = contacts.map((contact) =>
    [
      contact.first_name,
      contact.last_name ?? '',
      contact.email ?? '',
      contact.phone ?? '',
      contact.company ?? '',
      contact.country ?? '',
      contact.status,
      contact.source ?? '',
      (contact.tags ?? []).join('; '),
      // The day in Malaysia, as the screens show it.
      klDay(new Date(contact.created_at)),
    ]
      .map(cell)
      .join(','),
  );
  return ['first_name,last_name,email,phone,company,country,status,source,tags,added_on', ...rows].join('\r\n');
}

/** Every contact of the workspace, oldest first, a page at a time; `complete` is false past the limit. */
export async function listContactsForExport(
  client: SupabaseClient,
  orgId: string,
): Promise<{ contacts: ExportContact[]; complete: boolean }> {
  const contacts: ExportContact[] = [];
  // Read until a page comes back empty: the server may hand out fewer rows a page than were asked for.
  // It reads one row past the limit, so a workspace with exactly the limit is still known to be complete.
  while (contacts.length <= EXPORT_CONTACTS_MAX) {
    const { data, error } = await client
      .from('crm_contacts')
      .select(EXPORT_COLUMNS)
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(contacts.length, Math.min(contacts.length + EXPORT_PAGE_SIZE - 1, EXPORT_CONTACTS_MAX));
    if (error) throw error;
    const page = (data ?? []) as unknown as ExportContact[];
    if (page.length === 0) return { contacts, complete: true };
    contacts.push(...page);
  }
  return { contacts: contacts.slice(0, EXPORT_CONTACTS_MAX), complete: false };
}
