import { describe, expect, test } from 'vitest';
import {
  buildPeopleCalendar,
  calendarSubtitle,
  loadPeopleCalendar,
  parsePeopleMonth,
  type PeopleCalendarSources,
} from '@/lib/people/calendar';
import { createSeedPeopleData } from '@/lib/people/seed';
import type {
  Employee,
  LeaveRequest,
  PeopleViewer,
  PublicHoliday,
  TimeOffRequest,
  Training,
  TrainingEnrolment,
} from '@/lib/people/types';

/** Saturday 10 Oct 2026, 16:30 in Kuala Lumpur. */
const NOW = new Date('2026-10-10T08:30:00.000Z');

const HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const DEMO: PeopleViewer = { employeeId: 'e-aina', isHr: false, isDemo: true };
const MANAGER: PeopleViewer = { employeeId: 'e-aina', isHr: false, isDemo: false, managesTeam: true };
const MEMBER: PeopleViewer = { employeeId: 'e-aina', isHr: false, isDemo: false };

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e-aina',
    user_id: null,
    employee_no: 'EMP-001',
    name: 'Aina',
    work_email: null,
    department_id: null,
    department_name: null,
    designation: null,
    employment_type: 'full_time',
    reports_to: null,
    join_date: null,
    status: 'active',
    date_of_birth_day: null,
    date_of_birth_month: null,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

let nextId = 0;
function leave(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  nextId += 1;
  return {
    id: `leave-${nextId}`,
    employee_id: 'e-aina',
    employee_name: 'Aina',
    leave_type: 'annual',
    start_date: '2026-10-12',
    end_date: '2026-10-12',
    days: 1,
    half_day: false,
    reason: null,
    status: 'approved',
    decision_note: null,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function timeOff(overrides: Partial<TimeOffRequest> = {}): TimeOffRequest {
  nextId += 1;
  return {
    id: `off-${nextId}`,
    employee_id: 'e-aina',
    employee_name: 'Aina',
    off_date: '2026-10-14',
    start_time: '14:00:00',
    end_time: '16:00:00',
    reason: null,
    status: 'approved',
    decision_note: null,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function holiday(overrides: Partial<PublicHoliday> = {}): PublicHoliday {
  nextId += 1;
  return { id: `hol-${nextId}`, name: 'Deepavali', holiday_date: '2026-11-08', scope: 'national', state: null, ...overrides };
}

function training(overrides: Partial<Training> = {}): Training {
  nextId += 1;
  return { id: `tr-${nextId}`, title: 'First aid', category: null, provider: null, starts_on: '2026-10-20', ends_on: '2026-10-21', ...overrides };
}

function enrolment(overrides: Partial<TrainingEnrolment> = {}): TrainingEnrolment {
  nextId += 1;
  return { id: `en-${nextId}`, employee_id: 'e-aina', training_id: 'tr-x', completed: false, completed_at: null, ...overrides };
}

const NOTHING: PeopleCalendarSources = {
  employees: [],
  leave: [],
  timeOff: [],
  holidays: [],
  trainings: [],
  enrolments: [],
  workWeek: null,
};

const labelsOn = (model: ReturnType<typeof buildPeopleCalendar>, iso: string) =>
  model.days.find((d) => d.iso === iso)!.items.map((i) => i.label);

describe('parsePeopleMonth', () => {
  test('takes a YYYY-MM month, else this month in Malaysia', () => {
    expect(parsePeopleMonth('2026-11', NOW)).toBe('2026-11');
    expect(parsePeopleMonth(['2027-01'], NOW)).toBe('2027-01');
    expect(parsePeopleMonth('2026-13', NOW)).toBe('2026-10');
    expect(parsePeopleMonth(undefined, new Date('2026-10-31T23:30:00.000Z'))).toBe('2026-11');
  });
});

describe('buildPeopleCalendar', () => {
  test('lays out the month from a Sunday-first week, with today marked', () => {
    const model = buildPeopleCalendar(NOTHING, HR, '2026-10', NOW);
    expect(model.title).toBe('October 2026');
    expect(model.prevMonth).toBe('2026-09');
    expect(model.nextMonth).toBe('2026-11');
    // 1 Oct 2026 is a Thursday.
    expect(model.leadingEmpty).toBe(4);
    expect(model.days).toHaveLength(31);
    expect(model.days.filter((d) => d.isToday).map((d) => d.iso)).toEqual(['2026-10-10']);
    expect(model.stats).toEqual({ awayToday: 0, away7: 0, holidaysInMonth: 0, next30: 0 });
    expect(model.upcoming).toEqual([]);
  });

  test('puts every kind on the grid', () => {
    const model = buildPeopleCalendar(
      {
        ...NOTHING,
        employees: [employee({ date_of_birth_day: 15, date_of_birth_month: 10, join_date: '2023-10-16' })],
        leave: [leave({ start_date: '2026-10-12' })],
        timeOff: [timeOff()],
        holidays: [holiday({ name: 'Hari Raya', holiday_date: '2026-10-13' })],
        trainings: [training({ id: 'tr-x' })],
        enrolments: [enrolment()],
      },
      HR,
      '2026-10',
      NOW,
    );
    expect(labelsOn(model, '2026-10-12')).toEqual(['Aina · Annual leave']);
    expect(labelsOn(model, '2026-10-13')).toEqual(['Hari Raya']);
    expect(labelsOn(model, '2026-10-14')).toEqual(['Aina · Time-off 14:00–16:00']);
    expect(labelsOn(model, '2026-10-15')).toEqual(['Aina · Birthday']);
    expect(labelsOn(model, '2026-10-16')).toEqual(['Aina · 3-year anniversary']);
    expect(labelsOn(model, '2026-10-20')).toEqual(['First aid']);
    expect(labelsOn(model, '2026-10-21')).toEqual(['First aid']);
    const kinds = model.days.flatMap((d) => d.items.map((i) => i.kind));
    expect(new Set(kinds)).toEqual(new Set(['leave', 'holiday', 'time-off', 'birthday', 'anniversary', 'training']));
  });

  test('spreads leave over each of its days, clipped to the month shown', () => {
    const sources = { ...NOTHING, leave: [leave({ start_date: '2026-10-29', end_date: '2026-11-03', days: 4 })] };
    const october = buildPeopleCalendar(sources, HR, '2026-10', NOW);
    expect(october.days.filter((d) => d.items.length > 0).map((d) => d.iso)).toEqual([
      '2026-10-29', '2026-10-30', '2026-10-31',
    ]);
    const november = buildPeopleCalendar(sources, HR, '2026-11', NOW);
    expect(november.days.filter((d) => d.items.length > 0).map((d) => d.iso)).toEqual([
      '2026-11-01', '2026-11-02', '2026-11-03',
    ]);
    // One entry in the month's list, not one per day.
    expect(november.events).toHaveLength(1);
    expect(november.events[0]).toMatchObject({ from: '2026-10-29', to: '2026-11-03' });
  });

  test('marks a half day', () => {
    const model = buildPeopleCalendar({ ...NOTHING, leave: [leave({ half_day: true, days: 0.5 })] }, HR, '2026-10', NOW);
    expect(labelsOn(model, '2026-10-12')).toEqual(['Aina · Annual leave (half day)']);
  });

  test('shows pending requests as pending, and leaves out rejected and cancelled ones', () => {
    const model = buildPeopleCalendar(
      {
        ...NOTHING,
        leave: [
          leave({ status: 'pending', start_date: '2026-10-10', end_date: '2026-10-10' }),
          leave({ status: 'rejected', start_date: '2026-10-10', end_date: '2026-10-10' }),
          leave({ status: 'cancelled', start_date: '2026-10-10', end_date: '2026-10-10' }),
        ],
        timeOff: [timeOff({ status: 'pending', off_date: '2026-10-10' }), timeOff({ status: 'rejected', off_date: '2026-10-10' })],
      },
      HR,
      '2026-10',
      NOW,
    );
    const today = model.days.find((d) => d.isToday)!.items;
    expect(today).toHaveLength(2);
    expect(today.every((i) => i.pending)).toBe(true);
    // Pending is not away.
    expect(model.stats.awayToday).toBe(0);
    expect(model.stats.next30).toBe(2);
  });

  test('counts the people away today and in the next 7 days, once each', () => {
    const model = buildPeopleCalendar(
      {
        ...NOTHING,
        leave: [
          leave({ start_date: '2026-10-09', end_date: '2026-10-12' }),
          leave({ employee_id: 'e-ben', employee_name: 'Ben', start_date: '2026-10-15', end_date: '2026-10-15' }),
          leave({ employee_id: 'e-cik', employee_name: 'Cik', start_date: '2026-10-17', end_date: '2026-10-17' }),
        ],
        timeOff: [timeOff({ off_date: '2026-10-10' }), timeOff({ employee_id: 'e-dan', employee_name: 'Dan', off_date: '2026-10-16' })],
      },
      HR,
      '2026-10',
      NOW,
    );
    // Aina twice today (leave and time-off) is one person.
    expect(model.stats.awayToday).toBe(1);
    // Today to Fri 16 Oct: Aina, Ben and Dan; Cik is on the 17th.
    expect(model.stats.away7).toBe(3);
  });

  test('counts the public holidays in the month shown', () => {
    const model = buildPeopleCalendar(
      { ...NOTHING, holidays: [holiday({ holiday_date: '2026-10-02' }), holiday({ holiday_date: '2026-10-30' }), holiday({ holiday_date: '2026-11-08' })] },
      HR,
      '2026-10',
      NOW,
    );
    expect(model.stats.holidaysInMonth).toBe(2);
    // 2 Oct is behind today; 30 Oct and 8 Nov are within 30 days.
    expect(model.stats.next30).toBe(2);
  });

  test('shows a state holiday with its state', () => {
    const model = buildPeopleCalendar(
      { ...NOTHING, holidays: [holiday({ name: 'Sultan\'s birthday', holiday_date: '2026-10-12', scope: 'state', state: 'Johor' })] },
      HR,
      '2026-10',
      NOW,
    );
    expect(labelsOn(model, '2026-10-12')).toEqual(['Sultan\'s birthday (Johor)']);
  });

  test('gives HR and the demo every training, and anyone else only the ones they are enrolled in', () => {
    const sources: PeopleCalendarSources = {
      ...NOTHING,
      trainings: [training({ id: 'tr-mine', title: 'Mine' }), training({ id: 'tr-other', title: 'Other' })],
      enrolments: [
        enrolment({ training_id: 'tr-mine' }),
        enrolment({ employee_id: 'e-ben', training_id: 'tr-other' }),
      ],
    };
    const titles = (viewer: PeopleViewer) =>
      buildPeopleCalendar(sources, viewer, '2026-10', NOW).events.map((e) => e.label).sort();
    expect(titles(HR)).toEqual(['Mine', 'Other']);
    expect(titles(DEMO)).toEqual(['Mine', 'Other']);
    expect(titles(MANAGER)).toEqual(['Mine']);
    expect(titles(MEMBER)).toEqual(['Mine']);
    expect(titles({ ...MEMBER, employeeId: null })).toEqual([]);
  });

  test('keeps a member to their own requests, and a manager to what the database gave', () => {
    const sources = {
      ...NOTHING,
      leave: [leave(), leave({ employee_id: 'e-ben', employee_name: 'Ben' })],
      timeOff: [timeOff({ employee_id: 'e-ben', employee_name: 'Ben' })],
    };
    expect(buildPeopleCalendar(sources, MEMBER, '2026-10', NOW).events.map((e) => e.label)).toEqual(['Aina · Annual leave']);
    expect(buildPeopleCalendar(sources, MANAGER, '2026-10', NOW).events).toHaveLength(3);
    expect(buildPeopleCalendar(sources, HR, '2026-10', NOW).events).toHaveLength(3);
  });

  test('links a request to the person\'s own screen, or to the approval screen for someone else\'s', () => {
    const sources = {
      ...NOTHING,
      leave: [leave(), leave({ employee_id: 'e-ben', employee_name: 'Ben', status: 'pending' })],
      timeOff: [timeOff(), timeOff({ employee_id: 'e-ben', employee_name: 'Ben' })],
      holidays: [holiday({ holiday_date: '2026-10-30' })],
      trainings: [training({ id: 'tr-x' })],
      enrolments: [enrolment()],
      employees: [employee({ date_of_birth_day: 25, date_of_birth_month: 10 })],
    };
    const hrefs = Object.fromEntries(
      buildPeopleCalendar(sources, MANAGER, '2026-10', NOW).events.map((e) => [e.label, e.href]),
    );
    expect(hrefs).toEqual({
      'Aina · Annual leave': '/people/leave',
      'Ben · Annual leave': '/people/approve-leave',
      'Aina · Time-off 14:00–16:00': '/people/time-off',
      'Ben · Time-off 14:00–16:00': '/people/approve-time-off',
      Deepavali: '/people/public-holidays',
      'First aid': '/people/training',
      'Aina · Birthday': '/people/employees',
    });
  });

  test('shows a birthday by day and month only, never a year or an age', () => {
    const model = buildPeopleCalendar(
      { ...NOTHING, employees: [employee({ date_of_birth_day: 15, date_of_birth_month: 10 })] },
      HR,
      '2026-10',
      NOW,
    );
    expect(labelsOn(model, '2026-10-15')).toEqual(['Aina · Birthday']);
    expect(JSON.stringify(model)).not.toMatch(/\bage\b|19\d\d/i);
  });

  test('puts a 29 February birthday on the 28th in a year without one', () => {
    const sources = { ...NOTHING, employees: [employee({ date_of_birth_day: 29, date_of_birth_month: 2 })] };
    expect(labelsOn(buildPeopleCalendar(sources, HR, '2027-02', NOW), '2027-02-28')).toEqual(['Aina · Birthday']);
    expect(labelsOn(buildPeopleCalendar(sources, HR, '2028-02', NOW), '2028-02-29')).toEqual(['Aina · Birthday']);
  });

  test('marks anniversaries from one whole year, not the year someone joined', () => {
    const sources = {
      ...NOTHING,
      employees: [
        employee({ id: 'e-new', name: 'New', join_date: '2026-10-20' }),
        employee({ id: 'e-one', name: 'One', join_date: '2025-10-21' }),
      ],
    };
    const model = buildPeopleCalendar(sources, HR, '2026-10', NOW);
    expect(model.events.map((e) => e.label)).toEqual(['One · 1-year anniversary']);
    expect(buildPeopleCalendar(sources, HR, '2027-10', NOW).events.map((e) => e.label).sort()).toEqual([
      'New · 1-year anniversary',
      'One · 2-year anniversary',
    ]);
  });

  test('leaves out the birthdays and anniversaries of inactive staff', () => {
    const model = buildPeopleCalendar(
      {
        ...NOTHING,
        employees: [employee({ status: 'inactive', date_of_birth_day: 15, date_of_birth_month: 10, join_date: '2020-10-16' })],
      },
      HR,
      '2026-10',
      NOW,
    );
    expect(model.events).toEqual([]);
  });

  test('looks ahead past the year end for the upcoming list', () => {
    const december = new Date('2026-12-20T04:00:00Z');
    const model = buildPeopleCalendar(
      { ...NOTHING, employees: [employee({ date_of_birth_day: 3, date_of_birth_month: 1 })] },
      HR,
      '2026-12',
      december,
    );
    expect(model.upcoming.map((u) => [u.label, u.when])).toEqual([['Aina · Birthday', 'Sun 3 Jan']]);
    expect(model.stats.next30).toBe(1);
  });

  test('flags the days outside the work week, and none when it is unknown', () => {
    const known = buildPeopleCalendar({ ...NOTHING, workWeek: ['mon', 'tue', 'wed', 'thu', 'fri'] }, HR, '2026-10', NOW);
    const off = known.days.filter((d) => d.nonWorking).map((d) => d.iso);
    expect(off.slice(0, 4)).toEqual(['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11']);
    expect(off).toHaveLength(9);
    const sixDays = buildPeopleCalendar({ ...NOTHING, workWeek: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }, HR, '2026-10', NOW);
    expect(sixDays.days.filter((d) => d.nonWorking)).toHaveLength(4);
    const unknown = buildPeopleCalendar(NOTHING, HR, '2026-10', NOW);
    expect(unknown.days.some((d) => d.nonWorking)).toBe(false);
  });

  test('lists what is coming soonest first, from today, with Today and dates', () => {
    const model = buildPeopleCalendar(
      {
        ...NOTHING,
        employees: [employee({ date_of_birth_day: 14, date_of_birth_month: 10 })],
        leave: [
          leave({ start_date: '2026-10-08', end_date: '2026-10-12' }),
          leave({ employee_id: 'e-ben', employee_name: 'Ben', start_date: '2026-10-01', end_date: '2026-10-02' }),
        ],
        holidays: [holiday({ holiday_date: '2026-11-08' }), holiday({ name: 'Far away', holiday_date: '2026-11-20' })],
        timeOff: [timeOff({ off_date: '2026-10-13', status: 'pending' })],
      },
      HR,
      '2026-10',
      NOW,
    );
    expect(model.upcoming.map((u) => [u.label, u.when, u.pending])).toEqual([
      ['Aina · Annual leave', 'Today – Mon 12 Oct', false],
      ['Aina · Time-off 14:00–16:00', 'Tue 13 Oct', true],
      ['Aina · Birthday', 'Wed 14 Oct', false],
      ['Deepavali', 'Sun 8 Nov', false],
    ]);
    expect(model.stats.next30).toBe(4);
  });

  test('lists at most six upcoming entries', () => {
    const model = buildPeopleCalendar(
      { ...NOTHING, holidays: Array.from({ length: 8 }, (_, i) => holiday({ holiday_date: `2026-10-${11 + i}` })) },
      HR,
      '2026-10',
      NOW,
    );
    expect(model.upcoming).toHaveLength(6);
    expect(model.stats.next30).toBe(8);
  });
});

describe('calendarSubtitle', () => {
  test('says whose dates are shown', () => {
    expect(calendarSubtitle(HR)).toBe('Everyone\'s leave, holidays and milestones');
    expect(calendarSubtitle(DEMO)).toBe('Everyone\'s leave, holidays and milestones');
    expect(calendarSubtitle(MANAGER)).toBe('Your team\'s and the company\'s dates');
    expect(calendarSubtitle(MEMBER)).toBe('Your dates and the company\'s');
  });
});

describe('loadPeopleCalendar', () => {
  test('builds from the sample company, with the work week read once', async () => {
    const data = createSeedPeopleData(NOW);
    let reads = 0;
    const model = await loadPeopleCalendar(data, DEMO, '2026-10', NOW, async () => {
      reads += 1;
      return ['mon', 'tue', 'wed', 'thu', 'fri'];
    });
    expect(reads).toBe(1);
    expect(model.days).toHaveLength(31);
    expect(model.days.find((d) => d.iso === '2026-10-10')!.nonWorking).toBe(true);
    expect(model.events.length).toBeGreaterThan(0);
  });

  test('still shows the calendar when the work week cannot be read', async () => {
    const data = createSeedPeopleData(NOW);
    const model = await loadPeopleCalendar(data, DEMO, '2026-10', NOW, async () => {
      throw new Error('hr_work_week failed: 42501');
    });
    expect(model.days.some((d) => d.nonWorking)).toBe(false);
  });

  test('uses the settings\' work week when no reader is given', async () => {
    const data = createSeedPeopleData(NOW);
    const model = await loadPeopleCalendar(data, DEMO, '2026-10', NOW);
    expect(model.days.find((d) => d.iso === '2026-10-11')!.nonWorking).toBe(true);
  });
});
