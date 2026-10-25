import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: 'owner', isDemo: false }),
}));
vi.mock('@/app/(app)/reach/actions', () => ({
  cancelScheduleAction: vi.fn(),
  createScheduleAction: vi.fn(),
  pauseScheduleAction: vi.fn(),
  resumeScheduleAction: vi.fn(),
  setWorkspaceCapsAction: vi.fn(),
  updateScheduleAction: vi.fn(),
  setAgentCadenceAction: vi.fn(),
  setAgentCapAction: vi.fn(),
  runAgentNowAction: vi.fn(),
  setAgentEnabledAction: vi.fn(),
}));
vi.mock('@/app/(app)/agents/actions', () => ({ applyProposalAction: vi.fn(), rejectProposalAction: vi.fn() }));
// No saved Weekly Studio settings for this workspace.
vi.mock('@/lib/agents/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/config')>()),
  listAgentConfigs: async () => [],
}));
vi.mock('@/lib/agents/spend', () => ({ workspaceSpendCents: async () => 0 }));
vi.mock('@/lib/reach/schedule-capabilities', () => ({ listSchedules: async () => [] }));
vi.mock('@/lib/agents/proposals', () => ({
  listPendingProposals: async () => [],
  listRecentlyDecided: async () => [],
}));
vi.mock('@/lib/agents/proposal-names', () => ({ proposalNames: async () => ({}) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'order', 'in']) chain[m] = () => chain;
    chain.limit = async () => ({ data: [], error: null });
    return chain;
  },
}));

import AgentsScreen from '@/screens/reach/agents';
import { startRefusal } from '@/lib/agents/runner';

describe('Jebat AI Agents screen with no saved settings', () => {
  it('shows Weekly Studio as Disabled, and the runner agrees it is turned off', async () => {
    const html = renderToStaticMarkup(await AgentsScreen());
    expect(html).toContain('Disabled');
    expect(html).not.toContain('Enabled');
    // The same "no saved settings" the screen read: the start gate refuses as turned off.
    expect(await startRefusal({} as never, 'org-1', 'weekly-studio', null)).toBe('disabled');
  });
});
