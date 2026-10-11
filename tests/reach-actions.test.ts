import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  created: [] as unknown[],
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/reach/capabilities', async (orig) => {
  const actual = await orig<typeof import('@/lib/reach/capabilities')>();
  return {
    ...actual,
    createCampaign: async (_ctx: unknown, input: unknown) => {
      ctl.created.push(input);
      return { ok: true, data: { id: 'c1' } };
    },
    createAppointment: async (_ctx: unknown, input: unknown) => {
      ctl.created.push(input);
      return { ok: true, data: { id: 'a1' } };
    },
    createLead: async (_ctx: unknown, input: unknown) => {
      ctl.created.push(input);
      return { ok: true, data: { id: 'l1' } };
    },
  };
});

vi.mock('@/lib/agents/config', async (orig) => {
  const actual = await orig<typeof import('@/lib/agents/config')>();
  return {
    ...actual,
    setAgentEnabled: async (_ctx: unknown, input: unknown) => {
      ctl.created.push(input);
      return { ok: true, data: { id: 'ac1' } };
    },
  };
});

vi.mock('@/lib/reach/schedule-capabilities', async (orig) => {
  const actual = await orig<typeof import('@/lib/reach/schedule-capabilities')>();
  return {
    ...actual,
    createSchedule: async (_ctx: unknown, input: unknown) => {
      ctl.created.push(input);
      return { ok: true, data: { id: 's1' } };
    },
    setWorkspaceCaps: async (_ctx: unknown, input: unknown) => {
      ctl.created.push(input);
      return { ok: true, data: { daily_cap_cents: 1, weekly_cap_cents: 2 } };
    },
  };
});

type SvcWrite = { table: string; patch: Record<string, unknown>; eqs: [string, unknown][]; lts: [string, unknown][] };
const svc = vi.hoisted(() => {
  const o = {
    client: {} as object,
    run: vi.fn(),
    /** The workspace's agent_configs row (null: none saved). */
    cfg: null as { enabled: boolean; daily_cap_cents: number; weekly_cap_cents: number } | null,
    /** Spend the database reports for a window that started `ageMs` ago. */
    spent: (() => 0) as (ageMs: number) => number,
    spendError: false,
    rpcCalls: [] as { name: string; args: { p_org_id: string; p_since: string } }[],
    writes: [] as SvcWrite[],
  };
  // Chainable fake for the start gate's reads and the stale-run sweep on the service client.
  const from = (table: string) => {
    let write: SvcWrite | null = null;
    const q = {
      select: () => q,
      update: (patch: Record<string, unknown>) => {
        write = { table, patch, eqs: [], lts: [] };
        o.writes.push(write);
        return q;
      },
      eq: (c: string, v: unknown) => (write?.eqs.push([c, v]), q),
      lt: (c: string, v: unknown) => (write?.lts.push([c, v]), q),
      gte: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: table === 'agent_configs' ? o.cfg : null, error: null }),
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    };
    return q;
  };
  o.client = {
    from,
    rpc: async (name: string, args: { p_org_id: string; p_since: string }) => {
      o.rpcCalls.push({ name, args });
      if (o.spendError) return { data: null, error: { message: 'x' } };
      return { data: o.spent(Date.now() - new Date(args.p_since).getTime()), error: null };
    },
  };
  return o;
});
vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => svc.client) }));
vi.mock('@/lib/agents/weekly-studio', () => ({
  runWeeklyStudio: svc.run,
}));

const { RunInProgressError } = await import('@/lib/agents/types');
const { createCampaignAction, createLeadAction, createAppointmentAction, setAgentEnabledAction, runAgentNowAction, createScheduleAction, setWorkspaceCapsAction } = await import('@/app/(app)/reach/actions');

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.created = [];
  svc.run.mockReset();
  svc.run.mockResolvedValue({ runId: 'r1', status: 'done' });
  svc.cfg = null;
  svc.spent = () => 0;
  svc.spendError = false;
  svc.rpcCalls = [];
  svc.writes = [];
});

describe('createCampaignAction', () => {
  it('forbids a demo guest', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    const res = await createCampaignAction({ name: 'x', channel: 'facebook' });
    expect(res).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a viewer', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    const res = await createCampaignAction({ name: 'x', channel: 'facebook' });
    expect(res).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('rejects invalid input before calling the capability', async () => {
    const res = await createCampaignAction({ name: '', channel: 'nope' });
    expect(res).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('calls the capability for a member with valid input', async () => {
    const res = await createCampaignAction({ name: 'Promo', channel: 'facebook' });
    expect(res).toMatchObject({ ok: true });
    expect(ctl.created).toHaveLength(1);
  });
});

describe('createLeadAction', () => {
  it('forbids a demo guest', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await createLeadAction({ name: 'x', channel: 'whatsapp' })).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a viewer', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await createLeadAction({ name: 'x', channel: 'whatsapp' })).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('rejects invalid input before calling the capability', async () => {
    expect(await createLeadAction({ name: '', channel: 'nope' })).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('calls the capability for a member with valid input', async () => {
    expect(await createLeadAction({ name: 'Aisyah', channel: 'whatsapp' })).toMatchObject({ ok: true });
    expect(ctl.created).toHaveLength(1);
  });
});

describe('createAppointmentAction', () => {
  const valid = { contact_name: 'Aisyah', kind: 'Site visit', scheduled_at: '2026-11-01T09:00:00.000Z' };
  it('forbids a demo guest', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await createAppointmentAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a viewer', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await createAppointmentAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('rejects invalid input before calling the capability', async () => {
    expect(await createAppointmentAction({ contact_name: '', kind: '', scheduled_at: 'nope' })).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('calls the capability for a member with valid input', async () => {
    expect(await createAppointmentAction(valid)).toMatchObject({ ok: true });
    expect(ctl.created).toHaveLength(1);
  });
});

describe('setAgentEnabledAction', () => {
  const valid = { agent_key: 'weekly-studio', enabled: true };
  it('forbids a demo guest', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await setAgentEnabledAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a viewer', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await setAgentEnabledAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('rejects invalid input before calling the capability', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'admin' };
    expect(await setAgentEnabledAction({ agent_key: 'nope', enabled: 'yes' })).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a member: agent settings are owner/admin only', async () => {
    expect(await setAgentEnabledAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it.each(['owner', 'admin'])('calls the capability for an %s with valid input', async (role) => {
    ctl.viewer = { ...ctl.viewer, role };
    expect(await setAgentEnabledAction(valid)).toMatchObject({ ok: true });
    expect(ctl.created).toHaveLength(1);
  });
});

describe('createScheduleAction', () => {
  const valid = { agent_key: 'weekly-studio', interval_seconds: 3600 };
  it('forbids a demo guest', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await createScheduleAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a viewer', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await createScheduleAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('rejects invalid input before calling the capability', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'admin' };
    expect(await createScheduleAction({ agent_key: 'nope', interval_seconds: 1 })).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a member: agent settings are owner/admin only', async () => {
    expect(await createScheduleAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it.each(['owner', 'admin'])('calls the capability for an %s with valid input', async (role) => {
    ctl.viewer = { ...ctl.viewer, role };
    expect(await createScheduleAction(valid)).toMatchObject({ ok: true });
    expect(ctl.created).toHaveLength(1);
  });
});

describe('setWorkspaceCapsAction', () => {
  const valid = { daily_cap_cents: 100, weekly_cap_cents: 500 };
  it('forbids a demo guest', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await setWorkspaceCapsAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a viewer', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await setWorkspaceCapsAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it('forbids a member: agent settings are owner/admin only', async () => {
    expect(await setWorkspaceCapsAction(valid)).toMatchObject({ ok: false });
    expect(ctl.created).toHaveLength(0);
  });
  it.each(['owner', 'admin'])('calls the capability for an %s with valid input', async (role) => {
    ctl.viewer = { ...ctl.viewer, role };
    expect(await setWorkspaceCapsAction(valid)).toMatchObject({ ok: true });
    expect(ctl.created).toHaveLength(1);
  });
});

describe('runAgentNowAction', () => {
  it('forbids a demo guest and does not run', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await runAgentNowAction({})).toMatchObject({ ok: false });
    expect(svc.run).not.toHaveBeenCalled();
  });
  it('forbids a viewer and does not run', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await runAgentNowAction({})).toMatchObject({ ok: false });
    expect(svc.run).not.toHaveBeenCalled();
  });
  it('runs with the service client, the VIEWER org (input ignored) and manual trigger', async () => {
    const res = await runAgentNowAction({ org_id: 'evil-org', orgId: 'evil-org' });
    expect(res).toEqual({ ok: true, runId: 'r1' });
    expect(svc.run).toHaveBeenCalledTimes(1);
    expect(svc.run).toHaveBeenCalledWith(svc.client, 'org1', 'manual');
  });
  it('returns a safe error without leaking the exception', async () => {
    svc.run.mockRejectedValue(new Error('secret-key-123'));
    const res = await runAgentNowAction({});
    expect(res).toEqual({ ok: false, error: 'The run could not be started.' });
  });
  it('a member may start a run (it obeys the switch and every cap)', async () => {
    ctl.viewer = { ...ctl.viewer, role: 'member' };
    expect(await runAgentNowAction({})).toEqual({ ok: true, runId: 'r1' });
  });
  it('refuses when Weekly Studio is switched off and does not run', async () => {
    svc.cfg = { enabled: false, daily_cap_cents: 500, weekly_cap_cents: 2000 };
    const res = await runAgentNowAction({});
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('turned off') });
    expect(svc.run).not.toHaveBeenCalled();
  });
  it('refuses when the workspace daily cap is reached and does not run', async () => {
    svc.cfg = { enabled: true, daily_cap_cents: 100, weekly_cap_cents: 100_000 };
    svc.spent = () => 100;
    const res = await runAgentNowAction({});
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('daily spend cap') });
    expect(svc.run).not.toHaveBeenCalled();
    // The sum is asked of the database for the viewer's own org.
    expect(svc.rpcCalls[0]).toMatchObject({ name: 'agent_spend_cents', args: { p_org_id: 'org1' } });
  });
  it('refuses when the workspace weekly cap is reached and does not run', async () => {
    svc.cfg = { enabled: true, daily_cap_cents: 100_000, weekly_cap_cents: 300 };
    svc.spent = (age) => (age > 2 * 24 * 3600_000 ? 300 : 0);
    const res = await runAgentNowAction({});
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('weekly spend cap') });
    expect(svc.run).not.toHaveBeenCalled();
  });
  it('applies the default caps to a workspace with no saved settings', async () => {
    svc.spent = () => 500;
    expect(await runAgentNowAction({})).toMatchObject({ ok: false });
    expect(svc.run).not.toHaveBeenCalled();
  });
  it('does not run when the spend cannot be read', async () => {
    svc.spendError = true;
    expect(await runAgentNowAction({})).toEqual({ ok: false, error: 'The run could not be started.' });
    expect(svc.run).not.toHaveBeenCalled();
  });
  it('says so when the workspace already has a run in progress', async () => {
    svc.run.mockRejectedValue(new RunInProgressError());
    const res = await runAgentNowAction({});
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('already in progress') });
  });
  it('of two starts at the same moment, only the one that wins the claim runs', async () => {
    // The claim is the run insert itself (one running row per workspace), so both
    // calls reach it and the database lets exactly one through.
    svc.run.mockResolvedValueOnce({ runId: 'r1', status: 'done' }).mockRejectedValueOnce(new RunInProgressError());
    const results = await Promise.all([runAgentNowAction({}), runAgentNowAction({})]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: expect.stringContaining('already in progress') });
  });
  it('first closes a run of this workspace that has been stuck past the time limit', async () => {
    await runAgentNowAction({});
    const sweep = svc.writes.find((w) => w.table === 'agent_runs');
    expect(sweep?.patch).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(sweep?.eqs).toContainEqual(['status', 'running']);
    expect(sweep?.eqs).toContainEqual(['org_id', 'org1']);
    expect(sweep?.lts.map(([c]) => c)).toEqual(['started_at']);
  });
});
