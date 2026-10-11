/**
 * Who sees whose rows on a personal screen. The database decides what comes
 * back (the whole team for HR and in the demo); these helpers narrow that to
 * "mine" where a screen is about one person.
 */

import { leaveLabel } from './overview';
import { average } from './series';
import type {
  ClaimCategory,
  ClaimStatus,
  DocumentStatus,
  DocumentType,
  Employee,
  LeaveRequest,
  LeaveType,
  PeopleViewer,
} from './types';

/** HR, or anyone in the demo workspace: the people for whom the database returns the whole team. */
export function isTeamView(viewer: PeopleViewer): boolean {
  return viewer.isHr || viewer.isDemo;
}

/** The rows that belong to the viewer's own employee record. None when the account is not linked. */
export function ownRows<T extends { employee_id: string }>(rows: T[], viewer: PeopleViewer): T[] {
  const id = viewer.employeeId;
  return id === null ? [] : rows.filter((row) => row.employee_id === id);
}

/** Approved leave days per kind for leave starting in `year`, largest first. */
export function leaveDaysByTypeInYear(
  requests: LeaveRequest[],
  year: number,
): { leave_type: LeaveType; label: string; days: number }[] {
  const totals = new Map<LeaveType, number>();
  for (const request of requests) {
    if (request.status !== 'approved' || Number(request.start_date.slice(0, 4)) !== year) continue;
    totals.set(request.leave_type, (totals.get(request.leave_type) ?? 0) + request.days);
  }
  return [...totals.entries()]
    .map(([leave_type, days]) => ({ leave_type, label: leaveLabel(leave_type), days }))
    .sort((a, b) => b.days - a.days || a.leave_type.localeCompare(b.leave_type));
}

/** The mean score per department, highest first. Unassigned staff are under 'Unassigned'; people not in the directory are left out. */
export function departmentAverages(
  rows: { employee_id: string; score: number }[],
  employees: Employee[],
): { department: string; average: number; count: number }[] {
  const department = new Map(employees.map((e) => [e.id, e.department_name ?? 'Unassigned']));
  const scores = new Map<string, number[]>();
  for (const row of rows) {
    const name = department.get(row.employee_id);
    if (name === undefined) continue;
    scores.set(name, [...(scores.get(name) ?? []), row.score]);
  }
  return [...scores.entries()]
    .map(([name, values]) => ({ department: name, average: average(values) ?? 0, count: values.length }))
    .sort((a, b) => b.average - a.average || a.department.localeCompare(b.department));
}

export const REQUEST_STATUS_LABEL: Record<ClaimStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const CLAIM_CATEGORY_LABEL: Record<ClaimCategory, string> = {
  medical: 'Medical',
  travel: 'Travel',
  meals: 'Meals',
  equipment: 'Equipment',
  other: 'Other',
};

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  payslip: 'Payslip',
  contract: 'Contract',
  letter: 'Letter',
  tax: 'Tax form',
  benefits: 'Benefits',
};

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  signed: 'Signed',
  pending_signature: 'Pending signature',
  available: 'Available',
  expiring: 'Expiring',
};
