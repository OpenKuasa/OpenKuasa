import { describe, expect, it } from 'vitest';
import { PRODUCTS, getProduct } from '@/config/nav';
import { mergeBadges, type NavBadges } from '@/lib/nav-badges';

const ZERO: NavBadges = {
  pendingProposals: 0,
  pendingCrmProposals: 0,
  pendingFinanceProposals: 0,
  unreadAnnouncements: 0,
  awaitingAcknowledgement: 0,
  waitingLeave: 0,
  waitingTimeOff: 0,
  waitingClaims: 0,
  waitingOvertime: 0,
  waitingSwaps: 0,
  waitingSwapReplies: 0,
};

describe('AI Agents nav badge', () => {
  it('marks the reach AI Agents item with the pendingProposals badge', () => {
    const reach = getProduct('reach')!;
    const agents = reach.sections.flatMap((s) => s.items).find((i) => i.slug === 'agents');
    expect(agents?.badge).toBe('pendingProposals');
  });

  it('marks the Kasturi AI Agents item with its own pendingCrmProposals badge', () => {
    const crm = getProduct('crm')!;
    const agents = crm.sections.flatMap((s) => s.items).find((i) => i.slug === 'agents');
    expect(agents?.badge).toBe('pendingCrmProposals');
  });

  it('is one of exactly eleven badged nav items across every product (the others are Kasturi AI Agents, Bendahara AI Agents, Lekiu Announcements, My Documents, the five approval pages and Shift Calendar)', () => {
    const badged = PRODUCTS.flatMap((p) => p.sections.flatMap((s) => s.items)).filter((i) => i.badge);
    expect(badged.map((i) => [i.slug, i.badge]).sort()).toEqual([
      ['agents', 'pendingCrmProposals'],
      ['agents', 'pendingFinanceProposals'],
      ['agents', 'pendingProposals'],
      ['announcements', 'unreadAnnouncements'],
      ['approve-claims', 'waitingClaims'],
      ['approve-leave', 'waitingLeave'],
      ['approve-overtime', 'waitingOvertime'],
      ['approve-shift-swaps', 'waitingSwaps'],
      ['approve-time-off', 'waitingTimeOff'],
      ['my-documents', 'awaitingAcknowledgement'],
      ['shift-calendar', 'waitingSwapReplies'],
    ]);
  });

  it('still gets the marketing count from the server value, whatever a page sets', () => {
    expect(mergeBadges({ ...ZERO, pendingProposals: 4 }, { unreadAnnouncements: 2 }).pendingProposals).toBe(4);
  });
});
