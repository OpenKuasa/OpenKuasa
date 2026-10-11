/**
 * Live test of the claims and overtime write path against the real database.
 * It needs 20261020090000_people_claims_overtime_writes.sql applied; until then
 * it fails at the first call (the functions do not exist). Skipped without
 * Supabase env vars. It has NOT been run: the migration is not on the live
 * database yet.
 *
 * Why no receipt file: the receipts bucket takes uploads only from a signed-up
 * (non-anonymous) account, and this suite signs in anonymously like the leave
 * one. So the claim here has no receipt, and what a receipt adds (the folder
 * rule, the claim-scoped read, the removal) is covered by the access check in
 * supabase/tests/people_claims_overtime_check.sql and by the mocked tests. If a
 * real account becomes available to the suite, add an upload with
 * `uploadReceipt` and a `removeReceipt` of what it made.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee } from '@/lib/people/capabilities';
import { todayInMalaysia, addDays } from '@/lib/people/dates';
import {
  cancelClaim,
  cancelOvertime,
  decideClaim,
  decideOvertime,
  markClaimPaid,
  previewOvertime,
  submitClaim,
  submitOvertime,
  unmarkClaimPaid,
} from '@/lib/people/pay-requests';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = (): SupabaseClient =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const TODAY = todayInMalaysia(new Date());
const CLAIM_DATE = addDays(TODAY, -3);
// A past Monday, so it is a weekday for a workspace with no settings.
const MONDAY = '2026-03-02';

let owner: { c: SupabaseClient; orgId: string };
let guest: { c: SupabaseClient; demoId: string };
let createdEmployeeId: string | null = null;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = client();
  const signedIn = await c.auth.signInAnonymously();
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await c.rpc('create_org_for_current_user', { org_name: 'People Pay Sdn Bhd' });
  expect(org.error, org.error?.message).toBeNull();
  owner = { c, orgId: org.data as string };

  const g = client();
  expect((await g.auth.signInAnonymously()).error).toBeNull();
  const demo = await g.rpc('join_demo_org');
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };
});
afterAll(async () => {
  // Deleting the employee deletes their claims and overtime with it, so only the throwaway workspace is left.
  if (owner && createdEmployeeId) await owner.c.from('hr_employees').delete().eq('id', createdEmployeeId);
  await owner?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

testWithSupabase('an owner submits, approves, pays, unpays and cancels a claim', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const farah = await createEmployee(ctx, { name: 'Farah Idris' });
  expect(farah.ok, JSON.stringify(farah)).toBe(true);
  if (!farah.ok) return;
  const employee_id = farah.data.id;
  createdEmployeeId = employee_id;

  const made = await submitClaim(ctx, { employee_id, category: 'travel', amount_cents: 8500, claim_date: CLAIM_DATE, description: 'Taxi' });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  expect(made.data).toMatchObject({ status: 'pending', has_receipt: false });
  const id = made.data.id;

  // Not approved yet, so it cannot be paid.
  expect(await markClaimPaid(ctx, { id, paid_on: TODAY })).toEqual({ ok: false, error: 'Only an approved claim can be marked as paid.' });

  expect(await decideClaim(ctx, { id, approve: true })).toEqual({ ok: true, data: { id, status: 'approved' } });
  expect(await decideClaim(ctx, { id, approve: false })).toEqual({
    ok: false,
    error: 'That request has already been decided or cancelled.',
  });

  // Before the claim's own date is refused.
  expect((await markClaimPaid(ctx, { id, paid_on: addDays(CLAIM_DATE, -1) })).ok).toBe(false);
  expect(await markClaimPaid(ctx, { id, paid_on: TODAY, reference: 'TT-1' })).toEqual({
    ok: true,
    data: { id, status: 'paid', paid_on: TODAY },
  });

  // A paid claim is not cancelled until the paid mark is undone.
  expect(await cancelClaim(ctx, { id })).toEqual({ ok: false, error: 'That claim is marked as paid. Undo the paid mark first.' });
  expect(await unmarkClaimPaid(ctx, { id })).toEqual({ ok: true, data: { id, status: 'approved' } });
  expect(await unmarkClaimPaid(ctx, { id })).toEqual({ ok: false, error: 'That claim is not marked as paid.' });

  expect(await cancelClaim(ctx, { id })).toEqual({ ok: true, data: { id, status: 'cancelled', removed_receipt_path: null } });
});

testWithSupabase('an owner previews, submits, approves and cancels overtime', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const employee_id = createdEmployeeId;
  expect(employee_id).not.toBeNull();
  if (!employee_id) return;

  // No salary is on file, so the figures are not calculated.
  const preview = await previewOvertime(ctx, { employee_id, work_date: MONDAY, hours: 2.5 });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  if (preview.ok) {
    expect(preview.data).toMatchObject({ day_kind: 'weekday', multiplier: 1.5, hourly_rate_cents: null, amount_cents: null });
  }

  const made = await submitOvertime(ctx, { employee_id, work_date: MONDAY, hours: 2.5, reason: 'Month end' });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  expect(made.data).toMatchObject({ status: 'pending', amount_cents: 0, hourly_rate_cents: null });

  // More than 24 hours across records on one date is refused.
  expect(await submitOvertime(ctx, { employee_id, work_date: MONDAY, hours: 22 })).toEqual({
    ok: false,
    error: 'That would be more than 24 hours of overtime on one day.',
  });

  const approved = await decideOvertime(ctx, { id: made.data.id, approve: true });
  expect(approved.ok, JSON.stringify(approved)).toBe(true);
  expect(await cancelOvertime(ctx, { id: made.data.id })).toEqual({ ok: true, data: { id: made.data.id, status: 'cancelled' } });
  expect(await cancelOvertime(ctx, { id: made.data.id })).toEqual({
    ok: false,
    error: 'That request has already been decided or cancelled.',
  });
});

testWithSupabase('a demo guest changes nothing', async () => {
  const ctx = { client: guest.c, orgId: guest.demoId };
  const refusal = { ok: false, error: "You can't make that change." };
  expect(
    await submitClaim(ctx, { employee_id: DEMO_EMPLOYEE_ID, category: 'travel', amount_cents: 100, claim_date: CLAIM_DATE }),
  ).toEqual(refusal);
  expect(await submitOvertime(ctx, { employee_id: DEMO_EMPLOYEE_ID, work_date: MONDAY, hours: 1 })).toEqual(refusal);
  expect(await previewOvertime(ctx, { employee_id: DEMO_EMPLOYEE_ID, work_date: MONDAY, hours: 1 })).toEqual(refusal);
});
