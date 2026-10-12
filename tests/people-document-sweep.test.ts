import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_BUCKET, DOCUMENT_PATH } from '@/lib/people/document-files';
import {
  PATH_SHAPE,
  listWorkspaceFolders,
  parseArgs,
  runSweep,
  sweepWorkspace,
} from '../scripts/sweep-document-files.mjs';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const EMP = '33333333-3333-4333-8333-333333333333';
const file = (org: string, n: number, ext = 'pdf') => `${org}/${EMP}/abcdef0${n}-aaaa-4bbb-8ccc-0123456789ab.${ext}`;

type Release = (org: string, limit: number) => string[] | { error: { code?: string; message: string } };

/**
 * A stand-in for the service client: a bucket's top level, the two sweep functions, and `remove`.
 * `listed[org]` is what the listing says; `release(org, limit)` is what each release call answers.
 */
function fakeClient(opts: {
  folders?: { name: string; id: string | null }[];
  listed?: Record<string, string[]>;
  release?: Release;
  removeFails?: (path: string) => boolean;
  listError?: boolean;
}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const removed: string[] = [];
  const folders = opts.folders ?? [];
  const client = {
    rpc: (fn: string, args: { p_org: string; p_limit?: number }) => {
      calls.push({ kind: `rpc:${fn}`, args: [args] });
      const settle = async (from = 0, to = Number.MAX_SAFE_INTEGER) => {
        if (fn === 'hr_orphaned_document_files') {
          if (to !== Number.MAX_SAFE_INTEGER) calls.push({ kind: 'range', args: [from, to] });
          return { data: (opts.listed?.[args.p_org] ?? []).slice(from, to + 1), error: null };
        }
        if (fn === 'hr_release_orphaned_document_files') {
          const answer = (opts.release ?? (() => []))(args.p_org, args.p_limit ?? -1);
          return Array.isArray(answer) ? { data: answer, error: null } : { data: null, error: answer.error };
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
        list: async (path: string, options: { limit: number; offset: number }) => {
          calls.push({ kind: `list:${bucket}`, args: [path, options] });
          if (opts.listError) return { data: null, error: { message: 'down' } };
          return { data: folders.slice(options.offset, options.offset + options.limit), error: null };
        },
        remove: async (paths: string[]) => {
          calls.push({ kind: `remove:${bucket}`, args: [paths] });
          if (paths.some((p) => opts.removeFails?.(p))) return { data: null, error: { message: 'no' } };
          removed.push(...paths);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { client: client as never, calls, removed };
}

const logger = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
};

describe('the path shape', () => {
  it('is the very expression the app and the database use', () => {
    expect(PATH_SHAPE.source).toBe(DOCUMENT_PATH.source);
    expect(PATH_SHAPE.test(file(ORG_A, 1))).toBe(true);
    expect(PATH_SHAPE.test(`${ORG_A}/${EMP}/../x.pdf`)).toBe(false);
  });
});

describe('parseArgs', () => {
  it('is a dry run unless --remove is given exactly', () => {
    expect(parseArgs([])).toEqual({ remove: false });
    expect(parseArgs(['--remove'])).toEqual({ remove: true });
    expect(parseArgs(['--dry-run'])).toEqual({ remove: false });
    expect(parseArgs(['--verbose'])).toEqual({ remove: false, verbose: true });
    expect(parseArgs(['--remove', '--verbose'])).toEqual({ remove: true, verbose: true });
  });
  it('refuses anything else, so a typo cannot delete or silently do nothing', () => {
    for (const argv of [['--rm'], ['--remove=true'], ['remove'], ['--remove', '--force'], ['-r']]) {
      expect(() => parseArgs(argv)).toThrow();
    }
  });
});

describe('listWorkspaceFolders', () => {
  it('lists the bucket\'s top level, not the orgs table, and keeps only workspace folders', async () => {
    const { client, calls } = fakeClient({
      folders: [
        { name: ORG_A, id: null },
        { name: 'not-a-uuid', id: null },
        { name: ORG_B, id: null },
        { name: file(ORG_A, 1), id: 'an-object' },
        { name: 'ABCDEF01-AAAA-4BBB-8CCC-0123456789AB', id: null },
      ],
    });
    expect(await listWorkspaceFolders(client)).toEqual([ORG_A, ORG_B]);
    expect(calls[0]).toMatchObject({ kind: `list:${DOCUMENT_BUCKET}`, args: ['', { limit: 100, offset: 0 }] });
    expect(calls.every((c) => c.kind.startsWith('list:'))).toBe(true);
  });
  it('reads every page', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      name: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      id: null,
    }));
    const { client, calls } = fakeClient({ folders: many });
    expect(await listWorkspaceFolders(client)).toHaveLength(250);
    expect(calls.length).toBeGreaterThan(1);
  });
  it('throws a plain error when storage cannot be listed, without any detail', async () => {
    const { client } = fakeClient({ listError: true });
    await expect(listWorkspaceFolders(client)).rejects.toThrow('The bucket could not be listed.');
  });
});

describe('a dry run', () => {
  it('prints counts and no path unless --verbose is given', async () => {
    const out = logger();
    const { client } = fakeClient({ folders: [{ name: ORG_A, id: null }], listed: { [ORG_A]: [file(ORG_A, 1)] } });
    await runSweep(client, { remove: false, log: out.log });
    const text = out.lines.join('\n');
    expect(text).toContain(`${ORG_A}: 1 file(s)`);
    expect(text).not.toContain(file(ORG_A, 1));
    expect(text).not.toContain(EMP);
  });
  it('pages through more than 1,000 orphans instead of stopping at the first page', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => `${ORG_A}/${EMP}/${String(i).padStart(8, '0')}-aaaa-4bbb-8ccc-0123456789ab.pdf`);
    const { client, calls } = fakeClient({ folders: [{ name: ORG_A, id: null }], listed: { [ORG_A]: many } });
    const report = await runSweep(client, { remove: false, log: () => {} });
    expect(report.workspaces[0].listed).toBe(2500);
    expect(calls.filter((c) => c.kind === 'range').map((c) => c.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it('only lists, per workspace folder, and never releases or removes anything', async () => {
    const out = logger();
    const { client, calls, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }, { name: ORG_B, id: null }],
      listed: { [ORG_A]: [file(ORG_A, 1), file(ORG_A, 2)], [ORG_B]: [] },
    });
    const report = await runSweep(client, { remove: false, verbose: true, log: out.log });
    expect(report.workspaces.map((w) => [w.org, w.listed, w.removed])).toEqual([[ORG_A, 2, 0], [ORG_B, 0, 0]]);
    expect(calls.filter((c) => c.kind.startsWith('rpc:')).map((c) => c.kind)).toEqual([
      'rpc:hr_orphaned_document_files',
      'rpc:hr_orphaned_document_files',
    ]);
    expect(calls.some((c) => c.kind.startsWith('remove:'))).toBe(false);
    expect(removed).toEqual([]);
    const text = out.lines.join('\n');
    expect(text).toContain(ORG_A);
    expect(text).toContain(file(ORG_A, 1));
    expect(text.toLowerCase()).toContain('dry run');
  });
  it('lists a deleted workspace\'s files too, since it asks the bucket and not the orgs table', async () => {
    const { client } = fakeClient({ folders: [{ name: ORG_B, id: null }], listed: { [ORG_B]: [file(ORG_B, 3)] } });
    expect((await runSweep(client, { remove: false, log: () => {} })).workspaces[0]).toMatchObject({ org: ORG_B, listed: 1 });
  });
});

describe('removing', () => {
  it('removes only what a release call returned, never what the listing said', async () => {
    const listedOnly = file(ORG_A, 2);
    const released = file(ORG_A, 1);
    let round = 0;
    const { client, calls, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      listed: { [ORG_A]: [released, listedOnly] },
      release: () => (round++ === 0 ? [released] : []),
    });
    const report = await runSweep(client, { remove: true, log: () => {} });
    expect(removed).toEqual([released]);
    expect(removed).not.toContain(listedOnly);
    expect(report.workspaces[0]).toMatchObject({ removed: 1, failed: 0, skipped: 0 });
    const removeCalls = calls.filter((c) => c.kind.startsWith('remove:'));
    expect(removeCalls.map((c) => c.args)).toEqual([[[released]]]);
  });

  it('removes one path at a time and loops until a call returns nothing', async () => {
    const batches = [[file(ORG_A, 1), file(ORG_A, 2)], [file(ORG_A, 3)], []];
    const { client, calls, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => batches.shift() ?? [],
    });
    await sweepWorkspace(client, ORG_A, { remove: true, log: () => {} });
    expect(removed).toEqual([file(ORG_A, 1), file(ORG_A, 2), file(ORG_A, 3)]);
    expect(calls.filter((c) => c.kind.startsWith('remove:')).every((c) => (c.args[0] as string[]).length === 1)).toBe(true);
    const releases = calls.filter((c) => c.kind === 'rpc:hr_release_orphaned_document_files');
    expect(releases).toHaveLength(3);
    expect(releases.every((c) => (c.args[0] as { p_org: string; p_limit: number }).p_org === ORG_A)).toBe(true);
    expect(releases.every((c) => (c.args[0] as { p_limit: number }).p_limit === 500)).toBe(true);
  });

  it('does not remove a returned path of the wrong shape or from another folder, and says so', async () => {
    const good = file(ORG_A, 1);
    const bad = [`${ORG_A}/${EMP}/../x.pdf`, file(ORG_B, 1), `${ORG_A}/*`, '', file(ORG_A, 2, 'exe')];
    let round = 0;
    const { client, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => (round++ === 0 ? [...bad, good] : []),
    });
    const result = await sweepWorkspace(client, ORG_A, { remove: true, log: () => {} });
    expect(removed).toEqual([good]);
    expect(result).toMatchObject({ removed: 1, skipped: 5, failed: 0 });
  });

  it('stops when a call makes no progress, instead of looping on a path it cannot remove', async () => {
    const stuck = file(ORG_A, 1);
    const { client, calls } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => [stuck],
      removeFails: () => true,
    });
    const result = await sweepWorkspace(client, ORG_A, { remove: true, log: () => {} });
    expect(result).toMatchObject({ removed: 0, failed: 1 });
    // The path is tried once; the second call returns only it again, so there is nothing new and the workspace ends.
    expect(calls.filter((c) => c.kind === 'rpc:hr_release_orphaned_document_files')).toHaveLength(2);
    expect(calls.filter((c) => c.kind.startsWith('remove:'))).toHaveLength(1);
  });

  it('tries a path that failed once only once, and still removes the paths that come after it', async () => {
    const [bad, later] = [file(ORG_A, 1), file(ORG_A, 2)];
    const rounds = [[bad], [bad, later], [bad]];
    const { client, calls, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => rounds.shift() ?? [],
      removeFails: (p) => p === bad,
    });
    const result = await sweepWorkspace(client, ORG_A, { remove: true, log: () => {} });
    expect(calls.filter((c) => c.kind.startsWith('remove:') && (c.args[0] as string[])[0] === bad)).toHaveLength(1);
    expect(removed).toEqual([later]);
    expect(result).toMatchObject({ removed: 1, failed: 1 });
  });

  it('reports the total of failures at the end', async () => {
    const out = logger();
    const { client } = fakeClient({ folders: [{ name: ORG_A, id: null }], release: () => [file(ORG_A, 1)], removeFails: () => true });
    await runSweep(client, { remove: true, log: out.log });
    expect(out.lines.join('\n')).toContain('failed 1');
  });

  it('carries on after a failed removal in the same batch', async () => {
    const [a, b] = [file(ORG_A, 1), file(ORG_A, 2)];
    let round = 0;
    const { client, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => (round++ === 0 ? [a, b] : []),
      removeFails: (p) => p === a,
    });
    const result = await sweepWorkspace(client, ORG_A, { remove: true, log: () => {} });
    expect(removed).toEqual([b]);
    expect(result).toMatchObject({ removed: 1, failed: 1 });
  });

  it('is bounded: a release call that keeps returning new paths stops after a fixed number of rounds', async () => {
    let n = 0;
    const { client, calls } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => [`${ORG_A}/${EMP}/${String(n++).padStart(8, '0')}-aaaa-4bbb-8ccc-0123456789ab.pdf`],
    });
    await sweepWorkspace(client, ORG_A, { remove: true, log: () => {}, maxRounds: 5 });
    expect(calls.filter((c) => c.kind === 'rpc:hr_release_orphaned_document_files')).toHaveLength(5);
  });

  it('reports a refused release by its code only, and goes on to the next workspace', async () => {
    const out = logger();
    const next = file(ORG_B, 1);
    let round = 0;
    const { client, removed } = fakeClient({
      folders: [{ name: ORG_A, id: null }, { name: ORG_B, id: null }],
      release: (org) => (org === ORG_A ? { error: { code: '42501', message: `secret detail ${file(ORG_A, 9)}` } } : round++ === 0 ? [next] : []),
    });
    const report = await runSweep(client, { remove: true, log: out.log });
    expect(removed).toEqual([next]);
    expect(report.workspaces[0]).toMatchObject({ org: ORG_A, error: '42501' });
    expect(report.workspaces[1]).toMatchObject({ org: ORG_B, removed: 1 });
    expect(out.lines.join('\n')).not.toContain('secret detail');
  });

  it('prints counts only when removing, never a path', async () => {
    const out = logger();
    let round = 0;
    const { client } = fakeClient({
      folders: [{ name: ORG_A, id: null }],
      release: () => (round++ === 0 ? [file(ORG_A, 1)] : []),
    });
    await runSweep(client, { remove: true, log: out.log });
    const text = out.lines.join('\n');
    expect(text).toContain(ORG_A);
    expect(text).not.toContain(file(ORG_A, 1));
    expect(text).not.toContain(EMP);
  });

  it('answers the same in both modes for a bucket with no folders', async () => {
    const { client } = fakeClient({});
    expect((await runSweep(client, { remove: true, log: vi.fn() })).workspaces).toEqual([]);
    expect((await runSweep(client, { remove: false, log: vi.fn() })).workspaces).toEqual([]);
  });
});
