import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { entry, type AgentRegistry } from '@/lib/agents/definition';
import { approveProposal, rejectProposal, screensToRefresh } from '@/lib/agents/decide-proposal';

type Update = { patch: Record<string, unknown>; chain: string[] };
let claimResult: Record<string, unknown> | null = null;
let rejectResult: Record<string, unknown> | null = null;
const updates: Update[] = [];
const client = {
  from: () => ({
    update: (patch: Record<string, unknown>) => {
      const u: Update = { patch, chain: [] };
      updates.push(u);
      const q: Record<string, unknown> = {};
      for (const m of ['eq', 'gt', 'select']) q[m] = () => { u.chain.push(m); return q; };
      q.maybeSingle = async () => ({ data: patch.status === 'rejected' ? rejectResult : claimResult });
      q.then = (res: (v: unknown) => unknown) => res({ error: null });
      return q;
    },
  }),
} as never;

const ID = '44444444-4444-4444-8444-444444444444';
const reachRun = vi.fn(async () => ({ ok: true as const, data: { from: 'reach' } }));
const crmRun = vi.fn(async () => ({ ok: true as const, data: { from: 'crm' } }));
const reachCtx = vi.fn(() => ({ who: 'reach' }));
const crmCtx = vi.fn(() => ({ who: 'crm' }));

function stub(agentKey: string, product: string, run: typeof reachRun, ctx: typeof reachCtx, screenPath: string) {
  return {
    agentKey,
    product,
    actions: { noop: entry(z.object({ id: z.string() }), run) },
    buildWriteContext: ctx,
    proposals: { pickPrompt: () => '' },
    ui: { title: product, subtitle: '', screenPath, assetKinds: [] },
  } as never;
}

const registry: AgentRegistry = new Map([
  ['weekly-studio', stub('weekly-studio', 'reach', reachRun, reachCtx, '/reach/agents')],
  ['crm-focus', stub('crm-focus', 'crm', crmRun, crmCtx, '/crm/agents')],
]);

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  claimResult = { action: 'noop', input: { id: 'x' }, product: 'crm' };
  rejectResult = null;
});

describe('approveProposal', () => {
  it('routes a crm proposal to the crm write-context', async () => {
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: true, screenPath: '/crm/agents' });
    expect(crmCtx).toHaveBeenCalledWith(client, 'org-1', 'user-1');
    expect(crmRun).toHaveBeenCalledWith({ who: 'crm' }, { id: 'x' });
    expect(reachCtx).not.toHaveBeenCalled();
    expect(reachRun).not.toHaveBeenCalled();
    expect(updates[0].patch).toMatchObject({ status: 'approved', decided_by: 'user-1' });
    expect(updates[1].patch).toMatchObject({ result: { from: 'crm' } });
  });

  it('marks an unknown product failed and runs nothing', async () => {
    claimResult = { action: 'noop', input: { id: 'x' }, product: 'ghost' };
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: false, error: 'The change could not be applied.', screenPath: undefined });
    expect(updates).toHaveLength(2);
    expect(updates[1].patch).toMatchObject({ status: 'failed', result: { error: 'No agent handles this suggestion.' } });
    expect(reachRun).not.toHaveBeenCalled();
    expect(crmRun).not.toHaveBeenCalled();
  });

  it('reports already handled when the claim loses, with no further writes', async () => {
    claimResult = null;
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: false, error: 'That suggestion has already been handled.' });
    expect(updates).toHaveLength(1);
  });

  it('flips to failed and still returns the screen path when the action fails', async () => {
    crmRun.mockResolvedValueOnce({ ok: false, error: 'nope' } as never);
    const res = await approveProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: false, error: 'The change could not be applied.', screenPath: '/crm/agents' });
    expect(updates[1].patch).toMatchObject({ status: 'failed', result: { error: 'nope' } });
  });
});

describe('rejectProposal', () => {
  it('marks rejected with decided_by and returns the screen path', async () => {
    rejectResult = { id: 'p1', product: 'reach' };
    const res = await rejectProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: true, screenPath: '/reach/agents' });
    expect(updates[0].patch).toMatchObject({ status: 'rejected', decided_by: 'user-1' });
    expect(reachRun).not.toHaveBeenCalled();
  });

  it('reports already handled when nothing matched', async () => {
    const res = await rejectProposal(client, 'org-1', 'user-1', ID, registry);
    expect(res).toEqual({ ok: false, error: 'That suggestion has already been handled.' });
  });
});

describe('screensToRefresh', () => {
  it('uses the result screen when there is one', () => {
    expect(screensToRefresh({ screenPath: '/crm/agents' }, registry)).toEqual(['/crm/agents']);
  });

  it('refreshes every registered agent screen, once each, when already handled', () => {
    const dup: AgentRegistry = new Map([
      ...registry,
      ['other', stub('other', 'reach', reachRun, reachCtx, '/reach/agents')],
    ]);
    expect(screensToRefresh({}, dup)).toEqual(['/reach/agents', '/crm/agents']);
  });
});
