import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/weekly-studio', () => ({
  runWeeklyStudio: vi.fn(async () => ({ runId: 'r1', status: 'done' })),
}));
vi.mock('@/lib/agents/openrouter-media', () => ({ checkVideo: vi.fn() }));
vi.mock('@/lib/ai/key-crypto', () => ({ hasKeySecret: () => true, decryptApiKey: () => 'k' }));

import { runSchedules } from '@/lib/agents/runner';
import { RunInProgressError } from '@/lib/agents/types';
import { runWeeklyStudio } from '@/lib/agents/weekly-studio';

const ORG = 'org-1';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Sched = {
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

const sched = (over: Partial<Sched> = {}): Sched => ({
  id: 's1',
  org_id: ORG,
  agent_key: 'weekly_studio',
  interval_seconds: 3600,
  next_run_at: ago(1000),
  last_run_at: null,
  end_at: null,
  max_runs: null,
  runs_used: 0,
  max_total_cents: null,
  spent_cents: 0,
  ...over,
});

type Opts = {
  claim?: boolean;
  cfg?: { enabled?: boolean; daily_cap_cents: number; weekly_cap_cents: number } | null;
  recentRuns?: { cost_cents: number }[];
  runCost?: number;
  newData?: boolean;
  runsFor?: (ageMs: number) => { cost_cents: number }[];
  spendError?: boolean;
};

type Write = {
  table: string;
  kind: 'update' | 'insert';
  patch: Record<string, unknown>;
  eqs: [string, unknown][];
  ltes: [string, unknown][];
};

function fakeClient(schedules: Sched[], opts: Opts = {}) {
  const writes: Write[] = [];
  const rpcCalls: { name: string; args: { p_org_id: string; p_since: string } }[] = [];
  let runRowListReads = 0;
  const o = { claim: true, cfg: null, recentRuns: [], runCost: 0, newData: false, ...opts };
  const client = {
    // The workspace spend is one database-side sum per window, never a row fetch.
    async rpc(name: string, args: { p_org_id: string; p_since: string }) {
      rpcCalls.push({ name, args });
      if (o.spendError) return { data: null, error: { message: 'x' } };
      const rows = o.runsFor ? o.runsFor(Date.now() - new Date(args.p_since).getTime()) : o.recentRuns;
      return { data: rows.reduce((n, r) => n + r.cost_cents, 0), error: null };
    },
    from(table: string) {
      return {
        select() {
          const q: Record<string, unknown> = {};
          const eqs: [string, unknown][] = [];
          q.eq = (c: string, v: unknown) => (eqs.push([c, v]), q);
          q.gte = () => q;
          q.gt = () => q;
          q.lte = () => q;
          q.limit = () => q;
          q.maybeSingle = async () => {
            if (table === 'agent_configs') return { data: o.cfg, error: null };
            if (table === 'agent_runs') return { data: { cost_cents: o.runCost }, error: null };
            return { data: o.newData ? { id: 'x' } : null, error: null };
          };
          q.then = (res: (v: unknown) => void) => {
            if (table === 'agent_schedules') return res({ data: schedules, error: null });
            if (table === 'agent_runs') {
              runRowListReads += 1;
              return res({ data: [], error: null });
            }
            return res({ data: [], error: null });
          };
          return q;
        },
        update(patch: Record<string, unknown>) {
          const w: Write = { table, kind: 'update', patch, eqs: [], ltes: [] };
          writes.push(w);
          const q: Record<string, unknown> = {};
          q.eq = (c: string, v: unknown) => (w.eqs.push([c, v]), q);
          q.lte = (c: string, v: unknown) => (w.ltes.push([c, v]), q);
          q.select = () => q;
          q.maybeSingle = async () => ({ data: o.claim ? { id: 's1' } : null, error: null });
          q.then = (res: (v: unknown) => void) => res({ error: null });
          return q;
        },
        insert(row: Record<string, unknown>) {
          writes.push({ table, kind: 'insert', patch: row, eqs: [], ltes: [] });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as never, writes, rpcCalls, runRowListReads: () => runRowListReads };
}

const schedUpdates = (writes: Write[]) => writes.filter((w) => w.table === 'agent_schedules' && w.kind === 'update');

beforeEach(() => {
  vi.mocked(runWeeklyStudio).mockClear();
  vi.mocked(runWeeklyStudio).mockResolvedValue({ runId: 'r1', status: 'done' });
  vi.stubEnv('AGENTS_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('runSchedules', () => {
  it('does nothing when AGENTS_ENABLED is unset or false', async () => {
    const { client, writes } = fakeClient([sched()]);
    vi.stubEnv('AGENTS_ENABLED', '');
    await runSchedules(client);
    vi.stubEnv('AGENTS_ENABLED', 'false');
    await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('marks a schedule past max_runs completed without running', async () => {
    const { client, writes } = fakeClient([sched({ max_runs: 3, runs_used: 3 })]);
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    const u = schedUpdates(writes);
    expect(u).toHaveLength(1);
    expect(u[0].patch).toMatchObject({ status: 'completed' });
    expect(u[0].eqs).toContainEqual(['status', 'active']);
    expect(u[0].eqs).toContainEqual(['org_id', ORG]);
    expect(out).toMatchObject({ completed: 1, ran: 0 });
  });

  it('pauses the org schedules with a reason when over the weekly ceiling, without running', async () => {
    const { client, writes, rpcCalls, runRowListReads } = fakeClient([sched()], {
      cfg: { daily_cap_cents: 5000, weekly_cap_cents: 1000 },
      recentRuns: [{ cost_cents: 1500 }],
    });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    // One database-side sum per window (day, then week), scoped to the schedule's org.
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls.every((c) => c.name === 'agent_spend_cents' && c.args.p_org_id === ORG)).toBe(true);
    const ages = rpcCalls.map((c) => Date.now() - new Date(c.args.p_since).getTime());
    expect(Math.abs(ages[0] - 24 * 3600_000)).toBeLessThan(5000);
    expect(Math.abs(ages[1] - 7 * 24 * 3600_000)).toBeLessThan(5000);
    // Run rows are never fetched to be added up in the app (a row cap would undercount).
    expect(runRowListReads()).toBe(0);
    const u = schedUpdates(writes);
    expect(u).toHaveLength(1);
    expect(u[0].patch).toMatchObject({ status: 'paused', paused_reason: 'weekly budget reached' });
    expect(u[0].eqs).toContainEqual(['org_id', ORG]);
    expect(u[0].eqs).toContainEqual(['status', 'active']);
    expect(out).toMatchObject({ paused: 1, ran: 0 });
  });

  it('pauses on the daily ceiling when only the daily window is over', async () => {
    const { client, writes } = fakeClient([sched()], {
      cfg: { daily_cap_cents: 100, weekly_cap_cents: 100000 },
      runsFor: (age) => (age < 2 * 24 * 3600_000 ? [{ cost_cents: 150 }] : [{ cost_cents: 50 }]),
    });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    expect(schedUpdates(writes)[0].patch).toMatchObject({ status: 'paused', paused_reason: 'daily budget reached' });
    expect(out.paused).toBe(1);
  });

  it('fails closed (counts failed, no run, no pause) when the spend query errors', async () => {
    const { client, writes } = fakeClient([sched()], { spendError: true });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    expect(schedUpdates(writes)).toHaveLength(0);
    expect(out).toMatchObject({ failed: 1, ran: 0, paused: 0 });
  });

  it('does not run when the conditional claim returns no row (double-tick safety)', async () => {
    const { client, writes } = fakeClient([sched()], { claim: false });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.table === 'agent_runs')).toHaveLength(0);
    const claim = schedUpdates(writes).find((w) => 'next_run_at' in w.patch)!;
    expect(claim.eqs).toContainEqual(['status', 'active']);
    expect(claim.eqs).toContainEqual(['id', 's1']);
    expect(claim.ltes.map(([c]) => c)).toContain('next_run_at');
    expect(out).toMatchObject({ ran: 0, skipped: 1 });
  });

  it('monitor-skip: no new data since last run inserts a cost-0 skipped run and does not run', async () => {
    const { client, writes } = fakeClient([sched({ last_run_at: ago(3600_000), runs_used: 1 })], {
      newData: false,
    });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    const ins = writes.filter((w) => w.table === 'agent_runs' && w.kind === 'insert');
    expect(ins).toHaveLength(1);
    expect(ins[0].patch).toMatchObject({
      org_id: ORG,
      status: 'skipped',
      trigger: 'schedule',
      cost_cents: 0,
    });
    expect(schedUpdates(writes).some((w) => w.patch.runs_used === 2)).toBe(true);
    expect(out).toMatchObject({ skipped: 1, ran: 0 });
  });

  it('runs when there is new data since the last run', async () => {
    const { client } = fakeClient([sched({ last_run_at: ago(3600_000) })], { newData: true });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).toHaveBeenCalledTimes(1);
    expect(out.ran).toBe(1);
  });

  it('happy run: calls runWeeklyStudio with the row org and advances spent/runs_used', async () => {
    const { client, writes } = fakeClient([sched({ org_id: 'org-9', runs_used: 2, spent_cents: 100 })], {
      runCost: 40,
    });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).toHaveBeenCalledWith(client, 'org-9', 'schedule');
    const last = schedUpdates(writes).at(-1)!;
    expect(last.patch).toMatchObject({ runs_used: 3, spent_cents: 140 });
    expect(last.patch).not.toHaveProperty('status');
    expect(last.eqs).toContainEqual(['status', 'active']);
    expect(last.patch.last_run_at).toBeTruthy();
    expect(out).toMatchObject({ ran: 1, failed: 0 });
  });

  it('claims (pushes next_run_at forward) before running', async () => {
    const { client, writes } = fakeClient([sched()]);
    let claimedBeforeRun = false;
    vi.mocked(runWeeklyStudio).mockImplementationOnce(async () => {
      claimedBeforeRun = schedUpdates(writes).some((w) => 'next_run_at' in w.patch);
      return { runId: 'r1', status: 'done' };
    });
    await runSchedules(client);
    expect(claimedBeforeRun).toBe(true);
  });

  it('completes the schedule when this run reaches max_runs', async () => {
    const { client, writes } = fakeClient([sched({ max_runs: 2, runs_used: 1 })]);
    await runSchedules(client);
    expect(runWeeklyStudio).toHaveBeenCalledTimes(1);
    expect(schedUpdates(writes).at(-1)!.patch).toMatchObject({ runs_used: 2, status: 'completed' });
  });

  it('enable-gate: a disabled Weekly Studio skips the schedule with no run, pause, or claim', async () => {
    const { client, writes } = fakeClient([sched()], {
      cfg: { enabled: false, daily_cap_cents: 500, weekly_cap_cents: 2000 },
    });
    const out = await runSchedules(client);
    expect(runWeeklyStudio).not.toHaveBeenCalled();
    expect(schedUpdates(writes)).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(out).toMatchObject({ skipped: 1, ran: 0, paused: 0, failed: 0 });
  });

  it('enable-gate: enabled true runs, and the org config is read once per org', async () => {
    let cfgReads = 0;
    const { client } = fakeClient([sched({ id: 's1' }), sched({ id: 's2' })], {
      cfg: { enabled: true, daily_cap_cents: 500, weekly_cap_cents: 2000 },
    });
    const orig = (client as { from: (t: string) => unknown }).from.bind(client);
    (client as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'agent_configs') cfgReads += 1;
      return orig(t);
    };
    const out = await runSchedules(client);
    expect(out.ran).toBe(2);
    expect(cfgReads).toBe(1);
  });

  it('clears a stale paused_reason in the claim update', async () => {
    const { client, writes } = fakeClient([sched()]);
    await runSchedules(client);
    const claim = schedUpdates(writes).find((w) => 'next_run_at' in w.patch)!;
    expect(claim.patch).toHaveProperty('paused_reason', null);
  });

  it('a run already in progress for the workspace skips this tick and hands the slot back', async () => {
    vi.mocked(runWeeklyStudio).mockRejectedValueOnce(new RunInProgressError());
    const due = sched();
    const { client, writes } = fakeClient([due]);
    const out = await runSchedules(client);
    expect(out).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
    const last = schedUpdates(writes).at(-1)!;
    // The claim pushed next_run_at forward; it is put back so the next tick retries.
    expect(last.patch).toMatchObject({ next_run_at: due.next_run_at });
    expect(last.patch).not.toHaveProperty('runs_used');
    expect(last.eqs).toContainEqual(['id', 's1']);
    expect(last.eqs).toContainEqual(['org_id', ORG]);
  });

  it('keeps looping when one schedule throws', async () => {
    vi.mocked(runWeeklyStudio).mockRejectedValueOnce(new Error('boom sk-or-secret'));
    const { client } = fakeClient([sched({ id: 's1' }), sched({ id: 's2', org_id: 'org-2' })]);
    const out = await runSchedules(client);
    expect(runWeeklyStudio).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ ran: 1, failed: 1 });
  });
});
