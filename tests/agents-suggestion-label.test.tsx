import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProposal } from '@/lib/agents/types';

vi.mock('@/app/(app)/agents/actions', () => ({
  applyProposalAction: vi.fn(),
  rejectProposalAction: vi.fn(),
}));

import { PendingApprovals } from '@/components/agents/pending-approvals';
import { RecentlyDecided } from '@/components/agents/recently-decided';

const P = {
  id: 'p1',
  product: 'people',
  action: 'createAgentNote',
  input: { entityLabel: 'Aisyah Rahman', body: 'A note.' },
  title: 'Leave waiting · 6 days',
  detail: null,
  rationale: null,
  check_key: 'leave_waiting',
  status: 'pending',
  result: null,
} as unknown as AgentProposal;

describe('PendingApprovals label', () => {
  it('shows the label in place of the title when a view sets one, linked or not', () => {
    for (const href of ['/people/approve-leave', null]) {
      const html = renderToStaticMarkup(
        <PendingApprovals proposals={[P]} canEdit views={{ p1: { href, label: 'Aisyah Rahman', effect: 'Adds a note.', why: null } }} />,
      );
      expect(html).toContain('Aisyah Rahman');
      expect(html).not.toContain('Leave waiting · 6 days');
    }
  });

  it('shows the title as before when the view has no label', () => {
    const html = renderToStaticMarkup(
      <PendingApprovals proposals={[P]} canEdit views={{ p1: { href: '/x', effect: 'Adds a note.', why: null } }} />,
    );
    expect(html).toContain('Leave waiting · 6 days');
    expect(html).toContain('href="/x"');
  });
});

describe('RecentlyDecided labels', () => {
  const decided = [
    { ...P, id: 'a', status: 'approved' },
    { ...P, id: 'b', status: 'rejected', title: 'Claim waiting · 8 days' },
  ] as AgentProposal[];

  it('shows a label by proposal id in place of its title, and the title where none is given', () => {
    const html = renderToStaticMarkup(<RecentlyDecided decided={decided} labels={{ a: 'Nur Iman' }} />);
    const items = html.split('<li').slice(1);
    expect(items[0]).toContain('Nur Iman');
    expect(items[0]).not.toContain('Leave waiting');
    expect(items[1]).toContain('Claim waiting · 8 days');
  });

  it('shows titles as before without labels', () => {
    const html = renderToStaticMarkup(<RecentlyDecided decided={decided} />);
    expect(html).toContain('Leave waiting · 6 days');
    expect(html).toContain('Claim waiting · 8 days');
  });
});
