import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEAVE_REFUSALS,
  applyLeave,
  applyLeaveInput,
  applyTimeOff,
  cancelLeave,
  cancelTimeOff,
  decideLeave,
  decideTimeOff,
  overBalanceBy,
  previewLeave,
  setLeaveEntitlement,
} from '@/lib/people/leave';
import type { LeaveBalance, LeaveRequest } from '@/lib/people/types';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = 'org-1';
const EMP = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';

afterEach(() => vi.restoreAllMocks());

describe('LEAVE_REFUSALS', () => {
  it('has the spec sentence for every code the database raises', () => {
    expect(LEAVE_REFUSALS).toEqual({
      LEAVE_NOT_ALLOWED: "You can't make that change.",
      LEAVE_OVERLAP: 'That overlaps leave already applied for on those dates.',
      LEAVE_NO_WORKING_DAY: 'Those dates have no working day in them.',
      LEAVE_NOT_PENDING: 'That request has already been decided or cancelled.',
      LEAVE_ALREADY_STARTED: 'That leave has already started. Ask an owner or admin to cancel it.',
      LEAVE_INACTIVE_EMPLOYEE: 'That employee is inactive.',
      LEAVE_NOT_FOUND: 'That request was not found.',
      LEAVE_BAD_INPUT: "That request isn't valid. Check the dates and try again.",
    });
  });
});

const LEAVE = { employee_id: EMP, leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' } as const;

describe('the calls each function makes', () => {
  it('previews with the database parameter names and sends no reason', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_leave_preview': {
        data: { days: 3, over_by: 0, years: [{ year: 2026, days: 3, entitled: 14, used: 2, pending: 1, remaining_after: 8 }] },
      },
    });
    const result = await previewLeave(ctxOf(client), { ...LEAVE, reason: 'secret' } as never);
    expect(result).toEqual({
      ok: true,
      data: { days: 3, over_by: 0, years: [{ year: 2026, days: 3, entitled: 14, used: 2, pending: 1, remaining_after: 8 }] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: 'hr_leave_preview',
      args: { p_employee: EMP, p_leave_type: 'annual', p_start: '2026-10-20', p_end: '2026-10-22', p_half_day: false },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_employee', 'p_end', 'p_half_day', 'p_leave_type', 'p_start']);
  });

  it('applies for leave, with the reason trimmed and an empty one sent as null', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_apply_leave': { data: { id: REQ, days: 3, status: 'pending' } } });
    expect(await applyLeave(ctxOf(client), { ...LEAVE, reason: '  family  ' })).toEqual({
      ok: true,
      data: { id: REQ, days: 3, status: 'pending' },
    });
    await applyLeave(ctxOf(client), { ...LEAVE, reason: '   ' });
    expect(calls[0]).toMatchObject({ fn: 'hr_apply_leave', args: { p_reason: 'family', p_half_day: false } });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_employee', 'p_end', 'p_half_day', 'p_leave_type', 'p_reason', 'p_start']);
    expect(calls[1].args).toMatchObject({ p_reason: null });
  });

  it('sends a half day through', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_apply_leave': { data: { id: REQ, days: 0.5, status: 'pending' } } });
    await applyLeave(ctxOf(client), { ...LEAVE, end_date: '2026-10-20', half_day: true });
    expect(calls[0].args).toMatchObject({ p_half_day: true });
  });

  it('applies for time-off with times as HH:MM', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_apply_time_off': { data: { id: REQ, status: 'pending', start_time: '09:00:00' } } });
    expect(
      await applyTimeOff(ctxOf(client), { employee_id: EMP, off_date: '2026-10-20', start_time: '09:00', end_time: '10:30', reason: 'Bank' }),
    ).toEqual({ ok: true, data: { id: REQ, status: 'pending' } });
    expect(calls[0]).toMatchObject({
      fn: 'hr_apply_time_off',
      args: { p_employee: EMP, p_off_date: '2026-10-20', p_start_time: '09:00', p_end_time: '10:30', p_reason: 'Bank' },
    });
  });

  it('refuses a time with seconds, and an end that is not after the start, before any call', async () => {
    const { client, calls } = fakeSupabase();
    const base = { employee_id: EMP, off_date: '2026-10-20' };
    const seconds = await applyTimeOff(ctxOf(client), { ...base, start_time: '09:00:00', end_time: '10:00' });
    expect(seconds.ok).toBe(false);
    expect(await applyTimeOff(ctxOf(client), { ...base, start_time: '10:00', end_time: '10:00' })).toEqual({
      ok: false,
      error: LEAVE_REFUSALS.LEAVE_BAD_INPUT,
    });
    expect(calls).toEqual([]);
  });

  it('cancels leave and time-off by request id', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_cancel_leave': { data: { id: REQ, status: 'cancelled' } },
      'rpc.hr_cancel_time_off': { data: { id: REQ, status: 'cancelled' } },
    });
    expect(await cancelLeave(ctxOf(client), { id: REQ })).toEqual({ ok: true, data: { id: REQ, status: 'cancelled' } });
    expect(await cancelTimeOff(ctxOf(client), { id: REQ })).toEqual({ ok: true, data: { id: REQ, status: 'cancelled' } });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_cancel_leave', { p_request: REQ }],
      ['hr_cancel_time_off', { p_request: REQ }],
    ]);
  });

  it('decides leave and time-off, sending the note only as given', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_decide_leave': { data: { id: REQ, status: 'rejected' } },
      'rpc.hr_decide_time_off': { data: { id: REQ, status: 'approved' } },
    });
    expect(await decideLeave(ctxOf(client), { id: REQ, approve: false, note: ' Busy week ' })).toEqual({
      ok: true,
      data: { id: REQ, status: 'rejected' },
    });
    expect(await decideTimeOff(ctxOf(client), { id: REQ, approve: true })).toEqual({ ok: true, data: { id: REQ, status: 'approved' } });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_decide_leave', { p_request: REQ, p_approve: false, p_note: 'Busy week' }],
      ['hr_decide_time_off', { p_request: REQ, p_approve: true, p_note: null }],
    ]);
  });

  it('sets an entitlement', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_set_leave_entitlement': {
        data: { employee_id: EMP, leave_type: 'annual', year: 2026, entitled_days: 18, used_days: 2 },
      },
    });
    expect(await setLeaveEntitlement(ctxOf(client), { employee_id: EMP, leave_type: 'annual', year: 2026, days: 18 })).toEqual({
      ok: true,
      data: { employee_id: EMP, leave_type: 'annual', year: 2026, entitled_days: 18 },
    });
    expect(calls[0]).toMatchObject({
      fn: 'hr_set_leave_entitlement',
      args: { p_employee: EMP, p_leave_type: 'annual', p_year: 2026, p_days: 18 },
    });
  });
});

describe('input checks happen before any call', () => {
  it.each([
    ['an id that is not a uuid', { ...LEAVE, employee_id: 'nope' }],
    ['a date that does not exist', { ...LEAVE, end_date: '2026-02-31' }],
    ['a kind of leave that does not exist', { ...LEAVE, leave_type: 'sabbatical' }],
    ['an end before the start', { ...LEAVE, start_date: '2026-10-22', end_date: '2026-10-20' }],
    ['a half day over several dates', { ...LEAVE, half_day: true }],
    ['a reason over 500 characters', { ...LEAVE, reason: 'x'.repeat(501) }],
  ])('refuses %s', async (_name, input) => {
    const { client, calls } = fakeSupabase();
    const result = await applyLeave(ctxOf(client), input as never);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('accepts an id that is a valid uuid but not RFC-versioned', () => {
    expect(applyLeaveInput.safeParse({ ...LEAVE, employee_id: '00000000-0000-0000-0000-000000000001' }).success).toBe(true);
  });

  it('refuses an entitlement that is not in half days, negative, or over a year', async () => {
    const { client, calls } = fakeSupabase();
    for (const days of [0.3, -1, 366]) {
      expect((await setLeaveEntitlement(ctxOf(client), { employee_id: EMP, leave_type: 'annual', year: 2026, days })).ok).toBe(false);
    }
    expect((await setLeaveEntitlement(ctxOf(client), { employee_id: EMP, leave_type: 'unpaid' as never, year: 2026, days: 1 })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('what a refusal looks like to the caller', () => {
  const runs: [string, string, (client: never) => Promise<unknown>][] = [
    ['previewLeave', 'hr_leave_preview', (c) => previewLeave(ctxOf(c), LEAVE)],
    ['applyLeave', 'hr_apply_leave', (c) => applyLeave(ctxOf(c), LEAVE)],
    [
      'applyTimeOff',
      'hr_apply_time_off',
      (c) => applyTimeOff(ctxOf(c), { employee_id: EMP, off_date: '2026-10-20', start_time: '09:00', end_time: '10:00' }),
    ],
    ['cancelLeave', 'hr_cancel_leave', (c) => cancelLeave(ctxOf(c), { id: REQ })],
    ['cancelTimeOff', 'hr_cancel_time_off', (c) => cancelTimeOff(ctxOf(c), { id: REQ })],
    ['decideLeave', 'hr_decide_leave', (c) => decideLeave(ctxOf(c), { id: REQ, approve: true })],
    ['decideTimeOff', 'hr_decide_time_off', (c) => decideTimeOff(ctxOf(c), { id: REQ, approve: true })],
    [
      'setLeaveEntitlement',
      'hr_set_leave_entitlement',
      (c) => setLeaveEntitlement(ctxOf(c), { employee_id: EMP, leave_type: 'annual', year: 2026, days: 14 }),
    ],
  ];

  it.each(Object.entries(LEAVE_REFUSALS))('%s reaches the caller as its sentence, from every function', async (code, sentence) => {
    for (const [name, rpc, run] of runs) {
      const { client } = fakeSupabase({ [`rpc.${rpc}`]: { error: { code: 'P0001', message: code } } });
      expect(await run(client), name).toEqual({ ok: false, error: sentence });
    }
  });

  it('matches on the leading code, so text after it does not matter', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_apply_leave': { error: { code: 'P0001', message: 'LEAVE_OVERLAP: anything' } } });
    expect(await applyLeave(ctxOf(client), LEAVE)).toEqual({ ok: false, error: LEAVE_REFUSALS.LEAVE_OVERLAP });
  });

  it('answers an unknown database error generically and logs only its code and message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_apply_leave': { error: { code: '57014', message: 'canceling statement due to timeout' } } });
    const result = await applyLeave(ctxOf(client), { ...LEAVE, reason: 'my private reason' });
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(['[people-capability] applyLeave failed:', '57014', 'canceling statement due to timeout']);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private reason');
  });

  it('does not treat a message that merely mentions a code as that code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_apply_leave': { error: { message: 'oops LEAVE_OVERLAP' } } });
    expect(await applyLeave(ctxOf(client), LEAVE)).toEqual({ ok: false, error: GENERIC });
  });

  it('answers generically, and logs, when the reply is not what the function promises', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_cancel_leave': { data: null } });
    expect(await cancelLeave(ctxOf(client), { id: REQ })).toEqual({ ok: false, error: GENERIC });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('overBalanceBy', () => {
  const balance = (over: Partial<LeaveBalance> = {}): LeaveBalance => ({
    id: 'b', employee_id: 'e1', leave_type: 'annual', year: 2026, entitled_days: 14, used_days: 10, ...over,
  });
  const request = (over: Partial<LeaveRequest> = {}): LeaveRequest => ({
    id: 'r1', employee_id: 'e1', employee_name: 'E', leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22',
    days: 3, half_day: false, reason: null, status: 'pending', decision_note: null, created_at: '2026-10-01T00:00:00Z', ...over,
  });

  it('is 0 within balance, including when it uses exactly what is left', () => {
    expect(overBalanceBy(request({ days: 3 }), [balance()], [request()])).toBe(0);
    expect(overBalanceBy(request({ days: 4 }), [balance()], [request({ days: 4 })])).toBe(0);
  });

  it('is the shortfall when over', () => {
    expect(overBalanceBy(request({ days: 5 }), [balance()], [request({ days: 5 })])).toBe(1);
    expect(overBalanceBy(request({ days: 5.5 }), [balance({ entitled_days: 14, used_days: 12 })], [request({ days: 5.5 })])).toBe(3.5);
  });

  it("counts the same employee's other pending requests of that type and year, not this one, nor others' or other kinds'", () => {
    const mine = request({ id: 'r1', days: 2 });
    const requests = [
      mine,
      request({ id: 'r2', days: 2 }),
      request({ id: 'r3', days: 5, employee_id: 'e2' }),
      request({ id: 'r4', days: 5, leave_type: 'medical' }),
      request({ id: 'r5', days: 5, start_date: '2025-12-30' }),
      request({ id: 'r6', days: 5, status: 'approved' }),
      request({ id: 'r7', days: 5, status: 'rejected' }),
    ];
    // left = 14 - 10 - 2 (r2 only) = 2; this one is 2 days
    expect(overBalanceBy(mine, [balance()], requests)).toBe(0);
    expect(overBalanceBy({ ...mine, days: 3 }, [balance()], requests)).toBe(1);
  });

  it('is 0 for a type with no balance', () => {
    expect(overBalanceBy(request({ leave_type: 'unpaid', days: 30 }), [balance()], [])).toBe(0);
    expect(overBalanceBy(request({ leave_type: 'maternity', days: 90 }), [balance({ leave_type: 'maternity' })], [])).toBe(0);
  });

  it('is 0 when there is no balance row for that employee, kind and year', () => {
    expect(overBalanceBy(request({ days: 20 }), [], [])).toBe(0);
    expect(overBalanceBy(request({ days: 20 }), [balance({ year: 2025 })], [])).toBe(0);
    expect(overBalanceBy(request({ days: 20 }), [balance({ employee_id: 'e2' })], [])).toBe(0);
  });

  it('is 0 for a request that is not pending, since its days are already in used_days', () => {
    expect(overBalanceBy(request({ days: 20, status: 'approved' }), [balance()], [])).toBe(0);
    expect(overBalanceBy(request({ days: 20, status: 'cancelled' }), [balance()], [])).toBe(0);
  });

  it('measures a request that crosses New Year against the year it starts in', () => {
    const crossing = request({ start_date: '2026-12-29', end_date: '2027-01-02', days: 4 });
    expect(overBalanceBy(crossing, [balance({ used_days: 12 }), balance({ year: 2027, used_days: 0 })], [crossing])).toBe(2);
  });
});
