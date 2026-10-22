/**
 * Live test of the roster and hours write path against the real database. It needs
 * 20261124140000_people_rosters_and_hours.sql applied; until then it fails at the first call (the functions do
 * not exist). Skipped without Supabase env vars.
 *
 * Who may do what (a member, a manager, the edit window, another workspace) is covered by
 * supabase/tests/people_rosters_hours_check.sql. Workspaces and users come from tests/helpers/live-workspaces.ts,
 * which also removes them, so nothing is left behind.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createEmployee } from '@/lib/people/capabilities';
import { ROSTER_REFUSALS, archiveShiftType, ensureShiftTypes, saveHours, saveRoster, saveShiftType } from '@/lib/people/roster-writes';
import { createSupabasePeopleData } from '@/lib/people/supabase';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, liveClient, signInAnon, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// A past Monday, so its days are past whatever today is.
const MONDAY = '2026-03-02';

let owner: { c: SupabaseClient; orgId: string };
let guest: { c: SupabaseClient; demoId: string };

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = liveClient();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'People Rosters Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  owner = { c, orgId: org.data as string };

  const g = liveClient();
  expect((await signInAnon(g)).error).toBeNull();
  const demo = await joinDemo(g);
  expect(demo.error, demo.error?.message).toBeNull();
  guest = { c: g, demoId: demo.data as string };
});
afterAll(async () => {
  await owner?.c.auth.signOut();
  await guest?.c.auth.signOut();
});

testWithSupabase('an owner saves a week of the roster, changes it, and the provider reads it back', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const made = await createEmployee(ctx, { name: 'Hana Roslan' });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  const id = made.data.id;

  // A new workspace has no shift types until an owner first needs them.
  const data = createSupabasePeopleData(owner.c, owner.orgId);
  expect(await ensureShiftTypes(ctx)).toBe(3);
  expect(await ensureShiftTypes(ctx)).toBe(0);
  const types = await data.listShiftTypes();
  expect(types.map((t) => [t.name, t.start_time, t.end_time, t.is_off])).toEqual([
    ['Morning', '09:00', '18:00', false], ['Night', '21:00', '06:00', false], ['Off', null, null, true],
  ]);
  const [morning, night, off] = types.map((t) => t.id);

  const first = await saveRoster(ctx, {
    week_start: MONDAY,
    cells: [
      { employee_id: id, work_date: MONDAY, shift_type_id: morning },
      { employee_id: id, work_date: '2026-03-03', shift_type_id: night },
    ],
  });
  expect(first).toEqual({ ok: true, data: { week: MONDAY, saved: 2, removed: 0 } });

  const second = await saveRoster(ctx, {
    week_start: MONDAY,
    cells: [
      { employee_id: id, work_date: MONDAY, shift_type_id: off },
      { employee_id: id, work_date: '2026-03-03', shift_type_id: null },
    ],
  });
  expect(second).toEqual({ ok: true, data: { week: MONDAY, saved: 1, removed: 1 } });

  const shifts = await data.listShifts(MONDAY, '2026-03-08');
  expect(shifts.map((s) => [s.work_date, s.shift_type_id])).toEqual([[MONDAY, off]]);

  // A custom type that crosses midnight; once archived it stays on its shift but cannot be picked again.
  const late = await saveShiftType(ctx, { name: 'Graveyard', is_off: false, start_time: '22:00', end_time: '06:00', color: 'slate' });
  expect(late).toMatchObject({ ok: true, data: { name: 'Graveyard', start_time: '22:00', end_time: '06:00', archived: false } });
  if (!late.ok) return;
  expect(await saveRoster(ctx, { week_start: MONDAY, cells: [{ employee_id: id, work_date: '2026-03-04', shift_type_id: late.data.id }] })).toMatchObject({ ok: true });
  expect(await archiveShiftType(ctx, { id: late.data.id, archived: true })).toMatchObject({ ok: true, data: { archived: true } });
  expect(await saveRoster(ctx, { week_start: MONDAY, cells: [{ employee_id: id, work_date: '2026-03-05', shift_type_id: late.data.id }] })).toEqual({
    ok: false, error: ROSTER_REFUSALS.ROSTER_ARCHIVED_SHIFT_TYPE,
  });
  expect((await data.listShifts('2026-03-04', '2026-03-04'))[0]?.shift_type_id).toBe(late.data.id);

  // The database refuses a week that does not start on a Monday, whatever the app sends.
  const raw = await owner.c.rpc('hr_save_roster', { p_org: owner.orgId, p_week: '2026-03-03', p_cells: [] });
  expect(raw.error?.message).toMatch(/^ROSTER_NOT_MONDAY/);
});

testWithSupabase('an owner records, corrects and clears a day of hours for anyone', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };
  const made = await createEmployee(ctx, { name: 'Imran Zaki' });
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) return;
  const id = made.data.id;

  expect(await saveHours(ctx, { employee_id: id, work_date: MONDAY, hours: 8, billable_hours: 6 })).toEqual({
    ok: true, data: { employee_id: id, work_date: MONDAY, hours: 8, billable_hours: 6 },
  });
  expect(await saveHours(ctx, { employee_id: id, work_date: MONDAY, hours: 7.5, billable_hours: null })).toMatchObject({
    ok: true, data: { hours: 7.5, billable_hours: 0 },
  });
  const entries = await createSupabasePeopleData(owner.c, owner.orgId).listTimesheet(MONDAY, MONDAY);
  expect(entries).toHaveLength(1);
  expect(Number(entries[0].hours)).toBe(7.5);

  expect(await saveHours(ctx, { employee_id: id, work_date: MONDAY, hours: null, billable_hours: null })).toMatchObject({
    ok: true, data: { hours: null },
  });
  expect(await createSupabasePeopleData(owner.c, owner.orgId).listTimesheet(MONDAY, MONDAY)).toEqual([]);

  // A day still to come is refused by the database.
  const raw = await owner.c.rpc('hr_save_hours', { p_employee: id, p_work_date: '2100-01-01', p_hours: 1, p_billable: null });
  expect(raw.error?.message).toMatch(/^HOURS_FUTURE_DAY/);
});

testWithSupabase('a demo guest changes nothing', async () => {
  const ctx = { client: guest.c, orgId: guest.demoId };
  const demoType = (await createSupabasePeopleData(guest.c, guest.demoId).listShiftTypes())[0]?.id ?? '44444444-4444-4444-8444-444444444444';
  expect(await saveRoster(ctx, { week_start: MONDAY, cells: [{ employee_id: DEMO_EMPLOYEE_ID, work_date: MONDAY, shift_type_id: demoType }] })).toEqual({
    ok: false, error: ROSTER_REFUSALS.ROSTER_NOT_ALLOWED,
  });
  expect(await saveHours(ctx, { employee_id: DEMO_EMPLOYEE_ID, work_date: MONDAY, hours: 8, billable_hours: null })).toEqual({
    ok: false, error: ROSTER_REFUSALS.HOURS_NOT_ALLOWED,
  });
  expect(await saveShiftType(ctx, { name: 'Demo', is_off: true, start_time: null, end_time: null, color: 'stone' })).toEqual({
    ok: false, error: ROSTER_REFUSALS.SHIFT_TYPE_NOT_ALLOWED,
  });
});
