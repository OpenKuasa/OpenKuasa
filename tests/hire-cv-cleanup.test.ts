import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanCvFiles } from '@/lib/hire/cv-cleanup';

const PATHS = ['o/j/a.pdf', 'o/j/b.pdf', 'o/j/c.pdf'];

type Result = { data?: unknown; error: { code?: string } | null };

function fake(opts: { due?: Result; remove?: Result; done?: Result; there?: string[]; queue?: Result }) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'hire_cv_deletions_due') return opts.due ?? { data: [], error: null };
    if (name === 'hire_cv_queue_orphans') return opts.queue ?? { data: 0, error: null };
    return opts.done ?? { data: null, error: null };
  });
  const remove = vi.fn<(paths: string[]) => Promise<Result>>(
    async (paths) => opts.remove ?? { data: paths.map((name) => ({ name })), error: null },
  );
  // What a look in the bucket finds: by default nothing, so a file storage did not name is gone.
  const list = vi.fn(async (folder: string, options: { search: string }) => ({
    data: (opts.there ?? []).includes(`${folder}/${options.search}`) ? [{ name: options.search }] : [],
    error: null,
  }));
  const from = vi.fn<(bucket: string) => { remove: typeof remove; list: typeof list }>(() => ({ remove, list }));
  const service = { rpc, storage: { from } };
  return { service: service as never, rpc, remove, from };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('cleanCvFiles', () => {
  it('does nothing when nothing is due', async () => {
    const f = fake({ due: { data: [], error: null } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: false });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('treats a non-array answer as nothing due', async () => {
    const f = fake({ due: { data: null, error: null } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: false });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('removes due files then marks them done', async () => {
    const f = fake({ due: { data: PATHS, error: null } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 3, failed: false });
    expect(f.from).toHaveBeenCalledWith('hire-cvs');
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledWith(PATHS);
    expect(f.rpc).toHaveBeenCalledWith('hire_cv_deletions_done', { p_paths: PATHS });
  });

  it('keeps the row of a file that storage said nothing about and that is still there', async () => {
    const f = fake({ due: { data: PATHS, error: null }, remove: { data: [{ name: PATHS[0] }], error: null }, there: [PATHS[1]] });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 2, failed: true });
    expect(f.rpc).toHaveBeenCalledWith('hire_cv_deletions_done', { p_paths: [PATHS[0], PATHS[2]] });
  });

  it('marks nothing done when no file is certainly gone', async () => {
    const f = fake({ due: { data: PATHS, error: null }, remove: { data: [], error: null }, there: PATHS });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: true });
    expect(f.rpc).not.toHaveBeenCalledWith('hire_cv_deletions_done', expect.anything());
  });

  it('first queues the files no application holds, then reads what is due', async () => {
    const f = fake({ due: { data: PATHS, error: null } });
    await cleanCvFiles(f.service);
    expect(f.rpc.mock.calls[0][0]).toBe('hire_cv_queue_orphans');
    expect(f.rpc.mock.calls[1][0]).toBe('hire_cv_deletions_due');
  });

  it('still removes what is due when the queueing fails, and says the run failed', async () => {
    const f = fake({ due: { data: PATHS, error: null }, queue: { data: null, error: { code: '42501' } } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 3, failed: true });
    expect(f.rpc).toHaveBeenCalledWith('hire_cv_deletions_done', { p_paths: PATHS });
  });

  it('says the run failed when queueing fails and nothing is due', async () => {
    const f = fake({ queue: { data: null, error: { code: '42501' } } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: true });
  });

  it('fails when the due read errors', async () => {
    const f = fake({ due: { data: null, error: { code: '42501' } } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: true });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('keeps the rows when remove errors', async () => {
    const f = fake({ due: { data: PATHS, error: null }, remove: { error: { code: 'x' } } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: true });
    expect(f.rpc).not.toHaveBeenCalledWith('hire_cv_deletions_done', expect.anything());
  });

  it('fails when marking done errors', async () => {
    const f = fake({ due: { data: PATHS, error: null }, done: { error: { code: 'y' } } });
    expect(await cleanCvFiles(f.service)).toEqual({ removed: 0, failed: true });
  });

  it('passes the limit through', async () => {
    const f = fake({});
    await cleanCvFiles(f.service, 7);
    expect(f.rpc).toHaveBeenCalledWith('hire_cv_deletions_due', { p_limit: 7 });
  });

  it('defaults the limit to 100', async () => {
    const f = fake({});
    await cleanCvFiles(f.service);
    expect(f.rpc).toHaveBeenCalledWith('hire_cv_deletions_due', { p_limit: 100 });
  });

  it('never logs a path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fake({ due: { data: PATHS, error: null }, remove: { error: { code: 'x' } } });
    await cleanCvFiles(f.service);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('o/j/');
  });
});
