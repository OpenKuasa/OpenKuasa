import type { SupabaseClient } from '@supabase/supabase-js';
import { checkVideo } from '@/lib/agents/openrouter-media';
import { decryptApiKey, hasKeySecret } from '@/lib/ai/key-crypto';
import { runWeeklyStudio } from '@/lib/agents/weekly-studio';
import { WEEKLY_STUDIO } from '@/lib/agents/types';

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

/** Rolling-ceiling check. Returns a pause reason, or null if under budget. */
async function overBudget(
  client: SupabaseClient,
  orgId: string,
  caps: OrgConfig | null,
): Promise<string | null> {
  const daily = caps?.daily_cap_cents ?? 500;
  const weekly = caps?.weekly_cap_cents ?? 2000;
  const spentSince = async (sinceIso: string): Promise<number> => {
    // Zero-cost rows (monitor-skips) are excluded: they add nothing and would
    // otherwise push the window past PostgREST's row cap and undercount the sum.
    const { data, error } = await client
      .from('agent_runs')
      .select('cost_cents')
      .eq('org_id', orgId)
      .gt('cost_cents', 0)
      .gte('started_at', sinceIso);
    // Fail closed: an unreadable spend must never read as "under budget". The
    // per-schedule catch counts it failed and the next tick retries (no pause).
    if (error) throw new Error('spend query failed');
    return (data ?? []).reduce(
      (a: number, r: { cost_cents: number | null }) => a + (r.cost_cents ?? 0),
      0,
    );
  };
  if ((await spentSince(new Date(Date.now() - DAY_MS).toISOString())) >= daily) {
    return 'daily budget reached';
  }
  if ((await spentSince(new Date(Date.now() - 7 * DAY_MS).toISOString())) >= weekly) {
    return 'weekly budget reached';
  }
  return null;
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
 * ceilings BEFORE any run (over budget pauses the org's active schedules), then CLAIM
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
    const { data: cfg } = await client
      .from('agent_configs')
      .select('enabled, daily_cap_cents, weekly_cap_cents')
      .eq('org_id', orgId)
      .eq('agent_key', WEEKLY_STUDIO)
      .maybeSingle();
    const row = (cfg as OrgConfig | null) ?? null;
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

      const reason = await overBudget(client, s.org_id, config);
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

      const result = await runWeeklyStudio(client, s.org_id, 'schedule');
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
 * the row at 'running'. This also bounds the in-flight guard on manual runs
 * (runAgentNowAction): a stuck run stops blocking new ones once it is reaped.
 */
export const RUN_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Fails runs stuck in 'running' past {@link RUN_MAX_AGE_MS}. `client` MUST be the
 * service-role client. Idempotent: only status='running' rows older than the cutoff
 * are touched, so repeated sweeps are a no-op. A bulk update across orgs is correct
 * here — it is a global background sweep, scoped by status + age, not by org.
 */
export async function reapStaleRuns(client: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_MAX_AGE_MS).toISOString();
  const { error } = await client
    .from('agent_runs')
    .update({ status: 'failed', error: 'timed out', finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('started_at', cutoff);
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
};

/**
 * Finalizes pending video assets. `client` MUST be the service-role client.
 * Only status='pending' videos are read, and each is transitioned at most once
 * per call, so re-polling finished assets is a no-op. Never logs or stores the
 * key or any exception text.
 */
export async function pollVideos(client: SupabaseClient): Promise<void> {
  const { data, error } = await client
    .from('agent_run_assets')
    .select('id, org_id, run_id, provider_job_id, created_at')
    .eq('kind', 'video')
    .eq('status', 'pending');
  if (error || !data) return;

  const keys = new Map<string, string | null>();
  const keyFor = async (orgId: string): Promise<string | null> => {
    if (keys.has(orgId)) return keys.get(orgId) ?? null;
    const { data: row, error: keyErr } = await client
      .from('org_ai_keys')
      .select('ciphertext')
      .eq('org_id', orgId)
      .maybeSingle();
    const key =
      !keyErr && row?.ciphertext && hasKeySecret() ? decryptApiKey(row.ciphertext as string) : null;
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

  for (const asset of data as PendingVideo[]) {
    try {
      const expired = Date.now() - new Date(asset.created_at).getTime() > VIDEO_MAX_AGE_MS;
      const apiKey = await keyFor(asset.org_id);
      if (!apiKey || !asset.provider_job_id) {
        await mark(asset, { status: 'failed' });
        continue;
      }
      const check = await checkVideo(apiKey, asset.provider_job_id);
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
