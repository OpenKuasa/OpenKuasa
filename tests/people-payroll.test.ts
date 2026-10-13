import { describe, expect, it, vi } from 'vitest';
import { payrollModel, readPayroll, readVouchers, vouchersModel } from '@/lib/people/payroll';
import { createSeedPeopleData } from '@/lib/people/seed';
import { buildDashboardModel } from '@/lib/people/company';
import { ownPayslipsModel } from '@/lib/people/payroll';
import { asMember } from './setup/people-member-view';
import type { PaymentVoucher, PayrollRun, PeopleViewer, Payslip } from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = '2026-10-09';
const data = createSeedPeopleData(NOW);

const HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: false };

describe('payrollModel on the sample data', () => {
  it('reports the latest run: draft, 20 payslips, RM 107,387.50 gross (salaries, October overtime and two bonuses)', async () => {
    const model = payrollModel(await data.listPayrollRuns(), await data.listPayslips());
    const latest = model.latest!;
    expect(latest.period_month).toBe('2026-10-01');
    expect(latest.label).toBe('October 2026');
    expect(latest.status).toBe('draft');
    expect(latest.headcount).toBe(20);
    expect(latest.gross_cents).toBe(10_738_750);
    expect(latest.slips).toHaveLength(20);
    expect(latest.gross_cents - latest.deductions_cents).toBe(latest.net_cents);
    expect(latest.epf_cents + latest.socso_cents + latest.eis_cents + latest.pcb_cents + latest.other_cents).toBe(
      latest.deductions_cents,
    );
    expect(latest.other_cents).toBe(30_000);
  });

  it('has gross by month, oldest first, for the runs that exist', async () => {
    const model = payrollModel(await data.listPayrollRuns(), await data.listPayslips());
    expect(model.by_month).toHaveLength(8);
    expect(model.by_month.at(-1)!.start).toBe('2026-10-01');
    expect(model.by_month.at(-1)!.value).toBe(107_387.5);
    const starts = model.by_month.map((b) => b.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it('splits the latest run deductions into four statutory parts and Other, that add up', async () => {
    const model = payrollModel(await data.listPayrollRuns(), await data.listPayslips());
    expect(model.deductions.map((d) => d.label)).toEqual(['EPF', 'PCB', 'SOCSO', 'EIS', 'Other']);
    expect(model.deductions.reduce((t, d) => t + d.value, 0)).toBe(model.latest!.deductions_cents);
  });
});

const slipFor = (id: string, run: string, name: string): Payslip => ({
  id, employee_id: id, employee_name: name, payroll_run_id: run, period_month: '2026-10-01',
  basic_cents: 1000, gross_cents: 1000, epf_cents: 110, socso_cents: 5, eis_cents: 2, pcb_cents: 0,
  other_deductions_cents: 0, net_cents: 883, set_by_hr: [], lines: [], status: 'pending',
});

describe('payrollModel edge cases', () => {
  it('says there is no run rather than showing zeros', () => {
    const model = payrollModel([], []);
    expect(model.latest).toBeNull();
    expect(model.by_month).toEqual([]);
    expect(model.deductions).toEqual([]);
  });

  it('opens on the newest run even when it has no payslips', () => {
    const runs: PayrollRun[] = [
      { id: 'a', period_month: '2026-09-01', status: 'paid', paid_at: null, paid_by_name: null },
      { id: 'b', period_month: '2026-10-01', status: 'draft', paid_at: null, paid_by_name: null },
    ];
    const model = payrollModel(runs, [slipFor('1', 'a', 'Amy')]);
    expect(model.latest).toMatchObject({ run_id: 'b', status: 'draft', headcount: 0, slips: [], gross_cents: 0 });
    // The chart still shows only months that have payslips.
    expect(model.by_month.map((b) => b.start)).toEqual(['2026-09-01']);
  });

  it("opens on a workspace's only run when it is an empty draft", () => {
    const run: PayrollRun = { id: 'r', period_month: '2026-10-01', status: 'draft', paid_at: null, paid_by_name: null };
    const model = payrollModel([run], []);
    expect(model.latest).toMatchObject({ run_id: 'r', status: 'draft', headcount: 0 });
    expect(model.by_month).toEqual([]);
  });

  it('opens on an empty paid latest run, not the month before', () => {
    const runs: PayrollRun[] = [
      { id: 'a', period_month: '2026-09-01', status: 'paid', paid_at: null, paid_by_name: null },
      { id: 'b', period_month: '2026-10-01', status: 'paid', paid_at: '2026-10-28T02:00:00Z', paid_by_name: null },
    ];
    expect(payrollModel(runs, [slipFor('1', 'a', 'Amy')]).latest).toMatchObject({ run_id: 'b', status: 'paid', headcount: 0 });
  });

  it('opens on an empty draft after a paid month, so Undo paid is not offered on the earlier one', () => {
    const runs: PayrollRun[] = [
      { id: 'mar', period_month: '2026-03-01', status: 'paid', paid_at: '2026-03-28T02:00:00Z', paid_by_name: null },
      { id: 'apr', period_month: '2026-04-01', status: 'draft', paid_at: null, paid_by_name: null },
    ];
    const model = payrollModel(runs, [slipFor('1', 'mar', 'Amy')]);
    expect(model.latest!.run_id).toBe('apr');
  });

  it('agrees with the Dashboard on the latest run gross', () => {
    const runs: PayrollRun[] = [
      { id: 'a', period_month: '2026-09-01', status: 'paid', paid_at: null, paid_by_name: null },
      { id: 'b', period_month: '2026-10-01', status: 'draft', paid_at: null, paid_by_name: null },
    ];
    const payslips = [slipFor('1', 'a', 'Amy'), slipFor('2', 'a', 'Zed')];
    const dash = buildDashboardModel({ employees: [], leave: [], attendance: [], runs, payslips }, TODAY, true);
    const payroll = payrollModel(runs, payslips);
    expect(dash.payroll!.latest!.gross_cents).toBe(payroll.latest!.gross_cents);
    expect(dash.payroll!.latest!.period_month).toBe(payroll.latest!.period_month);
  });

  it('only lists the latest run payslips, by name', () => {
    const runs: PayrollRun[] = [
      { id: 'a', period_month: '2026-09-01', status: 'paid', paid_at: null, paid_by_name: null },
      { id: 'b', period_month: '2026-10-01', status: 'draft', paid_at: null, paid_by_name: null },
    ];
    const slip = (id: string, run: string, name: string): Payslip => ({
      id, employee_id: id, employee_name: name, payroll_run_id: run, period_month: '2026-10-01',
      basic_cents: 1000, gross_cents: 1000, epf_cents: 110, socso_cents: 5, eis_cents: 2, pcb_cents: 0,
      other_deductions_cents: 0, net_cents: 883, set_by_hr: [], lines: [], status: 'pending',
    });
    const model = payrollModel(runs, [slip('1', 'a', 'Old'), slip('2', 'b', 'Zed'), slip('3', 'b', 'Amy')]);
    expect(model.latest!.slips.map((s) => s.employee_name)).toEqual(['Amy', 'Zed']);
  });
});

describe('payrollModel with a chosen run', () => {
  const runs: PayrollRun[] = [
    { id: 'a', period_month: '2026-08-01', status: 'paid', paid_at: '2026-08-28T02:00:00Z', paid_by_name: null },
    { id: 'b', period_month: '2026-09-01', status: 'paid', paid_at: '2026-09-28T02:00:00Z', paid_by_name: null },
    { id: 'c', period_month: '2026-10-01', status: 'draft', paid_at: null, paid_by_name: null },
    { id: 'd', period_month: '2026-11-01', status: 'draft', paid_at: null, paid_by_name: null },
  ];
  const slips = [slipFor('1', 'a', 'Amy'), slipFor('2', 'b', 'Bob'), slipFor('3', 'c', 'Cat'), slipFor('4', 'c', 'Dan')];

  it('shows the run asked for, and lists every run for the picker, newest first, empty ones too', () => {
    const model = payrollModel(runs, slips, 'b');
    expect(model.latest!.run_id).toBe('b');
    expect(model.latest!.paid_at).toBe('2026-09-28T02:00:00Z');
    expect(model.latest!.slips.map((s) => s.employee_name)).toEqual(['Bob']);
    expect(model.runs.map((r) => [r.id, r.headcount, r.label])).toEqual([
      ['d', 0, 'November 2026'],
      ['c', 2, 'October 2026'],
      ['b', 1, 'September 2026'],
      ['a', 1, 'August 2026'],
    ]);
  });

  it('can show a draft whose payslips were all removed, so it can be deleted', () => {
    const model = payrollModel(runs, slips, 'd');
    expect(model.latest).toMatchObject({ run_id: 'd', status: 'draft', headcount: 0, slips: [], gross_cents: 0 });
  });

  it('defaults to the newest run whatever its payslip count, and ignores an id that names no run', () => {
    expect(payrollModel(runs, slips).latest!.run_id).toBe('d');
    expect(payrollModel(runs, slips, 'nope').latest!.run_id).toBe('d');
    expect(payrollModel(runs, slips, null).latest!.run_id).toBe('d');
    expect(payrollModel(runs, slips, 'c').latest!.run_id).toBe('c');
  });

  it('still charts every run with payslips, whichever is chosen', () => {
    expect(payrollModel(runs, slips, 'a').by_month.map((b) => b.start)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
  });

  it('carries each payslip with its lines, its marks and its deductions, and adds up Other', () => {
    const withLines: Payslip = {
      ...slipFor('9', 'c', 'Eve'),
      gross_cents: 1500,
      other_deductions_cents: 300,
      net_cents: 1500 - 110 - 5 - 2 - 300,
      set_by_hr: ['pcb'],
      lines: [{ id: 'l1', payslip_id: '9', kind: 'deduction', source: 'hr', label: 'Advance', amount_cents: 300 }],
    };
    const model = payrollModel(runs, [slipFor('3', 'c', 'Cat'), withLines], 'c');
    const row = model.latest!.slips.find((s) => s.id === '9')!;
    expect(row.lines).toHaveLength(1);
    expect(row.set_by_hr).toEqual(['pcb']);
    expect(row.deductions_cents).toBe(1500 - row.net_cents);
    expect(model.latest!.other_cents).toBe(300);
    expect(model.deductions.at(-1)).toEqual({ key: 'other', label: 'Other', value: 300 });
  });

  it('reads the run asked for through readPayroll too', async () => {
    const d = createSeedPeopleData(NOW);
    const all = await d.listPayrollRuns();
    const older = all.find((r) => r.period_month === '2026-09-01')!;
    expect((await readPayroll(d, HR, older.id))!.latest!.run_id).toBe(older.id);
  });
});

describe('ownPayslipsModel', () => {
  const mk = (id: string, employee: string, month: string, status: Payslip['status']): Payslip => ({
    ...slipFor(id, 'r', 'X'),
    employee_id: employee,
    period_month: month,
    status,
  });

  it('keeps only the viewer paid payslips, newest first', () => {
    const rows = ownPayslipsModel(
      [
        mk('1', 'me', '2026-08-01', 'paid'),
        mk('2', 'me', '2026-10-01', 'pending'),
        mk('3', 'me', '2026-09-01', 'paid'),
        mk('4', 'them', '2026-09-01', 'paid'),
      ],
      'me',
    );
    expect(rows.map((r) => r.id)).toEqual(['3', '1']);
    expect(rows[0].label).toBe('September 2026');
    expect(rows[0].deductions_cents).toBe(rows[0].gross_cents - rows[0].net_cents);
  });

  it('shows nothing for an account that is not linked to an employee', () => {
    expect(ownPayslipsModel([mk('1', 'me', '2026-08-01', 'paid')], null)).toEqual([]);
  });

  it('shows a member exactly their paid sample payslips, even if the provider sends a draft', async () => {
    const mine = 'seed-emp-2';
    const member = asMember(data, mine);
    const fromProvider = await member.listPayslips();
    expect(fromProvider.every((p) => p.status === 'paid')).toBe(true);
    const sneaky = [...fromProvider, ...(await data.listPayslips()).filter((p) => p.status === 'pending')];
    const rows = ownPayslipsModel(sneaky, mine);
    expect(rows.length).toBe(7);
    expect(rows.every((r) => r.status === 'paid' && r.employee_id === mine)).toBe(true);
  });
});

describe('the sample payslips', () => {
  it('carry lines that add up to what the payslip says', async () => {
    for (const p of await data.listPayslips()) {
      const sum = (kind: string) => p.lines.filter((l) => l.kind === kind).reduce((t, l) => t + l.amount_cents, 0);
      expect(p.gross_cents, p.id).toBe(Math.max(0, p.basic_cents + sum('earning') - sum('unpaid')));
      expect(p.other_deductions_cents, p.id).toBe(sum('deduction'));
      expect(p.net_cents, p.id).toBe(
        p.gross_cents - p.epf_cents - p.socso_cents - p.eis_cents - p.pcb_cents - p.other_deductions_cents,
      );
      expect(p.set_by_hr).toEqual([]);
      expect(p.lines.every((l) => l.payslip_id === p.id)).toBe(true);
    }
  });

  it('put the system lines before the owner own', async () => {
    const order = { joiner: 0, unpaid_leave: 1, overtime: 2, hr: 3 };
    for (const p of await data.listPayslips()) {
      const ranks = p.lines.map((l) => order[l.source]);
      expect([...ranks].sort((a, b) => a - b), p.id).toEqual(ranks);
    }
  });

  it('give the one employee who joined mid-month a joiner line, and the ten approved overtime records their lines', async () => {
    const slips = await data.listPayslips();
    const joiner = slips.flatMap((p) => p.lines).filter((l) => l.source === 'joiner');
    expect(joiner).toHaveLength(1);
    expect(joiner[0].label).toMatch(/^Joined \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    const overtime = slips.flatMap((p) => p.lines).filter((l) => l.source === 'overtime');
    expect(overtime).toHaveLength(10);
    expect(slips.flatMap((p) => p.lines).filter((l) => l.source === 'hr')).toHaveLength(6);
  });

  it('mark an overtime record paid only when its payslip is in a paid run', async () => {
    const records = await data.listOvertime();
    const paid = records.filter((r) => r.paid_month !== null);
    expect(paid.length).toBeGreaterThan(0);
    for (const r of paid) expect(r.paid_month).toBe(r.work_date.slice(0, 7));
    // The overtime of the current month sits on a draft payslip, so it is not paid.
    expect(records.filter((r) => r.work_date.startsWith('2026-10')).every((r) => r.paid_month === null)).toBe(true);
    expect(records.filter((r) => r.status !== 'approved').every((r) => r.paid_month === null)).toBe(true);
  });
});

describe('vouchersModel on the sample data', () => {
  it('counts the six vouchers: 4 paid, 1 issued, 1 draft, RM 27,465.00', async () => {
    const model = vouchersModel(await data.listPaymentVouchers(), TODAY);
    expect(model.count).toBe(6);
    expect(model.total_cents).toBe(2_746_500);
    expect(model.paid_count).toBe(4);
    expect(model.draft_count).toBe(1);
    expect(model.outstanding_count).toBe(1);
    expect(model.outstanding_cents).toBe(150_000);
  });

  it('totals issued and paid this month by issued date', async () => {
    const model = vouchersModel(await data.listPaymentVouchers(), TODAY);
    // October so far: the advance (issued) on the 6th and the draft on the 9th; the paid ones are in September.
    expect(model.month.issued_cents).toBe(150_000);
    expect(model.month.paid_cents).toBe(0);
  });

  it('has amount by month and by type, and the table newest first', async () => {
    const model = vouchersModel(await data.listPaymentVouchers(), TODAY);
    expect(model.by_month).toHaveLength(6);
    expect(model.by_month.reduce((t, b) => t + b.value, 0)).toBe(27_465);
    expect(model.by_type.map((t) => t.key)).toEqual([
      'Statutory payment', 'Claim reimbursement', 'Advance', 'Overtime payout',
    ]);
    const dates = model.rows.map((r) => r.issued_date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('is calm with no vouchers', () => {
    const model = vouchersModel([], TODAY);
    expect(model.count).toBe(0);
    expect(model.total_cents).toBe(0);
    expect(model.by_type).toEqual([]);
    expect(model.rows).toEqual([]);
  });

  it('puts a draft in neither issued nor paid', () => {
    const v: PaymentVoucher = {
      id: 'v', voucher_no: 'PV-1', payee: 'P', voucher_type: 'Advance', amount_cents: 500,
      issued_date: '2026-10-02', status: 'draft',
    };
    const model = vouchersModel([v], TODAY);
    expect(model.month.issued_cents).toBe(0);
    expect(model.outstanding_count).toBe(0);
  });
});

describe('reading is for HR only', () => {
  const spied = () => {
    const d = createSeedPeopleData(NOW);
    const spies = {
      listPayrollRuns: vi.spyOn(d, 'listPayrollRuns'),
      listPayslips: vi.spyOn(d, 'listPayslips'),
      listPaymentVouchers: vi.spyOn(d, 'listPaymentVouchers'),
    };
    return { d, spies };
  };

  it('a plain member reads nothing', async () => {
    const { d, spies } = spied();
    expect(await readPayroll(d, MEMBER)).toBeNull();
    expect(await readVouchers(d, MEMBER, TODAY)).toBeNull();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it('HR reads both', async () => {
    const { d } = spied();
    expect((await readPayroll(d, HR))!.latest!.headcount).toBe(20);
    expect((await readVouchers(d, HR, TODAY))!.count).toBe(6);
  });

  it('a demo visitor reads too', async () => {
    const demo: PeopleViewer = { employeeId: 'e1', isHr: false, isDemo: true };
    expect((await readVouchers(data, demo, TODAY))!.count).toBe(6);
  });
});
