import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/agents/openrouter-media', () => ({ suggestProposals: vi.fn() }));

import { proposeChanges, type Candidate } from '@/lib/agents/proposer';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { reachAgent } from '@/lib/agents/reach-agent';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const lead = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: LEAD_ID,
    name: 'Aina Rahman',
    channel: 'whatsapp',
    stage: 'won',
    source: 'Free Catering Quote',
    promoted_contact_id: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  }) as never;

/** Build the model-ready `built` arg proposeChanges now takes ({ context, raw, trend? }). */
const built = (
  o: { leads?: unknown[]; appts?: unknown[]; context?: string; trend?: string } = {},
) => ({
  context: o.context ?? 'ctx',
  raw: { leads: (o.leads ?? []) as never, appts: (o.appts ?? []) as never, campaigns: [] as never },
  trend: o.trend,
});

function fakeService(
  pending: { action: string; input: unknown }[] = [],
  selectError: { message: string; code?: string } | null = null,
  // The recent-form gate (`select('id')`) is a distinct query; control it separately.
  recentForms: { id: string }[] = [],
  recentError: { message: string; code?: string } | null = null,
  // The cooldown read (a select narrowed with `.in('status', …)`) is a third query.
  decided: { action: string; input: unknown; check_key?: string | null }[] = [],
  decidedError: { message: string; code?: string } | null = null,
) {
  const inserts: Record<string, unknown>[] = [];
  const selects: { cols: string; calls: { method: string; args: unknown[] }[] }[] = [];
  const client = {
    from() {
      // `select('id')` is the recent-form gate; a select narrowed with `.in()` is the cooldown
      // read; anything else is the dedupe fetch.
      const select = (cols: string) => {
        const isRecentFormGate = cols === 'id';
        const rec = { cols, calls: [] as { method: string; args: unknown[] }[] };
        selects.push(rec);
        let isDecided = false;
        const chain: Record<string, unknown> = {};
        for (const m of ['eq', 'gte', 'limit', 'in']) {
          chain[m] = (...args: unknown[]) => {
            rec.calls.push({ method: m, args });
            if (m === 'in') isDecided = true;
            return chain;
          };
        }
        chain.then = (resolve: (v: unknown) => void) => {
          if (isDecided) return resolve({ data: decided, error: decidedError });
          return resolve(
            isRecentFormGate
              ? { data: recentForms, error: recentError }
              : { data: pending, error: selectError },
          );
        };
        return chain;
      };
      return {
        select,
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  } as never;
  return { client, inserts, selects };
}

describe('proposeChanges gate', () => {
  beforeEach(() => vi.mocked(suggestProposals).mockReset());

  it('queues the LLM-selected candidate with its title + rationale', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({
      keep: [{ index: 0, rationale: 'A won lead ready for sales.' }],
      cost_cents: 2,
    });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    expect(res.proposed).toBe(1);
    expect(res.cost_cents).toBe(2);
    expect(inserts[0]).toMatchObject({
      action: 'promoteLeadToContact',
      status: 'pending',
      rationale: 'A won lead ready for sales.',
      run_id: 'run-1',
      org_id: 'org-1',
      agent_key: 'weekly-studio',
      product: 'reach',
    });
    expect(inserts[0].title).toContain('Aina Rahman');
  });

  it('inserts proposals carrying the definition agentKey/product, from def.scan + def.actions', async () => {
    const qa: AgentDefinition = {
      agentKey: 'qa-agent',
      product: 'qa',
      buildContext: async () => ({ context: 'c', raw: {} }),
      scan: () => [{ action: 'noop', input: { id: 'x' }, title: 'T', detail: null }],
      hasNewData: async () => true,
      actions: { noop: entry(z.object({ id: z.string() }), async () => ({ ok: true as const, data: null })) },
      buildWriteContext: () => ({}),
      digest: { prompt: () => 'd' },
      proposals: { pickPrompt: () => '' },
      ui: { title: 'QA', subtitle: 's', screenPath: '/qa/agents', assetKinds: [] },
    };
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'r' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, qa);
    expect(res.proposed).toBe(1);
    expect(inserts[0]).toMatchObject({ agent_key: 'qa-agent', product: 'qa', action: 'noop' });
  });

  it('drops an out-of-range selection', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 99, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('does not re-propose a pending opportunity, without paying for an LLM call (dedupe before the model)', async () => {
    const { client, inserts } = fakeService([{ action: 'promoteLeadToContact', input: { id: LEAD_ID } }]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('fails closed without calling the LLM when the dedupe query errors', async () => {
    const { client, inserts } = fakeService([], { message: 'boom', code: '500' });
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('skips the LLM entirely when already at the cost cap', async () => {
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 50, 50, reachAgent);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
  });

  const uid = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

  it('caps proposals at 5', async () => {
    const leads = [1, 2, 3, 4, 5, 6].map((n) => lead({ id: uid(n), name: `Lead ${n}` }));
    vi.mocked(suggestProposals).mockResolvedValue({
      keep: leads.map((_, index) => ({ index, rationale: 'r' })),
      cost_cents: 1,
    });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads }), 200, 10, reachAgent);
    expect(res.proposed).toBe(5);
    expect(inserts).toHaveLength(5);
  });

  it('drops a schema-invalid candidate', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead({ id: 'not-a-uuid' })] }), 200, 10, reachAgent);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('drops an off-list action (injected scan)', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const offListDef = {
      ...reachAgent,
      scan: (): Candidate[] => [{ action: 'deleteLead', input: { id: LEAD_ID }, title: 'x', detail: null }],
    };
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, offListDef);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('dedupes a multi-key pending appointment regardless of key order / scheduled_at', async () => {
    const { client, inserts } = fakeService([
      {
        action: 'createAppointment',
        input: { via: 'Phone', status: 'scheduled', kind: 'Follow-up call', contact_name: 'Aina Rahman', scheduled_at: '2020-01-01T09:00:00.000Z' },
      },
    ]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead({ stage: 'qualified' })] }), 200, 10, reachAgent);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('passes the seam only { index, title }', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [], cost_cents: 0 });
    const { client } = fakeService();
    await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    // The seam now takes the finished prompt: the candidates reach it only as `${index}. ${title}`.
    const arg = vi.mocked(suggestProposals).mock.calls[0];
    expect(arg[0]).toBe('key');
    expect(arg[1]).toContain('Business snapshot:\nctx');
    expect(arg[1]).toMatch(/Candidates:\n0\. .*Aina Rahman/);
  });

  it('offers a draft form for the trend and queues it with the model-supplied name (rule 4)', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({
      keep: [{ index: 0, rationale: 'Capture interest in the seasonal angle.', name: 'Raya Promo Leads' }],
      cost_cents: 2,
    });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(
      client,
      'org-1',
      'run-1',
      'key',
      built({ trend: 'Raya season gifting' }),
      200,
      10,
      reachAgent,
    );
    // The trend reaches the seam inside the finished prompt; channel/status are server-forced.
    expect(vi.mocked(suggestProposals).mock.calls[0][1]).toContain(
      "This week's market angles:\nRaya season gifting",
    );
    expect(res.proposed).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      action: 'createForm',
      status: 'pending',
      input: { name: 'Raya Promo Leads', channel: null, status: 'draft', category: null },
    });
    expect(inserts[0].title).toContain('Raya Promo Leads');
  });

  it('does not offer a form, or call the LLM, when there is no trend', async () => {
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, reachAgent);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('does not offer a form when one was proposed recently (any status)', async () => {
    // recent-form gate finds a prior proposal within the cooldown → suppressed.
    const { client, inserts } = fakeService([], null, [{ id: 'f1' }]);
    const res = await proposeChanges(
      client,
      'org-1',
      'run-1',
      'key',
      built({ trend: 'Raya season gifting' }),
      200,
      10,
      reachAgent,
    );
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('fails closed (does not offer a form) when the recent-form gate errors', async () => {
    const { client, inserts } = fakeService([], null, [], { message: 'boom' });
    const res = await proposeChanges(
      client,
      'org-1',
      'run-1',
      'key',
      built({ trend: 'Raya season gifting' }),
      200,
      10,
      reachAgent,
    );
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('drops the form when the model returns no name', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(
      client,
      'org-1',
      'run-1',
      'key',
      built({ trend: 'Raya season gifting' }),
      200,
      10,
      reachAgent,
    );
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });
});

describe('proposeChanges definition-supplied settings', () => {
  beforeEach(() => vi.mocked(suggestProposals).mockReset());

  const qaWith = (
    proposals: AgentDefinition['proposals'],
    candidates: Candidate[] = [{ action: 'noop', input: { id: 'x' }, title: 'T', detail: null }],
  ): AgentDefinition => ({
    agentKey: 'qa-agent',
    product: 'qa',
    buildContext: async () => ({ context: 'c', raw: {} }),
    scan: () => candidates,
    hasNewData: async () => true,
    actions: { noop: entry(z.object({ id: z.string() }), async () => ({ ok: true as const, data: null })) },
    buildWriteContext: () => ({}),
    proposals,
    ui: { title: 'QA', subtitle: 's', screenPath: '/qa/agents', assetKinds: [] },
  });

  it('scopes the pending read by the definition product', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [], cost_cents: 0 });
    const { client, selects } = fakeService();
    await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    const pendingRead = selects.find((s) => s.cols !== 'id');
    expect(pendingRead?.calls).toContainEqual({ method: 'eq', args: ['product', 'reach'] });
    expect(pendingRead?.calls).toContainEqual({ method: 'eq', args: ['status', 'pending'] });
  });

  it('makes no decided read, and inserts check_key null and no expires_at, for reach', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'r' }], cost_cents: 1 });
    const { client, inserts, selects } = fakeService();
    await proposeChanges(client, 'org-1', 'run-1', 'key', built({ leads: [lead()] }), 200, 10, reachAgent);
    expect(selects.some((s) => s.calls.some((c) => c.method === 'in'))).toBe(false);
    expect(inserts[0]).toMatchObject({ check_key: null });
    expect(inserts[0]).not.toHaveProperty('expires_at');
  });

  it('cooldown skips a candidate decided within the window', async () => {
    const def = qaWith({ pickPrompt: () => 'p', cooldownDays: 14 });
    const { client, inserts, selects } = fakeService([], null, [], null, [
      { action: 'noop', input: { id: 'x' } },
    ]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, def);
    const decidedRead = selects.find((s) => s.calls.some((c) => c.method === 'in'));
    expect(decidedRead?.cols).toBe('action, input, check_key');
    expect(decidedRead?.calls).toContainEqual({ method: 'eq', args: ['product', 'qa'] });
    expect(decidedRead?.calls).toContainEqual({ method: 'in', args: ['status', ['approved', 'rejected']] });
    const gte = decidedRead?.calls.find((c) => c.method === 'gte');
    expect(gte?.args[0]).toBe('decided_at');
    const ageMs = Date.now() - new Date(gte?.args[1] as string).getTime();
    expect(Math.abs(ageMs - 14 * 24 * 3600_000)).toBeLessThan(60_000);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('does not make the decided read without cooldownDays', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [], cost_cents: 0 });
    const def = qaWith({ pickPrompt: () => 'p' });
    const { client, selects } = fakeService();
    await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, def);
    expect(selects.some((s) => s.calls.some((c) => c.method === 'in'))).toBe(false);
  });

  it('fails closed when the cooldown read errors', async () => {
    const def = qaWith({ pickPrompt: () => 'p', cooldownDays: 14 });
    const { client, inserts } = fakeService([], null, [], null, [], { message: 'boom' });
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, def);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('passes a stored row check_key to the definition dedupe key', async () => {
    const dedupeKey = vi.fn((action: string, _input: unknown, checkKey?: string) => `${action}:${checkKey ?? '-'}`);
    const def = qaWith(
      { pickPrompt: () => 'p', dedupeKey },
      [{ action: 'noop', input: { id: 'x' }, title: 'T', detail: null, checkKey: 'k1' }],
    );
    const { client } = fakeService([{ action: 'noop', input: { id: 'x' }, check_key: 'k1' } as never]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, def);
    expect(dedupeKey).toHaveBeenCalledWith('noop', { id: 'x' }, 'k1');
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res.proposed).toBe(0);
  });

  it('inserts check_key and expires_at when the definition sets them', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'r' }], cost_cents: 1 });
    const def = qaWith(
      { pickPrompt: () => 'the prompt', expiresInDays: 7 },
      [{ action: 'noop', input: { id: 'x' }, title: 'T', detail: null, checkKey: 'k1' }],
    );
    const { client, inserts } = fakeService();
    const before = Date.now();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', built(), 200, 10, def);
    expect(res.proposed).toBe(1);
    expect(inserts[0]).toMatchObject({ check_key: 'k1' });
    const exp = new Date(inserts[0].expires_at as string).getTime();
    expect(Math.abs(exp - (before + 7 * 24 * 3600_000))).toBeLessThan(60_000);
    // The finished prompt comes from the definition.
    expect(vi.mocked(suggestProposals).mock.calls[0][1]).toBe('the prompt');
  });
});
