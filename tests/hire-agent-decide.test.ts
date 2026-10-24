import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '@/lib/agents/definition';
import { approveProposal } from '@/lib/agents/decide-proposal';
import { hireAgent } from '@/lib/agents/hire-agent';
import { AGENTS } from '@/lib/agents/registry';

/**
 * Approving a Lekir suggestion end to end through the real hire definition: the claim, the
 * re-read of the record under the approver's session, then either the note RPC or the
 * "no longer applies" dismissal (rejected with `result.stale = true`).
 */

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const ID = '55555555-5555-4555-8555-555555555555';
const APP = '11111111-1111-4111-8111-111111111111';
const CAND = '22222222-2222-4222-8222-222222222222';

type Update = { patch: Record<string, unknown>; filters: [string, unknown][] };

let claim: Record<string, unknown> | null;
let checkKey: string;
let records: Record<string, { data: unknown; error: unknown }>;
const updates: Update[] = [];
const rpc = vi.fn(async () => ({ data: 'note-1', error: null }));

const client = {
  rpc,
  from(table: string) {
    return {
      update(patch: Record<string, unknown>) {
        const u: Update = { patch, filters: [] };
        updates.push(u);
        const q: Record<string, unknown> = {};
        q.eq = (c: string, v: unknown) => {
          u.filters.push([c, v]);
          return q;
        };
        for (const m of ['gt', 'select']) q[m] = () => q;
        q.maybeSingle = async () => ({ data: claim });
        q.then = (res: (v: unknown) => unknown) => res({ error: null });
        return q;
      },
      select() {
        const reply = async () =>
          table === 'agent_proposals'
            ? { data: { check_key: checkKey, created_at: '2026-10-23T04:00:00.000Z' }, error: null }
            : (records[table] ?? { data: null, error: null });
        const q: Record<string, unknown> = {};
        q.eq = () => q;
        q.maybeSingle = reply;
        q.limit = reply;
        q.then = (res: (v: unknown) => unknown) => reply().then(res);
        return q;
      },
    };
  },
} as never;

const registry: AgentRegistry = new Map([[hireAgent.agentKey, hireAgent]]);
const note = (target: string, entity_type: string) => ({
  target,
  entity_type,
  label: 'Aisyah · Events Executive',
  body: 'Aisyah applied for Events Executive 5 days ago and is still at Applied. (as of 23 Oct 2026)',
  stage: '1',
});

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  records = {};
  checkKey = 'application_unscreened';
  claim = { action: 'createAgentNote', input: note(APP, 'hire_application'), product: 'hire' };
});

describe('approveProposal for hire', () => {
  it('the live registry routes the hire product to the hire agent', () => {
    expect([...AGENTS.values()].find((d) => d.product === 'hire')).toBe(hireAgent);
  });

  it('adds the note through the RPC with the claimed proposal id when the record still matches', async () => {
    records.hire_applications = { data: { stage: 'applied', outcome: 'active', offered_at: null }, error: null };
    const res = await approveProposal(client, ORG, USER, ID, registry);
    expect(res).toEqual({ ok: true, screenPath: '/hire/agents' });
    expect(rpc).toHaveBeenCalledWith('hire_add_agent_note', { target_org: ORG, proposal_id: ID });
  });

  it('a stage moved since: no note, "This no longer applies.", and the proposal is rejected with stale', async () => {
    records.hire_applications = { data: { stage: 'interview', outcome: 'active', offered_at: null }, error: null };
    const res = await approveProposal(client, ORG, USER, ID, registry);
    expect(res).toEqual({ ok: false, error: 'This no longer applies.', screenPath: '/hire/agents' });
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toHaveLength(2);
    expect(updates[1].patch).toEqual({ status: 'rejected', result: { error: 'This no longer applies.', stale: true } });
    expect(updates[1].filters).toEqual([
      ['id', ID],
      ['org_id', ORG],
    ]);
  });

  it('a candidate taken out of the pool since: no note, rejected with stale', async () => {
    checkKey = 'pool_idle';
    claim = { action: 'createAgentNote', input: note(CAND, 'hire_candidate'), product: 'hire' };
    records.hire_candidates = { data: { pool_status: 'none' }, error: null };
    const res = await approveProposal(client, ORG, USER, ID, registry);
    expect(res.error).toBe('This no longer applies.');
    expect(rpc).not.toHaveBeenCalled();
    expect(updates[1].patch).toEqual({ status: 'rejected', result: { error: 'This no longer applies.', stale: true } });
  });

  it('a refused RPC reads "could not be applied" and marks the proposal failed', async () => {
    records.hire_applications = { data: { stage: 'applied', outcome: 'active', offered_at: null }, error: null };
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'HIR01' } } as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await approveProposal(client, ORG, USER, ID, registry);
    log.mockRestore();
    expect(res).toEqual({ ok: false, error: 'The change could not be applied.', screenPath: '/hire/agents' });
    expect(updates[1].patch).toEqual({ status: 'failed', result: { error: 'That note could not be added.' } });
  });
});
