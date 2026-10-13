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

import { runAgent } from '@/lib/agents/run-agent';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { z } from 'zod';
import { webSearch, writeDigest, generateImage, startVideo, suggestProposals } from '@/lib/agents/openrouter-media';

const ORG = 'org-xyz';

function fakeService(keyRow: { ciphertext: string } | null = { ciphertext: 'abc' }) {
  const runs: Record<string, unknown>[] = [];
  const service = {
    from(table: string) {
      return {
        select() {
          const b = {
            eq() {
              return b;
            },
            gte() {
              return b;
            },
            limit() {
              return b;
            },
            then: (resolve: (v: { data: never[] }) => void) => resolve({ data: [] }),
            maybeSingle: async () => ({
              data: table === 'agent_configs' ? { max_cost_cents: 200 } : keyRow,
              error: null,
            }),
          };
          return b;
        },
        insert(payload: Record<string, unknown>) {
          if (table === 'agent_runs') {
            const row = { id: 'run-1', ...payload };
            runs.push(row);
            return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
          }
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          const b = {
            eq() {
              return b;
            },
            then(resolve: (v: { error: null }) => void) {
              if (runs[0]) Object.assign(runs[0], patch);
              resolve({ error: null });
            },
          };
          return b;
        },
      };
    },
  };
  return { service: service as never, runs };
}

const qa: AgentDefinition = {
  agentKey: 'qa-agent',
  product: 'qa',
  buildContext: async () => ({ context: 'ctx', raw: {} }),
  scan: () => [],
  hasNewData: async () => true,
  actions: { noop: entry(z.object({ id: z.string() }), async () => ({ ok: true as const, data: null })) },
  buildWriteContext: () => ({}),
  digest: { prompt: () => 'digest prompt' }, // no research, no media
  ui: { title: 'QA', subtitle: 's', screenPath: '/qa/agents', assetKinds: [] },
};

beforeEach(() => {
  vi.mocked(webSearch).mockReset();
  vi.mocked(writeDigest).mockReset();
  vi.mocked(generateImage).mockReset();
  vi.mocked(startVideo).mockReset();
  vi.mocked(suggestProposals).mockReset();
  vi.mocked(writeDigest).mockResolvedValue({ text: '# QA digest', cost_cents: 2 });
});

describe('runAgent drives any definition', () => {
  it('writes a run row with the definition agentKey and finishes done (no reach imports)', async () => {
    const { service, runs } = fakeService();
    const res = await runAgent(service, ORG, 'manual', qa);
    expect(res).toMatchObject({ runId: 'run-1', status: 'done' });
    expect(runs[0]).toMatchObject({ agent_key: 'qa-agent', status: 'done', digest_md: '# QA digest', trigger: 'manual' });
  });

  it('skips the research step when the definition has none, and never generates media it has none of', async () => {
    const { service } = fakeService();
    await runAgent(service, ORG, 'manual', qa);
    expect(webSearch).not.toHaveBeenCalled(); // qa has no research
    expect(generateImage).not.toHaveBeenCalled(); // qa has no media
    expect(startVideo).not.toHaveBeenCalled();
    expect(writeDigest).toHaveBeenCalledWith('decrypted-abc', 'digest prompt');
  });

  it('fails with "no AI key" before any paid call when the workspace has no key', async () => {
    const { service, runs } = fakeService(null);
    const res = await runAgent(service, ORG, 'manual', qa);
    expect(res.status).toBe('failed');
    expect(String(runs[0].error)).toContain('no AI key');
    expect(writeDigest).not.toHaveBeenCalled();
  });
});
