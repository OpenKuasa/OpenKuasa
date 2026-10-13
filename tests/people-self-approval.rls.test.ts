/**
 * Live test of "nobody decides or pays their own request", against the real
 * database. It needs 20261030124500_people_no_self_approval.sql applied; until
 * then the admin's own approvals succeed and this file fails. Skipped without
 * Supabase env vars.
 *
 * One workspace with its owner and an admin, each linked to an employee
 * record. The admin is refused on their own leave, time-off, claim and
 * overtime, and decides the owner's; the owner decides the admin's, and their
 * own. Every sentence comes from the refusal maps, never a literal.
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also
 * removes them.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee, linkEmployeeToMember } from '@/lib/people/capabilities';
import { addDays, todayInMalaysia } from '@/lib/people/dates';
import {
  LEAVE_REFUSALS,
  applyLeave,
  applyTimeOff,
  cancelLeave,
  decideLeave,
  decideTimeOff,
} from '@/lib/people/leave';
import {
  PAY_REFUSALS,
  decideClaim,
  decideOvertime,
  markClaimPaid,
  submitClaim,
  submitOvertime,
} from '@/lib/people/pay-requests';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const PASSWORD = 'self-approval-pass-123';
const TODAY = todayInMalaysia(new Date());
const CLAIM_DATE = addDays(TODAY, -3);
// A past Monday, so it is a weekday for a workspace with no settings.
const MONDAY = '2026-03-02';
// Two weekdays well ahead, so the leave has not started whatever today is.
const LEAVE_DAY = '2027-03-01';
const OTHER_LEAVE_DAY = '2027-03-08';

const OWN_LEAVE = { ok: false, error: LEAVE_REFUSALS.LEAVE_OWN_REQUEST };
const OWN_PAY = { ok: false, error: PAY_REFUSALS.PAY_OWN_REQUEST };

let owner: { c: SupabaseClient; userId: string };
let admin: { c: SupabaseClient; userId: string };
let orgId = '';
let ownerEmployee = '';
let adminEmployee = '';

const ownerCtx = () => ({ client: owner.c, orgId });
const adminCtx = () => ({ client: admin.c, orgId });

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = liveClient();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'Self Approval Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data as string;
  owner = { c, userId: signedIn.data.user!.id };

  // An admin needs an address to accept an invite sent to it; see people-payroll.rls.test.ts.
  const a = liveClient();
  const signUp = await createConfirmedTestUser(a, PASSWORD);
  const invite = await c.rpc('create_invite', { p_email: signUp.email, p_role: 'admin' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await a.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();
  admin = { c: a, userId: signUp.userId as string };

  const mine = await createEmployee(ownerCtx(), { name: 'Owner Person' });
  const theirs = await createEmployee(ownerCtx(), { name: 'Admin Person' });
  expect(mine.ok && theirs.ok, JSON.stringify([mine, theirs])).toBe(true);
  if (!mine.ok || !theirs.ok) return;
  ownerEmployee = mine.data.id;
  adminEmployee = theirs.data.id;
  expect((await linkEmployeeToMember(ownerCtx(), { id: ownerEmployee, user_id: owner.userId })).ok).toBe(true);
  expect((await linkEmployeeToMember(ownerCtx(), { id: adminEmployee, user_id: admin.userId })).ok).toBe(true);
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await admin?.c.auth.signOut();
});

testWithSupabase('an admin cannot approve or reject their own leave; the owner can, and the admin can still withdraw', async () => {
  const made = await applyLeave(adminCtx(), {
    employee_id: adminEmployee, leave_type: 'annual', start_date: LEAVE_DAY, end_date: LEAVE_DAY,
  });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  const id = made.data.id;

  expect(await decideLeave(adminCtx(), { id, approve: true })).toEqual(OWN_LEAVE);
  expect(await decideLeave(adminCtx(), { id, approve: false, note: 'no' })).toEqual(OWN_LEAVE);
  expect(await decideLeave(ownerCtx(), { id, approve: true })).toEqual({ ok: true, data: { id, status: 'approved' } });
  // Withdrawing one's own request is not deciding it.
  expect(await cancelLeave(adminCtx(), { id })).toEqual({ ok: true, data: { id, status: 'cancelled' } });
});

testWithSupabase('an admin cannot decide their own time-off', async () => {
  const made = await applyTimeOff(adminCtx(), {
    employee_id: adminEmployee, off_date: LEAVE_DAY, start_time: '15:00', end_time: '17:00',
  });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  expect(await decideTimeOff(adminCtx(), { id: made.data.id, approve: true })).toEqual(OWN_LEAVE);
  expect((await decideTimeOff(ownerCtx(), { id: made.data.id, approve: true })).ok).toBe(true);
});

testWithSupabase('an admin cannot approve or pay their own claim', async () => {
  const made = await submitClaim(adminCtx(), {
    employee_id: adminEmployee, category: 'travel', amount_cents: 8500, claim_date: CLAIM_DATE, description: 'Taxi',
  });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  const id = made.data.id;

  expect(await decideClaim(adminCtx(), { id, approve: true })).toEqual(OWN_PAY);
  expect(await decideClaim(ownerCtx(), { id, approve: true })).toEqual({ ok: true, data: { id, status: 'approved' } });
  // Approved by someone else, but still not theirs to pay.
  expect(await markClaimPaid(adminCtx(), { id, paid_on: TODAY })).toEqual(OWN_PAY);
  expect(await markClaimPaid(ownerCtx(), { id, paid_on: TODAY })).toEqual({
    ok: true,
    data: { id, status: 'paid', paid_on: TODAY },
  });
});

testWithSupabase('an admin cannot decide their own overtime', async () => {
  const made = await submitOvertime(adminCtx(), { employee_id: adminEmployee, work_date: MONDAY, hours: 2 });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  expect(await decideOvertime(adminCtx(), { id: made.data.id, approve: true })).toEqual(OWN_PAY);
  expect((await decideOvertime(ownerCtx(), { id: made.data.id, approve: true })).ok).toBe(true);
});

testWithSupabase("an admin decides the owner's request, and the owner may decide their own", async () => {
  const first = await applyLeave(ownerCtx(), {
    employee_id: ownerEmployee, leave_type: 'annual', start_date: LEAVE_DAY, end_date: LEAVE_DAY,
  });
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect((await decideLeave(adminCtx(), { id: first.data.id, approve: true })).ok).toBe(true);

  // A workspace whose only approver is its owner must still work.
  const second = await applyLeave(ownerCtx(), {
    employee_id: ownerEmployee, leave_type: 'annual', start_date: OTHER_LEAVE_DAY, end_date: OTHER_LEAVE_DAY,
  });
  expect(second.ok, JSON.stringify(second)).toBe(true);
  if (!second.ok) return;
  expect((await decideLeave(ownerCtx(), { id: second.data.id, approve: true })).ok).toBe(true);

  const claim = await submitClaim(ownerCtx(), {
    employee_id: ownerEmployee, category: 'meals', amount_cents: 2500, claim_date: CLAIM_DATE,
  });
  expect(claim.ok, JSON.stringify(claim)).toBe(true);
  if (!claim.ok) return;
  expect((await decideClaim(ownerCtx(), { id: claim.data.id, approve: true })).ok).toBe(true);
  expect((await markClaimPaid(ownerCtx(), { id: claim.data.id, paid_on: TODAY })).ok).toBe(true);
});
