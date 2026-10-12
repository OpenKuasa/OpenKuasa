import { describe, expect, it } from 'vitest';
import {
  CLAIM_CATEGORY_LABEL,
  DOCUMENT_TYPE_LABEL,
  LETTER_TYPE_LABEL,
  REQUEST_STATUS_LABEL,
  departmentAverages,
  isTeamView,
  leaveDaysByTypeInYear,
  ownRows,
} from '@/lib/people/own';
import { createSeedPeopleData } from '@/lib/people/seed';
import {
  DEMO_EMPLOYEE_ID,
  DOCUMENT_TYPES,
  LETTER_TYPES,
  type Employee,
  type LeaveRequest,
  type PeopleViewer,
} from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const data = createSeedPeopleData(NOW);

const HR: PeopleViewer = { employeeId: 'seed-emp-3', isHr: true, isDemo: false };
const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-5', isHr: false, isDemo: false };
const UNLINKED_HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const UNLINKED_DEMO: PeopleViewer = { employeeId: null, isHr: false, isDemo: true };

describe('isTeamView', () => {
  it('is true for HR and for a demo visitor, false for a plain member', () => {
    expect(isTeamView(HR)).toBe(true);
    expect(isTeamView(DEMO)).toBe(true);
    expect(isTeamView(MEMBER)).toBe(false);
  });
});

describe('ownRows', () => {
  it("keeps only the viewer's rows, even for HR", async () => {
    const claims = await data.listClaims();
    expect(ownRows(claims, MEMBER)).toHaveLength(1);
    expect(ownRows(claims, MEMBER).every((c) => c.employee_id === 'seed-emp-5')).toBe(true);
    // HR is not handed the team's: only the claims of the HR user's own record.
    expect(ownRows(claims, HR)).toHaveLength(claims.filter((c) => c.employee_id === 'seed-emp-3').length);
    expect(ownRows(claims, HR).length).toBeLessThan(claims.length);
  });

  it("gives the demo employee's rows to a demo visitor", async () => {
    const claims = await data.listClaims();
    expect(ownRows(claims, DEMO)).toHaveLength(4);
    expect(ownRows(claims, DEMO).every((c) => c.employee_id === DEMO_EMPLOYEE_ID)).toBe(true);
  });

  it('gives nothing when the account is not linked, even to HR', async () => {
    const claims = await data.listClaims();
    expect(ownRows(claims, UNLINKED_HR)).toEqual([]);
    expect(ownRows(claims, UNLINKED_DEMO)).toEqual([]);
    expect(ownRows([], MEMBER)).toEqual([]);
  });
});

describe('leaveDaysByTypeInYear', () => {
  it('counts approved leave only, by the year of the start date, largest first', async () => {
    const requests = await data.listLeaveRequests();
    const out = leaveDaysByTypeInYear(requests, 2026);
    expect(out.map((o) => o.leave_type)).toEqual(['annual', 'medical', 'emergency']);
    expect(out[0].label).toBe('Annual leave');
    const annual = requests
      .filter((r) => r.status === 'approved' && r.leave_type === 'annual' && r.start_date.startsWith('2026'))
      .reduce((total, r) => total + r.days, 0);
    expect(out[0].days).toBe(annual);
    expect(out.find((o) => o.leave_type === 'unpaid')).toBeUndefined(); // the one unpaid request was rejected
  });

  it('puts a request in the year it starts', () => {
    const request = (start: string, status: LeaveRequest['status']): LeaveRequest => ({
      id: start, employee_id: 'e', employee_name: 'E', leave_type: 'annual', start_date: start,
      end_date: start, days: 2, half_day: false, reason: null, status, decision_note: null, created_at: start,
    });
    const rows = [request('2025-12-31', 'approved'), request('2026-01-01', 'approved'), request('2026-02-01', 'pending')];
    expect(leaveDaysByTypeInYear(rows, 2026)).toEqual([{ leave_type: 'annual', label: 'Annual leave', days: 2 }]);
    expect(leaveDaysByTypeInYear([], 2026)).toEqual([]);
  });
});

describe('departmentAverages', () => {
  it('is empty on no rows', () => {
    expect(departmentAverages([], [])).toEqual([]);
  });

  it('averages scores per department, highest first, with unassigned staff apart', async () => {
    const employees = await data.listEmployees();
    const out = departmentAverages(await data.listReviews(), employees);
    expect(out.reduce((total, d) => total + d.count, 0)).toBe(20);
    const averages = out.map((d) => d.average);
    expect(averages).toEqual([...averages].sort((a, b) => b - a));

    const loose: Employee = { ...employees[0], id: 'x', department_id: null, department_name: null };
    const withLoose = departmentAverages([{ employee_id: 'x', score: 4 }, { employee_id: 'ghost', score: 1 }], [loose]);
    expect(withLoose).toEqual([{ department: 'Unassigned', average: 4, count: 1 }]);
  });
});

describe('labels', () => {
  it('cover every value the database allows', () => {
    expect(Object.keys(REQUEST_STATUS_LABEL)).toEqual(['pending', 'approved', 'paid', 'rejected', 'cancelled']);
    expect(Object.values(CLAIM_CATEGORY_LABEL)).toEqual(['Medical', 'Travel', 'Meals', 'Equipment', 'Other']);
    expect(Object.keys(DOCUMENT_TYPE_LABEL)).toEqual(DOCUMENT_TYPES);
    expect(Object.values(DOCUMENT_TYPE_LABEL)).toEqual([
      'Contract', 'Tax form', 'Benefits', 'Identity', 'Medical', 'Certificate', 'Other',
    ]);
    expect(Object.keys(LETTER_TYPE_LABEL)).toEqual(LETTER_TYPES);
    expect(Object.values(LETTER_TYPE_LABEL)).toEqual([
      'Offer', 'Confirmation', 'Promotion', 'Warning', 'Contract renewal', 'Other',
    ]);
  });
});
