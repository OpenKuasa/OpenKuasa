import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRODUCTS, getProduct } from '@/config/nav';
import { isSampleScreen } from '@/config/live-screens';
import type { AgentProposal } from '@/lib/agents/types';
import type { PeopleAgentNote } from '@/lib/people/agent/notes';
import {
  buildPeopleAgentsView,
  peopleSuggestionView,
  type PeopleAgentConfigRow,
  type PeopleAgentsInput,
} from '@/screens/people/agents-view';

const state = vi.hoisted(() => ({
  env: true,
  role: 'owner' as string,
  isDemo: false,
  config: null as unknown,
  configError: null as unknown,
  keyRows: [{ provider: 'openrouter' }] as unknown,
  pending: [] as unknown[],
  decided: [] as unknown[],
  notes: [] as unknown,
  queries: 0,
  pendingProducts: [] as (string | undefined)[],
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: state.role, isDemo: state.isDemo }),
  hasSupabaseEnv: () => state.env,
}));
vi.mock('@/app/(app)/people/agent-actions', () => ({
  savePeopleFocusAction: vi.fn(),
  confirmPeopleFocusAction: vi.fn(),
  setPeopleCadenceAction: vi.fn(),
  setPeopleCapsAction: vi.fn(),
  runPeopleAgentNowAction: vi.fn(),
  deletePeopleAgentNoteAction: vi.fn(),
}));
vi.mock('@/app/(app)/agents/actions', () => ({ applyProposalAction: vi.fn(), rejectProposalAction: vi.fn() }));
vi.mock('@/lib/agents/proposals', () => ({
  listPendingProposals: async (_c: unknown, _o: string, product?: string) => {
    state.queries += 1;
    state.pendingProducts.push(product);
    return state.pending;
  },
  listRecentlyDecided: async () => {
    state.queries += 1;
    return state.decided;
  },
}));
vi.mock('@/lib/agents/spend', () => ({ workspaceSpendCents: async () => 12 }));
vi.mock('@/lib/reach/schedule-capabilities', () => ({ listSchedules: async () => [] }));
vi.mock('@/lib/people/agent/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people/agent/notes')>()),
  listAgentNotes: async () => {
    state.queries += 1;
    return state.notes;
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    state.queries += 1;
    const chain = (result: unknown) => {
      const b: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'in', 'order', 'limit']) b[k] = () => b;
      b.maybeSingle = async () => result;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return b;
    };
    return {
      from: (table: string) =>
        table === 'agent_configs'
          ? chain({ data: state.config, error: state.configError })
          : chain({ data: [], error: null }),
      rpc: async () => ({ data: state.keyRows, error: null }),
    };
  },
}));

const AgentsScreen = (await import('@/screens/people/agents')).default;

const CONFIRMED: PeopleAgentConfigRow = {
  enabled: false,
  cadence: 'off',
  max_cost_cents: 50,
  daily_cap_cents: 200,
  weekly_cap_cents: 500,
  focus_text: 'Leave waiting more than 3 days',
  focus_plan: { checks: [{ key: 'leave_waiting', params: { days: 3 } }] },
  focus_cannot: [],
  focus_confirmed_at: '2026-10-20T00:00:00Z',
};

const PROPOSAL: AgentProposal = {
  id: 'p1',
  org_id: 'org-1',
  run_id: 'r1',
  agent_key: 'people-focus',
  product: 'people',
  action: 'createAgentNote',
  input: {
    entityType: 'hr_leave_request',
    entityId: 'l1',
    employeeId: 'e1',
    entityLabel: 'Aisyah Rahman',
    body: 'Leave has waited 6 days for a decision (as of 09 Oct 2026)',
    target: 'l1',
    stage: '4',
  },
  title: 'Leave waiting · 6 days',
  detail: null,
  rationale: 'MODEL RATIONALE',
  check_key: 'leave_waiting',
  status: 'pending',
  result: null,
  created_at: '2026-10-09T00:00:00Z',
  decided_at: null,
  decided_by: null,
  expires_at: '2026-10-16T00:00:00Z',
};

const NOTE: PeopleAgentNote = {
  id: 'n1',
  entityType: 'hr_claim',
  entityId: 'c1',
  employeeId: 'e2',
  entityLabel: 'Farid Hassan',
  body: 'A claim has waited 8 days for a decision (as of 09 Oct 2026)',
  approvedBy: 'Mei Ling',
  createdAt: '2026-10-09T02:00:00Z',
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ');
const render = async () => renderToStaticMarkup(await AgentsScreen());

beforeEach(() => {
  state.env = true;
  state.role = 'owner';
  state.isDemo = false;
  state.config = CONFIRMED;
  state.configError = null;
  state.keyRows = [{ provider: 'openrouter' }];
  state.pending = [PROPOSAL];
  state.decided = [];
  state.notes = [NOTE];
  state.queries = 0;
  state.pendingProducts = [];
});

describe('the Lekiu Agents screen', () => {
  it('shows the sample without a database and in the demo workspace', async () => {
    state.env = false;
    expect(text(await render())).toContain('Leave Watcher');
    state.env = true;
    state.isDemo = true;
    expect(text(await render())).toContain('Leave Watcher');
  });

  it.each(['owner', 'admin'])('gives %s the focus and schedule controls, with the name as the suggestion label', async (role) => {
    state.role = role;
    const html = await render();
    const t = text(html);
    expect(t).toContain('Waiting for you');
    expect(t).toContain('Aisyah Rahman');
    expect(t).not.toContain('Leave waiting · 6 days');
    expect(t).toContain('Why it came up: Flag leave requests waiting more than 3 days for a decision');
    expect(html).toContain('href="/people/approve-leave"');
    expect(t).toContain('Approving adds this note');
    expect(t).toContain('Save limits');
    expect(t).toContain('Run now');
    expect(t).toContain('Approve');
    expect(html).toContain('id="people-cap-run"');
    // The confirmed focus reads back with Edit.
    expect(t).toContain('Leave waiting more than 3 days');
    expect(t).toContain('Edit');
    expect(t).not.toContain('MODEL RATIONALE');
    expect(state.pendingProducts).toEqual(['people']);
  });

  it.each(['member', 'viewer'])('shows a %s the not-available state, before reading anything', async (role) => {
    state.role = role;
    const t = text(await render());
    expect(t).toContain('This page is for owners and admins of the workspace.');
    expect(t).not.toContain('Aisyah Rahman');
    expect(t).not.toContain('Farid Hassan');
    expect(t).not.toContain('Run now');
    expect(state.queries).toBe(0);
  });

  it('lists the notes from the agent with who approved, a View link and Delete', async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain('Notes from the agent');
    expect(t).toContain('Farid Hassan');
    expect(t).toContain('A claim has waited 8 days for a decision (as of 09 Oct 2026)');
    expect(t).toContain('Approved by Mei Ling');
    expect(html).toContain('href="/people/approve-claims"');
    expect(html).toContain('>View<');
    expect(html).toContain('>Delete<');
  });

  it('shows decided suggestions by the person, not the stored title', async () => {
    state.decided = [{ ...PROPOSAL, id: 'p2', status: 'approved', title: 'Claim waiting · 8 days', input: { entityLabel: 'Nur Iman' } }];
    const t = text(await render());
    expect(t).toContain('Nur Iman');
    expect(t).not.toContain('Claim waiting · 8 days');
  });

  it('says so when there is nothing waiting and when the notes could not be read', async () => {
    state.pending = [];
    state.notes = null;
    const t = text(await render());
    expect(t).toContain('Nothing waiting');
    expect(t).toContain("Couldn't load the notes");
  });

  it('asks for a key when the workspace has none', async () => {
    state.keyRows = [];
    expect(text(await render())).toContain('Add an OpenRouter key');
  });

  it('shows its own header and a message when the agent cannot be read', async () => {
    state.configError = { code: '42P01' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = text(await render());
    expect(t).toContain('AI Agents');
    expect(t).toContain("Couldn't load your agent");
  });
});

describe('the Lekiu Agents view', () => {
  const base: PeopleAgentsInput = {
    config: null,
    hasActiveSchedule: false,
    pending: [],
    decided: [],
    runs: [],
    suggestionsByRun: {},
    spentTodayCents: 0,
    spentWeekCents: 0,
    hasKey: true,
    notes: [],
  };

  it('with no focus shows only the focus box, plus notes left from an earlier focus', () => {
    expect(buildPeopleAgentsView(base).sections).toEqual(['focus']);
    expect(buildPeopleAgentsView({ ...base, notes: [NOTE] }).sections).toEqual(['focus', 'notes']);
    expect(buildPeopleAgentsView({ ...base, config: CONFIRMED }).sections).toEqual([
      'waiting',
      'focus',
      'schedule',
      'notes',
      'history',
    ]);
  });

  it('uses the Lekiu spend defaults and asks for a schedule once confirmed', () => {
    const v = buildPeopleAgentsView({ ...base, config: CONFIRMED });
    expect(v.settings).toEqual({ cadence: 'off', maxCostCents: 50, dailyCapCents: 200, weeklyCapCents: 500 });
    expect(v.needsSchedule).toBe(true);
  });

  it('shows a suggestion as the person, its screen, the check behind it and the note approving adds', () => {
    const v = peopleSuggestionView(PROPOSAL, { checks: [{ key: 'leave_waiting', params: { days: 3 } }] });
    expect(v).toEqual({
      href: '/people/approve-leave',
      label: 'Aisyah Rahman',
      effect: 'Approving adds this note: “Leave has waited 6 days for a decision (as of 09 Oct 2026)”',
      why: 'Flag leave requests waiting more than 3 days for a decision',
    });
    // Always a view, so the model's rationale never shows, even with nothing to go on.
    expect(peopleSuggestionView({ ...PROPOSAL, input: {}, check_key: null })).toEqual({
      href: null,
      effect: 'Approving adds this note.',
      why: null,
    });
  });

  it('links an absence to Attendance and a payroll month to Payroll', () => {
    const absent = { ...PROPOSAL, check_key: 'absent_streak', input: { ...(PROPOSAL.input as object), entityType: 'hr_employee' } };
    expect(peopleSuggestionView(absent).href).toBe('/people/attendance');
    const payroll = { ...PROPOSAL, check_key: 'payroll_unpaid', input: { entityType: 'hr_payroll_month', entityLabel: 'Payroll Oct 2026' } };
    expect(peopleSuggestionView(payroll)).toMatchObject({ href: '/people/payroll', label: 'Payroll Oct 2026' });
  });

  it('labels every pending and decided suggestion by its person', () => {
    const decided = [{ ...PROPOSAL, id: 'p2', status: 'approved' as const, input: { entityLabel: 'Nur Iman' } }, { ...PROPOSAL, id: 'p3', input: {} }];
    const v = buildPeopleAgentsView({ ...base, config: CONFIRMED, pending: [PROPOSAL], decided });
    expect(v.suggestions.p1.label).toBe('Aisyah Rahman');
    expect(v.labels).toEqual({ p2: 'Nur Iman' });
  });

  it('links each note to its screen', () => {
    const v = buildPeopleAgentsView({ ...base, notes: [NOTE, { ...NOTE, id: 'n2', entityType: 'hr_document' }] });
    expect(v.notes?.map((n) => n.href)).toEqual(['/people/approve-claims', '/people/employees']);
    expect(buildPeopleAgentsView({ ...base, notes: null }).notes).toBeNull();
  });
});

describe('Lekiu AI Agents in the nav', () => {
  it('is live, HR-only, after Settings in Configuration, and carries its own people badge', () => {
    expect(isSampleScreen('/people/agents')).toBe(false);
    const config = getProduct('people')!.sections.find((s) => s.label === 'Configuration')!;
    expect(config.items.map((i) => i.slug)).toEqual(['settings', 'agents']);
    const item = config.items[1];
    expect(item).toMatchObject({ label: 'AI Agents', needs: 'approve', badge: 'pendingPeopleProposals' });
    const others = PRODUCTS.filter((p) => p.key !== 'people')
      .flatMap((p) => p.sections.flatMap((s) => s.items))
      .filter((i) => i.badge === 'pendingPeopleProposals');
    expect(others).toHaveLength(0);
  });
});
