import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const COUNTS: Record<string, number> = { reach: 1, crm: 2, finance: 3, hire: 4 };

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: 'owner', isDemo: false }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/agents/proposals', () => ({
  countPendingProposals: async (_c: unknown, _o: string, product?: string) => {
    if (product === undefined) throw new Error('an unscoped count would mix products');
    return COUNTS[product] ?? 0;
  },
}));
vi.mock('@/lib/people/my-team', () => ({ readMyTeam: async () => [] }));
vi.mock('@/components/app/app-shell', () => ({ AppShell: () => null }));

const AppLayout = (await import('@/app/(app)/layout')).default;

type Tree = ReactElement<{ children: ReactElement<{ badges: Record<string, number> }> }>;
const badges = async () => ((await AppLayout({ children: null })) as Tree).props.children.props.badges;

describe('the Lekir AI Agents badge', () => {
  it('counts only hire proposals, and leaves the other products their own counts', async () => {
    const b = await badges();
    expect(b.pendingHireProposals).toBe(4);
    expect(b.pendingFinanceProposals).toBe(3);
    expect(b.pendingCrmProposals).toBe(2);
    expect(b.pendingProposals).toBe(1);
  });

  it('a finance proposal does not add to it', async () => {
    COUNTS.finance = 10;
    COUNTS.hire = 0;
    expect((await badges()).pendingHireProposals).toBe(0);
  });
});
