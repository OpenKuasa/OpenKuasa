import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dailyDealReport,
  dealKpis,
  formatDay,
  formatRM,
  klDay,
  weeklyDealTrend,
  type DealTrendWeek,
} from '@/lib/crm/deal-stats';
import { listCrmDeals, type CrmDeal } from '@/lib/crm/deals';
import { listCrmPipelines, type CrmPipeline } from '@/lib/crm/pipelines';

/** How many people the "Deals by owner" chart shows. */
const OWNERS_LISTED = 6;
/** How many follow-ups the Overview lists. */
export const FOLLOW_UPS_LISTED = 6;

/** An open follow-up as the Overview lists it. */
export type OverviewFollowUp = {
  id: string;
  title: string;
  /** `YYYY-MM-DD`, or null when it has no due date. */
  dueDay: string | null;
};

/** Everything the Kasturi Overview dashboard shows, worked out from the workspace's own rows. */
export type CrmOverviewModel = {
  /** No deals and no follow-ups yet. */
  isEmpty: boolean;
  kpis: {
    /** The value of every open deal, in ringgit. */
    pipelineValue: number;
    openDeals: number;
    /** Won ÷ (won + lost), 0 to 100; null when no deal has closed. */
    winRate: number | null;
    /** The value of deals won this calendar month in Kuala Lumpur, in ringgit. */
    wonThisMonth: number;
  };
  /** Deals created and won in each of the last eight weeks, oldest first. */
  trend: DealTrendWeek[];
  /** The pipeline the stage charts are about: the default one. Null when there is none. */
  pipelineName: string | null;
  /** Open deals in that pipeline, per stage, in board order. `value` is in ringgit. */
  stages: { key: string; label: string; count: number; value: number }[];
  /** Open deals per owner, most first. */
  owners: { label: string; deals: number }[];
  /** Open deals expected to close in the next seven days, soonest first; at most five. */
  closingSoon: { id: string; name: string; stage: string; value: number; closes: string }[];
  closingSoonTotal: number;
  /** Open follow-ups, soonest due first. */
  followUps: { id: string; title: string; due: string; overdue: boolean }[];
  /** The latest things that happened, newest first; at most five. */
  activity: { text: string; when: string }[];
};

/** How many entries "Recent activity" lists. */
export const ACTIVITY_LISTED = 5;

/** A contact as "Recent activity" mentions it. */
export type OverviewContactAdded = { name: string; source: string | null; createdAt: string };

/** A logged call, message, meeting, note or follow-up as "Recent activity" reads it. */
export type OverviewLoggedWork = {
  type: string;
  title: string;
  createdAt: string;
  completedAt: string | null;
};

export type OverviewRecent = { contacts: OverviewContactAdded[]; activities: OverviewLoggedWork[] };

const LOGGED_LABELS: Record<string, string> = {
  call: 'Call',
  whatsapp: 'WhatsApp',
  email: 'Email',
  meeting: 'Meeting',
};

/** "30m", "3h", "2d": how long before `now`. */
function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

function dealName(deal: CrmDeal) {
  return deal.company && deal.company !== deal.title ? `${deal.company} — ${deal.title}` : deal.title;
}

/**
 * The latest things that happened, read off the times the rows already hold:
 * deals added, won and lost, contacts added, calls and messages logged, and
 * follow-ups done. Nothing records a deal moving stage, so that is not listed.
 * Notes are left out: what they say is not for the dashboard.
 */
export function recentCrmActivity(
  deals: CrmDeal[],
  contacts: OverviewContactAdded[],
  activities: OverviewLoggedWork[],
  now: Date,
): { text: string; when: string }[] {
  const events: { at: string | null; text: string }[] = [];
  for (const deal of deals) {
    events.push({ at: deal.createdAt, text: `New deal: ${dealName(deal)}` });
    if (deal.status === 'won') events.push({ at: deal.wonAt, text: `Won ${dealName(deal)} · ${formatRM(deal.value)}` });
    if (deal.status === 'lost') events.push({ at: deal.lostAt, text: `Lost ${dealName(deal)}` });
  }
  for (const contact of contacts) {
    events.push({ at: contact.createdAt, text: `${contact.name} added${contact.source ? ` via ${contact.source}` : ''}` });
  }
  for (const work of activities) {
    if (work.type === 'task') {
      if (work.completedAt) events.push({ at: work.completedAt, text: `Follow-up done: ${work.title}` });
    } else if (LOGGED_LABELS[work.type]) {
      events.push({ at: work.createdAt, text: `${LOGGED_LABELS[work.type]} logged: ${work.title}` });
    }
  }
  return events
    .flatMap((event) => {
      const time = event.at ? Date.parse(event.at) : NaN;
      return Number.isNaN(time) || time > now.getTime() ? [] : [{ time, at: event.at as string, text: event.text }];
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, ACTIVITY_LISTED)
    .map((event) => ({ text: event.text, when: ago(event.at, now) }));
}

/** Adds ringgit amounts in whole sen, so the total has no floating-point dust. */
function sumValue(deals: CrmDeal[]) {
  return deals.reduce((sum, deal) => sum + Math.round(deal.value * 100), 0) / 100;
}

function monthOf(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : klDay(date).slice(0, 7);
}

/** The dashboard's figures from the workspace's deals, pipelines and open follow-ups. */
export function buildCrmOverview(
  deals: CrmDeal[],
  pipelines: CrmPipeline[],
  followUps: OverviewFollowUp[],
  now: Date,
  recent: OverviewRecent = { contacts: [], activities: [] },
): CrmOverviewModel {
  const kpis = dealKpis(deals);
  const today = klDay(now);
  const open = deals.filter((deal) => deal.status === 'open');
  const wonThisMonth = deals.filter(
    (deal) => deal.status === 'won' && monthOf(deal.wonAt) === today.slice(0, 7),
  );

  const pipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0] ?? null;
  const stages = (pipeline?.stages ?? []).map((stage) => {
    const inStage = open.filter((deal) => deal.stageId === stage.id);
    return { key: stage.id, label: stage.name, count: inStage.length, value: sumValue(inStage) };
  });

  const perOwner = new Map<string, number>();
  for (const deal of open) perOwner.set(deal.owner, (perOwner.get(deal.owner) ?? 0) + 1);
  const owners = [...perOwner]
    .map(([label, count]) => ({ label, deals: count }))
    .sort((a, b) => b.deals - a.deals || a.label.localeCompare(b.label))
    .slice(0, OWNERS_LISTED);

  const stageName = new Map(
    pipelines.flatMap((p) => p.stages.map((stage) => [stage.id, stage.name] as const)),
  );
  const report = dailyDealReport(deals, now);

  return {
    isEmpty: deals.length === 0 && followUps.length === 0,
    kpis: {
      pipelineValue: kpis.pipelineValue,
      openDeals: kpis.openDeals,
      winRate: kpis.winRate,
      wonThisMonth: sumValue(wonThisMonth),
    },
    trend: weeklyDealTrend(deals, now),
    pipelineName: pipeline?.name ?? null,
    stages,
    owners,
    closingSoon: report.closingSoon.map((deal) => ({
      id: deal.id,
      name: dealName(deal),
      stage: stageName.get(deal.stageId) ?? '',
      value: deal.value,
      closes: deal.expectedClose ? formatDay(deal.expectedClose, { year: false }) : '',
    })),
    closingSoonTotal: report.closingSoonTotal,
    followUps: followUps.map((followUp) => ({
      id: followUp.id,
      title: followUp.title,
      due:
        followUp.dueDay === null
          ? 'No date'
          : followUp.dueDay === today
            ? 'Today'
            : formatDay(followUp.dueDay, { year: false }),
      // Dates are `YYYY-MM-DD`, which compares as text.
      overdue: followUp.dueDay !== null && followUp.dueDay < today,
    })),
    activity: recentCrmActivity(deals, recent.contacts, recent.activities, now),
  };
}

/** The newest contacts, and the newest logged work and follow-ups done, for "Recent activity". */
async function listRecent(client: SupabaseClient, orgId: string): Promise<OverviewRecent> {
  const [contacts, logged, done] = await Promise.all([
    client
      .from('crm_contacts')
      .select('first_name,last_name,source,created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(ACTIVITY_LISTED),
    client
      .from('crm_activities')
      .select('type,title,created_at,completed_at')
      .eq('org_id', orgId)
      .in('type', Object.keys(LOGGED_LABELS))
      .order('created_at', { ascending: false })
      .limit(ACTIVITY_LISTED),
    client
      .from('crm_activities')
      .select('type,title,created_at,completed_at')
      .eq('org_id', orgId)
      .eq('type', 'task')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(ACTIVITY_LISTED),
  ]);
  for (const result of [contacts, logged, done]) if (result.error) throw result.error;

  type ContactRow = { first_name: string; last_name: string | null; source: string | null; created_at: string };
  type WorkRow = { type: string; title: string; created_at: string; completed_at: string | null };
  return {
    contacts: ((contacts.data ?? []) as ContactRow[]).map((row) => ({
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      source: row.source,
      createdAt: row.created_at,
    })),
    activities: [...((logged.data ?? []) as WorkRow[]), ...((done.data ?? []) as WorkRow[])].map((row) => ({
      type: row.type,
      title: row.title,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
  };
}

/** The next open follow-ups in a workspace, soonest due first with undated ones last. */
async function listNextFollowUps(client: SupabaseClient, orgId: string): Promise<OverviewFollowUp[]> {
  const { data, error } = await client
    .from('crm_activities')
    .select('id,title,due_at')
    .eq('org_id', orgId)
    .eq('type', 'task')
    .is('completed_at', null)
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(FOLLOW_UPS_LISTED);
  if (error) throw error;
  return ((data ?? []) as { id: string; title: string; due_at: string | null }[]).map((row) => ({
    id: row.id,
    title: row.title,
    // A follow-up's due date is stored as midnight UTC of the chosen day.
    dueDay: row.due_at ? row.due_at.slice(0, 10) : null,
  }));
}

/** Reads a workspace's deals, pipelines and follow-ups and builds the dashboard from them. */
export async function loadCrmOverview(
  client: SupabaseClient,
  orgId: string,
  now: Date,
): Promise<CrmOverviewModel> {
  const [{ deals }, pipelines, followUps, recent] = await Promise.all([
    listCrmDeals(client, orgId, 500),
    listCrmPipelines(client, orgId),
    listNextFollowUps(client, orgId),
    listRecent(client, orgId),
  ]);
  return buildCrmOverview(deals, pipelines, followUps, now, recent);
}
