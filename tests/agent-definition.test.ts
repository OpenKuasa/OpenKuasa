import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  entry,
  agentFor,
  agentForProduct,
  actionsFor,
  type AgentDefinition,
  type AgentRegistry,
} from '@/lib/agents/definition';

const qa: AgentDefinition = {
  agentKey: 'qa-agent',
  product: 'qa',
  buildContext: async () => ({ context: 'ctx', raw: { n: 1 } }),
  scan: () => [],
  hasNewData: async () => true,
  actions: {
    noop: entry(z.object({ id: z.string() }), async (_ctx: { tag: string }, _i) => ({
      ok: true as const,
      data: { id: 'x' },
    })),
  },
  buildWriteContext: () => ({ tag: 't' }),
  digest: { prompt: () => 'd' },
  proposals: { pickPrompt: () => '' },
  ui: { title: 'QA', subtitle: 's', screenPath: '/qa/agents', assetKinds: [] },
};
const reg: AgentRegistry = new Map([[qa.agentKey, qa]]);

describe('agent definition lookups', () => {
  it('resolves by agentKey and by product, over an explicit registry', () => {
    expect(agentFor('qa-agent', reg)?.product).toBe('qa');
    expect(agentForProduct('qa', reg)?.agentKey).toBe('qa-agent');
    expect(Object.keys(actionsFor('qa', reg))).toEqual(['noop']);
  });

  it('returns undefined / empty for misses', () => {
    expect(agentFor('nope', reg)).toBeUndefined();
    expect(agentForProduct('nope', reg)).toBeUndefined();
    expect(actionsFor('nope', reg)).toEqual({});
  });

  it('entry() parses input with the schema before running the capability', async () => {
    let seen: unknown;
    const e = entry(z.object({ id: z.string() }), async (_c: { tag: string }, i) => {
      seen = i;
      return { ok: true as const, data: null };
    });
    await e.run({ tag: 't' }, { id: 'abc', extra: 9 });
    expect(seen).toEqual({ id: 'abc' }); // extra stripped by the schema
  });
});
