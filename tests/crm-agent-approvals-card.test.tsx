import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProposal } from '@/lib/agents/types';

vi.mock('@/app/(app)/agents/actions', () => ({
  applyProposalAction: vi.fn(),
  rejectProposalAction: vi.fn(),
}));

import { PendingApprovals } from '@/components/agents/pending-approvals';

const P: AgentProposal = {
  id: 'p1',
  org_id: 'org',
  run_id: 'r1',
  agent_key: 'crm-focus',
  product: 'crm',
  action: 'createAgentNote',
  input: { dealId: 'd1', body: 'Quiet for 9 days.' },
  title: 'Note on Acme',
  detail: null,
  rationale: 'MODEL RATIONALE',
  check_key: 'deal_quiet',
  status: 'pending',
  result: null,
  created_at: '2026-10-23T00:00:00Z',
  decided_at: null,
  decided_by: null,
  expires_at: '2026-10-30T00:00:00Z',
};

describe('PendingApprovals', () => {
  it('on a Kasturi card shows the check, not the model rationale', () => {
    const html = renderToStaticMarkup(
      <PendingApprovals
        proposals={[P]}
        canEdit
        views={{ p1: { href: '/crm/deals?open=d1', effect: 'Leaves a note.', why: 'Open deals with no activity for N days' } }}
      />,
    );
    expect(html).toContain('Why it came up: Open deals with no activity for N days');
    expect(html).not.toContain('MODEL RATIONALE');
  });

  it('shows nothing for why when the check is unknown', () => {
    const html = renderToStaticMarkup(
      <PendingApprovals proposals={[P]} canEdit views={{ p1: { href: null, effect: 'Leaves a note.', why: null } }} />,
    );
    expect(html).not.toContain('Why it came up');
    expect(html).not.toContain('MODEL RATIONALE');
  });

  it('keeps Jebat cards (no views) showing the rationale as before', () => {
    const html = renderToStaticMarkup(
      <PendingApprovals proposals={[{ ...P, product: 'reach', check_key: null }]} canEdit />,
    );
    expect(html).toContain('MODEL RATIONALE');
    expect(html).not.toContain('Why it came up');
  });
});
