import { describe, expect, it } from 'vitest';
import {
  SAVE_ORDER,
  buildEmployeesModel,
  directoryExtras,
  employeeFormValues,
  employeesControls,
  filterEmployees,
  linkableMembers,
  reportsToChange,
  reportsToOptions,
  reportsToProblem,
  reportsToBaseline,
  reportsToRefusal,
  runSave,
  saveFailure,
  searchReportsTo,
  suggestedMember,
  toEmployeeInput,
} from '@/lib/people/employees';
import { showsOwnerDocumentControls } from '@/lib/people/documents-screens';
import { REPORTS_TO_REFUSALS, reportsToLoop } from '@/lib/people/reporting-refusals';
import type { StepResult } from '@/lib/people/employees';
import type { PeopleViewer } from '@/lib/people/types';
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

const emp = (id: string, name: string, reports_to: string | null, status: 'active' | 'inactive' = 'active'): Employee =>
  person({ id, name, reports_to, status, department_id: null });
const line = [
  emp('a', 'Aminah', null),
  emp('b', 'Bakar', 'a'),
  emp('c', 'Chong', 'b'),
  emp('d', 'Devi', 'a'),
  emp('z', 'Zul', null, 'inactive'),
  emp('y', 'Yati', 'z'),
];

describe('reportsToOptions', () => {
  const ids = (list: { id: string }[]) => list.map((o) => o.id);
  it('offers active employees but the person, by name', () => {
    expect(ids(reportsToOptions(line, 'b', 'a'))).toEqual(['a', 'c', 'd', 'y']);
  });
  it('keeps an inactive current manager, labelled', () => {
    const options = reportsToOptions(line, 'y', 'z');
    expect(ids(options)).toEqual(['a', 'b', 'c', 'd', 'z']);
    expect(options.find((o) => o.id === 'z')?.label).toBe('Zul (inactive)');
  });
  it('offers everyone active for a new employee', () => {
    expect(ids(reportsToOptions(line, null, null))).toEqual(['a', 'b', 'c', 'd', 'y']);
  });
  it('does not invent a manager that is not in the rows', () => {
    expect(ids(reportsToOptions(line, 'b', 'gone'))).toEqual(['a', 'c', 'd', 'y']);
  });
  it('is empty with no rows', () => {
    expect(reportsToOptions([], 'b', null)).toEqual([]);
  });
});

describe('searchReportsTo', () => {
  const options = reportsToOptions(line, null, null);
  it('gives all for a blank search', () => {
    expect(searchReportsTo(options, '', '')).toHaveLength(5);
    expect(searchReportsTo(options, '   ', '')).toHaveLength(5);
  });
  it('matches any capitals, ignoring outer spaces', () => {
    expect(searchReportsTo(options, 'am', '').map((o) => o.id)).toEqual(['a']);
    expect(searchReportsTo(options, 'AM', '').map((o) => o.id)).toEqual(['a']);
    expect(searchReportsTo(options, '  am ', '').map((o) => o.id)).toEqual(['a']);
  });
  it('gives nothing for no match, but never drops the chosen one', () => {
    expect(searchReportsTo(options, 'zzz', '')).toEqual([]);
    expect(searchReportsTo(options, 'zzz', 'a').map((o) => o.id)).toEqual(['a']);
  });
});

describe('reportsToChange', () => {
  it.each([
    [null, '', { changed: false, managerId: null }],
    ['a', 'a', { changed: false, managerId: 'a' }],
    [null, 'a', { changed: true, managerId: 'a' }],
    ['a', '', { changed: true, managerId: null }],
    ['a', 'd', { changed: true, managerId: 'd' }],
  ])('%s -> %s', (initial, chosen, expected) => {
    expect(reportsToChange(initial, chosen)).toEqual(expected);
  });
});

describe('reportsToProblem and reportsToRefusal', () => {
  it('names the loop for a chain of 1, 2 and 3', () => {
    expect(reportsToProblem('a', 'b', line)).toBe(reportsToLoop('Bakar'));
    expect(reportsToProblem('a', 'b', line)).toBe(
      'That would make a loop: Bakar already reports to this person, directly or through others.',
    );
    expect(reportsToProblem('a', 'c', line)).toBe(reportsToLoop('Chong'));
    expect(reportsToProblem('a', 'a', line)).toBe(reportsToLoop('Aminah'));
  });
  it('is null when the choice is fine', () => {
    expect(reportsToProblem('c', 'a', line)).toBeNull();
    expect(reportsToProblem('b', '', line)).toBeNull();
    expect(reportsToProblem(null, 'a', line)).toBeNull();
  });
  it('words the general bad-manager refusal so that it is true for every cause', () => {
    expect(REPORTS_TO_REFUSALS.EMP_BAD_MANAGER).toBe(
      "That person cannot be this employee's manager: it would make a loop, or they are no longer in this workspace.",
    );
  });
  it("names the loop only when the loaded rows show one", () => {
    expect(reportsToRefusal(REPORTS_TO_REFUSALS.EMP_BAD_MANAGER, 'a', 'b', line)).toBe(reportsToLoop('Bakar'));
  });
  it('keeps the general sentence when the loaded rows show no loop (a manager gone, a chain too deep)', () => {
    expect(reportsToRefusal(REPORTS_TO_REFUSALS.EMP_BAD_MANAGER, 'c', 'a', line)).toBe(REPORTS_TO_REFUSALS.EMP_BAD_MANAGER);
    expect(reportsToRefusal(REPORTS_TO_REFUSALS.EMP_BAD_MANAGER, 'a', 'gone', line)).toBe(REPORTS_TO_REFUSALS.EMP_BAD_MANAGER);
  });
  it('leaves any other text as it is', () => {
    expect(reportsToRefusal(REPORTS_TO_REFUSALS.EMP_NOT_ALLOWED, 'a', 'b', line)).toBe(REPORTS_TO_REFUSALS.EMP_NOT_ALLOWED);
    expect(reportsToRefusal('Something else.', 'a', 'b', line)).toBe('Something else.');
  });
});

describe('directoryExtras', () => {
  const extras = directoryExtras([...line, emp('q', 'Qadir', 'missing')]);
  it('says who each reports to and who is a manager', () => {
    expect(extras.get('a')).toEqual({ reportsTo: null, manages: true });
    expect(extras.get('b')).toEqual({ reportsTo: 'Aminah', manages: true });
    expect(extras.get('c')).toEqual({ reportsTo: 'Bakar', manages: false });
    expect(extras.get('y')).toEqual({ reportsTo: 'Zul (inactive)', manages: false });
    expect(extras.get('z')).toEqual({ reportsTo: null, manages: true });
    expect(extras.get('q')).toEqual({ reportsTo: null, manages: false });
  });
});

describe('filterEmployees, My team', () => {
  const base = { query: '', departmentId: 'all', status: 'all' as const, team: 'mine' as const };
  it('keeps the viewer\'s direct reports', () => {
    expect(filterEmployees(line, base, 'a').map((e) => e.id)).toEqual(['b', 'd']);
  });
  it('is empty with no viewer employee', () => {
    expect(filterEmployees(line, base, null)).toEqual([]);
    expect(filterEmployees(line, base)).toEqual([]);
  });
  it('combines with the other filters', () => {
    expect(filterEmployees(line, { ...base, query: 'dev' }, 'a').map((e) => e.id)).toEqual(['d']);
    const dept = [{ ...line[1], department_id: 'x' }, line[3]];
    expect(filterEmployees(dept, { ...base, departmentId: 'x' }, 'a').map((e) => e.id)).toEqual(['b']);
    const gone = [{ ...line[1], status: 'inactive' as const }, line[3]];
    expect(filterEmployees(gone, { ...base, status: 'active' }, 'a').map((e) => e.id)).toEqual(['d']);
  });
});

describe('employeesControls', () => {
  const v = (over: Partial<PeopleViewer>): PeopleViewer => ({ employeeId: 'e1', isHr: false, isDemo: false, ...over });
  const none = { canEdit: false, reportsToField: false, myTeamFilter: false };
  const cases: [string, PeopleViewer | null | undefined, { canEdit: boolean; reportsToField: boolean; myTeamFilter: boolean }][] = [
    ['owner', v({ isHr: true, isOwner: true }), { canEdit: true, reportsToField: true, myTeamFilter: false }],
    ['admin', v({ isHr: true }), { canEdit: true, reportsToField: true, myTeamFilter: false }],
    ['manager', v({ managesTeam: true }), { canEdit: false, reportsToField: false, myTeamFilter: true }],
    ['member', v({}), none],
    ['unlinked manager', v({ managesTeam: true, employeeId: null }), none],
    ['demo', v({ isDemo: true }), none],
    ['demo hr', v({ isDemo: true, isHr: true }), none],
    ['null', null, none],
    ['undefined', undefined, none],
  ];
  it.each(cases)('%s', (_name, viewer, expected) => {
    expect(employeesControls(viewer)).toEqual(expected);
    expect(employeesControls(viewer).canEdit).toBe(showsOwnerDocumentControls(viewer));
  });
});

describe('runSave', () => {
  const spies = (results: Partial<Record<'details' | 'reports_to' | 'entitlements', unknown>> = {}) => {
    const calls: string[] = [];
    const step = (name: 'details' | 'reports_to' | 'entitlements') => async (): Promise<StepResult> => {
      calls.push(name);
      const r = results[name];
      if (r instanceof Error) throw r;
      return (r as StepResult | undefined) ?? { ok: true };
    };
    return {
      calls,
      steps: { details: step('details'), reports_to: step('reports_to'), entitlements: step('entitlements') },
    };
  };

  it('runs the steps in SAVE_ORDER', async () => {
    const { calls, steps } = spies();
    const outcome = await runSave(true, steps);
    expect(calls).toEqual([...SAVE_ORDER]);
    expect(outcome).toEqual({ ok: true, done: [...SAVE_ORDER] });
  });
  it('calls nothing else when the details are refused, and says it as it was', async () => {
    const { calls, steps } = spies({ details: { ok: false, error: 'Name taken.' } });
    expect(await runSave(true, steps)).toEqual({ ok: false, step: 'details', error: 'Name taken.', done: [] });
    expect(calls).toEqual(['details']);
  });
  it('skips entitlements when the line is refused, with the saved-but sentence', async () => {
    const { calls, steps } = spies({ reports_to: { ok: false, error: 'No.' } });
    expect(await runSave(true, steps)).toEqual({
      ok: false,
      step: 'reports_to',
      error: saveFailure('reports_to', 'No.'),
      done: ['details'],
    });
    expect(calls).toEqual(['details', 'reports_to']);
  });
  it('never calls the line step when the line did not change', async () => {
    const { calls, steps } = spies();
    const outcome = await runSave(false, steps);
    expect(calls).toEqual(['details', 'entitlements']);
    expect(outcome).toEqual({ ok: true, done: ['details', 'entitlements'] });
  });
  it('reports a refused entitlement after the line was saved', async () => {
    const { steps } = spies({ entitlements: { ok: false, error: 'Too many.' } });
    expect(await runSave(true, steps)).toEqual({
      ok: false,
      step: 'entitlements',
      error: saveFailure('entitlements', 'Too many.'),
      done: ['details', 'reports_to'],
    });
  });
  it('turns a rejected line request into the saved-but sentence', async () => {
    const { calls, steps } = spies({ reports_to: new Error('network') });
    const outcome = await runSave(true, steps);
    expect(outcome).toMatchObject({ ok: false, step: 'reports_to', done: ['details'] });
    expect(outcome.ok === false && outcome.error).toBe(saveFailure('reports_to', 'Something went wrong. Try again.'));
    expect(calls).toEqual(['details', 'reports_to']);
  });
  it('lets a rejected details request through, since nothing was saved', async () => {
    const { steps } = spies({ details: new Error('network') });
    await expect(runSave(true, steps)).rejects.toThrow('network');
  });
});

describe('the line baseline after a partial save', () => {
  it('moves to the saved manager when the line went through and a later step failed', () => {
    const outcome = { ok: false as const, step: 'entitlements' as const, error: 'x', done: ['details', 'reports_to'] as ('details' | 'reports_to' | 'entitlements')[] };
    const baseline = reportsToBaseline('a', outcome, 'd');
    expect(baseline).toBe('d');
    // Changing the control back to Aminah is now a change, and is sent.
    expect(reportsToChange(baseline, 'a')).toEqual({ changed: true, managerId: 'a' });
  });
  it('stays when the line was not saved', () => {
    expect(reportsToBaseline('a', { ok: false, step: 'reports_to', error: 'x', done: ['details'] }, 'd')).toBe('a');
  });
});

describe('the order of an edit', () => {
  it('saves details, then the line, then entitlements', () => {
    expect(SAVE_ORDER).toEqual(['details', 'reports_to', 'entitlements']);
  });
  it('words a later refusal', () => {
    expect(saveFailure('reports_to', 'x')).toBe('The employee was saved, but "Reports to" was not: x');
    expect(saveFailure('entitlements', 'x')).toBe('The employee was saved, but an entitlement was not: x');
  });
});

describe('filterEmployees', () => {
  const all = { query: '', departmentId: 'all', status: 'all' as const, team: 'all' as const };
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

  it('never carries the reporting line in the table update', () => {
    const values = employeeFormValues(employees[0], null);
    const result = toEmployeeInput(values, { includePrivate: false });
    expect(result.ok).toBe(true);
    for (const key of ['reports_to', 'manager_id', 'is_manager']) {
      expect(values).not.toHaveProperty(key);
      expect(result.ok && key in result.input).toBe(false);
    }
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
