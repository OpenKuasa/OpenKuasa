import { describe, expect, it } from 'vitest';
import { PRODUCTS, getProduct } from '@/config/nav';

describe('AI Agents nav badge', () => {
  it('marks the reach AI Agents item with the pendingProposals badge', () => {
    const reach = getProduct('reach')!;
    const agents = reach.sections.flatMap((s) => s.items).find((i) => i.slug === 'agents');
    expect(agents?.badge).toBe('pendingProposals');
  });

  it('is the only badged nav item across every product', () => {
    const badged = PRODUCTS.flatMap((p) => p.sections.flatMap((s) => s.items)).filter((i) => i.badge);
    expect(badged).toHaveLength(1);
    expect(badged[0].slug).toBe('agents');
    expect(badged[0].badge).toBe('pendingProposals');
  });
});
