/**
 * Live test of roster notifications and shift swaps, against the real database. It needs
 * 20261125090300_people_roster_notify_swaps.sql applied; until then it fails. Skipped without Supabase env vars.
 * Not run by the agent that wrote it.
 *
 * One workspace: an owner, a manager, and two members (alpha and bravo) who report to the manager. The owner
 * saves a week ahead: alpha and bravo are each told once. Alpha sees bravo's shift among the options, asks to
 * swap, bravo accepts, the manager approves, and the owner reads the two shifts exchanged. Every refusal and the
 * read rule are covered by supabase/tests/people_roster_swaps_check.sql.
 *
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also removes them.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee, linkEmployeeToMember, setReportsTo } from '@/lib/people/capabilities';
import { addDays, todayInMalaysia, weekStart } from '@/lib/people/dates';
import { ensureShiftTypes, saveRoster } from '@/lib/people/roster-writes';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { SWAP_REFUSALS, decideShiftSwap, replyShiftSwap, requestShiftSwap } from '@/lib/people/swap-writes';
import { listSwapOptions, listSwaps } from '@/lib/people/swaps';
import { readWaitingCounts } from '@/lib/people/waiting-counts';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const PASSWORD = 'roster-swaps-pass-123';
// Two weeks ahead: every day is to come, and within the 60 days the options cover.
const MONDAY = addDays(weekStart(todayInMalaysia(new Date())), 14);

type Member = { c: SupabaseClient; userId: string; employeeId: string };
let owner: { c: SupabaseClient; userId: string };
let manager: Member;
let alpha: Member;
let bravo: Member;
let orgId = '';

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

const notices = async (who: { c: SupabaseClient }, event: string) => {
  const { data, error } = await who.c.from('notifications').select('title,href').eq('event', event);
  expect(error, error?.message).toBeNull();
  return data ?? [];
};

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = liveClient();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'Roster Swaps Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data as string;
  owner = { c, userId: signedIn.data.user!.id };

  manager = await joinAsMember('Swap Manager');
  alpha = await joinAsMember('Swap Alpha');
  bravo = await joinAsMember('Swap Bravo');
  for (const who of [alpha, bravo]) {
    expect((await setReportsTo(ctx(owner), { id: who.employeeId, manager_id: manager.employeeId })).ok).toBe(true);
  }
}, 120_000);

afterAll(async () => {
  for (const who of [owner, manager, alpha, bravo]) await who?.c.auth.signOut();
});

let morning = '';
let night = '';

testWithSupabase('a roster save tells each changed employee once, and nobody for a cell left as it was', async () => {
  expect(await ensureShiftTypes(ctx(owner))).toBe(3);
  const types = await createSupabasePeopleData(owner.c, orgId).listShiftTypes();
  morning = types.find((t) => t.name === 'Morning')!.id;
  night = types.find((t) => t.name === 'Night')!.id;

  const first = await saveRoster(ctx(owner), {
    week_start: MONDAY,
    cells: [
      { employee_id: alpha.employeeId, work_date: MONDAY, shift_type_id: morning },
      { employee_id: bravo.employeeId, work_date: MONDAY, shift_type_id: night },
      { employee_id: bravo.employeeId, work_date: addDays(MONDAY, 1), shift_type_id: night },
    ],
  });
  expect(first).toMatchObject({ ok: true, data: { saved: 3 } });
  expect(await notices(alpha, 'hr_roster_changed')).toHaveLength(1);
  expect(await notices(bravo, 'hr_roster_changed')).toHaveLength(1);
  expect((await notices(alpha, 'hr_roster_changed'))[0]?.href).toBe(`/people/shift-calendar?week=${MONDAY}`);

  // Alpha's cell again with the same type: no new notice.
  expect(await saveRoster(ctx(owner), { week_start: MONDAY, cells: [{ employee_id: alpha.employeeId, work_date: MONDAY, shift_type_id: morning }] })).toMatchObject({
    ok: true, data: { saved: 0 },
  });
  expect(await notices(alpha, 'hr_roster_changed')).toHaveLength(1);
}, 60_000);

testWithSupabase('alpha swaps with bravo: bravo accepts, the manager approves, the shifts are exchanged', async () => {
  const options = await listSwapOptions(ctx(alpha));
  const mine = options.find((o) => o.mine && o.work_date === MONDAY);
  const theirs = options.find((o) => o.employee_id === bravo.employeeId && o.work_date === MONDAY);
  expect(mine && theirs, JSON.stringify(options)).toBeTruthy();
  if (!mine || !theirs) return;

  const asked = await requestShiftSwap(ctx(alpha), { my_shift_id: mine.shift_id, their_shift_id: theirs.shift_id, note: 'Dentist' });
  expect(asked).toMatchObject({ ok: true, data: { status: 'requested' } });
  if (!asked.ok) return;
  expect(await notices(bravo, 'hr_shift_swap')).toHaveLength(1);
  expect((await readWaitingCounts(ctx(bravo))).swap_replies).toBe(1);

  // Alpha cannot accept for bravo, and the table takes no direct write.
  expect(await replyShiftSwap(ctx(alpha), { id: asked.data.id, accept: true })).toEqual({ ok: false, error: SWAP_REFUSALS.SWAP_NOT_ALLOWED });
  const direct = await alpha.c.from('hr_shift_swaps').update({ status: 'approved' }).eq('id', asked.data.id).select('id');
  expect(direct.error !== null || (direct.data ?? []).length === 0).toBe(true);

  expect(await replyShiftSwap(ctx(bravo), { id: asked.data.id, accept: true })).toMatchObject({ ok: true, data: { status: 'accepted' } });
  expect((await readWaitingCounts(ctx(manager))).swaps).toBe(1);
  expect((await listSwaps(ctx(manager))).map((s) => s.id)).toContain(asked.data.id);

  expect(await decideShiftSwap(ctx(manager), { id: asked.data.id, approve: true, note: null })).toMatchObject({ ok: true, data: { status: 'approved' } });
  const shifts = await createSupabasePeopleData(owner.c, orgId).listShifts(MONDAY, MONDAY);
  const typeOf = (id: string) => shifts.find((s) => s.employee_id === id)?.shift_type_id;
  expect([typeOf(alpha.employeeId), typeOf(bravo.employeeId)]).toEqual([night, morning]);
  expect(await notices(alpha, 'hr_shift_swap')).toHaveLength(2);
  expect(await decideShiftSwap(ctx(owner), { id: asked.data.id, approve: true, note: null })).toEqual({ ok: false, error: SWAP_REFUSALS.SWAP_NOT_PENDING });
}, 60_000);
