import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/openrouter-media', () => ({ suggestProposals: vi.fn() }));

import { opportunityScan, proposeChanges, type Candidate } from '@/lib/agents/proposer';
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

function fakeService(
  pending: { action: string; input: unknown }[] = [],
  selectError: { message: string; code?: string } | null = null,
) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from() {
      // Chainable select: any number of .eq() calls, awaitable at the end.
      const chain: Record<string, unknown> = {
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: pending, error: selectError }),
      };
      return {
        select: () => chain,
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
});

describe('proposeChanges gate', () => {
  beforeEach(() => vi.mocked(suggestProposals).mockReset());

  it('queues the LLM-selected candidate with its title + rationale', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({
      keep: [{ index: 0, rationale: 'A won lead ready for sales.' }],
      cost_cents: 2,
    });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(1);
    expect(res.cost_cents).toBe(2);
    expect(inserts[0]).toMatchObject({
      action: 'promoteLeadToContact',
      status: 'pending',
      rationale: 'A won lead ready for sales.',
      run_id: 'run-1',
      org_id: 'org-1',
    });
    expect(inserts[0].title).toContain('Aina Rahman');
  });

  it('drops an out-of-range selection', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 99, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('does not re-propose a pending opportunity, without paying for an LLM call (dedupe before the model)', async () => {
    const { client, inserts } = fakeService([{ action: 'promoteLeadToContact', input: { id: LEAD_ID } }]);
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('fails closed without calling the LLM when the dedupe query errors', async () => {
    const { client, inserts } = fakeService([], { message: 'boom', code: '500' });
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('skips the LLM entirely when already at the cost cap', async () => {
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 50, 50);
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
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads, appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(5);
    expect(inserts).toHaveLength(5);
  });

  it('drops a schema-invalid candidate', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead({ id: 'not-a-uuid' })], appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('drops an off-list action (injected scan)', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const scan = (): Candidate[] => [
      { action: 'deleteLead', input: { id: LEAD_ID }, title: 'x', detail: null },
    ];
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [], appts: [], context: 'ctx' }, 200, 10, scan);
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
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead({ stage: 'qualified' })], appts: [], context: 'ctx' }, 200, 10);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('passes the seam only { index, title }', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [], cost_cents: 0 });
    const { client } = fakeService();
    await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    const arg = vi.mocked(suggestProposals).mock.calls[0];
    expect(arg[0]).toBe('key');
    expect(arg[1]).toBe('ctx');
    expect(arg[2]).toEqual([{ index: 0, title: expect.any(String) }]);
    expect(Object.keys(arg[2][0]).sort()).toEqual(['index', 'title']);
  });
});
