import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => '/crm/deals',
  useSearchParams: () => new URLSearchParams(),
}));

const { default: DealsScreen } = await import('@/screens/crm/deals');
const { SAMPLE_DEALS, SAMPLE_PIPELINE } = await import('@/screens/crm/deal-sample');

const action = async () => undefined;
const actions = {
  notes: async () => null,
  save: action,
  move: action,
  markLost: action,
  reopen: action,
  remove: action,
  createPipeline: action,
  renamePipeline: action,
  makeDefaultPipeline: action,
  removePipeline: action,
  addStage: action,
  updateStage: action,
  moveStage: action,
  removeStage: action,
};

function render(openId: string | null) {
  return renderToStaticMarkup(
    createElement(DealsScreen as unknown as (props: Record<string, unknown>) => ReactElement, {
      pipelines: [SAMPLE_PIPELINE],
      deals: SAMPLE_DEALS,
      contacts: [],
      actions,
      openId,
      now: '2026-10-20T00:00:00.000Z',
    }),
  );
}

describe('Deals opened by link', () => {
  it('opens the edit card for a loaded deal', () => {
    expect(render(SAMPLE_DEALS[0].id)).toContain('Edit deal');
  });

  it('opens nothing for an id that is not a loaded deal', () => {
    expect(render('00000000-0000-4000-8000-000000000000')).not.toContain('Edit deal');
  });
});
