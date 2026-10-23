import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/agents/openrouter-media', () => ({ suggestProposals: vi.fn() }));

import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { proposeChanges } from '@/lib/agents/proposer';
import { suggestProposals } from '@/lib/agents/openrouter-media';

/** A service whose decided read answers page by page by `range`; the pending read is empty. */
function fakeService(decidedPages: { action: string; input: unknown }[][]) {
  const ranges: [number, number][] = [];
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        select() {
          let decided = false;
          let page: [number, number] | null = null;
          const chain: Record<string, unknown> = {};
          for (const m of ['eq', 'gte', 'order']) chain[m] = () => chain;
          chain.in = () => {
            decided = true;
            return chain;
          };
          chain.range = (from: number, to: number) => {
            page = [from, to];
            ranges.push(page);
            return chain;
          };
          chain.then = (resolve: (v: unknown) => void) => {
            if (!decided) return resolve({ data: [], error: null });
            const index = page ? page[0] / 1000 : 0;
            return resolve({ data: decidedPages[index] ?? [], error: null });
          };
          return chain;
        },
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  } as never;
  return { client, ranges, inserts };
}

const def = (candidateIds: string[]): AgentDefinition => ({
  agentKey: 'qa-agent',
  product: 'qa',
  buildContext: async () => ({ context: 'c', raw: {} }),
  scan: () => candidateIds.map((id) => ({ action: 'noop', input: { id }, title: id, detail: null })),
  hasNewData: async () => true,
  actions: { noop: entry(z.object({ id: z.string() }), async () => ({ ok: true as const, data: null })) },
  buildWriteContext: () => ({}),
  proposals: { pickPrompt: () => 'p', cooldownDays: 36500 },
  ui: { title: 'QA', subtitle: 's', screenPath: '/qa/agents', assetKinds: [] },
});

const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ action: 'noop', input: { id: `${prefix}${i}` } }));

describe('proposeChanges cooldown read', () => {
  beforeEach(() => vi.mocked(suggestProposals).mockReset());

  it('reads every page of decided rows, so a key on the second page still blocks', async () => {
    // 1000 on the first page, the one that matters on the second.
    const { client, ranges } = fakeService([rows('a', 1000), [{ action: 'noop', input: { id: 'old' } }]]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { context: 'c', raw: {} }, 200, 0, def(['old']));
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(suggestProposals).not.toHaveBeenCalled();
  });

  it('stops after a short page and still offers what was never decided', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'r' }], cost_cents: 1 });
    const { client, ranges, inserts } = fakeService([rows('a', 3)]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { context: 'c', raw: {} }, 200, 0, def(['a1', 'new']));
    expect(ranges).toEqual([[0, 999]]);
    expect(res.proposed).toBe(1);
    expect(inserts[0]).toMatchObject({ input: { id: 'new' } });
  });
});
