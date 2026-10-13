/**
 * Live test of the leave write path against the real database. It needs
 * 20261018090000_people_leave_writes.sql applied; until then it fails at the
 * first call (the functions do not exist). Skipped without Supabase env vars.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee } from '@/lib/people/capabilities';
import {
  applyLeave,
  cancelLeave,
  decideLeave,
  previewLeave,
  setLeaveEntitlement,
} from '@/lib/people/leave';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

// A Monday and Tuesday far enough ahead that nothing is "already started", in a year with no row yet.
const YEAR = 2031;
const MON = `${YEAR}-03-03`;
const TUE = `${YEAR}-03-04`;

let owner: { c: SupabaseClient; orgId: string };
let guest: { c: SupabaseClient; demoId: string };

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = client();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'People Leave Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  owner = { c, orgId: org.data as string };

  const g = client();
  expect((await signInAnon(g)).error).toBeNull();
  const demo = await joinDemo(g);
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

const balance = async (employeeId: string) => {
  const { data, error } = await owner.c
    .from('hr_leave_balances')
    .select('entitled_days,used_days')
    .eq('employee_id', employeeId)
    .eq('leave_type', 'annual')
    .eq('year', YEAR)
    .maybeSingle();
  expect(error, error?.message).toBeNull();
  return data as { entitled_days: number; used_days: number } | null;
};

testWithSupabase('an owner applies, approves and cancels leave, and the balance follows', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const farah = await createEmployee(ctx, { name: 'Farah Idris' });
  expect(farah.ok, JSON.stringify(farah)).toBe(true);
  if (!farah.ok) return;
  const employee_id = farah.data.id;

  const preview = await previewLeave(ctx, { employee_id, leave_type: 'annual', start_date: MON, end_date: TUE });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  if (preview.ok) expect(preview.data).toMatchObject({ days: 2, over_by: 0 });

  const applied = await applyLeave(ctx, { employee_id, leave_type: 'annual', start_date: MON, end_date: TUE, reason: 'Family' });
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  if (!applied.ok) return;
  expect(applied.data).toMatchObject({ days: 2, status: 'pending' });
  expect(Number((await balance(employee_id))?.used_days)).toBe(0);

  // The same dates again overlap.
  expect(await applyLeave(ctx, { employee_id, leave_type: 'annual', start_date: TUE, end_date: TUE })).toEqual({
    ok: false,
    error: 'That overlaps leave already applied for on those dates.',
  });

  const approved = await decideLeave(ctx, { id: applied.data.id, approve: true });
  expect(approved).toEqual({ ok: true, data: { id: applied.data.id, status: 'approved' } });
  expect(Number((await balance(employee_id))?.used_days)).toBe(2);

  // Deciding twice is refused.
  expect(await decideLeave(ctx, { id: applied.data.id, approve: false })).toEqual({
    ok: false,
    error: 'That request has already been decided or cancelled.',
  });

  const cancelled = await cancelLeave(ctx, { id: applied.data.id });
  expect(cancelled).toEqual({ ok: true, data: { id: applied.data.id, status: 'cancelled' } });
  expect(Number((await balance(employee_id))?.used_days)).toBe(0);

  // Over the balance is allowed, and the preview says so.
  const set = await setLeaveEntitlement(ctx, { employee_id, leave_type: 'annual', year: YEAR, days: 1 });
  expect(set.ok, JSON.stringify(set)).toBe(true);
  const over = await previewLeave(ctx, { employee_id, leave_type: 'annual', start_date: MON, end_date: TUE });
  expect(over.ok && over.data.over_by).toBe(1);
});

testWithSupabase('a demo guest changes nothing', async () => {
  const ctx = { client: guest.c, orgId: guest.demoId };
  const refusal = { ok: false, error: "You can't make that change." };
  expect(await applyLeave(ctx, { employee_id: DEMO_EMPLOYEE_ID, leave_type: 'annual', start_date: MON, end_date: TUE })).toEqual(refusal);
  expect(await previewLeave(ctx, { employee_id: DEMO_EMPLOYEE_ID, leave_type: 'annual', start_date: MON, end_date: TUE })).toEqual(refusal);
  expect(await setLeaveEntitlement(ctx, { employee_id: DEMO_EMPLOYEE_ID, leave_type: 'annual', year: YEAR, days: 30 })).toEqual(refusal);
});
