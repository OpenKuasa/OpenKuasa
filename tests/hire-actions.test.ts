import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  revalidated: [] as string[],
  types: [] as (string | undefined)[],
  calls: [] as { fn: string; ctx: { orgId: string }; input: unknown }[],
  fail: false,
  refusal: 'This application is no longer active. Reopen it first.',
  change: { id: 'a1', candidate: 'Aina', job: 'Barista', stage: 'offer', outcome: 'active', rating: 4, reject_reason: null },
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string, type?: string) => { ctl.revalidated.push(path); ctl.types.push(type); } }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ marker: 'client' }) }));
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  const stub = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, ctx, input });
    return ctl.fail ? { ok: false, error: 'refused' } : { ok: true, data: { id: 'j1', title: 'Barista' } };
  };
  const change = (fn: string) => async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, ctx, input });
    return ctl.fail ? { ok: false, error: ctl.refusal } : { ok: true, data: ctl.change };
  };
  return { ...actual, moveApplication: change('moveApplication'), closeApplication: change('closeApplication'), reopenApplication: change('reopenApplication'), rateApplication: change('rateApplication'), createJob: stub('createJob'), updateJob: stub('updateJob'), setJobStatus: stub('setJobStatus'), deleteJob: stub('deleteJob'), updateCareersPage: stub('updateCareersPage'), updateApplicationForm: stub('updateApplicationForm') };
});

const {
  createJobAction, updateJobAction, setJobStatusAction, deleteJobAction, updateCareersPageAction, updateApplicationFormAction,
  moveApplicationAction, closeApplicationAction, reopenApplicationAction, rateApplicationAction,
} = await import('@/app/(app)/hire/actions');
const ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.types = [];
  ctl.calls = [];
  ctl.fail = false;
});

describe('hire job actions', () => {
  it('runs the capability with the viewer\'s workspace and refreshes the hiring screens', async () => {
    const sent = { title: 'Barista', org_id: 'someone-else' };
    const result = await createJobAction(sent);
    expect(result.ok).toBe(true);
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0]).toMatchObject({ fn: 'createJob', ctx: { orgId: 'org1', client: { marker: 'client' } } });
    expect(ctl.calls[0].input).toEqual(sent);
    expect(ctl.revalidated.sort()).toEqual([
      '/hire/applications',
      '/hire/assistant',
      '/hire/candidates',
      '/hire/careers-page',
      '/hire/dashboard',
      '/hire/interviews',
      '/hire/jobs',
    ]);
  });
  it('allows an owner and an admin who are not demo visitors', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { orgId: 'org1', role, isDemo: false };
      ctl.calls = [];
  ctl.fail = false;
      expect((await deleteJobAction({ id: ID })).ok).toBe(true);
      expect(ctl.calls).toHaveLength(1);
    }
  });
  it('refuses a viewer and a demo visitor without calling the capability', async () => {
    for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'demo', role: 'viewer', isDemo: true }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
      ctl.viewer = viewer;
      for (const run of [() => createJobAction({ title: 'x' }), () => updateJobAction({ id: ID }), () => setJobStatusAction({ id: ID, status: 'open' }), () => deleteJobAction({ id: ID })]) {
        expect(await run()).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
      }
    }
    expect(ctl.calls).toHaveLength(0);
    expect(ctl.revalidated).toHaveLength(0);
  });
  it('routes each action to its capability', async () => {
    await updateJobAction({ id: ID, title: 'Head Barista' });
    await setJobStatusAction({ id: ID, status: 'open' });
    await deleteJobAction({ id: ID });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['updateJob', 'setJobStatus', 'deleteJob']);
  });
});

describe('updateCareersPageAction', () => {
  it('refuses a viewer, a demo visitor and a demo owner without calling the capability', async () => {
    for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'demo', role: 'viewer', isDemo: true }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
      ctl.viewer = viewer;
      expect(await updateCareersPageAction({ careers_enabled: true })).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
    }
    expect(ctl.calls).toHaveLength(0);
    expect(ctl.revalidated).toHaveLength(0);
  });
  it('runs for an owner with the session context and refreshes the settings screen, the assistant and the public board with its job pages', async () => {
    ctl.viewer = { orgId: 'org1', role: 'owner', isDemo: false };
    const sent = { careers_enabled: true, org_id: 'someone-else' };
    expect((await updateCareersPageAction(sent)).ok).toBe(true);
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0]).toMatchObject({ fn: 'updateCareersPage', ctx: { orgId: 'org1', client: { marker: 'client' } } });
    expect(ctl.calls[0].input).toEqual(sent);
    expect(ctl.revalidated).toEqual(['/hire/careers-page', '/hire/assistant', '/careers/org1']);
    expect(ctl.types[2]).toBeUndefined();
  });
  it('refreshes nothing when the change was refused', async () => {
    ctl.viewer = { orgId: 'org1', role: 'owner', isDemo: false };
    ctl.fail = true;
    expect(await updateCareersPageAction({ careers_enabled: true })).toEqual({ ok: false, error: 'refused' });
    expect(ctl.revalidated).toHaveLength(0);
  });
});

describe('updateApplicationFormAction', () => {
  it('refuses a viewer, a demo visitor and a demo owner without calling the capability', async () => {
    for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'demo', role: 'viewer', isDemo: true }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
      ctl.viewer = viewer;
      expect(await updateApplicationFormAction({ require_cv: true })).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
    }
    expect(ctl.calls).toHaveLength(0);
    expect(ctl.revalidated).toHaveLength(0);
  });
  it('runs for an owner with the session context and refreshes the settings screen, the assistant and the public job pages', async () => {
    ctl.viewer = { orgId: 'org1', role: 'owner', isDemo: false };
    const sent = { require_cv: true, org_id: 'someone-else' };
    expect((await updateApplicationFormAction(sent)).ok).toBe(true);
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0]).toMatchObject({ fn: 'updateApplicationForm', ctx: { orgId: 'org1', client: { marker: 'client' } } });
    expect(ctl.calls[0].input).toEqual(sent);
    expect(ctl.revalidated).toEqual(['/hire/settings', '/hire/assistant', '/careers/org1']);
  });
  it('refreshes nothing when the change was refused', async () => {
    ctl.viewer = { orgId: 'org1', role: 'owner', isDemo: false };
    ctl.fail = true;
    expect(await updateApplicationFormAction({ require_cv: true })).toEqual({ ok: false, error: 'refused' });
    expect(ctl.revalidated).toHaveLength(0);
  });
});

describe('application change actions', () => {
  const APP = '44444444-4444-4444-8444-444444444444';
  const HIRING_SCREENS = [
    '/hire/applications', '/hire/assistant', '/hire/candidates', '/hire/careers-page', '/hire/dashboard', '/hire/interviews', '/hire/jobs',
  ];
  const each: [string, string, (input: unknown) => Promise<unknown>, Record<string, unknown>][] = [
    ['moveApplicationAction', 'moveApplication', (input) => moveApplicationAction(input), { id: APP, stage: 'offer' }],
    ['closeApplicationAction', 'closeApplication', (input) => closeApplicationAction(input), { id: APP, outcome: 'rejected', reason: 'experience' }],
    ['reopenApplicationAction', 'reopenApplication', (input) => reopenApplicationAction(input), { id: APP }],
    ['rateApplicationAction', 'rateApplication', (input) => rateApplicationAction(input), { id: APP, rating: null }],
  ];

  for (const [name, capability, action, input] of each) {
    describe(name, () => {
      it('gives the capability the input as sent and the session\'s workspace, answers with its result and refreshes the hiring screens', async () => {
        const sent = { ...input, org_id: 'someone-else' };
        expect(await action(sent)).toEqual({ ok: true, data: ctl.change });
        expect(ctl.calls).toHaveLength(1);
        expect(ctl.calls[0]).toMatchObject({ fn: capability, ctx: { orgId: 'org1', client: { marker: 'client' } } });
        expect(ctl.calls[0].input).toEqual(sent);
        expect([...ctl.revalidated].sort()).toEqual(HIRING_SCREENS);
      });
      it('answers with the capability\'s refusal, word for word, and refreshes nothing', async () => {
        ctl.fail = true;
        expect(await action(input)).toEqual({ ok: false, error: 'This application is no longer active. Reopen it first.' });
        expect(ctl.calls).toHaveLength(1);
        expect(ctl.revalidated).toHaveLength(0);
      });
      it('refuses a viewer, a demo visitor and a demo owner without calling the capability', async () => {
        for (const viewer of [{ orgId: 'org1', role: 'viewer', isDemo: false }, { orgId: 'demo', role: 'viewer', isDemo: true }, { orgId: 'org1', role: 'owner', isDemo: true }]) {
          ctl.viewer = viewer;
          expect(await action(input)).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
        }
        expect(ctl.calls).toHaveLength(0);
        expect(ctl.revalidated).toHaveLength(0);
      });
      it('runs for a member, an admin and an owner', async () => {
        for (const role of ['member', 'admin', 'owner']) {
          ctl.viewer = { orgId: 'org1', role, isDemo: false };
          expect(await action(input)).toMatchObject({ ok: true });
        }
        expect(ctl.calls).toHaveLength(3);
      });
    });
  }
});
