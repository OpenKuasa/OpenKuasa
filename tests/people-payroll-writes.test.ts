import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAYROLL_REFUSALS,
  deletePayrollRun,
  deletePayslipLine,
  markPayrollPaid,
  recalculatePayroll,
  removePayslip,
  runPayroll,
  savePayslipLine,
  setPayslipStatutory,
  unmarkPayrollPaid,
} from '@/lib/people/payroll-writes';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = 'org-1';
const RUN = '11111111-1111-4111-8111-111111111111';
const SLIP = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const EMP = '44444444-4444-4444-8444-444444444444';
const ctxOf = (client: never) => ({ client, orgId: ORG });
const GENERIC = 'That change could not be saved. Please try again.';

afterEach(() => vi.restoreAllMocks());

const slipJson = (over: Record<string, unknown> = {}) => ({
  id: SLIP,
  employee_id: EMP,
  period_month: '2026-10-01',
  basic_cents: 300_000,
  gross_cents: 300_000,
  epf_cents: 33_000,
  socso_cents: 1_500,
  eis_cents: 600,
  pcb_cents: 0,
  other_deductions_cents: 0,
  net_cents: 264_900,
  set_by_hr: [],
  status: 'pending',
  ...over,
});

describe('PAYROLL_REFUSALS', () => {
  it('has the spec sentence for every code the database raises', () => {
    expect(PAYROLL_REFUSALS).toEqual({
      PAYROLL_NOT_ALLOWED: "You can't make that change.",
      PAYROLL_NOT_FOUND: 'That payroll record could not be found.',
      PAYROLL_RUN_EXISTS: 'Payroll for that month has already been run.',
      PAYROLL_MONTH_NOT_STARTED: 'That month has not started yet.',
      PAYROLL_EARLIER_DRAFT: 'An earlier month is still a draft. Mark it as paid or delete it first.',
      PAYROLL_SKIPS_MONTH: 'Run payroll for the month after the latest run first.',
      PAYROLL_NOT_DRAFT: 'That run is already paid. Undo paid first to change it.',
      PAYROLL_NOT_PAID: 'That run is not marked as paid.',
      PAYROLL_LATER_RUN: 'A later month already has a payroll run. Delete that run first.',
      PAYROLL_NEGATIVE_NET: "A payslip's net pay is below zero. Fix it before marking the run as paid.",
      PAYROLL_STALE: 'An overtime claim on this run has changed. Recalculate first.',
      PAYROLL_SYSTEM_LINE: "That line is worked out by the system and can't be changed.",
      PAYROLL_BAD_INPUT: 'Some of that was not accepted. Check the name and the amount, and try again.',
      PAY_IN_PAID_RUN: 'This overtime was paid in a payroll run. Undo paid on that run first.',
      HR_EMPLOYEE_HAS_PAID_PAYSLIPS: 'This employee has paid payslips. Make them inactive instead.',
    });
  });
});

describe('the calls each function makes', () => {
  it('runs payroll with the workspace from the context and the first of the month', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_run_payroll': {
        data: {
          run: { id: RUN, period_month: '2026-10-01', status: 'draft' },
          payslips: 3,
          earlier_overtime: 2,
          skipped: [{ employee_id: EMP, name: 'Aisyah', reason: 'no_salary' }],
        },
      },
    });
    const result = await runPayroll(ctxOf(client), { month: '2026-10', org_id: 'someone-else' } as never);
    expect(result).toEqual({
      ok: true,
      data: {
        run_id: RUN,
        month: '2026-10',
        payslips: 3,
        earlier_overtime: 2,
        skipped: [{ employee_id: EMP, name: 'Aisyah', reason: 'no_salary' }],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('hr_run_payroll');
    expect(calls[0].args).toEqual({ p_org: ORG, p_month: '2026-10-01' });
  });

  it('recalculates a run by its id and reports how many payslips were added', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_recalculate_payroll': {
        data: { run: { id: RUN, period_month: '2026-09-01', status: 'draft' }, payslips: 5, added: 2, earlier_overtime: 0, skipped: [] },
      },
    });
    expect(await recalculatePayroll(ctxOf(client), { run_id: RUN })).toEqual({
      ok: true,
      data: { run_id: RUN, month: '2026-09', payslips: 5, added: 2, earlier_overtime: 0, skipped: [] },
    });
    expect(calls[0].fn).toBe('hr_recalculate_payroll');
    expect(calls[0].args).toEqual({ p_run: RUN });
  });

  it('adds a line with a null line id, a trimmed name and the amount in cents', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_payslip_line': {
        data: {
          payslip: slipJson({ gross_cents: 400_000 }),
          line: { id: LINE, kind: 'earning', source: 'hr', label: 'Bonus', amount_cents: 100_000 },
        },
      },
    });
    const result = await savePayslipLine(ctxOf(client), {
      payslip_id: SLIP,
      kind: 'earning',
      label: '  Bonus ',
      amount_cents: 100_000,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { id: SLIP, gross_cents: 400_000, set_by_hr: [], status: 'pending' },
    });
    expect(calls[0].fn).toBe('hr_save_payslip_line');
    expect(calls[0].args).toEqual({
      p_payslip: SLIP,
      p_line: null,
      p_kind: 'earning',
      p_label: 'Bonus',
      p_amount_cents: 100_000,
    });
  });

  it('changes a line by its id, and reads an empty string for the line as none', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_payslip_line': {
        data: { payslip: slipJson(), line: { id: LINE, kind: 'deduction', source: 'hr', label: 'Uniform', amount_cents: 6000 } },
      },
    });
    await savePayslipLine(ctxOf(client), { payslip_id: SLIP, line_id: LINE, kind: 'deduction', label: 'Uniform', amount_cents: 6000 });
    expect(calls[0].args).toMatchObject({ p_line: LINE, p_kind: 'deduction' });
    await savePayslipLine(ctxOf(client), { payslip_id: SLIP, line_id: '', kind: 'deduction', label: 'Uniform', amount_cents: 6000 });
    expect(calls[1].args).toMatchObject({ p_line: null });
  });

  it('removes a line and hands back the payslip', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_payslip_line': { data: { payslip: slipJson() } } });
    const result = await deletePayslipLine(ctxOf(client), { line_id: LINE });
    expect(result).toMatchObject({ ok: true, data: { id: SLIP, employee_id: EMP } });
    expect(calls[0].fn).toBe('hr_delete_payslip_line');
    expect(calls[0].args).toEqual({ p_line: LINE });
  });

  it('sets a figure, and resets it with a null amount', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_set_statutory': { data: { payslip: slipJson({ pcb_cents: 5000, set_by_hr: ['pcb'] }) } },
    });
    const set = await setPayslipStatutory(ctxOf(client), { payslip_id: SLIP, field: 'pcb', amount_cents: 5000 });
    expect(set).toMatchObject({ ok: true, data: { pcb_cents: 5000, set_by_hr: ['pcb'] } });
    expect(calls[0].fn).toBe('hr_set_statutory');
    expect(calls[0].args).toEqual({ p_payslip: SLIP, p_field: 'pcb', p_amount_cents: 5000 });
    await setPayslipStatutory(ctxOf(client), { payslip_id: SLIP, field: 'pcb', amount_cents: null });
    expect(calls[1].args).toEqual({ p_payslip: SLIP, p_field: 'pcb', p_amount_cents: null });
    await setPayslipStatutory(ctxOf(client), { payslip_id: SLIP, field: 'eis', amount_cents: 0 });
    expect(calls[2].args).toEqual({ p_payslip: SLIP, p_field: 'eis', p_amount_cents: 0 });
  });

  it('removes a payslip', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_remove_payslip': { data: { run_id: RUN, employee_id: EMP } } });
    expect(await removePayslip(ctxOf(client), { payslip_id: SLIP })).toEqual({
      ok: true,
      data: { run_id: RUN, employee_id: EMP },
    });
    expect(calls[0].fn).toBe('hr_remove_payslip');
    expect(calls[0].args).toEqual({ p_payslip: SLIP });
  });

  it('deletes a draft run', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_payroll_run': { data: { id: RUN } } });
    expect(await deletePayrollRun(ctxOf(client), { run_id: RUN })).toEqual({ ok: true, data: { id: RUN } });
    expect(calls[0].fn).toBe('hr_delete_payroll_run');
    expect(calls[0].args).toEqual({ p_run: RUN });
  });

  it('marks a run paid and undoes it', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_mark_payroll_paid': {
        data: { id: RUN, period_month: '2026-10-01', status: 'paid', paid_at: '2026-10-11T02:00:00+00:00' },
      },
      'rpc.hr_unmark_payroll_paid': { data: { id: RUN, period_month: '2026-10-01', status: 'draft' } },
    });
    expect(await markPayrollPaid(ctxOf(client), { run_id: RUN })).toEqual({
      ok: true,
      data: { id: RUN, period_month: '2026-10-01' },
    });
    expect(await unmarkPayrollPaid(ctxOf(client), { run_id: RUN })).toEqual({
      ok: true,
      data: { id: RUN, period_month: '2026-10-01' },
    });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['hr_mark_payroll_paid', { p_run: RUN }],
      ['hr_unmark_payroll_paid', { p_run: RUN }],
    ]);
  });
});

describe('what is refused before the database is asked', () => {
  const never = () => fakeSupabase();

  it('refuses a month that is not a month', async () => {
    for (const month of ['2026-13', '2026-00', '2026-1', '2026-10-01', '1999-12', '', 'October']) {
      const { client, calls } = never();
      const result = await runPayroll(ctxOf(client), { month });
      expect(result.ok, month).toBe(false);
      expect(calls, month).toEqual([]);
    }
  });

  it('refuses an id that is not an id, for each function that takes one', async () => {
    const { client, calls } = never();
    const bad = 'not-an-id';
    const results = [
      await recalculatePayroll(ctxOf(client), { run_id: bad }),
      await deletePayslipLine(ctxOf(client), { line_id: bad }),
      await removePayslip(ctxOf(client), { payslip_id: bad }),
      await deletePayrollRun(ctxOf(client), { run_id: bad }),
      await markPayrollPaid(ctxOf(client), { run_id: bad }),
      await unmarkPayrollPaid(ctxOf(client), { run_id: bad }),
      await savePayslipLine(ctxOf(client), { payslip_id: bad, kind: 'earning', label: 'x', amount_cents: 1 }),
      await setPayslipStatutory(ctxOf(client), { payslip_id: bad, field: 'epf', amount_cents: 1 }),
    ];
    for (const r of results) expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ['a fraction of a cent', { amount_cents: 10.5 }],
    ['zero', { amount_cents: 0 }],
    ['a negative amount', { amount_cents: -100 }],
    ['not a number', { amount_cents: Number.NaN }],
    ['infinity', { amount_cents: Number.POSITIVE_INFINITY }],
    ['beyond the safe integers', { amount_cents: Number.MAX_SAFE_INTEGER + 2 }],
    ['above the database limit', { amount_cents: 100_000_000_001 }],
    ['a text amount', { amount_cents: '100' }],
    ['a kind that is not hr-writable', { kind: 'unpaid' }],
    ['an empty name', { label: '   ' }],
    ['an 81-character name', { label: 'a'.repeat(81) }],
  ])('refuses a line with %s', async (_what, over) => {
    const { client, calls } = never();
    const result = await savePayslipLine(ctxOf(client), {
      payslip_id: SLIP,
      kind: 'earning',
      label: 'Bonus',
      amount_cents: 100,
      ...over,
    } as never);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('accepts the largest amount the database does', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_save_payslip_line': { data: {
          payslip: slipJson(),
          line: { id: LINE, kind: 'earning', source: 'hr', label: 'a'.repeat(80), amount_cents: 100_000_000_000 },
        },
      },
    });
    const result = await savePayslipLine(ctxOf(client), {
      payslip_id: SLIP,
      kind: 'earning',
      label: 'a'.repeat(80),
      amount_cents: 100_000_000_000,
    });
    expect(result.ok).toBe(true);
    expect(calls[0].args).toMatchObject({ p_amount_cents: 100_000_000_000 });
  });

  it.each([
    ['an unknown field', { field: 'tax', amount_cents: 1 }],
    ['an upper-case field', { field: 'EPF', amount_cents: 1 }],
    ['a negative amount', { field: 'epf', amount_cents: -1 }],
    ['a fraction', { field: 'epf', amount_cents: 1.5 }],
    ['no amount at all', { field: 'epf' }],
    ['infinity', { field: 'epf', amount_cents: Number.POSITIVE_INFINITY }],
    ['beyond the safe integers', { field: 'epf', amount_cents: Number.MAX_SAFE_INTEGER + 2 }],
  ])('refuses a statutory figure with %s', async (_what, over) => {
    const { client, calls } = never();
    const result = await setPayslipStatutory(ctxOf(client), { payslip_id: SLIP, ...over } as never);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('a run reply', () => {
  const reply = (over: Record<string, unknown>) => ({
    run: { id: RUN, period_month: '2026-10-01', status: 'draft' },
    payslips: 1,
    earlier_overtime: 0,
    skipped: [],
    ...over,
  });

  it.each([
    ['missing', undefined],
    ['a fraction', 1.5],
    ['negative', -1],
    ['text', '2'],
    ['null', null],
  ])('is invalid when earlier_overtime is %s', async (_what, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_run_payroll': { data: reply({ earlier_overtime: value }) },
      'rpc.hr_recalculate_payroll': { data: reply({ earlier_overtime: value, added: 0 }) },
    });
    expect(await runPayroll(ctxOf(client), { month: '2026-10' })).toEqual({ ok: false, error: GENERIC });
    expect(await recalculatePayroll(ctxOf(client), { run_id: RUN })).toEqual({ ok: false, error: GENERIC });
  });

  it('carries earlier_overtime through', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_run_payroll': { data: reply({ earlier_overtime: 4 }) } });
    expect(await runPayroll(ctxOf(client), { month: '2026-10' })).toMatchObject({ ok: true, data: { earlier_overtime: 4 } });
  });

  it('reads PAYROLL_SKIPS_MONTH as its sentence', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_run_payroll': { error: { code: 'P0001', message: 'PAYROLL_SKIPS_MONTH' } } });
    expect(await runPayroll(ctxOf(client), { month: '2026-05' })).toEqual({
      ok: false,
      error: 'Run payroll for the month after the latest run first.',
    });
  });

  it('reads PAYROLL_LATER_RUN with the one sentence for creating and reopening', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_run_payroll': { error: { code: 'P0001', message: 'PAYROLL_LATER_RUN' } } });
    expect(await runPayroll(ctxOf(client), { month: '2026-01' })).toEqual({
      ok: false,
      error: 'A later month already has a payroll run. Delete that run first.',
    });
  });
});

describe('the line id', () => {
  it.each([[5], [{ id: LINE }], [true], [[LINE]]])('refuses %j instead of adding a line', async (value) => {
    const { client, calls } = fakeSupabase();
    const result = await savePayslipLine(ctxOf(client), {
      payslip_id: SLIP,
      line_id: value,
      kind: 'earning',
      label: 'x',
      amount_cents: 1,
    } as never);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('what comes back', () => {
  it.each(Object.entries(PAYROLL_REFUSALS))('turns %s into its sentence', async (code, sentence) => {
    const { client } = fakeSupabase({ 'rpc.hr_mark_payroll_paid': { error: { code: 'P0001', message: code } } });
    expect(await markPayrollPaid(ctxOf(client), { run_id: RUN })).toEqual({ ok: false, error: sentence });
  });

  it('turns an unknown error into the generic sentence and logs only the code and message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_run_payroll': { error: { code: '42501', message: 'permission denied for function hr_run_payroll' } },
    });
    expect(await runPayroll(ctxOf(client), { month: '2026-10' })).toEqual({ ok: false, error: GENERIC });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).toContain('42501');
  });

  it('does not take a sentence from an error that merely mentions a code', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_mark_payroll_paid': { error: { code: 'P0001', message: 'something went wrong near PAYROLL_NOT_DRAFT' } },
    });
    expect(await markPayrollPaid(ctxOf(client), { run_id: RUN })).toEqual({ ok: false, error: GENERIC });
    logged.mockRestore();
  });

  it('never logs what was typed or the amount, whatever fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_save_payslip_line': { error: { code: 'XX000', message: 'boom' } },
      'rpc.hr_set_statutory': { data: { unexpected: true } },
    });
    await savePayslipLine(ctxOf(client), {
      payslip_id: SLIP,
      kind: 'earning',
      label: 'SECRET-LABEL',
      amount_cents: 123_456_789,
    });
    await setPayslipStatutory(ctxOf(client), { payslip_id: SLIP, field: 'epf', amount_cents: 987_654_321 });
    await savePayslipLine(ctxOf(client), {
      payslip_id: SLIP,
      kind: 'earning',
      label: 'SECRET-LABEL',
      amount_cents: -987_654_321,
    });
    const text = JSON.stringify(logged.mock.calls);
    expect(text).not.toContain('SECRET-LABEL');
    expect(text).not.toContain('123456789');
    expect(text).not.toContain('987654321');
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('treats a reply that is not what was promised as a failed write', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const data of [null, 'ok', [], {}, { run: {}, payslips: 'x' }, { payslip: { id: SLIP } }]) {
      const { client } = fakeSupabase({
        'rpc.hr_run_payroll': { data },
        'rpc.hr_delete_payslip_line': { data },
      });
      expect(await runPayroll(ctxOf(client), { month: '2026-10' }), JSON.stringify(data)).toEqual({ ok: false, error: GENERIC });
      expect(await deletePayslipLine(ctxOf(client), { line_id: LINE }), JSON.stringify(data)).toEqual({ ok: false, error: GENERIC });
    }
    expect(logged).toHaveBeenCalled();
  });

  it('keeps the order of the figures a payslip is set by HR in, and refuses a payslip with a made-up one', async () => {
    const good = fakeSupabase({
      'rpc.hr_set_statutory': { data: { payslip: slipJson({ set_by_hr: ['epf', 'pcb'] }) } },
    });
    const ok = await setPayslipStatutory(ctxOf(good.client), { payslip_id: SLIP, field: 'epf', amount_cents: 1 });
    expect(ok).toMatchObject({ ok: true, data: { set_by_hr: ['epf', 'pcb'] } });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = fakeSupabase({ 'rpc.hr_set_statutory': { data: { payslip: slipJson({ set_by_hr: ['tax'] }) } } });
    expect(await setPayslipStatutory(ctxOf(bad.client), { payslip_id: SLIP, field: 'epf', amount_cents: 1 })).toEqual({
      ok: false,
      error: GENERIC,
    });
  });
});
