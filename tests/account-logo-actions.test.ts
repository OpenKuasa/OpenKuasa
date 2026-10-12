import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGO_NOT_IMAGE, LOGO_REFUSALS, LOGO_TOO_BIG, LOGO_UPLOAD_FAILED } from '@/lib/account/logo-refusals';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const NEW = `${ORG}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`;
const NEW_JPG = `${ORG}/abcdef03-aaaa-4bbb-8ccc-0123456789ab.jpg`;
const NEW_WEBP = `${ORG}/abcdef04-aaaa-4bbb-8ccc-0123456789ab.webp`;
const OLD = `${ORG}/abcdef02-aaaa-4bbb-8ccc-0123456789ab.webp`;
const DEMO_SENTENCE = 'The demo workspace is read-only. Sign up to save changes.';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const blob = (bytes: number[], extra = 0) => new Blob([new Uint8Array([...bytes, ...new Array(extra).fill(0)])]);

type Reply = { data?: unknown; error?: { code?: string; message?: string } | null };

const ctl = vi.hoisted(() => ({
  events: 0,
  viewer: { userId: 'u', orgId: 'o', role: 'owner', isDemo: false } as { userId: string; orgId: string; role: string; isDemo: boolean },
  client: null as unknown,
  clients: 0,
  removed: [] as string[],
  buckets: [] as string[],
  removeError: null as null | { message: string },
  removeThrows: false,
  serviceBuilt: 0,
  serviceThrows: false,
  /** What storage holds at a path: the file, or how the download goes wrong. */
  stored: null as Blob | null | 'error' | 'missing' | 'missing-400' | 'throws',
  downloads: [] as string[],
  /** What the service client's `set_org_logo` answers, and what it was asked. */
  rpc: {} as { data?: unknown; error?: { code?: string; message?: string } | null },
  rpcCalls: [] as { fn: string; args: unknown }[],
  /** Every step in the order it happened. */
  steps: [] as string[],
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
    if (ctl.serviceThrows) throw new Error('Service role is not configured. SECRET');
    return {
      rpc: async (fn: string, args: unknown) => {
        ctl.steps.push(`rpc:${fn}`);
        ctl.rpcCalls.push({ fn, args });
        return { data: ctl.rpc.data ?? null, error: ctl.rpc.error ?? null };
      },
      storage: {
        from: (bucket: string) => {
          ctl.buckets.push(bucket);
          return {
            download: async (path: string) => {
              ctl.steps.push('download');
              ctl.downloads.push(path);
              if (ctl.stored === 'throws') throw new Error('SECRET download failure');
              // What storage-js hands back: a missing object answers 404 (or 400 with statusCode '404'); a 5xx is another thing.
              if (ctl.stored === 'missing' || ctl.stored === null) return { data: null, error: { message: 'SECRET', status: 404, statusCode: '404' } };
              if (ctl.stored === 'missing-400') return { data: null, error: { message: 'SECRET', status: 400, statusCode: '404' } };
              if (ctl.stored === 'error') return { data: null, error: { message: 'SECRET not found', status: 503, statusCode: '503' } };
              return { data: ctl.stored, error: null };
            },
            remove: async (paths: string[]) => {
              ctl.steps.push('remove');
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
    ctl.events += 1;
  },
}));

const { setLogo, clearLogo, removeLogoFile, discardLogoUpload } = await import('@/lib/account/logo-server');
const { setLogoAction, clearLogoAction } = await import('@/app/account/logo-actions');

/** The session's client: it must never be asked to set a logo. */
const session = (replies: Record<string, Reply> = {}) => fakeSupabase(replies as never);
const ctxOf = (client: never, actorId: string = USER) => ({ client, orgId: ORG, actorId });
const answers = (reply: Reply) => {
  ctl.rpc = reply;
};

beforeEach(() => {
  ctl.viewer = { userId: USER, orgId: ORG, role: 'owner', isDemo: false };
  ctl.client = null;
  ctl.clients = 0;
  ctl.removed = [];
  ctl.buckets = [];
  ctl.removeError = null;
  ctl.removeThrows = false;
  ctl.serviceBuilt = 0;
  ctl.serviceThrows = false;
  ctl.stored = blob(PNG, 100);
  ctl.downloads = [];
  ctl.rpc = {};
  ctl.rpcCalls = [];
  ctl.steps = [];
  ctl.events = 0;
  ctl.revalidated = [];
  vi.restoreAllMocks();
});

describe('setLogo', () => {
  it('downloads the upload with the service client, then calls the three-argument function with it, then removes the old file', async () => {
    answers({ data: { logo_path: NEW, old_path: OLD } });
    const { client, calls } = session();
    expect(await setLogo(ctxOf(client), NEW)).toEqual({ ok: true, data: { logo_path: NEW } });
    expect(ctl.downloads).toEqual([NEW]);
    expect(ctl.rpcCalls).toEqual([{ fn: 'set_org_logo', args: { p_org: ORG, p_actor: USER, p_path: NEW } }]);
    expect(ctl.steps).toEqual(['download', 'rpc:set_org_logo', 'remove']);
    expect(ctl.removed).toEqual([OLD]);
    expect(new Set(ctl.buckets)).toEqual(new Set(['org-logos']));
    // The signed-in user's own client is never asked: they may not call the function.
    expect(calls).toEqual([]);
  });

  it('takes a PNG, a JPEG and a WebP whose bytes are what the path ends in', async () => {
    for (const [path, bytes] of [[NEW, PNG], [NEW_JPG, JPG], [NEW_WEBP, WEBP]] as const) {
      ctl.stored = blob([...bytes]);
      answers({ data: { logo_path: path, old_path: null } });
      expect(await setLogo(ctxOf(session().client), path), path).toEqual({ ok: true, data: { logo_path: path } });
    }
    expect(ctl.rpcCalls.map((c) => (c.args as { p_path: string }).p_path)).toEqual([NEW, NEW_JPG, NEW_WEBP]);
  });

  it('refuses bytes that are no image, whatever the path says, and never asks the database', async () => {
    const text = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/> just text, named .png']);
    for (const stored of [text, new Blob(['GIF89a..........']), new Blob([new Uint8Array(PNG.slice(0, 7))]), new Blob([])]) {
      ctl.stored = stored;
      expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    }
    expect(ctl.rpcCalls).toEqual([]);
    expect(ctl.downloads).toHaveLength(4);
  });

  it('refuses real image bytes under another type\'s extension', async () => {
    for (const [path, bytes] of [[NEW, JPG], [NEW, WEBP], [NEW_JPG, PNG], [NEW_WEBP, PNG], [NEW_WEBP, JPG]] as const) {
      ctl.stored = blob([...bytes]);
      expect(await setLogo(ctxOf(session().client), path), path).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    }
    expect(ctl.rpcCalls).toEqual([]);
  });

  it('takes exactly 1 MB and refuses one byte more with the size sentence', async () => {
    ctl.stored = blob(PNG, 1_048_576 - PNG.length);
    answers({ data: { logo_path: NEW, old_path: null } });
    expect(await setLogo(ctxOf(session().client), NEW)).toMatchObject({ ok: true });
    ctl.stored = blob(PNG, 1_048_576 - PNG.length + 1);
    expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: LOGO_TOO_BIG });
    expect(ctl.rpcCalls).toHaveLength(1);
  });

  it('refuses when there is no file to look at, and answers the generic sentence when the look itself failed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const missing of ['missing', 'missing-400'] as const) {
      ctl.stored = missing;
      expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: LOGO_UPLOAD_FAILED });
    }
    // A failed download that does not say the object is absent (a 5xx, the network) is a write failure, whatever its words.
    ctl.stored = 'error';
    expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    ctl.stored = 'throws';
    expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    ctl.serviceThrows = true;
    expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    expect(ctl.rpcCalls).toEqual([]);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(ORG);
  });

  it('refuses without an acting user, before anything is built', async () => {
    for (const actor of ['', undefined, null, 5]) {
      expect(await setLogo({ client: session().client, orgId: ORG, actorId: actor as never }, NEW)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    }
    expect(ctl.serviceBuilt).toBe(0);
  });

  it('removes nothing on a first set, or when the same path is set again', async () => {
    answers({ data: { logo_path: NEW, old_path: null } });
    expect(await setLogo(ctxOf(session().client), NEW)).toMatchObject({ ok: true });
    answers({ data: { logo_path: NEW, old_path: NEW } });
    expect(await setLogo(ctxOf(session().client), NEW)).toMatchObject({ ok: true });
    expect(ctl.removed).toEqual([]);
  });

  it('refuses a path of the wrong shape or another workspace before any call', async () => {
    const { client, calls } = session();
    for (const path of [`${OTHER}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`, '../x.png', `${ORG}/x.png`, '', 5, null, undefined]) {
      expect(await setLogo(ctxOf(client), path)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    }
    expect(calls).toEqual([]);
    expect(ctl.serviceBuilt).toBe(0);
  });

  it('maps each code to its sentence', async () => {
    for (const code of ['LOGO_NOT_ALLOWED', 'LOGO_BAD_FILE']) {
      answers({ error: { code: 'P0001', message: code } });
      expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: LOGO_REFUSALS[code] });
    }
  });

  it('answers the generic sentence for an unknown error, logging the code only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    answers({ error: { code: 'XX000', message: `boom SECRET ${NEW}` } });
    expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(NEW);
    expect(logged).not.toContain(ORG);
    expect(logged).not.toContain(USER);
  });

  it('answers the generic sentence for a reply of the wrong shape and removes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const data of [null, {}, { logo_path: 5, old_path: OLD }, { logo_path: NEW, old_path: 5 }]) {
      answers({ data });
      expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    }
    expect(ctl.removed).toEqual([]);
  });

  it('never fails because the old file would not go, and logs no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const how of ['error', 'throws'] as const) {
      ctl.removeError = how === 'error' ? { message: `SECRET ${OLD}` } : null;
      ctl.removeThrows = how === 'throws';
      answers({ data: { logo_path: NEW, old_path: OLD } });
      expect(await setLogo(ctxOf(session().client), NEW)).toEqual({ ok: true, data: { logo_path: NEW } });
    }
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(OLD);
    expect(logged).not.toContain(ORG);
  });

  it('removes no old path the database handed back that is not of the shape in this workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answers({ data: { logo_path: NEW, old_path: `${OTHER}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png` } });
    expect(await setLogo(ctxOf(session().client), NEW)).toMatchObject({ ok: true });
    expect(ctl.removed).toEqual([]);
  });
});

describe('clearLogo', () => {
  it('calls clear_org_logo with exactly p_org as the signed-in user, then removes the path handed back', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.clear_org_logo': { data: { old_path: OLD } } });
    expect(await clearLogo(ctxOf(client))).toEqual({ ok: true, data: { cleared: true } });
    expect(calls).toEqual([{ table: 'rpc', op: 'rpc', fn: 'clear_org_logo', args: { p_org: ORG }, filters: {} }]);
    expect(ctl.removed).toEqual([OLD]);
    expect(ctl.rpcCalls).toEqual([]);
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
  it('refuses a member and a viewer before any call: the service client is never built for them', async () => {
    for (const role of ['member', 'viewer']) {
      ctl.viewer = { ...ctl.viewer, role };
      expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    }
    expect(ctl.clients).toBe(0);
    expect(ctl.serviceBuilt).toBe(0);
  });
  it('refuses a path that is not a string, or of another workspace, before any call', async () => {
    expect(await setLogoAction({ path: NEW })).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    expect(await setLogoAction(`${OTHER}/abcdef01-aaaa-4bbb-8ccc-0123456789ab.png`)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    expect(ctl.clients).toBe(0);
    expect(ctl.serviceBuilt).toBe(0);
  });
  it('lets an owner and an admin set it: the workspace and the acting user are the session\'s, and the layout is revalidated', async () => {
    for (const role of ['owner', 'admin']) {
      ctl.viewer = { ...ctl.viewer, role };
      answers({ data: { logo_path: NEW, old_path: OLD } });
      ctl.client = session().client;
      expect(await setLogoAction(NEW)).toEqual({ ok: true, data: { logo_path: NEW } });
    }
    expect(ctl.rpcCalls.map((c) => c.args)).toEqual([
      { p_org: ORG, p_actor: USER, p_path: NEW },
      { p_org: ORG, p_actor: USER, p_path: NEW },
    ]);
    expect(ctl.revalidated[0]).toEqual(['/', 'layout']);
  });
  it('takes the acting user from the session and from nowhere in the request', async () => {
    answers({ data: { logo_path: NEW, old_path: null } });
    ctl.client = session().client;
    // A second argument, as a crafted call might send, is not read.
    await (setLogoAction as unknown as (path: unknown, actor: unknown) => Promise<unknown>)(NEW, OTHER);
    expect(ctl.rpcCalls.map((c) => (c.args as { p_actor: string }).p_actor)).toEqual([USER]);
    expect(setLogoAction.length).toBe(1);
  });
  it('removes the upload when its bytes are no image, and tells the person so', async () => {
    ctl.stored = new Blob(['this is text, named .png and declared image/png']);
    ctl.client = session({ 'orgs.select': { data: { logo_path: OLD } } }).client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_NOT_IMAGE });
    expect(ctl.rpcCalls).toEqual([]);
    expect(ctl.removed).toEqual([NEW]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('removes an upload over 1 MB with the size sentence', async () => {
    ctl.stored = blob(PNG, 1_048_577);
    ctl.client = session({ 'orgs.select': { data: { logo_path: null } } }).client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_TOO_BIG });
    expect(ctl.removed).toEqual([NEW]);
  });
  it('removes the upload when the database refuses, and keeps it when the outcome is unknown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answers({ error: { code: 'P0001', message: 'LOGO_BAD_FILE' } });
    ctl.client = session({ 'orgs.select': { data: { logo_path: OLD } } }).client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_BAD_FILE });
    expect(ctl.removed).toEqual([NEW]);

    ctl.removed = [];
    answers({ error: { code: 'XX000', message: 'boom' } });
    ctl.client = session({ 'orgs.select': { data: { logo_path: OLD } } }).client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    expect(ctl.removed).toEqual([]);
  });
  it('removes the upload when storage says it is not there, and keeps it when the download merely failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.client = session({ 'orgs.select': { data: { logo_path: OLD } } }).client;
    ctl.stored = 'missing';
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: LOGO_UPLOAD_FAILED });
    expect(ctl.removed).toEqual([NEW]);

    ctl.removed = [];
    ctl.stored = 'error';
    ctl.client = session({ 'orgs.select': { data: { logo_path: OLD } } }).client;
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    ctl.stored = 'throws';
    expect(await setLogoAction(NEW)).toEqual({ ok: false, error: WRITE_FAILED });
    expect(ctl.removed).toEqual([]);
    expect(ctl.rpcCalls).toEqual([]);
  });
  it('never removes the current logo when a refused call names it', async () => {
    ctl.stored = new Blob(['not an image']);
    ctl.client = session({ 'orgs.select': { data: { logo_path: NEW } } }).client;
    await setLogoAction(NEW);
    expect(ctl.removed).toEqual([]);
  });
  it('does not record an activity entry (the database function does)', async () => {
    answers({ data: { logo_path: NEW, old_path: null } });
    ctl.client = session().client;
    await expect(setLogoAction(NEW)).resolves.toMatchObject({ ok: true });
    expect(ctl.events).toBe(0);
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
    expect(ctl.events).toBe(0);
  });
  it('does not revalidate on a refusal', async () => {
    const { client } = fakeSupabase({ 'rpc.clear_org_logo': { error: { code: 'P0001', message: 'LOGO_NOT_ALLOWED' } } });
    ctl.client = client;
    expect(await clearLogoAction()).toEqual({ ok: false, error: LOGO_REFUSALS.LOGO_NOT_ALLOWED });
    expect(ctl.revalidated).toEqual([]);
  });
});
