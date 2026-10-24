import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ role: 'owner' as string, isDemo: false, calls: [] as string[] }));
const NOTE_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: state.role, isDemo: state.isDemo }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
vi.mock('@/lib/agents/focus/settings', () => ({
  START_REFUSED: {},
  saveFocus: async () => {
    state.calls.push('saveFocus');
    return { ok: true, data: null };
  },
  confirmFocus: async () => {
    state.calls.push('confirmFocus');
    return { ok: true, data: null };
  },
  ensureAgentConfig: async () => ({ ok: true, data: null }),
  hasConfirmedFocus: async () => true,
  nextKlSeven: () => new Date(),
}));
vi.mock('@/lib/agents/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/config')>()),
  setAgentCadence: async () => ({ ok: true, data: null }),
  setAgentCap: async () => ({ ok: true, data: null }),
  setAgentEnabled: async () => ({ ok: true, data: null }),
}));
vi.mock('@/lib/reach/schedule-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach/schedule-capabilities')>()),
  setWorkspaceCaps: async () => ({ ok: true, data: null }),
  syncCadenceSchedule: async () => ({ ok: true, data: null }),
}));
vi.mock('@/lib/agents/runner', () => ({ reapStaleRuns: async () => {}, startRefusal: async () => null }));
vi.mock('@/lib/agents/run-agent', () => ({
  runAgent: async (_s: unknown, _o: string, _t: string, agent: { agentKey: string }) => {
    state.calls.push(`runAgent:${agent.agentKey}`);
    return { runId: 'r1' };
  },
}));
vi.mock('@/lib/people/agent/notes', () => ({
  deleteAgentNote: async () => {
    state.calls.push('deleteAgentNote');
    return { ok: true, data: null };
  },
}));

const actions = await import('@/app/(app)/people/agent-actions');

const CALLS = {
  save: () => actions.savePeopleFocusAction('Leave waiting more than 3 days'),
  confirm: () => actions.confirmPeopleFocusAction(),
  cadence: () => actions.setPeopleCadenceAction('daily'),
  caps: () => actions.setPeopleCapsAction({ max_cost_cents: 50, daily_cap_cents: 200, weekly_cap_cents: 500 }),
  run: () => actions.runPeopleAgentNowAction(),
  del: () => actions.deletePeopleAgentNoteAction(NOTE_ID),
};

beforeEach(() => {
  state.role = 'owner';
  state.isDemo = false;
  state.calls = [];
});

describe('the Lekiu agent screen actions', () => {
  it.each(['member', 'viewer'])('refuse a %s every one, before doing anything', async (role) => {
    state.role = role;
    for (const [name, call] of Object.entries(CALLS)) {
      expect(await call(), name).toEqual({ ok: false, error: 'Only HR can change this.' });
    }
    expect(state.calls).toEqual([]);
  });

  it('refuse the demo workspace too', async () => {
    state.isDemo = true;
    for (const call of Object.values(CALLS)) expect((await call()).ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  it.each(['owner', 'admin'])('let an %s use each one, running the people agent', async (role) => {
    state.role = role;
    for (const [name, call] of Object.entries(CALLS)) expect((await call()).ok, name).toBe(true);
    expect(state.calls).toEqual(['saveFocus', 'confirmFocus', 'runAgent:people-focus', 'deleteAgentNote']);
  });

  it('refuse a note id that is not a uuid', async () => {
    expect(await actions.deletePeopleAgentNoteAction('n1')).toEqual({ ok: false, error: 'That input was not valid.' });
  });
});
