/**
 * Pure models for the three company-wide Lekiu screens: the Dashboard, the
 * Announcements and the Public Holidays. Nothing here reads the clock or the
 * database: callers pass rows and a date.
 */

import {
  addDays,
  daysBetween,
  malaysiaDate,
  monthLabel,
  monthStart,
  relativeTime,
  weekStart,
  weekdayName,
} from './dates';
import { type AttendanceCounts, attendanceOn, headcountByDepartment, headcountTrend, leaveDaysByType } from './overview';
import { bucketByMonth, bucketByWeek } from './series';
import { attendanceCounts, payrollSummary } from './summaries';
import type { Announcement, AttendanceDay, Employee, LeaveRequest, PayrollRun, Payslip, PublicHoliday } from './types';

/* ---- Dashboard ---------------------------------------------------- */

export type DashboardInput = {
  employees: Employee[];
  leave: LeaveRequest[];
  attendance: AttendanceDay[];
  runs: PayrollRun[];
  payslips: Payslip[];
};

export type DashboardModel = {
  today: string;
  /** False for a member who is not HR: only the directory figures below are theirs to see. */
  team: boolean;
  headcount: number;
  trend: { label: string; headcount: number }[];
  departments: { department: string; headcount: number }[];
  attendanceToday: AttendanceCounts | null;
  weeklyAttendance: { start: string; label: string; value: number | null }[] | null;
  leaveByType: { label: string; days: number }[] | null;
  joiners: { label: string; joiners: number }[] | null;
  payroll: {
    latest: { period_month: string; gross_cents: number; headcount: number } | null;
    /** Gross pay in ringgit per month, oldest first. */
    byMonth: { label: string; payroll: number }[];
  } | null;
};

/** The share of expected attendances (present, late or absent) that happened, per week, oldest first. Null for a week with none. */
export function weeklyAttendanceRate(
  days: AttendanceDay[],
  today: string,
  weeks: number,
): { start: string; label: string; value: number | null }[] {
  return bucketByWeek(days, (d) => d.work_date, () => 1, today, weeks).map((bucket) => ({
    start: bucket.start,
    label: bucket.label,
    value: attendanceCounts(days.filter((d) => weekStart(d.work_date) === bucket.start)).rate_pct,
  }));
}

export function buildDashboardModel(input: DashboardInput, today: string, team: boolean): DashboardModel {
  const { employees } = input;
  const base = {
    today,
    team,
    headcount: employees.filter((e) => e.status === 'active').length,
    trend: headcountTrend(employees, today),
    departments: headcountByDepartment(employees),
  };
  if (!team) {
    return { ...base, attendanceToday: null, weeklyAttendance: null, leaveByType: null, joiners: null, payroll: null };
  }
  // The latest tile is the newest run, empty or not (an empty paid month really paid nothing). Only the chart
  // leaves out a run with no payslips.
  const all = payrollSummary(input.runs, input.payslips);
  const summary = all.filter((run) => run.headcount > 0);
  return {
    ...base,
    attendanceToday: attendanceOn(input.attendance, today),
    weeklyAttendance: weeklyAttendanceRate(input.attendance, today, 8),
    leaveByType: leaveDaysByType(input.leave, monthStart(today)),
    joiners: bucketByMonth(
      employees.filter((e) => e.status === 'active'),
      (e) => e.join_date,
      () => 1,
      today,
      6,
    ).map((b) => ({ label: b.label, joiners: b.value })),
    payroll: {
      latest: all[0]
        ? { period_month: all[0].period_month, gross_cents: all[0].gross_cents, headcount: all[0].headcount }
        : null,
      byMonth: summary
        .slice(0, 8)
        .reverse()
        .map((run) => ({ label: monthLabel(run.period_month), payroll: run.gross_cents / 100 })),
    },
  };
}

/** The first day to read attendance from: the Monday of the week eight weeks back. */
export const dashboardAttendanceFrom = (today: string): string => addDays(weekStart(today), -7 * 7);

/* ---- Announcements ------------------------------------------------ */

export const ANNOUNCEMENT_CATEGORIES: { key: Announcement['category']; label: string; color: string }[] = [
  { key: 'general', label: 'General', color: 'var(--chart-1)' },
  { key: 'holiday', label: 'Holiday', color: 'var(--chart-2)' },
  { key: 'benefits', label: 'Benefits', color: 'var(--chart-3)' },
  { key: 'strategy', label: 'Strategy', color: 'var(--chart-4)' },
  { key: 'policy', label: 'Policy', color: 'var(--chart-5)' },
];

const categoryLabel = (key: Announcement['category']) =>
  ANNOUNCEMENT_CATEGORIES.find((c) => c.key === key)?.label ?? key;

export type AnnouncementsModel = {
  total: number;
  thisMonth: number;
  /** Categories with at least one post. */
  categories: number;
  byCategory: { key: string; label: string; value: number; color: string }[];
  list: { id: string; title: string; body: string; category: string; author: string; when: string }[];
};

export function buildAnnouncementsModel(rows: Announcement[], now: Date): AnnouncementsModel {
  const month = monthStart(malaysiaDate(now.toISOString()));
  const byCategory = ANNOUNCEMENT_CATEGORIES.map((c) => ({
    key: c.key as string,
    label: c.label,
    color: c.color,
    value: rows.filter((r) => r.category === c.key).length,
  })).filter((c) => c.value > 0);
  return {
    total: rows.length,
    thisMonth: rows.filter((r) => {
      const date = malaysiaDate(r.published_at);
      return date !== '' && monthStart(date) === month;
    }).length,
    categories: byCategory.length,
    byCategory,
    list: [...rows]
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || a.title.localeCompare(b.title))
      .map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        category: categoryLabel(r.category),
        author: r.author_name?.trim() || 'Unknown',
        when: relativeTime(r.published_at, now),
      })),
  };
}

/* ---- Public holidays ---------------------------------------------- */

export type HolidayRow = {
  id: string;
  name: string;
  date: string;
  weekday: string;
  scope: 'National' | 'State';
  state: string;
  past: boolean;
};

export type HolidaysModel = {
  year: number;
  /** Holidays dated in the current year. */
  total: number;
  thisMonth: number;
  national: number;
  state: number;
  /** The first holiday on or after today, in this year or a later one. */
  next: { name: string; date: string; daysAway: number; in: string } | null;
  /** This year's holidays by date. */
  rows: HolidayRow[];
  /** This year's holidays still ahead. */
  upcoming: HolidayRow[];
};

const inDays = (n: number) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

export function buildHolidaysModel(holidays: PublicHoliday[], today: string): HolidaysModel {
  const year = Number(today.slice(0, 4));
  const sorted = [...holidays].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date) || a.name.localeCompare(b.name));
  const rows: HolidayRow[] = sorted
    .filter((h) => Number(h.holiday_date.slice(0, 4)) === year)
    .map((h) => ({
      id: h.id,
      name: h.name,
      date: h.holiday_date,
      weekday: weekdayName(h.holiday_date),
      scope: h.scope === 'national' ? 'National' : 'State',
      state: h.state ?? (h.scope === 'national' ? 'Nationwide' : '—'),
      past: h.holiday_date < today,
    }));
  const next = sorted.find((h) => h.holiday_date >= today);
  const daysAway = next ? daysBetween(today, next.holiday_date) : 0;
  return {
    year,
    total: rows.length,
    thisMonth: rows.filter((r) => monthStart(r.date) === monthStart(today)).length,
    national: rows.filter((r) => r.scope === 'National').length,
    state: rows.filter((r) => r.scope === 'State').length,
    next: next ? { name: next.name, date: next.holiday_date, daysAway, in: inDays(daysAway) } : null,
    rows,
    upcoming: rows.filter((r) => !r.past),
  };
}
