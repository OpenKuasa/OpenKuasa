import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/(app)/crm/agent-actions', () => ({
  runCrmAgentNowAction: vi.fn(),
  setCrmCadenceAction: vi.fn(),
  setCrmCapsAction: vi.fn(),
}));

import { AgentSchedule } from '@/components/crm/agent-schedule';

const SETTINGS = { cadence: 'off' as const, maxCostCents: 50, dailyCapCents: 200, weeklyCapCents: 500 };
const HINT = 'Pick daily or weekly so the agent runs on its own, or press Run now.';

function render(over: Partial<Parameters<typeof AgentSchedule>[0]> = {}) {
  return renderToStaticMarkup(
    <AgentSchedule
      settings={SETTINGS}
      spend={{ todayCents: 12, weekCents: 40 }}
      needsSchedule={false}
      canManage
      canRun
      hasKey
      {...over}
    />,
  );
}

describe('AgentSchedule', () => {
  it('asks the owner to pick a schedule when nothing is scheduled', () => {
    expect(render({ needsSchedule: true })).toContain(HINT);
    expect(render({ needsSchedule: true, canManage: false })).toContain(HINT);
    expect(render()).not.toContain(HINT);
  });

  it('takes limits to the sen', () => {
    const html = render();
    expect(html.match(/step="0.01"/g)).toHaveLength(3);
    expect(html).not.toContain('step="0.5"');
  });

  it('says when spend could not be read instead of showing RM 0.00', () => {
    const html = render({ spend: { todayCents: null, weekCents: 40 } });
    expect(html).toContain('Couldn’t read spend');
    expect(html).toContain('RM 0.40 of RM 5.00');
    expect(html).not.toContain('RM 0.00');
    expect(render()).not.toContain('Couldn’t read spend');
  });
});
