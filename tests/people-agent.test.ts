import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake model: no network, and the pick prompt is captured. The rest of the module stays real.
vi.mock('@/lib/agents/openrouter-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/openrouter-media')>()),
  suggestProposals: vi.fn(),
}));

import { AGENT_KEYS } from '@/lib/agents/agent-keys';
import { financeAgent } from '@/lib/agents/finance-agent';
import { interpretFocus } from '@/lib/agents/focus/interpret';
import { suggestProposals } from '@/lib/agents/openrouter-media';
import { peopleAgent } from '@/lib/agents/people-agent';
import { proposeChanges } from '@/lib/agents/proposer';
import { AGENTS, agentForProduct } from '@/lib/agents/registry';
import { PEOPLE_FOCUS } from '@/lib/agents/types';
import { PEOPLE_FOCUS_MENU } from '@/lib/people/agent/checks';
import { buildPeopleAgentContext } from '@/lib/people/agent/context';
import { PEOPLE_FOCUS_SPEC } from '@/lib/people/agent/settings';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const RUN = '77777777-7777-4777-8777-777777777777';
const E1 = 'e1111111-1111-4111-8111-111111111111';
const E2 = 'e2222222-2222-4222-8222-222222222222';
const E3 = 'e3333333-3333-4333-8333-333333333333';
const R1 = 'a1111111-1111-4111-8111-111111111111';
const R2 = 'a2222222-2222-4222-8222-222222222222';
const R3 = 'a3333333-3333-4333-8333-333333333333';
const R4 = 'a4444444-4444-4444-8444-444444444444';

// 12:00 on Fri 23 Oct 2026 in Kuala Lumpur.
const NOW = new Date('2026-10-23T04:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('registry', () => {
  it('registers Lekiu after Bendahara, with the same keys list', () => {
    expect([...AGENTS.keys()]).toEqual(['weekly-studio', 'crm-focus', 'finance-focus', 'hire-focus', 'people-focus']);
    expect([...AGENT_KEYS]).toEqual([...AGENTS.keys()]);
    expect(PEOPLE_FOCUS).toBe('people-focus');
    expect(agentForProduct('people', AGENTS)).toBe(peopleAgent);
    expect(agentForProduct('finance', AGENTS)).toBe(financeAgent);
  });
});

describe('peopleAgent', () => {
  it('is the people-focus agent with one action and no digest, research or media', () => {
    expect(peopleAgent.agentKey).toBe(PEOPLE_FOCUS);
    expect(peopleAgent.product).toBe('people');
    expect(Object.keys(peopleAgent.actions)).toEqual(['createAgentNote']);
    expect(peopleAgent.digest).toBeUndefined();
    expect(peopleAgent.research).toBeUndefined();
    expect(peopleAgent.media).toBeUndefined();
    expect(peopleAgent.extraCandidates).toBeUndefined();
    expect(peopleAgent.ui).toEqual({
      title: 'AI Agents',
      subtitle: 'Watches your team records for what you asked',
      screenPath: '/people/agents',
      assetKinds: [],
    });
  });

  it('builds the write context from the session and asks for the proposal id', () => {
    const client = {} as never;
    expect(peopleAgent.buildWriteContext(client, ORG, USER)).toEqual({ client, orgId: ORG, userId: USER });
    expect(peopleAgent.writeContextTakesProposal).toBe(true);
  });

  it('expires in 7 days and never re-offers a decided stage', () => {
    expect(peopleAgent.proposals.expiresInDays).toBe(7);
    expect(peopleAgent.proposals.cooldownDays).toBe(36500);
  });

  it('dedupes on action, check, target and stage', () => {
    const key = peopleAgent.proposals.dedupeKey!;
    const input = { entityType: 'hr_leave_request', entityId: R1, employeeId: E1, entityLabel: 'A', body: 'x', target: R1, stage: '3' };
    expect(key('createAgentNote', input, 'leave_waiting')).toBe(`createAgentNote:leave_waiting:${R1}:3`);
    expect(key('createAgentNote', { ...input, stage: '6' }, 'leave_waiting')).not.toBe(key('createAgentNote', input, 'leave_waiting'));
    expect(key('createAgentNote', { target: 'payroll:2026-10', stage: '2026-10' }, 'payroll_unpaid')).toBe(
      'createAgentNote:payroll_unpaid:payroll:2026-10:2026-10',
    );
  });

  it('pick prompt carries the context and the list, is about HR follow-ups, and only leaves a private note', () => {
    const prompt = peopleAgent.proposals.pickPrompt('CTX', '0. Leave waiting · 6 days');
    expect(prompt).toContain('CTX');
    expect(prompt).toContain('0. Leave waiting · 6 days');
    expect(prompt).toContain('Choose at most 5');
    expect(prompt).toContain('each candidate only leaves a private note for HR');
    expect(prompt).toMatch(/HR/);
  });

  it('shares the settings spec with Lekiu defaults', () => {
    expect(PEOPLE_FOCUS_SPEC).toMatchObject({
      agentKey: 'people-focus',
      maxChars: 500,
      defaults: { max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 },
    });
    expect(PEOPLE_FOCUS_SPEC.menu).toBe(PEOPLE_FOCUS_MENU);
  });
});

describe('interpret refuses actions', () => {
  it('a focus asking to approve, pay or message yields only "cannot" items and no checks', async () => {
    const complete = async () => ({
      text: JSON.stringify({
        checks: [
          { key: 'approve_leave', params: {} },
          { key: 'run_payroll', params: {} },
        ],
        cannot: ['Approve leave', 'Run payroll', 'Message staff'],
      }),
      cost_cents: 1,
    });
    const out = await interpretFocus('k', PEOPLE_FOCUS_MENU, 'Approve all leave, run payroll and message staff', complete);
    expect(out.plan.checks).toEqual([]);
    expect(out.cannot).toEqual(['Approve leave', 'Run payroll', 'Message staff']);
  });
});

/** Columns service_role is granted for the scan (20261125200200_people_agent_service_reads.sql). */
const GRANTED: Record<string, string[]> = {
  hr_employees: ['id', 'org_id', 'name', 'status'],
  hr_documents: ['id', 'org_id', 'employee_id', 'doc_type', 'expires_on'],
  hr_goals: ['id', 'org_id', 'employee_id', 'title', 'progress', 'due_date', 'status'],
  hr_leave_requests: ['id', 'org_id', 'employee_id', 'status', 'created_at', 'start_date', 'end_date'],
  hr_claims: ['id', 'org_id', 'employee_id', 'status', 'created_at', 'claim_date'],
  hr_overtime_records: ['id', 'org_id', 'employee_id', 'status', 'created_at', 'work_date'],
  hr_letters: ['id', 'org_id', 'employee_id', 'status', 'created_at'],
  hr_attendance_days: ['org_id', 'employee_id', 'work_date', 'status'],
  hr_payroll_runs: ['org_id', 'period_month', 'status'],
};

type Query = { table: string; columns: string[]; filters: [string, string, unknown][]; orders: string[] };

/** A service client whose reads answer from `data` by table, recording every column touched. */
function fakeService(data: Record<string, unknown>) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, columns: [], filters: [], orders: [] };
      queries.push(q);
      const result = () => ({ data: data[table] ?? (table === 'agent_configs' ? null : []), error: null });
      const chain: Record<string, unknown> = {
        select(cols: string) {
          q.columns = cols.split(',');
          return chain;
        },
        order(c: string) {
          q.orders.push(c);
          return chain;
        },
        not(c: string, op: string, v: unknown) {
          q.filters.push([`not.${op}`, c, v]);
          return chain;
        },
        maybeSingle: async () => result(),
        range: async () => result(),
        then: (res: (v: unknown) => unknown) => res(result()),
      };
      for (const op of ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'is']) {
        chain[op] = (c: string, v: unknown) => {
          q.filters.push([op, c, v]);
          return chain;
        };
      }
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const ALL_CHECKS = PEOPLE_FOCUS_MENU.checks.map((c) => ({ key: c.key, params: {} }));
const confirmed = (checks: unknown[]) => ({ focus_plan: { checks }, focus_confirmed_at: '2026-10-01T00:00:00Z' });

/** A workspace full of names and titles, with columns the scan must never pass on. */
const FIXTURE = {
  agent_configs: confirmed([...ALL_CHECKS.filter((c) => c.key !== 'payroll_unpaid'), { key: 'payroll_unpaid', params: { day: 20 } }]),
  hr_employees: [
    { id: E1, name: 'Nurul Izzati binti Kamal', status: 'active' },
    { id: E2, name: 'Rajesh Kumar', status: 'inactive' },
    { id: E3, name: 'Wong Siew Lan', status: 'active' },
  ],
  hr_documents: [
    { id: R1, employee_id: E1, doc_type: 'medical', expires_on: '2026-11-01', title: 'Oncology referral letter' },
    { id: R2, employee_id: E3, doc_type: 'identity', expires_on: '2026-10-30', title: 'Passport A12345678' },
  ],
  hr_goals: [{ id: R3, employee_id: E3, title: 'Close the Shopee Mall deal', progress: 40, due_date: '2026-10-14', status: 'at_risk' }],
  hr_leave_requests: [
    { id: R4, employee_id: E1, status: 'pending', created_at: '2026-10-10T00:00:00Z', start_date: '2026-10-24', end_date: '2026-10-25', reason: 'Chemotherapy', leave_type: 'medical' },
  ],
  hr_claims: [{ id: R1, employee_id: E3, status: 'pending', created_at: '2026-10-01T00:00:00Z', claim_date: '2026-09-29', category: 'Dental', amount_cents: 88000 }],
  hr_overtime_records: [{ id: R2, employee_id: E1, status: 'pending', created_at: '2026-10-01T00:00:00Z', work_date: '2026-09-28', hours: 7 }],
  hr_letters: [{ id: R3, employee_id: E3, status: 'draft', created_at: '2026-10-01T00:00:00Z', title: 'Show-cause letter' }],
  hr_attendance_days: [
    { employee_id: E1, work_date: '2026-10-20', status: 'absent' },
    { employee_id: E1, work_date: '2026-10-21', status: 'absent' },
    { employee_id: E1, work_date: '2026-10-22', status: 'absent' },
    { employee_id: E2, work_date: '2026-10-22', status: 'absent' },
  ],
  hr_payroll_runs: [{ period_month: '2026-09-01', status: 'paid' }],
};
const PERSONAL = [
  'Nurul',
  'Izzati',
  'Kamal',
  'Rajesh',
  'Kumar',
  'Wong',
  'Siew Lan',
  'Oncology',
  'Passport',
  'A12345678',
  'Shopee',
  'Chemotherapy',
  'medical',
  'identity',
  'Dental',
  '880',
  'Show-cause',
  '2026-10-',
  '2026-09-',
  '24 Oct',
  '14 Oct',
];

describe('buildPeopleAgentContext', () => {
  it('reads only granted columns of the workspace, and only open records', async () => {
    const { client, queries } = fakeService(FIXTURE);
    await buildPeopleAgentContext(client, ORG);
    const tables = new Set(queries.map((q) => q.table));
    expect(tables).toEqual(new Set(['agent_configs', ...Object.keys(GRANTED)]));
    for (const q of queries) {
      expect(q.filters).toContainEqual(['eq', 'org_id', ORG]);
      if (q.table === 'agent_configs') {
        expect(q.filters).toContainEqual(['eq', 'agent_key', PEOPLE_FOCUS]);
        continue;
      }
      const allowed = GRANTED[q.table];
      for (const col of [...q.columns, ...q.filters.map((f) => f[1]), ...q.orders]) {
        expect(allowed, `${q.table}.${col}`).toContain(col);
      }
    }
    const find = (t: string) => queries.find((q) => q.table === t)!;
    expect(find('hr_leave_requests').filters).toContainEqual(['eq', 'status', 'pending']);
    expect(find('hr_claims').filters).toContainEqual(['eq', 'status', 'pending']);
    expect(find('hr_overtime_records').filters).toContainEqual(['eq', 'status', 'pending']);
    expect(find('hr_letters').filters).toContainEqual(['eq', 'status', 'draft']);
    expect(find('hr_goals').filters).toContainEqual(['in', 'status', ['on_track', 'at_risk']]);
    expect(find('hr_documents').filters).toContainEqual(['not.is', 'expires_on', null]);
    // Long-expired documents are never read: 120 days before 23 Oct 2026 (Malaysia).
    expect(find('hr_documents').filters).toContainEqual(['gte', 'expires_on', '2026-06-25']);
    // A generous window: the pure scan applies the strict 14 days.
    const since = find('hr_attendance_days').filters.find((f) => f[0] === 'gte' && f[1] === 'work_date')![2] as string;
    expect(since <= '2026-10-10').toBe(true);
  });

  it('maps rows, keeps inactive employees marked so the scan can drop them, and drops extra columns', async () => {
    const { client } = fakeService(FIXTURE);
    const { raw } = await buildPeopleAgentContext(client, ORG);
    expect(raw.employees).toEqual([
      { id: E1, name: 'Nurul Izzati binti Kamal', active: true },
      { id: E2, name: 'Rajesh Kumar', active: false },
      { id: E3, name: 'Wong Siew Lan', active: true },
    ]);
    expect(raw.documents[0]).toEqual({ id: R1, employeeId: E1, docType: 'medical', expiresOn: '2026-11-01' });
    expect(raw.leaves[0]).toEqual({ id: R4, employeeId: E1, createdAt: '2026-10-10T00:00:00Z', startDate: '2026-10-24', endDate: '2026-10-25' });
    expect(raw.goals[0]).toEqual({ id: R3, employeeId: E3, title: 'Close the Shopee Mall deal', progress: 40, dueDate: '2026-10-14' });
    expect(raw.attendance).toHaveLength(4);
    expect(raw.payrollRuns).toEqual([{ periodMonth: '2026-09-01', status: 'paid' }]);
    expect(JSON.stringify(raw)).not.toMatch(/Oncology|Chemotherapy|Dental|Show-cause|88000/);
  });

  it('the context is the read-back plus per-check counts: no names, titles or ids', async () => {
    const { client } = fakeService(FIXTURE);
    const { context } = await buildPeopleAgentContext(client, ORG);
    expect(context).toContain('Active employees: 2.');
    expect(context).toContain('- Warn about documents expiring within 30 days, or already expired (2 found)');
    expect(context).toContain('- Flag anyone marked absent 3 working days in a row (1 found)');
    expect(context).toContain("- Warn if the month's payroll isn't marked paid by the 20th (1 found)");
    for (const p of PERSONAL) expect(context).not.toContain(p);
    expect(context).not.toMatch(UUID);
  });

  it('has no plan until it is confirmed', async () => {
    const { client } = fakeService({ ...FIXTURE, agent_configs: { focus_plan: { checks: ALL_CHECKS }, focus_confirmed_at: null } });
    const { raw, context } = await buildPeopleAgentContext(client, ORG);
    expect(raw.plan).toBeNull();
    expect(context).not.toContain('What HR asked');
  });
});

/** The proposer's agent_proposals reads: nothing pending, nothing decided. */
function emptyProposals() {
  const inserts: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'order']) chain[m] = () => chain;
  chain.range = async () => ({ data: [], error: null });
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
  const client = {
    from: () => ({
      ...chain,
      insert: async (row: unknown) => {
        inserts.push(row);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserts };
}

describe('the model sees only check labels and numbers, never a name, title, person-tied date or id', () => {
  it('pick prompt carries no personal data', async () => {
    const prompts: string[] = [];
    vi.mocked(suggestProposals).mockImplementation(async (_key: string, prompt: string) => {
      prompts.push(prompt);
      return { keep: [{ index: 0, rationale: 'Worth a look.' }], cost_cents: 1 };
    });
    const { client: service } = fakeService(FIXTURE);
    const built = await buildPeopleAgentContext(service, ORG);
    const { client: proposals, inserts } = emptyProposals();

    const out = await proposeChanges(proposals, ORG, RUN, 'sk-test', built, 100, 0, peopleAgent);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    // Every check made at least one candidate, and the list reached the model.
    expect(prompt).toContain('Leave waiting · 13 days');
    expect(prompt).toContain('Absent 3 working days in a row');
    expect(prompt).toContain('Payroll Oct 2026 not marked paid');
    for (const p of PERSONAL) expect(prompt, p).not.toContain(p);
    expect(prompt).not.toMatch(UUID);
    // The stored proposal keeps the name for HR, behind HR-only access, but its title is name-free.
    expect(out.proposed).toBe(1);
    const row = inserts[0] as { product: string; title: string; input: { entityLabel: string } };
    expect(row.product).toBe('people');
    for (const p of PERSONAL) expect(row.title).not.toContain(p);
  });
});
