/**
 * The four approval queues (leave, financial claims, overtime, time-off) as
 * plain models. Owners and admins, and a manager for their direct reports: a
 * builder returns null, having read nothing, for anyone else. Nothing here changes data; the buttons do, through
 * the actions in `leave-actions.ts` and `pay-actions.ts`.
 */

import { rm } from '@/lib/reach/format';
import { formatDate, formatDay, hoursBetweenTimes, malaysiaDate, monthStart, todayInMalaysia } from './dates';
import { CLAIM_CATEGORY_LABEL, REQUEST_STATUS_LABEL, canApproveTeam } from './own';
import { overBalanceBy } from './leave';
import { overtimeAmountText, overtimeCalculated, overtimeModel } from './overtime';
import { leaveLabel } from './overview';
import { approvedThisYear } from './pay-requests';
import { managerLabel, teamIds } from './reporting';
import { bucketByWeek, sumBy } from './series';
import { teamScreenView, type TeamScreenView } from './tier';
import type { Claim, ClaimStatus, Employee, OvertimeDayKind, PeopleData, PeopleViewer, TeamOvertimeRow } from './types';

export type ApprovalQueue = 'leave' | 'claims' | 'overtime' | 'time_off';

export type ApprovalRow = {
  id: string;
  employee_name: string;
  /** The queue's own middle columns, already formatted. */
  cells: string[];
  status: ClaimStatus;
  status_label: string;
  pending: boolean;
  created_at: string;
  /** Days by which a pending leave request exceeds the balance; 0 everywhere else. */
  over_by: number;
  /** The request belongs to the viewer's own employee record. */
  yours: boolean;
  /**
   * The viewer may approve, reject or mark it paid: anyone's but their own, and their own only when they are
   * the workspace's owner. The database decides (LEAVE_OWN_REQUEST, PAY_OWN_REQUEST); this keeps the buttons
   * in step with it. Cancelling is not part of it: a person may always withdraw their own request.
   */
  decidable: boolean;
  /** An owner or admin may cancel it: anything not already cancelled. Never for a manager. */
  cancellable: boolean;
  /** Who the employee reports to ("Farid Ismail", "Farid Ismail (inactive)"); null when nobody, and always null in a manager's own queue. */
  manager_label: string | null;
  /** Claims only: the receipt, the year's total, the paid mark. Null on the other queues. */
  claim: ClaimDetail | null;
  /** Overtime only: what the multiplier was worked out from. Null on the other queues. */
  overtime: OvertimeDetail | null;
  /** Short lines shown under the row: a rejection note, the paid reference. Free text, never logged. */
  notes: string[];
};

export type ClaimDetail = {
  has_file: boolean;
  ticked: boolean;
  /** The claim's own date, which a paid date cannot precede. */
  claim_date: string;
  /** The calendar year of the claim's own date, which the total below counts. */
  year: number;
  /**
   * Approved or paid in this category in `year`, not counting this claim, already formatted. Null on a claim
   * that is no longer being weighed (paid, rejected, cancelled), and when the total is nothing.
   */
  year_total: string | null;
  /** An approved claim can be marked paid. */
  markable: boolean;
  /** Set once paid. */
  paid_on: string | null;
  paid_on_text: string | null;
  paid_reference: string | null;
};

export type OvertimeDetail = {
  /** "Weekday, paid at 1.5 times"; the multiplier alone when the kind of day was not recorded. */
  kind: string;
  /** False when no salary was on file: the amount is not calculated. */
  calculated: boolean;
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
  /** Claims only: approved claims not yet marked paid. Null on the other queues. */
  unpaid: { count: number; caption: string } | null;
  /** Who is looking: decides which controls a row offers. */
  view: TeamScreenView;
};

/** What one row offers this kind of viewer. */
export type RowControls = {
  /** Approve and Reject. */
  decide: boolean;
  /** Cancel (HR only: cancelling for someone else). */
  cancel: boolean;
  /** Mark paid, on an approved claim (HR only). */
  markPaid: boolean;
  /** Undo paid, on a paid claim (HR only). */
  undoPaid: boolean;
  /** Every control drawn but switched off (the demo). */
  disabled: boolean;
  /** Why a pending row has no decide buttons: an admin's own request. Null otherwise. */
  note: 'own-admin' | null;
};

export function rowControls(
  view: TeamScreenView,
  row: Pick<ApprovalRow, 'pending' | 'decidable' | 'cancellable' | 'status' | 'claim'>,
): RowControls {
  if (view === 'manager') {
    return { decide: row.pending, cancel: false, markPaid: false, undoPaid: false, disabled: false, note: null };
  }
  if (view === 'none') return { decide: false, cancel: false, markPaid: false, undoPaid: false, disabled: false, note: null };
  return {
    decide: row.pending && row.decidable,
    cancel: row.cancellable,
    markPaid: row.claim?.markable === true && row.decidable,
    undoPaid: row.status === 'paid',
    disabled: view === 'demo',
    note: !row.decidable && (row.pending || row.claim?.markable === true) ? 'own-admin' : null,
  };
}

/** What the screen offers above the table. */
export type ScreenControls = { addFor: boolean; export: boolean; disabled: boolean; subtitle: string };

export function screenControls(view: TeamScreenView, queueSubtitle: string): ScreenControls {
  if (view === 'hr') return { addFor: true, export: true, disabled: false, subtitle: queueSubtitle };
  if (view === 'demo') return { addFor: true, export: true, disabled: true, subtitle: queueSubtitle };
  if (view === 'manager') {
    return { addFor: false, export: false, disabled: false, subtitle: 'Requests from the people who report to you' };
  }
  return { addFor: false, export: false, disabled: false, subtitle: queueSubtitle };
}

/** The table's middle columns for this viewer: a manager's overtime has a day column where HR's has the amount. */
export function queueColumns(queue: ApprovalQueue, view: TeamScreenView): QueueConfig['columns'] {
  const columns = APPROVAL_QUEUES[queue].columns;
  if (queue === 'overtime' && view === 'manager') return [columns[0], columns[1], { label: 'Day' }];
  return columns;
}

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

const OVERTIME_KIND: Record<OvertimeDayKind, string> = {
  weekday: 'Weekday',
  rest_day: 'Rest day',
  public_holiday: 'Public holiday',
};
const multiplierText = (multiplier: number) => `${Math.round(multiplier * 10) / 10} times`;

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
    decides: true,
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
    decides: true,
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
export type Item = {
  id: string;
  employee_id: string;
  employee_name: string;
  /** Days over balance, for a pending leave request. */
  over_by?: number;
  status: ClaimStatus;
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
  claim?: ClaimDetail;
  overtime?: OvertimeDetail;
  notes?: string[];
};

/** The rows a viewer's queue is made of: a manager's are their direct reports' and nobody else's, whatever the provider hands over. */
function inScope<T extends { employee_id: string }>(rows: T[], viewer: PeopleViewer, employees: Employee[]): T[] {
  if (teamScreenView(viewer) !== 'manager') return rows;
  const team = teamIds(employees, viewer);
  return rows.filter((row) => team.has(row.employee_id));
}

function buildQueue(
  items: Item[],
  viewer: PeopleViewer,
  employees: Employee[],
  today: string,
  format: (measure: number) => string,
  breakdown: ApprovalsModel['breakdown'],
  unpaidClaims = false,
): ApprovalsModel {
  const view = teamScreenView(viewer);
  const manager = view === 'manager';
  const byId = new Map(employees.map((e) => [e.id, e]));
  const month = monthStart(today);
  const total = (list: Item[]) => list.reduce((sum, item) => sum + item.measure, 0);
  const pending = items.filter((item) => item.status === 'pending');
  const inMonth = (counts: (status: ClaimStatus) => boolean) =>
    items.filter((item) => counts(item.status) && monthStart(item.date) === month);
  // A paid claim was approved first, so it counts wherever an approved one does.
  const approved = inMonth((status) => status === 'approved' || status === 'paid');
  const rejected = inMonth((status) => status === 'rejected');

  const submittedOn = (item: Item) => malaysiaDate(item.created_at) || null;
  const submitted = bucketByWeek(items, submittedOn, (item) => item.trend, today, WEEKS);
  const approvedSince = bucketByWeek(
    items.filter((item) => item.status === 'approved' || item.status === 'paid'),
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
    view,
    unpaid: unpaidClaims
      ? (() => {
          const unpaid = items.filter((item) => item.status === 'approved');
          return { count: unpaid.length, caption: format(total(unpaid)) };
        })()
      : null,
    rows: [...items]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .map((item) => {
        const yours = viewer.employeeId !== null && item.employee_id === viewer.employeeId;
        return {
          id: item.id,
          employee_name: item.employee_name,
          cells: item.cells,
          status: item.status,
          status_label: REQUEST_STATUS_LABEL[item.status],
          pending: item.status === 'pending',
          created_at: item.created_at,
          over_by: item.over_by ?? 0,
          yours,
          // A manager's own rows were dropped before this, so everything left is a report's.
          decidable: manager || !yours || viewer.isOwner === true,
          // A paid claim is not cancelled until its paid mark is undone. A manager cancels nothing.
          cancellable: !manager && item.status !== 'cancelled' && item.status !== 'paid',
          manager_label: manager ? null : byId.has(item.employee_id) ? managerLabel(byId.get(item.employee_id)!, employees) : null,
          claim: item.claim ?? null,
          overtime: item.overtime ?? null,
          notes: item.notes ?? [],
        };
      }),
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

/** A rejection note, then the payment reference: the lines that sit under a row. */
function requestNotes(decisionNote: string | null, paidReference: string | null): string[] {
  const lines: string[] = [];
  if (decisionNote?.trim()) lines.push(`Note: ${decisionNote.trim()}`);
  if (paidReference?.trim()) lines.push(`Reference: ${paidReference.trim()}`);
  return lines;
}

function claimDetail(claim: Claim, claims: Claim[]): ClaimDetail {
  // A total of nothing is not worth a line, so it is left out.
  const yearCents = claim.status === 'pending' || claim.status === 'approved' ? approvedThisYear(claim, claims) : 0;
  return {
    has_file: claim.receipt_path !== null,
    ticked: claim.has_receipt,
    claim_date: claim.claim_date,
    // The one formula, shared with Lekiu's lookups.
    year: Number(claim.claim_date.slice(0, 4)),
    year_total: yearCents > 0 ? rm(yearCents) : null,
    markable: claim.status === 'approved',
    paid_on: claim.status === 'paid' ? claim.paid_on : null,
    paid_on_text: claim.status === 'paid' && claim.paid_on ? formatDate(claim.paid_on) : null,
    paid_reference: claim.status === 'paid' ? claim.paid_reference : null,
  };
}

export async function leaveApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!canApproveTeam(viewer)) return null;
  const [all, employees] = await Promise.all([data.listLeaveRequests(), data.listEmployees()]);
  const requests = inScope(all, viewer, employees);
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
  return buildQueue(items, viewer, employees, todayInMalaysia(now), daysText, grouped(items, daysText));
}

export async function claimApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!canApproveTeam(viewer)) return null;
  const [all, employees] = await Promise.all([data.listClaims(), data.listEmployees()]);
  const claims = inScope(all, viewer, employees);
  const items: Item[] = claims.map((c) => ({
    claim: claimDetail(c, claims),
    notes: requestNotes(c.decision_note, c.paid_reference),
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
  return buildQueue(items, viewer, employees, todayInMalaysia(now), rm, grouped(items, rm), true);
}

/**
 * A manager's overtime row, built from the pay-free row the database function returns: date, hours, day kind,
 * multiplier, reason, status, and nothing about money (no amount, rate or paid month exists on the input).
 * Nothing here says what the hours "pay".
 */
export function managerOvertimeItem(r: TeamOvertimeRow, employeeName: string): Item {
  const multiplier = r.rate_multiplier === null ? null : multiplierText(r.rate_multiplier);
  const kind = r.day_kind ? (multiplier ? `${OVERTIME_KIND[r.day_kind]}, ${multiplier}` : OVERTIME_KIND[r.day_kind]) : multiplier;
  return {
    id: r.id,
    employee_id: r.employee_id,
    employee_name: employeeName,
    status: r.status,
    created_at: r.created_at,
    date: r.work_date,
    measure: r.hours,
    trend: r.hours,
    group: '',
    cells: [formatDate(r.work_date), hoursText(r.hours), kind ?? '—'],
    overtime: { kind: kind ?? '', calculated: true },
    notes: [...(r.reason?.trim() ? [`Reason: ${r.reason.trim()}`] : []), ...requestNotes(r.decision_note, null)],
  };
}

/**
 * HR (and the demo) read the overtime table, with amounts. A manager's rows come in as `teamOvertime`, from
 * `readTeamOvertime`, because their database role cannot read the table's pay columns.
 */
export async function overtimeApprovals(
  data: PeopleData,
  viewer: PeopleViewer,
  now: Date,
  teamOvertime: TeamOvertimeRow[] | null,
): Promise<ApprovalsModel | null> {
  if (!canApproveTeam(viewer)) return null;
  const today = todayInMalaysia(now);
  if (teamScreenView(viewer) === 'manager') {
    const employees = await data.listEmployees();
    const names = new Map(employees.map((e) => [e.id, e.name]));
    const rows = inScope(teamOvertime ?? [], viewer, employees);
    const items = rows.map((r) => managerOvertimeItem(r, names.get(r.employee_id) ?? ''));
    const department = new Map(employees.map((e) => [e.id, e.department_name ?? 'Unassigned']));
    const breakdown = sumBy(
      rows.filter((r) => r.status === 'pending'),
      (r) => department.get(r.employee_id) ?? null,
      (r) => r.hours,
    ).map(({ key, value }) => ({ label: key, value, text: hoursText(value) }));
    return buildQueue(items, viewer, employees, today, hoursText, breakdown);
  }
  const [records, employees] = await Promise.all([data.listOvertime(), data.listEmployees()]);
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
    // No salary on file: the database stored no rate, so there is no amount to show.
    cells: [formatDate(r.work_date), hoursText(r.hours), overtimeAmountText(r)],
    overtime: {
      kind: r.day_kind
        ? `${OVERTIME_KIND[r.day_kind]}, paid at ${multiplierText(r.rate_multiplier)}`
        : `Paid at ${multiplierText(r.rate_multiplier)}`,
      calculated: overtimeCalculated(r),
    },
    notes: requestNotes(r.decision_note, null),
  }));
  const breakdown = overtimeModel(records, employees, today).by_department.map(({ department, hours }) => ({
    label: department,
    value: hours,
    text: hoursText(hours),
  }));
  return buildQueue(items, viewer, employees, today, hoursText, breakdown);
}

export async function timeOffApprovals(data: PeopleData, viewer: PeopleViewer, now: Date): Promise<ApprovalsModel | null> {
  if (!canApproveTeam(viewer)) return null;
  const [all, employees] = await Promise.all([data.listTimeOffRequests(), data.listEmployees()]);
  const requests = inScope(all, viewer, employees);
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
  return buildQueue(items, viewer, employees, todayInMalaysia(now), hoursText, null);
}
