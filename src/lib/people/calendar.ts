/**
 * Lekiu's Calendar: leave, time-off, public holidays, trainings, birthdays and
 * work anniversaries on a month grid. Pure apart from the loader, which only
 * reads through `PeopleData`, so the screen and the chat tool build the same model.
 *
 * Which rows come in is the database's decision; this only narrows a member
 * (not a manager, not HR, not the demo) to their own requests, and anyone
 * outside HR and the demo to the trainings they are enrolled in.
 */

import { leaveLabel } from './overview';
import { isTeamView, ownRows } from './own';
import { peopleTier } from './tier';
import { addDays, monthYearLabel, todayInMalaysia, weekdayKey } from './dates';
import type {
  Employee,
  LeaveRequest,
  PeopleData,
  PeopleViewer,
  PublicHoliday,
  TimeOffRequest,
  Training,
  TrainingEnrolment,
  Weekday,
} from './types';

/** How many entries the "Upcoming" list shows. */
export const UPCOMING_LISTED = 6;
/** How far ahead of today the counts and the "Upcoming" list look, in days. */
const LOOK_AHEAD_DAYS = 30;
const MONTH = /^(2\d{3})-(0[1-9]|1[0-2])$/;

export type PeopleCalendarKind = 'leave' | 'time-off' | 'holiday' | 'training' | 'birthday' | 'anniversary';

/** The order kinds sit in within a day. */
const KIND_ORDER: PeopleCalendarKind[] = ['holiday', 'leave', 'time-off', 'training', 'birthday', 'anniversary'];

/** One thing on the calendar, which may span several days. */
export type PeopleCalendarEvent = {
  id: string;
  kind: PeopleCalendarKind;
  /** First and last day, `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
  label: string;
  /** A leave or time-off request still waiting for a decision. */
  pending: boolean;
  /** The employee it is about, for leave, time-off, birthdays and anniversaries. */
  employeeId: string | null;
  /** The screen it links to. */
  href: string;
};

export type PeopleCalendarSources = {
  employees: Employee[];
  leave: LeaveRequest[];
  timeOff: TimeOffRequest[];
  holidays: PublicHoliday[];
  trainings: Training[];
  enrolments: TrainingEnrolment[];
  /** The workspace's work week; null when it could not be read (no day is then shaded). */
  workWeek: Weekday[] | null;
};

export type PeopleCalendarModel = {
  /** `YYYY-MM`. */
  month: string;
  /** 'October 2026'. */
  title: string;
  prevMonth: string;
  nextMonth: string;
  /** Empty cells before the 1st, in a week that starts on Sunday. */
  leadingEmpty: number;
  days: { day: number; iso: string; isToday: boolean; nonWorking: boolean; items: PeopleCalendarEvent[] }[];
  /** Everything that touches the month shown, by first day. */
  events: PeopleCalendarEvent[];
  stats: {
    /** People on approved leave or time-off today. */
    awayToday: number;
    /** People on approved leave or time-off from today to six days on. */
    away7: number;
    holidaysInMonth: number;
    /** Entries of any kind from today to 29 days on. */
    next30: number;
  };
  /** The next entries from today, soonest first. `when` reads 'Today', 'Wed 14 Oct' or 'Today – Mon 12 Oct'. */
  upcoming: (PeopleCalendarEvent & { when: string })[];
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

function shiftMonth(month: string, by: number) {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
}

const lastDayOf = (month: string) => addDays(`${shiftMonth(month, 1)}-01`, -1);
const weekdayIndex = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay();

/** 'Wed 14 Oct'. */
function weekdayAndDay(day: string) {
  return `${WEEKDAY_SHORT[weekdayIndex(day)]} ${Number(day.slice(8))} ${MONTH_SHORT[Number(day.slice(5, 7)) - 1]}`;
}

/** The `?month=` value as `YYYY-MM`; anything else means this month in Malaysia. */
export function parsePeopleMonth(value: string | string[] | undefined, now: Date): string {
  const text = Array.isArray(value) ? value[0] : value;
  return text && MONTH.test(text) ? text : todayInMalaysia(now).slice(0, 7);
}

/** Whose dates the page shows, in words. */
export function calendarSubtitle(viewer: PeopleViewer): string {
  if (isTeamView(viewer)) return 'Everyone\'s leave, holidays and milestones';
  return peopleTier(viewer) === 'manager' ? 'Your team\'s and the company\'s dates' : 'Your dates and the company\'s';
}

/** This month and day in `year`; 29 February falls back to the 28th. */
function onYear(year: number, month: number, day: number) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${two(month)}-${two(Math.min(day, last))}`;
}

/** Birthdays and anniversaries of active staff from `from` to `to`. Never a birth year or an age. */
function occasions(employees: Employee[], from: string, to: string): PeopleCalendarEvent[] {
  const found: PeopleCalendarEvent[] = [];
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));
  for (const e of employees) {
    if (e.status !== 'active') continue;
    for (let year = firstYear; year <= lastYear; year += 1) {
      if (e.date_of_birth_month !== null && e.date_of_birth_day !== null) {
        const day = onYear(year, e.date_of_birth_month, e.date_of_birth_day);
        if (day >= from && day <= to) {
          found.push({
            id: `birthday-${e.id}-${year}`, kind: 'birthday', from: day, to: day, label: `${e.name} · Birthday`,
            pending: false, employeeId: e.id, href: '/people/employees',
          });
        }
      }
      if (e.join_date) {
        const years = year - Number(e.join_date.slice(0, 4));
        const day = onYear(year, Number(e.join_date.slice(5, 7)), Number(e.join_date.slice(8, 10)));
        if (years >= 1 && day >= from && day <= to) {
          found.push({
            id: `anniversary-${e.id}-${year}`, kind: 'anniversary', from: day, to: day,
            label: `${e.name} · ${years}-year anniversary`, pending: false, employeeId: e.id, href: '/people/employees',
          });
        }
      }
    }
  }
  return found;
}

const live = (status: string) => status === 'approved' || status === 'pending';

/** Every event the viewer gets, for the days `from` to `to`. */
function toEvents(sources: PeopleCalendarSources, viewer: PeopleViewer, from: string, to: string): PeopleCalendarEvent[] {
  // A member gets their own requests only; HR, the demo and a manager get what the database returned.
  const narrow = !viewer.isDemo && peopleTier(viewer) === 'self';
  const leave = narrow ? ownRows(sources.leave, viewer) : sources.leave;
  const timeOff = narrow ? ownRows(sources.timeOff, viewer) : sources.timeOff;
  const own = (employeeId: string) => viewer.employeeId !== null && viewer.employeeId === employeeId;
  const overlaps = (start: string, end: string) => start <= to && end >= from;

  const enrolled = new Set(
    sources.enrolments.filter((e) => viewer.employeeId !== null && e.employee_id === viewer.employeeId).map((e) => e.training_id),
  );
  const trainings = isTeamView(viewer) ? sources.trainings : sources.trainings.filter((t) => enrolled.has(t.id));

  const events: PeopleCalendarEvent[] = [];
  for (const r of leave) {
    if (!live(r.status) || !overlaps(r.start_date, r.end_date)) continue;
    events.push({
      id: r.id, kind: 'leave', from: r.start_date, to: r.end_date < r.start_date ? r.start_date : r.end_date,
      label: `${r.employee_name} · ${leaveLabel(r.leave_type)}${r.half_day ? ' (half day)' : ''}`,
      pending: r.status === 'pending', employeeId: r.employee_id,
      href: own(r.employee_id) ? '/people/leave' : '/people/approve-leave',
    });
  }
  for (const r of timeOff) {
    if (!live(r.status) || !overlaps(r.off_date, r.off_date)) continue;
    events.push({
      id: r.id, kind: 'time-off', from: r.off_date, to: r.off_date,
      label: `${r.employee_name} · Time-off ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
      pending: r.status === 'pending', employeeId: r.employee_id,
      href: own(r.employee_id) ? '/people/time-off' : '/people/approve-time-off',
    });
  }
  for (const h of sources.holidays) {
    if (!overlaps(h.holiday_date, h.holiday_date)) continue;
    events.push({
      id: h.id, kind: 'holiday', from: h.holiday_date, to: h.holiday_date,
      label: h.scope === 'state' && h.state ? `${h.name} (${h.state})` : h.name,
      pending: false, employeeId: null, href: '/people/public-holidays',
    });
  }
  for (const t of trainings) {
    if (!t.starts_on) continue;
    const end = t.ends_on && t.ends_on >= t.starts_on ? t.ends_on : t.starts_on;
    if (!overlaps(t.starts_on, end)) continue;
    events.push({
      id: t.id, kind: 'training', from: t.starts_on, to: end, label: t.title,
      pending: false, employeeId: null, href: '/people/training',
    });
  }
  events.push(...occasions(sources.employees, from, to));

  return events.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      Number(a.pending) - Number(b.pending) ||
      a.label.localeCompare(b.label),
  );
}

/** The calendar for one month, for this viewer. */
export function buildPeopleCalendar(
  sources: PeopleCalendarSources,
  viewer: PeopleViewer,
  month: string,
  now: Date,
): PeopleCalendarModel {
  const today = todayInMalaysia(now);
  const first = `${month}-01`;
  const last = lastDayOf(month);
  const ahead = addDays(today, LOOK_AHEAD_DAYS - 1);
  // Dates are `YYYY-MM-DD`, which compares as text.
  const from = first < today ? first : today;
  const to = last > ahead ? last : ahead;
  const events = toEvents(sources, viewer, from, to);
  const between = (start: string, end: string) => events.filter((e) => e.from <= end && e.to >= start);

  const inMonth = between(first, last);
  const work = sources.workWeek ? new Set(sources.workWeek) : null;
  const dayCount = Number(last.slice(8));
  const days = Array.from({ length: dayCount }, (_, i) => {
    const iso = addDays(first, i);
    // Already in day order, kind order within a day.
    const items = inMonth
      .filter((e) => e.from <= iso && e.to >= iso)
      .sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
          Number(a.pending) - Number(b.pending) ||
          a.label.localeCompare(b.label),
      );
    return { day: i + 1, iso, isToday: iso === today, nonWorking: work !== null && !work.has(weekdayKey(iso)), items };
  });

  const awayBetween = (start: string, end: string) =>
    new Set(
      between(start, end)
        .filter((e) => (e.kind === 'leave' || e.kind === 'time-off') && !e.pending)
        .map((e) => e.employeeId),
    ).size;

  const startOf = (e: PeopleCalendarEvent) => (e.from < today ? today : e.from);
  const coming = between(today, ahead).sort(
    (a, b) => startOf(a).localeCompare(startOf(b)) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label),
  );

  return {
    month,
    title: monthYearLabel(first),
    prevMonth: shiftMonth(month, -1),
    nextMonth: shiftMonth(month, 1),
    leadingEmpty: weekdayIndex(first),
    days,
    events: inMonth,
    stats: {
      awayToday: awayBetween(today, today),
      away7: awayBetween(today, addDays(today, 6)),
      holidaysInMonth: inMonth.filter((e) => e.kind === 'holiday').length,
      next30: coming.length,
    },
    upcoming: coming.slice(0, UPCOMING_LISTED).map((e) => {
      const start = startOf(e);
      const word = start === today ? 'Today' : weekdayAndDay(start);
      return { ...e, when: e.to > start ? `${word} – ${weekdayAndDay(e.to)}` : word };
    }),
  };
}

/**
 * Reads what the calendar needs and builds it. `readWorkWeek` is the members' work-week read (a manager or member
 * cannot read the settings); without it the settings' work week is used. A failed work-week read only drops the shading.
 */
export async function loadPeopleCalendar(
  data: PeopleData,
  viewer: PeopleViewer,
  month: string,
  now: Date,
  readWorkWeek?: () => Promise<Weekday[] | null>,
): Promise<PeopleCalendarModel> {
  const week = async (): Promise<Weekday[] | null> => {
    try {
      return readWorkWeek ? await readWorkWeek() : (await data.getSettings()).work_week;
    } catch (error) {
      console.error('[people/calendar] work week:', error instanceof Error ? error.name : 'error');
      return null;
    }
  };
  const [employees, leave, timeOff, holidays, trainings, enrolments, workWeek] = await Promise.all([
    data.listEmployees(),
    data.listLeaveRequests(),
    data.listTimeOffRequests(),
    data.listPublicHolidays(),
    data.listTrainings(),
    data.listTrainingEnrolments(),
    week(),
  ]);
  return buildPeopleCalendar({ employees, leave, timeOff, holidays, trainings, enrolments, workWeek }, viewer, month, now);
}
