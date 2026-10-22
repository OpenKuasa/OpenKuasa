import { describe, expect, test } from 'vitest';
import { isSampleScreen } from '@/config/live-screens';
import { buildCalendar, calendarWindow, parseMonth } from '@/lib/crm/calendar';
import type { CrmDeal } from '@/lib/crm/deals';

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

const NOTHING = { appointments: [], followUps: [], deals: [] };

describe('parseMonth', () => {
  test('takes a YYYY-MM month from the URL', () => {
    expect(parseMonth('2026-11', NOW)).toBe('2026-11');
    expect(parseMonth(['2027-01', '2027-02'], NOW)).toBe('2027-01');
  });

  test('falls back to the current month in Kuala Lumpur', () => {
    expect(parseMonth(undefined, NOW)).toBe('2026-10');
    expect(parseMonth('2026-13', NOW)).toBe('2026-10');
    expect(parseMonth('next', NOW)).toBe('2026-10');
    expect(parseMonth('1026-10', NOW)).toBe('2026-10');
    // 31 Oct, 23:30 UTC is already 1 Nov in Kuala Lumpur.
    expect(parseMonth(undefined, new Date('2026-10-31T23:30:00.000Z'))).toBe('2026-11');
  });
});

describe('calendarWindow', () => {
  test('covers the month shown and the next 30 days from today', () => {
    expect(calendarWindow('2026-10', NOW)).toEqual({ from: '2026-10-01', to: '2026-11-08' });
    expect(calendarWindow('2026-12', NOW)).toEqual({ from: '2026-10-10', to: '2026-12-31' });
    expect(calendarWindow('2026-08', NOW)).toEqual({ from: '2026-08-01', to: '2026-11-08' });
  });
});

describe('buildCalendar', () => {
  test('lays the month out from its first weekday, with today marked', () => {
    const model = buildCalendar(NOTHING, '2026-10', NOW);
    expect(model.title).toBe('October 2026');
    expect(model.prevMonth).toBe('2026-09');
    expect(model.nextMonth).toBe('2026-11');
    // 1 Oct 2026 is a Thursday.
    expect(model.leadingEmpty).toBe(4);
    expect(model.days).toHaveLength(31);
    expect(model.days.filter((d) => d.isToday).map((d) => d.day)).toEqual([10]);
    expect(model.stats).toEqual({ today: 0, next7: 0, inMonth: 0, next30: 0 });
    expect(model.upcoming).toEqual([]);
  });

  test('months roll over the year, and another month has no today', () => {
    const january = buildCalendar(NOTHING, '2027-01', NOW);
    expect(january.title).toBe('January 2027');
    expect(january.prevMonth).toBe('2026-12');
    expect(january.days.some((d) => d.isToday)).toBe(false);
    expect(buildCalendar(NOTHING, '2026-12', NOW).nextMonth).toBe('2027-01');
    expect(buildCalendar(NOTHING, '2028-02', NOW).days).toHaveLength(29);
  });

  test('appointments land on their Kuala Lumpur day, with their time', () => {
    const model = buildCalendar(
      {
        ...NOTHING,
        appointments: [
          // 14 Oct, 23:30 UTC is 15 Oct, 7:30 am in Kuala Lumpur.
          { id: 'a1', contactName: 'Lim Wei', kind: 'Demo', scheduledAt: '2026-10-14T23:30:00.000Z', status: 'scheduled' },
          { id: 'a2', contactName: 'Siti', kind: 'Call', scheduledAt: '2026-10-15T07:00:00.000Z', status: 'cancelled' },
        ],
      },
      '2026-10',
      NOW,
    );
    expect(model.days[13].items).toEqual([]);
    expect(model.days[14].items).toEqual([
      { id: 'a1', kind: 'appointment', day: '2026-10-15', time: '7:30 am', label: 'Lim Wei · Demo' },
    ]);
    expect(model.stats.inMonth).toBe(1);
  });

  test('follow-ups and open deals land on their due and close dates', () => {
    const model = buildCalendar(
      {
        appointments: [
          { id: 'a1', contactName: 'Lim Wei', kind: 'Demo', scheduledAt: '2026-10-12T07:00:00.000Z', status: 'scheduled' },
          { id: 'a0', contactName: 'Aina', kind: 'Call', scheduledAt: '2026-10-12T01:00:00.000Z', status: 'scheduled' },
        ],
        followUps: [
          { id: 'f1', title: 'Send quote', dueDay: '2026-10-12' },
          { id: 'f2', title: 'Someday', dueDay: null },
        ],
        deals: [
          deal({ id: 'd1', title: 'Fitout', expectedClose: '2026-10-12' }),
          deal({ id: 'd2', title: 'Already won', expectedClose: '2026-10-12', status: 'won' }),
          deal({ id: 'd3', title: 'No date' }),
        ],
      },
      '2026-10',
      NOW,
    );
    // Timed entries first, in time order; then the rest by name.
    expect(model.days[11].items.map((item) => [item.kind, item.label, item.time])).toEqual([
      ['appointment', 'Aina · Call', '9:00 am'],
      ['appointment', 'Lim Wei · Demo', '3:00 pm'],
      ['deal', 'Fitout', null],
      ['follow-up', 'Send quote', null],
    ]);
    expect(model.stats.inMonth).toBe(4);
  });

  test('the counts look ahead from today, whichever month is shown', () => {
    const sources = {
      appointments: [
        { id: 'a1', contactName: 'Lim Wei', kind: 'Demo', scheduledAt: '2026-10-10T10:00:00.000Z', status: 'scheduled' },
      ],
      followUps: [
        { id: 'f0', title: 'Overdue', dueDay: '2026-10-08' },
        { id: 'f1', title: 'This week', dueDay: '2026-10-16' },
        { id: 'f2', title: 'Next week', dueDay: '2026-10-17' },
        { id: 'f3', title: 'Next month', dueDay: '2026-11-08' },
        { id: 'f4', title: 'Too far', dueDay: '2026-11-09' },
      ],
      deals: [],
    };
    const october = buildCalendar(sources, '2026-10', NOW);
    expect(october.stats).toEqual({ today: 1, next7: 2, inMonth: 4, next30: 4 });
    const november = buildCalendar(sources, '2026-11', NOW);
    expect(november.stats).toEqual({ today: 1, next7: 2, inMonth: 2, next30: 4 });
  });

  test('upcoming lists the next entries from today, soonest first', () => {
    const model = buildCalendar(
      {
        appointments: [
          { id: 'a1', contactName: 'Lim Wei', kind: 'Demo', scheduledAt: '2026-10-10T10:00:00.000Z', status: 'scheduled' },
        ],
        followUps: [
          { id: 'f0', title: 'Overdue', dueDay: '2026-10-08' },
          ...Array.from({ length: 7 }, (_, i) => ({ id: `f${i + 1}`, title: `Task ${i + 1}`, dueDay: `2026-10-${14 + i}` })),
        ],
        deals: [],
      },
      '2026-10',
      NOW,
    );
    expect(model.upcoming).toHaveLength(6);
    expect(model.upcoming.slice(0, 2).map(({ label, when }) => ({ label, when }))).toEqual([
      { label: 'Lim Wei · Demo', when: 'Today · 6:00 pm' },
      { label: 'Task 1', when: 'Wed 14 Oct' },
    ]);
  });
});

test('the Kasturi and the Lekiu Calendars are both live', () => {
  expect(isSampleScreen('/crm/calendar')).toBe(false);
  expect(isSampleScreen('/people/calendar')).toBe(false);
});
