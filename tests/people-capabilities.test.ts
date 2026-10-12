import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDepartment,
  createDepartmentInput,
  createEmployee,
  createEmployeeInput,
  deleteDepartment,
  deleteDepartmentInput,
  deleteEmployee,
  linkEmployeeToMember,
  setEmployeeStatus,
  updateDepartment,
  updateEmployee,
  updateEmployeeInput,
  WRITE_FAILED,
  writeOutcome,
} from '@/lib/people/capabilities';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = 'org-1';
const DEPT = '11111111-1111-4111-8111-111111111111';
const ctxOf = (client: never) => ({ client, orgId: ORG });

afterEach(() => vi.restoreAllMocks());

describe('writeOutcome', () => {
  it('is saved for an ok result', () => {
    expect(writeOutcome({ ok: true, data: null })).toBe('saved');
  });

  it('is unknown for the generic failure (a lost call may have been saved), so a form keeps its file', () => {
    expect(writeOutcome({ ok: false, error: WRITE_FAILED })).toBe('unknown');
  });

  it('is refused for any sentence the rules produced', () => {
    expect(writeOutcome({ ok: false, error: 'That receipt cannot be used.' })).toBe('refused');
    expect(writeOutcome({ ok: false, error: '' })).toBe('refused');
  });
});

describe('department schemas', () => {
  it('refuses a blank name with a message for the person typing', () => {
    const parsed = createDepartmentInput.safeParse({ name: '   ' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].message).toBe('Give the department a name.');
  });
  it('trims the name', () => {
    expect(createDepartmentInput.parse({ name: '  Sales ' })).toEqual({ name: 'Sales' });
  });
  it('refuses a name over 80 characters', () => {
    expect(createDepartmentInput.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
  });
});

describe('createDepartment', () => {
  it('saves the name under the workspace from the context, never one from the input', async () => {
    const { client, calls } = fakeSupabase({
      'hr_departments.insert': { data: { id: DEPT, name: 'Sales', created_at: '2026-10-11T00:00:00Z' } },
    });
    const result = await createDepartment(ctxOf(client), { name: 'Sales', org_id: 'someone-else' } as never);
    expect(result).toEqual({ ok: true, data: { id: DEPT, name: 'Sales', created_at: '2026-10-11T00:00:00Z' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'hr_departments', op: 'insert', values: { name: 'Sales', org_id: ORG } });
  });

  it('says so when the name is taken', async () => {
    const { client } = fakeSupabase({
      'hr_departments.insert': {
        error: { code: '23505', message: 'duplicate key value violates unique constraint "hr_departments_org_name_idx"' },
      },
    });
    expect(await createDepartment(ctxOf(client), { name: 'Sales' })).toEqual({
      ok: false,
      error: 'A department with that name already exists.',
    });
  });

  it('gives a plain message for any other failure and logs no input', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'hr_departments.insert': { error: { code: '42501', message: 'permission denied for table hr_departments' } },
    });
    expect(await createDepartment(ctxOf(client), { name: 'Secret Projects' })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(JSON.stringify(log.mock.calls)).toContain('42501');
    expect(JSON.stringify(log.mock.calls)).not.toContain('Secret Projects');
  });
});

describe('updateDepartment', () => {
  it('renames within the workspace and sends only the name', async () => {
    const { client, calls } = fakeSupabase({
      'hr_departments.update': { data: { id: DEPT, name: 'Field Sales', created_at: '2026-10-11T00:00:00Z' } },
    });
    const result = await updateDepartment(ctxOf(client), { id: DEPT, name: 'Field Sales' });
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ op: 'update', values: { name: 'Field Sales' }, filters: { id: DEPT, org_id: ORG } });
    expect(Object.keys(calls[0].values as object)).toEqual(['name']);
  });

  it('says when the department is not there', async () => {
    const { client } = fakeSupabase({ 'hr_departments.update': { data: null } });
    expect(await updateDepartment(ctxOf(client), { id: DEPT, name: 'X' })).toEqual({
      ok: false,
      error: 'That department was not found.',
    });
  });

  it('says so when the new name is taken', async () => {
    const { client } = fakeSupabase({
      'hr_departments.update': {
        error: { code: '23505', message: 'duplicate key value violates unique constraint "hr_departments_org_name_idx"' },
      },
    });
    expect(await updateDepartment(ctxOf(client), { id: DEPT, name: 'Sales' })).toEqual({
      ok: false,
      error: 'A department with that name already exists.',
    });
  });
});

describe('deleteDepartment', () => {
  it('refuses while employees are still in it', async () => {
    const { client } = fakeSupabase({
      'hr_departments.delete': { error: { code: '23503', message: 'violates foreign key constraint' } },
    });
    expect(await deleteDepartment(ctxOf(client), { id: DEPT })).toEqual({
      ok: false,
      error: 'That department still has employees, including inactive ones. Move them to another department first.',
    });
  });

  it('deletes within the workspace and hands back what it deleted', async () => {
    const { client, calls } = fakeSupabase({ 'hr_departments.delete': { data: { id: DEPT, name: 'Sales' } } });
    expect(await deleteDepartment(ctxOf(client), { id: DEPT })).toEqual({ ok: true, data: { id: DEPT, name: 'Sales' } });
    expect(calls[0].filters).toEqual({ id: DEPT, org_id: ORG });
  });

  it('says when the department is not there', async () => {
    const { client } = fakeSupabase({ 'hr_departments.delete': { data: null } });
    expect(await deleteDepartment(ctxOf(client), { id: DEPT })).toEqual({
      ok: false,
      error: 'That department was not found.',
    });
  });
});

const EMP = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const saved = { id: EMP, name: 'Farah Idris', employee_no: 'EMP-021' };

describe('employee schemas', () => {
  it('needs a name to add someone', () => {
    const parsed = createEmployeeInput.safeParse({ name: ' ' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].message).toBe('Give the employee a name.');
  });
  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(createEmployeeInput.safeParse({ name: 'A', join_date: '1 Nov 2026' }).success).toBe(false);
  });
  it('refuses a negative salary', () => {
    expect(createEmployeeInput.safeParse({ name: 'A', private: { base_salary: -1 } }).success).toBe(false);
  });
  it('lets an edit carry only what changes', () => {
    expect(updateEmployeeInput.parse({ id: EMP, designation: 'Senior Designer' })).toEqual({
      id: EMP,
      designation: 'Senior Designer',
    });
  });
});

describe('createEmployee', () => {
  it('assigns the next EMP number after the highest, ignoring irregular ones', async () => {
    const { client, calls } = fakeSupabase({
      'hr_employees.select': { data: [{ employee_no: 'EMP-001' }, { employee_no: 'A17' }, { employee_no: 'EMP-020' }] },
      'hr_employees.insert': { data: saved },
    });
    const result = await createEmployee(ctxOf(client), { name: 'Farah Idris', designation: 'Sales Executive' });
    expect(result).toEqual({ ok: true, data: saved });
    const insert = calls.find((c) => c.op === 'insert')!;
    expect(insert.values).toMatchObject({
      org_id: ORG,
      name: 'Farah Idris',
      employee_no: 'EMP-021',
      designation: 'Sales Executive',
    });
    // No pay or identity detail was given, so no private row is made.
    expect(calls.some((c) => c.table === 'hr_employee_private')).toBe(false);
  });

  it('starts at EMP-001 in an empty workspace', async () => {
    const { client, calls } = fakeSupabase({
      'hr_employees.select': { data: [] },
      'hr_employees.insert': { data: { ...saved, employee_no: 'EMP-001' } },
    });
    await createEmployee(ctxOf(client), { name: 'Farah Idris' });
    expect(calls.find((c) => c.op === 'insert')!.values).toMatchObject({ employee_no: 'EMP-001' });
  });

  it('keeps a number that was given, and does not read the others', async () => {
    const { client, calls } = fakeSupabase({ 'hr_employees.insert': { data: { ...saved, employee_no: 'S-9' } } });
    await createEmployee(ctxOf(client), { name: 'Farah Idris', employee_no: 'S-9' });
    expect(calls.map((c) => c.op)).toEqual(['insert']);
    expect(calls[0].values).toMatchObject({ employee_no: 'S-9' });
  });

  it('stores a blank work email as empty and a given one in lower case', async () => {
    const blank = fakeSupabase({ 'hr_employees.select': { data: [] }, 'hr_employees.insert': { data: saved } });
    await createEmployee(ctxOf(blank.client), { name: 'Farah Idris', work_email: '  ' });
    expect(blank.calls.find((c) => c.op === 'insert')!.values).toMatchObject({ work_email: null });

    const given = fakeSupabase({ 'hr_employees.select': { data: [] }, 'hr_employees.insert': { data: saved } });
    await createEmployee(ctxOf(given.client), { name: 'Farah Idris', work_email: ' Farah@Example.com ' });
    expect(given.calls.find((c) => c.op === 'insert')!.values).toMatchObject({ work_email: 'farah@example.com' });
  });

  it('refuses a work email that is not one, before touching the database', async () => {
    const { client, calls } = fakeSupabase();
    expect(await createEmployee(ctxOf(client), { name: 'Farah Idris', work_email: 'farah-at-example' })).toEqual({
      ok: false,
      error: 'That work email does not look right.',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a date that does not exist', async () => {
    const { client } = fakeSupabase();
    expect(await createEmployee(ctxOf(client), { name: 'Farah Idris', join_date: '2026-02-31' })).toEqual({
      ok: false,
      error: 'Join date must be a real date, as YYYY-MM-DD.',
    });
  });

  it('saves pay and identity details in the private table, in cents, with the birthday on the directory row', async () => {
    const { client, calls } = fakeSupabase({
      'hr_employees.select': { data: [] },
      'hr_employees.insert': { data: saved },
    });
    await createEmployee(ctxOf(client), {
      name: 'Farah Idris',
      private: { base_salary: 3500.5, nric: ' 900101-14-5678 ', date_of_birth: '1990-01-09', phone: '' },
    });
    expect(calls.find((c) => c.table === 'hr_employees' && c.op === 'insert')!.values).toMatchObject({
      date_of_birth_day: 9,
      date_of_birth_month: 1,
    });
    const priv = calls.find((c) => c.table === 'hr_employee_private')!;
    expect(priv.op).toBe('insert');
    expect(priv.values).toEqual({
      employee_id: EMP,
      org_id: ORG,
      base_salary_cents: 350050,
      nric: '900101-14-5678',
      date_of_birth: '1990-01-09',
      phone: null,
    });
  });

  it('removes the employee again when the private details cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, calls } = fakeSupabase({
      'hr_employees.select': { data: [] },
      'hr_employees.insert': { data: saved },
      'hr_employee_private.insert': { error: { code: '42501', message: 'permission denied' } },
      'rpc.hr_delete_employee': { data: { id: EMP, name: 'Farah Idris', document_paths: [] } },
    });
    const result = await createEmployee(ctxOf(client), { name: 'Farah Idris', private: { base_salary: 3000 } });
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    // Through the function, never a delete on the table: signed-in users hold no DELETE on hr_employees.
    expect(calls.filter((c) => c.op === 'delete')).toEqual([]);
    const undo = calls.filter((c) => c.op === 'rpc');
    expect(undo).toHaveLength(1);
    expect(undo[0]).toMatchObject({ fn: 'hr_delete_employee', args: { p_org: ORG, p_employee: EMP } });
    expect(calls.at(-1)).toBe(undo[0]);
  });

  it('names the clash when the employee number or email is taken', async () => {
    const no = fakeSupabase({
      'hr_employees.insert': {
        error: { code: '23505', message: 'duplicate key value violates unique constraint "hr_employees_org_id_employee_no_key"' },
      },
    });
    expect(await createEmployee(ctxOf(no.client), { name: 'A', employee_no: 'EMP-001' })).toEqual({
      ok: false,
      error: 'Another employee already has that employee number.',
    });
    const email = fakeSupabase({
      'hr_employees.insert': {
        error: { code: '23505', message: 'duplicate key value violates unique constraint "hr_employees_org_email_idx"' },
      },
    });
    expect(await createEmployee(ctxOf(email.client), { name: 'A', employee_no: 'X1', work_email: 'a@b.co' })).toEqual({
      ok: false,
      error: 'Another employee already has that work email.',
    });
  });

  it('never logs what was typed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'hr_employees.insert': { error: { code: '42501', message: 'permission denied' } },
    });
    await createEmployee(ctxOf(client), {
      name: 'Farah Idris',
      employee_no: 'X1',
      private: { nric: '900101-14-5678', bank_account: '1234567890', base_salary: 9999 },
    });
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of ['900101-14-5678', '1234567890', '9999', 'Farah']) expect(logged).not.toContain(secret);
  });
});

describe('updateEmployee', () => {
  const current = { 'hr_employees.select': { data: saved } };

  it('sends only what changed, and never the columns the database will not let it set', async () => {
    const { client, calls } = fakeSupabase({
      ...current,
      'hr_employees.update': { data: { ...saved, name: 'Farah I.' } },
    });
    const result = await updateEmployee(ctxOf(client), { id: EMP, name: 'Farah I.', designation: '' });
    expect(result).toEqual({ ok: true, data: { ...saved, name: 'Farah I.' } });
    const update = calls.find((c) => c.op === 'update')!;
    expect(update.values).toEqual({ name: 'Farah I.', designation: null });
    expect(update.filters).toEqual({ id: EMP, org_id: ORG });
  });

  it('says there is nothing to update when no field was given', async () => {
    const { client, calls } = fakeSupabase();
    expect(await updateEmployee(ctxOf(client), { id: EMP })).toEqual({ ok: false, error: 'Nothing to update.' });
    expect(calls).toHaveLength(0);
  });

  it('says when the employee is not there', async () => {
    const { client } = fakeSupabase({ 'hr_employees.select': { data: null } });
    expect(await updateEmployee(ctxOf(client), { id: EMP, name: 'X' })).toEqual({
      ok: false,
      error: 'That employee was not found.',
    });
  });

  it('inserts the private row when there is none yet, and never upserts', async () => {
    const { client, calls } = fakeSupabase({ ...current, 'hr_employee_private.select': { data: null } });
    const result = await updateEmployee(ctxOf(client), { id: EMP, private: { bank_name: 'Maybank' } });
    expect(result).toEqual({ ok: true, data: saved });
    const writes = calls.filter((c) => c.table === 'hr_employee_private' && c.op !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: 'insert', values: { employee_id: EMP, org_id: ORG, bank_name: 'Maybank' } });
  });

  it('updates the private row when there is one, without the key columns', async () => {
    const { client, calls } = fakeSupabase({ ...current, 'hr_employee_private.select': { data: { employee_id: EMP } } });
    await updateEmployee(ctxOf(client), { id: EMP, private: { base_salary: null, phone: '012-3456789' } });
    const write = calls.find((c) => c.table === 'hr_employee_private' && c.op === 'update')!;
    expect(write.values).toEqual({ base_salary_cents: null, phone: '012-3456789' });
    expect(write.filters).toEqual({ employee_id: EMP, org_id: ORG });
  });

  it('makes no empty private row when every private value is blank and none exists', async () => {
    const { client, calls } = fakeSupabase({ ...current, 'hr_employee_private.select': { data: null } });
    const result = await updateEmployee(ctxOf(client), { id: EMP, private: { phone: '', nric: null } });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.table === 'hr_employee_private' && c.op === 'insert')).toBe(false);
  });

  it('says which half was saved when the private details fail after the directory ones', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      ...current,
      'hr_employees.update': { data: saved },
      'hr_employee_private.select': { data: { employee_id: EMP } },
      'hr_employee_private.update': { error: { code: '42501', message: 'permission denied' } },
    });
    expect(await updateEmployee(ctxOf(client), { id: EMP, name: 'Farah Idris', private: { phone: '1' } })).toEqual({
      ok: false,
      error: 'The directory details were saved, but the private details were not. Please try again.',
    });
  });

  it('says when the department is not there', async () => {
    const { client } = fakeSupabase({
      ...current,
      'hr_employees.update': { error: { code: '23503', message: 'violates foreign key constraint' } },
    });
    expect(await updateEmployee(ctxOf(client), { id: EMP, department_id: DEPT })).toEqual({
      ok: false,
      error: 'That department was not found.',
    });
  });
});

describe('setEmployeeStatus, deleteEmployee', () => {
  it('deactivates by changing the status only', async () => {
    const { client, calls } = fakeSupabase({
      'hr_employees.select': { data: saved },
      'hr_employees.update': { data: saved },
    });
    expect((await setEmployeeStatus(ctxOf(client), { id: EMP, status: 'inactive' })).ok).toBe(true);
    expect(calls.find((c) => c.op === 'update')!.values).toEqual({ status: 'inactive' });
  });

  it('deletes through the database function in the session workspace and hands back who it was', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_delete_employee': { data: { id: EMP, name: 'Farah Idris', document_paths: [] } },
    });
    expect(await deleteEmployee(ctxOf(client), { id: EMP })).toEqual({ ok: true, data: { id: EMP, name: 'Farah Idris' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fn: 'hr_delete_employee', args: { p_org: ORG, p_employee: EMP } });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_employee', 'p_org']);
  });

  it('removes each document file the database returned, one path at a time and after the delete, and never returns them', async () => {
    const A = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/abcdef01-aaaa-4bbb-8ccc-0123456789ab.pdf';
    const B = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/abcdef02-aaaa-4bbb-8ccc-0123456789ab.png';
    const { client } = fakeSupabase({
      'rpc.hr_delete_employee': { data: { id: EMP, name: 'Farah Idris', document_paths: [A, B] } },
    });
    const removed: string[][] = [];
    const result = await deleteEmployee(ctxOf(client), { id: EMP }, async (paths) => void removed.push([...paths]));
    expect(removed).toEqual([[A, B]]);
    expect(result).toEqual({ ok: true, data: { id: EMP, name: 'Farah Idris' } });
    expect(JSON.stringify(result)).not.toContain('abcdef01');
  });

  it('removes nothing for an employee with no files', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_delete_employee': { data: { id: EMP, name: 'Farah Idris', document_paths: [] } } });
    const removeFiles = vi.fn(async () => {});
    await deleteEmployee(ctxOf(client), { id: EMP }, removeFiles);
    expect(removeFiles).not.toHaveBeenCalled();
  });

  it('does not remove a file when the delete is refused or finds nobody', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const removeFiles = vi.fn(async () => {});
    for (const reply of [
      { data: null },
      { error: { code: 'P0001', message: 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS' } },
      { error: { code: 'XX000', message: 'boom' } },
    ]) {
      const { client } = fakeSupabase({ 'rpc.hr_delete_employee': reply });
      await deleteEmployee(ctxOf(client), { id: EMP }, removeFiles);
    }
    expect(removeFiles).not.toHaveBeenCalled();
  });

  it('is not failed by a file that cannot be removed, and logs no path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const PATH = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/abcdef01-aaaa-4bbb-8ccc-0123456789ab.pdf';
    const { client } = fakeSupabase({ 'rpc.hr_delete_employee': { data: { id: EMP, name: 'Farah Idris', document_paths: [PATH] } } });
    const result = await deleteEmployee(ctxOf(client), { id: EMP }, async () => {
      throw new Error(`boom ${PATH}`);
    });
    expect(result).toEqual({ ok: true, data: { id: EMP, name: 'Farah Idris' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(PATH);
  });

  it('refuses an employee with a paid payslip in the payroll sentence, and logs nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_delete_employee': { error: { code: 'P0001', message: 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS' } },
    });
    expect(await deleteEmployee(ctxOf(client), { id: EMP })).toEqual({
      ok: false,
      error: 'This employee has paid payslips. Make them inactive instead.',
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('answers any other delete error generically', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_delete_employee': { error: { code: 'P0001', message: 'something about HR_EMPLOYEE_HAS_PAID_PAYSLIPS elsewhere' } },
    });
    const result = await deleteEmployee(ctxOf(client), { id: EMP });
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });

  it('says when the employee is not there (the function answers null)', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_delete_employee': { data: null } });
    expect(await deleteEmployee(ctxOf(client), { id: EMP })).toEqual({ ok: false, error: 'That employee was not found.' });
  });

  it('treats a reply that is not an employee as a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_delete_employee': { data: { id: 5 } } });
    expect(await deleteEmployee(ctxOf(client), { id: EMP })).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });
});

describe('linkEmployeeToMember', () => {
  it('links by setting user_id only, and unlinks with null', async () => {
    const link = fakeSupabase({ 'hr_employees.update': { data: { id: EMP, name: 'Farah Idris', user_id: USER } } });
    expect(await linkEmployeeToMember(ctxOf(link.client), { id: EMP, user_id: USER })).toEqual({
      ok: true,
      data: { id: EMP, name: 'Farah Idris', user_id: USER },
    });
    expect(link.calls[0]).toMatchObject({ values: { user_id: USER }, filters: { id: EMP, org_id: ORG } });

    const unlink = fakeSupabase({ 'hr_employees.update': { data: { id: EMP, name: 'Farah Idris', user_id: null } } });
    await linkEmployeeToMember(ctxOf(unlink.client), { id: EMP, user_id: null });
    expect(unlink.calls[0].values).toEqual({ user_id: null });
  });

  it('says so when that member is already linked to someone else', async () => {
    const { client } = fakeSupabase({
      'hr_employees.update': {
        error: { code: '23505', message: 'duplicate key value violates unique constraint "hr_employees_org_user_idx"' },
      },
    });
    expect(await linkEmployeeToMember(ctxOf(client), { id: EMP, user_id: USER })).toEqual({
      ok: false,
      error: 'That member is already linked to another employee.',
    });
  });

  it('says so when the person is not in the workspace', async () => {
    const { client } = fakeSupabase({
      'hr_employees.update': { error: { code: 'P0001', message: 'that user is not a member of this workspace' } },
    });
    expect(await linkEmployeeToMember(ctxOf(client), { id: EMP, user_id: USER })).toEqual({
      ok: false,
      error: 'That person is not a member of this workspace.',
    });
  });
});

describe('ids and bad input', () => {
  const ODD = 'dea97d89-a5b6-f264-bd42-c6df73f664a7';
  it('accepts any database uuid and refuses a non-id', () => {
    expect(updateEmployeeInput.safeParse({ id: ODD }).success).toBe(true);
    expect(deleteDepartmentInput.safeParse({ id: ODD }).success).toBe(true);
    expect(updateEmployeeInput.safeParse({ id: 'not-an-id' }).success).toBe(false);
    expect(deleteDepartmentInput.safeParse({ id: 'not-an-id' }).success).toBe(false);
  });
  it('refuses bad input in words, without a database call', async () => {
    const { client, calls } = fakeSupabase();
    expect(await createDepartment(ctxOf(client), { name: ' ' })).toEqual({ ok: false, error: 'Give the department a name.' });
    const bad = await deleteEmployee(ctxOf(client), { id: 'not-an-id' });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('logs it when the rollback of a half-made employee fails too', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'hr_employees.select': { data: [] },
      'hr_employees.insert': { data: saved },
      'hr_employee_private.insert': { error: { code: '42501', message: 'permission denied' } },
      'rpc.hr_delete_employee': { error: { code: '57014', message: 'canceling statement' } },
    });
    const result = await createEmployee(ctxOf(client), { name: 'Farah Idris', private: { base_salary: 3000 } });
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('rollback');
    expect(logged).toContain('57014');
    expect(logged).not.toContain('3000');
  });
  it('logs it when the rollback of a half-made employee removes nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'hr_employees.select': { data: [] },
      'hr_employees.insert': { data: saved },
      'hr_employee_private.insert': { error: { code: '42501', message: 'permission denied' } },
      'rpc.hr_delete_employee': { data: null },
    });
    const result = await createEmployee(ctxOf(client), { name: 'Farah Idris', private: { base_salary: 3000 } });
    expect(result).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    const rollback = log.mock.calls.filter((c) => String(c[0]).includes('rollback'));
    expect(rollback).toHaveLength(1);
    expect(JSON.stringify(rollback)).toContain('the employee was not removed');
  });
});
