import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRODUCTS, getProduct } from '@/config/nav';
import { isSampleScreen } from '@/config/live-screens';
import type { AgentProposal } from '@/lib/agents/types';
import { HIRE_STARTER_EXAMPLES } from '@/lib/hire/agent/checks';
import type { HireAgentNote } from '@/lib/hire/agent/notes';
import {
  buildHireAgentsView,
  hireNoteLink,
  hireSuggestionView,
  type HireAgentConfigRow,
  type HireAgentsInput,
} from '@/screens/hire/agents-view';

const state = vi.hoisted(() => ({
  env: true,
  role: 'owner' as string,
  isDemo: false,
  config: null as unknown,
  configError: null as unknown,
  keyRows: [{ provider: 'openrouter' }] as unknown,
  pending: [] as unknown[],
  notes: [] as unknown,
  pendingProducts: [] as (string | undefined)[],
  decidedProducts: [] as (string | undefined)[],
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: state.role, isDemo: state.isDemo }),
  hasSupabaseEnv: () => state.env,
}));
vi.mock('@/app/(app)/hire/agent-actions', () => ({
  saveHireFocusAction: vi.fn(),
  confirmHireFocusAction: vi.fn(),
  setHireCadenceAction: vi.fn(),
  setHireCapsAction: vi.fn(),
  runHireAgentNowAction: vi.fn(),
  deleteHireAgentNoteAction: vi.fn(),
}));
vi.mock('@/app/(app)/agents/actions', () => ({ applyProposalAction: vi.fn(), rejectProposalAction: vi.fn() }));
vi.mock('@/lib/agents/proposals', () => ({
  listPendingProposals: async (_c: unknown, _o: string, product?: string) => {
    state.pendingProducts.push(product);
    return state.pending;
  },
  listRecentlyDecided: async (_c: unknown, _o: string, _limit?: number, product?: string) => {
    state.decidedProducts.push(product);
    return [];
  },
}));
vi.mock('@/lib/agents/spend', () => ({ workspaceSpendCents: async () => 12 }));
vi.mock('@/lib/reach/schedule-capabilities', () => ({ listSchedules: async () => [] }));
vi.mock('@/lib/hire/agent/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/agent/notes')>()),
  listAgentNotes: async () => state.notes,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
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

const AgentsScreen = (await import('@/screens/hire/agents')).default;

const CONFIRMED: HireAgentConfigRow = {
  enabled: false,
  cadence: 'off',
  max_cost_cents: 50,
  daily_cap_cents: 200,
  weekly_cap_cents: 500,
  focus_text: 'Anyone waiting more than 5 days to be screened',
  focus_plan: { checks: [{ key: 'application_unscreened', params: { days: 5 } }] },
  focus_cannot: [],
  focus_confirmed_at: '2026-10-20T00:00:00Z',
};

// The stored input as the scan writes it: snake_case, names, stage and dates only.
const PROPOSAL: AgentProposal = {
  id: 'p1',
  org_id: 'org-1',
  run_id: 'r1',
  agent_key: 'hire-focus',
  product: 'hire',
  action: 'createAgentNote',
  input: {
    target: '11111111-1111-4111-8111-111111111111',
    entity_type: 'hire_application',
    label: 'Aina Rahman · Sales Executive',
    body: 'Aina Rahman · Sales Executive has been at Applied for 6 days (as of 20 Oct 2026).',
    stage: '5',
  },
  title: 'Aina Rahman · Sales Executive — at Applied for 6 days',
  detail: null,
  rationale: 'MODEL RATIONALE',
  check_key: 'application_unscreened',
  status: 'pending',
  result: null,
  created_at: '2026-10-20T00:00:00Z',
  decided_at: null,
  decided_by: null,
  expires_at: '2026-10-27T00:00:00Z',
};

const NOTE: HireAgentNote = {
  id: 'n1',
  entityType: 'hire_application',
  entityId: '11111111-1111-4111-8111-111111111111',
  entityLabel: 'Aina Rahman · Sales Executive',
  body: 'Aina Rahman · Sales Executive has been at Applied for 6 days (as of 20 Oct 2026).',
  approvedBy: 'Farah',
  createdAt: '2026-10-20T02:00:00Z',
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const render = async () => renderToStaticMarkup(await AgentsScreen());

beforeEach(() => {
  state.env = true;
  state.role = 'owner';
  state.isDemo = false;
  state.config = CONFIRMED;
  state.configError = null;
  state.keyRows = [{ provider: 'openrouter' }];
  state.pending = [PROPOSAL];
  state.notes = [NOTE];
  state.pendingProducts = [];
  state.decidedProducts = [];
});

describe('the Lekir Agents screen', () => {
  it('shows the sample without a database and in the demo workspace', async () => {
    state.env = false;
    expect(text(await render())).toContain('Screening Assistant');
    state.env = true;
    state.isDemo = true;
    expect(text(await render())).toContain('Screening Assistant');
  });

  it('with no focus yet offers the focus box with the four starter examples', async () => {
    state.config = null;
    state.notes = [];
    const t = text(await render());
    expect(t).toContain('What should the agent watch for?');
    expect(HIRE_STARTER_EXAMPLES).toHaveLength(4);
    for (const s of HIRE_STARTER_EXAMPLES) expect(t).toContain(s);
    expect(t).not.toContain('Waiting for you');
  });

  it('shows a waiting suggestion with its label, why it came up and the note approving adds; only hire ones', async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain('Waiting for you');
    expect(t).toContain('Aina Rahman · Sales Executive');
    expect(t).toContain('Why it came up: Flag applications still at Applied more than 5 days after applying');
    expect(t).toContain('Approving adds this note');
    expect(html).toContain('href="/hire/applications"');
    expect(t).not.toContain('MODEL RATIONALE');
    expect(state.pendingProducts).toEqual(['hire']);
    expect(state.decidedProducts).toEqual(['hire']);
  });

  it('gives an owner the focus and schedule controls', async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain('Edit');
    expect(t).toContain('Save limits');
    expect(t).toContain('Run now');
    expect(html).toContain('id="hire-cap-run"');
  });

  it('shows a member the focus and limits read-only, with Approve, Run now and Delete', async () => {
    state.role = 'member';
    const t = text(await render());
    expect(t).not.toContain('Save limits');
    expect(t).toContain('Only an owner or admin can change these');
    expect(t).toContain('Approve');
    expect(t).toContain('Run now');
    expect(t).toContain('Delete');
  });

  it('gives a viewer no Approve, Run now or Delete', async () => {
    state.role = 'viewer';
    const html = await render();
    expect(html).not.toContain('>Approve<');
    expect(html).not.toContain('>Run now<');
    expect(html).not.toContain('>Delete<');
    expect(text(html)).toContain('Ask an owner to review this.');
    state.role = 'member';
    const member = await render();
    for (const b of ['>Approve<', '>Run now<', '>Delete<']) expect(member).toContain(b);
  });

  it('lists the notes from the agent with who approved, a View link to Applications and Delete', async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain('Notes from the agent');
    expect(t).toContain('Aina Rahman · Sales Executive has been at Applied for 6 days (as of 20 Oct 2026).');
    expect(t).toContain('Approved by Farah');
    expect(html).toContain('href="/hire/applications"');
    expect(t).toContain('View');
    expect(t).toContain('Delete');
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

describe('the Lekir Agents view', () => {
  const base: HireAgentsInput = {
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
    expect(buildHireAgentsView(base).sections).toEqual(['focus']);
    expect(buildHireAgentsView({ ...base, notes: [NOTE] }).sections).toEqual(['focus', 'notes']);
    expect(buildHireAgentsView({ ...base, config: CONFIRMED }).sections).toEqual([
      'waiting',
      'focus',
      'schedule',
      'notes',
      'history',
    ]);
  });

  it('uses the Lekir spend defaults and asks for a schedule once confirmed', () => {
    expect(buildHireAgentsView(base).settings).toEqual({ cadence: 'off', maxCostCents: 50, dailyCapCents: 200, weeklyCapCents: 500 });
    const v = buildHireAgentsView({ ...base, config: CONFIRMED });
    expect(v.needsSchedule).toBe(true);
    expect(v.focus.state).toBe('confirmed');
  });

  it('shows a suggestion as its screen, the check behind it and the note approving adds', () => {
    const v = hireSuggestionView(PROPOSAL, { checks: [{ key: 'application_unscreened', params: { days: 5 } }] });
    expect(v.href).toBe('/hire/applications');
    expect(v.effect).toBe(
      'Approving adds this note: “Aina Rahman · Sales Executive has been at Applied for 6 days (as of 20 Oct 2026).”',
    );
    expect(v.why).toBe('Flag applications still at Applied more than 5 days after applying');
    expect(hireSuggestionView({ ...PROPOSAL, input: {}, check_key: null })).toEqual({
      href: null,
      effect: 'Approving adds this note.',
      why: null,
    });
  });

  it('links each note to its screen, passing the name as the Talent Pool search', () => {
    const v = buildHireAgentsView({
      ...base,
      notes: [
        NOTE,
        { ...NOTE, id: 'n2', entityType: 'hire_interview' },
        { ...NOTE, id: 'n3', entityType: 'hire_job', entityLabel: 'Sales Executive' },
        { ...NOTE, id: 'n4', entityType: 'hire_candidate', entityLabel: 'Siti Nur Aisyah' },
      ],
    });
    expect(v.notes?.map((n) => n.href)).toEqual([
      '/hire/applications',
      '/hire/interviews',
      '/hire/jobs',
      '/hire/talent-pool?q=Siti%20Nur%20Aisyah',
    ]);
    expect(buildHireAgentsView({ ...base, notes: null }).notes).toBeNull();
  });

  it('drops the "…" a long name was cut with before searching for it', () => {
    expect(hireNoteLink('hire_candidate', 'Nur Aisyah binti Abdullah…')).toBe('/hire/talent-pool?q=Nur%20Aisyah%20binti%20Abdullah');
    expect(hireNoteLink('hire_candidate', '')).toBe('/hire/talent-pool');
    expect(hireNoteLink('something_else', 'x')).toBeNull();
  });
});

describe('Lekir AI Agents in the nav', () => {
  it('is live, comes right after Overview, and carries its own hire badge', () => {
    expect(isSampleScreen('/hire/agents')).toBe(false);
    const overview = getProduct('hire')!.sections[0].items.map((i) => i.slug);
    expect(overview.slice(0, 2)).toEqual(['assistant', 'agents']);
    const item = getProduct('hire')!.sections.flatMap((s) => s.items).find((i) => i.slug === 'agents');
    expect(item?.badge).toBe('pendingHireProposals');
    const others = PRODUCTS.filter((p) => p.key !== 'hire')
      .flatMap((p) => p.sections.flatMap((s) => s.items))
      .filter((i) => i.badge === 'pendingHireProposals');
    expect(others).toHaveLength(0);
  });
});
