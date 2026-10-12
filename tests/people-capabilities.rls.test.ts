import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import {
  createDepartment,
  createEmployee,
  deleteDepartment,
  deleteEmployee,
  linkEmployeeToMember,
  setEmployeeStatus,
  updateEmployee,
} from '@/lib/people/capabilities';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

let owner: { c: SupabaseClient; orgId: string; userId: string };
let guest: { c: SupabaseClient; demoId: string };

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const c = client();
  const signedIn = await signInOwner(c);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const org = await createOrg(c, 'People Capabilities Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();
  owner = { c, orgId: org.data as string, userId: signedIn.data.user!.id };

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

testWithSupabase('an owner adds, edits, links and deletes through the capabilities', async () => {
  const ctx = { client: owner.c, orgId: owner.orgId };

  const sales = await createDepartment(ctx, { name: 'Sales' });
  expect(sales.ok, JSON.stringify(sales)).toBe(true);
  if (!sales.ok) return;
  expect(await createDepartment(ctx, { name: ' sales ' })).toEqual({
    ok: false,
    error: 'A department with that name already exists.',
  });

  // First employee: assigned EMP-001, email lower-cased, private row and birthday written.
  const farah = await createEmployee(ctx, {
    name: 'Farah Idris',
    department_id: sales.data.id,
    work_email: 'Farah@Example.com',
    private: { base_salary: 3500, date_of_birth: '1990-01-09' },
  });
  expect(farah.ok, JSON.stringify(farah)).toBe(true);
  if (!farah.ok) return;
  expect(farah.data.employee_no).toBe('EMP-001');

  const row = await owner.c
    .from('hr_employees')
    .select('work_email,date_of_birth_day,date_of_birth_month,user_id')
    .eq('id', farah.data.id)
    .single();
  expect(row.data).toEqual({ work_email: 'farah@example.com', date_of_birth_day: 9, date_of_birth_month: 1, user_id: null });
  const priv = await owner.c
    .from('hr_employee_private')
    .select('base_salary_cents,date_of_birth')
    .eq('employee_id', farah.data.id)
    .single();
  expect(priv.data).toEqual({ base_salary_cents: 350000, date_of_birth: '1990-01-09' });

  // Second employee: next number, no private row until one is edited in.
  const amir = await createEmployee(ctx, { name: 'Amir Hakim' });
  expect(amir.ok, JSON.stringify(amir)).toBe(true);
  if (!amir.ok) return;
  expect(amir.data.employee_no).toBe('EMP-002');
  const none = await owner.c.from('hr_employee_private').select('employee_id').eq('employee_id', amir.data.id);
  expect(none.data).toEqual([]);

  const added = await updateEmployee(ctx, { id: amir.data.id, private: { bank_name: 'Maybank' } });
  expect(added.ok, JSON.stringify(added)).toBe(true);
  const changed = await updateEmployee(ctx, { id: amir.data.id, designation: 'Technician', private: { bank_name: 'CIMB', phone: '012-3456789' } });
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  const bank = await owner.c.from('hr_employee_private').select('bank_name,phone').eq('employee_id', amir.data.id).single();
  expect(bank.data).toEqual({ bank_name: 'CIMB', phone: '012-3456789' });

  // Clashes come back as plain messages.
  expect(await updateEmployee(ctx, { id: amir.data.id, work_email: 'FARAH@example.com' })).toEqual({
    ok: false,
    error: 'Another employee already has that work email.',
  });
  expect(await updateEmployee(ctx, { id: amir.data.id, employee_no: 'EMP-001' })).toEqual({
    ok: false,
    error: 'Another employee already has that employee number.',
  });
  expect(await deleteDepartment(ctx, { id: sales.data.id })).toEqual({
    ok: false,
    error: 'That department still has employees, including inactive ones. Move them to another department first.',
  });

  // Linking: only a member of the workspace, and one employee per member.
  expect(await linkEmployeeToMember(ctx, { id: farah.data.id, user_id: '99999999-9999-4999-8999-999999999999' })).toEqual({
    ok: false,
    error: 'That person is not a member of this workspace.',
  });
  expect((await linkEmployeeToMember(ctx, { id: farah.data.id, user_id: owner.userId })).ok).toBe(true);
  expect(await linkEmployeeToMember(ctx, { id: amir.data.id, user_id: owner.userId })).toEqual({
    ok: false,
    error: 'That member is already linked to another employee.',
  });
  expect((await linkEmployeeToMember(ctx, { id: farah.data.id, user_id: null })).ok).toBe(true);

  expect((await setEmployeeStatus(ctx, { id: amir.data.id, status: 'inactive' })).ok).toBe(true);

  // Deleting takes the private row with it; then the department is free to go.
  expect((await deleteEmployee(ctx, { id: farah.data.id })).ok).toBe(true);
  expect((await deleteEmployee(ctx, { id: amir.data.id })).ok).toBe(true);
  const left = await owner.c.from('hr_employee_private').select('employee_id').eq('org_id', owner.orgId);
  expect(left.data).toEqual([]);
  expect((await deleteDepartment(ctx, { id: sales.data.id })).ok).toBe(true);
});

testWithSupabase('a demo guest changes nothing through the capabilities', async () => {
  const ctx = { client: guest.c, orgId: guest.demoId };
  expect((await createDepartment(ctx, { name: 'Guest Department' })).ok).toBe(false);
  expect((await createEmployee(ctx, { name: 'Guest Employee', employee_no: 'GUEST-1' })).ok).toBe(false);
  // Aisyah Rahim, the demo's fixed employee: an update that matches no row the guest may write.
  expect(await setEmployeeStatus(ctx, { id: 'dea97d89-a5b6-f264-bd42-c6df73f664a7', status: 'inactive' })).toMatchObject({ ok: false });
  const still = await guest.c
    .from('hr_employees')
    .select('status')
    .eq('id', 'dea97d89-a5b6-f264-bd42-c6df73f664a7')
    .single();
  expect(still.data?.status).toBe('active');
});
