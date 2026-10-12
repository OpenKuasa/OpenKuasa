import { describe, expect, it } from 'vitest';
import {
  APPROVAL_QUEUES,
  claimApprovals,
  leaveApprovals,
  overtimeApprovals,
  timeOffApprovals,
} from '@/lib/people/approvals';
import { createSeedPeopleData } from '@/lib/people/seed';
import type {
  Claim,
  LeaveBalance,
  LeaveRequest,
  OvertimeRecord,
  PeopleData,
  PeopleViewer,
  TimeOffRequest,
} from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const data = createSeedPeopleData(NOW);

const HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-5', isHr: false, isDemo: false };

/** A PeopleData whose every read throws: proves a builder read nothing. */
const THROWING = new Proxy({} as PeopleData, {
  get: (_target, name) => () => {
    throw new Error(`unexpected read: ${String(name)}`);
  },
});

/** A PeopleData that serves the given rows and an empty list for everything else. */
const withRows = (rows: Partial<Record<keyof PeopleData, unknown>>): PeopleData =>
  new Proxy({} as PeopleData, {
    get: (_target, name) => async () => rows[name as keyof PeopleData] ?? [],
  });

const leave = (over: Partial<LeaveRequest>): LeaveRequest => ({
  id: 'l', employee_id: 'e1', employee_name: 'E One', leave_type: 'annual', start_date: '2026-10-05',
  end_date: '2026-10-06', days: 2, half_day: false, reason: null, status: 'pending', decision_note: null,
  created_at: '2026-10-01T02:00:00Z', ...over,
});
const claim = (over: Partial<Claim>): Claim => ({
  id: 'c', employee_id: 'e1', employee_name: 'E One', category: 'travel', amount_cents: 1000,
  claim_date: '2026-10-02', description: null, has_receipt: true, status: 'pending',
  decision_note: null, receipt_path: null, paid_on: null, paid_reference: null,
  created_at: '2026-10-02T02:00:00Z', ...over,
});
const overtime = (over: Partial<OvertimeRecord>): OvertimeRecord => ({
  id: 'o', employee_id: 'e1', employee_name: 'E One', work_date: '2026-10-02', hours: 2, rate_multiplier: 1.5,
  amount_cents: 7500, hourly_rate_cents: 2500, day_kind: null, reason: null, decision_note: null, status: 'pending', created_at: '2026-10-03T02:00:00Z', paid_month: null, ...over,
});
const timeOff = (over: Partial<TimeOffRequest>): TimeOffRequest => ({
  id: 't', employee_id: 'e1', employee_name: 'E One', off_date: '2026-10-05', start_time: '09:00:00',
  end_time: '10:30:00', reason: 'Bank', status: 'pending', decision_note: null,
  created_at: '2026-10-04T02:00:00Z', ...over,
});

describe('the sample data queues', () => {
  it('leave: 3 pending requests, newest first, broken down by type in days', async () => {
    const model = (await leaveApprovals(data, HR, NOW))!;
    expect(model.pending.count).toBe(3);
    expect(model.rows.filter((r) => r.pending)).toHaveLength(3);
    const created = model.rows.map((r) => r.created_at);
    expect(created).toEqual([...created].sort().reverse());
    expect(model.breakdown!.length).toBeGreaterThan(0);
    expect(model.trend).toHaveLength(8);
  });

  it('claims: 2 pending totalling RM 420.00, broken down by category in ringgit', async () => {
    const model = (await claimApprovals(data, HR, NOW))!;
    expect(model.pending.count).toBe(2);
    expect(model.pending.caption).toBe('RM 420.00');
    expect(model.breakdown!.map((b) => b.label).sort()).toEqual(['Medical', 'Travel']);
    expect(model.breakdown!.map((b) => b.text).sort()).toEqual(['RM 180.00', 'RM 240.00']);
  });

  it('overtime: 1 pending record of 4 hours, by department', async () => {
    const model = (await overtimeApprovals(data, HR, NOW))!;
    expect(model.pending.count).toBe(1);
    expect(model.pending.caption).toBe('4 h');
    expect(model.breakdown).toEqual([{ label: 'Operations', value: 4, text: '4 h' }]);
  });

  it('time-off: nothing pending and no breakdown', async () => {
    const model = (await timeOffApprovals(data, HR, NOW))!;
    expect(model.pending.count).toBe(0);
    expect(model.breakdown).toBeNull();
    expect(model.rows.length).toBeGreaterThan(0);
    expect(model.rows.every((r) => !r.pending)).toBe(true);
  });
});

describe('who may build', () => {
  it('a plain member gets null from every builder and nothing is read', async () => {
    for (const build of [leaveApprovals, claimApprovals, overtimeApprovals, timeOffApprovals]) {
      expect(await build(THROWING, MEMBER, NOW)).toBeNull();
    }
  });
});

describe('an empty workspace', () => {
  it('gives empty queues and zeros, no NaN', async () => {
    const empty = withRows({});
    for (const build of [leaveApprovals, claimApprovals, overtimeApprovals, timeOffApprovals]) {
      const model = (await build(empty, HR, NOW))!;
      expect(model.rows).toEqual([]);
      expect(model.pending.count).toBe(0);
      expect(model.approved.count).toBe(0);
      expect(model.rejected.count).toBe(0);
      expect(model.trend).toHaveLength(8);
      expect(model.trend.every((t) => t.submitted === 0 && t.approved === 0)).toBe(true);
      expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe('the queue rules', () => {
  it("counts approved and rejected by the request's own date, this month only", async () => {
    const model = (await leaveApprovals(
      withRows({
        listLeaveRequests: [
          leave({ id: 'a', status: 'approved', start_date: '2026-10-02', days: 3 }),
          leave({ id: 'b', status: 'approved', start_date: '2026-09-28', days: 1 }),
          leave({ id: 'c', status: 'rejected', start_date: '2026-10-20', days: 1 }),
          leave({ id: 'd', status: 'cancelled', start_date: '2026-10-03' }),
        ],
      }),
      HR,
      NOW,
    ))!;
    expect(model.approved.count).toBe(1);
    expect(model.approved.caption).toBe('3 days');
    expect(model.rejected.count).toBe(1);
    expect(model.pending.count).toBe(0);
    expect(model.rows.find((r) => r.id === 'd')!.pending).toBe(false);
    expect(model.rows.find((r) => r.id === 'd')!.status_label).toBe('Cancelled');
  });

  it('buckets by created_at in Malaysia time and counts those approved now as "approved since"', async () => {
    // 2026-10-04T17:00Z is Monday 05 Oct 01:00 in Malaysia, so the 05 Oct week, not the 28 Sep week.
    const model = (await leaveApprovals(
      withRows({
        listLeaveRequests: [
          leave({ id: 'a', created_at: '2026-10-04T17:00:00Z', status: 'approved' }),
          leave({ id: 'b', created_at: '2026-10-05T02:00:00Z', status: 'pending' }),
          leave({ id: 'c', created_at: '2026-09-29T02:00:00Z', status: 'rejected' }),
          leave({ id: 'd', created_at: '2026-01-01T02:00:00Z', status: 'approved' }),
        ],
      }),
      HR,
      NOW,
    ))!;
    const last = model.trend.at(-1)!;
    expect(last.label).toBe('05 Oct');
    expect(last.submitted).toBe(2);
    expect(last.approved).toBe(1);
    const previous = model.trend.at(-2)!;
    expect(previous.submitted).toBe(1);
    expect(previous.approved).toBe(0);
    expect(model.trend.reduce((n, t) => n + t.submitted, 0)).toBe(3);
  });

  it('values the claims trend in ringgit and survives a bad created_at', async () => {
    const model = (await claimApprovals(
      withRows({
        listClaims: [
          claim({ id: 'a', created_at: '2026-10-06T02:00:00Z', amount_cents: 12_550, status: 'approved' }),
          claim({ id: 'b', created_at: 'not a date', amount_cents: 999 }),
        ],
      }),
      HR,
      NOW,
    ))!;
    expect(model.trend.at(-1)).toMatchObject({ submitted: 125.5, approved: 125.5 });
    expect(model.rows).toHaveLength(2);
  });

  it('counts a paid claim wherever an approved one counts, and keeps it from being cancelled', async () => {
    const model = (await claimApprovals(
      withRows({
        listClaims: [
          claim({ id: 'a', status: 'approved', amount_cents: 1000 }),
          claim({ id: 'p', status: 'paid', amount_cents: 2500, created_at: '2026-10-06T02:00:00Z' }),
          claim({ id: 'r', status: 'rejected' }),
        ],
      }),
      HR,
      NOW,
    ))!;
    expect(model.approved).toEqual({ count: 2, caption: 'RM 35.00' });
    expect(model.trend.at(-1)).toMatchObject({ approved: 25 });
    const paid = model.rows.find((r) => r.id === 'p')!;
    expect(paid).toMatchObject({ status: 'paid', status_label: 'Paid', pending: false, cancellable: false });
    expect(model.rows.find((r) => r.id === 'a')!.cancellable).toBe(true);
  });

  it('formats the middle cells for each queue', async () => {
    const l = (await leaveApprovals(withRows({ listLeaveRequests: [leave({})] }), HR, NOW))!;
    expect(l.rows[0].cells).toEqual(['Annual leave', '05 Oct–06 Oct', '2']);
    const c = (await claimApprovals(withRows({ listClaims: [claim({})] }), HR, NOW))!;
    expect(c.rows[0].cells).toEqual(['Travel', 'RM 10.00', '02 Oct 2026']);
    const o = (await overtimeApprovals(withRows({ listOvertime: [overtime({})] }), HR, NOW))!;
    expect(o.rows[0].cells).toEqual(['02 Oct 2026', '2 h', 'RM 75.00']);
    const t = (await timeOffApprovals(withRows({ listTimeOffRequests: [timeOff({ reason: null })] }), HR, NOW))!;
    expect(t.rows[0].cells).toEqual(['05 Oct 2026', '1.5 h', '—']);
    expect(t.pending.caption).toBe('1.5 h');
  });

  it("puts overtime from someone with no department under Unassigned", async () => {
    const model = (await overtimeApprovals(
      withRows({
        listOvertime: [overtime({ id: 'a', employee_id: 'x' }), overtime({ id: 'b', employee_id: 'x' })],
        listEmployees: [{ id: 'x', department_name: null }],
      }),
      HR,
      NOW,
    ))!;
    expect(model.breakdown).toEqual([{ label: 'Unassigned', value: 4, text: '4 h' }]);
    expect(model.pending.count).toBe(2);
  });

  it('has one config per queue, with a right-aligned flag per middle column', () => {
    expect(Object.keys(APPROVAL_QUEUES).sort()).toEqual(['claims', 'leave', 'overtime', 'time_off']);
    for (const queue of Object.values(APPROVAL_QUEUES)) expect(queue.columns.length).toBe(3);
  });
});

describe('over balance, yours and cancel on the leave queue', () => {
  const balance = (over: Partial<LeaveBalance>): LeaveBalance => ({
    id: 'b', employee_id: 'e1', leave_type: 'annual', year: 2026, entitled_days: 10, used_days: 8, ...over,
  });

  it('flags a pending request by what it exceeds the balance by', async () => {
    const model = (await leaveApprovals(
      withRows({
        listLeaveRequests: [leave({ id: 'a', days: 5 }), leave({ id: 'b', employee_id: 'e2', days: 1 })],
        listLeaveBalances: [balance({}), balance({ employee_id: 'e2', used_days: 0 })],
      }),
      HR,
      NOW,
    ))!;
    expect(model.rows.find((r) => r.id === 'a')!.over_by).toBe(3);
    expect(model.rows.find((r) => r.id === 'b')!.over_by).toBe(0);
  });

  it('does not flag a decided request, and counts other pending requests against the balance', async () => {
    const model = (await leaveApprovals(
      withRows({
        listLeaveRequests: [
          leave({ id: 'a', days: 5, status: 'approved' }),
          leave({ id: 'b', days: 1, status: 'pending' }),
          leave({ id: 'c', days: 1, status: 'pending', start_date: '2026-11-02', end_date: '2026-11-02' }),
        ],
        listLeaveBalances: [balance({ entitled_days: 10, used_days: 8 })],
      }),
      HR,
      NOW,
    ))!;
    expect(model.rows.find((r) => r.id === 'a')!.over_by).toBe(0);
    // 10 - 8 - 1 (the other pending request) = 1 left, so one more day does not exceed it.
    expect(model.rows.find((r) => r.id === 'b')!.over_by).toBe(0);
  });

  it('reads the balances of each year a pending request starts in, and nothing for a plain member', async () => {
    const years: number[] = [];
    const requests = [
      leave({ id: 'a', start_date: '2026-12-30' }),
      leave({ id: 'b', start_date: '2027-01-05', end_date: '2027-01-05' }),
      leave({ id: 'c', start_date: '2026-03-02', status: 'approved' }),
    ];
    const spy = {
      listLeaveRequests: async () => requests,
      listLeaveBalances: async (year: number) => {
        years.push(year);
        return [];
      },
    } as unknown as PeopleData;
    await leaveApprovals(spy, HR, NOW);
    expect(years.sort()).toEqual([2026, 2027]);
    years.length = 0;
    expect(await leaveApprovals(spy, MEMBER, NOW)).toBeNull();
    expect(years).toEqual([]);
  });

  it("marks the viewer's own request yours", async () => {
    const viewer: PeopleViewer = { employeeId: 'e1', isHr: true, isDemo: false };
    const model = (await leaveApprovals(
      withRows({ listLeaveRequests: [leave({ id: 'a' }), leave({ id: 'b', employee_id: 'e2' })] }),
      viewer,
      NOW,
    ))!;
    expect(model.rows.find((r) => r.id === 'a')!.yours).toBe(true);
    expect(model.rows.find((r) => r.id === 'b')!.yours).toBe(false);
    const unlinked = (await leaveApprovals(withRows({ listLeaveRequests: [leave({})] }), HR, NOW))!;
    expect(unlinked.rows[0].yours).toBe(false);
  });

  it('allows cancel on everything but a cancelled request, on leave and time-off', async () => {
    const l = (await leaveApprovals(
      withRows({
        listLeaveRequests: [
          leave({ id: 'p' }),
          leave({ id: 'a', status: 'approved' }),
          leave({ id: 'r', status: 'rejected' }),
          leave({ id: 'c', status: 'cancelled' }),
        ],
      }),
      HR,
      NOW,
    ))!;
    expect(l.rows.map((r) => [r.id, r.cancellable]).sort()).toEqual([['a', true], ['c', false], ['p', true], ['r', true]]);
    const t = (await timeOffApprovals(
      withRows({ listTimeOffRequests: [timeOff({ id: 'x' }), timeOff({ id: 'y', status: 'cancelled' })] }),
      HR,
      NOW,
    ))!;
    expect(t.rows.find((r) => r.id === 'x')!.cancellable).toBe(true);
    expect(t.rows.find((r) => r.id === 'y')!.cancellable).toBe(false);
  });

  it('every queue decides', () => {
    expect(Object.fromEntries(Object.entries(APPROVAL_QUEUES).map(([k, v]) => [k, v.decides]))).toEqual({
      leave: true,
      claims: true,
      overtime: true,
      time_off: true,
    });
  });
});

describe('claim rows', () => {
  const claims = [
    claim({ id: 'a', status: 'approved', amount_cents: 1000, receipt_path: 'u/f.pdf' }),
    claim({ id: 'p', status: 'paid', amount_cents: 2500, paid_on: '2026-10-05', paid_reference: 'TRX-9' }),
    claim({ id: 'n', status: 'pending', amount_cents: 400, has_receipt: false, claim_date: '2026-10-03' }),
    claim({ id: 'x', status: 'rejected', decision_note: 'No receipt' }),
    claim({ id: 'o', status: 'approved', employee_id: 'e2', amount_cents: 9900 }),
    claim({ id: 'y', status: 'paid', amount_cents: 700, claim_date: '2025-10-02' }),
  ];
  const build = async () => (await claimApprovals(withRows({ listClaims: claims }), HR, NOW))!;

  it("shows the year's approved-or-paid total from the one shared formula, not counting the claim itself", async () => {
    const model = await build();
    // approved 1000 + paid 2500 of e1 / travel in 2026; the 2025 one and e2's are out
    expect(model.rows.find((r) => r.id === 'n')!.claim!.year_total).toBe('RM 35.00');
    expect(model.rows.find((r) => r.id === 'a')!.claim!.year_total).toBe('RM 25.00');
  });

  it("labels the total with the claim's own year, and shows it only on pending and approved rows", async () => {
    const model = await build();
    const detail = (id: string) => model.rows.find((r) => r.id === id)!.claim!;
    expect(detail('n').year).toBe(2026);
    expect(detail('a').year).toBe(2026);
    // The 2025 claim is paid: no total, and its year is its own.
    expect(detail('y').year).toBe(2025);
    for (const id of ['p', 'x', 'y']) expect(detail(id).year_total, id).toBeNull();
    for (const id of ['n', 'a']) expect(detail(id).year_total, id).not.toBeNull();
  });

  it('has no total at all when nothing else was approved or paid that year', async () => {
    const model = await build();
    // e2's only claim: the total would be RM 0.00, which is not worth a line.
    expect(model.rows.find((r) => r.id === 'o')!.claim!.year_total).toBeNull();
  });

  it('knows the receipt, which rows can be marked paid, and the paid date and reference', async () => {
    const model = await build();
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('a').claim).toMatchObject({ has_file: true, ticked: true, markable: true, paid_on: null });
    expect(row('n').claim).toMatchObject({ has_file: false, ticked: false, markable: false });
    expect(row('p').claim).toMatchObject({ markable: false, paid_on: '2026-10-05', paid_on_text: '05 Oct 2026' });
    expect(row('p').notes).toEqual(['Reference: TRX-9']);
    expect(row('x').notes).toEqual(['Note: No receipt']);
    expect(row('p').cancellable).toBe(false);
  });

  it('adds the tile of approved claims not yet paid, only on the claims queue', async () => {
    const model = await build();
    expect(model.unpaid).toEqual({ count: 2, caption: 'RM 109.00' });
    const other = (await overtimeApprovals(withRows({}), HR, NOW))!;
    expect(other.unpaid).toBeNull();
    expect(other.rows.every((r) => r.claim === null)).toBe(true);
  });
});

describe('overtime rows', () => {
  it('shows the kind of day and multiplier, and "Not calculated" when no salary was on file', async () => {
    const model = (await overtimeApprovals(
      withRows({
        listOvertime: [
          overtime({ id: 'a', day_kind: 'rest_day', rate_multiplier: 2 }),
          overtime({ id: 'b', day_kind: 'weekday', hourly_rate_cents: null, amount_cents: 0, decision_note: 'Too late' }),
          overtime({ id: 'c', day_kind: null }),
          overtime({ id: 'd', hourly_rate_cents: null, amount_cents: 7500 }),
        ],
      }),
      HR,
      NOW,
    ))!;
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('a').overtime).toEqual({ kind: 'Rest day, paid at 2 times', calculated: true });
    expect(row('a').cells[2]).toBe('RM 75.00');
    expect(row('b').overtime).toEqual({ kind: 'Weekday, paid at 1.5 times', calculated: false });
    expect(row('b').cells[2]).toBe('Not calculated');
    expect(row('b').notes).toEqual(['Note: Too late']);
    expect(row('c').overtime!.kind).toBe('Paid at 1.5 times');
    // Made before the rate was stored: the amount is real, so it is shown.
    expect(row('d').cells[2]).toBe('RM 75.00');
    expect(row('d').overtime!.calculated).toBe(true);
    expect(model.unpaid).toBeNull();
  });
});
