import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  user: null as { id: string; is_anonymous: boolean } | null,
  org: null as { orgId: string; role: string } | null,
  orgFails: false,
  env: true,
  viewer: { employeeId: 'e1', isHr: true, isDemo: false } as {
    employeeId: string | null;
    isHr: boolean;
    isDemo: boolean;
  },
  orgLookups: 0,
  createdFor: [] as string[],
  fallbackCalls: 0,
  clientCreations: 0,
}));

const ORG_PROVIDER = { marker: 'org' };
const FALLBACK_PROVIDER = { marker: 'fallback' };
const PREVIEW_PROVIDER = { marker: 'preview' };

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clientCreations += 1;
    return {
      auth: { getUser: async () => ({ data: { user: ctl.user }, error: null }) },
    };
  },
}));

vi.mock('@/lib/people/seed', () => ({ createSeedPeopleData: () => PREVIEW_PROVIDER }));

vi.mock('@/lib/auth/current-org', () => ({
  getCurrentOrg: async () => {
    ctl.orgLookups += 1;
    if (ctl.orgFails) throw new Error('org lookup failed');
    return ctl.org;
  },
}));

vi.mock('@/lib/auth/viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/viewer')>();
  return { ...actual, hasSupabaseEnv: () => ctl.env };
});

vi.mock('@/lib/people/viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/viewer')>();
  return { ...actual, getPeopleViewer: async () => ctl.viewer };
});

vi.mock('@/lib/people/supabase', () => ({
  createSupabasePeopleData: (_client: unknown, orgId: string) => {
    ctl.createdFor.push(orgId);
    return ORG_PROVIDER;
  },
  getPeopleData: async () => {
    ctl.fallbackCalls += 1;
    return FALLBACK_PROVIDER;
  },
}));

import { loadPeople } from '@/screens/people/parts';

const build = vi.fn<(data: unknown, now: Date, ctx: unknown) => Promise<{ got: unknown }>>(async (data) => ({ got: data }));

beforeEach(() => {
  vi.restoreAllMocks();
  ctl.user = { id: 'u1', is_anonymous: false };
  ctl.org = null;
  ctl.orgFails = false;
  ctl.env = true;
  ctl.viewer = { employeeId: 'e1', isHr: true, isDemo: false };
  ctl.orgLookups = 0;
  ctl.createdFor = [];
  ctl.fallbackCalls = 0;
  ctl.clientCreations = 0;
  build.mockClear();
  build.mockImplementation(async (data) => ({ got: data }));
});

describe('loadPeople', () => {
  it('builds the provider from the resolved workspace, resolving it once', async () => {
    ctl.org = { orgId: 'org-1', role: 'owner' };
    const r = await loadPeople('t', build);
    expect(r.hasWorkspace).toBe(true);
    expect(ctl.createdFor).toEqual(['org-1']);
    expect(ctl.fallbackCalls).toBe(0);
    expect(ctl.orgLookups).toBe(1);
    expect(r.model).toEqual({ got: ORG_PROVIDER });
    expect(r.viewer).toBe(ctl.viewer);
  });

  it('falls back to getPeopleData for someone in no workspace', async () => {
    const r = await loadPeople('t', build);
    expect(r.hasWorkspace).toBe(false);
    expect(ctl.fallbackCalls).toBe(1);
    expect(ctl.createdFor).toEqual([]);
    expect(r.model).not.toBeNull();
  });

  it('counts the sample company as a workspace when no project is configured', async () => {
    ctl.env = false;
    const r = await loadPeople('t', build);
    expect(r.hasWorkspace).toBe(true);
    expect(ctl.orgLookups).toBe(0);
    expect(ctl.fallbackCalls).toBe(0);
    expect(ctl.clientCreations).toBe(0);
    expect(r.model).toEqual({ got: PREVIEW_PROVIDER });
    expect(r.viewer).toMatchObject({ isDemo: true });
    expect(r.chatDemo).toBe(true);
    expect(build.mock.calls[0][2]).toMatchObject({ client: null, orgId: null });
  });

  it('returns a null model, no workspace and does not throw when the org lookup fails', async () => {
    ctl.orgFails = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await loadPeople('t', build);
    expect(r.model).toBeNull();
    expect(r.hasWorkspace).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it('keeps the viewer and workspace resolved before build throws', async () => {
    ctl.org = { orgId: 'org-1', role: 'member' };
    ctl.viewer = { employeeId: null, isHr: false, isDemo: false };
    build.mockImplementation(async () => {
      throw new Error('boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await loadPeople('t', build);
    expect(r.model).toBeNull();
    expect(r.viewer).toBe(ctl.viewer);
    expect(r.hasWorkspace).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('gives the canned chat answer to signed-out and anonymous visitors only', async () => {
    ctl.user = null;
    expect((await loadPeople('t', build)).chatDemo).toBe(true);
    ctl.user = { id: 'u2', is_anonymous: true };
    expect((await loadPeople('t', build)).chatDemo).toBe(true);
    ctl.user = { id: 'u3', is_anonymous: false };
    expect((await loadPeople('t', build)).chatDemo).toBe(false);
  });

  it('hands the builder the workspace and the viewer it resolved', async () => {
    ctl.org = { orgId: 'org-9', role: 'owner' };
    await loadPeople('test', build);
    const ctx = build.mock.calls[0][2] as { orgId: string | null; viewer: unknown; client: unknown };
    expect(ctx.orgId).toBe('org-9');
    expect(ctx.viewer).toEqual(ctl.viewer);
    expect(ctx.client).toBeDefined();

    build.mockClear();
    ctl.org = null;
    await loadPeople('test', build);
    expect((build.mock.calls[0][2] as { orgId: string | null }).orgId).toBeNull();
  });
});
