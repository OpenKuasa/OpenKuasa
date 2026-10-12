import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGO_REFUSALS } from '@/lib/account/logo-refusals';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const NEW = `${ORG}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`;
const OLD = `${ORG}/abcdef02-aaaa-4bbb-8ccc-0123456789ab.webp`;
const DEMO_SENTENCE = 'The demo workspace is read-only. Sign up to save changes.';

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: '11111111-1111-4111-8111-111111111111', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  client: null as unknown,
  clients: 0,
  removed: [] as string[],
  buckets: [] as string[],
  removeError: null as null | { message: string },
  removeThrows: false,
  serviceBuilt: 0,
  revalidated: [] as unknown[][],
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clients += 1;
    return ctl.client;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => ctl.revalidated.push(args) }));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    ctl.serviceBuilt += 1;
    return {
      storage: {
        from: (bucket: string) => {
          ctl.buckets.push(bucket);
          return {
            remove: async (paths: string[]) => {
              if (ctl.removeThrows) throw new Error('SECRET removal failure');
              ctl.removed.push(...paths);
              return { error: ctl.removeError };
            },
          };
        },
      },
    };
  },
}));
vi.mock('@/lib/events', () => ({
  recordEvent: () => {
    throw new Error('the logo functions record their own entry; the action must not');
  },
}));

const { setLogo, clearLogo, removeLogoFile, discardLogoUpload } = await import('@/lib/account/logo-server');
const { setLogoAction, clearLogoAction } = await import('@/app/account/logo-actions');

const ctxOf = (client: never) => ({ client, orgId: ORG });

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: ORG, role: 'owner', isDemo: false };
  ctl.client = null;
  ctl.clients = 0;
  ctl.removed = [];
  ctl.buckets = [];
  ctl.removeError = null;
  ctl.removeThrows = false;
  ctl.serviceBuilt = 0;
  ctl.revalidated = [];
  vi.restoreAllMocks();
});

describe('setLogo', () => {
  it('calls set_org_logo with exactly p_org and p_path, then removes the path the database handed back', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: OLD } } });
    expect(await setLogo(ctxOf(client), NEW)).toEqual({ ok: true, data: { logo_path: NEW } });
    expect(calls).toEqual([{ table: 'rpc', op: 'rpc', fn: 'set_org_logo', args: { p_org: ORG, p_path: NEW }, filters: {} }]);
    expect(ctl.removed).toEqual([OLD]);
    expect(ctl.buckets).toEqual(['org-logos']);
  });

  it('removes nothing on a first set, or when the same path is set again', async () => {
    const first = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: null } } });
    expect(await setLogo(ctxOf(first.client), NEW)).toMatchObject({ ok: true });
    const same = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: NEW } } });
    expect(await setLogo(ctxOf(same.client), NEW)).toMatchObject({ ok: true });
    expect(ctl.removed).toEqual([]);
  });

  it('refuses a path of the wrong shape or another workspace before any call', async () => {
    const { client, calls } = fakeSupabase();
    for (const path of [`${OTHER}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`, '../x.png', `${ORG}/x.png`, '', 5, null, undefined]) {
      expect(await setLogo(ctxOf(client), path)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    }
    expect(calls).toEqual([]);
  });

  it('maps each code to its sentence', async () => {
    for (const code of ['LOGO_NOT_ALLOWED', 'LOGO_BAD_FILE']) {
      const { client } = fakeSupabase({ 'rpc.set_org_logo': { error: { code: 'P0001', message: code } } });
      expect(await setLogo(ctxOf(client), NEW)).toEqual({ ok: false, error: LOGO_REFUSALS[code] });
    }
  });

  it('answers the generic sentence for an unknown error, logging the code only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.set_org_logo': { error: { code: 'XX000', message: `boom SECRET ${NEW}` } } });
    expect(await setLogo(ctxOf(client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(NEW);
    expect(logged).not.toContain(ORG);
  });

  it('answers the generic sentence for a reply of the wrong shape and removes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const data of [null, {}, { logo_path: 5, old_path: OLD }, { logo_path: NEW, old_path: 5 }]) {
      const { client } = fakeSupabase({ 'rpc.set_org_logo': { data } });
      expect(await setLogo(ctxOf(client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    }
    expect(ctl.removed).toEqual([]);
  });

  it('never fails because the old file would not go, and logs no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const how of ['error', 'throws'] as const) {
      ctl.removeError = how === 'error' ? { message: `SECRET ${OLD}` } : null;
      ctl.removeThrows = how === 'throws';
      const { client } = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: OLD } } });
      expect(await setLogo(ctxOf(client), NEW)).toEqual({ ok: true, data: { logo_path: NEW } });
    }
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(OLD);
    expect(logged).not.toContain(ORG);
  });

  it('removes no old path the database handed back that is not of the shape in this workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: `${OTHER}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png` } } });
    expect(await setLogo(ctxOf(client), NEW)).toMatchObject({ ok: true });
    expect(ctl.removed).toEqual([]);
  });
});

describe('clearLogo', () => {
  it('calls clear_org_logo with exactly p_org, then removes the path handed back', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.clear_org_logo': { data: { old_path: OLD } } });
    expect(await clearLogo(ctxOf(client))).toEqual({ ok: true, data: { cleared: true } });
    expect(calls).toEqual([{ table: 'rpc', op: 'rpc', fn: 'clear_org_logo', args: { p_org: ORG }, filters: {} }]);
    expect(ctl.removed).toEqual([OLD]);
  });
  it('removes nothing when none was set', async () => {
    const { client } = fakeSupabase({ 'rpc.clear_org_logo': { data: { old_path: null } } });
    expect(await clearLogo(ctxOf(client))).toMatchObject({ ok: true });
    expect(ctl.removed).toEqual([]);
  });
  it('maps LOGO_NOT_ALLOWED to its sentence and an unknown error to the generic one', async () => {
    const denied = fakeSupabase({ 'rpc.clear_org_logo': { error: { code: 'P0001', message: 'LOGO_NOT_ALLOWED' } } });
    expect(await clearLogo(ctxOf(denied.client))).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = fakeSupabase({ 'rpc.clear_org_logo': { error: { code: '42501', message: 'permission denied' } } });
    expect(await clearLogo(ctxOf(other.client))).toEqual({ ok: false, error: WRITE_FAILED });
  });
  it('never fails because the old file would not go', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.removeThrows = true;
    const { client } = fakeSupabase({ 'rpc.clear_org_logo': { data: { old_path: OLD } } });
    expect(await clearLogo(ctxOf(client))).toMatchObject({ ok: true });
  });
});

describe('removeLogoFile', () => {
  it('removes a path of the shape from org-logos, one call', async () => {
    await removeLogoFile(OLD);
    expect(ctl.removed).toEqual([OLD]);
    expect(ctl.buckets).toEqual(['org-logos']);
  });
  it('builds no service client and removes nothing for a path of another shape', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const path of ['', '../x.png', `${ORG}/`, `${ORG}/x.png`, `${ORG}/${'a'.repeat(36)}.png`]) await removeLogoFile(path);
    expect(ctl.serviceBuilt).toBe(0);
    expect(ctl.removed).toEqual([]);
  });
  it('never throws, and logs one fixed sentence without the path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.removeThrows = true;
    await expect(removeLogoFile(OLD)).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain(ORG);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});

describe('discardLogoUpload', () => {
  it('removes an unattached upload of this workspace when it is not the current logo', async () => {
    const { client, calls } = fakeSupabase({ 'orgs.select': { data: { logo_path: OLD } } });
    await discardLogoUpload(ctxOf(client), NEW);
    expect(ctl.removed).toEqual([NEW]);
    expect(calls[0]).toMatchObject({ table: 'orgs', op: 'select', filters: { id: ORG } });
  });
  it('keeps the file when it IS the current logo, when the read fails, and for a path of the wrong shape', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await discardLogoUpload(ctxOf(fakeSupabase({ 'orgs.select': { data: { logo_path: NEW } } }).client), NEW);
    await discardLogoUpload(ctxOf(fakeSupabase({ 'orgs.select': { error: { message: 'x' } } }).client), NEW);
    await discardLogoUpload(ctxOf(fakeSupabase({ 'orgs.select': { data: null } }).client), NEW);
    await discardLogoUpload(ctxOf(fakeSupabase({ 'orgs.select': { data: { logo_path: null } } }).client), `${OTHER}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`);
    expect(ctl.removed).toEqual([]);
  });
});

describe('setLogoAction', () => {
  it('refuses the demo before reading anything or calling anything', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true, role: 'admin' };
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.clients).toBe(0);
    expect(ctl.serviceBuilt).toBe(0);
  });
  it('refuses a member and a viewer before any call', async () => {
    for (const role of ['member', 'viewer']) {
      ctl.viewer = { ...ctl.viewer, role };
      expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    }
    expect(ctl.clients).toBe(0);
    expect(ctl.serviceBuilt).toBe(0);
  });
  it('refuses a path that is not a string, before any call', async () => {
    expect(await setLogoAction({ path: NEW })).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    expect(ctl.clients).toBe(0);
  });
  it('lets an owner and an admin set it, using the session workspace, and revalidates the layout', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { ...ctl.viewer, role };
      const { client, calls } = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: OLD } } });
      ctl.client = client;
      expect(await setLogoAction(NEW)).toEqual({ ok: true, data: { logo_path: NEW } });
      expect(calls.map((c) => c.args)).toEqual([{ p_org: ORG, p_path: NEW }]);
    }
    expect(ctl.revalidated[0]).toEqual(['/', 'layout']);
  });
  it('removes the upload when the database refuses, and keeps it when the outcome is unknown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = fakeSupabase({
      'rpc.set_org_logo': { error: { code: 'P0001', message: 'LOGO_BAD_FILE' } },
      'orgs.select': { data: { logo_path: OLD } },
    });
    ctl.client = refused.client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    expect(ctl.removed).toEqual([NEW]);

    ctl.removed = [];
    const unknown = fakeSupabase({
      'rpc.set_org_logo': { error: { code: 'XX000', message: 'boom' } },
      'orgs.select': { data: { logo_path: OLD } },
    });
    ctl.client = unknown.client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    expect(ctl.removed).toEqual([]);
  });
  it('never removes the current logo when a refused call names it', async () => {
    const refused = fakeSupabase({
      'rpc.set_org_logo': { error: { code: 'P0001', message: 'LOGO_NOT_ALLOWED' } },
      'orgs.select': { data: { logo_path: NEW } },
    });
    ctl.client = refused.client;
    await setLogoAction(NEW);
    expect(ctl.removed).toEqual([]);
  });
  it('does not record an activity entry (the database function does)', async () => {
    const { client } = fakeSupabase({ 'rpc.set_org_logo': { data: { logo_path: NEW, old_path: null } } });
    ctl.client = client;
    await expect(setLogoAction(NEW)).resolves.toMatchObject({ ok: true });
  });
});

describe('clearLogoAction', () => {
  it('refuses the demo, a member and a viewer before any call', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await clearLogoAction()).toEqual({ ok: false, error: DEMO_SENTENCE });
    ctl.viewer = { ...ctl.viewer, isDemo: false, role: 'member' };
    expect(await clearLogoAction()).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    ctl.viewer = { ...ctl.viewer, role: 'viewer' };
    expect(await clearLogoAction()).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    expect(ctl.clients).toBe(0);
    expect(ctl.serviceBuilt).toBe(0);
  });
  it('lets an owner clear it, removes the old file after the database and revalidates the layout', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.clear_org_logo': { data: { old_path: OLD } } });
    ctl.client = client;
    expect(await clearLogoAction()).toEqual({ ok: true, data: { cleared: true } });
    expect(calls.map((c) => c.fn)).toEqual(['clear_org_logo']);
    expect(ctl.removed).toEqual([OLD]);
    expect(ctl.revalidated[0]).toEqual(['/', 'layout']);
  });
  it('does not revalidate on a refusal', async () => {
    const { client } = fakeSupabase({ 'rpc.clear_org_logo': { error: { code: 'P0001', message: 'LOGO_NOT_ALLOWED' } } });
    ctl.client = client;
    expect(await clearLogoAction()).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    expect(ctl.revalidated).toEqual([]);
  });
});
