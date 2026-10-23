import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { entry, type AgentRegistry } from '@/lib/agents/definition';
import { approveProposal } from '@/lib/agents/decide-proposal';

type Update = { patch: Record<string, unknown>; filters: [string, unknown][] };
let claimResult: Record<string, unknown> | null = null;
let staleUpdateError: unknown = null;
const updates: Update[] = [];
const client = {
  from: () => ({
    update: (patch: Record<string, unknown>) => {
      const u: Update = { patch, filters: [] };
      updates.push(u);
      const q: Record<string, unknown> = {};
      q.eq = (c: string, v: unknown) => {
        u.filters.push([c, v]);
        return q;
      };
      for (const m of ['gt', 'select']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: claimResult });
      q.then = (res: (v: unknown) => unknown) => res({ error: patch.status === 'rejected' ? staleUpdateError : null });
      return q;
    },
  }),
} as never;

const ID = '44444444-4444-4444-8444-444444444444';
const financeRun = vi.fn();
const crmRun = vi.fn();
const financeCtx = vi.fn(() => ({ who: 'finance' }));
const crmCtx = vi.fn(() => ({ who: 'crm' }));

const registry: AgentRegistry = new Map([
  [
    'crm-focus',
    {
      agentKey: 'crm-focus',
      product: 'crm',
      actions: { createAgentNote: entry(z.object({ id: z.string() }), crmRun) },
      buildWriteContext: crmCtx,
      proposals: { pickPrompt: () => '' },
      ui: { title: 'crm', subtitle: '', screenPath: '/crm/agents', assetKinds: [] },
    } as never,
  ],
  [
    'finance-focus',
    {
      agentKey: 'finance-focus',
      product: 'finance',
      actions: { createAgentNote: entry(z.object({ id: z.string() }), financeRun) },
      buildWriteContext: financeCtx,
      writeContextTakesProposal: true,
      proposals: { pickPrompt: () => '' },
      ui: { title: 'finance', subtitle: '', screenPath: '/finance/agents', assetKinds: [] },
    } as never,
  ],
]);

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  staleUpdateError = null;
  claimResult = { action: 'createAgentNote', input: { id: 'x' }, product: 'finance' };
});

describe('approveProposal: no longer applies', () => {
  it('hands the finance action the claimed proposal id', async () => {
    financeRun.mockResolvedValueOnce({ ok: true, data: { id: 'n1' } });
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: true, screenPath: '/finance/agents' });
    expect(financeRun).toHaveBeenCalledWith({ who: 'finance', proposalId: ID }, { id: 'x' });
  });

  it('marks a stale suggestion rejected with { error, stale } and answers with the action sentence', async () => {
    financeRun.mockResolvedValueOnce({ ok: false, error: 'This no longer applies.', stale: true });
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: false, error: 'This no longer applies.', screenPath: '/finance/agents' });
    expect(updates).toHaveLength(2);
    // Only status and result: who decided, and when, stay as the claim wrote them.
    expect(updates[1].patch).toEqual({ status: 'rejected', result: { error: 'This no longer applies.', stale: true } });
    expect(updates[1].filters).toEqual([
      ['id', ID],
      ['org_id', 'org-1'],
    ]);
  });

  it('falls back to failed when the dismissal is refused, so nothing stays approved', async () => {
    staleUpdateError = { code: 'AGP01' };
    financeRun.mockResolvedValueOnce({ ok: false, error: 'This no longer applies.', stale: true });
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res.error).toBe('This no longer applies.');
    expect(updates[2].patch).toEqual({ status: 'failed', result: { error: 'This no longer applies.', stale: true } });
  });

  it('a finance failure that is not stale still reads "could not be applied" and marks failed', async () => {
    financeRun.mockResolvedValueOnce({ ok: false, error: 'That note could not be added.' });
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: false, error: 'The change could not be applied.', screenPath: '/finance/agents' });
    expect(updates[1].patch).toEqual({ status: 'failed', result: { error: 'That note could not be added.' } });
  });

  it('Kasturi is unchanged: no proposal id in its context, and its failures read the same', async () => {
    claimResult = { action: 'createAgentNote', input: { id: 'x' }, product: 'crm' };
    crmRun.mockResolvedValueOnce({ ok: false, error: 'nope' });
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(crmCtx).toHaveBeenCalledWith(client, 'org-1', 'user-1');
    expect(crmRun).toHaveBeenCalledWith({ who: 'crm' }, { id: 'x' });
    expect(res).toEqual({ ok: false, error: 'The change could not be applied.', screenPath: '/crm/agents' });
    expect(updates[1].patch).toEqual({ status: 'failed', result: { error: 'nope' } });
  });
});
