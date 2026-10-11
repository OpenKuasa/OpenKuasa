import type { SupabaseClient } from '@supabase/supabase-js';
import { generateImage, startVideo, webSearch, writeDigest } from '@/lib/agents/openrouter-media';
import {
  IMAGE_ESTIMATE_CENTS,
  TEXT_ESTIMATE_CENTS,
  VIDEO_ESTIMATE_CENTS,
  costOr,
} from '@/lib/agents/costs';
import { proposeChanges } from '@/lib/agents/proposer';
import {
  RunInProgressError,
  WEEKLY_STUDIO,
  type AgentRunStatus,
  type AgentRunTrigger,
} from '@/lib/agents/types';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';
import { createSupabaseReachData } from '@/lib/reach/supabase';
import { deriveReportsModel, type ReportsModel } from '@/lib/reach/reports';

const DEFAULT_MAX_COST_CENTS = 200;

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

export type WeeklyStudioResult = { runId: string; status: AgentRunStatus };

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
 * Runs one org's weekly digest and persists it as an agent_runs row.
 * `service` MUST be the service-role client; `orgId` is a TRUSTED argument the
 * caller has already authorized, and the caller has already passed the start gate
 * (`startRefusal` in runner.ts). Throws {@link RunInProgressError} when the
 * workspace already has a run in progress. Never logs or returns the key or ciphertext.
 */
export async function runWeeklyStudio(
  service: SupabaseClient,
  orgId: string,
  trigger: AgentRunTrigger,
): Promise<WeeklyStudioResult> {
  const { data: run, error: insertErr } = await service
    .from('agent_runs')
    .insert({ org_id: orgId, agent_key: WEEKLY_STUDIO, status: 'running', trigger })
    .select()
    .single();
  // This insert is also the claim. The database keeps at most one 'running' row per
  // workspace (agent_runs_one_running_uniq), so of any number of concurrent starts
  // exactly one gets a row; the rest are refused here, before anything is spent.
  if (insertErr?.code === '23505') throw new RunInProgressError();
  if (insertErr || !run) {
    // The insert is a DB write (no API key involved), so its SQLSTATE and message
    // are safe to log and are the only trace of why a run never started -- e.g. a
    // missing service_role grant surfaces here as code '42501' / "permission denied".
    console.error('[weekly-studio] agent_runs insert failed:', insertErr?.code, insertErr?.message);
    throw new Error('Could not start the agent run.');
  }
  const runId = run.id as string;

  const finish = async (
    status: 'done' | 'failed',
    patch: { digest_md?: string; cost_cents?: number; error?: string },
  ): Promise<WeeklyStudioResult> => {
    const base = { status, finished_at: new Date().toISOString(), ...patch };
    const write = (row: Record<string, unknown>) =>
      service.from('agent_runs').update(row).eq('org_id', orgId).eq('id', runId);
    const { cost_cents: cost, ...withoutCost } = base;
    const { error } = await write(
      typeof cost === 'number' ? { ...withoutCost, cost_cents: Math.round(cost) } : withoutCost,
    );
    // supabase-js returns { error } rather than throwing. If the cost column write
    // was rejected, retry without it so the run never stays stuck at 'running'.
    if (error && typeof cost === 'number') await write(withoutCost);
    return { runId, status };
  };

  // What this run has spent so far, as far as it is known: each paid step adds the
  // provider's figure, or the step's estimate when the provider gave none.
  let cost = 0;
  // Before each paid step, write the spend so far plus that step's estimate to the
  // row. A run that is cut off mid-step (and later reaped as timed out) then still
  // shows what it had spent and was about to spend, instead of zero. Bookkeeping
  // only: a failed write must never abort the run.
  const reserve = async (estimateCents: number) => {
    const { error } = await service
      .from('agent_runs')
      .update({ cost_cents: Math.round(cost + estimateCents) })
      .eq('org_id', orgId)
      .eq('id', runId)
      .eq('status', 'running');
    void error;
  };

  try {
    // The key opens only for the workspace this run belongs to.
    const stored = await readWorkspaceKey(service, orgId);
    const apiKey = stored.status === 'ok' ? stored.apiKey : null;
    if (!apiKey) return await finish('failed', { error: 'no AI key' });

    const { data: capRow } = await service
      .from('agent_configs')
      .select('max_cost_cents')
      .eq('org_id', orgId)
      .eq('agent_key', WEEKLY_STUDIO)
      .maybeSingle();
    const maxCost =
      typeof capRow?.max_cost_cents === 'number' ? capRow.max_cost_cents : DEFAULT_MAX_COST_CENTS;

    const data = createSupabaseReachData(service, orgId);
    const [campaigns, leads, appts] = await Promise.all([
      data.listCampaigns(),
      data.listLeads(),
      data.listAppointments(),
    ]);
    const context = summarize(deriveReportsModel(leads, campaigns, appts, '7d', new Date()));

    await reserve(TEXT_ESTIMATE_CENTS);
    const search = await webSearch(
      apiKey,
      `Find 3 timely, practical marketing angles for a small business this week. Business snapshot:\n${context}`,
    );
    cost += costOr(search.cost_cents, TEXT_ESTIMATE_CENTS);

    await reserve(TEXT_ESTIMATE_CENTS);
    const digest = await writeDigest(
      apiKey,
      `Write a short weekly digest in markdown for the business owner.\n\nBusiness snapshot:\n${context}\n\nMarket angles:\n${search.text}`,
    );
    cost += costOr(digest.cost_cents, TEXT_ESTIMATE_CENTS);

    const recordAsset = async (
      kind: 'poster' | 'image',
      status: 'done' | 'failed',
      storage_path: string | null,
    ) => {
      // supabase-js returns { error } rather than throwing; a failed write just
      // means the asset is not recorded. Bookkeeping must never abort the run.
      const { error } = await service
        .from('agent_run_assets')
        .insert({ org_id: orgId, run_id: runId, kind, status, storage_path });
      void error;
    };

    for (const step of IMAGE_STEPS) {
      // Gate each paid step: stop before anything that could exceed the cap.
      if (cost + IMAGE_ESTIMATE_CENTS > maxCost) break;
      const path = `${orgId}/${runId}/${step.kind}.png`;
      await reserve(IMAGE_ESTIMATE_CENTS);
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
      await reserve(VIDEO_ESTIMATE_CENTS);
      try {
        const video = await startVideo(
          apiKey,
          `A short, upbeat 6-second promotional clip for a small business's weekly marketing update, no text overlays. Business snapshot:\n${context}`,
        );
        // The real cost is only known when the clip finishes, after this run has
        // ended. Book it now (the estimate, unless submit already named a figure) on
        // both the run and the asset; pollVideos settles the difference later.
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

    // Autonomous proposals (5b/5c): suggest non-destructive changes for the owner to approve.
    await reserve(TEXT_ESTIMATE_CENTS);
    try {
      const prop = await proposeChanges(
        service,
        orgId,
        runId,
        apiKey,
        { leads, appts, context, trend: search.text },
        maxCost,
        cost,
      );
      cost += prop.cost_cents;
    } catch {
      // Deliberately drop the exception: it may carry request details or a key.
    }

    return await finish('done', { digest_md: digest.text, cost_cents: cost });
  } catch {
    // Deliberately drop the exception: it may carry request details or a key.
    // The steps that completed before the failure were still paid for.
    return finish('failed', { error: 'digest failed', cost_cents: cost });
  }
}
