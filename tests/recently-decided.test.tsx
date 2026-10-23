import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecentlyDecided } from '@/components/agents/recently-decided';
import type { AgentProposal } from '@/lib/agents/types';

const row = (id: string, status: AgentProposal['status'], result: unknown = null): AgentProposal =>
  ({ id, title: `Suggestion ${id}`, status, result }) as AgentProposal;

describe('RecentlyDecided', () => {
  it('shows a suggestion that no longer applied as "No longer applies", not "Rejected"', () => {
    const html = renderToStaticMarkup(
      <RecentlyDecided
        decided={[row('a', 'rejected', { error: 'This bill is already paid.', stale: true }), row('b', 'rejected')]}
      />,
    );
    const items = html.split('<li').slice(1);
    expect(items[0]).toContain('No longer applies');
    expect(items[0]).not.toContain('Rejected');
    expect(items[1]).toContain('Rejected');
  });

  it('only a strict true stale flag counts', () => {
    const html = renderToStaticMarkup(
      <RecentlyDecided decided={[row('a', 'rejected', { stale: 'true' }), row('b', 'approved', { stale: true })]} />,
    );
    expect(html).not.toContain('No longer applies');
    expect(html).toContain('Rejected');
    expect(html).toContain('Approved');
  });
});
