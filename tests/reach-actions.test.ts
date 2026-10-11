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

const svc = vi.hoisted(() => {
  const o = { client: {} as object, run: vi.fn(), inflight: null as unknown };
  // Chainable fake for the in-flight guard's SELECT on agent_runs.
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: o.inflight, error: null }),
  };
  o.client = { from: () => chain };
  return o;
});
vi.mock('@/lib/supabase/service', () => ({ serviceClient: vi.fn(() => svc.client) }));
vi.mock('@/lib/agents/weekly-studio', () => ({
  runWeeklyStudio: svc.run,
}));

const { createCampaignAction, createLeadAction, createAppointmentAction, setAgentEnabledAction, runAgentNowAction, createScheduleAction, setWorkspaceCapsAction } = await import('@/app/(app)/reach/actions');

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'member', isDemo: false };
  ctl.created = [];
  svc.run.mockReset();
  svc.run.mockResolvedValue({ runId: 'r1', status: 'done' });
  svc.inflight = null;
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
  it('refuses when a run is already in progress for the org and does not start another', async () => {
    svc.inflight = { id: 'r0' };
    const res = await runAgentNowAction({});
    expect(res).toMatchObject({ ok: false });
    expect(svc.run).not.toHaveBeenCalled();
  });
});
