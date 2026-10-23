import type { SupabaseClient } from '@supabase/supabase-js';
import { CRM_FOCUS } from '@/lib/agents/types';
import { readBack, validatePlan, type FocusPlan } from '@/lib/agents/focus/plan';
import { CRM_FOCUS_MENU } from '@/lib/crm/agent/checks';
import { klDay } from '@/lib/crm/deal-stats';

export type CrmAgentRaw = {
  /** Null unless the owner confirmed a focus (`focus_confirmed_at` is set). */
  plan: FocusPlan | null;
  deals: {
    id: string;
    title: string;
    company: string | null;
    status: string;
    value: number;
    expectedClose: string | null;
    contactId: string | null;
    lastActivityAt: string | null;
  }[];
  contacts: {
    id: string;
    name: string;
    createdAt: string;
    lastActivityAt: string | null;
    hasOpenFollowUp: boolean;
  }[];
  /** `contactName` is embedded from the contact row, so it is there even for contacts not loaded above. */
  overdue: { id: string; title: string; contactId: string; contactName: string | null; dueAt: string }[];
};

/** Like the Overview: at most this many open deals and contacts, newest first. */
const RECORD_LIMIT = 500;
/** How many ids go into one `in (...)` filter, to keep request URLs short. */
const ID_CHUNK = 100;
/** PostgREST returns at most this many rows per request. */
const PAGE = 1000;

type Rows = { data: unknown[] | null; error: unknown };

/** Throws on any read error, so a run never works from a partial snapshot. */
function rowsOf(result: Rows): Record<string, unknown>[] {
  if (result.error) throw result.error;
  return (result.data ?? []) as Record<string, unknown>[];
}

/** Reads every page of a query, so the 1000-row response cap cannot hide older rows. */
async function readAll(
  page: (from: number, to: number) => PromiseLike<Rows>,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = rowsOf(await page(from, from + PAGE - 1));
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

function later(current: string | null, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || Number.isNaN(Date.parse(candidate))) return current;
  return current === null || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function personName(first: unknown, last: unknown) {
  return [first, last]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
}

type Activity = { at: string | null; openTask: boolean };

/**
 * For each id, the newest activity/note time and whether it has an open follow-up.
 * `column` is the link column to match on ('contact_id' or 'deal_id').
 */
async function readActivity(
  service: SupabaseClient,
  orgId: string,
  column: 'contact_id' | 'deal_id',
  ids: string[],
): Promise<Map<string, Activity>> {
  const found = new Map<string, Activity>();
  const touch = (id: unknown, at: unknown, openTask: boolean) => {
    if (typeof id !== 'string') return;
    const prev = found.get(id) ?? { at: null, openTask: false };
    found.set(id, { at: later(prev.at, at), openTask: prev.openTask || openTask });
  };
  for (const group of chunks(ids)) {
    const [activities, notes] = await Promise.all([
      readAll((from, to) =>
        service
          .from('crm_activities')
          .select(`${column},type,created_at,completed_at`)
          .eq('org_id', orgId)
          .in(column, group)
          .order('created_at', { ascending: true })
          // Tiebreaker: rows sharing a created_at must not shift between pages.
          .order('id', { ascending: true })
          .range(from, to),
      ),
      readAll((from, to) =>
        service
          .from('crm_notes')
          .select(`${column},created_at`)
          .eq('org_id', orgId)
          .in(column, group)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);
    for (const row of activities) {
      const open = row.type === 'task' && row.completed_at == null;
      touch(row[column], row.created_at, open);
      touch(row[column], row.completed_at, false);
    }
    for (const row of notes) touch(row[column], row.created_at, false);
  }
  return found;
}

export async function buildCrmAgentContext(
  service: SupabaseClient,
  orgId: string,
  now: Date = new Date(),
): Promise<{ context: string; raw: CrmAgentRaw }> {
  const config = await service
    .from('agent_configs')
    .select('focus_plan,focus_confirmed_at')
    .eq('org_id', orgId)
    .eq('agent_key', CRM_FOCUS)
    .maybeSingle();
  if (config.error) throw config.error;
  const row = config.data as { focus_plan: unknown; focus_confirmed_at: string | null } | null;
  // Re-validated on every read: the stored plan is never trusted as-is.
  const plan = row?.focus_confirmed_at ? validatePlan(CRM_FOCUS_MENU, row.focus_plan).plan : null;

  const [dealRows, contactRows] = await Promise.all([
    service
      .from('crm_deals')
      .select('id,title,value_cents,status,contact_id,expected_close_date,last_activity_at,created_at,crm_contacts(company)')
      .eq('org_id', orgId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(RECORD_LIMIT),
    service
      .from('crm_contacts')
      .select('id,first_name,last_name,created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(RECORD_LIMIT),
  ]);
  const dealData = rowsOf(dealRows);
  const contactData = rowsOf(contactRows);

  const todayStart = `${klDay(now)}T00:00:00.000Z`;
  const overdueRows = rowsOf(
    await service
      .from('crm_activities')
      .select('id,title,contact_id,due_at,crm_contacts(first_name,last_name)')
      .eq('org_id', orgId)
      .eq('type', 'task')
      .is('completed_at', null)
      .not('contact_id', 'is', null)
      .not('due_at', 'is', null)
      .lt('due_at', todayStart)
      .order('due_at', { ascending: true })
      .limit(RECORD_LIMIT),
  );

  const [dealActivity, contactActivity] = await Promise.all([
    readActivity(service, orgId, 'deal_id', dealData.map((d) => String(d.id))),
    readActivity(service, orgId, 'contact_id', contactData.map((c) => String(c.id))),
  ]);

  const raw: CrmAgentRaw = {
    plan,
    deals: dealData.map((d) => {
      const contact = d.crm_contacts as { company?: string | null } | null;
      const id = String(d.id);
      return {
        id,
        title: String(d.title ?? '').trim() || 'Untitled deal',
        company: contact?.company?.trim() || null,
        status: String(d.status),
        value: Number(d.value_cents ?? 0) / 100,
        expectedClose: (d.expected_close_date as string | null) ?? null,
        contactId: (d.contact_id as string | null) ?? null,
        // The newest of its activities, notes and its own stamp; else when it was created.
        lastActivityAt: later(dealActivity.get(id)?.at ?? null, d.last_activity_at) ?? (d.created_at as string),
      };
    }),
    contacts: contactData.map((c) => {
      const id = String(c.id);
      const seen = contactActivity.get(id);
      return {
        id,
        name: personName(c.first_name, c.last_name) || 'Unnamed contact',
        createdAt: String(c.created_at),
        lastActivityAt: seen?.at ?? null,
        hasOpenFollowUp: seen?.openTask ?? false,
      };
    }),
    overdue: overdueRows.map((o) => {
      const person = o.crm_contacts as { first_name?: unknown; last_name?: unknown } | null;
      return {
        id: String(o.id),
        title: String(o.title ?? ''),
        contactId: String(o.contact_id),
        contactName: person ? personName(person.first_name, person.last_name) || null : null,
        dueAt: String(o.due_at),
      };
    }),
  };

  // Counts only: no names, no ids, never the focus text.
  let context = `Open deals: ${raw.deals.length}. Contacts: ${raw.contacts.length}. Overdue follow-ups: ${raw.overdue.length}.`;
  if (plan) {
    context += `\nWhat the owner asked to watch:\n${readBack(CRM_FOCUS_MENU, plan)
      .map((line) => `- ${line}`)
      .join('\n')}`;
  }
  return { context, raw };
}
