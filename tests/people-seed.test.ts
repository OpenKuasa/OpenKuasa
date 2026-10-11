import { describe, expect, it } from 'vitest';
import { addDays, monthStart, todayInMalaysia } from '@/lib/people/dates';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID } from '@/lib/people/types';

const NOW = new Date('2026-10-10T04:00:00Z');
const TODAY = todayInMalaysia(NOW);
const data = createSeedPeopleData(NOW);

describe('people seed', () => {
  it('has 20 active employees in 5 departments, mixed as the demo is', async () => {
    const employees = await data.listEmployees();
    expect(employees).toHaveLength(20);
    expect(employees.every((e) => e.status === 'active')).toBe(true);
    expect(await data.listDepartments()).toHaveLength(5);
    const count = (name: string) => employees.filter((e) => e.department_name === name).length;
    expect(['Sales', 'Operations', 'Marketing', 'Finance', 'Management'].map(count)).toEqual([6, 5, 3, 3, 3]);
    expect(new Set(employees.map((e) => e.id)).size).toBe(20);
    expect(new Set(employees.map((e) => e.employee_no)).size).toBe(20);
  });

  it('makes Aisyah Rahim the demo employee', async () => {
    const aisyah = (await data.listEmployees()).find((e) => e.id === DEMO_EMPLOYEE_ID);
    expect(aisyah).toMatchObject({ name: 'Aisyah Rahim', employee_no: 'EMP-001', department_name: 'Sales' });
  });

  it('always has three people on leave today', async () => {
    const onLeave = (await data.listLeaveRequests()).filter(
      (r) => r.status === 'approved' && r.start_date <= TODAY && r.end_date >= TODAY,
    );
    expect(onLeave.map((r) => r.employee_name).sort()).toEqual(['Lim Wei Jie', 'Nurul Huda', 'Siti Lestari']);
  });

  it('gives every claim and overtime record the new columns, with no file and no decision yet', async () => {
    for (const c of await data.listClaims()) {
      expect(c).toMatchObject({ decision_note: null, receipt_path: null, paid_on: null, paid_reference: null });
    }
    for (const o of await data.listOvertime()) {
      expect(o).toMatchObject({ decision_note: null, reason: null });
      expect(o.hourly_rate_cents).toBe(2500);
    }
  });

  it('always has six approvals waiting: 3 leave, 2 claims, 1 overtime, no time-off', async () => {
    const pending = <T extends { status: string }>(rows: T[]) => rows.filter((r) => r.status === 'pending').length;
    expect(pending(await data.listLeaveRequests())).toBe(3);
    expect(pending(await data.listClaims())).toBe(2);
    expect(pending(await data.listOvertime())).toBe(1);
    expect(pending(await data.listTimeOffRequests())).toBe(0);
  });

  it('has eight payroll runs, this month in draft, with a payslip per employee', async () => {
    const runs = await data.listPayrollRuns();
    expect(runs).toHaveLength(8);
    expect(runs.filter((r) => r.status === 'draft').map((r) => r.period_month)).toEqual([monthStart(TODAY)]);
    const payslips = await data.listPayslips();
    expect(payslips).toHaveLength(160);
    for (const slip of payslips) {
      expect(slip.net_cents).toBe(
        slip.gross_cents - slip.epf_cents - slip.socso_cents - slip.eis_cents - slip.pcb_cents - slip.other_deductions_cents,
      );
      expect(slip.net_cents).toBeGreaterThan(0);
    }
  });

  it('has attendance for every weekday of the last eight weeks, and only in the window asked for', async () => {
    const all = await data.listAttendance(addDays(TODAY, -55), TODAY);
    expect(all).toHaveLength(800);
    const oneDay = await data.listAttendance('2026-10-09', '2026-10-09');
    expect(oneDay).toHaveLength(20);
    expect(oneDay.every((d) => d.work_date === '2026-10-09')).toBe(true);
    expect(await data.listAttendance('2026-10-10', '2026-10-11')).toEqual([]); // a weekend
  });

  it('gives every attendance day the correction fields, none corrected', async () => {
    const all = await data.listAttendance(addDays(TODAY, -55), TODAY);
    expect(all.every((d) => d.corrected === false && d.correction_note === null)).toBe(true);
  });

  it('has settings with the work week, start time and grace period the attendance rules read', async () => {
    expect(await data.getSettings()).toMatchObject({
      work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
      work_start_time: '09:00',
      late_grace_minutes: 15,
    });
  });

  it('gives every public holiday an id, so the list can be edited', async () => {
    const holidays = await data.listPublicHolidays();
    expect(holidays.length).toBeGreaterThan(0);
    expect(new Set(holidays.map((h) => h.id)).size).toBe(holidays.length);
    expect(holidays.every((h) => h.id !== '')).toBe(true);
  });

  it('marks people on approved leave as on leave in attendance', async () => {
    const day = await data.listAttendance('2026-10-09', '2026-10-09');
    const lestari = (await data.listEmployees()).find((e) => e.name === 'Siti Lestari')!;
    expect(day.find((d) => d.employee_id === lestari.id)?.status).toBe('on_leave');
  });

  it('keeps private details off the directory and gives each employee a private row', async () => {
    const [first] = await data.listEmployees();
    expect(first).not.toHaveProperty('base_salary_cents');
    expect(first).not.toHaveProperty('nric');
    const priv = await data.getEmployeePrivate(DEMO_EMPLOYEE_ID);
    expect(priv?.base_salary_cents).toBe(560000);
    expect(await data.getEmployeePrivate('no-such-employee')).toBeNull();
  });

  it('fills every other list the lookups read', async () => {
    expect((await data.listLeaveBalances(2026)).length).toBe(60);
    expect(await data.listLeaveBalances(2025)).toEqual([]);
    expect(await data.listShifts('2026-10-05', '2026-10-11')).toHaveLength(35);
    expect(await data.listPublicHolidays()).toHaveLength(6);
    expect(await data.listGoals()).toHaveLength(40);
    expect(await data.listReviews()).toHaveLength(20);
    expect(await data.listTrainings()).toHaveLength(5);
    expect((await data.listTrainingEnrolments()).length).toBeGreaterThan(0);
    expect(await data.listAnnouncements()).toHaveLength(6);
    expect((await data.listTimesheet(addDays(TODAY, -55), TODAY)).length).toBeGreaterThan(600);
  });

  it('moves with the clock', async () => {
    const later = createSeedPeopleData(new Date('2027-01-05T04:00:00Z'));
    const onLeave = (await later.listLeaveRequests()).filter(
      (r) => r.status === 'approved' && r.start_date <= '2027-01-05' && r.end_date >= '2027-01-05',
    );
    expect(onLeave).toHaveLength(3);
    expect((await later.listPayrollRuns()).find((r) => r.status === 'draft')?.period_month).toBe('2027-01-01');
  });

  it('has the documents, letters, vouchers and settings the demo has', async () => {
    const documents = await data.listDocuments();
    expect(documents).toHaveLength(26);
    expect(documents.filter((d) => d.doc_type === 'contract' && d.status === 'signed')).toHaveLength(20);
    const mine = documents.filter((d) => d.employee_id === DEMO_EMPLOYEE_ID);
    expect(mine).toHaveLength(7);
    expect(mine.filter((d) => d.status === 'pending_signature')).toHaveLength(1);
    expect(mine.filter((d) => d.status === 'expiring')).toHaveLength(1);
    expect(mine.find((d) => d.status === 'expiring')?.expires_on).toBe(addDays(TODAY, 25));
    expect(documents.every((d) => d.employee_name !== '')).toBe(true);
    const issued = documents.map((d) => d.issued_on ?? '');
    expect(issued).toEqual([...issued].sort().reverse());

    const letters = await data.listLetters();
    expect(letters).toHaveLength(5);
    expect(letters.filter((l) => l.status === 'issued')).toHaveLength(3);
    expect(letters.filter((l) => l.status === 'draft').every((l) => l.issued_on === null)).toBe(true);
    const created = letters.map((l) => l.created_at);
    expect(created).toEqual([...created].sort().reverse());

    const vouchers = await data.listPaymentVouchers();
    expect(vouchers).toHaveLength(6);
    expect(vouchers.filter((v) => v.status === 'paid')).toHaveLength(4);
    expect(vouchers.reduce((total, v) => total + v.amount_cents, 0)).toBe(2746500);
    expect(vouchers[0].issued_date).toBe(TODAY);

    const settings = await data.getSettings();
    expect([settings.default_medical_leave_days, settings.default_emergency_leave_days]).toEqual([14, 3]);
    const requests = await data.listLeaveRequests();
    expect(requests.every((r) => r.half_day === false && r.decision_note === null)).toBe(true);
    expect((await data.listTimeOffRequests()).every((r) => r.decision_note === null)).toBe(true);
    expect((await data.getSettings()).notifications).toEqual({
      leave_requests: true, payslip_ready: true, document_expiry: true, birthdays: false,
    });
  });
});
