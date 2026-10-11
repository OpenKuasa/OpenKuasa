import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/openrouter-media', () => ({
  webSearch: vi.fn(),
  writeDigest: vi.fn(),
  generateImage: vi.fn(),
  startVideo: vi.fn(),
  suggestProposals: vi.fn(),
}));
vi.mock('@/lib/ai/key-crypto', () => ({
  hasKeySecret: () => true,
  decryptApiKey: (c: string) => `decrypted-${c}`,
}));
vi.mock('@/lib/reach/supabase', () => ({
  createSupabaseReachData: () => ({
    listCampaigns: async () => [],
    listLeads: async () => [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Aina Rahman',
        channel: 'whatsapp',
        stage: 'won',
        source: 'Free Catering Quote',
        promoted_contact_id: null,
        created_at: '2026-10-01T00:00:00Z',
      },
    ],
    listAppointments: async () => [],
  }),
}));

import { runWeeklyStudio } from '@/lib/agents/weekly-studio';
import { RunInProgressError } from '@/lib/agents/types';
import {
  generateImage,
  startVideo,
  suggestProposals,
  webSearch,
  writeDigest,
} from '@/lib/agents/openrouter-media';

const ORG = 'org-123';

type Call = { table: string; op: string; payload?: unknown; eqs: [string, unknown][] };

function fakeService(
  keyRow: { ciphertext: string } | null,
  cap: { max_cost_cents: number } | null = { max_cost_cents: 200 },
  opts: { runInsertError?: { code: string; message: string } } = {},
) {
  const calls: Call[] = [];
  const runs: Record<string, unknown>[] = [];
  const assets: Record<string, unknown>[] = [];
  const uploads: { path: string; bytes: unknown; opts: unknown }[] = [];
  const service = {
    from(table: string) {
      return {
        select() {
          const call: Call = { table, op: 'select', eqs: [] };
          calls.push(call);
          const b = {
            eq(col: string, val: unknown) {
              call.eqs.push([col, val]);
              return b;
            },
            gte() {
              return b;
            },
            limit() {
              return b;
            },
            then: (resolve: (v: { data: never[] }) => void) => resolve({ data: [] }),
            maybeSingle: async () => ({ data: table === 'agent_configs' ? cap : keyRow, error: null }),
          };
          return b;
        },
        insert(payload: Record<string, unknown>) {
          const call: Call = { table, op: 'insert', payload, eqs: [] };
          calls.push(call);
          if (table === 'agent_proposals') return Promise.resolve({ error: null });
          if (table === 'agent_run_assets') {
            assets.push(payload);
            return Promise.resolve({ error: null });
          }
          if (opts.runInsertError) {
            const refused = { data: null, error: opts.runInsertError };
            return { select: () => ({ single: async () => refused }) };
          }
          const row = { id: 'run-1', ...payload };
          runs.push(row);
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
        update(patch: Record<string, unknown>) {
          const call: Call = { table, op: 'update', payload: patch, eqs: [] };
          calls.push(call);
          const b = {
            eq(col: string, val: unknown) {
              call.eqs.push([col, val]);
              return b;
            },
            then(resolve: (v: { error: null }) => void) {
              Object.assign(runs[0], patch);
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
  return { service: service as never, calls, runs, assets, uploads };
}

beforeEach(() => {
  vi.mocked(webSearch).mockReset();
  vi.mocked(writeDigest).mockReset();
  vi.mocked(generateImage).mockReset();
  vi.mocked(startVideo).mockReset();
  vi.mocked(suggestProposals).mockReset();
  vi.mocked(suggestProposals).mockResolvedValue({
    keep: [{ index: 0, rationale: 'A won lead ready for sales.' }],
    cost_cents: 0,
  });
  vi.mocked(startVideo).mockResolvedValue({ jobId: 'job-9', cost_cents: 20 });
  vi.mocked(generateImage).mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'image/png',
    cost_cents: 5,
  });
});

describe('runWeeklyStudio', () => {
  it('fails with "no AI key" and makes no media call when the org has no key', async () => {
    const { service, runs } = fakeService(null);
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res).toEqual({ runId: 'run-1', status: 'failed' });
    expect(runs[0].status).toBe('failed');
    expect(String(runs[0].error)).toContain('no AI key');
    expect(runs[0].trigger).toBe('manual');
    expect(webSearch).not.toHaveBeenCalled();
    expect(writeDigest).not.toHaveBeenCalled();
  });

  it('starting a run while the workspace has one in progress is refused before any paid call', async () => {
    // 23505: the one-running-run-per-workspace index rejected the insert.
    const { service, runs } = fakeService({ ciphertext: 'abc' }, undefined, {
      runInsertError: { code: '23505', message: 'duplicate key value' },
    });
    await expect(runWeeklyStudio(service, ORG, 'manual')).rejects.toBeInstanceOf(RunInProgressError);
    expect(runs).toHaveLength(0);
    expect(webSearch).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    expect(startVideo).not.toHaveBeenCalled();
  });

  it('any other failure to start is still the generic error', async () => {
    const { service } = fakeService({ ciphertext: 'abc' }, undefined, {
      runInsertError: { code: '42501', message: 'permission denied' },
    });
    const err = await runWeeklyStudio(service, ORG, 'manual').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RunInProgressError);
    expect((err as Error).message).toBe('Could not start the agent run.');
  });

  it('runs search + digest + images and finishes done with summed cost', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'angle', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# Digest', cost_cents: 4 });
    const { service, runs } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'schedule');
    expect(res.status).toBe('done');
    expect(webSearch).toHaveBeenCalledWith('decrypted-abc', expect.any(String));
    expect(writeDigest).toHaveBeenCalledWith('decrypted-abc', expect.stringContaining('angle'));
    expect(runs[0]).toMatchObject({ status: 'done', digest_md: '# Digest', cost_cents: 37, trigger: 'schedule' });
    expect(runs[0].finished_at).toBeTruthy();
  });

  it('persists an INTEGER cost_cents even when a media call reports a fractional cost', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'angle', cost_cents: 1.2 });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# Digest', cost_cents: 3.4 });
    const { service, runs, calls } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    const finishes = calls.filter(
      (c) => c.table === 'agent_runs' && c.op === 'update' && (c.payload as { status?: string }).status === 'done',
    );
    expect(finishes).toHaveLength(1);
    const cents = (finishes[0].payload as { cost_cents: number }).cost_cents;
    expect(Number.isInteger(cents)).toBe(true);
    expect(runs[0]).toMatchObject({ status: 'done', digest_md: '# Digest' });
  });

  it('marks the run failed with a safe error when a media call throws', async () => {
    vi.mocked(webSearch).mockRejectedValue(new Error('boom sk-or-secret'));
    const { service, runs } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('failed');
    expect(runs[0].status).toBe('failed');
    expect(String(runs[0].error)).not.toContain('secret');
    expect(writeDigest).not.toHaveBeenCalled();
  });

  it('counts a step at its estimate when the provider reports no cost', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'angle', cost_cents: null });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# Digest', cost_cents: null });
    vi.mocked(generateImage).mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
      cost_cents: null,
    });
    vi.mocked(startVideo).mockResolvedValue({ jobId: 'job-9', cost_cents: null });
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [], cost_cents: null });
    const { service, runs } = fakeService({ ciphertext: 'abc' });
    await runWeeklyStudio(service, ORG, 'manual');
    // search + digest + two images + video + the proposal pick, each at its estimate
    expect(runs[0]).toMatchObject({ status: 'done', cost_cents: 3 + 3 + 5 + 5 + 50 + 3 });
  });

  it('a reported cost of zero is kept as zero, not replaced by the estimate', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'angle', cost_cents: 0 });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# Digest', cost_cents: 0 });
    const { service, runs } = fakeService({ ciphertext: 'abc' }, { max_cost_cents: 1 });
    await runWeeklyStudio(service, ORG, 'manual');
    expect(runs[0]).toMatchObject({ status: 'done', cost_cents: 0 });
  });

  it('a run that fails part-way keeps the cost of the steps already paid for', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'angle', cost_cents: 3 });
    vi.mocked(writeDigest).mockRejectedValue(new Error('boom sk-or-secret'));
    const { service, runs } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('failed');
    expect(runs[0]).toMatchObject({ status: 'failed', cost_cents: 3 });
  });

  it('before each paid step the run row already holds the spend so far plus that step', async () => {
    const { service, runs } = fakeService({ ciphertext: 'abc' });
    const seen: Record<string, unknown> = {};
    vi.mocked(webSearch).mockImplementation(async () => {
      seen.search = runs[0].cost_cents;
      return { text: 'angle', cost_cents: 3 };
    });
    vi.mocked(writeDigest).mockImplementation(async () => {
      seen.digest = runs[0].cost_cents;
      return { text: '# Digest', cost_cents: 4 };
    });
    vi.mocked(startVideo).mockImplementation(async () => {
      seen.video = runs[0].cost_cents;
      seen.status = runs[0].status;
      return { jobId: 'job-9', cost_cents: null };
    });
    await runWeeklyStudio(service, ORG, 'manual');
    // If the process died inside a step, this is the figure a reaped run would keep.
    expect(seen).toEqual({ search: 3, digest: 3 + 3, video: 3 + 4 + 5 + 5 + 50, status: 'running' });
  });

  it('records the video cost on its asset as an estimate to be settled when it is collected', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 4 });
    vi.mocked(startVideo).mockResolvedValue({ jobId: 'job-9', cost_cents: null });
    const { service, runs, assets } = fakeService({ ciphertext: 'abc' });
    await runWeeklyStudio(service, ORG, 'manual');
    expect(assets.find((a) => a.kind === 'video')).toMatchObject({
      status: 'pending',
      cost_cents: 50,
      cost_estimated: true,
    });
    expect(runs[0].cost_cents).toBe(3 + 4 + 5 + 5 + 50);
  });

  it('scopes the key read and every agent_runs write by org_id', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 1 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 1 });
    const { service, calls } = fakeService({ ciphertext: 'abc' });
    await runWeeklyStudio(service, ORG, 'manual');
    const keyRead = calls.find((c) => c.table === 'org_ai_keys');
    expect(keyRead?.eqs).toContainEqual(['org_id', ORG]);
    const insert = calls.find((c) => c.table === 'agent_runs' && c.op === 'insert');
    expect(insert?.payload).toMatchObject({ org_id: ORG });
    const updates = calls.filter((c) => c.table === 'agent_runs' && c.op === 'update');
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u.eqs).toContainEqual(['org_id', ORG]);
  });

  it('generates poster + hero, uploads via the passed service, and records done assets', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 4 });
    const { service, runs, assets, uploads } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(uploads.map((u) => u.path)).toEqual([
      `agent-assets/${ORG}/run-1/poster.png`,
      `agent-assets/${ORG}/run-1/image.png`,
    ]);
    expect(uploads[0].opts).toMatchObject({ contentType: 'image/png', upsert: true });
    expect(assets).toHaveLength(3);
    expect(assets[0]).toMatchObject({
      org_id: ORG,
      run_id: 'run-1',
      kind: 'poster',
      status: 'done',
      storage_path: `${ORG}/run-1/poster.png`,
    });
    expect(assets[1]).toMatchObject({ kind: 'image', status: 'done' });
    expect(runs[0].cost_cents).toBe(3 + 4 + 5 + 5 + 20);
  });

  it('skips image generation when the per-run cap would be exceeded but still persists the digest', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# Digest', cost_cents: 4 });
    const { service, runs, assets, uploads } = fakeService(
      { ciphertext: 'abc' },
      { max_cost_cents: 1 },
    );
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(generateImage).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(assets).toHaveLength(0);
    expect(runs[0]).toMatchObject({ status: 'done', digest_md: '# Digest', cost_cents: 7 });
    expect(startVideo).not.toHaveBeenCalled();
  });

  it('kicks off a video and records a pending asset with its job id via the passed service', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 4 });
    const { service, assets } = fakeService({ ciphertext: 'abc' });
    await runWeeklyStudio(service, ORG, 'manual');
    expect(startVideo).toHaveBeenCalledWith('decrypted-abc', expect.any(String));
    const video = assets.find((a) => a.kind === 'video');
    expect(video).toMatchObject({
      org_id: ORG,
      run_id: 'run-1',
      status: 'pending',
      provider_job_id: 'job-9',
    });
  });

  it('skips the video (but keeps images and the run) when its estimate would exceed the cap', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 4 });
    const { service, runs, assets } = fakeService({ ciphertext: 'abc' }, { max_cost_cents: 40 });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(startVideo).not.toHaveBeenCalled();
    expect(assets.map((a) => a.kind)).toEqual(['poster', 'image']);
    expect(runs[0].status).toBe('done');
  });

  it('does not fail the run when the video kick-off throws', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 3 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 4 });
    vi.mocked(startVideo).mockRejectedValue(new Error('boom sk-or-secret'));
    const { service, runs, assets } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(runs[0].digest_md).toBe('d');
    expect(assets.some((a) => a.kind === 'video')).toBe(false);
  });

  it('records a failed asset (no secret) when an image fails and keeps the run done', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 1 });
    vi.mocked(writeDigest).mockResolvedValue({ text: 'd', cost_cents: 1 });
    vi.mocked(generateImage).mockRejectedValue(new Error('boom sk-or-secret'));
    const { service, runs, assets } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(runs[0].digest_md).toBe('d');
    expect(assets.filter((a) => a.kind !== 'video').map((a) => a.status)).toEqual(['failed', 'failed']);
    expect(JSON.stringify(assets)).not.toContain('secret');
  });

  it('queues an agent_proposals row for an opportunity and still finishes done', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 1 });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# D', cost_cents: 1 });
    const { service, runs, calls } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(runs[0]).toMatchObject({ status: 'done', digest_md: '# D' });
    const proposal = calls.find((c) => c.table === 'agent_proposals' && c.op === 'insert');
    expect(proposal?.payload).toMatchObject({
      org_id: ORG,
      run_id: 'run-1',
      action: 'promoteLeadToContact',
      status: 'pending',
    });
  });

  it('keeps the digest and a done run when the proposer throws', async () => {
    vi.mocked(webSearch).mockResolvedValue({ text: 'a', cost_cents: 1 });
    vi.mocked(writeDigest).mockResolvedValue({ text: '# D', cost_cents: 1 });
    vi.mocked(suggestProposals).mockRejectedValue(new Error('boom sk-or-secret'));
    const { service, runs } = fakeService({ ciphertext: 'abc' });
    const res = await runWeeklyStudio(service, ORG, 'manual');
    expect(res.status).toBe('done');
    expect(runs[0].digest_md).toBe('# D');
  });
});
