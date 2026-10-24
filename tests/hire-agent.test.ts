import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AGENT_KEYS } from '@/lib/agents/agent-keys';
import { financeAgent } from '@/lib/agents/finance-agent';
import { interpretFocus } from '@/lib/agents/focus/interpret';
import { hireAgent } from '@/lib/agents/hire-agent';
import { AGENTS, agentForProduct } from '@/lib/agents/registry';
import { HIRE_FOCUS } from '@/lib/agents/types';
import { HIRE_FOCUS_MENU } from '@/lib/hire/agent/checks';
import { buildHireAgentContext } from '@/lib/hire/agent/context';
import { HIRE_FOCUS_SPEC } from '@/lib/hire/agent/settings';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const A = '11111111-1111-4111-8111-111111111111';

describe('registry', () => {
  it('registers Lekir after Bendahara, with the same keys list', () => {
    expect([...AGENTS.keys()]).toEqual(['weekly-studio', 'crm-focus', 'finance-focus', 'hire-focus', 'people-focus']);
    expect([...AGENT_KEYS]).toEqual([...AGENTS.keys()]);
    expect(agentForProduct('hire', AGENTS)).toBe(hireAgent);
    expect(agentForProduct('finance', AGENTS)).toBe(financeAgent);
  });
});

describe('hireAgent', () => {
  it('is the hire-focus agent with one action and no digest, research or media', () => {
    expect(hireAgent.agentKey).toBe(HIRE_FOCUS);
    expect(HIRE_FOCUS).toBe('hire-focus');
    expect(hireAgent.product).toBe('hire');
    expect(Object.keys(hireAgent.actions)).toEqual(['createAgentNote']);
    expect(hireAgent.digest).toBeUndefined();
    expect(hireAgent.research).toBeUndefined();
    expect(hireAgent.media).toBeUndefined();
    expect(hireAgent.ui).toEqual({
      title: 'AI Agents',
      subtitle: 'Watches your hiring for what you asked',
      screenPath: '/hire/agents',
      assetKinds: [],
    });
  });

  it('builds the write context from the session and asks for the proposal id', () => {
    const client = {} as never;
    expect(hireAgent.buildWriteContext(client, ORG, USER)).toEqual({ client, orgId: ORG, userId: USER });
    expect(hireAgent.writeContextTakesProposal).toBe(true);
  });

  it('expires in 7 days and never re-offers a decided stage', () => {
    expect(hireAgent.proposals.expiresInDays).toBe(7);
    expect(hireAgent.proposals.cooldownDays).toBe(36500);
  });

  it('dedupes on action, check, target and stage', () => {
    const key = hireAgent.proposals.dedupeKey!;
    const input = { target: A, entity_type: 'hire_application', label: 'Aisyah · Events Executive', body: 'x', stage: '1' };
    expect(key('createAgentNote', input, 'application_unscreened')).toBe(`createAgentNote:application_unscreened:${A}:1`);
    expect(key('createAgentNote', { ...input, stage: '2' }, 'application_unscreened')).not.toBe(
      key('createAgentNote', input, 'application_unscreened'),
    );
  });

  it('pick prompt carries the context and the list, and says nothing is moved, rejected or sent', () => {
    const prompt = hireAgent.proposals.pickPrompt('CTX', '0. Aisyah');
    expect(prompt).toContain('CTX');
    expect(prompt).toContain('0. Aisyah');
    expect(prompt).toContain('Choose at most 5');
    expect(prompt).toContain('notes about their hiring');
    expect(prompt).toContain('nothing is moved, rejected or sent');
    expect(prompt).toContain('Hiring snapshot');
  });

  it('shares the settings spec with the hire defaults', () => {
    expect(HIRE_FOCUS_SPEC).toMatchObject({
      agentKey: 'hire-focus',
      maxChars: 500,
      defaults: { max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 },
    });
    expect(HIRE_FOCUS_SPEC.menu).toBe(HIRE_FOCUS_MENU);
  });
});

describe('interpret refuses actions', () => {
  it('a focus asking to reject, move or email yields only "cannot" items and no checks', async () => {
    const complete = async () => ({
      text: JSON.stringify({
        checks: [
          { key: 'reject_candidates', params: {} },
          { key: 'move_stage', params: {} },
        ],
        cannot: ['Reject candidates', 'Move applications', 'Email candidates'],
      }),
      cost_cents: 1,
    });
    const out = await interpretFocus('k', HIRE_FOCUS_MENU, 'Reject everyone old, move the rest, email them', complete);
    expect(out.plan.checks).toEqual([]);
    expect(out.cannot).toEqual(['Reject candidates', 'Move applications', 'Email candidates']);
  });
});

/** Columns service_role is granted for the scan (spec §7.3, migration 20261125190200). */
const GRANTED: Record<string, string[]> = {
  agent_configs: ['focus_plan', 'focus_confirmed_at'],
  hire_applications: ['id', 'org_id', 'candidate_id', 'job_id', 'stage', 'outcome', 'applied_at', 'offered_at', 'hired_at'],
  hire_candidates: ['id', 'org_id', 'name', 'pool_status', 'created_at'],
  hire_interviews: ['id', 'org_id', 'application_id', 'scheduled_at', 'status', 'created_at', 'updated_at', 'feedback_at'],
  hire_jobs: ['id', 'org_id', 'title', 'status', 'opened_at', 'created_at', 'closes_on', 'headcount'],
};

type Query = { table: string; columns: string[]; filters: [string, string, unknown][] };

function fakeService(data: Record<string, unknown>) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, columns: [], filters: [] };
      queries.push(q);
      const result = () => ({ data: data[table] ?? (table === 'agent_configs' ? null : []), error: null });
      const chain: Record<string, unknown> = {
        select(cols: string) {
          q.columns = cols.split(',');
          return chain;
        },
        maybeSingle: async () => result(),
        range: async () => result(),
        then: (res: (v: unknown) => unknown) => res(result()),
      };
      for (const op of ['eq', 'in', 'gt', 'is', 'order', 'lt', 'gte', 'neq']) {
        chain[op] = (c: string, v: unknown) => {
          if (op !== 'order') q.filters.push([op, c, v]);
          return chain;
        };
      }
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

describe('buildHireAgentContext', () => {
  const plan = { checks: [{ key: 'application_unscreened', params: { days: 5 } }] };

  it('reads only granted columns, always scoped to the workspace', async () => {
    const { client, queries } = fakeService({
      agent_configs: { focus_plan: plan, focus_confirmed_at: '2026-10-01T00:00:00Z' },
    });
    await buildHireAgentContext(client, ORG);
    expect(new Set(queries.map((q) => q.table))).toEqual(new Set(Object.keys(GRANTED)));
    for (const q of queries) {
      const allowed = GRANTED[q.table];
      for (const col of [...q.columns, ...q.filters.map((f) => f[1])]) {
        if (q.table !== 'agent_configs' && col !== 'agent_key') expect(allowed, `${q.table}.${col}`).toContain(col);
      }
      expect(q.filters).toContainEqual(['eq', 'org_id', ORG]);
    }
  });

  it('maps rows with names joined in, and the context holds counts and the read-back only', async () => {
    const { client } = fakeService({
      agent_configs: { focus_plan: plan, focus_confirmed_at: '2026-10-01T00:00:00Z' },
      hire_candidates: [{ id: 'c1', name: ' Aisyah ', pool_status: 'available', created_at: '2026-01-01T00:00:00Z' }],
      hire_jobs: [
        { id: 'j1', title: 'Events Executive', status: 'open', opened_at: null, created_at: '2026-09-01T00:00:00Z', closes_on: null, headcount: null },
      ],
      hire_applications: [
        { id: A, candidate_id: 'c1', job_id: 'j1', stage: 'applied', outcome: 'active', applied_at: '2026-10-10T00:00:00Z', offered_at: null, hired_at: null },
      ],
      hire_interviews: [
        { id: 'i1', application_id: A, scheduled_at: '2026-10-20T02:00:00Z', status: 'scheduled', created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z', feedback_at: null },
      ],
    });
    const { raw, context } = await buildHireAgentContext(client, ORG);
    expect(raw.plan).toEqual(plan);
    expect(raw.applications).toEqual([
      {
        id: A,
        candidateId: 'c1',
        jobId: 'j1',
        candidate: 'Aisyah',
        job: 'Events Executive',
        stage: 'applied',
        outcome: 'active',
        appliedAt: '2026-10-10T00:00:00Z',
        offeredAt: null,
        hiredAt: null,
      },
    ]);
    expect(raw.jobs).toEqual([
      { id: 'j1', title: 'Events Executive', status: 'open', openedAt: null, createdAt: '2026-09-01T00:00:00Z', closesOn: null, headcount: null },
    ]);
    expect(raw.candidates).toEqual([{ id: 'c1', name: 'Aisyah', poolStatus: 'available', createdAt: '2026-01-01T00:00:00Z' }]);
    expect(raw.interviews).toHaveLength(1);
    expect(context).toContain('Active applications: 1.');
    expect(context).toContain('Open jobs: 1.');
    expect(context).toContain('- Flag applications still at Applied more than 5 days after applying');
    expect(context).not.toContain('Aisyah');
    expect(context).not.toContain(A);
  });

  it('has no plan until it is confirmed', async () => {
    const { client } = fakeService({ agent_configs: { focus_plan: plan, focus_confirmed_at: null } });
    const { raw, context } = await buildHireAgentContext(client, ORG);
    expect(raw.plan).toBeNull();
    expect(context).not.toContain('What the owner asked');
  });

  it('throws on a read error rather than working from a partial snapshot', async () => {
    const client = {
      from(table: string) {
        const res = table === 'agent_configs' ? { data: null, error: null } : { data: null, error: { code: '42501' } };
        const chain: Record<string, unknown> = {
          maybeSingle: async () => res,
          range: async () => res,
        };
        for (const op of ['select', 'eq', 'in', 'order']) chain[op] = () => chain;
        return chain;
      },
    } as unknown as SupabaseClient;
    await expect(buildHireAgentContext(client, ORG)).rejects.toEqual({ code: '42501' });
  });
});
