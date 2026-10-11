/**
 * The four approval queues (leave, financial claims, overtime, time-off) as
 * plain models. Owners and admins only: a builder returns null, having read
 * nothing, for anyone else. Nothing here changes data; the leave and time-off
 * queues' buttons do, through the actions in `leave-actions.ts`.
 */

import { rm } from '@/lib/reach/format';
import { formatDate, formatDay, hoursBetweenTimes, malaysiaDate, monthStart, todayInMalaysia } from './dates';
import { CLAIM_CATEGORY_LABEL, REQUEST_STATUS_LABEL, isTeamView } from './own';
import { overBalanceBy } from './leave';
import { overtimeModel } from './overtime';
import { leaveLabel } from './overview';
import { bucketByWeek, sumBy } from './series';
import type { PeopleData, PeopleViewer, RequestStatus } from './types';

export type ApprovalQueue = 'leave' | 'claims' | 'overtime' | 'time_off';

export type ApprovalRow = {
  id: string;
  employee_name: string;
  /** The queue's own middle columns, already formatted. */
  cells: string[];
  status: RequestStatus;
  status_label: string;
  pending: boolean;
  created_at: string;
  /** Days by which a pending leave request exceeds the balance; 0 everywhere else. */
  over_by: number;
  /** The request belongs to the viewer's own employee record. */
  yours: boolean;
  /** An owner or admin may cancel it: anything not already cancelled. */
  cancellable: boolean;
};

export type ApprovalsModel = {
  /** `caption` is the queue's own unit: days, ringgit or hours. */
  pending: { count: number; caption: string };
  approved: { count: number; caption: string };
  rejected: { count: number; caption: string };
  /** The last 8 weeks by `created_at`; `approved` is how many of that week's requests are approved now. */
  trend: { label: string; submitted: number; approved: number }[];
  /** The pending queue by kind, largest first; null where the queue has no categories. */
  breakdown: { label: string; value: number; text: string }[] | null;
  rows: ApprovalRow[];
};

type QueueConfig = {
  title: string;
  subtitle: string;
  chartTitle: string;
  /** What the chart's two series measure, for the series names. */
  trendUnit: string;
  breakdownTitle: string | null;
  breakdownSubtitle: string | null;
  tableTitle: string;
  columns: { label: string; right?: boolean }[];
  emptyText: string;
  /** Approve, Reject and Cancel work on this queue; false keeps the disabled buttons. */
  decides: boolean;
};

export const APPROVAL_QUEUES: Record<ApprovalQueue, QueueConfig> = {
  leave: {
    title: 'Leave Approvals',
    subtitle: 'Leave requests from your team',
    chartTitle: 'Leave requests over time',
    trendUnit: 'requests',
    breakdownTitle: 'Pending by type',
    breakdownSubtitle: 'Days waiting',
    tableTitle: 'Leave requests',
    columns: [{ label: 'Type' }, { label: 'From–To' }, { label: 'Days', right: true }],
    emptyText: 'No leave requests yet',
    decides: true,
  },
  claims: {
    title: 'Claim Approvals',
    subtitle: 'Expense claims from your team',
    chartTitle: 'Claim value over time',
    trendUnit: 'RM',
    breakdownTitle: 'Pending by category',
    breakdownSubtitle: 'Ringgit waiting',
    tableTitle: 'Expense claims',
    columns: [{ label: 'Category' }, { label: 'Amount', right: true }, { label: 'Date' }],
    emptyText: 'No claims yet',
    decides: false,
  },
  overtime: {
    title: 'Overtime Approvals',
    subtitle: 'Overtime claims from your team',
    chartTitle: 'Overtime hours over time',
    trendUnit: 'hours',
    breakdownTitle: 'Pending by department',
    breakdownSubtitle: 'Hours waiting',
    tableTitle: 'Overtime claims',
    columns: [{ label: 'Date' }, { label: 'Hours', right: true }, { label: 'Amount', right: true }],
    emptyText: 'No overtime claims yet',
    decides: false,
  },
  time_off: {
    title: 'Time-Off Approvals',
    subtitle: 'Short time-off requests from your team',
    chartTitle: 'Time-off requests over time',
    trendUnit: 'requests',
    breakdownTitle: null,
    breakdownSubtitle: null,
    tableTitle: 'Time-off requests',
    columns: [{ label: 'Date' }, { label: 'Duration', right: true }, { label: 'Reason' }],
    emptyText: 'No time-off requests yet',
    decides: true,
  },
};

const WEEKS = 8;
const round2 = (value: number) => Math.round(value * 100) / 100;
const hoursText = (hours: number) => `${round2(hours)} h`;
const daysText = (days: number) => `${round2(days)} ${days === 1 ? 'day' : 'days'}`;
const dayRange = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)}–${formatDay(to)}`);

/** One request of any queue, reduced to what the shared model needs. */
type Item = {
  id: string;
  employee_id: string;
  employee_name: string;
  /** Days over balance, for a pending leave request. */
  over_by?: number;
  status: RequestStatus;
  created_at: string;
  /** The request's own date: start, claim, work or off date. */
  date: string;
  /** The queue's unit: days, cents or hours. */
  measure: number;
  /** What the chart adds up: 1 per request, or ringgit, or hours. */
  trend: number;
  /** What the pending breakdown groups by; '' where the queue has none. */
  group: string;
  cells: string[];
};

function buildQueue(
  items: Item[],
  viewer: PeopleViewer,
  today: string,
  format: (measure: number) => string,
  breakdown: ApprovalsModel['breakdown'],
): ApprovalsModel {
  const month = monthStart(today);
  const total = (list: Item[]) => list.reduce((sum, item) => sum + item.measure, 0);
  const pending = items.filter((item) => item.status === 'pending');
  const inMonth = (status: RequestStatus) =>
    items.filter((item) => item.status === status && monthStart(item.date) === month);
  const approved = inMonth('approved');
  const rejected = inMonth('rejected');

  const submittedOn = (item: Item) => malaysiaDate(item.created_at) || null;
  const submitted = bucketByWeek(items, submittedOn, (item) => item.trend, today, WEEKS);
  const approvedSince = bucketByWeek(
    items.filter((item) => item.status === 'approved'),
    submittedOn,
    (item) => item.trend,
    today,
    WEEKS,
  );

  return {
    pending: { count: pending.length, caption: format(total(pending)) },
    approved: { count: approved.length, caption: format(total(approved)) },
    rejected: { count: rejected.length, caption: format(total(rejected)) },
    trend: submitted.map((bucket, index) => ({
      label: bucket.label,
      submitted: bucket.value,
      approved: approvedSince[index].value,
    })),
    breakdown,
    rows: [...items]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id,
        employee_name: item.employee_name,
        cells: item.cells,
        status: item.status,
        status_label: REQUEST_STATUS_LABEL[item.status],
        pending: item.status === 'pending',
        created_at: item.created_at,
        over_by: item.over_by ?? 0,
        yours: viewer.employeeId !== null && item.employee_id === viewer.employeeId,
        cancellable: item.status !== 'cancelled',
      })),
  };
}

const grouped = (
  items: Item[],
  format: (measure: number) => string,
): ApprovalsModel['breakdown'] =>
  sumBy(
    items.filter((item) => item.status === 'pending'),
    (item) => item.group,
    (item) => item.measure,
  ).map(({ key, value }) => ({ label: key, value, text: format(value) }));

export async function leaveApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!isTeamView(viewer)) return null;
  const requests = await data.listLeaveRequests();
  // The balances of each year a pending request starts in, read only here (team viewers only get this far).
  const years = [...new Set(requests.filter((r) => r.status === 'pending').map((r) => Number(r.start_date.slice(0, 4))))];
  const balances = (await Promise.all(years.map((year) => data.listLeaveBalances(year)))).flat();
  const items: Item[] = requests.map((r) => ({
    id: r.id,
    employee_id: r.employee_id,
    over_by: overBalanceBy(r, balances, requests),
    employee_name: r.employee_name,
    status: r.status,
    created_at: r.created_at,
    date: r.start_date,
    measure: r.days,
    trend: 1,
    group: leaveLabel(r.leave_type),
    cells: [leaveLabel(r.leave_type), dayRange(r.start_date, r.end_date), String(r.days)],
  }));
  return buildQueue(items, viewer, todayInMalaysia(now), daysText, grouped(items, daysText));
}

export async function claimApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!isTeamView(viewer)) return null;
  const claims = await data.listClaims();
  const items: Item[] = claims.map((c) => ({
    id: c.id,
    employee_id: c.employee_id,
    employee_name: c.employee_name,
    status: c.status,
    created_at: c.created_at,
    date: c.claim_date,
    measure: c.amount_cents,
    trend: c.amount_cents / 100,
    group: CLAIM_CATEGORY_LABEL[c.category] ?? 'Other',
    cells: [CLAIM_CATEGORY_LABEL[c.category] ?? 'Other', rm(c.amount_cents), formatDate(c.claim_date)],
  }));
  return buildQueue(items, viewer, todayInMalaysia(now), rm, grouped(items, rm));
}

export async function overtimeApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!isTeamView(viewer)) return null;
  const [records, employees] = await Promise.all([data.listOvertime(), data.listEmployees()]);
  const today = todayInMalaysia(now);
  const items: Item[] = records.map((r) => ({
    id: r.id,
    employee_id: r.employee_id,
    employee_name: r.employee_name,
    status: r.status,
    created_at: r.created_at,
    date: r.work_date,
    measure: r.hours,
    trend: r.hours,
    group: '',
    cells: [formatDate(r.work_date), hoursText(r.hours), rm(r.amount_cents)],
  }));
  const breakdown = overtimeModel(records, employees, today).by_department.map(({ department, hours }) => ({
    label: department,
    value: hours,
    text: hoursText(hours),
  }));
  return buildQueue(items, viewer, today, hoursText, breakdown);
}

export async function timeOffApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!isTeamView(viewer)) return null;
  const requests = await data.listTimeOffRequests();
  const items: Item[] = requests.map((r) => {
    const hours = hoursBetweenTimes(r.start_time, r.end_time);
    return {
      id: r.id,
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      status: r.status,
      created_at: r.created_at,
      date: r.off_date,
      measure: hours,
      trend: 1,
      group: '',
      cells: [formatDate(r.off_date), hoursText(hours), r.reason?.trim() || '—'],
    };
  });
  // The reasons are free text, so there is nothing honest to group by.
  return buildQueue(items, viewer, todayInMalaysia(now), hoursText, null);
}
