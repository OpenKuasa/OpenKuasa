/**
 * Live test of reporting lines, against the real database. It needs 20261115133700_people_reporting_lines.sql
 * applied; until then it fails. Skipped without Supabase env vars. Not run by the agent that wrote it.
 *
 * One workspace: an owner, and three real members linked to employee records. The owner sets the lines
 * (manager <- report <- third). The report files leave, time-off, a claim with a real small receipt and overtime.
 * Then, as the manager: the report's rows in the five widened tables and none of the third's; overtime only through
 * `hr_team_overtime` (the table gives a manager their own rows only); none of the report's private records; a signed
 * link for the report's receipt and none for the third's; decisions, a second decision refused, the waiting counts,
 * the team, the refusals, and the notifications (none with an amount or a reason in them).
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also removes them. The one receipt file
 * the test uploads is removed by the service client before that cleanup.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee, linkEmployeeToMember, setReportsTo } from '@/lib/people/capabilities';
import { addDays, todayInMalaysia } from '@/lib/people/dates';
import { LEAVE_REFUSALS, applyLeave, applyTimeOff, decideLeave } from '@/lib/people/leave';
import { PAY_REFUSALS, decideClaim, submitClaim, submitOvertime } from '@/lib/people/pay-requests';
import { RECEIPT_BUCKET, receiptPath } from '@/lib/people/receipts';
import { REPORTS_TO_REFUSALS } from '@/lib/people/reporting-refusals';
import { readMyTeam } from '@/lib/people/my-team';
import { readWaitingCounts } from '@/lib/people/waiting-counts';
import { readTeamOvertime } from '@/lib/people/supabase';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { beforeCleanup, createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const PASSWORD = 'reporting-lines-pass-123';
const TODAY = todayInMalaysia(new Date());
const CLAIM_DATE = addDays(TODAY, -3);
// A past Monday: a weekday for a workspace with no settings.
const MONDAY = '2026-03-02';
// Weekdays well ahead, so nothing has started whatever today is.
const LEAVE_DAY = '2027-03-01';
const TIME_OFF_DAY = '2027-03-08';
const THIRD_LEAVE_DAY = '2027-03-15';
const LEAVE_REASON = 'Family trip to Ipoh';
const CLAIM_DESCRIPTION = 'Taxi to the client';
const OVERTIME_REASON = 'Month-end close';
// A 1 x 1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

type Member = { c: SupabaseClient; userId: string; employeeId: string };
let owner: { c: SupabaseClient; userId: string };
let manager: Member;
let report: Member;
let third: Member;
let orgId = '';
const uploaded: string[] = [];

const ctx = (who: { c: SupabaseClient }) => ({ client: who.c, orgId });

async function joinAsMember(name: string): Promise<Member> {
  const c = liveClient();
  const signUp = await createConfirmedTestUser(c, PASSWORD);
  const invite = await owner.c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await c.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const made = await createEmployee(ctx(owner), { name });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) throw new Error('could not create the employee');
  const userId = signUp.userId as string;
  expect((await linkEmployeeToMember(ctx(owner), { id: made.data.id, user_id: userId })).ok).toBe(true);
  return { c, userId, employeeId: made.data.id };
}

beforeCleanup(async () => {
  if (uploaded.length === 0) return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await service.storage.from(RECEIPT_BUCKET).remove(uploaded);
});

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = liveClient();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'Reporting Lines Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data as string;
  owner = { c, userId: signedIn.data.user!.id };

  manager = await joinAsMember('Manager Person');
  report = await joinAsMember('Report Person');
  third = await joinAsMember('Third Person');

  // manager <- report <- third
  expect((await setReportsTo(ctx(owner), { id: report.employeeId, manager_id: manager.employeeId })).ok).toBe(true);
  expect((await setReportsTo(ctx(owner), { id: third.employeeId, manager_id: report.employeeId })).ok).toBe(true);
}, 120_000);

afterAll(async () => {
  for (const who of [owner, manager, report, third]) await who?.c.auth.signOut();
});

let leaveId = '';
let claimId = '';
let overtimeId = '';
let timeOffId = '';
let thirdLeaveId = '';
let receipt = '';
let thirdReceipt = '';

testWithSupabase('the report and the third file their requests, with a real receipt', async () => {
  receipt = receiptPath(report.userId, 'image/png');
  thirdReceipt = receiptPath(third.userId, 'image/png');
  for (const [who, path] of [[report, receipt], [third, thirdReceipt]] as const) {
    const up = await who.c.storage.from(RECEIPT_BUCKET).upload(path, PNG, { contentType: 'image/png', upsert: false });
    expect(up.error, up.error?.message).toBeNull();
    uploaded.push(path);
  }

  const leave = await applyLeave(ctx(report), {
    employee_id: report.employeeId, leave_type: 'annual', start_date: LEAVE_DAY, end_date: LEAVE_DAY, reason: LEAVE_REASON,
  });
  const timeOff = await applyTimeOff(ctx(report), {
    employee_id: report.employeeId, off_date: TIME_OFF_DAY, start_time: '15:00', end_time: '17:00',
  });
  const claim = await submitClaim(ctx(report), {
    employee_id: report.employeeId, category: 'travel', amount_cents: 8500, claim_date: CLAIM_DATE,
    description: CLAIM_DESCRIPTION, receipt_path: receipt,
  });
  const overtime = await submitOvertime(ctx(report), {
    employee_id: report.employeeId, work_date: MONDAY, hours: 2, reason: OVERTIME_REASON,
  });
  const thirdLeave = await applyLeave(ctx(third), {
    employee_id: third.employeeId, leave_type: 'annual', start_date: THIRD_LEAVE_DAY, end_date: THIRD_LEAVE_DAY,
  });
  const thirdClaim = await submitClaim(ctx(third), {
    employee_id: third.employeeId, category: 'meals', amount_cents: 2500, claim_date: CLAIM_DATE, receipt_path: thirdReceipt,
  });
  for (const made of [leave, timeOff, claim, overtime, thirdLeave, thirdClaim]) expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!leave.ok || !timeOff.ok || !claim.ok || !overtime.ok || !thirdLeave.ok) return;
  leaveId = leave.data.id;
  timeOffId = timeOff.data.id;
  claimId = claim.data.id;
  overtimeId = overtime.data.id;
  thirdLeaveId = thirdLeave.data.id;
}, 60_000);

testWithSupabase("the manager reads the report's rows in the five widened tables and none of the third's", async () => {
  const widened = ['hr_leave_requests', 'hr_leave_balances', 'hr_time_off_requests', 'hr_claims', 'hr_attendance_days'] as const;
  for (const table of widened) {
    const mine = await manager.c.from(table).select('employee_id').eq('employee_id', report.employeeId);
    expect(mine.error, `${table}: ${mine.error?.message}`).toBeNull();
    const theirs = await manager.c.from(table).select('employee_id').eq('employee_id', third.employeeId);
    expect(theirs.error, table).toBeNull();
    expect(theirs.data, table).toEqual([]);
    // The request tables hold the report's row; balances and attendance may be empty, but never the third's.
    if (table !== 'hr_leave_balances' && table !== 'hr_attendance_days') expect(mine.data?.length, table).toBeGreaterThan(0);
  }
});

testWithSupabase("overtime: the table gives the manager their own rows only; the function gives the report's, with no pay", async () => {
  const table = await manager.c.from('hr_overtime_records').select('employee_id').eq('employee_id', report.employeeId);
  expect(table.error).toBeNull();
  expect(table.data).toEqual([]);

  const team = await readTeamOvertime(manager.c, orgId);
  expect(team.map((r) => r.id)).toContain(overtimeId);
  expect(team.every((r) => r.employee_id === report.employeeId)).toBe(true);
  for (const row of team) {
    for (const key of ['hourly_rate_cents', 'amount_cents', 'payslip_id']) expect(row).not.toHaveProperty(key);
  }
});

testWithSupabase("the manager reads none of the report's private records", async () => {
  for (const table of ['hr_employee_private', 'hr_payslips', 'hr_letters', 'hr_documents', 'hr_reviews', 'hr_goals'] as const) {
    const read = await manager.c.from(table).select('employee_id').eq('employee_id', report.employeeId);
    expect(read.error, `${table}: ${read.error?.message}`).toBeNull();
    expect(read.data, table).toEqual([]);
  }
});

testWithSupabase("the manager gets a signed link for the report's receipt and is refused the third's", async () => {
  const ok = await manager.c.storage.from(RECEIPT_BUCKET).createSignedUrl(receipt, 60);
  expect(ok.error, ok.error?.message).toBeNull();
  expect(ok.data?.signedUrl).toBeTruthy();
  const refused = await manager.c.storage.from(RECEIPT_BUCKET).createSignedUrl(thirdReceipt, 60);
  expect(refused.data?.signedUrl ?? null).toBeNull();
  expect(refused.error).not.toBeNull();
});

testWithSupabase('the team and the waiting counts are the manager\'s own reports', async () => {
  expect(await readMyTeam(manager.c, orgId)).toEqual([report.employeeId]);
  expect(await readMyTeam(report.c, orgId)).toEqual([third.employeeId]);
  expect(await readMyTeam(owner.c, orgId)).toEqual([]);
  // The report's four requests, none of the third's.
  expect(await readWaitingCounts(ctx(manager))).toEqual({ leave: 1, time_off: 1, claims: 1, overtime: 1 });
});

testWithSupabase('the manager approves the leave and rejects the claim with a note; a second decision is refused', async () => {
  expect(await decideLeave(ctx(manager), { id: leaveId, approve: true })).toEqual({
    ok: true,
    data: { id: leaveId, status: 'approved' },
  });
  expect(await decideClaim(ctx(manager), { id: claimId, approve: false, note: 'Needs the invoice' })).toEqual({
    ok: true,
    data: { id: claimId, status: 'rejected' },
  });
  expect(await decideLeave(ctx(owner), { id: leaveId, approve: false })).toEqual({
    ok: false,
    error: LEAVE_REFUSALS.LEAVE_NOT_PENDING,
  });
  expect(await decideClaim(ctx(owner), { id: claimId, approve: true })).toEqual({
    ok: false,
    error: PAY_REFUSALS.PAY_NOT_PENDING,
  });
  // The third's request is not the manager's to decide: it answers as a request that does not exist.
  expect(await decideLeave(ctx(manager), { id: thirdLeaveId, approve: true })).toEqual({
    ok: false,
    error: LEAVE_REFUSALS.LEAVE_NOT_FOUND,
  });
  expect(await readWaitingCounts(ctx(manager))).toEqual({ leave: 0, time_off: 1, claims: 0, overtime: 1 });
  expect(timeOffId).toBeTruthy();
});

testWithSupabase('the manager cannot set a line, and a loop is refused', async () => {
  expect(await setReportsTo(ctx(manager), { id: third.employeeId, manager_id: manager.employeeId })).toEqual({
    ok: false,
    error: REPORTS_TO_REFUSALS.EMP_NOT_ALLOWED,
  });
  // manager <- report <- third: making the manager report to the third closes the loop.
  expect(await setReportsTo(ctx(owner), { id: manager.employeeId, manager_id: third.employeeId })).toEqual({
    ok: false,
    error: REPORTS_TO_REFUSALS.EMP_BAD_MANAGER,
  });
});

testWithSupabase('notifications: one decision for the report per decision, one filed for the manager per request, no amount or reason', async () => {
  const mine = async (who: Member, event: string) => {
    const read = await who.c.from('notifications').select('title,body,event').eq('event', event);
    expect(read.error, read.error?.message).toBeNull();
    return read.data ?? [];
  };
  const decided = await mine(report, 'hr_request_decided');
  expect(decided).toHaveLength(2);
  const filed = await mine(manager, 'hr_request_filed');
  expect(filed).toHaveLength(4);
  const everything = JSON.stringify([...decided, ...filed]);
  for (const secret of ['85.00', '8500', 'RM', LEAVE_REASON, CLAIM_DESCRIPTION, OVERTIME_REASON, 'Needs the invoice']) {
    expect(everything, secret).not.toContain(secret);
  }
  // The third's requests are told to the report, not to the manager.
  expect(await mine(report, 'hr_request_filed')).toHaveLength(2);
  expect(overtimeId).toBeTruthy();
});
