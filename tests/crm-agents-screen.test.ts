import { describe, expect, it } from 'vitest';
import { buildCrmAgentsView, suggestionView, type CrmAgentConfigRow, type CrmAgentsInput } from '@/screens/crm/agents-view';
import type { AgentProposal } from '@/lib/agents/types';

const DEAL = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';

function config(over: Partial<CrmAgentConfigRow> = {}): CrmAgentConfigRow {
  return {
    enabled: true,
    cadence: 'daily',
    max_cost_cents: 50,
    daily_cap_cents: 200,
    weekly_cap_cents: 500,
    focus_text: 'Chase quiet deals',
    focus_plan: { checks: [{ key: 'deal_quiet', params: { days: 7 } }] },
    focus_cannot: ['Send WhatsApp messages'],
    focus_confirmed_at: '2026-10-23T00:00:00Z',
    ...over,
  };
}

function proposal(over: Partial<AgentProposal> = {}): AgentProposal {
  return {
    id: 'p1',
    org_id: 'org',
    run_id: 'r1',
    agent_key: 'crm-focus',
    product: 'crm',
    action: 'createAgentNote',
    input: { dealId: DEAL, body: 'No activity for 9 days.' },
    title: 'Note on Acme — quiet 9 days',
    detail: null,
    rationale: 'It has gone quiet.',
    check_key: 'deal_quiet',
    status: 'pending',
    result: null,
    created_at: '2026-10-23T00:00:00Z',
    decided_at: null,
    decided_by: null,
    expires_at: '2026-10-30T00:00:00Z',
    ...over,
  };
}

function input(over: Partial<CrmAgentsInput> = {}): CrmAgentsInput {
  return {
    config: config(),
    hasActiveSchedule: true,
    pending: [],
    decided: [],
    runs: [],
    suggestionsByRun: {},
    spentTodayCents: 0,
    spentWeekCents: 0,
    hasKey: true,
    ...over,
  };
}

describe('buildCrmAgentsView', () => {
  it('shows only the focus box when no focus is saved', () => {
    expect(buildCrmAgentsView(input({ config: null })).sections).toEqual(['focus']);
    expect(buildCrmAgentsView(input({ config: config({ focus_text: null }) })).sections).toEqual(['focus']);
    expect(buildCrmAgentsView(input({ config: config({ focus_text: '   ' }) })).focus.state).toBe('none');
  });

  it('shows every section, in order, once a focus is saved', () => {
    expect(buildCrmAgentsView(input()).sections).toEqual(['waiting', 'focus', 'schedule', 'history']);
    expect(
      buildCrmAgentsView(input({ config: config({ focus_confirmed_at: null }) })).sections,
    ).toEqual(['waiting', 'focus', 'schedule', 'history']);
  });

  it('reads the stored plan back through the menu', () => {
    const view = buildCrmAgentsView(input());
    expect(view.focus).toEqual({
      state: 'confirmed',
      text: 'Chase quiet deals',
      readBack: ['Look for open deals with no activity in 7+ days'],
      cannot: ['Send WhatsApp messages'],
    });
    const unconfirmed = buildCrmAgentsView(
      input({ config: config({ focus_confirmed_at: null, focus_plan: { checks: [{ key: 'made_up' }] } }) }),
    );
    expect(unconfirmed.focus.state).toBe('unconfirmed');
    expect(unconfirmed.focus.readBack).toEqual([]);
  });

  it('links a suggestion to its deal or contact pop-up from the stored input', () => {
    const view = buildCrmAgentsView(
      input({
        pending: [
          proposal(),
          proposal({
            id: 'p2',
            action: 'createFollowUp',
            input: { contactId: CONTACT, title: 'Check in with Siti', dueDay: '2026-10-24' },
            title: 'Follow up with Siti — quiet 14 days',
          }),
          proposal({ id: 'p3', input: { dealId: 42 } }),
        ],
      }),
    );
    expect(view.suggestions.p1.href).toBe(`/crm/deals?open=${DEAL}`);
    expect(view.suggestions.p2.href).toBe(`/crm/contacts?open=${CONTACT}`);
    expect(view.suggestions.p3.href).toBeNull();
    expect(view.suggestions.p1.effect).toBe('Leaves this note on the deal: “No activity for 9 days.”');
    expect(view.suggestions.p2.effect).toBe('Adds a follow-up task “Check in with Siti”, due 24 Oct 2026.');
  });

  it('says why from the check that raised it, never the model rationale', () => {
    const view = buildCrmAgentsView(
      input({
        pending: [proposal(), proposal({ id: 'p2', check_key: 'made_up' }), proposal({ id: 'p3', check_key: null })],
      }),
    );
    expect(view.suggestions.p1.why).toBe('Look for open deals with no activity in 7+ days');
    expect(view.suggestions.p2.why).toBeNull();
    expect(view.suggestions.p3.why).toBeNull();
    expect(JSON.stringify(view.suggestions)).not.toContain('It has gone quiet.');
  });

  it('keeps an unreadable spend or key status unknown', () => {
    const view = buildCrmAgentsView(input({ spentTodayCents: null, spentWeekCents: null, hasKey: null }));
    expect(view.spend).toEqual({ todayCents: null, weekCents: null });
    expect(view.hasKey).toBeNull();
  });

  it('encodes a link id rather than trusting it', () => {
    const view = buildCrmAgentsView(input({ pending: [proposal({ input: { dealId: 'a&b=c' } })] }));
    expect(view.suggestions.p1.href).toBe('/crm/deals?open=a%26b%3Dc');
  });

  it('uses Kasturi defaults and shows off when nothing is scheduled', () => {
    expect(buildCrmAgentsView(input({ config: null })).settings).toEqual({
      cadence: 'off',
      maxCostCents: 50,
      dailyCapCents: 200,
      weeklyCapCents: 500,
    });
    expect(buildCrmAgentsView(input({ hasActiveSchedule: false })).settings.cadence).toBe('off');
    expect(buildCrmAgentsView(input({ config: config({ enabled: false }) })).settings.cadence).toBe('off');
    expect(buildCrmAgentsView(input()).settings.cadence).toBe('daily');
  });

  it('asks for a schedule once the focus is confirmed and nothing is scheduled', () => {
    expect(buildCrmAgentsView(input({ hasActiveSchedule: false })).needsSchedule).toBe(true);
    expect(buildCrmAgentsView(input()).needsSchedule).toBe(false);
    expect(
      buildCrmAgentsView(input({ hasActiveSchedule: false, config: config({ focus_confirmed_at: null }) })).needsSchedule,
    ).toBe(false);
    expect(buildCrmAgentsView(input({ hasActiveSchedule: false, config: null })).needsSchedule).toBe(false);
  });

  it('lists recent runs with their suggestion counts', () => {
    const view = buildCrmAgentsView(
      input({
        runs: [
          { id: 'r1', status: 'done', cost_cents: 3, started_at: '2026-10-23T00:00:00Z' },
          { id: 'r2', status: 'failed', cost_cents: 0, started_at: '2026-10-22T00:00:00Z' },
        ],
        suggestionsByRun: { r1: 2 },
      }),
    );
    expect(view.history).toEqual([
      { id: 'r1', status: 'done', costCents: 3, startedAt: '2026-10-23T00:00:00Z', suggestions: 2 },
      { id: 'r2', status: 'failed', costCents: 0, startedAt: '2026-10-22T00:00:00Z', suggestions: 0 },
    ]);
    const noCounts = buildCrmAgentsView(
      input({ runs: [{ id: 'r1', status: 'done', cost_cents: 3, started_at: 'x' }], suggestionsByRun: null }),
    );
    expect(noCounts.history[0].suggestions).toBeNull();
  });

  it('words "why it came up" from the confirmed plan, the default, or nothing', () => {
    const days10 = config({ focus_plan: { checks: [{ key: 'deal_quiet', params: { days: 10 } }] } });
    const withPlan = buildCrmAgentsView(input({ config: days10, pending: [proposal()] }));
    expect(withPlan.suggestions.p1.why).toBe('Look for open deals with no activity in 10+ days');
    const noMatch = buildCrmAgentsView(input({ config: config({ focus_plan: { checks: [] } }), pending: [proposal()] }));
    expect(noMatch.suggestions.p1.why).toBe('Look for open deals with no activity in 7+ days');
    expect(suggestionView(proposal({ check_key: 'nope' })).why).toBeNull();
    expect(suggestionView(proposal({ check_key: null })).why).toBeNull();
  });
});
