import { describe, expect, it } from 'vitest';
import {
  APPROVAL_QUEUES,
  claimApprovals,
  leaveApprovals,
  managerOvertimeItem,
  overtimeApprovals,
  rowControls,
  screenControls,
  timeOffApprovals,
} from '@/lib/people/approvals';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { asManager } from './setup/people-manager-view';
import type {
  Claim,
  LeaveBalance,
  LeaveRequest,
  OvertimeRecord,
  PeopleData,
  PeopleViewer,
  TeamOvertimeRow,
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
    const model = (await overtimeApprovals(data, HR, NOW, null))!;
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
      expect(await build(THROWING, MEMBER, NOW, null)).toBeNull();
    }
  });
});

describe('an empty workspace', () => {
  it('gives empty queues and zeros, no NaN', async () => {
    const empty = withRows({});
    for (const build of [leaveApprovals, claimApprovals, overtimeApprovals, timeOffApprovals]) {
      const model = (await build(empty, HR, NOW, null))!;
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
    const o = (await overtimeApprovals(withRows({ listOvertime: [overtime({})] }), HR, NOW, null))!;
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
      null,
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
      listEmployees: async () => [],
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

  it("lets an admin decide anyone's request but their own, and an owner decide their own too", async () => {
    const rows = withRows({ listLeaveRequests: [leave({ id: 'a' }), leave({ id: 'b', employee_id: 'e2' })] });
    const admin: PeopleViewer = { employeeId: 'e1', isHr: true, isDemo: false };
    const asAdmin = (await leaveApprovals(rows, admin, NOW))!;
    expect(asAdmin.rows.find((r) => r.id === 'a')!.decidable).toBe(false);
    expect(asAdmin.rows.find((r) => r.id === 'b')!.decidable).toBe(true);
    // Withdrawing their own request is still theirs to do.
    expect(asAdmin.rows.find((r) => r.id === 'a')!.cancellable).toBe(true);

    const asOwner = (await leaveApprovals(rows, { ...admin, isOwner: true }, NOW))!;
    expect(asOwner.rows.map((r) => r.decidable)).toEqual([true, true]);

    // Not linked to an employee record: nothing is theirs, so everything can be decided.
    const unlinked = (await leaveApprovals(rows, HR, NOW))!;
    expect(unlinked.rows.map((r) => r.decidable)).toEqual([true, true]);
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
    const other = (await overtimeApprovals(withRows({}), HR, NOW, null))!;
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
      null,
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

// ---- the manager tier ----

const MANAGER: PeopleViewer = { employeeId: 'seed-emp-12', isHr: false, isDemo: false, managesTeam: true };
const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const OWNER: PeopleViewer = { employeeId: null, isHr: true, isOwner: true, isDemo: false };
const TEAM = [DEMO_EMPLOYEE_ID, 'seed-emp-5', 'seed-emp-10', 'seed-emp-11', 'seed-emp-13'];
const teamData = () => asManager(data, 'seed-emp-12', TEAM);

/** What `hr_team_overtime` hands over: the whole row minus every pay field. */
const toTeamRow = (r: OvertimeRecord): TeamOvertimeRow => ({
  id: r.id, org_id: 'org', employee_id: r.employee_id, work_date: r.work_date, hours: r.hours, day_kind: r.day_kind,
  rate_multiplier: r.rate_multiplier, reason: r.reason, status: r.status, requested_by: null, decided_by: null,
  decided_at: null, decision_note: r.decision_note, created_at: r.created_at,
});

const BASE = { pending: true, decidable: true, cancellable: true, status: 'pending' as const, claim: null };
const markable = { has_file: false, ticked: false, claim_date: '2026-10-01', year: 2026, year_total: null, markable: true, paid_on: null, paid_on_text: null, paid_reference: null };
const NONE = { decide: false, cancel: false, markPaid: false, undoPaid: false, disabled: false, note: null };

describe('rowControls', () => {
  it.each([
    ['hr', BASE, { ...NONE, decide: true, cancel: true }],
    ['hr', { ...BASE, decidable: false }, { ...NONE, cancel: true, note: 'own-admin' }],
    ['hr', { ...BASE, pending: false, status: 'approved' as const, claim: markable }, { ...NONE, cancel: true, markPaid: true }],
    ['hr', { ...BASE, pending: false, decidable: false, status: 'approved' as const, claim: markable }, { ...NONE, cancel: true, note: 'own-admin' }],
    ['hr', { ...BASE, pending: false, cancellable: false, status: 'paid' as const, claim: { ...markable, markable: false } }, { ...NONE, undoPaid: true }],
    ['hr', { ...BASE, pending: false, cancellable: false, status: 'rejected' as const }, NONE],
    ['demo', BASE, { ...NONE, decide: true, cancel: true, disabled: true }],
    ['manager', { ...BASE, decidable: true }, { ...NONE, decide: true }],
    ['manager', { ...BASE, pending: false, status: 'approved' as const, claim: markable }, NONE],
    ['manager', { ...BASE, pending: false, cancellable: false, status: 'paid' as const, claim: { ...markable, markable: false } }, NONE],
    ['manager', { ...BASE, pending: false, status: 'approved' as const }, NONE],
    ['none', BASE, NONE],
  ] as const)('%s: %#', (view, row, expected) => {
    expect(rowControls(view, row)).toEqual(expected);
  });
});

describe('screenControls', () => {
  it('answers each view', () => {
    expect(screenControls('hr', 'S')).toEqual({ addFor: true, export: true, disabled: false, subtitle: 'S' });
    expect(screenControls('demo', 'S')).toEqual({ addFor: true, export: true, disabled: true, subtitle: 'S' });
    expect(screenControls('manager', 'S')).toEqual({
      addFor: false, export: false, disabled: false, subtitle: 'Requests from the people who report to you',
    });
    expect(screenControls('none', 'S')).toEqual({ addFor: false, export: false, disabled: false, subtitle: 'S' });
  });
});

describe("a manager's queue", () => {
  const builders = {
    leave: (d: PeopleData, v: PeopleViewer) => leaveApprovals(d, v, NOW),
    claims: (d: PeopleData, v: PeopleViewer) => claimApprovals(d, v, NOW),
    overtime: async (d: PeopleData, v: PeopleViewer) => overtimeApprovals(d, v, NOW, (await data.listOvertime()).map(toTeamRow)),
    time_off: (d: PeopleData, v: PeopleViewer) => timeOffApprovals(d, v, NOW),
  };
  const employeeOf = async (queue: keyof typeof builders, id: string) => {
    const lists = {
      leave: await data.listLeaveRequests(), claims: await data.listClaims(),
      overtime: await data.listOvertime(), time_off: await data.listTimeOffRequests(),
    };
    return lists[queue].find((r) => r.id === id)!.employee_id;
  };

  it.each(Object.keys(builders) as (keyof typeof builders)[])('%s: team only, no HR controls', async (queue) => {
    const model = (await builders[queue](teamData(), MANAGER))!;
    expect(model).not.toBeNull();
    expect(model.view).toBe('manager');
    expect(model.rows.length).toBeGreaterThan(0);
    for (const row of model.rows) {
      expect(TEAM).toContain(await employeeOf(queue, row.id));
      expect(row).toMatchObject({ manager_label: null, cancellable: false, decidable: true, yours: false });
    }
  });

  it('counts pending over the team only, from the seed', async () => {
    const lists = {
      leave: await data.listLeaveRequests(), claims: await data.listClaims(),
      overtime: await data.listOvertime(), time_off: await data.listTimeOffRequests(),
    };
    for (const queue of Object.keys(builders) as (keyof typeof builders)[]) {
      const expected = lists[queue].filter((r) => r.status === 'pending' && TEAM.includes(r.employee_id)).length;
      expect((await builders[queue](teamData(), MANAGER))!.pending.count, queue).toBe(expected);
    }
  });

  it("drops the manager's own request and anyone else's the provider hands over", async () => {
    const mine = leave({ id: 'mine', employee_id: 'seed-emp-12', employee_name: 'Sales lead' });
    const stranger = leave({ id: 'stranger', employee_id: 'seed-emp-3', employee_name: 'Stranger' });
    const reports = leave({ id: 'report', employee_id: 'seed-emp-5', employee_name: 'Report' });
    const d = withRows({ listLeaveRequests: [mine, stranger, reports], listEmployees: await data.listEmployees() });
    const model = (await leaveApprovals(d, MANAGER, NOW))!;
    expect(model.rows.map((r) => r.id)).toEqual(['report']);
    expect(model.pending.count).toBe(1);
    expect(model.trend.reduce((sum, b) => sum + b.submitted, 0)).toBe(1);
  });

  it('claims: unpaid counts the team approved claims only', async () => {
    const claims = [
      claim({ id: 'a', employee_id: 'seed-emp-5', status: 'approved' }),
      claim({ id: 'b', employee_id: 'seed-emp-3', status: 'approved' }),
      claim({ id: 'c', employee_id: 'seed-emp-12', status: 'approved' }),
    ];
    const d = withRows({ listClaims: claims, listEmployees: await data.listEmployees() });
    const model = (await claimApprovals(d, MANAGER, NOW))!;
    expect(model.unpaid!.count).toBe(1);
    expect(model.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('overtime: the breakdown is over the team only', async () => {
    const rows = [
      { ...toTeamRow(overtime({ id: 'x', employee_id: 'seed-emp-5', hours: 3 })) },
      { ...toTeamRow(overtime({ id: 'y', employee_id: 'seed-emp-3', hours: 9 })) },
    ];
    const d = withRows({ listEmployees: await data.listEmployees() });
    const model = (await overtimeApprovals(d, MANAGER, NOW, rows))!;
    expect(model.rows.map((r) => r.id)).toEqual(['x']);
    expect(model.breakdown!.reduce((sum, b) => sum + b.value, 0)).toBe(3);
  });

  it("drops the manager's own claim, overtime and time-off request too", async () => {
    const employees = await data.listEmployees();
    const claims = await claimApprovals(
      withRows({ listEmployees: employees, listClaims: [claim({ id: 'own', employee_id: 'seed-emp-12' }), claim({ id: 'rep', employee_id: 'seed-emp-5' })] }),
      MANAGER, NOW,
    );
    expect(claims!.rows.map((r) => r.id)).toEqual(['rep']);
    const off = await timeOffApprovals(
      withRows({ listEmployees: employees, listTimeOffRequests: [timeOff({ id: 'own', employee_id: 'seed-emp-12' }), timeOff({ id: 'rep', employee_id: 'seed-emp-5' })] }),
      MANAGER, NOW,
    );
    expect(off!.rows.map((r) => r.id)).toEqual(['rep']);
    const ot = await overtimeApprovals(
      withRows({ listEmployees: employees }), MANAGER, NOW,
      [toTeamRow(overtime({ id: 'own', employee_id: 'seed-emp-12' })), toTeamRow(overtime({ id: 'rep', employee_id: 'seed-emp-5' }))],
    );
    expect(ot!.rows.map((r) => r.id)).toEqual(['rep']);
    expect(ot!.pending.count).toBe(1);
  });

  it('never reads the overtime table for a manager', async () => {
    const d = new Proxy(withRows({ listEmployees: await data.listEmployees() }), {
      get: (target, name) =>
        name === 'listOvertime'
          ? () => {
              throw new Error('the table was read');
            }
          : Reflect.get(target, name),
    });
    const model = await overtimeApprovals(d, MANAGER, NOW, [toTeamRow(overtime({ employee_id: 'seed-emp-5' }))]);
    expect(model!.rows).toHaveLength(1);
  });

  it('a manager with no employee record gets an empty queue and no throw', async () => {
    const nobody: PeopleViewer = { employeeId: null, isHr: false, isDemo: false, managesTeam: true };
    for (const queue of Object.keys(builders) as (keyof typeof builders)[]) {
      expect((await builders[queue](teamData(), nobody))!.rows, queue).toEqual([]);
    }
  });

  it('a member gets null and nothing is read', async () => {
    let called = false;
    const spy = new Proxy({} as PeopleData, { get: () => () => { called = true; return []; } });
    for (const build of [leaveApprovals, claimApprovals, overtimeApprovals, timeOffApprovals]) {
      expect(await build(spy, MEMBER, NOW, null)).toBeNull();
    }
    expect(called).toBe(false);
  });
});

describe("a manager's overtime row never shows money", () => {
  const row = toTeamRow(overtime({ id: 'o1', day_kind: 'rest_day', rate_multiplier: 2, reason: 'Launch', hours: 3.5 }));
  const MONEY = /amount|hourly|rate_cents|paid_month|payslip|RM\s?\d|paid at|Paid,/i;

  it('shows date, hours, day kind, multiplier, reason and status', () => {
    const item = managerOvertimeItem(row, 'Report');
    expect(item.cells).toEqual(['02 Oct 2026', '3.5 h', 'Rest day, 2 times']);
    expect(item.notes).toContain('Reason: Launch');
    expect(item.status).toBe('pending');
  });

  it('carries no money field and no money text', () => {
    const item = managerOvertimeItem(row, 'Report');
    expect(JSON.stringify(item)).not.toMatch(MONEY);
    expect(Object.keys(item).sort()).toEqual(
      ['cells', 'created_at', 'date', 'employee_id', 'employee_name', 'group', 'id', 'measure', 'notes', 'overtime', 'status', 'trend'],
    );
  });

  it('the whole model carries none either', async () => {
    const d = withRows({ listEmployees: await data.listEmployees() });
    const rows = [toTeamRow(overtime({ id: 'x', employee_id: 'seed-emp-5', hours: 3, day_kind: 'weekday' }))];
    const model = (await overtimeApprovals(d, MANAGER, NOW, rows))!;
    expect(JSON.stringify(model)).not.toMatch(MONEY);
    expect(model.rows[0].overtime).toEqual({ kind: 'Weekday, 1.5 times', calculated: true });
  });

  it('an old row without a kind or multiplier still shows no money', () => {
    const item = managerOvertimeItem({ ...row, day_kind: null, rate_multiplier: null }, 'Report');
    expect(item.cells[2]).toBe('—');
    expect(JSON.stringify(item)).not.toMatch(MONEY);
  });
});

describe('the manager on an HR row', () => {
  it('names the manager for owner and demo, and null for the lead', async () => {
    const employees = await data.listEmployees();
    const reqs = [
      leave({ id: 'r5', employee_id: 'seed-emp-5', employee_name: 'Five' }),
      leave({ id: 'r12', employee_id: 'seed-emp-12', employee_name: 'Lead' }),
    ];
    const d = withRows({ listLeaveRequests: reqs, listEmployees: employees });
    for (const viewer of [OWNER, DEMO]) {
      const model = (await leaveApprovals(d, viewer, NOW))!;
      expect(model.rows.find((r) => r.id === 'r5')!.manager_label).toBe('Farid Ismail');
      expect(model.rows.find((r) => r.id === 'r12')!.manager_label).toBeNull();
    }
  });

  it('says (inactive) after a manager who has left', async () => {
    const employees = (await data.listEmployees()).map((e) => (e.id === 'seed-emp-12' ? { ...e, status: 'inactive' as const } : e));
    const reqs = [leave({ id: 'r5', employee_id: 'seed-emp-5', employee_name: 'Five' })];
    const model = (await leaveApprovals(withRows({ listLeaveRequests: reqs, listEmployees: employees }), OWNER, NOW))!;
    expect(model.rows[0].manager_label).toBe('Farid Ismail (inactive)');
  });
});
