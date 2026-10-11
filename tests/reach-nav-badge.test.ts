import { describe, expect, it } from 'vitest';
import { PRODUCTS, getProduct } from '@/config/nav';
import { mergeBadges } from '@/lib/nav-badges';

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

  it('still gets the marketing count from the server value, whatever a page sets', () => {
    expect(mergeBadges({ pendingProposals: 4, unreadAnnouncements: 0 }, { unreadAnnouncements: 2 }).pendingProposals).toBe(4);
  });
});
