import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COUNTS: Record<string, number> = { reach: 1, crm: 2, finance: 3, people: 4 };
const state = vi.hoisted(() => ({ role: 'owner' as string, asked: [] as (string | undefined)[] }));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', userId: 'u1', role: state.role, isDemo: false }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/agents/proposals', () => ({
  countPendingProposals: async (_c: unknown, _o: string, product?: string) => {
    if (product === undefined) throw new Error('an unscoped count would mix products');
    state.asked.push(product);
    return COUNTS[product] ?? 99;
  },
}));
vi.mock('@/lib/people/my-team', () => ({ readMyTeam: async () => [] }));
vi.mock('@/components/app/app-shell', () => ({ AppShell: () => null }));

const AppLayout = (await import('@/app/(app)/layout')).default;

const badgesOf = async () => {
  const tree = (await AppLayout({ children: null })) as ReactElement<{ children: ReactElement<{ badges: Record<string, number> }> }>;
  return tree.props.children.props.badges;
};

beforeEach(() => {
  state.role = 'owner';
  state.asked = [];
});

describe('the Lekiu AI Agents badge', () => {
  it.each(['owner', 'admin'])('counts only people proposals for an %s, leaving the other badges their own', async (role) => {
    state.role = role;
    const badges = await badgesOf();
    expect(badges.pendingPeopleProposals).toBe(4);
    expect(badges.pendingFinanceProposals).toBe(3);
    expect(badges.pendingCrmProposals).toBe(2);
    expect(badges.pendingProposals).toBe(1);
  });

  it.each(['member', 'viewer'])('is 0 for a %s, without counting people proposals at all', async (role) => {
    state.role = role;
    const badges = await badgesOf();
    expect(badges.pendingPeopleProposals).toBe(0);
    expect(state.asked).not.toContain('people');
    expect(badges.pendingFinanceProposals).toBe(3);
  });
});
