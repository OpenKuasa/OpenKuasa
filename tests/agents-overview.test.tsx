import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentsOverview } from '@/components/agents/agents-overview';
import { NavBadgesProvider, type NavBadges } from '@/components/app/nav-badges-context';

const badges = (people: number, finance: number): NavBadges => ({
  pendingProposals: 0,
  pendingCrmProposals: 0,
  pendingFinanceProposals: finance,
  pendingHireProposals: 0,
  pendingPeopleProposals: people,
  unreadAnnouncements: 0,
  awaitingAcknowledgement: 0,
  waitingLeave: 0,
  waitingTimeOff: 0,
  waitingClaims: 0,
  waitingOvertime: 0,
  waitingSwaps: 0,
  waitingSwapReplies: 0,
});

const render = (b: NavBadges, badge: 'pendingPeopleProposals' | 'pendingFinanceProposals', href: string) =>
  renderToStaticMarkup(
    <NavBadgesProvider badges={b}>
      <AgentsOverview badge={badge} href={href} />
    </NavBadgesProvider>,
  );

describe('AgentsOverview', () => {
  it("shows the product's own waiting count and links to its agents screen", () => {
    const html = render(badges(3, 7), 'pendingPeopleProposals', '/people/agents');
    expect(html).toContain('>3<');
    expect(html).toContain('suggestions waiting for you');
    expect(html).toContain('href="/people/agents"');
    expect(html).not.toContain('>7<');
  });

  it('says suggestion for one', () => {
    const html = render(badges(0, 1), 'pendingFinanceProposals', '/finance/agents');
    expect(html).toContain('suggestion waiting for you');
    expect(html).not.toContain('suggestions waiting');
  });
});
