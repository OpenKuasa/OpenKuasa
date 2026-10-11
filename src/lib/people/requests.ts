/**
 * The figures and table rows for the four "my requests" screens (Leave,
 * Time-Off, Financial Claims, OT Claims). Each builder narrows the rows it is
 * given to the viewer's own and returns `{ linked: false }` when the account
 * is linked to no employee record. Pure: nothing here reads the database.
 */

import { rm } from '@/lib/reach/format';
import { formatDate, formatDay, hoursBetweenTimes, malaysiaDate, monthStart } from './dates';
import { CLAIM_CATEGORY_LABEL, leaveDaysByTypeInYear, ownRows } from './own';
import { overtimeModel, type OvertimeModel } from './overtime';
import { leaveLabel } from './overview';
import { percent, sumBy } from './series';
import { leaveBalanceRows } from './summaries';
import type {
  Claim,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  OvertimeRecord,
  PeopleViewer,
  RequestStatus,
  TimeOffRequest,
} from './types';

export type NotLinked = { linked: false };

const round2 = (value: number) => Math.round(value * 100) / 100;
const sum = (values: number[]) => round2(values.reduce((total, v) => total + v, 0));
/** `3`, `2.5`, never `2.50`. */
const trimmed = (value: number) => String(round2(value));
const dayOrDash = (instant: string) => {
  const date = malaysiaDate(instant);
  return date === '' ? '—' : formatDay(date);
};
/** Newest first by one date, then by when the request was made. */
/** A rejected request's note for the person who asked, or null. */
const rejectionNote = (status: RequestStatus, note: string | null): string | null =>
  status === 'rejected' && note !== null && note.trim() !== '' ? note.trim() : null;
const newestFirst = <T extends { created_at: string }>(rows: T[], dateOf: (row: T) => string): T[] =>
  [...rows].sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || b.created_at.localeCompare(a.created_at));

/**
 * Whether the person may cancel their own request: while it waits, or once
 * approved and not yet started (its first day is after today). The database
 * makes the same call; this only decides whether to show the button.
 */
export function canCancelRequest(status: RequestStatus, startDate: string, today: string): boolean {
  return status === 'pending' || (status === 'approved' && startDate > today);
}

/* ---- Leave ---------------------------------------------------------- */

export type LeaveRow = {
  id: string;
  /** Whether the Cancel button shows. */
  cancellable: boolean;
  type: string;
  from: string;
  to: string;
  days: number;
  status: RequestStatus;
  /** The note the decider left, for a rejected request. */
  note: string | null;
  applied: string;
};

export type LeaveModel = {
  linked: true;
  /** Remaining days of annual leave this year, or null with no annual balance row. */
  annual: { remaining: number; entitled: number } | null;
  /** Medical leave taken this year, or null with no medical balance row. */
  medical: { taken: number; entitled: number } | null;
  /** Approved days starting this year, all kinds. */
  used_ytd: number;
  /** Requests waiting for a decision. */
  pending: number;
  by_type: { leave_type: LeaveType; label: string; days: number }[];
  /** Entitlement used, per kind that has a balance row. `percent` is null when nothing is entitled. */
  balances: { leave_type: LeaveType; label: string; used: number; entitled: number; percent: number | null }[];
  /** Approved unpaid days this year. */
  unpaid_days: number;
  rows: LeaveRow[];
};

export function buildLeaveModel(
  requests: LeaveRequest[],
  balances: LeaveBalance[],
  viewer: PeopleViewer,
  today: string,
): LeaveModel | NotLinked {
  if (viewer.employeeId === null) return { linked: false };
  const year = Number(today.slice(0, 4));
  const mine = ownRows(requests, viewer);
  const balanceRows = leaveBalanceRows(
    ownRows(balances, viewer).filter((b) => b.year === year),
    [],
  );
  const annual = balanceRows.find((b) => b.leave_type === 'annual');
  const medical = balanceRows.find((b) => b.leave_type === 'medical');
  const byType = leaveDaysByTypeInYear(mine, year);

  return {
    linked: true,
    annual: annual ? { remaining: annual.remaining_days, entitled: annual.entitled_days } : null,
    medical: medical ? { taken: medical.used_days, entitled: medical.entitled_days } : null,
    used_ytd: sum(byType.map((t) => t.days)),
    pending: mine.filter((r) => r.status === 'pending').length,
    by_type: byType,
    balances: balanceRows.map((b) => ({
      leave_type: b.leave_type,
      label: leaveLabel(b.leave_type),
      used: b.used_days,
      entitled: b.entitled_days,
      percent: percent(b.used_days, b.entitled_days),
    })),
    unpaid_days: byType.find((t) => t.leave_type === 'unpaid')?.days ?? 0,
    rows: newestFirst(mine, (r) => r.start_date).map((r) => ({
      id: r.id,
      cancellable: canCancelRequest(r.status, r.start_date, today),
      type: leaveLabel(r.leave_type),
      from: formatDate(r.start_date),
      to: formatDate(r.end_date),
      days: r.days,
      status: r.status,
      note: rejectionNote(r.status, r.decision_note),
      applied: dayOrDash(r.created_at),
    })),
  };
}

/* ---- Time-Off ------------------------------------------------------- */

export type TimeOffRow = {
  id: string;
  /** Whether the Cancel button shows. */
  cancellable: boolean;
  date: string;
  from: string;
  to: string;
  duration: string;
  reason: string;
  status: RequestStatus;
  /** The note the decider left, for a rejected request. */
  note: string | null;
};

export type TimeOffModel = {
  linked: true;
  /** Requests for a date in this month, not counting cancelled ones. */
  this_month: number;
  /** Approved requests for a date in this month. */
  approved: number;
  /** Requests waiting for a decision, whatever their date. */
  pending: number;
  /** Hours of approved and pending requests for a date in this month. */
  hours: number;
  rows: TimeOffRow[];
};

export function buildTimeOffModel(
  requests: TimeOffRequest[],
  viewer: PeopleViewer,
  today: string,
): TimeOffModel | NotLinked {
  if (viewer.employeeId === null) return { linked: false };
  const mine = ownRows(requests, viewer);
  const thisMonth = monthStart(today);
  const inMonth = mine.filter((r) => monthStart(r.off_date) === thisMonth);
  const hoursOf = (r: TimeOffRequest) => hoursBetweenTimes(r.start_time, r.end_time);

  return {
    linked: true,
    this_month: inMonth.filter((r) => r.status !== 'cancelled').length,
    approved: inMonth.filter((r) => r.status === 'approved').length,
    pending: mine.filter((r) => r.status === 'pending').length,
    hours: sum(inMonth.filter((r) => r.status === 'approved' || r.status === 'pending').map(hoursOf)),
    rows: newestFirst(mine, (r) => r.off_date).map((r) => ({
      id: r.id,
      cancellable: canCancelRequest(r.status, r.off_date, today),
      date: formatDate(r.off_date),
      from: r.start_time.slice(0, 5),
      to: r.end_time.slice(0, 5),
      duration: `${trimmed(hoursOf(r))}h`,
      reason: r.reason ?? '—',
      status: r.status,
      note: rejectionNote(r.status, r.decision_note),
    })),
  };
}

/* ---- Financial Claims ----------------------------------------------- */

export type ClaimRow = {
  id: string;
  category: string;
  amount: string;
  date: string;
  receipt: boolean;
  status: RequestStatus;
};

export type ClaimsModel = {
  linked: true;
  /** Claims dated this month, not counting cancelled ones. */
  claimed_cents: number;
  /** Approved claims dated this month. */
  approved_cents: number;
  /** Claims waiting for a decision, whatever their date. */
  pending_cents: number;
  pending_count: number;
  /** The claimed figure split by category, largest first. `percent` is null when the total is 0. */
  by_category: { category: string; label: string; cents: number; percent: number | null }[];
  rows: ClaimRow[];
};

export function buildClaimsModel(claims: Claim[], viewer: PeopleViewer, today: string): ClaimsModel | NotLinked {
  if (viewer.employeeId === null) return { linked: false };
  const mine = ownRows(claims, viewer);
  const thisMonth = monthStart(today);
  const claimed = mine.filter((c) => c.status !== 'cancelled' && monthStart(c.claim_date) === thisMonth);
  const pending = mine.filter((c) => c.status === 'pending');
  const total = claimed.reduce((t, c) => t + c.amount_cents, 0);

  return {
    linked: true,
    claimed_cents: total,
    approved_cents: claimed.filter((c) => c.status === 'approved').reduce((t, c) => t + c.amount_cents, 0),
    pending_cents: pending.reduce((t, c) => t + c.amount_cents, 0),
    pending_count: pending.length,
    by_category: sumBy(claimed, (c) => c.category, (c) => c.amount_cents).map(({ key, value }) => ({
      category: key,
      label: CLAIM_CATEGORY_LABEL[key as keyof typeof CLAIM_CATEGORY_LABEL] ?? key,
      cents: value,
      percent: percent(value, total),
    })),
    rows: newestFirst(mine, (c) => c.claim_date).map((c) => ({
      id: c.id,
      category: CLAIM_CATEGORY_LABEL[c.category],
      amount: rm(c.amount_cents),
      date: formatDate(c.claim_date),
      receipt: c.has_receipt,
      status: c.status,
    })),
  };
}

/* ---- OT Claims ------------------------------------------------------ */

export type OtRow = {
  id: string;
  date: string;
  hours: number;
  rate: string;
  amount: string;
  status: RequestStatus;
};

export type OtModel = {
  linked: true;
  overtime: OvertimeModel;
  rows: OtRow[];
};

export function buildOtModel(records: OvertimeRecord[], viewer: PeopleViewer, today: string): OtModel | NotLinked {
  if (viewer.employeeId === null) return { linked: false };
  const mine = ownRows(records, viewer);
  return {
    linked: true,
    overtime: overtimeModel(mine, [], today),
    rows: newestFirst(mine, (r) => r.work_date).map((r) => ({
      id: r.id,
      date: formatDate(r.work_date),
      hours: r.hours,
      rate: `${r.rate_multiplier}x`,
      amount: rm(r.amount_cents),
      status: r.status,
    })),
  };
}
