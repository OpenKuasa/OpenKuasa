/**
 * Live test of the attendance write path against the real database. It needs
 * 20261024090000_people_attendance_writes.sql applied; until then it fails at
 * the first call (the functions do not exist). Skipped without Supabase env vars.
 *
 * It does not clock in or out: whether today is a working day, and whether a
 * clock-in is late, depend on the clock. Those are covered by the access check
 * in supabase/tests/people_attendance_check.sql and by the signed-in pass.
 * Workspaces and users come from tests/helpers/live-workspaces.ts, which also
 * removes them, so nothing is left behind.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import {
  ATT_REFUSALS,
  correctAttendance,
  deleteHoliday,
  saveAttendanceSettings,
  saveHoliday,
} from '@/lib/people/attendance-writes';
import { createEmployee } from '@/lib/people/capabilities';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, liveClient, signInAnon, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

// A past Monday, so it is a past day whatever today is.
const MONDAY = '2026-03-02';
const REFUSED = { ok: false, error: "You can't make that change." };

let owner: { c: SupabaseClient; orgId: string };
let guest: { c: SupabaseClient; demoId: string };

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = client();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'People Attendance Sdn Bhd');
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

testWithSupabase('an owner corrects a day, and corrects it again', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const made = await createEmployee(ctx, { name: 'Farah Idris' });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;

  const present = await correctAttendance(ctx, {
    employee_id: made.data.id,
    work_date: MONDAY,
    status: 'present',
    clock_in: '09:00',
    clock_out: '18:00',
    note: 'Forgot to clock in',
  });
  expect(present.ok, JSON.stringify(present)).toBe(true);
  if (!present.ok) return;
  expect(present.data).toMatchObject({ work_date: MONDAY, status: 'present' });
  expect(present.data.clock_in).not.toBeNull();
  expect(present.data.clock_out).not.toBeNull();

  // The provider reads it back as a corrected day with its note.
  const days = await createSupabasePeopleData(owner.c, owner.orgId).listAttendance(MONDAY, MONDAY);
  expect(days).toHaveLength(1);
  expect(days[0]).toMatchObject({ corrected: true, correction_note: 'Forgot to clock in', status: 'present' });

  // The same day again replaces it; absent takes no times.
  const absent = await correctAttendance(ctx, { employee_id: made.data.id, work_date: MONDAY, status: 'absent' });
  expect(absent.ok, JSON.stringify(absent)).toBe(true);
  if (absent.ok) expect(absent.data).toMatchObject({ id: present.data.id, status: 'absent', clock_in: null, clock_out: null });

  // The database refuses what is not a day: times on an absence, a clock-out before the clock-in.
  const bad = { ok: false, error: ATT_REFUSALS.ATT_BAD_INPUT };
  expect(await correctAttendance(ctx, { employee_id: made.data.id, work_date: MONDAY, status: 'absent', clock_in: '09:00' })).toEqual(bad);
  expect(
    await correctAttendance(ctx, { employee_id: made.data.id, work_date: MONDAY, status: 'present', clock_in: '18:00', clock_out: '09:00' }),
  ).toEqual(bad);
});

testWithSupabase('an owner adds, edits, duplicates and removes a public holiday', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const added = await saveHoliday(ctx, { name: 'Deepavali', holiday_date: '2026-11-08' });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  if (!added.ok) return;
  expect(added.data).toMatchObject({ name: 'Deepavali', holiday_date: '2026-11-08' });
  const id = added.data.id;

  // One holiday per date.
  expect(await saveHoliday(ctx, { name: 'Another', holiday_date: '2026-11-08' })).toEqual({
    ok: false,
    error: 'There is already a public holiday on that date.',
  });

  const edited = await saveHoliday(ctx, { id, name: 'Deepavali (moved)', holiday_date: '2026-11-09' });
  expect(edited).toEqual({ ok: true, data: { id, name: 'Deepavali (moved)', holiday_date: '2026-11-09' } });

  const listed = await createSupabasePeopleData(owner.c, owner.orgId).listPublicHolidays();
  expect(listed.find((h) => h.id === id)).toMatchObject({ name: 'Deepavali (moved)', holiday_date: '2026-11-09' });

  expect(await deleteHoliday(ctx, { id })).toEqual({ ok: true, data: { id } });
  expect(await deleteHoliday(ctx, { id })).toEqual({ ok: false, error: 'That record was not found.' });
});

testWithSupabase('an owner saves the attendance settings, and the provider reads them back', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const saved = await saveAttendanceSettings(ctx, { work_week: ['sat', 'mon', 'tue'], work_start_time: '08:30', late_grace_minutes: 10 });
  expect(saved).toEqual({
    ok: true,
    data: { work_week: ['mon', 'tue', 'sat'], work_start_time: '08:30', late_grace_minutes: 10 },
  });

  const read = await createSupabasePeopleData(owner.c, owner.orgId).getSettings();
  expect(read).toMatchObject({ work_week: ['mon', 'tue', 'sat'], work_start_time: '08:30', late_grace_minutes: 10 });

  expect(
    await saveAttendanceSettings(ctx, { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 15 }),
  ).toMatchObject({ ok: true });
});

testWithSupabase('a demo guest changes nothing', async () => {
  const ctx = { client: guest.c, orgId: guest.demoId };
  expect(await correctAttendance(ctx, { employee_id: DEMO_EMPLOYEE_ID, work_date: MONDAY, status: 'absent' })).toEqual(REFUSED);
  expect(await saveHoliday(ctx, { name: 'Nothing', holiday_date: '2026-12-25' })).toEqual(REFUSED);
  expect(
    await saveAttendanceSettings(ctx, { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 15 }),
  ).toEqual(REFUSED);

  // A holiday of a workspace the caller does not run is "not found", the same as an id that is not a holiday.
  const { data } = await guest.c.from('hr_public_holidays').select('id').eq('org_id', guest.demoId).limit(1);
  const demoHoliday = data?.[0]?.id as string | undefined;
  if (demoHoliday) {
    expect(await deleteHoliday(ctx, { id: demoHoliday })).toEqual({ ok: false, error: 'That record was not found.' });
  }
});

testWithSupabase('an owner cannot change the demo workspace by naming it', async () => {
  // The write path takes the workspace from the context; a caller who points it elsewhere is refused.
  const elsewhere = { client: owner.c, orgId: guest.demoId };
  expect(await saveHoliday(elsewhere, { name: 'Nothing', holiday_date: '2026-12-26' })).toEqual(REFUSED);
  expect(
    await saveAttendanceSettings(elsewhere, { work_week: ['mon'], work_start_time: '09:00', late_grace_minutes: 15 }),
  ).toEqual(REFUSED);
});
