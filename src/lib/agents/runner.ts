import type { SupabaseClient } from '@supabase/supabase-js';
import { checkVideo } from '@/lib/agents/openrouter-media';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';
import { workspaceSpendCents } from '@/lib/agents/spend';
import { runWeeklyStudio } from '@/lib/agents/weekly-studio';
import { RunInProgressError, WEEKLY_STUDIO } from '@/lib/agents/types';

export type RunSchedulesSummary = {
  ran: number;
  skipped: number;
  paused: number;
  completed: number;
  failed: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

type OrgConfig = {
  enabled: boolean | null;
  daily_cap_cents: number | null;
  weekly_cap_cents: number | null;
};

type BudgetRefusal = 'daily budget reached' | 'weekly budget reached';

/** Why a run may not start now. */
export type StartRefusal = 'disabled' | BudgetRefusal;

/** Rolling-ceiling check. Returns a pause reason, or null if under budget. */
async function overBudget(
  client: SupabaseClient,
  orgId: string,
  caps: OrgConfig | null,
): Promise<BudgetRefusal | null> {
  const daily = caps?.daily_cap_cents ?? 500;
  const weekly = caps?.weekly_cap_cents ?? 2000;
  // Fail closed: workspaceSpendCents throws on an unreadable spend. For a schedule,
  // the per-schedule catch counts it failed and the next tick retries (no pause).
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  if ((await workspaceSpendCents(client, orgId, since(DAY_MS))) >= daily) {
    return 'daily budget reached';
  }
  if ((await workspaceSpendCents(client, orgId, since(7 * DAY_MS))) >= weekly) {
    return 'weekly budget reached';
  }
  return null;
}

async function readOrgConfig(client: SupabaseClient, orgId: string): Promise<OrgConfig | null> {
  const { data, error } = await client
    .from('agent_configs')
    .select('enabled, daily_cap_cents, weekly_cap_cents')
    .eq('org_id', orgId)
    .eq('agent_key', WEEKLY_STUDIO)
    .maybeSingle();
  // Fail closed: unreadable settings must not read as "no settings, defaults apply".
  if (error) throw new Error('config query failed');
  return (data as OrgConfig | null) ?? null;
}

/**
 * The one gate every run passes before it starts, scheduled or manual: the
 * workspace's off switch, then its rolling daily and weekly spend caps. Returns
 * why the run is refused, or null when it may start. A workspace with no saved
 * settings is not switched off and uses the default caps. Throws when the
 * settings or the spend cannot be read (callers treat that as "do not run").
 */
export async function startRefusal(
  client: SupabaseClient,
  orgId: string,
  config?: OrgConfig | null,
): Promise<StartRefusal | null> {
  const cfg = config === undefined ? await readOrgConfig(client, orgId) : config;
  if (cfg && cfg.enabled === false) return 'disabled';
  return overBudget(client, orgId, cfg);
}

/** Monitor-skip: has the org's reach data changed since `sinceIso`? */
async function hasNewDataSince(
  client: SupabaseClient,
  orgId: string,
  sinceIso: string,
): Promise<boolean> {
  for (const table of ['leads', 'campaigns', 'appointments']) {
    const { data } = await client
      .from(table)
      .select('id')
      .eq('org_id', orgId)
      .gt('created_at', sinceIso)
      .limit(1)
      .maybeSingle();
    if (data) return true;
  }
  return false;
}

type DueSchedule = {
  id: string;
  org_id: string;
  agent_key: string;
  interval_seconds: number;
  next_run_at: string;
  last_run_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  runs_used: number;
  max_total_cents: number | null;
  spent_cents: number;
};

/**
 * Schedule-driven driver. `client` MUST be the service-role client. Kill-switch:
 * does nothing unless AGENTS_ENABLED is 'true'/'1'. For each due active schedule:
 * finish it if its limits are spent, else check the workspace's rolling daily/weekly
 * ceilings BEFORE any run ({@link startRefusal}, the same gate "Run now" passes; over
 * budget pauses the org's active schedules), then CLAIM
 * it with a conditional update so overlapping ticks run it once. If nothing in the
 * org's reach data is new since the last run, record a cost-0 skipped run instead of
 * generating. The org always comes from the schedule row. One failure never stops the
 * loop and exception text is dropped (it may carry request details or a key).
 */
export async function runSchedules(client: SupabaseClient): Promise<RunSchedulesSummary> {
  const summary: RunSchedulesSummary = { ran: 0, skipped: 0, paused: 0, completed: 0, failed: 0 };
  const flag = (process.env.AGENTS_ENABLED ?? '').trim().toLowerCase();
  if (flag !== 'true' && flag !== '1') return summary;

  const nowIso = new Date().toISOString();
  const { data, error } = await client
    .from('agent_schedules')
    .select(
      'id, org_id, agent_key, interval_seconds, next_run_at, last_run_at, end_at, max_runs, runs_used, max_total_cents, spent_cents',
    )
    .eq('status', 'active')
    .lte('next_run_at', nowIso);
  if (error || !data) return summary;

  // Per-org Weekly Studio config, read once per org per tick.
  const configs = new Map<string, OrgConfig | null>();
  const configFor = async (orgId: string): Promise<OrgConfig | null> => {
    if (configs.has(orgId)) return configs.get(orgId) ?? null;
    const row = await readOrgConfig(client, orgId);
    configs.set(orgId, row);
    return row;
  };

  for (const s of data as DueSchedule[]) {
    try {
      // Off switch: leave the schedule untouched so re-enabling resumes it.
      // No config row keeps the default behavior (proceed).
      const config = await configFor(s.org_id);
      if (config && config.enabled === false) {
        summary.skipped += 1;
        continue;
      }

      const done =
        (s.max_runs != null && s.runs_used >= s.max_runs) ||
        (s.max_total_cents != null && s.spent_cents >= s.max_total_cents) ||
        (s.end_at != null && new Date(s.end_at) <= new Date());
      if (done) {
        await client
          .from('agent_schedules')
          .update({ status: 'completed', updated_at: nowIso })
          .eq('id', s.id)
          .eq('org_id', s.org_id)
          .eq('status', 'active');
        summary.completed += 1;
        continue;
      }

      const reason = await startRefusal(client, s.org_id, config);
      if (reason) {
        await client
          .from('agent_schedules')
          .update({ status: 'paused', paused_reason: reason, updated_at: nowIso })
          .eq('org_id', s.org_id)
          .eq('status', 'active');
        summary.paused += 1;
        continue;
      }

      const nextIso = new Date(Date.now() + s.interval_seconds * 1000).toISOString();
      const { data: claimed } = await client
        .from('agent_schedules')
        .update({ next_run_at: nextIso, paused_reason: null, updated_at: nowIso })
        .eq('id', s.id)
        .eq('status', 'active')
        .lte('next_run_at', nowIso)
        .select('id')
        .maybeSingle();
      if (!claimed) {
        summary.skipped += 1;
        continue;
      }

      if (s.last_run_at && !(await hasNewDataSince(client, s.org_id, s.last_run_at))) {
        await client.from('agent_runs').insert({
          org_id: s.org_id,
          agent_key: s.agent_key,
          status: 'skipped',
          trigger: 'schedule',
          cost_cents: 0,
          finished_at: nowIso,
        });
        await client
          .from('agent_schedules')
          .update({ last_run_at: nowIso, runs_used: s.runs_used + 1, updated_at: nowIso })
          .eq('id', s.id)
          .eq('org_id', s.org_id);
        summary.skipped += 1;
        continue;
      }

      let result: Awaited<ReturnType<typeof runWeeklyStudio>>;
      try {
        result = await runWeeklyStudio(client, s.org_id, 'schedule');
      } catch (e) {
        if (!(e instanceof RunInProgressError)) throw e;
        // The workspace already has a run in progress (e.g. a manual "Run now").
        // Hand the slot back so the next tick retries instead of losing an interval.
        await client
          .from('agent_schedules')
          .update({ next_run_at: s.next_run_at, updated_at: nowIso })
          .eq('id', s.id)
          .eq('org_id', s.org_id)
          .eq('next_run_at', nextIso);
        summary.skipped += 1;
        continue;
      }
      const { data: runRow } = await client
        .from('agent_runs')
        .select('cost_cents')
        .eq('id', result.runId)
        .maybeSingle();
      const cost = (runRow?.cost_cents as number | undefined) ?? 0;
      const runsUsed = s.runs_used + 1;
      const spent = s.spent_cents + cost;
      const nowDone =
        (s.max_runs != null && runsUsed >= s.max_runs) ||
        (s.max_total_cents != null && spent >= s.max_total_cents);
      await client
        .from('agent_schedules')
        .update({
          last_run_at: nowIso,
          runs_used: runsUsed,
          spent_cents: spent,
          // Never write 'active': a user may have paused/cancelled mid-run.
          ...(nowDone ? { status: 'completed' } : {}),
          updated_at: nowIso,
        })
        .eq('id', s.id)
        .eq('org_id', s.org_id)
        .eq('status', 'active');
      summary.ran += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * A run still in 'running' after this long is treated as dead and failed. "Run now"
 * executes the whole pipeline synchronously in a server action, so a platform/proxy
 * request timeout can kill the process between the run insert and finish(), stranding
 * the row at 'running'. A workspace has one run slot (a single 'running' row), so
 * this also bounds how long a dead run can hold it: it is freed once reaped.
 */
export const RUN_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Fails runs stuck in 'running' past {@link RUN_MAX_AGE_MS}. `client` MUST be the
 * service-role client. Idempotent: only status='running' rows older than the cutoff
 * are touched, so repeated sweeps are a no-op. Without `orgId` it is the global
 * background sweep (a bulk update across orgs is correct there: it is scoped by
 * status + age); with it, only that workspace's runs, so "Run now" can free a slot
 * a dead run still holds without waiting for the next poll.
 *
 * The cost is deliberately left as it is: a run writes what it has spent, plus the
 * estimate of the step it is on, before each paid step, so the reaped row already
 * holds its known-or-estimated spend.
 */
export async function reapStaleRuns(client: SupabaseClient, orgId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_MAX_AGE_MS).toISOString();
  const sweep = client
    .from('agent_runs')
    .update({ status: 'failed', error: 'timed out', finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('started_at', cutoff);
  const { error } = await (orgId ? sweep.eq('org_id', orgId) : sweep);
  void error; // supabase-js returns { error }; a failed sweep simply retries next poll.
}

/**
 * Marks pending proposals past their expires_at as 'expired'. `client` MUST be the
 * service-role client. A bulk cross-org update is correct here — a global background
 * sweep scoped by status + time, not by org. Idempotent: only pending+past rows move.
 */
export async function expireProposals(client: SupabaseClient): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client
    .from('agent_proposals')
    .update({ status: 'expired', decided_at: now })
    .eq('status', 'pending')
    .lte('expires_at', now);
  void error; // supabase-js returns { error }; a failed sweep simply retries next poll.
}

/** A video still pending after this long is given up on. */
const VIDEO_MAX_AGE_MS = 30 * 60 * 1000;

type PendingVideo = {
  id: string;
  org_id: string;
  run_id: string;
  provider_job_id: string | null;
  created_at: string;
  cost_cents: number | null;
  cost_estimated: boolean | null;
};

/**
 * Finalizes pending video assets. `client` MUST be the service-role client.
 * Only status='pending' videos are read, and each is transitioned at most once
 * per call, so re-polling finished assets is a no-op. Never logs or stores the
 * key or any exception text.
 *
 * A video's cost was booked as an estimate when it was submitted. Once the job has
 * ended and the provider says what it cost, that figure replaces the estimate on
 * the asset and the run's total moves by the difference (`agent_settle_video_cost`,
 * one transaction, applied once). When the provider says nothing, the estimate stands.
 */
export async function pollVideos(client: SupabaseClient): Promise<void> {
  const { data, error } = await client
    .from('agent_run_assets')
    .select('id, org_id, run_id, provider_job_id, created_at, cost_cents, cost_estimated')
    .eq('kind', 'video')
    .eq('status', 'pending');
  if (error || !data) return;

  const keys = new Map<string, string | null>();
  const keyFor = async (orgId: string): Promise<string | null> => {
    if (keys.has(orgId)) return keys.get(orgId) ?? null;
    // `orgId` is the asset row's own workspace; the key opens only for it.
    const stored = await readWorkspaceKey(client, orgId);
    const key = stored.status === 'ok' ? stored.apiKey : null;
    keys.set(orgId, key);
    return key;
  };

  const mark = async (
    asset: PendingVideo,
    patch: { status: 'done' | 'failed'; storage_path?: string },
  ) => {
    // supabase-js returns { error } rather than throwing; a failed write leaves the
    // asset pending so the next poll retries. Only pending assets may transition.
    const { error: markErr } = await client
      .from('agent_run_assets')
      .update(patch)
      .eq('id', asset.id)
      .eq('org_id', asset.org_id)
      .eq('status', 'pending');
    void markErr;
  };

  /**
   * True when the asset's cost is final or nothing is known to replace the estimate;
   * false when a reported cost could not be applied yet (the run is still writing
   * its own total, or the write failed) and the caller should try again next poll.
   */
  const settle = async (asset: PendingVideo, reported: number | null | undefined) => {
    if (!asset.cost_estimated || typeof reported !== 'number' || !Number.isFinite(reported)) {
      return true;
    }
    const { data: settled, error: settleErr } = await client.rpc('agent_settle_video_cost', {
      p_asset_id: asset.id,
      p_cost_cents: Math.max(0, Math.round(reported)),
    });
    return !settleErr && settled === true;
  };

  for (const asset of data as PendingVideo[]) {
    try {
      const expired = Date.now() - new Date(asset.created_at).getTime() > VIDEO_MAX_AGE_MS;
      const apiKey = await keyFor(asset.org_id);
      if (!apiKey || !asset.provider_job_id) {
        await mark(asset, { status: 'failed' });
        continue;
      }
      const check = await checkVideo(apiKey, asset.provider_job_id);
      // Settle the cost before the asset leaves 'pending' (only pending assets are
      // polled). If it cannot be settled yet, keep the asset pending and retry,
      // unless it has expired: then it is finished on its estimate.
      const ended = check.status === 'failed' || (check.status === 'done' && !!check.url);
      if (ended && !(await settle(asset, check.cost_cents)) && !expired) continue;
      if (check.status === 'failed') {
        await mark(asset, { status: 'failed' });
      } else if (check.status === 'done' && check.url) {
        const res = await fetch(check.url);
        if (!res.ok) throw new Error('download failed');
        const bytes = new Uint8Array(await res.arrayBuffer());
        const path = `${asset.org_id}/${asset.run_id}/video.mp4`;
        const { error: upErr } = await client.storage
          .from('agent-assets')
          .upload(path, bytes, { contentType: 'video/mp4', upsert: true });
        if (upErr) throw new Error('upload failed');
        await mark(asset, { status: 'done', storage_path: path });
      } else if (expired) {
        // Still rendering, or done without a url, past the max age: time out.
        await mark(asset, { status: 'failed' });
      }
    } catch {
      // Deliberately drop the exception: it may carry request details or a key.
      // Leave the asset pending to retry next poll; give up once it has expired.
      try {
        if (Date.now() - new Date(asset.created_at).getTime() > VIDEO_MAX_AGE_MS) {
          await mark(asset, { status: 'failed' });
        }
      } catch {
        // Next poll will retry.
      }
    }
  }
}
