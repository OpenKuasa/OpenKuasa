import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CrmDeal } from '@/lib/crm/deals';

/**
 * The lost-deal question on the Deals board, as the server renders it, and the
 * check it runs before sending: the workspace rule "a deal marked lost needs a
 * reason" decides whether the reason may be left out.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { LostDealConfirm } = await import('@/screens/crm/deal-parts');
const { lostReasonProblem } = await import('@/lib/crm/deals');
const { LOST_REASON_REQUIRED_MESSAGE } = await import('@/lib/crm/settings');

const deal: CrmDeal = {
  id: 'd1',
  title: 'Annual plan',
  company: 'Teratak Kopi',
  contactName: 'Faiz Hakim',
  value: 1000,
  owner: 'Aisyah Rahim',
  status: 'open',
  pipelineId: 'p-1',
  stageId: 'lead',
  lastTouch: '—',
  expectedClose: null,
  createdAt: null,
  wonAt: null,
  lostAt: null,
  lostReason: null,
};

const render = (requireReason?: boolean) =>
  renderToStaticMarkup(
    <LostDealConfirm
      deal={deal}
      action={async () => ({ ok: true })}
      onClose={() => {}}
      focusRef={createRef<HTMLElement>()}
      {...(requireReason === undefined ? {} : { requireReason })}
    />,
  );

const reasonInput = (html: string) => html.match(/<input[^>]*name="lostReason"[^>]*>/)?.[0] ?? '';

describe('LostDealConfirm', () => {
  it('says the reason is optional, and does not require it, when the rule is off', () => {
    for (const flag of [false, undefined]) {
      const html = render(flag);
      expect(html).toContain('Reason (optional)');
      expect(reasonInput(html)).not.toMatch(/\brequired\b/);
    }
  });

  it('asks for the reason, and requires it, when the rule is on', () => {
    const html = render(true);
    expect(html).not.toContain('(optional)');
    expect(html).toMatch(/>Reason</);
    expect(reasonInput(html)).toMatch(/\brequired\b/);
  });
});

describe('lostReasonProblem', () => {
  it('lets any reason, or none, through when the rule is off', () => {
    expect(lostReasonProblem('', false)).toBeNull();
    expect(lostReasonProblem('   ', false)).toBeNull();
    expect(lostReasonProblem('Chose another vendor', false)).toBeNull();
  });

  it('refuses an empty or blank reason when the rule is on', () => {
    expect(lostReasonProblem('', true)).toBe(LOST_REASON_REQUIRED_MESSAGE);
    expect(lostReasonProblem(' \n\t ', true)).toBe(LOST_REASON_REQUIRED_MESSAGE);
    expect(lostReasonProblem('Chose another vendor', true)).toBeNull();
  });
});
