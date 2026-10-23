import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/run-agent', () => ({
  runAgent: vi.fn(async () => ({ runId: 'r1', status: 'done' })),
}));
vi.mock('@/lib/agents/openrouter-media', () => ({ checkVideo: vi.fn() }));
vi.mock('@/lib/ai/key-crypto', () => ({ hasKeySecret: () => true, decryptApiKey: () => 'k' }));

import { runSchedules, startRefusal } from '@/lib/agents/runner';
import { AGENTS } from '@/lib/agents/registry';
import type { AgentRegistry } from '@/lib/agents/definition';
import { RunInProgressError } from '@/lib/agents/types';
import { runAgent } from '@/lib/agents/run-agent';

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
  agent_key: 'weekly-studio',
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
  cfgFor?: (agentKey: unknown) => { enabled?: boolean; daily_cap_cents: number; weekly_cap_cents: number } | null;
  spendFor?: (agentKey: unknown) => number;
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
  const rpcCalls: { name: string; args: { p_org_id: string; p_since: string; p_agent_key?: string } }[] = [];
  let runRowListReads = 0;
  const configReads: [string, unknown][][] = [];
  const o = { claim: true, cfg: null, recentRuns: [], runCost: 0, newData: false, ...opts };
  const client = {
    // The workspace spend is one database-side sum per window, never a row fetch.
    async rpc(name: string, args: { p_org_id: string; p_since: string; p_agent_key?: string }) {
      rpcCalls.push({ name, args });
      if (o.spendError) return { data: null, error: { message: 'x' } };
      if (o.spendFor) return { data: o.spendFor(args.p_agent_key), error: null };
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
            if (table === 'agent_configs') {
              configReads.push(eqs);
              const key = eqs.find(([c]) => c === 'agent_key')?.[1];
              return { data: o.cfgFor ? o.cfgFor(key) : o.cfg, error: null };
            }
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
  return { client: client as never, writes, rpcCalls, configReads, runRowListReads: () => runRowListReads };
}

const schedUpdates = (writes: Write[]) => writes.filter((w) => w.table === 'agent_schedules' && w.kind === 'update');

beforeEach(() => {
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockResolvedValue({ runId: 'r1', status: 'done' });
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
    expect(runAgent).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('skips a schedule whose agent_key has no definition, without running, claiming or writing', async () => {
    const { client, writes } = fakeClient([sched({ agent_key: 'ghost-agent' })]);
    const out = await runSchedules(client);
    expect(runAgent).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(out).toMatchObject({ skipped: 1, ran: 0, paused: 0, completed: 0, failed: 0 });
  });

  it('marks a schedule past max_runs completed without running', async () => {
    const { client, writes } = fakeClient([sched({ max_runs: 3, runs_used: 3 })]);
    const out = await runSchedules(client);
    expect(runAgent).not.toHaveBeenCalled();
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
    expect(runAgent).not.toHaveBeenCalled();
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
    expect(runAgent).not.toHaveBeenCalled();
    expect(schedUpdates(writes)[0].patch).toMatchObject({ status: 'paused', paused_reason: 'daily budget reached' });
    expect(out.paused).toBe(1);
  });

  it('fails closed (counts failed, no run, no pause) when the spend query errors', async () => {
    const { client, writes } = fakeClient([sched()], { spendError: true });
    const out = await runSchedules(client);
    expect(runAgent).not.toHaveBeenCalled();
    expect(schedUpdates(writes)).toHaveLength(0);
    expect(out).toMatchObject({ failed: 1, ran: 0, paused: 0 });
  });

  it('does not run when the conditional claim returns no row (double-tick safety)', async () => {
    const { client, writes } = fakeClient([sched()], { claim: false });
    const out = await runSchedules(client);
    expect(runAgent).not.toHaveBeenCalled();
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
    expect(runAgent).not.toHaveBeenCalled();
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
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(out.ran).toBe(1);
  });

  it('happy run: dispatches the reach agent with the row org and advances spent/runs_used', async () => {
    const { client, writes } = fakeClient([sched({ org_id: 'org-9', runs_used: 2, spent_cents: 100 })], {
      runCost: 40,
    });
    const out = await runSchedules(client);
    expect(runAgent).toHaveBeenCalledWith(
      client,
      'org-9',
      'schedule',
      expect.objectContaining({ agentKey: 'weekly-studio', product: 'reach' }),
    );
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
    vi.mocked(runAgent).mockImplementationOnce(async () => {
      claimedBeforeRun = schedUpdates(writes).some((w) => 'next_run_at' in w.patch);
      return { runId: 'r1', status: 'done' };
    });
    await runSchedules(client);
    expect(claimedBeforeRun).toBe(true);
  });

  it('completes the schedule when this run reaches max_runs', async () => {
    const { client, writes } = fakeClient([sched({ max_runs: 2, runs_used: 1 })]);
    await runSchedules(client);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(schedUpdates(writes).at(-1)!.patch).toMatchObject({ runs_used: 2, status: 'completed' });
  });

  it('enable-gate: a disabled Weekly Studio skips the schedule with no run, pause, or claim', async () => {
    const { client, writes } = fakeClient([sched()], {
      cfg: { enabled: false, daily_cap_cents: 500, weekly_cap_cents: 2000 },
    });
    const out = await runSchedules(client);
    expect(runAgent).not.toHaveBeenCalled();
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

  const crmRegistry = (): AgentRegistry =>
    new Map([
      ...AGENTS,
      ['crm-focus', { ...AGENTS.get('weekly-studio')!, agentKey: 'crm-focus', hasNewData: async () => true }],
    ]);

  it("pauses only the over-budget agent's schedules", async () => {
    const { client, writes, rpcCalls } = fakeClient(
      [sched({ id: 's1', agent_key: 'weekly-studio' }), sched({ id: 's2', agent_key: 'crm-focus' })],
      { spendFor: (k) => (k === 'crm-focus' ? 9999 : 0) },
    );
    const out = await runSchedules(client, crmRegistry());
    expect(rpcCalls.every((c) => c.args.p_agent_key !== undefined)).toBe(true);
    const pauses = schedUpdates(writes).filter((w) => w.patch.status === 'paused');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].eqs).toContainEqual(['agent_key', 'crm-focus']);
    expect(pauses[0].eqs).toContainEqual(['org_id', ORG]);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ paused: 1, ran: 1 });
  });

  it('reads config per agent, cached by org and agent key', async () => {
    const { client, configReads } = fakeClient(
      [
        sched({ id: 's1', agent_key: 'weekly-studio' }),
        sched({ id: 's2', agent_key: 'crm-focus' }),
        sched({ id: 's3', agent_key: 'crm-focus' }),
      ],
      { cfgFor: (k) => ({ enabled: k !== 'crm-focus', daily_cap_cents: 500, weekly_cap_cents: 2000 }) },
    );
    const out = await runSchedules(client, crmRegistry());
    expect(configReads).toHaveLength(2);
    expect(configReads.map((e) => e.find(([c]) => c === 'agent_key')?.[1]).sort()).toEqual([
      'crm-focus',
      'weekly-studio',
    ]);
    expect(out).toMatchObject({ ran: 1, skipped: 2 });
  });

  it('startRefusal passes the agent key to the spend sum', async () => {
    const { client, rpcCalls } = fakeClient([], {});
    await startRefusal(client, ORG, 'crm-focus', null);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls.every((c) => c.args.p_agent_key === 'crm-focus')).toBe(true);
  });

  it('clears a stale paused_reason in the claim update', async () => {
    const { client, writes } = fakeClient([sched()]);
    await runSchedules(client);
    const claim = schedUpdates(writes).find((w) => 'next_run_at' in w.patch)!;
    expect(claim.patch).toHaveProperty('paused_reason', null);
  });

  it('a run already in progress for the workspace skips this tick and hands the slot back', async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new RunInProgressError());
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

  describe('keeps the schedule on its own time of day', () => {
    afterEach(() => vi.useRealTimers());
    const DAY = 86_400;
    // 07:00 in Kuala Lumpur is 23:00 UTC the day before.
    const SLOT = '2026-10-22T23:00:00.000Z';

    it('a claim at 07:04:59 for a 07:00 daily slot moves to the next day 07:00', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-22T23:04:59.000Z'));
      const { client, writes } = fakeClient([sched({ interval_seconds: DAY, next_run_at: SLOT })]);
      await runSchedules(client);
      const claim = schedUpdates(writes).find((w) => 'next_run_at' in w.patch)!;
      expect(claim.patch.next_run_at).toBe('2026-10-23T23:00:00.000Z');
    });

    it('a schedule several intervals behind jumps to the next future slot, with no backlog', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-26T01:30:00.000Z'));
      const { client, writes } = fakeClient([sched({ interval_seconds: DAY, next_run_at: SLOT })]);
      const out = await runSchedules(client);
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(out.ran).toBe(1);
      const claim = schedUpdates(writes).find((w) => 'next_run_at' in w.patch)!;
      expect(claim.patch.next_run_at).toBe('2026-10-26T23:00:00.000Z');
    });

    it('a slot exactly due now moves one interval on', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(SLOT));
      const { client, writes } = fakeClient([sched({ interval_seconds: DAY, next_run_at: SLOT })]);
      await runSchedules(client);
      const claim = schedUpdates(writes).find((w) => 'next_run_at' in w.patch)!;
      expect(claim.patch.next_run_at).toBe('2026-10-23T23:00:00.000Z');
    });

    it('still hands the slot back on a run in progress, matching the claimed time', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-22T23:04:59.000Z'));
      vi.mocked(runAgent).mockRejectedValueOnce(new RunInProgressError());
      const { client, writes } = fakeClient([sched({ interval_seconds: DAY, next_run_at: SLOT })]);
      await runSchedules(client);
      const last = schedUpdates(writes).at(-1)!;
      expect(last.patch).toMatchObject({ next_run_at: SLOT });
      expect(last.eqs).toContainEqual(['next_run_at', '2026-10-23T23:00:00.000Z']);
    });
  });

  it('keeps looping when one schedule throws', async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('boom sk-or-secret'));
    const { client } = fakeClient([sched({ id: 's1' }), sched({ id: 's2', org_id: 'org-2' })]);
    const out = await runSchedules(client);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ ran: 1, failed: 1 });
  });
});
