import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cancelSchedule,
  createSchedule,
  createScheduleInput,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  setWorkspaceCaps,
  setWorkspaceCapsInput,
  syncCadenceSchedule,
  updateSchedule,
  updateScheduleInput,
} from '@/lib/reach/schedule-capabilities';
import { agentKeySchema } from '@/lib/agents/config';

type Call = { table: string; op: string; payload?: unknown; eq: [string, unknown][] };

/** Minimal chainable fake: records each query and resolves queued results in order. */
function fakeClient(results: { data: unknown; error: { code: string } | null }[]) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: 'select', eq: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      const done = () => Promise.resolve(results.shift() ?? { data: null, error: null });
      b.insert = (p: unknown) => ((call.op = 'insert'), (call.payload = p), b);
      b.update = (p: unknown) => ((call.op = 'update'), (call.payload = p), b);
      b.select = () => b;
      b.order = () => done();
      b.in = (c: string, v: unknown) => (call.eq.push([c, v]), b);
      b.eq = (c: string, v: unknown) => (call.eq.push([c, v]), b);
      b.single = done;
      b.maybeSingle = done;
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => done().then(res, rej);
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const ORG = '11111111-1111-1111-1111-111111111111';
const ID = '3f2b8c1e-5d4a-4b7e-9a1c-6e0d2f8a9b34';
const ok = (data: unknown) => ({ data, error: null });
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const base = { agent_key: 'weekly-studio', interval_seconds: 3600 };

describe('createScheduleInput', () => {
  it('accepts a valid input', () => {
    expect(createScheduleInput.safeParse(base).success).toBe(true);
  });
  it('rejects interval < 300', () => {
    expect(createScheduleInput.safeParse({ ...base, interval_seconds: 299 }).success).toBe(false);
  });
  it('rejects max_runs outside 1..1000', () => {
    expect(createScheduleInput.safeParse({ ...base, max_runs: 0 }).success).toBe(false);
    expect(createScheduleInput.safeParse({ ...base, max_runs: 1001 }).success).toBe(false);
  });
  it('rejects a past end_at', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(createScheduleInput.safeParse({ ...base, end_at: past }).success).toBe(false);
    expect(createScheduleInput.safeParse({ ...base, end_at: future() }).success).toBe(true);
  });
  it('rejects max_total_cents outside 0..100000', () => {
    expect(createScheduleInput.safeParse({ ...base, max_total_cents: -1 }).success).toBe(false);
    expect(createScheduleInput.safeParse({ ...base, max_total_cents: 100_001 }).success).toBe(false);
  });
  it('rejects an unknown agent_key', () => {
    expect(createScheduleInput.safeParse({ ...base, agent_key: 'nope' }).success).toBe(false);
  });
});

describe('updateScheduleInput', () => {
  it('requires a uuid and enforces the interval floor', () => {
    expect(updateScheduleInput.safeParse({ id: 'x' }).success).toBe(false);
    expect(updateScheduleInput.safeParse({ id: ID, interval_seconds: 10 }).success).toBe(false);
  });
});

describe('createSchedule', () => {
  it('inserts org_id from ctx, active default, next_run_at = starts_at, no ungrantable columns', async () => {
    const { client, calls } = fakeClient([ok({ id: ID })]);
    const starts = future();
    const r = await createSchedule(
      { client, orgId: ORG },
      { ...base, starts_at: starts, org_id: 'evil' } as never,
    );
    expect(r.ok).toBe(true);
    const payload = calls[0].payload as Record<string, unknown>;
    expect(calls[0]).toMatchObject({ table: 'agent_schedules', op: 'insert' });
    expect(payload.org_id).toBe(ORG);
    expect(payload.status).toBe('active');
    expect(payload.next_run_at).toBe(starts);
    for (const k of ['created_by', 'spent_cents', 'runs_used', 'last_run_at', 'paused_reason']) {
      expect(payload).not.toHaveProperty(k);
    }
  });
  it('defaults next_run_at to now + interval', async () => {
    const { client, calls } = fakeClient([ok({ id: ID })]);
    const before = Date.now();
    await createSchedule({ client, orgId: ORG }, base as never);
    const next = new Date((calls[0].payload as { next_run_at: string }).next_run_at).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });
  it('returns a generic failure on db error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient([{ data: null, error: { code: '42501' } }]);
    const r = await createSchedule({ client, orgId: ORG }, base as never);
    expect(r.ok).toBe(false);
  });
});

describe('patch-based mutations', () => {
  const scoped = (c: Call) => {
    expect(c.eq).toContainEqual(['org_id', ORG]);
    expect(c.eq).toContainEqual(['id', ID]);
  };
  it('updateSchedule scopes by id + org_id', async () => {
    const { client, calls } = fakeClient([ok({ id: ID })]);
    await updateSchedule({ client, orgId: ORG }, { id: ID, interval_seconds: 600 });
    scoped(calls[0]);
    expect(calls[0].payload).toMatchObject({ interval_seconds: 600 });
  });
  it('pauseSchedule sets paused only', async () => {
    const { client, calls } = fakeClient([ok({ id: ID })]);
    await pauseSchedule({ client, orgId: ORG }, { id: ID });
    scoped(calls[0]);
    expect(calls[0].payload).toMatchObject({ status: 'paused' });
    expect(calls[0].payload).not.toHaveProperty('paused_reason');
  });
  it('resumeSchedule writes status active and never paused_reason (R1)', async () => {
    const { client, calls } = fakeClient([ok({ id: ID })]);
    await resumeSchedule({ client, orgId: ORG }, { id: ID });
    scoped(calls[0]);
    expect(calls[0].payload).toMatchObject({ status: 'active' });
    expect(calls[0].payload).not.toHaveProperty('paused_reason');
  });
  it('cancelSchedule sets completed', async () => {
    const { client, calls } = fakeClient([ok({ id: ID })]);
    await cancelSchedule({ client, orgId: ORG }, { id: ID });
    scoped(calls[0]);
    expect(calls[0].payload).toMatchObject({ status: 'completed' });
  });
  it('fails when no row matched (other org)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient([ok(null)]);
    const r = await pauseSchedule({ client, orgId: ORG }, { id: ID });
    expect(r.ok).toBe(false);
  });
});

describe('listSchedules', () => {
  it('scopes by org_id', async () => {
    const { client, calls } = fakeClient([ok([{ id: ID }])]);
    const rows = await listSchedules(client, ORG);
    expect(rows).toHaveLength(1);
    expect(calls[0].eq).toContainEqual(['org_id', ORG]);
  });
});

describe('workspace caps', () => {
  it('rejects negative or oversized caps', () => {
    expect(setWorkspaceCapsInput.safeParse({ daily_cap_cents: -1, weekly_cap_cents: 0 }).success).toBe(false);
    expect(setWorkspaceCapsInput.safeParse({ daily_cap_cents: 0, weekly_cap_cents: 1_000_001 }).success).toBe(false);
    expect(setWorkspaceCapsInput.safeParse({ daily_cap_cents: 100, weekly_cap_cents: 500 }).success).toBe(true);
  });
  it('updates first, scoped by org_id + agent_key, without inserting when a row exists', async () => {
    const caps = { daily_cap_cents: 100, weekly_cap_cents: 500 };
    const { client, calls } = fakeClient([ok(caps)]);
    const r = await setWorkspaceCaps({ client, orgId: ORG }, caps);
    expect(r).toEqual({ ok: true, data: caps });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'agent_configs', op: 'update' });
    expect(calls[0].eq).toContainEqual(['org_id', ORG]);
    expect(calls[0].eq).toContainEqual(['agent_key', 'weekly-studio']);
  });
  it('inserts a new row when the update matched nothing', async () => {
    const caps = { daily_cap_cents: 100, weekly_cap_cents: 500 };
    const { client, calls } = fakeClient([ok(null), ok(caps)]);
    const r = await setWorkspaceCaps({ client, orgId: ORG }, caps);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(['update', 'insert']);
    expect(calls[1].payload).toEqual({ org_id: ORG, agent_key: 'weekly-studio', ...caps });
  });
});

describe('agent key on caps and cadence sync', () => {
  const caps = { daily_cap_cents: 100, weekly_cap_cents: 500 };
  it('setWorkspaceCaps writes the row for the given agent_key and never SETs it', async () => {
    const { client, calls } = fakeClient([ok(null), ok(caps)]);
    const r = await setWorkspaceCaps({ client, orgId: ORG }, { ...caps, agent_key: 'crm-focus' });
    expect(r.ok).toBe(true);
    expect(calls[0].eq).toContainEqual(['agent_key', 'crm-focus']);
    expect(calls[0].payload).not.toHaveProperty('agent_key');
    expect(calls[1].payload).toEqual({ org_id: ORG, agent_key: 'crm-focus', ...caps });
  });
  it('setWorkspaceCaps without agent_key defaults to weekly-studio', async () => {
    const { client, calls } = fakeClient([ok(caps)]);
    await setWorkspaceCaps({ client, orgId: ORG }, caps);
    expect(calls[0].eq).toContainEqual(['agent_key', 'weekly-studio']);
  });
  it('agentKeySchema rejects an unknown key and accepts the registered one', () => {
    expect(agentKeySchema.safeParse('nope').success).toBe(false);
    expect(agentKeySchema.safeParse('weekly-studio').success).toBe(true);
  });
  it('syncCadenceSchedule scopes to a given agent key and uses firstRunAt', async () => {
    const { client, calls } = fakeClient([ok(null), ok({ id: ID })]);
    const r = await syncCadenceSchedule({ client, orgId: ORG }, 'daily', {
      agentKey: 'crm-focus',
      firstRunAt: () => new Date('2026-10-24T23:00:00Z'),
    });
    expect(r.ok).toBe(true);
    expect(calls[0].eq).toContainEqual(['agent_key', 'crm-focus']);
    expect(calls[0].payload).toMatchObject({ next_run_at: '2026-10-24T23:00:00.000Z' });
    expect(calls[1].payload).toMatchObject({ agent_key: 'crm-focus', next_run_at: '2026-10-24T23:00:00.000Z' });
  });
  it('syncCadenceSchedule with no opts keeps weekly-studio and now + interval', async () => {
    const before = Date.now();
    const { client, calls } = fakeClient([ok(null), ok({ id: ID })]);
    await syncCadenceSchedule({ client, orgId: ORG }, 'daily');
    expect(calls[0].eq).toContainEqual(['agent_key', 'weekly-studio']);
    expect(calls[1].payload).toMatchObject({ agent_key: 'weekly-studio' });
    const next = new Date((calls[1].payload as { next_run_at: string }).next_run_at).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(next).toBeLessThan(before + 86_400_000 + 5000);
  });
});

describe('syncCadenceSchedule', () => {
  const row = { id: ID, interval_seconds: 604800, status: 'active' };
  const FORBIDDEN = ['spent_cents', 'runs_used', 'last_run_at', 'paused_reason'];

  it('weekly: updates the tagged preset row first (604800, active), no insert', async () => {
    const { client, calls } = fakeClient([ok(row)]);
    const r = await syncCadenceSchedule({ client, orgId: ORG }, 'weekly');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'agent_schedules', op: 'update' });
    expect(calls[0].payload).toMatchObject({ interval_seconds: 604800, status: 'active', nl_text: 'cadence preset' });
    expect(calls[0].eq).toContainEqual(['org_id', ORG]);
    expect(calls[0].eq).toContainEqual(['agent_key', 'weekly-studio']);
    for (const k of FORBIDDEN) expect(calls[0].payload).not.toHaveProperty(k);
  });
  it('daily: inserts one tagged row (86400) when none exists', async () => {
    const { client, calls } = fakeClient([ok(null), ok(row)]);
    const r = await syncCadenceSchedule({ client, orgId: ORG }, 'daily');
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(['update', 'insert']);
    expect(calls[1].payload).toMatchObject({
      org_id: ORG,
      agent_key: 'weekly-studio',
      interval_seconds: 86400,
      status: 'active',
      nl_text: 'cadence preset',
    });
    for (const k of FORBIDDEN) expect(calls[1].payload).not.toHaveProperty(k);
  });
  it('adopts migrated rows: filters on all three tags and re-tags nl_text', async () => {
    const { client, calls } = fakeClient([ok(row)]);
    await syncCadenceSchedule({ client, orgId: ORG }, 'daily');
    const inFilter = calls[0].eq.find(([c]) => c === 'nl_text');
    expect(inFilter?.[1]).toEqual(
      expect.arrayContaining(['cadence preset', 'Migrated from daily cadence', 'Migrated from weekly cadence']),
    );
    expect(calls[0].payload).toMatchObject({ nl_text: 'cadence preset' });
  });
  it('23505 on insert (concurrent sync) falls back to the update, not a failure', async () => {
    const { client, calls } = fakeClient([ok(null), { data: null, error: { code: '23505' } }, ok(row)]);
    const r = await syncCadenceSchedule({ client, orgId: ORG }, 'weekly');
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(['update', 'insert', 'update']);
    expect(calls[2].payload).toMatchObject({ interval_seconds: 604800, status: 'active', nl_text: 'cadence preset' });
  });
  it('off: completes the matched preset row and never inserts', async () => {
    const { client, calls } = fakeClient([ok(row)]);
    const r = await syncCadenceSchedule({ client, orgId: ORG }, 'off');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'update' });
    expect(calls[0].payload).toMatchObject({ status: 'completed' });
    expect(calls[0].eq).toContainEqual(['org_id', ORG]);
  });
  it('is idempotent: a second call updates the same row instead of inserting', async () => {
    const { client, calls } = fakeClient([ok(null), ok(row), ok(row)]);
    await syncCadenceSchedule({ client, orgId: ORG }, 'weekly');
    await syncCadenceSchedule({ client, orgId: ORG }, 'weekly');
    expect(calls.map((c) => c.op)).toEqual(['update', 'insert', 'update']);
  });
  it('fails closed on a DB error', async () => {
    const { client } = fakeClient([{ data: null, error: { code: '42501' } }]);
    const r = await syncCadenceSchedule({ client, orgId: ORG }, 'weekly');
    expect(r.ok).toBe(false);
  });
});
