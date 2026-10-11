import { afterEach, describe, expect, it, vi } from 'vitest';
import * as leave from '@/lib/people/leave';
import {
  PAY_REFUSALS,
  approvedThisYear,
  cancelClaim,
  cancelOvertime,
  decideClaim,
  decideInput,
  decideOvertime,
  markClaimPaid,
  markClaimPaidInput,
  previewOvertime,
  requestIdInput,
  ringgitToSen,
  submitClaim,
  submitClaimInput,
  submitOvertime,
  unmarkClaimPaid,
} from '@/lib/people/pay-requests';
import type { Claim } from '@/lib/people/types';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = 'org-1';
const EMP = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';
const RECEIPT = '11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444.pdf';

afterEach(() => vi.restoreAllMocks());

const CLAIM = { employee_id: EMP, category: 'travel', amount_cents: 8500, claim_date: '2026-10-09' } as const;
const OVERTIME = { employee_id: EMP, work_date: '2026-10-09', hours: 2.5 } as const;

describe('PAY_REFUSALS', () => {
  it('has the spec sentence for every code the database raises', () => {
    expect(PAY_REFUSALS).toEqual({
      PAY_NOT_ALLOWED: "You can't make that change.",
      PAY_NOT_FOUND: 'That request was not found.',
      PAY_NOT_PENDING: 'That request has already been decided or cancelled.',
      PAY_NOT_APPROVED: 'Only an approved claim can be marked as paid.',
      PAY_NOT_PAID: 'That claim is not marked as paid.',
      PAY_ALREADY_PAID: 'That claim is marked as paid. Undo the paid mark first.',
      PAY_INACTIVE_EMPLOYEE: 'That employee is inactive.',
      PAY_TOO_MANY_HOURS: 'That would be more than 24 hours of overtime on one day.',
      PAY_BAD_RECEIPT: 'That receipt could not be attached. Please upload it again.',
      PAY_BAD_INPUT: "That request isn't valid. Check the details and try again.",
    });
  });

  it('shares the request and decision schemas with leave rather than redefining them', () => {
    expect(requestIdInput).toBe(leave.requestIdInput);
    expect(decideInput).toBe(leave.decideInput);
  });
});

describe('the calls each function makes', () => {
  it('submits a claim with the database parameter names, a trimmed description and no receipt as null', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_submit_claim': { data: { id: REQ, status: 'pending', has_receipt: false, amount_cents: 8500 } },
    });
    expect(await submitClaim(ctxOf(client), { ...CLAIM, description: '  Taxi to client  ' })).toEqual({
      ok: true,
      data: { id: REQ, status: 'pending', has_receipt: false },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: 'hr_submit_claim',
      args: {
        p_employee: EMP,
        p_category: 'travel',
        p_amount_cents: 8500,
        p_claim_date: '2026-10-09',
        p_description: 'Taxi to client',
        p_receipt_path: null,
      },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual([
      'p_amount_cents', 'p_category', 'p_claim_date', 'p_description', 'p_employee', 'p_receipt_path',
    ]);
  });

  it('sends a blank description and an empty receipt path as null, never as an empty string', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_submit_claim': { data: { id: REQ, status: 'pending', has_receipt: false } } });
    await submitClaim(ctxOf(client), { ...CLAIM, description: '   ', receipt_path: null });
    await submitClaim(ctxOf(client), CLAIM);
    expect(calls.map((c) => [c.args!.p_description, c.args!.p_receipt_path])).toEqual([[null, null], [null, null]]);
  });

  it('passes a receipt path through and reports that the claim has a receipt', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_submit_claim': { data: { id: REQ, status: 'pending', has_receipt: true } } });
    expect(await submitClaim(ctxOf(client), { ...CLAIM, receipt_path: RECEIPT })).toEqual({
      ok: true,
      data: { id: REQ, status: 'pending', has_receipt: true },
    });
    expect(calls[0].args).toMatchObject({ p_receipt_path: RECEIPT });
  });

  it('cancels a claim and hands back the path of the receipt it let go of, or null', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_cancel_claim': [
        { data: { id: REQ, status: 'cancelled', removed_receipt_path: RECEIPT } },
        { data: { id: REQ, status: 'cancelled', removed_receipt_path: null } },
        { data: { id: REQ, status: 'cancelled' } },
      ],
    });
    expect(await cancelClaim(ctxOf(client), { id: REQ })).toEqual({
      ok: true,
      data: { id: REQ, status: 'cancelled', removed_receipt_path: RECEIPT },
    });
    expect(await cancelClaim(ctxOf(client), { id: REQ })).toEqual({
      ok: true,
      data: { id: REQ, status: 'cancelled', removed_receipt_path: null },
    });
    expect(await cancelClaim(ctxOf(client), { id: REQ })).toEqual({
      ok: true,
      data: { id: REQ, status: 'cancelled', removed_receipt_path: null },
    });
    expect(calls[0]).toMatchObject({ fn: 'hr_cancel_claim', args: { p_request: REQ } });
    expect(Object.keys(calls[0].args!)).toEqual(['p_request']);
  });

  it('is told generically when the cancelled receipt path is not text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_cancel_claim': { data: { id: REQ, status: 'cancelled', removed_receipt_path: 7 } } });
    expect(await cancelClaim(ctxOf(client), { id: REQ })).toEqual({ ok: false, error: GENERIC });
  });

  it('decides a claim, sending the note trimmed and only as given', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_decide_claim': { data: { id: REQ, status: 'rejected' } } });
    expect(await decideClaim(ctxOf(client), { id: REQ, approve: false, note: ' Not covered ' })).toEqual({
      ok: true,
      data: { id: REQ, status: 'rejected' },
    });
    await decideClaim(ctxOf(client), { id: REQ, approve: true });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_decide_claim', { p_request: REQ, p_approve: false, p_note: 'Not covered' }],
      ['hr_decide_claim', { p_request: REQ, p_approve: true, p_note: null }],
    ]);
  });

  it('marks a claim paid and undoes it', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_mark_claim_paid': { data: { id: REQ, status: 'paid', paid_on: '2026-10-10' } },
      'rpc.hr_unmark_claim_paid': { data: { id: REQ, status: 'approved' } },
    });
    expect(await markClaimPaid(ctxOf(client), { id: REQ, paid_on: '2026-10-10', reference: ' TT-1 ' })).toEqual({
      ok: true,
      data: { id: REQ, status: 'paid', paid_on: '2026-10-10' },
    });
    await markClaimPaid(ctxOf(client), { id: REQ, paid_on: '2026-10-10' });
    expect(await unmarkClaimPaid(ctxOf(client), { id: REQ })).toEqual({ ok: true, data: { id: REQ, status: 'approved' } });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_mark_claim_paid', { p_request: REQ, p_paid_on: '2026-10-10', p_reference: 'TT-1' }],
      ['hr_mark_claim_paid', { p_request: REQ, p_paid_on: '2026-10-10', p_reference: null }],
      ['hr_unmark_claim_paid', { p_request: REQ }],
    ]);
  });

  it('previews overtime with the database parameter names, and sends no reason', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_overtime_preview': {
        data: { day_kind: 'rest_day', multiplier: 2, hourly_rate_cents: 2404, amount_cents: 12020 },
      },
    });
    const result = await previewOvertime(ctxOf(client), { ...OVERTIME, reason: 'secret' } as never);
    expect(result).toEqual({
      ok: true,
      data: { day_kind: 'rest_day', multiplier: 2, hourly_rate_cents: 2404, amount_cents: 12020 },
    });
    expect(calls[0]).toMatchObject({
      fn: 'hr_overtime_preview',
      args: { p_employee: EMP, p_work_date: '2026-10-09', p_hours: 2.5 },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_employee', 'p_hours', 'p_work_date']);
  });

  it('passes a null rate and amount through (no salary on file) rather than calling it a bad reply', async () => {
    const { client } = fakeSupabase({
      'rpc.hr_overtime_preview': { data: { day_kind: 'weekday', multiplier: '1.5', hourly_rate_cents: null, amount_cents: null } },
    });
    expect(await previewOvertime(ctxOf(client), OVERTIME)).toEqual({
      ok: true,
      data: { day_kind: 'weekday', multiplier: 1.5, hourly_rate_cents: null, amount_cents: null },
    });
  });

  it('is told generically when the preview names a kind of day that does not exist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_overtime_preview': { data: { day_kind: 'holiday', multiplier: 1.5, hourly_rate_cents: 1, amount_cents: 1 } },
    });
    expect(await previewOvertime(ctxOf(client), OVERTIME)).toEqual({ ok: false, error: GENERIC });
  });

  it('submits overtime, with the reason trimmed and blank sent as null, and reports the worked-out figures', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_submit_overtime': [
        { data: { id: REQ, status: 'pending', amount_cents: 9000, hourly_rate_cents: 2400, hours: 2.5 } },
        { data: { id: REQ, status: 'pending', amount_cents: 0, hourly_rate_cents: null } },
      ],
    });
    expect(await submitOvertime(ctxOf(client), { ...OVERTIME, reason: '  Month end  ' })).toEqual({
      ok: true,
      data: { id: REQ, status: 'pending', amount_cents: 9000, hourly_rate_cents: 2400 },
    });
    expect(await submitOvertime(ctxOf(client), { ...OVERTIME, reason: '  ' })).toEqual({
      ok: true,
      data: { id: REQ, status: 'pending', amount_cents: 0, hourly_rate_cents: null },
    });
    expect(calls.map((c) => c.args)).toEqual([
      { p_employee: EMP, p_work_date: '2026-10-09', p_hours: 2.5, p_reason: 'Month end' },
      { p_employee: EMP, p_work_date: '2026-10-09', p_hours: 2.5, p_reason: null },
    ]);
  });

  it('cancels and decides overtime', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_cancel_overtime': { data: { id: REQ, status: 'cancelled' } },
      'rpc.hr_decide_overtime': { data: { id: REQ, status: 'approved', amount_cents: 9000 } },
    });
    expect(await cancelOvertime(ctxOf(client), { id: REQ })).toEqual({ ok: true, data: { id: REQ, status: 'cancelled' } });
    expect(await decideOvertime(ctxOf(client), { id: REQ, approve: true })).toEqual({
      ok: true,
      data: { id: REQ, status: 'approved', amount_cents: 9000 },
    });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_cancel_overtime', { p_request: REQ }],
      ['hr_decide_overtime', { p_request: REQ, p_approve: true, p_note: null }],
    ]);
  });
});

describe('input checks happen before any call', () => {
  it.each([
    ['an id that is not a uuid', { ...CLAIM, employee_id: 'nope' }],
    ['an amount of zero', { ...CLAIM, amount_cents: 0 }],
    ['a negative amount', { ...CLAIM, amount_cents: -5 }],
    ['an amount with a fraction of a sen', { ...CLAIM, amount_cents: 85.5 }],
    ['an amount over RM 1,000,000', { ...CLAIM, amount_cents: 100_000_001 }],
    ['a category that does not exist', { ...CLAIM, category: 'travelling' }],
    ['a date that does not exist', { ...CLAIM, claim_date: '2026-02-31' }],
    ['a date before 2000', { ...CLAIM, claim_date: '1999-12-31' }],
    ['a description over 500 characters', { ...CLAIM, description: 'x'.repeat(501) }],
    ['an empty receipt path', { ...CLAIM, receipt_path: '' }],
  ])('refuses a claim with %s', async (_name, input) => {
    const { client, calls } = fakeSupabase();
    expect((await submitClaim(ctxOf(client), input as never)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no hours', { ...OVERTIME, hours: 0 }],
    ['a quarter hour', { ...OVERTIME, hours: 1.25 }],
    ['more than 24 hours', { ...OVERTIME, hours: 24.5 }],
    ['hours that are text', { ...OVERTIME, hours: '2' }],
    ['a date that does not exist', { ...OVERTIME, work_date: '2026-13-01' }],
    ['a reason over 500 characters', { ...OVERTIME, reason: 'x'.repeat(501) }],
  ])('refuses overtime with %s', async (_name, input) => {
    const { client, calls } = fakeSupabase();
    expect((await submitOvertime(ctxOf(client), input as never)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses the same hours and date in a preview', async () => {
    const { client, calls } = fakeSupabase();
    for (const bad of [{ hours: 0 }, { hours: 1.25 }, { hours: 24.5 }, { work_date: '2026-13-01' }]) {
      expect((await previewOvertime(ctxOf(client), { ...OVERTIME, ...bad })).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('accepts half hours from half an hour to 24', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_overtime_preview': { data: { day_kind: 'weekday', multiplier: 1.5, hourly_rate_cents: null, amount_cents: null } } });
    for (const hours of [0.5, 1, 7.5, 24]) expect((await previewOvertime(ctxOf(client), { ...OVERTIME, hours })).ok).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('refuses a paid reference over 100 characters and a paid date that does not exist', async () => {
    const { client, calls } = fakeSupabase();
    expect((await markClaimPaid(ctxOf(client), { id: REQ, paid_on: '2026-10-10', reference: 'x'.repeat(101) })).ok).toBe(false);
    expect((await markClaimPaid(ctxOf(client), { id: REQ, paid_on: '2026-10-32' })).ok).toBe(false);
    expect(markClaimPaidInput.safeParse({ id: 'nope', paid_on: '2026-10-10' }).success).toBe(false);
    expect(calls).toEqual([]);
  });

  it('accepts an id that is a valid uuid but not RFC-versioned', () => {
    expect(submitClaimInput.safeParse({ ...CLAIM, employee_id: '00000000-0000-0000-0000-000000000001' }).success).toBe(true);
  });
});

describe('what a refusal looks like to the caller', () => {
  const runs: [string, string, (client: never) => Promise<unknown>][] = [
    ['submitClaim', 'hr_submit_claim', (c) => submitClaim(ctxOf(c), CLAIM)],
    ['cancelClaim', 'hr_cancel_claim', (c) => cancelClaim(ctxOf(c), { id: REQ })],
    ['decideClaim', 'hr_decide_claim', (c) => decideClaim(ctxOf(c), { id: REQ, approve: true })],
    ['markClaimPaid', 'hr_mark_claim_paid', (c) => markClaimPaid(ctxOf(c), { id: REQ, paid_on: '2026-10-10' })],
    ['unmarkClaimPaid', 'hr_unmark_claim_paid', (c) => unmarkClaimPaid(ctxOf(c), { id: REQ })],
    ['previewOvertime', 'hr_overtime_preview', (c) => previewOvertime(ctxOf(c), OVERTIME)],
    ['submitOvertime', 'hr_submit_overtime', (c) => submitOvertime(ctxOf(c), OVERTIME)],
    ['cancelOvertime', 'hr_cancel_overtime', (c) => cancelOvertime(ctxOf(c), { id: REQ })],
    ['decideOvertime', 'hr_decide_overtime', (c) => decideOvertime(ctxOf(c), { id: REQ, approve: true })],
  ];

  it.each(Object.entries(PAY_REFUSALS))('%s reaches the caller as its sentence, from every function', async (code, sentence) => {
    for (const [name, rpc, run] of runs) {
      const { client } = fakeSupabase({ [`rpc.${rpc}`]: { error: { code: 'P0001', message: code } } });
      expect(await run(client), name).toEqual({ ok: false, error: sentence });
    }
  });

  it('matches on the leading code, so text after it does not matter', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_submit_claim': { error: { code: 'P0001', message: 'PAY_BAD_RECEIPT: anything' } } });
    expect(await submitClaim(ctxOf(client), CLAIM)).toEqual({ ok: false, error: PAY_REFUSALS.PAY_BAD_RECEIPT });
  });

  it('answers an unknown database error generically and logs only its code and message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_submit_claim': { error: { code: '57014', message: 'canceling statement due to timeout' } } });
    const result = await submitClaim(ctxOf(client), { ...CLAIM, description: 'my private lunch', receipt_path: RECEIPT });
    expect(result).toEqual({ ok: false, error: GENERIC });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(['[people-capability] submitClaim failed:', '57014', 'canceling statement due to timeout']);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('private lunch');
    expect(logged).not.toContain(RECEIPT);
    expect(logged).not.toContain('8500');
  });

  it('does not treat a message that merely mentions a code as that code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_submit_claim': { error: { message: 'oops PAY_NOT_FOUND' } } });
    expect(await submitClaim(ctxOf(client), CLAIM)).toEqual({ ok: false, error: GENERIC });
  });

  it('answers generically, and logs, when the reply is not what the function promises', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_cancel_overtime': { data: null } });
    expect(await cancelOvertime(ctxOf(client), { id: REQ })).toEqual({ ok: false, error: GENERIC });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('ringgitToSen', () => {
  it.each([
    ['85', 8500],
    ['85.5', 8550],
    ['85.50', 8550],
    ['85.05', 8505],
    ['0.99', 99],
    ['0', 0],
    ['007', 700],
    [' 12 ', 1200],
    ['1000000', 100_000_000],
  ])('turns %s into %d sen', (text, sen) => {
    expect(ringgitToSen(text)).toBe(sen);
  });

  it.each([['85.123'], ['-5'], ['+5'], ['abc'], ['RM 85'], ['1,000'], ['85.'], ['.5'], [''], ['  '], ['8 5'], ['1e3']])(
    'refuses %j',
    (text) => {
      expect(ringgitToSen(text)).toBeNull();
    },
  );

  it('refuses a number too large to hold exactly', () => {
    expect(ringgitToSen('9'.repeat(30))).toBeNull();
  });
});

describe('approvedThisYear', () => {
  const claim = (over: Partial<Claim> = {}): Claim => ({
    id: 'c1', employee_id: 'e1', employee_name: 'E', category: 'travel', amount_cents: 1000, claim_date: '2026-10-02',
    description: null, has_receipt: true, status: 'approved', decision_note: null, receipt_path: null, paid_on: null,
    paid_reference: null, created_at: '2026-10-02T00:00:00Z', ...over,
  });
  const subject = { id: 'subject', employee_id: 'e1', category: 'travel', claim_date: '2026-10-20' };

  it('adds up approved and paid claims', () => {
    expect(approvedThisYear(subject, [claim({ id: 'a', amount_cents: 1000 }), claim({ id: 'b', amount_cents: 2500, status: 'paid', paid_on: '2026-10-05' })])).toBe(3500);
  });

  it.each(['pending', 'rejected', 'cancelled'] as const)('does not count a %s claim', (status) => {
    expect(approvedThisYear(subject, [claim({ status })])).toBe(0);
  });

  it('counts only the same employee, the same category and the same calendar year as the claim', () => {
    expect(
      approvedThisYear(subject, [
        claim({ id: 'other-person', employee_id: 'e2' }),
        claim({ id: 'other-category', category: 'meals' }),
        claim({ id: 'last-year', claim_date: '2025-12-31' }),
        claim({ id: 'next-year', claim_date: '2027-01-01' }),
        claim({ id: 'same', amount_cents: 400, claim_date: '2026-01-01' }),
      ]),
    ).toBe(400);
  });

  it("takes the year from the claim's own date, not from today", () => {
    expect(approvedThisYear({ ...subject, claim_date: '2024-06-01' }, [claim({ claim_date: '2024-03-03', amount_cents: 700 }), claim({ id: 'x' })])).toBe(700);
  });

  it('leaves out the claim itself', () => {
    expect(approvedThisYear({ ...subject, id: 'c1' }, [claim({ id: 'c1' })])).toBe(0);
  });
});
