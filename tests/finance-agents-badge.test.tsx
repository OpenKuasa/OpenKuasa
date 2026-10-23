import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const COUNTS: Record<string, number> = { reach: 1, crm: 2, finance: 3 };

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: 'owner', isDemo: false }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/agents/proposals', () => ({
  countPendingProposals: async (_c: unknown, _o: string, product?: string) => {
    if (product === undefined) throw new Error('an unscoped count would mix products');
    return COUNTS[product] ?? 99;
  },
}));
vi.mock('@/lib/people/my-team', () => ({ readMyTeam: async () => [] }));
vi.mock('@/components/app/app-shell', () => ({ AppShell: () => null }));

const AppLayout = (await import('@/app/(app)/layout')).default;

describe('the Bendahara AI Agents badge', () => {
  it('counts only finance proposals, and leaves the Jebat and Kasturi counts their own', async () => {
    const tree = (await AppLayout({ children: null })) as ReactElement<{ children: ReactElement<{ badges: Record<string, number> }> }>;
    const badges = tree.props.children.props.badges;
    expect(badges.pendingFinanceProposals).toBe(3);
    expect(badges.pendingCrmProposals).toBe(2);
    expect(badges.pendingProposals).toBe(1);
  });
});
