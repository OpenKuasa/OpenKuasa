import { describe, expect, it, vi } from 'vitest';
import { createSeedReachData } from '@/lib/reach/seed';

// What each assistant hands the model: captured instead of calling one.
const seen = vi.hoisted(() => ({ calls: [] as { tools: Record<string, unknown>; toolApproval?: Record<string, unknown> }[] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (options: { tools: Record<string, unknown>; toolApproval?: Record<string, unknown> }) => {
      seen.calls.push({ tools: options.tools, toolApproval: options.toolApproval });
      return {};
    },
  };
});

const { runTuah, runKasturi } = await import('@/lib/ai/agents/orchestrator');
const { withTuah } = await import('./helpers/approvals');

const reach = () => ({ data: createSeedReachData() });
const crm = () => ({ client: {} as never, orgId: 'org1', userId: 'u1', canWrite: true });
const ask = [{ role: 'user' as const, content: 'How do I add my OpenRouter key?' }];

describe('the docs search beside the change tools', () => {
  it('is held by a single assistant, and is in no approval map', () => {
    seen.calls = [];
    runTuah(...withTuah(ask, reach(), undefined, undefined, null, crm()));
    runKasturi(ask, crm(), reach());
    expect(seen.calls).toHaveLength(2);
    for (const call of seen.calls) {
      expect(Object.keys(call.tools)).toContain('searchDocs');
      // Change tools are there and gated, so the map is real; the docs search is not in it.
      expect(Object.keys(call.toolApproval ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(call.toolApproval ?? {})).not.toContain('searchDocs');
    }
  });
});
