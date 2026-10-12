import { describe, expect, it } from 'vitest';
import {
  buildEmployeesModel,
  employeeFormValues,
  filterEmployees,
  linkableMembers,
  suggestedMember,
  toEmployeeInput,
} from '@/lib/people/employees';
import { entitlementChanges, entitlementValues } from '@/components/people/entitlements-fields';
import { createSeedPeopleData } from '@/lib/people/seed';
import { todayInMalaysia } from '@/lib/people/dates';
import type { Employee } from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const data = createSeedPeopleData(NOW);
const employees = await data.listEmployees();
const departments = await data.listDepartments();

const person = (over: Partial<Employee>): Employee => ({ ...employees[0], ...over });

describe('buildEmployeesModel', () => {
  const model = buildEmployeesModel(employees, departments, TODAY);

  it('counts active staff, departments and the sizes of each department', () => {
    expect(model.totals.headcount).toBe(20);
    expect(model.totals.inactive).toBe(0);
    expect(model.totals.departments).toBe(5);
    expect(model.by_department[0]).toEqual({ department: 'Sales', headcount: 6 });
    expect(model.departments.find((d) => d.name === 'Sales')?.headcount).toBe(6);
  });

  it('puts everyone with a join date in exactly one tenure band', () => {
    expect(model.tenure.map((band) => band.label)).toEqual(['<1 yr', '1–2 yr', '2–3 yr', '3+ yr']);
    expect(model.tenure.reduce((sum, band) => sum + band.count, 0)).toBe(20);
  });

  it('counts each employment type', () => {
    expect(model.employment.find((e) => e.type === 'full_time')).toEqual({ type: 'full_time', label: 'Full-time', count: 17 });
    expect(model.employment.find((e) => e.type === 'contract')?.count).toBe(2);
    expect(model.employment.find((e) => e.type === 'part_time')?.count).toBe(1);
  });

  it('leaves inactive staff and people with no join date out of the figures, not out of the list', () => {
    const mixed = [
      person({ id: 'a', status: 'active', join_date: TODAY }),
      person({ id: 'b', status: 'inactive', join_date: '2020-01-01' }),
      person({ id: 'c', status: 'active', join_date: null }),
    ];
    const small = buildEmployeesModel(mixed, departments, TODAY);
    expect(small.employees).toHaveLength(3);
    expect(small.totals).toMatchObject({ headcount: 2, inactive: 1, new_joiners_90d: 1, avg_tenure_years: 0 });
    expect(small.tenure.reduce((sum, band) => sum + band.count, 0)).toBe(1);
  });

  it('has no average tenure when nobody has a join date', () => {
    expect(buildEmployeesModel([], [], TODAY).totals.avg_tenure_years).toBeNull();
  });
});

describe('filterEmployees', () => {
  const all = { query: '', departmentId: 'all', status: 'all' as const };
  it('searches name, email, employee number and designation in any letter case', () => {
    expect(filterEmployees(employees, { ...all, query: 'AISYAH' }).map((e) => e.name)).toEqual(['Aisyah Rahim']);
    expect(filterEmployees(employees, { ...all, query: 'emp-003' }).map((e) => e.name)).toEqual(['Ahmad Zaki']);
    expect(filterEmployees(employees, { ...all, query: 'technician' })).toHaveLength(2);
    expect(filterEmployees(employees, { ...all, query: 'zaki@' })).toHaveLength(1);
  });
  it('filters by department, by no department, and by status', () => {
    const sales = departments.find((d) => d.name === 'Sales')!.id;
    expect(filterEmployees(employees, { ...all, departmentId: sales })).toHaveLength(6);
    expect(filterEmployees(employees, { ...all, departmentId: 'none' })).toHaveLength(0);
    expect(filterEmployees([person({ department_id: null })], { ...all, departmentId: 'none' })).toHaveLength(1);
    expect(filterEmployees(employees, { ...all, status: 'inactive' })).toHaveLength(0);
  });
});

describe('the employee form', () => {
  it('starts empty for a new employee', () => {
    const values = employeeFormValues(null, null);
    expect(values).toMatchObject({ name: '', employee_no: '', department_id: '', employment_type: 'full_time', status: 'active', base_salary: '' });
  });

  it('starts from the saved record, with the salary back in ringgit', () => {
    const values = employeeFormValues(employees[0], {
      employee_id: employees[0].id, nric: '900101-14-5678', date_of_birth: '1990-01-09', phone: null, address: null,
      base_salary_cents: 350050, bank_name: null, bank_account: null, epf_no: null, socso_no: null, tax_no: null,
      emergency_contact_name: null, emergency_contact_phone: null,
    });
    expect(values).toMatchObject({ name: 'Aisyah Rahim', nric: '900101-14-5678', base_salary: '3500.5', phone: '' });
  });

  it('sends a cleared field as null and a blank employee number as "assign one"', () => {
    const result = toEmployeeInput(
      { ...employeeFormValues(null, null), name: ' Farah Idris ', work_email: '', join_date: '', base_salary: '3500' },
      { includePrivate: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({ name: 'Farah Idris', work_email: null, department_id: null, join_date: null });
    expect(result.input).not.toHaveProperty('employee_no');
    expect(result.input.private).toMatchObject({ base_salary: 3500, nric: null, date_of_birth: null });
  });

  it('leaves the private details out entirely when they could not be loaded, so a save cannot blank them', () => {
    const result = toEmployeeInput(employeeFormValues(employees[0], null), { includePrivate: false });
    expect(result.ok && 'private' in result.input).toBe(false);
  });

  it('refuses a salary that is not a number, before anything is sent', () => {
    expect(toEmployeeInput({ ...employeeFormValues(null, null), name: 'A', base_salary: 'tiga ribu' }, { includePrivate: true })).toEqual({
      ok: false,
      error: 'Salary must be a number, such as 3500.',
    });
    expect(toEmployeeInput({ ...employeeFormValues(null, null), name: 'A', base_salary: '-5' }, { includePrivate: true }).ok).toBe(false);
  });

  it('refuses an empty name', () => {
    expect(toEmployeeInput({ ...employeeFormValues(null, null), name: '  ' }, { includePrivate: true })).toEqual({
      ok: false,
      error: 'Give the employee a name.',
    });
  });
});

describe('linkableMembers', () => {
  const members = [
    { userId: 'u1', name: 'Ali', email: 'ali@example.com' },
    { userId: 'u2', name: 'Zara', email: 'zara@example.com' },
  ];
  it('offers members nobody is linked to, plus the one this employee already has', () => {
    const staff = [person({ id: 'a', user_id: 'u1' }), person({ id: 'b', user_id: null })];
    expect(linkableMembers(members, staff, staff[1]).map((m) => m.userId)).toEqual(['u2']);
    expect(linkableMembers(members, staff, staff[0]).map((m) => m.userId)).toEqual(['u1', 'u2']);
  });
});

describe('suggestedMember', () => {
  const members = [
    { userId: 'u1', name: 'Ali', email: 'ali@example.com' },
    { userId: 'u2', name: 'Zara', email: 'Zara@Example.com' },
  ];
  it('is the unlinked member who signs in with the work email, whatever its capitals', () => {
    const staff = [person({ id: 'a', user_id: null, work_email: ' zara@example.com ' })];
    expect(suggestedMember(members, staff, staff[0])?.userId).toBe('u2');
  });
  it('is nobody for a linked employee, one with no work email, or one whose email no member has', () => {
    const linked = person({ id: 'a', user_id: 'u1', work_email: 'zara@example.com' });
    const noEmail = person({ id: 'b', user_id: null, work_email: null });
    const stranger = person({ id: 'c', user_id: null, work_email: 'someone@example.com' });
    const staff = [linked, noEmail, stranger];
    for (const employee of staff) expect(suggestedMember(members, staff, employee)).toBeNull();
  });
  it('is nobody when that member is already linked to another employee', () => {
    const staff = [
      person({ id: 'a', user_id: 'u2', work_email: 'other@example.com' }),
      person({ id: 'b', user_id: null, work_email: 'zara@example.com' }),
    ];
    expect(suggestedMember(members, staff, staff[1])).toBeNull();
  });
});

describe('the entitlement fields', () => {
  const rows = [
    { leave_type: 'annual', year: 2026, entitled_days: 14, used_days: 2 },
    { leave_type: 'medical', year: 2026, entitled_days: 14.5, used_days: 0 },
    { leave_type: 'annual', year: 2025, entitled_days: 99, used_days: 0 },
  ];

  it("starts from this year's rows only, blank where there is none", () => {
    expect(entitlementValues(rows, 2026)).toEqual({ annual: '14', medical: '14.5', emergency: '' });
  });

  it("saves only what changed, for the form's year", () => {
    const start = entitlementValues(rows, 2026);
    expect(entitlementChanges(start, { ...start, annual: '18', emergency: '3' }, 2026)).toEqual({
      ok: true,
      changes: [
        { leave_type: 'annual', year: 2026, days: 18 },
        { leave_type: 'emergency', year: 2026, days: 3 },
      ],
    });
    expect(entitlementChanges(start, start, 2026)).toEqual({ ok: true, changes: [] });
  });

  it('never sends a blank, and accepts 0 and halves', () => {
    const start = entitlementValues(rows, 2026);
    expect(entitlementChanges(start, { ...start, annual: '' }, 2026)).toEqual({ ok: true, changes: [] });
    expect(entitlementChanges(start, { ...start, annual: '0', medical: '7.5' }, 2026)).toMatchObject({
      ok: true,
      changes: [
        { leave_type: 'annual', days: 0 },
        { leave_type: 'medical', days: 7.5 },
      ],
    });
  });

  it('refuses a negative, a quarter day, more than a year and text, naming the type', () => {
    const start = entitlementValues(rows, 2026);
    for (const bad of ['-1', '1.25', '366', 'abc']) {
      const result = entitlementChanges(start, { ...start, annual: bad }, 2026);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Annual');
    }
  });
});
