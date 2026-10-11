import { describe, expect, it } from 'vitest';
import {
  buildClaimsModel,
  buildLeaveModel,
  buildOtModel,
  buildTimeOffModel,
  canCancelPayRequest,
  canCancelRequest,
} from '@/lib/people/requests';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type LeaveRequest, type PeopleViewer, type TimeOffRequest } from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = '2026-10-09';
const data = createSeedPeopleData(NOW);

const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const HR2: PeopleViewer = { employeeId: 'seed-emp-2', isHr: true, isDemo: false };
const UNLINKED_HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER_E: PeopleViewer = { employeeId: 'e', isHr: false, isDemo: false };

const noNaN = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/NaN|Infinity/);

describe('buildLeaveModel', () => {
  it("gives an HR viewer linked to employee 2 employee 2's rows only", async () => {
    const [requests, balances] = await Promise.all([data.listLeaveRequests(), data.listLeaveBalances(2026)]);
    const model = buildLeaveModel(requests, balances, HR2, TODAY);
    if (!model.linked) throw new Error('expected linked');
    const mine = requests.filter((r) => r.employee_id === 'seed-emp-2');
    expect(model.rows).toHaveLength(mine.length);
    expect(model.rows.length).toBeLessThan(requests.length);
    expect(model.balances.length).toBeLessThanOrEqual(3);
  });

  it("builds the demo employee's model: 3 requests, 1 pending", async () => {
    const [requests, balances] = await Promise.all([data.listLeaveRequests(), data.listLeaveBalances(2026)]);
    const model = buildLeaveModel(requests, balances, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows).toHaveLength(3);
    expect(model.pending).toBe(1);
    expect(model.annual?.entitled).toBe(16);
    expect(model.used_ytd).toBe(model.by_type.reduce((sum, t) => sum + t.days, 0));
    noNaN(model);
  });

  it('is not linked without an employee', async () => {
    const [requests, balances] = await Promise.all([data.listLeaveRequests(), data.listLeaveBalances(2026)]);
    expect(buildLeaveModel(requests, balances, UNLINKED_HR, TODAY)).toEqual({ linked: false });
  });

  it('gives zeros and nulls for no rows', () => {
    const model = buildLeaveModel([], [], DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.annual).toBeNull();
    expect(model.medical).toBeNull();
    expect(model.used_ytd).toBe(0);
    expect(model.pending).toBe(0);
    expect(model.unpaid_days).toBe(0);
    expect(model.rows).toEqual([]);
    noNaN(model);
  });

  it('counts approved unpaid days this year and shows a dash for an unreadable applied date', () => {
    const model = buildLeaveModel(
      [
        { id: 'a', employee_id: 'e', employee_name: 'E', leave_type: 'unpaid', start_date: '2026-03-02', end_date: '2026-03-03', days: 2, half_day: false, reason: null, status: 'approved', decision_note: null, created_at: 'bad' },
        { id: 'b', employee_id: 'e', employee_name: 'E', leave_type: 'annual', start_date: '2025-12-30', end_date: '2025-12-31', days: 2, half_day: false, reason: null, status: 'approved', decision_note: null, created_at: '2025-12-01T00:00:00Z' },
      ],
      [],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.unpaid_days).toBe(2);
    expect(model.used_ytd).toBe(2);
    expect(model.rows.find((r) => r.id === 'a')?.applied).toBe('—');
  });

  it('works out the balance figures from the balance rows', () => {
    const model = buildLeaveModel(
      [],
      [
        { id: '1', employee_id: 'e', leave_type: 'annual', year: 2026, entitled_days: 16, used_days: 4 },
        { id: '2', employee_id: 'e', leave_type: 'medical', year: 2026, entitled_days: 14, used_days: 6 },
        { id: '3', employee_id: 'other', leave_type: 'annual', year: 2026, entitled_days: 99, used_days: 0 },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.annual).toEqual({ remaining: 12, entitled: 16 });
    expect(model.medical).toEqual({ taken: 6, entitled: 14 });
    expect(model.balances.map((b) => [b.label, b.percent])).toEqual([
      ['Annual leave', 25],
      ['Medical leave', 43],
    ]);
  });
});

describe("decision notes on the member's own rows", () => {
  const leave = (id: string, status: LeaveRequest['status'], decision_note: string | null): LeaveRequest => ({
    id, employee_id: 'e', employee_name: 'E', leave_type: 'annual', start_date: '2026-11-02', end_date: '2026-11-03', days: 2,
    half_day: false, reason: null, status, decision_note, created_at: '2026-10-01T00:00:00Z',
  });
  const off = (id: string, status: TimeOffRequest['status'], decision_note: string | null): TimeOffRequest => ({
    id, employee_id: 'e', employee_name: 'E', off_date: '2026-11-02', start_time: '09:00:00', end_time: '10:00:00', reason: null,
    status, decision_note, created_at: '2026-10-01T00:00:00Z',
  });

  it('carries the note for a rejected leave request and not otherwise', () => {
    const model = buildLeaveModel(
      [leave('a', 'rejected', 'Team is short'), leave('b', 'approved', 'Fine'), leave('c', 'rejected', null), leave('d', 'rejected', '  ')],
      [], MEMBER_E, TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    const note = (id: string) => model.rows.find((r) => r.id === id)?.note;
    expect(note('a')).toBe('Team is short');
    expect(note('b')).toBeNull();
    expect(note('c')).toBeNull();
    expect(note('d')).toBeNull();
  });

  it('carries the note for a rejected time-off request and not otherwise', () => {
    const model = buildTimeOffModel([off('a', 'rejected', 'Audit day'), off('b', 'pending', 'x'), off('c', 'rejected', null)], MEMBER_E, TODAY);
    if (!model.linked) throw new Error('expected linked');
    const note = (id: string) => model.rows.find((r) => r.id === id)?.note;
    expect(note('a')).toBe('Audit day');
    expect(note('b')).toBeNull();
    expect(note('c')).toBeNull();
  });
});

describe('buildTimeOffModel', () => {
  it("gives employee 2's rows only", async () => {
    const requests = await data.listTimeOffRequests();
    const model = buildTimeOffModel(requests, HR2, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows).toHaveLength(requests.filter((r) => r.employee_id === 'seed-emp-2').length);
  });

  it('counts the demo employee: two rows, none pending', async () => {
    const requests = await data.listTimeOffRequests();
    const model = buildTimeOffModel(requests, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows).toHaveLength(2);
    expect(model.pending).toBe(0);
    noNaN(model);
  });

  it('measures hours and durations from the times', () => {
    const base = { employee_id: 'e', employee_name: 'E', reason: null, decision_note: null, created_at: '2026-10-01T00:00:00Z' };
    const model = buildTimeOffModel(
      [
        { ...base, id: '1', off_date: '2026-10-03', start_time: '14:00:00', end_time: '16:30:00', status: 'approved' },
        { ...base, id: '2', off_date: '2026-10-05', start_time: '09:00:00', end_time: '10:00:00', status: 'pending' },
        { ...base, id: '3', off_date: '2026-09-05', start_time: '09:00:00', end_time: '10:00:00', status: 'approved' },
        { ...base, id: '4', off_date: '2026-10-06', start_time: '09:00:00', end_time: '10:00:00', status: 'cancelled' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.this_month).toBe(2);
    expect(model.approved).toBe(1);
    expect(model.pending).toBe(1);
    expect(model.hours).toBe(3.5);
    expect(model.rows.find((r) => r.id === '2')).toMatchObject({ from: '09:00', to: '10:00', duration: '1h' });
    expect(model.rows.find((r) => r.id === '1')?.duration).toBe('2.5h');
  });

  it('is not linked without an employee, and zero without rows', () => {
    expect(buildTimeOffModel([], UNLINKED_HR, TODAY)).toEqual({ linked: false });
    const model = buildTimeOffModel([], DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect([model.this_month, model.approved, model.pending, model.hours]).toEqual([0, 0, 0, 0]);
  });
});

describe('buildClaimsModel', () => {
  it("gives employee 2's rows only", async () => {
    const claims = await data.listClaims();
    const model = buildClaimsModel(claims, HR2, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows).toHaveLength(claims.filter((c) => c.employee_id === 'seed-emp-2').length);
  });

  it('counts a paid claim as approved', () => {
    const base = { employee_id: 'e', employee_name: 'E', description: null, has_receipt: true, decision_note: null, receipt_path: null, paid_on: null, paid_reference: null, created_at: '2026-10-01T00:00:00Z' };
    const model = buildClaimsModel(
      [
        { ...base, id: '1', category: 'travel', amount_cents: 10000, claim_date: '2026-10-02', status: 'approved' },
        { ...base, id: '2', category: 'travel', amount_cents: 4000, claim_date: '2026-10-03', status: 'paid', paid_on: '2026-10-05' },
        { ...base, id: '3', category: 'meals', amount_cents: 999, claim_date: '2026-10-04', status: 'rejected' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.approved_cents).toBe(14000);
    expect(model.claimed_cents).toBe(14999);
    expect(model.rows.find((r) => r.id === '2')?.status).toBe('paid');
  });

  it('adds up this month, leaving out cancelled claims, and splits by category', () => {
    const base = { employee_id: 'e', employee_name: 'E', description: null, has_receipt: true, decision_note: null, receipt_path: null, paid_on: null, paid_reference: null, created_at: '2026-10-01T00:00:00Z' };
    const model = buildClaimsModel(
      [
        { ...base, id: '1', category: 'travel', amount_cents: 10000, claim_date: '2026-10-02', status: 'approved' },
        { ...base, id: '2', category: 'meals', amount_cents: 2550, claim_date: '2026-10-03', status: 'pending' },
        { ...base, id: '3', category: 'meals', amount_cents: 999, claim_date: '2026-10-04', status: 'cancelled' },
        { ...base, id: '4', category: 'travel', amount_cents: 5000, claim_date: '2026-09-30', status: 'approved' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.claimed_cents).toBe(12550);
    expect(model.approved_cents).toBe(10000);
    expect(model.pending_cents).toBe(2550);
    expect(model.pending_count).toBe(1);
    expect(model.by_category.map((c) => [c.label, c.cents])).toEqual([['Travel', 10000], ['Meals', 2550]]);
    expect(model.by_category.map((c) => c.percent)).toEqual([80, 20]);
    expect(model.rows).toHaveLength(4);
  });

  it('is not linked without an employee, and zero without rows', () => {
    expect(buildClaimsModel([], UNLINKED_HR, TODAY)).toEqual({ linked: false });
    const model = buildClaimsModel([], DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect([model.claimed_cents, model.approved_cents, model.pending_cents, model.pending_count]).toEqual([0, 0, 0, 0]);
    expect(model.by_category).toEqual([]);
    noNaN(model);
  });
});

describe('buildOtModel', () => {
  it("gives employee 2's rows only", async () => {
    const records = await data.listOvertime();
    const model = buildOtModel(records, HR2, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows).toHaveLength(records.filter((r) => r.employee_id === 'seed-emp-2').length);
    expect(model.rows.length).toBeLessThan(records.length);
  });

  it('shows rate labels, a status per row, and the newest first', () => {
    const base = { employee_id: 'e', employee_name: 'E', hourly_rate_cents: 2500, day_kind: null, reason: null, decision_note: null, created_at: '2026-10-01T00:00:00Z' };
    const model = buildOtModel(
      [
        { ...base, id: '1', work_date: '2026-10-01', hours: 2, rate_multiplier: 1.5, amount_cents: 7500, status: 'approved' },
        { ...base, id: '2', work_date: '2026-10-05', hours: 4, rate_multiplier: 2, amount_cents: 20000, status: 'pending' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows.map((r) => r.id)).toEqual(['2', '1']);
    expect(model.rows[0]).toMatchObject({ rate: '2x', hours: 4 });
    expect(model.overtime.month.pending_hours).toBe(4);
    expect(model.overtime.month.approved_hours).toBe(2);
  });

  it('is not linked without an employee, and zero without rows', () => {
    expect(buildOtModel([], UNLINKED_HR, TODAY)).toEqual({ linked: false });
    const model = buildOtModel([], DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.overtime.month.hours).toBe(0);
    expect(model.overtime.by_rate).toEqual([]);
    expect(model.rows).toEqual([]);
    noNaN(model);
  });
});

describe('canCancelRequest', () => {
  it('allows a pending request, whatever its date', () => {
    expect(canCancelRequest('pending', '2026-10-01', TODAY)).toBe(true);
    expect(canCancelRequest('pending', '2026-12-01', TODAY)).toBe(true);
  });

  it('allows an approved request only when it starts after today', () => {
    expect(canCancelRequest('approved', '2026-10-10', TODAY)).toBe(true);
    expect(canCancelRequest('approved', TODAY, TODAY)).toBe(false);
    expect(canCancelRequest('approved', '2026-10-01', TODAY)).toBe(false);
  });

  it('never allows a rejected or cancelled request', () => {
    expect(canCancelRequest('rejected', '2026-12-01', TODAY)).toBe(false);
    expect(canCancelRequest('cancelled', '2026-12-01', TODAY)).toBe(false);
  });

  it('marks each leave and time-off row with the rule', () => {
    const leave = (start: string, status: 'pending' | 'approved'): LeaveRequest => ({
      id: `l-${status}-${start}`,
      employee_id: 'e',
      employee_name: 'E',
      leave_type: 'annual',
      start_date: start,
      end_date: start,
      days: 1,
      half_day: false,
      reason: null,
      status,
      decision_note: null,
      created_at: '2026-10-01T00:00:00Z',
    });
    const model = buildLeaveModel([leave('2026-10-20', 'approved'), leave('2026-10-05', 'approved')], [], MEMBER_E, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(Object.fromEntries(model.rows.map((r) => [r.id, r.cancellable]))).toEqual({
      'l-approved-2026-10-20': true,
      'l-approved-2026-10-05': false,
    });

    const off = (date: string, status: 'pending' | 'approved'): TimeOffRequest => ({
      id: `t-${status}-${date}`,
      employee_id: 'e',
      employee_name: 'E',
      off_date: date,
      start_time: '09:00:00',
      end_time: '11:00:00',
      reason: null,
      status,
      decision_note: null,
      created_at: '2026-10-01T00:00:00Z',
    });
    const timeOff = buildTimeOffModel([off('2026-10-20', 'pending'), off(TODAY, 'approved')], MEMBER_E, TODAY);
    if (!timeOff.linked) throw new Error('expected linked');
    expect(Object.fromEntries(timeOff.rows.map((r) => [r.id, r.cancellable]))).toEqual({
      't-pending-2026-10-20': true,
      [`t-approved-${TODAY}`]: false,
    });
  });
});

describe('canCancelPayRequest', () => {
  it('allows a claim or overtime request only while it is pending', () => {
    expect(canCancelPayRequest('pending')).toBe(true);
    for (const status of ['approved', 'rejected', 'cancelled', 'paid'] as const) {
      expect(canCancelPayRequest(status)).toBe(false);
    }
  });
});

describe('claim rows for the member', () => {
  const base = { employee_id: 'e', employee_name: 'E', description: null, has_receipt: false, decision_note: null, receipt_path: null, paid_on: null, paid_reference: null, created_at: '2026-10-01T00:00:00Z', category: 'travel' as const, amount_cents: 1000, claim_date: '2026-10-02' };

  it('marks only pending rows cancellable, never a paid one', () => {
    const model = buildClaimsModel(
      (['pending', 'approved', 'rejected', 'cancelled', 'paid'] as const).map((status) => ({ ...base, id: status, status })),
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows.filter((r) => r.cancellable).map((r) => r.id)).toEqual(['pending']);
  });

  it('carries the rejection note only for a rejected claim', () => {
    const model = buildClaimsModel(
      [
        { ...base, id: 'a', status: 'rejected', decision_note: ' No receipt ' },
        { ...base, id: 'b', status: 'approved', decision_note: 'Fine' },
        { ...base, id: 'c', status: 'rejected', decision_note: '  ' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    const note = (id: string) => model.rows.find((r) => r.id === id)?.note;
    expect(note('a')).toBe('No receipt');
    expect(note('b')).toBeNull();
    expect(note('c')).toBeNull();
  });

  it('says whether there is a file, and the date paid on a paid claim only', () => {
    const model = buildClaimsModel(
      [
        { ...base, id: 'f', status: 'approved', has_receipt: true, receipt_path: 'u/f.pdf' },
        { ...base, id: 't', status: 'approved', has_receipt: true },
        { ...base, id: 'p', status: 'paid', paid_on: '2026-10-08' },
        { ...base, id: 'q', status: 'approved', paid_on: '2026-10-08' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect([row('f').hasFile, row('f').receipt]).toEqual([true, true]);
    expect([row('t').hasFile, row('t').receipt]).toEqual([false, true]);
    expect([row('p').hasFile, row('p').receipt]).toEqual([false, false]);
    expect(row('p').paidOn).toBe('08 Oct 2026');
    expect(row('q').paidOn).toBeNull();
    expect(JSON.stringify(model)).not.toContain('u/f.pdf');
  });
});

describe('overtime rows for the member', () => {
  const base = { employee_id: 'e', employee_name: 'E', reason: null, decision_note: null, created_at: '2026-10-01T00:00:00Z', work_date: '2026-10-05', hours: 2, rate_multiplier: 1.5 };

  it('shows the kind of day, and "Not calculated" when there is no rate', () => {
    const model = buildOtModel(
      [
        { ...base, id: 'a', status: 'pending', day_kind: 'rest_day', hourly_rate_cents: 2500, amount_cents: 15000 },
        { ...base, id: 'b', status: 'pending', day_kind: null, hourly_rate_cents: null, amount_cents: 0 },
        { ...base, id: 'c', status: 'approved', day_kind: null, hourly_rate_cents: null, amount_cents: 7500 },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('a')).toMatchObject({ dayKind: 'Rest day', amount: 'RM 150.00' });
    expect(row('b')).toMatchObject({ dayKind: '—', amount: 'Not calculated' });
    // Made before the rate was stored: it has an amount and no rate, so it shows the amount.
    expect(row('c').amount).toBe('RM 75.00');
  });

  it('marks only pending rows cancellable and carries the rejection note', () => {
    const rate = { hourly_rate_cents: 2500, amount_cents: 7500, day_kind: 'weekday' as const };
    const model = buildOtModel(
      [
        { ...base, ...rate, id: 'p', status: 'pending' },
        { ...base, ...rate, id: 'x', status: 'rejected', decision_note: 'Not authorised' },
        { ...base, ...rate, id: 'o', status: 'approved', decision_note: 'ok' },
      ],
      MEMBER_E,
      TODAY,
    );
    if (!model.linked) throw new Error('expected linked');
    expect(model.rows.filter((r) => r.cancellable).map((r) => r.id)).toEqual(['p']);
    expect(model.rows.find((r) => r.id === 'x')?.note).toBe('Not authorised');
    expect(model.rows.find((r) => r.id === 'o')?.note).toBeNull();
  });
});
