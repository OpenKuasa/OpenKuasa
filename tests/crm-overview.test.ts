import { describe, expect, test } from 'vitest';
import { isSampleScreen } from '@/config/live-screens';
import type { CrmDeal } from '@/lib/crm/deals';
import { buildCrmOverview, recentCrmActivity } from '@/lib/crm/overview';
import type { CrmPipeline } from '@/lib/crm/pipelines';

/** Saturday 10 Oct 2026, 16:30 in Kuala Lumpur. */
const NOW = new Date('2026-10-10T08:30:00.000Z');

let nextId = 0;
function deal(overrides: Partial<CrmDeal> = {}): CrmDeal {
  nextId += 1;
  return {
    id: `deal-${nextId}`,
    title: 'POS rollout',
    company: 'Seri Mutiara Enterprise',
    contactName: 'Aisyah Rahim',
    value: 1000,
    owner: 'Faiz Hakim',
    status: 'open',
    pipelineId: 'p-1',
    stageId: 'lead',
    lastTouch: '—',
    expectedClose: null,
    createdAt: null,
    wonAt: null,
    lostAt: null,
    lostReason: null,
    ...overrides,
  };
}

const stage = (id: string, name: string, position: number) => ({
  id,
  name,
  position,
  probability: 50,
  dot: '',
});
const PIPELINES: CrmPipeline[] = [
  { id: 'p-2', name: 'Renewals', isDefault: false, stages: [stage('r1', 'Due', 0), stage('r2', 'Renewed', 1)] },
  {
    id: 'p-1',
    name: 'Sales pipeline',
    isDefault: true,
    stages: [stage('lead', 'Lead', 0), stage('proposal', 'Proposal', 1), stage('won', 'Won', 2)],
  },
];

describe('buildCrmOverview', () => {
  test('an empty workspace has zeros and nothing to list, not sample figures', () => {
    const model = buildCrmOverview([], PIPELINES, [], NOW);
    expect(model.isEmpty).toBe(true);
    expect(model.kpis).toEqual({ pipelineValue: 0, openDeals: 0, winRate: null, wonThisMonth: 0 });
    expect(model.trend).toHaveLength(8);
    expect(model.trend.every((week) => week.created === 0 && week.won === 0)).toBe(true);
    expect(model.stages.map((s) => s.count)).toEqual([0, 0, 0]);
    expect(model.owners).toEqual([]);
    expect(model.closingSoon).toEqual([]);
    expect(model.followUps).toEqual([]);
  });

  test('headline figures: open value, open count, win rate, and what was won this month', () => {
    const model = buildCrmOverview(
      [
        deal({ value: 1200.5 }),
        deal({ value: 800.25, stageId: 'proposal' }),
        // Won on 1 Oct, 00:30 in Kuala Lumpur: still September in UTC.
        deal({ status: 'won', stageId: 'won', value: 5000, wonAt: '2026-09-30T16:30:00.000Z' }),
        deal({ status: 'won', stageId: 'won', value: 3000, wonAt: '2026-09-12T03:00:00.000Z' }),
        deal({ status: 'lost', value: 700 }),
        deal({ status: 'lost', value: 900 }),
      ],
      PIPELINES,
      [],
      NOW,
    );
    expect(model.isEmpty).toBe(false);
    expect(model.kpis).toEqual({
      pipelineValue: 2000.75,
      openDeals: 2,
      winRate: 50,
      wonThisMonth: 5000,
    });
  });

  test('stage charts cover the default pipeline’s open deals, in board order', () => {
    const model = buildCrmOverview(
      [
        deal({ value: 100 }),
        deal({ value: 250 }),
        deal({ value: 400, stageId: 'proposal' }),
        deal({ value: 999, stageId: 'lead', status: 'lost' }),
        deal({ value: 5000, stageId: 'won', status: 'won' }),
        deal({ value: 70, pipelineId: 'p-2', stageId: 'r1' }),
      ],
      PIPELINES,
      [],
      NOW,
    );
    expect(model.pipelineName).toBe('Sales pipeline');
    expect(model.stages).toEqual([
      { key: 'lead', label: 'Lead', count: 2, value: 350 },
      { key: 'proposal', label: 'Proposal', count: 1, value: 400 },
      { key: 'won', label: 'Won', count: 0, value: 0 },
    ]);
    // The headline figures still count every pipeline.
    expect(model.kpis.openDeals).toBe(4);
  });

  test('owners are ranked by their open deals', () => {
    const model = buildCrmOverview(
      [
        deal({ owner: 'Zaki' }),
        deal({ owner: 'Aisyah' }),
        deal({ owner: 'Aisyah' }),
        deal({ owner: 'Unassigned' }),
        deal({ owner: 'Zaki', status: 'won' }),
      ],
      PIPELINES,
      [],
      NOW,
    );
    expect(model.owners).toEqual([
      { label: 'Aisyah', deals: 2 },
      { label: 'Unassigned', deals: 1 },
      { label: 'Zaki', deals: 1 },
    ]);
  });

  test('closing soon lists open deals due in the next seven days, with their stage', () => {
    const model = buildCrmOverview(
      [
        deal({ title: 'Fitout', company: 'Lim Hardware', expectedClose: '2026-10-12', stageId: 'proposal', value: 15000 }),
        deal({ title: 'Renewal', company: 'Renewal', expectedClose: '2026-10-10', pipelineId: 'p-2', stageId: 'r1' }),
        deal({ title: 'Too late', expectedClose: '2026-10-18' }),
        deal({ title: 'Already won', expectedClose: '2026-10-11', status: 'won' }),
        deal({ title: 'No date' }),
      ],
      PIPELINES,
      [],
      NOW,
    );
    expect(model.closingSoonTotal).toBe(2);
    expect(model.closingSoon.map(({ name, stage, closes, value }) => ({ name, stage, closes, value }))).toEqual([
      { name: 'Renewal', stage: 'Due', closes: '10 Oct', value: 1000 },
      { name: 'Lim Hardware — Fitout', stage: 'Proposal', closes: '12 Oct', value: 15000 },
    ]);
  });

  test('follow-ups say when they are due, and which are overdue', () => {
    const model = buildCrmOverview(
      [],
      PIPELINES,
      [
        { id: 'f1', title: 'Send quote', dueDay: '2026-10-08' },
        { id: 'f2', title: 'Call back', dueDay: '2026-10-10' },
        { id: 'f3', title: 'Check in', dueDay: '2026-10-14' },
        { id: 'f4', title: 'Someday', dueDay: null },
      ],
      NOW,
    );
    expect(model.isEmpty).toBe(false);
    expect(model.followUps).toEqual([
      { id: 'f1', title: 'Send quote', due: '8 Oct', overdue: true },
      { id: 'f2', title: 'Call back', due: 'Today', overdue: false },
      { id: 'f3', title: 'Check in', due: '14 Oct', overdue: false },
      { id: 'f4', title: 'Someday', due: 'No date', overdue: false },
    ]);
  });

  test('a workspace with no default pipeline falls back to its first one', () => {
    const model = buildCrmOverview([], [PIPELINES[0]], [], NOW);
    expect(model.pipelineName).toBe('Renewals');
    expect(buildCrmOverview([], [], [], NOW).pipelineName).toBeNull();
  });
});

test('the Kasturi Overview no longer carries the sample-data banner', () => {
  expect(isSampleScreen('/crm/assistant')).toBe(false);
});

describe('recentCrmActivity', () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

  test('lists deals added, won and lost, contacts added and logged work, newest first, at most five', () => {
    const rows = recentCrmActivity(
      [
        deal({ title: 'Fitout', company: 'Lim Hardware', createdAt: minutesAgo(600) }),
        deal({
          title: 'Branding',
          company: 'Faiz Studio',
          status: 'won',
          value: 15000,
          createdAt: minutesAgo(9000),
          wonAt: minutesAgo(90),
        }),
        deal({ title: 'Event', company: 'Siti Decor', status: 'lost', createdAt: minutesAgo(9500), lostAt: minutesAgo(200) }),
      ],
      [
        { name: 'Aisyah Rahim', source: 'Lead form', createdAt: minutesAgo(8) },
        { name: 'Nurul Huda', source: null, createdAt: minutesAgo(2 * 24 * 60) },
      ],
      [
        { type: 'call', title: 'Quote follow-up', createdAt: minutesAgo(30), completedAt: null },
        { type: 'task', title: 'Send revised quote', createdAt: minutesAgo(9000), completedAt: minutesAgo(3 * 24 * 60) },
      ],
      NOW,
    );
    expect(rows).toEqual([
      { text: 'Aisyah Rahim added via Lead form', when: '8m' },
      { text: 'Call logged: Quote follow-up', when: '30m' },
      { text: 'Won Faiz Studio — Branding · RM 15,000', when: '1h' },
      { text: 'Lost Siti Decor — Event', when: '3h' },
      { text: 'New deal: Lim Hardware — Fitout', when: '10h' },
    ]);
  });

  test('older entries show in days, and follow-ups count when they were done', () => {
    const rows = recentCrmActivity(
      [],
      [{ name: 'Nurul Huda', source: null, createdAt: minutesAgo(2 * 24 * 60) }],
      [
        { type: 'task', title: 'Send revised quote', createdAt: minutesAgo(30), completedAt: minutesAgo(3 * 24 * 60) },
        { type: 'whatsapp', title: 'Sent price list', createdAt: minutesAgo(5 * 24 * 60), completedAt: null },
      ],
      NOW,
    );
    expect(rows).toEqual([
      { text: 'Nurul Huda added', when: '2d' },
      { text: 'Follow-up done: Send revised quote', when: '3d' },
      { text: 'WhatsApp logged: Sent price list', when: '5d' },
    ]);
  });

  test('leaves out notes, open follow-ups, future times and rows with no time', () => {
    const rows = recentCrmActivity(
      [deal({ createdAt: null }), deal({ createdAt: new Date(NOW.getTime() + 60_000).toISOString() })],
      [],
      [
        { type: 'note', title: 'Private thought', createdAt: minutesAgo(5), completedAt: null },
        { type: 'task', title: 'Not done yet', createdAt: minutesAgo(5), completedAt: null },
      ],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  test('names a deal by its title alone when the company is the same', () => {
    const rows = recentCrmActivity(
      [deal({ title: 'Seri Mutiara', company: 'Seri Mutiara', createdAt: minutesAgo(2) })],
      [],
      [],
      NOW,
    );
    expect(rows).toEqual([{ text: 'New deal: Seri Mutiara', when: '2m' }]);
  });

  test('the overview carries the feed, and an empty workspace has none', () => {
    expect(buildCrmOverview([], PIPELINES, [], NOW).activity).toEqual([]);
    const model = buildCrmOverview([], PIPELINES, [], NOW, {
      contacts: [{ name: 'Aisyah Rahim', source: null, createdAt: minutesAgo(8) }],
      activities: [],
    });
    expect(model.activity).toEqual([{ text: 'Aisyah Rahim added', when: '8m' }]);
  });
});
