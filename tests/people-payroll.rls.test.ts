/**
 * Live test of the payroll write path against the real database. It needs
 * 20261027090000_people_payroll_writes.sql applied; until then it fails at the
 * first call (the functions do not exist). Skipped without Supabase env vars.
 * First run: Task 6 of the L5 plan, after the owner's go-ahead.
 *
 * A fresh workspace with two salaried employees (one linked to a member's
 * account), a third with no salary, and one approved overtime record. The
 * owner runs payroll for a past month, adds a line, types over a figure and
 * puts it back; the member reads nothing while the run is a draft and exactly
 * their own payslip and lines once it is paid; every write is refused to the
 * member and to the demo guest. No figure is worked out here beyond adding up
 * what the rows say: the arithmetic of a payslip is proven by
 * supabase/tests/people_payroll_check.sql.
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also
 * removes them. Every sentence comes from PAYROLL_REFUSALS, never a literal.
 *
 * The demo part is skipped in minutes :00 to :02 of every hour (UTC), while the demo is re-seeded.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee, linkEmployeeToMember } from '@/lib/people/capabilities';
import { decideOvertime, submitOvertime } from '@/lib/people/pay-requests';
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
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, joinDemo, liveClient, signInAnon } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

// A past month and a Monday in it, so the month has started whatever today is.
const MONTH = '2026-03';
const MONDAY = '2026-03-02';
const PASSWORD = 'payroll-live-pass-123';

const NOT_ALLOWED = PAYROLL_REFUSALS.PAYROLL_NOT_ALLOWED;
const NOT_FOUND = PAYROLL_REFUSALS.PAYROLL_NOT_FOUND;
const NOT_DRAFT = PAYROLL_REFUSALS.PAYROLL_NOT_DRAFT;

let owner: { c: SupabaseClient; orgId: string };
let member: { c: SupabaseClient; userId: string };
let guest: { c: SupabaseClient; demoId: string };

// Filled in by the first test, used by the rest.
let runId = '';
const linked = { employeeId: '', slipId: '' };
const other = { employeeId: '', slipId: '' };
let noSalaryId = '';
let overtimeId = '';
// A line on the OTHER payslip: the member must not be able to name it.
let otherLineId = '';

const ownerCtx = () => ({ client: owner.c, orgId: owner.orgId });
const memberCtx = () => ({ client: member.c, orgId: owner.orgId });
const ownerData = () => createSupabasePeopleData(owner.c, owner.orgId);
const memberData = () => createSupabasePeopleData(member.c, owner.orgId);

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = client();
  expect((await signInAnon(c)).error).toBeNull();
  const org = await createOrg(c, 'People Payroll Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  owner = { c, orgId: org.data as string };

  // A member needs an address to accept an invite sent to it. The user is created already confirmed (a plain
  // sign-up returns no session while the project requires email confirmation) and signed in at once.
  const m = client();
  const signUp = await createConfirmedTestUser(m, PASSWORD);
  const userId = signUp.userId;
  const invite = await owner.c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  member = { c: m, userId: userId as string };

  const g = client();
  expect((await signInAnon(g)).error).toBeNull();
  const demo = await joinDemo(g);
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await member?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

testWithSupabase('an owner runs payroll for a past month and sees who was left out', async () => {
  const ctx = ownerCtx();
  const a = await createEmployee(ctx, { name: 'Farah Idris', join_date: '2025-01-06', private: { base_salary: 3000 } });
  const b = await createEmployee(ctx, { name: 'Hakim Rosli', join_date: '2025-01-06', private: { base_salary: 4000 } });
  const c = await createEmployee(ctx, { name: 'Nadia Salleh', join_date: '2025-01-06' });
  expect(a.ok && b.ok && c.ok, JSON.stringify([a, b, c])).toBe(true);
  if (!a.ok || !b.ok || !c.ok) return;
  linked.employeeId = a.data.id;
  other.employeeId = b.data.id;
  noSalaryId = c.data.id;
  expect((await linkEmployeeToMember(ctx, { id: a.data.id, user_id: member.userId })).ok).toBe(true);

  // One approved overtime record on a day inside the month.
  const made = await submitOvertime(ctx, { employee_id: a.data.id, work_date: MONDAY, hours: 2 });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  overtimeId = made.data.id;
  expect((await decideOvertime(ctx, { id: overtimeId, approve: true })).ok).toBe(true);

  const run = await runPayroll(ctx, { month: MONTH });
  expect(run.ok, JSON.stringify(run)).toBe(true);
  if (!run.ok) return;
  runId = run.data.run_id;
  expect(run.data).toMatchObject({ month: MONTH, payslips: 2, earlier_overtime: 0 });
  expect(run.data.skipped).toEqual([{ employee_id: noSalaryId, name: 'Nadia Salleh', reason: 'no_salary' }]);

  // A second run for the same month is refused, with its sentence.
  expect(await runPayroll(ctx, { month: MONTH })).toEqual({ ok: false, error: PAYROLL_REFUSALS.PAYROLL_RUN_EXISTS });

  const data = ownerData();
  const [runs, slips] = await Promise.all([data.listPayrollRuns(), data.listPayslips()]);
  expect(runs).toEqual([{ id: runId, period_month: `${MONTH}-01`, status: 'draft', paid_at: null, paid_by_name: null }]);
  expect(slips).toHaveLength(2);
  const mine = slips.find((s) => s.employee_id === a.data.id)!;
  const theirs = slips.find((s) => s.employee_id === b.data.id)!;
  linked.slipId = mine.id;
  other.slipId = theirs.id;
  expect(mine).toMatchObject({ status: 'pending', set_by_hr: [], basic_cents: 300_000 });
  expect(theirs.basic_cents).toBe(400_000);
  // The overtime is a line on Farah's payslip and on no one else's, and the record says which run took it.
  expect(mine.lines.filter((l) => l.source === 'overtime')).toHaveLength(1);
  expect(theirs.lines).toEqual([]);
  expect(mine.gross_cents).toBe(mine.basic_cents + mine.lines.reduce((t, l) => t + l.amount_cents, 0));
});

testWithSupabase('an owner adds a line, types over a figure and puts it back', async () => {
  const ctx = ownerCtx();
  const before = (await ownerData().listPayslips()).find((s) => s.id === linked.slipId)!;

  const added = await savePayslipLine(ctx, {
    payslip_id: linked.slipId,
    kind: 'earning',
    label: 'Sales commission',
    amount_cents: 50_000,
  });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  if (!added.ok) return;
  expect(added.data.gross_cents).toBe(before.gross_cents + 50_000);
  expect(added.data.line).toMatchObject({ kind: 'earning', source: 'hr', label: 'Sales commission', amount_cents: 50_000 });

  const afterAdd = (await ownerData().listPayslips()).find((s) => s.id === linked.slipId)!;
  // System lines first, the owner's own last.
  expect(afterAdd.lines.at(-1)).toMatchObject({ id: added.data.line.id, source: 'hr' });

  // A deduction changes net and nothing else.
  const deduction = await savePayslipLine(ctx, {
    payslip_id: linked.slipId,
    kind: 'deduction',
    label: 'Uniform',
    amount_cents: 6_000,
  });
  expect(deduction.ok, JSON.stringify(deduction)).toBe(true);
  if (deduction.ok) {
    expect(deduction.data.gross_cents).toBe(added.data.gross_cents);
    expect(deduction.data.other_deductions_cents).toBe(6_000);
    expect(deduction.data.net_cents).toBe(added.data.net_cents - 6_000);
  }

  // A line is changed by its id.
  const edited = await savePayslipLine(ctx, {
    payslip_id: linked.slipId,
    line_id: added.data.line.id,
    kind: 'earning',
    label: 'Sales commission',
    amount_cents: 60_000,
  });
  expect(edited.ok, JSON.stringify(edited)).toBe(true);
  if (edited.ok) expect(edited.data.gross_cents).toBe(before.gross_cents + 60_000);

  // A system line is not the owner's to change.
  const system = afterAdd.lines.find((l) => l.source === 'overtime')!;
  expect(await deletePayslipLine(ctx, { line_id: system.id })).toEqual({
    ok: false,
    error: PAYROLL_REFUSALS.PAYROLL_SYSTEM_LINE,
  });

  // Something only the database can judge: a line that belongs to another payslip is not found on this one.
  const parking = await savePayslipLine(ctx, { payslip_id: other.slipId, kind: 'earning', label: 'Parking', amount_cents: 1_000 });
  expect(parking.ok, JSON.stringify(parking)).toBe(true);
  if (!parking.ok) return;
  otherLineId = parking.data.line.id;
  expect(
    await savePayslipLine(ctx, {
      payslip_id: linked.slipId,
      line_id: parking.data.line.id,
      kind: 'earning',
      label: 'Parking',
      amount_cents: 2_000,
    }),
  ).toEqual({ ok: false, error: PAYROLL_REFUSALS.PAYROLL_NOT_FOUND });

  // A figure typed over is marked, survives a recalculation, and goes back to the proposal on null.
  const set = await setPayslipStatutory(ctx, { payslip_id: linked.slipId, field: 'epf', amount_cents: 12_345 });
  expect(set.ok, JSON.stringify(set)).toBe(true);
  if (set.ok) expect(set.data).toMatchObject({ epf_cents: 12_345, set_by_hr: ['epf'] });
  const recalculated = await recalculatePayroll(ctx, { run_id: runId });
  expect(recalculated.ok, JSON.stringify(recalculated)).toBe(true);
  if (recalculated.ok) expect(recalculated.data).toMatchObject({ payslips: 2, added: 0, earlier_overtime: 0 });
  const kept = (await ownerData().listPayslips()).find((s) => s.id === linked.slipId)!;
  expect(kept).toMatchObject({ epf_cents: 12_345, set_by_hr: ['epf'] });
  expect(kept.lines.filter((l) => l.source === 'hr')).toHaveLength(2);

  const reset = await setPayslipStatutory(ctx, { payslip_id: linked.slipId, field: 'epf', amount_cents: null });
  expect(reset.ok, JSON.stringify(reset)).toBe(true);
  if (reset.ok) {
    expect(reset.data.set_by_hr).toEqual([]);
    expect(reset.data.epf_cents).not.toBe(12_345);
  }
});

testWithSupabase('a member reads nothing of a draft, and every write is refused to them', async () => {
  // Nothing: not their own payslip, not its lines, not the run, not the overtime month.
  expect(await memberData().listPayslips()).toEqual([]);
  expect(await memberData().listPayrollRuns()).toEqual([]);
  const lines = await member.c.from('hr_payslip_lines').select('id');
  expect(lines.error).toBeNull();
  expect(lines.data ?? []).toEqual([]);
  // The record is there to be read (it is the member's own), and says nothing of a payroll month yet.
  const ot = (await memberData().listOvertime()).find((r) => r.id === overtimeId);
  expect(ot, 'the member can read their own overtime record').toBeDefined();
  expect(ot?.paid_month).toBeNull();

  const ctx = memberCtx();
  expect(await runPayroll(ctx, { month: '2026-02' })).toEqual({ ok: false, error: NOT_ALLOWED });
  expect(otherLineId, 'a real line on another payslip, from the earlier test').not.toBe('');
  const refused = [
    await recalculatePayroll(ctx, { run_id: runId }),
    await savePayslipLine(ctx, { payslip_id: linked.slipId, kind: 'earning', label: 'Mine', amount_cents: 100 }),
    await deletePayslipLine(ctx, { line_id: otherLineId }),
    await setPayslipStatutory(ctx, { payslip_id: linked.slipId, field: 'epf', amount_cents: 1 }),
    await removePayslip(ctx, { payslip_id: linked.slipId }),
    await deletePayrollRun(ctx, { run_id: runId }),
    await markPayrollPaid(ctx, { run_id: runId }),
    await unmarkPayrollPaid(ctx, { run_id: runId }),
  ];
  // The member is told a payroll record was not found, never that one exists and is out of reach.
  for (const result of refused) expect(result).toEqual({ ok: false, error: NOT_FOUND });
});

testWithSupabase('an owner marks the run paid, and the member reads exactly their own payslip', async () => {
  const ctx = ownerCtx();
  const paid = await markPayrollPaid(ctx, { run_id: runId });
  expect(paid, JSON.stringify(paid)).toEqual({ ok: true, data: { id: runId, period_month: `${MONTH}-01` } });

  const runs = await ownerData().listPayrollRuns();
  expect(runs[0]).toMatchObject({ id: runId, status: 'paid' });
  expect(runs[0].paid_at).not.toBeNull();

  // The member: one payslip (theirs), its lines, and the overtime now reads as paid in March.
  const slips = await memberData().listPayslips();
  expect(slips.map((s) => s.id)).toEqual([linked.slipId]);
  expect(slips[0]).toMatchObject({ status: 'paid', employee_id: linked.employeeId });
  expect(slips[0].lines.length).toBeGreaterThanOrEqual(3);
  const ownerSlip = (await ownerData().listPayslips()).find((s) => s.id === linked.slipId)!;
  expect(slips[0].lines).toEqual(ownerSlip.lines);
  const lines = await member.c.from('hr_payslip_lines').select('payslip_id');
  expect((lines.data ?? []).every((l) => l.payslip_id === linked.slipId)).toBe(true);
  expect((await memberData().listOvertime()).find((r) => r.id === overtimeId)?.paid_month).toBe(MONTH);
  expect((await ownerData().listOvertime()).find((r) => r.id === overtimeId)?.paid_month).toBe(MONTH);

  // A paid run changes in no way: every write that names it is refused as "not a draft".
  expect(await markPayrollPaid(ctx, { run_id: runId })).toEqual({ ok: false, error: NOT_DRAFT });
  expect(await recalculatePayroll(ctx, { run_id: runId })).toEqual({ ok: false, error: NOT_DRAFT });
  expect(await removePayslip(ctx, { payslip_id: other.slipId })).toEqual({ ok: false, error: NOT_DRAFT });
  expect(await deletePayrollRun(ctx, { run_id: runId })).toEqual({ ok: false, error: NOT_DRAFT });
  expect(
    await setPayslipStatutory(ctx, { payslip_id: linked.slipId, field: 'pcb', amount_cents: 1 }),
  ).toEqual({ ok: false, error: NOT_DRAFT });
  expect(
    await savePayslipLine(ctx, { payslip_id: linked.slipId, kind: 'earning', label: 'Late', amount_cents: 1 }),
  ).toEqual({ ok: false, error: NOT_DRAFT });
});

testWithSupabase('an owner undoes paid, the member loses sight of it, and the draft can be deleted', async () => {
  const ctx = ownerCtx();
  expect(await unmarkPayrollPaid(ctx, { run_id: runId })).toEqual({
    ok: true,
    data: { id: runId, period_month: `${MONTH}-01` },
  });
  expect(await unmarkPayrollPaid(ctx, { run_id: runId })).toEqual({ ok: false, error: PAYROLL_REFUSALS.PAYROLL_NOT_PAID });
  expect(await memberData().listPayslips()).toEqual([]);
  expect((await ownerData().listPayslips()).every((s) => s.status === 'pending')).toBe(true);

  // Taking a payslip out of a draft leaves the other.
  expect(await removePayslip(ctx, { payslip_id: other.slipId })).toEqual({
    ok: true,
    data: { run_id: runId, employee_id: other.employeeId },
  });
  expect(await ownerData().listPayslips()).toHaveLength(1);

  expect(await deletePayrollRun(ctx, { run_id: runId })).toEqual({ ok: true, data: { id: runId } });
  expect(await ownerData().listPayrollRuns()).toEqual([]);
  expect(await ownerData().listPayslips()).toEqual([]);
  // Its overtime is free again, so the next run takes it.
  const again = await runPayroll(ctx, { month: MONTH });
  expect(again.ok, JSON.stringify(again)).toBe(true);
  if (again.ok) {
    const slip = (await ownerData().listPayslips()).find((s) => s.employee_id === linked.employeeId)!;
    expect(slip.lines.filter((l) => l.source === 'overtime')).toHaveLength(1);
    // An earlier month is refused while a later month has a run.
    expect(await runPayroll(ctx, { month: '2026-02' })).toEqual({
      ok: false,
      error: PAYROLL_REFUSALS.PAYROLL_LATER_RUN,
    });
    // With March still a draft, even the next month is refused: the draft comes first.
    expect(await runPayroll(ctx, { month: '2026-04' })).toEqual({
      ok: false,
      error: PAYROLL_REFUSALS.PAYROLL_EARLIER_DRAFT,
    });
    // Once March is paid, skipping a month ahead of it is refused (May skips April).
    expect(await markPayrollPaid(ctx, { run_id: again.data.run_id })).toMatchObject({ ok: true });
    expect(await runPayroll(ctx, { month: '2026-05' })).toEqual({
      ok: false,
      error: PAYROLL_REFUSALS.PAYROLL_SKIPS_MONTH,
    });
    expect(await unmarkPayrollPaid(ctx, { run_id: again.data.run_id })).toMatchObject({ ok: true });
    expect(await deletePayrollRun(ctx, { run_id: again.data.run_id })).toEqual({ ok: true, data: { id: again.data.run_id } });
  }
});

testWithSupabase('a month with nobody to pay is a real record: it is run, paid, and the next month follows', async () => {
  // Its own workspace, with one employee and no salary on file.
  const c = client();
  expect((await signInAnon(c)).error).toBeNull();
  const org = await createOrg(c, 'People Payroll Empty Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  const ctx = { client: c, orgId: org.data as string };
  const made = await createEmployee(ctx, { name: 'Tiada Gaji', join_date: '2025-01-06' });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;

  const first = await runPayroll(ctx, { month: MONTH });
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(first.data).toMatchObject({ month: MONTH, payslips: 0 });
  expect(first.data.skipped).toEqual([{ employee_id: made.data.id, name: 'Tiada Gaji', reason: 'no_salary' }]);

  const paid = await markPayrollPaid(ctx, { run_id: first.data.run_id });
  expect(paid, JSON.stringify(paid)).toEqual({ ok: true, data: { id: first.data.run_id, period_month: `${MONTH}-01` } });

  const second = await runPayroll(ctx, { month: '2026-04' });
  expect(second.ok, JSON.stringify(second)).toBe(true);
  if (second.ok) expect(second.data).toMatchObject({ month: '2026-04', payslips: 0 });
});

testWithSupabase('a demo guest changes nothing', async () => {
  // The demo is rebuilt at the top of every hour; its rows are not there to be tried in the first minutes of it.
  if (new Date().getUTCMinutes() <= 2) {
    console.warn('Skipped the demo part of the payroll live test: the demo is being re-seeded (minutes :00 to :02).');
    return;
  }
  const ctx = { client: guest.c, orgId: guest.demoId };
  const data = createSupabasePeopleData(guest.c, guest.demoId);
  const [runs, slips] = await Promise.all([data.listPayrollRuns(), data.listPayslips()]);
  const draft = runs.find((r) => r.status === 'draft');
  const paid = runs.find((r) => r.status === 'paid');
  const slip = slips.find((s) => s.payroll_run_id === draft?.id);
  expect(draft && paid && slip, 'the demo has a draft run, a paid run and a payslip to try').toBeTruthy();
  if (!draft || !paid || !slip) return;

  const demoLine = slips.flatMap((s) => s.lines)[0];
  expect(demoLine, 'the demo has a payslip line to try').toBeDefined();
  if (!demoLine) return;

  const refused = [
    await runPayroll(ctx, { month: '2025-01' }),
    await recalculatePayroll(ctx, { run_id: draft.id }),
    await savePayslipLine(ctx, { payslip_id: slip.id, kind: 'earning', label: 'Gift', amount_cents: 100 }),
    await deletePayslipLine(ctx, { line_id: demoLine.id }),
    await setPayslipStatutory(ctx, { payslip_id: slip.id, field: 'epf', amount_cents: 1 }),
    await removePayslip(ctx, { payslip_id: slip.id }),
    await deletePayrollRun(ctx, { run_id: draft.id }),
    await markPayrollPaid(ctx, { run_id: draft.id }),
    await unmarkPayrollPaid(ctx, { run_id: paid.id }),
  ];
  for (const result of refused) expect(result).toEqual({ ok: false, error: NOT_ALLOWED });

  // Nothing changed.
  expect((await data.listPayrollRuns()).map((r) => [r.id, r.status])).toEqual(runs.map((r) => [r.id, r.status]));
});
