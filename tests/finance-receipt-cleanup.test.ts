import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route's own service client: an empty bucket and an empty list.
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(() => ({
    rpc: async (name: string) => ({ data: name === 'finance_receipt_queue_orphans' ? 0 : [], error: null }),
  })),
}));

import { POST } from '@/app/api/finance/receipt-cleanup/route';
import { cleanReceiptFiles, firstBytesOf, removeReleasedReceiptFile, storedFileCheck } from '@/lib/finance/receipt-files-server';
import { serviceClient } from '@/lib/supabase/service';

const ORG = '11111111-1111-4111-8111-111111111111';
const path = (n: number, ext = 'jpg') => `${ORG}/22222222-2222-4222-8222-${String(n).padStart(12, '0')}.${ext}`;

/**
 * A stand-in for the service client over a pretend bucket and a pretend list.
 * `done` behaves as the database's does: it takes off the list only paths
 * whose objects are gone.
 */
function fakeService(opts: { objects: string[]; list: string[]; orphans?: string[]; failRemove?: string[]; errors?: Record<string, string> }) {
  const objects = new Set(opts.objects);
  const list = [...opts.list];
  const calls: string[] = [];
  const err = (name: string) => (opts.errors?.[name] ? { data: null, error: { code: opts.errors[name] } } : null);
  const client = {
    rpc: async (name: string, args?: Record<string, unknown>) => {
      calls.push(`${name}${args?.p_path ? `:${args.p_path}` : ''}`);
      const failed = err(name);
      if (failed) return failed;
      if (name === 'finance_receipt_queue_orphans') {
        const fresh = (opts.orphans ?? []).filter((p) => !list.includes(p));
        list.push(...fresh);
        return { data: fresh.length, error: null };
      }
      if (name === 'finance_receipt_deletions_due') return { data: list.slice(0, Number(args?.p_limit ?? 100)), error: null };
      if (name === 'finance_receipt_deletion_queued') return { data: list.includes(String(args?.p_path)), error: null };
      if (name === 'finance_receipt_deletions_done') {
        const gone = (args?.p_paths as string[]).filter((p) => list.includes(p) && !objects.has(p));
        for (const p of gone) list.splice(list.indexOf(p), 1);
        return { data: gone.length, error: null };
      }
      throw new Error(`unexpected function ${name}`);
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          calls.push(`remove:${bucket}:${paths.join(',')}`);
          if (paths.some((p) => opts.failRemove?.includes(p))) return { data: null, error: { message: 'no' } };
          for (const p of paths) objects.delete(p);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { client: client as never, calls, objects, list };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(serviceClient).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('cleanReceiptFiles', () => {
  it('queues orphans, asks about each path again, removes it from the receipts bucket, and marks done what is gone', async () => {
    const s = fakeService({ objects: [path(1), path(2), path(3)], list: [path(1)], orphans: [path(2)] });
    expect(await cleanReceiptFiles(s.client)).toEqual({ queued: 1, removed: 2, failed: false });
    expect(s.calls).toEqual([
      'finance_receipt_queue_orphans',
      'finance_receipt_deletions_due',
      `finance_receipt_deletion_queued:${path(1)}`,
      `remove:finance-receipts:${path(1)}`,
      `finance_receipt_deletion_queued:${path(2)}`,
      `remove:finance-receipts:${path(2)}`,
      'finance_receipt_deletions_done',
    ]);
    // The file a receipt still holds was never on the list and is still there.
    expect([...s.objects]).toEqual([path(3)]);
    expect(s.list).toEqual([]);
  });

  it('leaves a path whose file could not be removed on the list, and says the run failed', async () => {
    const s = fakeService({ objects: [path(1), path(2)], list: [path(1), path(2)], failRemove: [path(1)] });
    expect(await cleanReceiptFiles(s.client)).toEqual({ queued: 0, removed: 1, failed: true });
    expect(s.list).toEqual([path(1)]);
    expect(s.objects.has(path(1))).toBe(true);
  });

  it('does not touch a path that left the list after it was read', async () => {
    const s = fakeService({ objects: [path(1)], list: [path(1)] });
    const rpc = (s.client as unknown as { rpc: (n: string, a?: Record<string, unknown>) => Promise<unknown> }).rpc;
    (s.client as unknown as { rpc: unknown }).rpc = async (name: string, args?: Record<string, unknown>) => {
      const answer = await rpc(name, args);
      // The delete action finished with it in between, and the same path was uploaded and recorded again.
      if (name === 'finance_receipt_deletions_due') s.list.length = 0;
      return answer;
    };
    expect(await cleanReceiptFiles(s.client)).toEqual({ queued: 0, removed: 0, failed: false });
    expect(s.calls.some((c) => c.startsWith('remove:'))).toBe(false);
    expect(s.objects.has(path(1))).toBe(true);
  });

  it('clears a listed path whose file is already gone', async () => {
    const s = fakeService({ objects: [], list: [path(1)] });
    expect(await cleanReceiptFiles(s.client)).toEqual({ queued: 0, removed: 1, failed: false });
  });

  it('stops at its time budget and leaves the rest for the next run', async () => {
    const s = fakeService({ objects: [path(1), path(2), path(3)], list: [path(1), path(2), path(3)] });
    let t = 0;
    const result = await cleanReceiptFiles(s.client, { budgetMs: 10, now: () => (t += 6) });
    expect(result).toEqual({ queued: 0, removed: 1, failed: true });
    expect(s.list).toEqual([path(2), path(3)]);
  });

  it('reports a failure to read the list, and goes on when only the orphan step failed', async () => {
    const down = fakeService({ objects: [], list: [], errors: { finance_receipt_deletions_due: '42501' } });
    expect(await cleanReceiptFiles(down.client)).toEqual({ queued: 0, removed: 0, failed: true });
    const half = fakeService({ objects: [path(1)], list: [path(1)], errors: { finance_receipt_queue_orphans: '57014' } });
    expect(await cleanReceiptFiles(half.client)).toEqual({ queued: 0, removed: 1, failed: true });
  });

  it('logs no path', async () => {
    const s = fakeService({ objects: [path(1)], list: [path(1)], failRemove: [path(1)] });
    await cleanReceiptFiles(s.client);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(ORG);
  });
});

describe('removeReleasedReceiptFile', () => {
  it('removes exactly the path the database has queued', async () => {
    const s = fakeService({ objects: [path(1)], list: [path(1)] });
    expect(await removeReleasedReceiptFile(s.client, path(1))).toBe(true);
    expect(s.calls).toEqual([`finance_receipt_deletion_queued:${path(1)}`, `remove:finance-receipts:${path(1)}`, 'finance_receipt_deletions_done']);
  });

  it('removes nothing the database has not queued, and nothing of another shape', async () => {
    const s = fakeService({ objects: [path(1)], list: [] });
    expect(await removeReleasedReceiptFile(s.client, path(1))).toBe(false);
    for (const bad of ['', '../x', `${ORG}/resit.jpg`, path(1, 'exe'), `${path(1)}/x`, `hr-receipts/${path(1)}`]) {
      expect(await removeReleasedReceiptFile(s.client, bad), bad).toBe(false);
    }
    expect(s.calls.filter((c) => c.startsWith('remove:'))).toEqual([]);
    expect(s.objects.has(path(1))).toBe(true);
  });

  it('never throws', async () => {
    const broken = { rpc: async () => { throw new Error('down'); } } as never;
    expect(await removeReleasedReceiptFile(broken, path(1))).toBe(false);
  });
});

describe('reading a stored file’s first bytes', () => {
  /** Every request's options, as the fake store saw them. */
  const asked: (RequestInit | undefined)[] = [];
  const served = (bytes: number[], status = 206) =>
    (async (...args: [unknown, RequestInit?]) => {
      asked.push(args[1]);
      return new Response(new Uint8Array(bytes), { status });
    }) as unknown as typeof fetch;

  it('asks for a range and reads no more than it needs', async () => {
    const whole = Array.from({ length: 5000 }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : 1));
    asked.length = 0;
    const head = await firstBytesOf('https://store.example/signed', served(whole, 200));
    expect(head).toHaveLength(64);
    expect(asked[0]).toMatchObject({ headers: { Range: 'bytes=0-63' } });
  });

  it('says match, mismatch or unreadable', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(await storedFileCheck('u', 'image/png', served(png))).toBe('match');
    expect(await storedFileCheck('u', 'image/jpeg', served(png))).toBe('mismatch');
    expect(await storedFileCheck('u', 'image/jpeg', served(Array.from('<html>').map((c) => c.charCodeAt(0))))).toBe('mismatch');
    expect(await storedFileCheck('u', 'image/png', served(png, 404))).toBe('unreadable');
    const thrown = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await storedFileCheck('u', 'image/png', thrown)).toBe('unreadable');
    // A HEIC stored as HEIF, or the other way round, is the same container.
    const heic = [0, 0, 0, 24, ...Array.from('ftypheic').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from('mif1heic').map((c) => c.charCodeAt(0))];
    expect(await storedFileCheck('u', 'image/heif', served(heic))).toBe('match');
  });
});

describe('a stalled store', () => {
  /** Never answers; ends only when the request is aborted, as a real fetch does. */
  const stalled = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

  it('is given up on after a time limit and answers unreadable', async () => {
    expect(await storedFileCheck('u', 'image/png', stalled, 20)).toBe('unreadable');
    expect(await firstBytesOf('u', stalled, 20)).toBeNull();
  });

  it('is asked with a five second limit unless told otherwise', async () => {
    let signal: AbortSignal | null | undefined;
    const spy = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(new Uint8Array([1]), { status: 404 });
    }) as unknown as typeof fetch;
    await firstBytesOf('u', spy);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

describe('POST /api/finance/receipt-cleanup', () => {
  const SECRET = 'cron-secret-0123456789abcdef0123456789abcdef';
  const KEY = 'test-service-key';
  const req = (headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/finance/receipt-cleanup', { method: 'POST', headers });

  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', KEY);
  });

  it('401s without the secret and makes no service client', async () => {
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req({ authorization: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req({ 'x-service-key': 'nope' }))).status).toBe(401);
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it('runs with the cron secret and answers with counts only', async () => {
    const res = await POST(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: 0, removed: 0 });
    expect(serviceClient).toHaveBeenCalledTimes(1);
  });

  it('still runs on the legacy service-role key during the transition, and 401s once it is switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await POST(req({ 'x-service-key': KEY }))).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv('CRON_ALLOW_LEGACY_KEY', 'false');
    expect((await POST(req({ 'x-service-key': KEY }))).status).toBe(401);
  });
});
