import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/agents/openrouter-media', () => ({ suggestProposals: vi.fn() }));

import { opportunityScan, proposeChanges, type Candidate } from '@/lib/agents/proposer';
import { entry, type AgentDefinition } from '@/lib/agents/definition';
import { reachAgent } from '@/lib/agents/reach-agent';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const now = new Date('2026-10-11T00:00:00Z');
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

const appt = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: '99999999-9999-4999-8999-999999999999',
    contact_name: 'Aina Rahman',
    kind: 'Follow-up call',
    scheduled_at: '2026-10-01T09:00:00Z', // past, so it is never "upcoming"
    via: 'Phone',
    status: 'completed',
    created_at: '2026-09-30T00:00:00Z',
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
) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from() {
      // `select('id')` is the recent-form gate; anything else is the dedupe fetch.
      const select = (cols: string) => {
        const isRecentFormGate = cols === 'id';
        const data = isRecentFormGate ? recentForms : pending;
        const error = isRecentFormGate ? recentError : selectError;
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          limit: () => chain,
          then: (resolve: (v: unknown) => void) => resolve({ data, error }),
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
  return { client, inserts };
}

describe('opportunityScan', () => {
  it('proposes promote for a won, unpromoted lead', () => {
    const cands = opportunityScan([lead()], [], now);
    expect(cands.some((c) => c.action === 'promoteLeadToContact')).toBe(true);
  });
  it('does not propose promote for an already-promoted lead', () => {
    const cands = opportunityScan([lead({ promoted_contact_id: 'c1' })], [], now);
    expect(cands.some((c) => c.action === 'promoteLeadToContact')).toBe(false);
  });

  it('proposes advancing a lead that completed a meeting but is still below booked', () => {
    const cands = opportunityScan([lead({ stage: 'qualified' })], [appt()], now);
    const advance = cands.find((c) => c.action === 'setLeadStage');
    expect(advance?.input).toEqual({ id: LEAD_ID, stage: 'booked' });
  });

  it('does not advance a lead that is already booked or won', () => {
    for (const stage of ['booked', 'won'] as const) {
      const cands = opportunityScan([lead({ stage })], [appt()], now);
      expect(cands.some((c) => c.action === 'setLeadStage')).toBe(false);
    }
  });

  it('does not advance a lead whose appointment is not completed', () => {
    const cands = opportunityScan([lead({ stage: 'qualified' })], [appt({ status: 'scheduled' })], now);
    expect(cands.some((c) => c.action === 'setLeadStage')).toBe(false);
  });
});

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
    const arg = vi.mocked(suggestProposals).mock.calls[0];
    expect(arg[0]).toBe('key');
    expect(arg[1]).toBe('ctx');
    expect(arg[2]).toEqual([{ index: 0, title: expect.any(String) }]);
    expect(Object.keys(arg[2][0]).sort()).toEqual(['index', 'title']);
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
    // The trend reaches the seam as the 4th arg; channel/status are server-forced.
    expect(vi.mocked(suggestProposals).mock.calls[0][3]).toBe('Raya season gifting');
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
