import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGO_BUCKET, LOGO_PATH } from '@/lib/account/logo-url';
import { DOCUMENT_BUCKET, DOCUMENT_PATH } from '@/lib/people/document-files';
import {
  DOCUMENT_BUCKET as CORE_DOCUMENT_BUCKET,
  DOCUMENT_PATH_SHAPE,
  LOGO_BUCKET as CORE_LOGO_BUCKET,
  LOGO_PATH_SHAPE,
  SWEEP_CALL_LIMIT,
  runSweep,
  sweepAllFiles,
  sweepLogoFiles,
} from '@/lib/maintenance/sweep-files.mjs';
import * as script from '../scripts/sweep-document-files.mjs';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const GONE = '99999999-9999-4999-8999-999999999999';
const EMP = '33333333-3333-4333-8333-333333333333';
const doc = (org: string, n: number) => `${org}/${EMP}/${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-0123456789ab.pdf`;
const logo = (org: string, n: number, ext = 'png') => `${org}/${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-0123456789ab.${ext}`;

type Opts = {
  /** The stray logo files, oldest first, as the database lists them. */
  strays?: string[];
  /** Names the database no longer calls stray when asked just before the removal (a logo by then, or gone). */
  notStrayNow?: string[];
  listError?: { code?: string; message: string };
  askError?: (name: string) => { code?: string; message: string } | null;
  removeFails?: (path: string) => boolean;
  removeThrows?: (path: string) => boolean;
  folders?: string[];
  /** What each release call answers for a workspace: the paths, up to the limit asked. */
  orphans?: Record<string, string[]>;
  releaseError?: Record<string, { code?: string; message: string }>;
};

/** A stand-in for the service client: the sweep's functions, a bucket's top level and `remove`. Removed files leave the lists. */
function fakeClient(opts: Opts = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const removed: { bucket: string; path: string }[] = [];
  const strays = [...(opts.strays ?? [])];
  const orphans: Record<string, string[]> = Object.fromEntries(Object.entries(opts.orphans ?? {}).map(([k, v]) => [k, [...v]]));
  const client = {
    rpc: (fn: string, args?: { p_org?: string; p_limit?: number; p_name?: string }) => {
      calls.push({ kind: `rpc:${fn}`, args: [args] });
      const settle = async (from = 0, to = Number.MAX_SAFE_INTEGER) => {
        if (fn === 'org_orphaned_logo_files') {
          calls.push({ kind: 'range', args: [from, to] });
          if (opts.listError) return { data: null, error: opts.listError };
          return { data: strays.slice(from, to + 1), error: null };
        }
        if (fn === 'org_logo_file_is_orphaned') {
          const name = args?.p_name ?? '';
          const error = opts.askError?.(name) ?? null;
          if (error) return { data: null, error };
          return { data: strays.includes(name) && !(opts.notStrayNow ?? []).includes(name), error: null };
        }
        if (fn === 'hr_orphaned_document_files') return { data: (orphans[args?.p_org ?? ''] ?? []).slice(from, to + 1), error: null };
        if (fn === 'hr_release_orphaned_document_files') {
          const error = opts.releaseError?.[args?.p_org ?? ''];
          if (error) return { data: null, error };
          return { data: (orphans[args?.p_org ?? ''] ?? []).slice(0, args?.p_limit ?? 0), error: null };
        }
        return { data: null, error: { message: 'unknown function' } };
      };
      return {
        range: (from: number, to: number) => settle(from, to),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => settle().then(resolve, reject),
      };
    },
    storage: {
      from: (bucket: string) => ({
        list: async (_path: string, options: { limit: number; offset: number }) => {
          calls.push({ kind: `list:${bucket}`, args: [options] });
          return { data: (opts.folders ?? []).slice(options.offset, options.offset + options.limit).map((name) => ({ name, id: null })), error: null };
        },
        remove: async (paths: string[]) => {
          calls.push({ kind: `remove:${bucket}`, args: [paths] });
          if (paths.some((p) => opts.removeThrows?.(p))) throw new Error(`SECRET ${paths[0]}`);
          if (paths.some((p) => opts.removeFails?.(p))) return { data: null, error: { message: `SECRET ${paths[0]}` } };
          for (const path of paths) {
            removed.push({ bucket, path });
            if (bucket === CORE_LOGO_BUCKET && strays.includes(path)) strays.splice(strays.indexOf(path), 1);
            for (const list of Object.values(orphans)) if (bucket === CORE_DOCUMENT_BUCKET && list.includes(path)) list.splice(list.indexOf(path), 1);
          }
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { client: client as never, calls, removed, kinds: () => calls.map((c) => c.kind) };
}

const logger = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line), text: () => lines.join('\n') };
};

describe('the shapes and buckets', () => {
  it('are the very ones the app and the database use', () => {
    expect(LOGO_PATH_SHAPE.source).toBe(LOGO_PATH.source);
    expect(DOCUMENT_PATH_SHAPE.source).toBe(DOCUMENT_PATH.source);
    expect(CORE_LOGO_BUCKET).toBe(LOGO_BUCKET);
    expect(CORE_DOCUMENT_BUCKET).toBe(DOCUMENT_BUCKET);
    expect(SWEEP_CALL_LIMIT).toBe(500);
  });
  it('the script runs the same functions, not a copy', () => {
    expect(script.runSweep).toBe(runSweep);
    expect(script.sweepLogoFiles).toBe(sweepLogoFiles);
    expect(script.PATH_SHAPE).toBe(DOCUMENT_PATH_SHAPE);
  });
});

describe('the stray logo files: a dry run', () => {
  it('lists and counts, and removes nothing, asks about nothing', async () => {
    const out = logger();
    const { client, kinds, removed } = fakeClient({ strays: [logo(ORG_A, 1), logo(GONE, 2)] });
    const result = await sweepLogoFiles(client, { remove: false, log: out.log });
    expect(result).toMatchObject({ listed: 2, removed: 0, failed: 0, skipped: 0, kept: 0, error: null });
    expect(removed).toEqual([]);
    expect(kinds().filter((k) => k !== 'range')).toEqual(['rpc:org_orphaned_logo_files']);
    expect(out.text()).toContain('2 logo file(s)');
    expect(out.text()).not.toContain(ORG_A);
  });
  it('prints the paths only with verbose', async () => {
    const out = logger();
    const { client } = fakeClient({ strays: [logo(ORG_A, 1)] });
    await sweepLogoFiles(client, { remove: false, verbose: true, log: out.log });
    expect(out.text()).toContain(logo(ORG_A, 1));
  });
  it('pages through more than 1,000', async () => {
    const many = Array.from({ length: 2300 }, (_, i) => logo(ORG_A, i));
    const { client, calls } = fakeClient({ strays: many });
    expect((await sweepLogoFiles(client, { remove: false, log: () => {} })).listed).toBe(2300);
    expect(calls.filter((c) => c.kind === 'range').map((c) => c.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it('reports a refused listing by its code only', async () => {
    const out = logger();
    const { client } = fakeClient({ listError: { code: '42501', message: `SECRET ${logo(ORG_A, 1)}` } });
    expect(await sweepLogoFiles(client, { remove: false, log: out.log })).toMatchObject({ listed: null, error: '42501' });
    expect(out.text()).toContain('42501');
    expect(out.text()).not.toContain('SECRET');
  });
});

describe('the stray logo files: removing', () => {
  it('asks the database about each name again just before removing it, one name at a time, from the logo bucket', async () => {
    const [a, b] = [logo(ORG_A, 1), logo(GONE, 2, 'webp')];
    const { client, calls, removed } = fakeClient({ strays: [a, b] });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(result).toMatchObject({ removed: 2, failed: 0, skipped: 0, kept: 0, error: null });
    expect(removed).toEqual([{ bucket: 'org-logos', path: a }, { bucket: 'org-logos', path: b }]);
    const steps = calls.filter((c) => c.kind !== 'range' && c.kind !== 'rpc:org_orphaned_logo_files').map((c) => [c.kind, c.args[0]]);
    expect(steps.slice(0, 4)).toEqual([
      ['rpc:org_logo_file_is_orphaned', { p_name: a }],
      ['remove:org-logos', [a]],
      ['rpc:org_logo_file_is_orphaned', { p_name: b }],
      ['remove:org-logos', [b]],
    ]);
  });

  it('keeps a file that is a logo by the time it is asked about: it was listed, it is not removed', async () => {
    const [a, b] = [logo(ORG_A, 1), logo(ORG_A, 2)];
    const { client, removed } = fakeClient({ strays: [a, b], notStrayNow: [a] });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(removed.map((r) => r.path)).toEqual([b]);
    expect(result).toMatchObject({ removed: 1, kept: 1 });
  });

  it('removes nothing whose second answer is not exactly true, or could not be had', async () => {
    const a = logo(ORG_A, 1);
    const { client, removed } = fakeClient({ strays: [a], askError: () => ({ code: '57014', message: 'SECRET' }) });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(removed).toEqual([]);
    expect(result).toMatchObject({ removed: 0, failed: 1, kept: 0 });
  });

  it('never hands the service role a name of another shape', async () => {
    const good = logo(ORG_A, 1);
    const bad = ['stray.txt', `${ORG_A}/../${ORG_B}/x.png`, `${ORG_A}/*`, '', logo(ORG_A, 2, 'svg'), `${ORG_A}/${EMP}/${logo(ORG_A, 3).split('/')[1]}`, logo(ORG_A, 4).toUpperCase()];
    const { client, removed, calls } = fakeClient({ strays: [...bad, good] });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(removed.map((r) => r.path)).toEqual([good]);
    expect(result).toMatchObject({ removed: 1, skipped: bad.length });
    // Not even asked about.
    expect(calls.filter((c) => c.kind === 'rpc:org_logo_file_is_orphaned')).toHaveLength(1);
  });

  it('carries on after a removal that fails or throws, tries it once, and reaches the files listed after it', async () => {
    const [a, b, c] = [logo(ORG_A, 1), logo(ORG_A, 2), logo(ORG_A, 3)];
    const { client, removed, calls } = fakeClient({ strays: [a, b, c], removeFails: (p) => p === a, removeThrows: (p) => p === b });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(removed.map((r) => r.path)).toEqual([c]);
    expect(result).toMatchObject({ removed: 1, failed: 2 });
    expect(calls.filter((x) => x.kind === 'remove:org-logos' && (x.args[0] as string[])[0] === a)).toHaveLength(1);
  });

  it('tries a file that would not go once only, even when the listing takes more than one batch', async () => {
    const many = Array.from({ length: 501 }, (_, i) => logo(ORG_A, i));
    const { client, removed, calls } = fakeClient({ strays: many, removeFails: (p) => p === many[0] });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(result).toMatchObject({ removed: 500, failed: 1 });
    expect(removed).toHaveLength(500);
    expect(calls.filter((x) => x.kind === 'remove:org-logos' && (x.args[0] as string[])[0] === many[0])).toHaveLength(1);
  });

  it('takes at most the number it is given in one call, and then stops', async () => {
    const many = Array.from({ length: 40 }, (_, i) => logo(ORG_A, i));
    const budget = { left: 7 };
    const { client, removed } = fakeClient({ strays: many });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {}, budget });
    expect(removed).toHaveLength(7);
    expect(result.removed).toBe(7);
    expect(budget.left).toBe(0);
  });

  it('with no budget (the script) goes on batch after batch until none is left', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => logo(ORG_A, i));
    const { client, removed } = fakeClient({ strays: many });
    expect((await sweepLogoFiles(client, { remove: true, log: () => {} })).removed).toBe(1200);
    expect(removed).toHaveLength(1200);
  });

  it('is bounded when every file fails: each is tried once', async () => {
    const many = Array.from({ length: 30 }, (_, i) => logo(ORG_A, i));
    const { client, calls } = fakeClient({ strays: many, removeFails: () => true });
    const result = await sweepLogoFiles(client, { remove: true, log: () => {} });
    expect(result).toMatchObject({ removed: 0, failed: 30 });
    expect(calls.filter((c) => c.kind === 'remove:org-logos')).toHaveLength(30);
  });

  it('prints counts only, never a path, and a refused listing by its code', async () => {
    const out = logger();
    const { client } = fakeClient({ strays: [logo(ORG_A, 1)] });
    await sweepLogoFiles(client, { remove: true, verbose: true, log: out.log });
    expect(out.text()).toContain('removed 1');
    expect(out.text()).not.toContain(ORG_A);
    const refused = fakeClient({ listError: { code: 'PGRST202', message: 'SECRET' } });
    expect(await sweepLogoFiles(refused.client, { remove: true, log: out.log })).toMatchObject({ removed: 0, error: 'PGRST202' });
    expect(out.text()).not.toContain('SECRET');
  });
});

describe('both sweeps in one bounded call', () => {
  it('removes stray logos and unattached documents, and answers in numbers only', async () => {
    const { client, removed } = fakeClient({
      strays: [logo(ORG_A, 1), logo(GONE, 2)],
      folders: [ORG_A, ORG_B],
      orphans: { [ORG_A]: [doc(ORG_A, 1), doc(ORG_A, 2)], [ORG_B]: [doc(ORG_B, 3)] },
    });
    const report = await sweepAllFiles(client);
    expect(report).toEqual({
      limit: 500,
      attempted: 5,
      logos: { removed: 2, failed: 0, skipped: 0, kept: 0, errors: 0 },
      documents: { workspaces: 2, removed: 3, failed: 0, skipped: 0, errors: 0, stoppedEarly: false },
    });
    expect(removed).toHaveLength(5);
    expect(JSON.stringify(report)).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('never attempts more than the limit across the two, logos first', async () => {
    const strays = Array.from({ length: 4 }, (_, i) => logo(ORG_A, i));
    const docs = Array.from({ length: 30 }, (_, i) => doc(ORG_A, i));
    const { client, removed, calls } = fakeClient({ strays, folders: [ORG_A, ORG_B], orphans: { [ORG_A]: docs, [ORG_B]: [doc(ORG_B, 99)] } });
    const report = await sweepAllFiles(client, { limit: 10 });
    expect(removed).toHaveLength(10);
    expect(removed.filter((r) => r.bucket === 'org-logos')).toHaveLength(4);
    expect(report.attempted).toBe(10);
    expect(report.limit).toBe(10);
    // The release is asked for no more than is left, so nothing is released that this call will not try to remove.
    const limits = calls.filter((c) => c.kind === 'rpc:hr_release_orphaned_document_files').map((c) => (c.args[0] as { p_limit: number }).p_limit);
    expect(limits[0]).toBe(6);
    expect(limits.every((n) => n > 0 && n <= 6)).toBe(true);
    // The second workspace is not started once the limit is reached.
    expect(calls.some((c) => c.kind === 'rpc:hr_release_orphaned_document_files' && (c.args[0] as { p_org: string }).p_org === ORG_B)).toBe(false);
  });

  it('a failed removal counts against the limit too', async () => {
    const strays = Array.from({ length: 20 }, (_, i) => logo(ORG_A, i));
    const { client, calls } = fakeClient({ strays, removeFails: () => true });
    const report = await sweepAllFiles(client, { limit: 6 });
    // Logos may take half of the limit, whatever is behind them.
    expect(calls.filter((c) => c.kind.startsWith('remove:'))).toHaveLength(3);
    expect(report.logos).toMatchObject({ removed: 0, failed: 3 });
  });

  it('logos that keep failing cannot starve the documents: each side has its own half', async () => {
    const strays = Array.from({ length: 40 }, (_, i) => logo(ORG_A, i));
    const docs = Array.from({ length: 8 }, (_, i) => doc(ORG_A, i));
    const { client, removed } = fakeClient({ strays, folders: [ORG_A], orphans: { [ORG_A]: docs }, removeFails: (path) => path.endsWith('.png') });
    const report = await sweepAllFiles(client, { limit: 10 });
    expect(report.logos).toMatchObject({ removed: 0, failed: 5 });
    expect(report.documents).toMatchObject({ removed: 5 });
    expect(removed.filter((r) => r.bucket === 'hr-documents')).toHaveLength(5);
    expect(report.attempted).toBe(10);
  });

  it('what the logos leave unused goes to the documents', async () => {
    const { client } = fakeClient({ strays: [logo(ORG_A, 1)], folders: [ORG_A], orphans: { [ORG_A]: Array.from({ length: 30 }, (_, i) => doc(ORG_A, i)) } });
    const report = await sweepAllFiles(client, { limit: 10 });
    expect(report.logos.removed).toBe(1);
    expect(report.documents.removed).toBe(9);
  });

  it('stops going through workspace folders once the time limit has passed, and says so', async () => {
    let clock = 0;
    const folders = [ORG_A, ORG_B, GONE];
    const orphans = { [ORG_A]: [doc(ORG_A, 1)], [ORG_B]: [doc(ORG_B, 2)], [GONE]: [doc(GONE, 3)] };
    // Each removal takes 15 seconds of the fake clock.
    const { client, calls } = fakeClient({ folders, orphans, removeFails: () => ((clock += 15_000), true) });
    const report = await sweepAllFiles(client, { now: () => clock, timeLimitMs: 20_000 });
    expect(report.documents.workspaces).toBe(2);
    expect(report.documents.stoppedEarly).toBe(true);
    expect(calls.some((c) => c.kind === 'rpc:hr_release_orphaned_document_files' && (c.args[0] as { p_org: string }).p_org === GONE)).toBe(false);
  });

  it('does not say it stopped early when every folder was reached, and defaults to 20 seconds', async () => {
    let clock = 0;
    const { client } = fakeClient({ folders: [ORG_A, ORG_B], orphans: { [ORG_A]: [doc(ORG_A, 1)], [ORG_B]: [doc(ORG_B, 2)] }, removeFails: () => ((clock += 10_000), false) });
    const report = await sweepAllFiles(client, { now: () => clock });
    expect(report.documents).toMatchObject({ workspaces: 2, stoppedEarly: false });
    const slow = fakeClient({ folders: [ORG_A, ORG_B], orphans: { [ORG_A]: [doc(ORG_A, 1)], [ORG_B]: [doc(ORG_B, 2)] } });
    clock = 0;
    const jump = fakeClient({ folders: [ORG_A, ORG_B], orphans: { [ORG_A]: [doc(ORG_A, 1)], [ORG_B]: [doc(ORG_B, 2)] }, removeFails: () => ((clock += 21_000), true) });
    expect((await sweepAllFiles(jump.client, { now: () => clock })).documents).toMatchObject({ workspaces: 1, stoppedEarly: true });
    expect((await sweepAllFiles(slow.client)).documents.stoppedEarly).toBe(false);
  });

  it('reports what went wrong as codes, to the function it is given, and carries on with the other sweep', async () => {
    const codes: string[] = [];
    const { client, removed } = fakeClient({
      listError: { code: '42501', message: `SECRET ${logo(ORG_A, 1)}` },
      folders: [ORG_A, ORG_B],
      orphans: { [ORG_B]: [doc(ORG_B, 1)] },
      releaseError: { [ORG_A]: { code: 'P0001', message: 'SECRET detail' } },
    });
    const report = await sweepAllFiles(client, { onCode: (where: string, code: string) => void codes.push(`${where}:${code}`) });
    expect(removed.map((r) => r.path)).toEqual([doc(ORG_B, 1)]);
    expect(report.logos.errors).toBe(1);
    expect(report.documents).toMatchObject({ workspaces: 2, removed: 1, errors: 1 });
    expect(codes).toEqual(['logos:42501', 'documents:P0001']);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('refuses a limit that is not a whole number from 1 to 500', async () => {
    const { client } = fakeClient({});
    for (const limit of [0, -1, 501, 1.5, Number.NaN, '10' as never]) await expect(sweepAllFiles(client, { limit })).rejects.toThrow();
  });
});

describe('POST /api/maintenance/sweep-files', () => {
  const SECRET = 'c'.repeat(40);
  const KEY = 'service-role-key-for-this-test-only';
  const built = { n: 0, client: null as unknown, throws: false };

  beforeEach(() => {
    built.n = 0;
    built.throws = false;
    vi.resetModules();
    vi.doMock('@/lib/supabase/service', () => ({
      serviceClient: () => {
        built.n += 1;
        if (built.throws) throw new Error('Service role is not configured. SECRET');
        return built.client;
      },
    }));
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', KEY);
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', '');
  });
  afterEach(() => {
    vi.doUnmock('@/lib/supabase/service');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const post = async (headers: Record<string, string>, url = 'https://app.test/api/maintenance/sweep-files') => {
    const { POST } = await import('@/app/api/maintenance/sweep-files/route');
    return POST(new Request(url, { method: 'POST', headers }));
  };

  it('answers 401 and builds no service client without the credential', async () => {
    built.client = fakeClient({ strays: [logo(ORG_A, 1)] }).client;
    const tried: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { 'x-service-key': 'wrong' }, { 'x-service-key': '' }];
    for (const headers of tried) {
      const response = await post(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(built.n).toBe(0);
  });

  it('runs both sweeps for the scheduler\'s credential, as /api/agents/run takes it, and answers counts only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accepted: Record<string, string>[] = [{ authorization: `Bearer ${SECRET}` }, { 'x-service-key': KEY }];
    for (const headers of accepted) {
      const fake = fakeClient({ strays: [logo(ORG_A, 1)], folders: [ORG_A], orphans: { [ORG_A]: [doc(ORG_A, 1)] } });
      built.client = fake.client;
      const response = await post(headers);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        limit: 500,
        attempted: 2,
        logos: { removed: 1, failed: 0, skipped: 0, kept: 0, errors: 0 },
        documents: { workspaces: 1, removed: 1, failed: 0, skipped: 0, errors: 0, stoppedEarly: false },
      });
      expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-/);
      expect(fake.removed).toHaveLength(2);
    }
  });

  it('reads nothing from the request: a body or a query cannot raise the limit or name a path', async () => {
    const strays = Array.from({ length: 600 }, (_, i) => logo(ORG_A, i));
    const fake = fakeClient({ strays, folders: [ORG_A], orphans: { [ORG_A]: Array.from({ length: 600 }, (_, i) => doc(ORG_A, i)) } });
    built.client = fake.client;
    const { POST } = await import('@/app/api/maintenance/sweep-files/route');
    const response = await POST(
      new Request('https://app.test/api/maintenance/sweep-files?limit=100000&remove=0', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 100000, paths: ['x'] }),
      }),
    );
    expect((await response.json()).attempted).toBe(500);
    expect(fake.removed).toHaveLength(500);
  });

  it('logs codes only, and answers 500 with no detail when the sweep cannot run', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    built.client = fakeClient({ listError: { code: '42501', message: `SECRET ${logo(ORG_A, 1)}` } }).client;
    const partial = await post({ authorization: `Bearer ${SECRET}` });
    expect(partial.status).toBe(200);
    expect((await partial.json()).logos.errors).toBe(1);
    built.throws = true;
    const broken = await post({ authorization: `Bearer ${SECRET}` });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: 'The sweep could not run.' });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('42501');
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(ORG_A);
  });
});
