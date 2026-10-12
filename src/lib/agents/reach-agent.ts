import type { SupabaseClient } from '@supabase/supabase-js';
import { entry, type AgentDefinition, type Candidate, type MediaContext } from '@/lib/agents/definition';
import {
  createAppointment,
  createAppointmentInput,
  createForm,
  createFormInput,
  promoteLeadToContact,
  promoteLeadToContactInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
  setLeadStage,
  setLeadStageInput,
  updateAppointment,
  updateAppointmentInput,
  updateForm,
  updateFormInput,
} from '@/lib/reach/capabilities';
import { opportunityScan } from '@/lib/agents/proposer';
import { generateImage, startVideo } from '@/lib/agents/openrouter-media';
import { IMAGE_ESTIMATE_CENTS, VIDEO_ESTIMATE_CENTS, costOr } from '@/lib/agents/costs';
import { WEEKLY_STUDIO } from '@/lib/agents/types';
import { createSupabaseReachData } from '@/lib/reach/supabase';
import { deriveReportsModel, type ReportsModel } from '@/lib/reach/reports';
import type { Lead, Appointment, Campaign } from '@/lib/reach/types';

export type ReachRaw = { leads: Lead[]; appts: Appointment[]; campaigns: Campaign[] };

/** How long after any form proposal (any status) before the agent may offer another. */
const FORM_PROPOSAL_COOLDOWN_MS = 30 * 24 * 3600_000;

const IMAGE_STEPS: { kind: 'poster' | 'image'; prompt: (context: string) => string }[] = [
  {
    kind: 'poster',
    prompt: (c) =>
      `A clean, eye-catching promotional poster for a small business, vertical layout, bold headline area, no small text. Business snapshot:\n${c}`,
  },
  {
    kind: 'image',
    prompt: (c) =>
      `A wide hero image for a weekly marketing update, modern and warm, no text. Business snapshot:\n${c}`,
  },
];

function summarize(model: ReportsModel): string {
  const f = model.funnel;
  const channels = model.topChannels
    .map((c) => `${c.channel} ${c.leads} leads (${c.conv_pct}% qualified)`)
    .join(', ');
  const a = model.appointmentStats;
  return [
    `Last 7 days: ${model.totalLeads} new leads.`,
    `Funnel: ${f.lead} lead, ${f.contacted} contacted, ${f.qualified} qualified, ${f.booked} booked, ${f.won} won.`,
    `Top channels: ${channels || 'none yet'}.`,
    `Appointments: ${a.scheduled} scheduled, ${a.completed} completed, ${a.cancelled} cancelled, ${a.no_show} no-show.`,
  ].join('\n');
}

/**
 * True when no createForm proposal (any status) exists in the cooldown window. The model
 * names each form differently, so a name-based dedupe can't stop weekly re-offers on its
 * own; this is the real gate. Fails closed: a query error means "do not offer".
 */
async function noRecentFormProposal(service: SupabaseClient, orgId: string): Promise<boolean> {
  const since = new Date(Date.now() - FORM_PROPOSAL_COOLDOWN_MS).toISOString();
  const { data, error } = await service
    .from('agent_proposals')
    .select('id')
    .eq('org_id', orgId)
    .eq('action', 'createForm')
    .gte('created_at', since)
    .limit(1);
  if (error) return false;
  return (data ?? []).length === 0;
}

/**
 * The reach / "Weekly Studio" autonomous agent, expressed as an {@link AgentDefinition}.
 * This is the behavior-preserving home for what used to live inline in weekly-studio.ts +
 * proposer.ts. Registered in the static {@link import('@/lib/agents/registry').AGENTS} map.
 */
export const reachAgent: AgentDefinition = {
  agentKey: WEEKLY_STUDIO,
  product: 'reach',

  async buildContext(service, orgId) {
    const data = createSupabaseReachData(service, orgId);
    const [campaigns, leads, appts] = await Promise.all([
      data.listCampaigns(),
      data.listLeads(),
      data.listAppointments(),
    ]);
    const context = summarize(deriveReportsModel(leads, campaigns, appts, '7d', new Date()));
    const raw: ReachRaw = { leads, appts, campaigns };
    return { context, raw };
  },

  scan(raw, now) {
    const { leads, appts } = raw as ReachRaw;
    return opportunityScan(leads, appts, now);
  },

  // Rule 4: offer ONE draft lead-capture form for the model to NAME after the week's trend,
  // when there is a trend and none was proposed in the cooldown window. The model supplies
  // only the name; channel/status stay server-locked in the proposer's insert path.
  async extraCandidates(service, orgId, built): Promise<Candidate[]> {
    if (!built.trend) return [];
    if (!(await noRecentFormProposal(service, orgId))) return [];
    return [
      {
        action: 'createForm',
        input: {},
        title: "Create a draft lead-capture form for this week's trend",
        detail: null,
        fillName: true,
      },
    ];
  },

  async hasNewData(service, orgId, since) {
    for (const table of ['leads', 'campaigns', 'appointments']) {
      const { data } = await service
        .from(table)
        .select('id')
        .eq('org_id', orgId)
        .gt('created_at', since)
        .limit(1)
        .maybeSingle();
      if (data) return true;
    }
    return false;
  },

  actions: {
    promoteLeadToContact: entry(promoteLeadToContactInput, promoteLeadToContact),
    setLeadStage: entry(setLeadStageInput, setLeadStage),
    createAppointment: entry(createAppointmentInput, createAppointment),
    updateAppointment: entry(updateAppointmentInput, updateAppointment),
    setAppointmentStatus: entry(setAppointmentStatusInput, setAppointmentStatus),
    createForm: entry(createFormInput, createForm),
    updateForm: entry(updateFormInput, updateForm),
  },

  buildWriteContext(client, orgId) {
    return { client, orgId };
  },

  research: {
    prompt: (context) =>
      `Find 3 timely, practical marketing angles for a small business this week. Business snapshot:\n${context}`,
  },

  digest: {
    prompt: (context, research) =>
      `Write a short weekly digest in markdown for the business owner.\n\nBusiness snapshot:\n${context}\n\nMarket angles:\n${research ?? ''}`,
  },

  async media(mctx: MediaContext): Promise<{ cost_cents: number }> {
    const { apiKey, context, maxCost, costSoFar, reserve, service, orgId, runId } = mctx;
    let cost = costSoFar;

    const recordAsset = async (
      kind: 'poster' | 'image',
      status: 'done' | 'failed',
      storage_path: string | null,
    ) => {
      // supabase-js returns { error } rather than throwing; a failed write just means the
      // asset is not recorded. Bookkeeping must never abort the run.
      const { error } = await service
        .from('agent_run_assets')
        .insert({ org_id: orgId, run_id: runId, kind, status, storage_path });
      void error;
    };

    for (const step of IMAGE_STEPS) {
      // Gate each paid step: stop before anything that could exceed the cap.
      if (cost + IMAGE_ESTIMATE_CENTS > maxCost) break;
      const path = `${orgId}/${runId}/${step.kind}.png`;
      await reserve(cost + IMAGE_ESTIMATE_CENTS);
      try {
        const img = await generateImage(apiKey, step.prompt(context));
        cost += costOr(img.cost_cents, IMAGE_ESTIMATE_CENTS);
        const { error: upErr } = await service.storage
          .from('agent-assets')
          .upload(path, img.bytes, { contentType: img.contentType, upsert: true });
        if (upErr) throw new Error('upload failed');
        await recordAsset(step.kind, 'done', path);
      } catch {
        // Deliberately drop the exception: it may carry request details or a key.
        await recordAsset(step.kind, 'failed', null);
      }
    }

    // Video is async: only kick it off here and store a pending asset; pollVideos finalizes it.
    if (cost + VIDEO_ESTIMATE_CENTS <= maxCost) {
      await reserve(cost + VIDEO_ESTIMATE_CENTS);
      try {
        const video = await startVideo(
          apiKey,
          `A short, upbeat 6-second promotional clip for a small business's weekly marketing update, no text overlays. Business snapshot:\n${context}`,
        );
        // The real cost is only known when the clip finishes, after this run has ended. Book
        // it now (the estimate, unless submit already named a figure) on both the run and the
        // asset; pollVideos settles the difference later.
        const videoCost = Math.round(costOr(video.cost_cents, VIDEO_ESTIMATE_CENTS));
        cost += videoCost;
        // A failed insert (returned as { error }) just means the clip is not tracked.
        const { error: videoInsertErr } = await service.from('agent_run_assets').insert({
          org_id: orgId,
          run_id: runId,
          kind: 'video',
          status: 'pending',
          provider_job_id: video.jobId,
          cost_cents: videoCost,
          cost_estimated: true,
        });
        void videoInsertErr;
      } catch {
        // Deliberately drop the exception: it may carry request details or a key.
      }
    }

    return { cost_cents: cost - costSoFar };
  },

  ui: {
    title: 'Weekly Studio',
    subtitle: 'Drafts a weekly content digest with poster ideas',
    screenPath: '/reach/agents',
    assetKinds: ['poster', 'image', 'video'] as const,
  },
};
