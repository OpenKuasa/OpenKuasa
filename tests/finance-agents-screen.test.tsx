import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRODUCTS, getProduct } from '@/config/nav';
import { isSampleScreen } from '@/config/live-screens';
import type { AgentProposal } from '@/lib/agents/types';
import type { FinanceAgentNote } from '@/lib/finance/agent/notes';
import {
  buildFinanceAgentsView,
  financeSuggestionView,
  type FinanceAgentConfigRow,
  type FinanceAgentsInput,
} from '@/screens/finance/agents-view';

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
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: state.role, isDemo: state.isDemo }),
  hasSupabaseEnv: () => state.env,
}));
vi.mock('@/app/(app)/finance/agent-actions', () => ({
  saveFinanceFocusAction: vi.fn(),
  confirmFinanceFocusAction: vi.fn(),
  setFinanceCadenceAction: vi.fn(),
  setFinanceCapsAction: vi.fn(),
  runFinanceAgentNowAction: vi.fn(),
  deleteFinanceAgentNoteAction: vi.fn(),
}));
vi.mock('@/app/(app)/agents/actions', () => ({ applyProposalAction: vi.fn(), rejectProposalAction: vi.fn() }));
vi.mock('@/lib/agents/proposals', () => ({
  listPendingProposals: async (_c: unknown, _o: string, product?: string) => {
    state.pendingProducts.push(product);
    return state.pending;
  },
  listRecentlyDecided: async () => [],
}));
vi.mock('@/lib/agents/spend', () => ({ workspaceSpendCents: async () => 12 }));
vi.mock('@/lib/reach/schedule-capabilities', () => ({ listSchedules: async () => [] }));
vi.mock('@/lib/finance/agent/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/agent/notes')>()),
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

const AgentsScreen = (await import('@/screens/finance/agents')).default;

const CONFIRMED: FinanceAgentConfigRow = {
  enabled: false,
  cadence: 'off',
  max_cost_cents: 50,
  daily_cap_cents: 200,
  weekly_cap_cents: 500,
  focus_text: 'Invoices overdue more than 14 days',
  focus_plan: { checks: [{ key: 'invoice_overdue', params: { days: 14 } }] },
  focus_cannot: [],
  focus_confirmed_at: '2026-10-20T00:00:00Z',
};

const PROPOSAL: AgentProposal = {
  id: 'p1',
  org_id: 'org-1',
  run_id: 'r1',
  agent_key: 'finance-focus',
  product: 'finance',
  action: 'createAgentNote',
  input: {
    entityType: 'finance_invoice',
    entityId: 'i1',
    entityLabel: 'INV-0042',
    body: 'Overdue 14 days (as of 09 Oct 2026)',
    target: 'i1',
    stage: '14',
  },
  title: 'INV-0042 to Aisyah Trading',
  detail: null,
  rationale: 'MODEL RATIONALE',
  check_key: 'invoice_overdue',
  status: 'pending',
  result: null,
  created_at: '2026-10-09T00:00:00Z',
  decided_at: null,
  decided_by: null,
  expires_at: '2026-10-16T00:00:00Z',
};

const NOTE: FinanceAgentNote = {
  id: 'n1',
  entityType: 'finance_supplier_bill',
  entityId: 'b1',
  entityLabel: 'BILL-0007',
  body: 'Due in 3 days (as of 09 Oct 2026)',
  approvedBy: 'Aisyah',
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
  state.notes = [NOTE];
  state.pendingProducts = [];
});

describe('the Bendahara Agents screen', () => {
  it('shows the sample without a database and in the demo workspace', async () => {
    state.env = false;
    expect(text(await render())).toContain('Invoice Chaser');
    state.env = true;
    state.isDemo = true;
    expect(text(await render())).toContain('Invoice Chaser');
  });

  it('gives an owner the focus and schedule controls, and lists only finance suggestions', async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain('Waiting for you');
    expect(t).toContain('Why it came up: Flag invoices more than 14 days overdue');
    expect(html).toContain('href="/finance/invoices"');
    expect(t).toContain('Approving adds this note');
    expect(t).toContain('Edit');
    expect(t).toContain('Save limits');
    expect(t).toContain('Run now');
    expect(html).toContain('id="finance-cap-run"');
    expect(t).not.toContain('MODEL RATIONALE');
    expect(state.pendingProducts).toEqual(['finance']);
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
    expect(text(html)).toContain('BILL-0007');
    expect(text(html)).toContain('Ask an owner to review this.');
    // The same buttons are there for a member, so the checks above test something.
    state.role = 'member';
    const member = await render();
    for (const b of ['>Approve<', '>Run now<', '>Delete<']) expect(member).toContain(b);
  });

  it('lists the notes from the agent with who approved, a View link and Delete', async () => {
    const html = await render();
    const t = text(html);
    expect(t).toContain('Notes from the agent');
    expect(t).toContain('BILL-0007');
    expect(t).toContain('Due in 3 days (as of 09 Oct 2026)');
    expect(t).toContain('Approved by Aisyah');
    expect(html).toContain('href="/finance/supplier-bills"');
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
    const t = text(await render());
    expect(t).toContain('Add an OpenRouter key');
  });

  it('shows its own header and a message when the agent cannot be read', async () => {
    state.configError = { code: '42P01' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = text(await render());
    expect(t).toContain('AI Agents');
    expect(t).toContain("Couldn't load your agent");
  });
});

describe('the Bendahara Agents view', () => {
  const base: FinanceAgentsInput = {
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
    expect(buildFinanceAgentsView(base).sections).toEqual(['focus']);
    expect(buildFinanceAgentsView({ ...base, notes: [NOTE] }).sections).toEqual(['focus', 'notes']);
    expect(buildFinanceAgentsView({ ...base, config: CONFIRMED }).sections).toEqual([
      'waiting',
      'focus',
      'schedule',
      'notes',
      'history',
    ]);
  });

  it('uses the Kasturi spend defaults and asks for a schedule once confirmed', () => {
    const v = buildFinanceAgentsView({ ...base, config: CONFIRMED });
    expect(v.settings).toEqual({ cadence: 'off', maxCostCents: 50, dailyCapCents: 200, weeklyCapCents: 500 });
    expect(v.needsSchedule).toBe(true);
    expect(v.focus.state).toBe('confirmed');
  });

  it('shows a suggestion as its screen, the check behind it and the note approving adds', () => {
    const v = financeSuggestionView(PROPOSAL, { checks: [{ key: 'invoice_overdue', params: { days: 14 } }] });
    expect(v.href).toBe('/finance/invoices');
    expect(v.effect).toBe('Approving adds this note: “Overdue 14 days (as of 09 Oct 2026)”');
    expect(v.why).toContain('14');
    expect(financeSuggestionView({ ...PROPOSAL, input: {}, check_key: null })).toEqual({
      href: null,
      effect: 'Approving adds this note.',
      why: null,
    });
  });

  it('links each note to its document screen', () => {
    const v = buildFinanceAgentsView({ ...base, notes: [NOTE, { ...NOTE, id: 'n2', entityType: 'finance_sst_period', entityId: null }] });
    expect(v.notes?.map((n) => n.href)).toEqual(['/finance/supplier-bills', '/finance/sst-report']);
    expect(buildFinanceAgentsView({ ...base, notes: null }).notes).toBeNull();
  });
});

describe('Bendahara AI Agents in the nav', () => {
  it('is live and carries its own finance badge', () => {
    expect(isSampleScreen('/finance/agents')).toBe(false);
    const item = getProduct('finance')!.sections.flatMap((s) => s.items).find((i) => i.slug === 'agents');
    expect(item?.badge).toBe('pendingFinanceProposals');
    const others = PRODUCTS.filter((p) => p.key !== 'finance')
      .flatMap((p) => p.sections.flatMap((s) => s.items))
      .filter((i) => i.badge === 'pendingFinanceProposals');
    expect(others).toHaveLength(0);
  });
});
