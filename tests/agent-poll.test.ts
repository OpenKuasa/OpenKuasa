import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/openrouter-media', () => ({ checkVideo: vi.fn() }));
vi.mock('@/lib/ai/key-crypto', () => ({
  hasKeySecret: () => true,
  decryptApiKey: (c: string) => `decrypted-${c}`,
}));

import { pollVideos } from '@/lib/agents/runner';
import { checkVideo } from '@/lib/agents/openrouter-media';

const ORG = 'org-1';

type Asset = Record<string, unknown>;

const fresh = () => new Date(Date.now() - 60_000).toISOString();
const old = () => new Date(Date.now() - 31 * 60_000).toISOString();

function pendingAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    org_id: ORG,
    run_id: 'run-1',
    kind: 'video',
    status: 'pending',
    provider_job_id: 'job-1',
    storage_path: null,
    created_at: fresh(),
    ...over,
  };
}

function fakeClient(
  rows: Asset[],
  keyRow: { ciphertext: string } | null = { ciphertext: 'abc' },
  settle: { data: boolean | null; error: { message: string } | null } = { data: true, error: null },
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const updates: { patch: Asset; eqs: [string, unknown][] }[] = [];
  const selectEqs: [string, unknown][] = [];
  const keyEqs: [string, unknown][] = [];
  const uploads: { path: string; bytes: unknown; opts: unknown }[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return settle;
    },
    from(table: string) {
      return {
        select() {
          if (table === 'org_ai_keys') {
            const b = {
              eq(c: string, v: unknown) {
                keyEqs.push([c, v]);
                return b;
              },
              maybeSingle: async () => ({ data: keyRow, error: null }),
            };
            return b;
          }
          const filters: [string, unknown][] = [];
          const b = {
            eq(c: string, v: unknown) {
              filters.push([c, v]);
              selectEqs.push([c, v]);
              return b;
            },
            then(resolve: (v: { data: Asset[]; error: null }) => void) {
              const data = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
              resolve({ data, error: null });
            },
          };
          return b;
        },
        update(patch: Asset) {
          const call = { patch, eqs: [] as [string, unknown][] };
          updates.push(call);
          const b = {
            eq(c: string, v: unknown) {
              call.eqs.push([c, v]);
              return b;
            },
            then(resolve: (v: { error: null }) => void) {
              resolve({ error: null });
            },
          };
          return b;
        },
      };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: unknown, opts: unknown) => {
          uploads.push({ path: `${bucket}/${path}`, bytes, opts });
          return { data: { path }, error: null };
        },
      }),
    },
  };
  return { client: client as never, updates, selectEqs, keyEqs, uploads, rpcCalls };
}

beforeEach(() => {
  vi.mocked(checkVideo).mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([9, 9]).buffer })),
  );
});

describe('pollVideos', () => {
  it('downloads, uploads and marks a finished video done', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4' });
    const { client, updates, uploads, keyEqs } = fakeClient([pendingAsset()]);
    await pollVideos(client);
    expect(keyEqs).toContainEqual(['org_id', ORG]);
    expect(checkVideo).toHaveBeenCalledWith('decrypted-abc', 'job-1');
    expect(fetch).toHaveBeenCalledWith('https://cdn/v.mp4');
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(`agent-assets/${ORG}/run-1/video.mp4`);
    expect(uploads[0].opts).toMatchObject({ contentType: 'video/mp4', upsert: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ status: 'done', storage_path: `${ORG}/run-1/video.mp4` });
    expect(updates[0].eqs).toContainEqual(['id', 'asset-1']);
    expect(updates[0].eqs).toContainEqual(['org_id', ORG]);
    expect(updates[0].eqs).toContainEqual(['status', 'pending']);
  });

  it('leaves a video pending when done but the provider returned no url', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done' });
    const { client, updates, uploads } = fakeClient([pendingAsset()]);
    await pollVideos(client);
    expect(fetch).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('leaves a video pending while the provider is still rendering', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'pending' });
    const { client, updates } = fakeClient([pendingAsset()]);
    await pollVideos(client);
    expect(updates).toHaveLength(0);
  });

  it('marks a failed video failed', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'failed' });
    const { client, updates, uploads } = fakeClient([pendingAsset()]);
    await pollVideos(client);
    expect(uploads).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ status: 'failed' });
    expect(updates[0].eqs).toContainEqual(['id', 'asset-1']);
    expect(updates[0].eqs).toContainEqual(['org_id', ORG]);
  });

  it('fails a pending video older than the max age (timed out)', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'pending' });
    const { client, updates } = fakeClient([pendingAsset({ created_at: old() })]);
    await pollVideos(client);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ status: 'failed' });
  });

  it('fails an old video that is done but never produced a url', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done' });
    const { client, updates, uploads } = fakeClient([pendingAsset({ created_at: old() })]);
    await pollVideos(client);
    expect(uploads).toHaveLength(0);
    expect(updates[0].patch).toEqual({ status: 'failed' });
  });

  it('settles the estimated cost against the run with the figure the provider reports', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4', cost_cents: 80 });
    const { client, updates, rpcCalls } = fakeClient([
      pendingAsset({ cost_cents: 50, cost_estimated: true }),
    ]);
    await pollVideos(client);
    expect(rpcCalls).toEqual([
      { name: 'agent_settle_video_cost', args: { p_asset_id: 'asset-1', p_cost_cents: 80 } },
    ]);
    expect(updates[0].patch).toMatchObject({ status: 'done' });
  });

  it('writes a whole number of cents', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4', cost_cents: 41.6 });
    const { client, rpcCalls } = fakeClient([pendingAsset({ cost_cents: 50, cost_estimated: true })]);
    await pollVideos(client);
    expect(rpcCalls[0].args.p_cost_cents).toBe(42);
  });

  it('keeps the estimate when the provider reports no cost for the finished video', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4', cost_cents: null });
    const { client, updates, rpcCalls } = fakeClient([
      pendingAsset({ cost_cents: 50, cost_estimated: true }),
    ]);
    await pollVideos(client);
    expect(rpcCalls).toHaveLength(0);
    expect(updates[0].patch).toMatchObject({ status: 'done' });
  });

  it('does not settle twice: an asset whose cost is already final is left alone', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4', cost_cents: 80 });
    const { client, rpcCalls } = fakeClient([pendingAsset({ cost_cents: 80, cost_estimated: false })]);
    await pollVideos(client);
    expect(rpcCalls).toHaveLength(0);
  });

  it('waits for the next poll when the cost cannot be settled yet (its run is still in progress)', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4', cost_cents: 80 });
    const { client, updates, uploads } = fakeClient(
      [pendingAsset({ cost_cents: 50, cost_estimated: true })],
      undefined,
      { data: false, error: null },
    );
    await pollVideos(client);
    expect(uploads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('still finishes an old video whose cost could not be settled, on its estimate', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4', cost_cents: 80 });
    const { client, updates } = fakeClient(
      [pendingAsset({ cost_cents: 50, cost_estimated: true, created_at: old() })],
      undefined,
      { data: null, error: { message: 'x' } },
    );
    await pollVideos(client);
    expect(updates[0].patch).toMatchObject({ status: 'done' });
  });

  it('settles a failed video too when the provider says what it cost', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'failed', cost_cents: 0 });
    const { client, updates, rpcCalls } = fakeClient([
      pendingAsset({ cost_cents: 50, cost_estimated: true }),
    ]);
    await pollVideos(client);
    expect(rpcCalls[0].args).toEqual({ p_asset_id: 'asset-1', p_cost_cents: 0 });
    expect(updates[0].patch).toEqual({ status: 'failed' });
  });

  it('only selects pending video assets, so done/failed ones are a no-op', async () => {
    vi.mocked(checkVideo).mockResolvedValue({ status: 'done', url: 'https://cdn/v.mp4' });
    const { client, updates, selectEqs } = fakeClient([
      pendingAsset({ id: 'a', status: 'done' }),
      pendingAsset({ id: 'b', status: 'failed' }),
      pendingAsset({ id: 'c', kind: 'poster' }),
    ]);
    await pollVideos(client);
    expect(selectEqs).toContainEqual(['status', 'pending']);
    expect(selectEqs).toContainEqual(['kind', 'video']);
    expect(checkVideo).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('fails the asset (no check call) when the org has no AI key', async () => {
    const { client, updates } = fakeClient([pendingAsset()], null);
    await pollVideos(client);
    expect(checkVideo).not.toHaveBeenCalled();
    expect(updates[0].patch).toEqual({ status: 'failed' });
  });

  it('keeps going when one asset throws and never leaks error text', async () => {
    vi.mocked(checkVideo)
      .mockRejectedValueOnce(new Error('boom sk-or-secret'))
      .mockResolvedValueOnce({ status: 'failed' });
    const { client, updates } = fakeClient([pendingAsset(), pendingAsset({ id: 'asset-2' })]);
    await pollVideos(client);
    expect(updates).toHaveLength(1);
    expect(updates[0].eqs).toContainEqual(['id', 'asset-2']);
    expect(JSON.stringify(updates)).not.toContain('secret');
  });
});
