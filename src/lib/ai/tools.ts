/**
 * Jebat data tools (Layer 3 of the Ask-Jebat agent).
 *
 * Each tool reads through the {@link ReachData} seam, so swapping the seed
 * provider for an RLS-scoped Supabase one (data slice) needs no change here.
 * The `org_id` is never taken from the model — isolation is the provider's job.
 *
 * The derivation helpers are pure and take an explicit `now`, so the funnel /
 * channel / trend / conversion math is unit-tested without the model or a clock.
 */

import { tool } from 'ai';
import { limitSchema, rowLimit } from '@/lib/ai/limits';
import { rm } from '@/lib/reach/format';
import { z } from 'zod';
import { createSchedule as capCreateSchedule, createScheduleInput } from '@/lib/reach/schedule-capabilities';
import {
  type ReachWriteContext,
  createAppointment as capCreateAppointment,
  createAppointmentInput,
  createCampaign as capCreateCampaign,
  createCampaignInput,
  createCreative as capCreateCreative,
  createCreativeInput,
  createForm as capCreateForm,
  createFormInput,
  createLead as capCreateLead,
  createLeadInput,
  deleteAppointment as capDeleteAppointment,
  deleteAppointmentInput,
  deleteCampaign as capDeleteCampaign,
  deleteCampaignInput,
  deleteCreative as capDeleteCreative,
  deleteCreativeInput,
  deleteForm as capDeleteForm,
  deleteFormInput,
  deleteLead as capDeleteLead,
  deleteLeadInput,
  promoteLeadToContact as capPromoteLeadToContact,
  promoteLeadToContactInput,
  setAppointmentStatus as capSetAppointmentStatus,
  setAppointmentStatusInput,
  setCampaignStatus as capSetCampaignStatus,
  setCampaignStatusInput,
  setFormStatus as capSetFormStatus,
  setFormStatusInput,
  setLeadStage as capSetLeadStage,
  setLeadStageInput,
  updateAdSettings as capUpdateAdSettings,
  updateAppointment as capUpdateAppointment,
  updateAppointmentInput,
  updateAdSettingsInput,
  updateCampaign as capUpdateCampaign,
  updateCampaignInput,
  updateCreative as capUpdateCreative,
  updateCreativeInput,
  updateForm as capUpdateForm,
  updateFormInput,
  updateLead as capUpdateLead,
  updateLeadInput,
} from '@/lib/reach/capabilities';
import {
  type Appointment,
  type Automation,
  type Broadcast,
  type Campaign,
  type Channel,
  type Creative,
  type CreativeType,
  type Form,
  type Lead,
  LEAD_STAGES,
  type LeadStage,
  type ReachData,
} from '@/lib/reach/types';

export { rm } from '@/lib/reach/format';

const DAY_MS = 24 * 60 * 60 * 1000;

function stageRank(stage: LeadStage): number {
  return LEAD_STAGES.indexOf(stage);
}

function withinWindow(lead: Lead, now: Date, sinceDays?: number): boolean {
  if (sinceDays == null) return true;
  const age = now.getTime() - new Date(lead.created_at).getTime();
  return age <= sinceDays * DAY_MS;
}

export type LeadSummary = {
  total_leads: number;
  /** Count of leads that *reached* each stage (the funnel). */
  funnel: Record<LeadStage, number>;
  by_channel: Record<Channel, number>;
  /** won ÷ total, as a 0–100 percentage rounded to 1 dp. */
  conversion_pct: number;
  /** Oldest → newest, 8 buckets. `qualified` = reached qualified+ that week. */
  weekly_trend: Array<{ weeks_ago: number; leads: number; qualified: number }>;
  since_days: number | null;
};

export function deriveLeadSummary(
  leads: Lead[],
  now: Date,
  sinceDays?: number,
): LeadSummary {
  const scoped = leads.filter((l) => withinWindow(l, now, sinceDays));

  const funnel = Object.fromEntries(
    LEAD_STAGES.map((stage) => [
      stage,
      scoped.filter((l) => stageRank(l.stage) >= stageRank(stage)).length,
    ]),
  ) as Record<LeadStage, number>;

  const by_channel = scoped.reduce(
    (acc, l) => {
      acc[l.channel] = (acc[l.channel] ?? 0) + 1;
      return acc;
    },
    { whatsapp: 0, facebook: 0, instagram: 0, tiktok: 0 } as Record<Channel, number>,
  );

  const total = scoped.length;
  const conversion_pct = total === 0 ? 0 : Math.round((funnel.won / total) * 1000) / 10;

  const WEEKS = 8;
  const weekly_trend = Array.from({ length: WEEKS }, (_, i) => {
    const weeksAgo = WEEKS - 1 - i;
    const inWeek = scoped.filter((l) => {
      const age = now.getTime() - new Date(l.created_at).getTime();
      const w = Math.floor(age / (7 * DAY_MS));
      return w === weeksAgo;
    });
    return {
      weeks_ago: weeksAgo,
      leads: inWeek.length,
      qualified: inWeek.filter((l) => stageRank(l.stage) >= stageRank('qualified')).length,
    };
  });

  return {
    total_leads: total,
    funnel,
    by_channel,
    conversion_pct,
    weekly_trend,
    since_days: sinceDays ?? null,
  };
}

export type SpendByChannel = {
  by_channel: Array<{ channel: Channel; spend_cents: number; spend: string }>;
  total_spend_cents: number;
  total_spend: string;
};

export function deriveSpendByChannel(campaigns: Campaign[]): SpendByChannel {
  const totals = campaigns.reduce(
    (acc, c) => {
      acc[c.channel] = (acc[c.channel] ?? 0) + c.spend_cents;
      return acc;
    },
    {} as Partial<Record<Channel, number>>,
  );
  const by_channel = (Object.entries(totals) as [Channel, number][])
    .map(([channel, spend_cents]) => ({ channel, spend_cents, spend: rm(spend_cents) }))
    .sort((a, b) => b.spend_cents - a.spend_cents);
  const total_spend_cents = by_channel.reduce((a, c) => a + c.spend_cents, 0);
  return { by_channel, total_spend_cents, total_spend: rm(total_spend_cents) };
}

export function summarizeCampaigns(
  campaigns: Campaign[],
  status?: 'active' | 'paused',
) {
  return campaigns
    .filter((c) => (status ? c.status === status : true))
    .map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status,
      leads: c.leads_count,
      spend_cents: c.spend_cents,
      spend: rm(c.spend_cents),
      cpl_cents: c.cpl_cents,
      cpl: c.cpl_cents == null ? '—' : rm(c.cpl_cents),
    }))
    .sort((a, b) => (a.cpl_cents ?? Infinity) - (b.cpl_cents ?? Infinity));
}

/** '15 Oct 2026, 7:30 am': an appointment's time as people in Malaysia read it. */
function malaysiaTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kuala_Lumpur',
  })
    .format(new Date(iso))
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]{3}\b(?= \d{4})/, (month) => month.charAt(0).toUpperCase() + month.slice(1));
}

export function filterUpcomingAppointments(
  appointments: Appointment[],
  now: Date,
  limit = 5,
) {
  return appointments
    .filter((a) => a.status === 'scheduled' && new Date(a.scheduled_at).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      contact_name: a.contact_name,
      kind: a.kind,
      via: a.via,
      status: a.status,
      scheduled_at: a.scheduled_at,
      // Said as given: the model must not shift a time it is told is already local.
      malaysia_time: malaysiaTime(a.scheduled_at),
    }));
}

export type AdsOverview = {
  total_spend_cents: number;
  total_spend: string;
  total_leads: number;
  blended_cpl_cents: number;
  blended_cpl: string;
  active_campaigns: number;
  paused_campaigns: number;
};

/** Account-wide ad totals; blended CPL = total spend ÷ total platform-reported leads. */
export function deriveAdsOverview(campaigns: Campaign[]): AdsOverview {
  const total_spend_cents = campaigns.reduce((a, c) => a + c.spend_cents, 0);
  const total_leads = campaigns.reduce((a, c) => a + c.leads_count, 0);
  const blended_cpl_cents = total_leads === 0 ? 0 : Math.round(total_spend_cents / total_leads);
  return {
    total_spend_cents,
    total_spend: rm(total_spend_cents),
    total_leads,
    blended_cpl_cents,
    blended_cpl: rm(blended_cpl_cents),
    active_campaigns: campaigns.filter((c) => c.status === 'active').length,
    paused_campaigns: campaigns.filter((c) => c.status === 'paused').length,
  };
}

/** CRM contacts derived from leads, newest first, optionally filtered. */
export function deriveContacts(
  leads: Lead[],
  opts: { stage?: LeadStage; channel?: Channel; limit?: number } = {},
) {
  const { stage, channel, limit = 10 } = opts;
  return leads
    .filter((l) => (stage ? l.stage === stage : true))
    .filter((l) => (channel ? l.channel === channel : true))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)
    .map((l) => ({
      id: l.id,
      name: l.name,
      channel: l.channel,
      stage: l.stage,
      source: l.source,
      promoted_contact_id: l.promoted_contact_id,
      created_at: l.created_at,
    }));
}

export function summarizeForms(forms: Form[], limit = 10) {
  return [...forms]
    .sort((a, b) => b.submissions_count - a.submissions_count)
    .slice(0, limit)
    .map((f) => ({
      id: f.id,
      name: f.name,
      category: f.category,
      slug: f.slug,
      channel: f.channel,
      views: f.views_count,
      submissions: f.submissions_count,
      status: f.status,
    }));
}

/** Broadcasts newest first. */
export function summarizeBroadcasts(broadcasts: Broadcast[], limit = 10) {
  return [...broadcasts]
    .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
    .slice(0, limit)
    .map((b) => ({
      name: b.name,
      channel: b.channel,
      sent: b.sent_count,
      opened: b.opened_count,
      clicked: b.clicked_count,
      open_rate_pct: b.sent_count === 0 ? 0 : Math.round((b.opened_count / b.sent_count) * 1000) / 10,
      sent_at: b.sent_at,
    }));
}

export function summarizeAutomations(automations: Automation[], limit = 10) {
  return [...automations]
    .sort((a, b) => b.runs_count - a.runs_count)
    .slice(0, limit)
    .map((a) => ({
      name: a.name,
      trigger: a.trigger,
      status: a.status,
      runs: a.runs_count,
    }));
}

export function summarizeCreatives(
  creatives: Creative[],
  opts: { type?: CreativeType; limit?: number } = {},
) {
  const { type, limit = 20 } = opts;
  return creatives
    .filter((c) => (type ? c.type === type : true))
    .slice(0, limit)
    .map((c) => ({ id: c.id, name: c.name, type: c.type, channel: c.channel, status: c.status, ctr: c.ctr }));
}


/**
 * Who may change marketing data in this chat. `canManageAgents` (owner/admin)
 * additionally unlocks the tools that commit the workspace to recurring AI spend.
 */
export type ReachWrite = { ctx: ReachWriteContext; canWrite: boolean; canManageAgents?: boolean };

/**
 * Build all Jebat read-only data tools over a {@link ReachData} provider. `now`
 * (a Date or a clock function) is injectable for tests; the route uses the real clock.
 */
export function createReachTools(
  data: ReachData,
  nowArg: Date | (() => Date) = () => new Date(),
  write?: ReachWrite,
) {
  const now = typeof nowArg === 'function' ? nowArg : () => nowArg;
  const read = {
    getCampaigns: tool({
      description:
        'List the org’s ad campaigns with leads, spend and cost-per-lead (RM). ' +
        'Sorted by cost-per-lead ascending (cheapest first). Optionally filter by status.',
      inputSchema: z.object({
        status: z
          .enum(['active', 'paused'])
          .optional()
          .describe('Only return campaigns with this status.'),
      }),
      execute: async ({ status }) => summarizeCampaigns(await data.listCampaigns(), status),
    }),

    getLeadSummary: tool({
      description:
        'Aggregate CRM leads into totals, the funnel (leads→contacted→qualified→booked→won), ' +
        'leads by channel, conversion rate and an 8-week trend. Optionally scope to the last N days.',
      inputSchema: z.object({
        sinceDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only count leads created within this many days.'),
      }),
      execute: async ({ sinceDays }) =>
        deriveLeadSummary(await data.listLeads(), now(), sinceDays),
    }),

    getSpendByChannel: tool({
      description: 'Total ad spend (RM) broken down by channel, highest first.',
      inputSchema: z.object({}),
      execute: async () => deriveSpendByChannel(await data.listCampaigns()),
    }),

    getUpcomingAppointments: tool({
      description:
        'The org’s upcoming appointments (discovery calls, demos, follow-ups), soonest first. ' +
        'malaysia_time is when each one is, in Malaysian time: say that to the user as given. scheduled_at is the same moment in UTC.',
      inputSchema: z.object({
        limit: limitSchema('Max appointments to return (default 5, at most 20).'),
      }),
      execute: async ({ limit }) =>
        filterUpcomingAppointments(await data.listAppointments(), now(), rowLimit(limit, 5, 20)),
    }),

    getAdsOverview: tool({
      description:
        'Overall ad performance: total spend (RM), total leads, blended cost-per-lead and the count of active vs paused campaigns.',
      inputSchema: z.object({}),
      execute: async () => deriveAdsOverview(await data.listCampaigns()),
    }),

    listContacts: tool({
      description:
        'Recent CRM contacts (derived from leads), newest first: name, channel, stage, source, created_at. Optionally filter by stage or channel.',
      inputSchema: z.object({
        stage: z.enum(LEAD_STAGES as [LeadStage, ...LeadStage[]]).optional().describe('Only contacts at this stage.'),
        channel: z.enum(['whatsapp', 'facebook', 'instagram', 'tiktok']).optional().describe('Only contacts from this channel.'),
        limit: limitSchema('Max contacts to return (default 10, at most 50).'),
      }),
      execute: async ({ stage, channel, limit }) =>
        deriveContacts(await data.listLeads(), { stage, channel, limit: rowLimit(limit, 10) }),
    }),

    listForms: tool({
      description:
        'Lead-capture forms with id, category, link (slug), status, views and submissions count, most submissions first.',
      inputSchema: z.object({ limit: limitSchema('Max forms to return (default 10, at most 50).') }),
      execute: async ({ limit }) => summarizeForms(await data.listForms(), rowLimit(limit, 10)),
    }),

    listBroadcasts: tool({
      description: 'Email / WhatsApp broadcasts with sent, opened, clicked counts and sent date, newest first.',
      inputSchema: z.object({ limit: limitSchema('Max broadcasts to return (default 10, at most 50).') }),
      execute: async ({ limit }) => summarizeBroadcasts(await data.listBroadcasts(), rowLimit(limit, 10)),
    }),

    listAutomations: tool({
      description: 'Automation workflows with trigger, status and number of runs, most runs first.',
      inputSchema: z.object({ limit: limitSchema('Max automations to return (default 10, at most 50).') }),
      execute: async ({ limit }) => summarizeAutomations(await data.listAutomations(), rowLimit(limit, 10)),
    }),

    getCreatives: tool({
      description: 'List the org’s ad creatives (image/video/copy) with channel, status and CTR. Optionally filter by type.',
      inputSchema: z.object({
        type: z.enum(['image', 'video', 'copy']).optional().describe('Only return creatives of this type.'),
        limit: limitSchema('Max creatives to return (default 20, at most 50).'),
      }),
      execute: async ({ type, limit }) =>
        summarizeCreatives(await data.listCreatives(), { type, limit: rowLimit(limit, 20) }),
    }),

    getAdSettings: tool({
      description: 'The org’s ad settings: budget caps (RM), currency, and automation/notification toggles.',
      inputSchema: z.object({}),
      execute: async () => {
        const s = await data.getAdSettings();
        if (!s) return { configured: false };
        return {
          configured: true,
          daily_cap: s.daily_cap_cents == null ? null : rm(s.daily_cap_cents),
          monthly_cap: s.monthly_cap_cents == null ? null : rm(s.monthly_cap_cents),
          currency: s.currency,
          automation: s.automation,
          notifications: s.notifications,
        };
      },
    }),
  };

  // A caller who cannot write gets no write tools at all (not merely gated ones).
  if (!write?.canWrite) return read;
  const ctx = write.ctx;

  const changes = {
    ...read,
    createCampaign: tool({
      description: 'Create a new ad campaign. Needs the owner’s approval before it is saved.',
      inputSchema: createCampaignInput,
      execute: async (input) => capCreateCampaign(ctx, input),
    }),
    updateCampaign: tool({
      description:
        'Edit an existing campaign by id (name, channel, status, spend or leads). Needs approval.',
      inputSchema: updateCampaignInput,
      execute: async (input) => capUpdateCampaign(ctx, input),
    }),
    setCampaignStatus: tool({
      description: 'Pause or resume a campaign by id. Needs approval.',
      inputSchema: setCampaignStatusInput,
      execute: async (input) => capSetCampaignStatus(ctx, input),
    }),
    deleteCampaign: tool({
      description: 'Delete a campaign by id. This cannot be undone and needs approval.',
      inputSchema: deleteCampaignInput,
      execute: async (input) => capDeleteCampaign(ctx, input),
    }),
    createCreative: tool({
      description: 'Create a new ad creative (image/video/copy). Needs approval.',
      inputSchema: createCreativeInput,
      execute: async (input) => capCreateCreative(ctx, input),
    }),
    updateCreative: tool({
      description: 'Edit a creative by id. Needs approval.',
      inputSchema: updateCreativeInput,
      execute: async (input) => capUpdateCreative(ctx, input),
    }),
    deleteCreative: tool({
      description: 'Delete a creative by id. Cannot be undone; needs approval.',
      inputSchema: deleteCreativeInput,
      execute: async (input) => capDeleteCreative(ctx, input),
    }),
    updateAdSettings: tool({
      description: 'Update the org’s ad settings (budget caps, currency, automation/notification toggles). Needs approval.',
      inputSchema: updateAdSettingsInput,
      execute: async (input) => capUpdateAdSettings(ctx, input),
    }),
    createForm: tool({
      description:
        'Create a lead form (name, optional category, link and status). Leave the link out to derive it from the name. Needs approval.',
      inputSchema: createFormInput,
      execute: async (input) => capCreateForm(ctx, input),
    }),
    updateForm: tool({
      description: 'Edit a lead form by id (name, category, link or status). Needs approval.',
      inputSchema: updateFormInput,
      execute: async (input) => capUpdateForm(ctx, input),
    }),
    setFormStatus: tool({
      description: 'Activate or pause a lead form by id, or move it back to draft. Needs approval.',
      inputSchema: setFormStatusInput,
      execute: async (input) => capSetFormStatus(ctx, input),
    }),
    deleteForm: tool({
      description: 'Delete a lead form by id. This cannot be undone and needs approval.',
      inputSchema: deleteFormInput,
      execute: async (input) => capDeleteForm(ctx, input),
    }),
    createLead: tool({
      description: 'Create a new lead. Needs the owner’s approval before it is saved.',
      inputSchema: createLeadInput,
      execute: async (input) => capCreateLead(ctx, input),
    }),
    updateLead: tool({
      description: 'Edit a lead by id (name, channel, stage, source). Needs approval.',
      inputSchema: updateLeadInput,
      execute: async (input) => capUpdateLead(ctx, input),
    }),
    setLeadStage: tool({
      description:
        'Move a lead to a funnel stage by id (lead→contacted→qualified→booked→won). Needs approval.',
      inputSchema: setLeadStageInput,
      execute: async (input) => capSetLeadStage(ctx, input),
    }),
    deleteLead: tool({
      description: 'Delete a lead by id. Cannot be undone; needs approval.',
      inputSchema: deleteLeadInput,
      execute: async (input) => capDeleteLead(ctx, input),
    }),
    promoteLeadToContact: tool({
      description: 'Promote a lead to a CRM contact by id. Creates a Kasturi contact. Needs approval.',
      inputSchema: promoteLeadToContactInput,
      execute: async (input) => capPromoteLeadToContact(ctx, input),
    }),
    createAppointment: tool({
      description:
        'Book an appointment. scheduled_at is UTC ISO 8601. Needs the owner’s approval before it is saved.',
      inputSchema: createAppointmentInput,
      execute: async (input) => capCreateAppointment(ctx, input),
    }),
    updateAppointment: tool({
      description:
        'Edit an appointment by id (contact, kind, time, channel). scheduled_at is UTC ISO 8601. Needs approval.',
      inputSchema: updateAppointmentInput,
      execute: async (input) => capUpdateAppointment(ctx, input),
    }),
    setAppointmentStatus: tool({
      description: 'Mark an appointment by id scheduled, completed, cancelled or no_show. Needs approval.',
      inputSchema: setAppointmentStatusInput,
      execute: async (input) => capSetAppointmentStatus(ctx, input),
    }),
    deleteAppointment: tool({
      description: 'Delete an appointment by id. Cannot be undone; needs approval.',
      inputSchema: deleteAppointmentInput,
      execute: async (input) => capDeleteAppointment(ctx, input),
    }),
  };
  // Recurring agent runs spend the workspace's key: owner/admin only.
  if (!write.canManageAgents) return changes;

  return {
    ...changes,
    scheduleWeeklyStudio: tool({
      description:
        'Schedule the Weekly Studio agent to run itself on a recurring interval. interval_seconds is the gap between runs (min 300 = 5 min); optional starts_at (UTC ISO), max_runs, end_at (UTC ISO), max_total_cents (per-schedule budget). Set nl_text to the user’s own phrasing. Needs the owner’s approval before it is saved.',
      inputSchema: createScheduleInput,
      execute: async (input) => capCreateSchedule(ctx, input),
    }),
  };
}

export type ReachTools = ReturnType<typeof createReachTools>;
