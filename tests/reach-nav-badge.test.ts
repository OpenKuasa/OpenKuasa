import { describe, expect, it } from 'vitest';
import { PRODUCTS, getProduct } from '@/config/nav';

describe('AI Agents nav badge', () => {
  it('marks the reach AI Agents item with the pendingProposals badge', () => {
    const reach = getProduct('reach')!;
    const agents = reach.sections.flatMap((s) => s.items).find((i) => i.slug === 'agents');
    expect(agents?.badge).toBe('pendingProposals');
  });

  it('is one of exactly two badged nav items across every product (the other is Lekiu Announcements)', () => {
    const badged = PRODUCTS.flatMap((p) => p.sections.flatMap((s) => s.items)).filter((i) => i.badge);
    expect(badged.map((i) => [i.slug, i.badge]).sort()).toEqual([
      ['agents', 'pendingProposals'],
      ['announcements', 'unreadAnnouncements'],
    ]);
  });
});
