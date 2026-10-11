/**
 * Pure builders for the payroll screens (Payroll, My Payslips, Payment Vouchers).
 * Payroll and Payment Vouchers are for owners and admins: `readPayroll` /
 * `readVouchers` return null without reading anything for anyone else.
 *
 * Nothing here works out a payslip. Gross, the four statutory figures, the
 * deductions total and net are whatever the row carries; the models only add
 * rows up and order them.
 */

import { formatDate, malaysiaDate, monthLabel, monthYearLabel } from './dates';
import { isTeamView } from './own';
import { nextRunMonth } from './payroll-forms';
import { bucketByMonth, sumBy } from './series';
import type { Bucket } from './series';
import { payrollSummary } from './summaries';
import type {
  Employee,
  PaymentVoucher,
  PayrollRun,
  PeopleData,
  PeopleViewer,
  Payslip,
  PayslipLine,
  StatutoryField,
} from './types';

/** How many runs the cost chart shows. */
const RUN_MONTHS = 12;

export type PayslipRow = Payslip & { deductions_cents: number };

/** One run for the month picker. */
export type PayrollRunOption = {
  id: string;
  period_month: string;
  /** `October 2026`. */
  label: string;
  status: PayrollRun['status'];
  /** Payslips in the run; a draft whose payslips were all removed has none. */
  headcount: number;
};

export type PayrollModel = {
  /** Every run on record, newest first, for the picker. Includes a run with no payslips, so it can still be deleted. */
  runs: PayrollRunOption[];
  /**
   * The chosen run: the one asked for, else the NEWEST run, whatever its payslip count (an empty draft or an
   * empty paid month is a real record and must be what the screen opens on). Null only when the workspace has no
   * run. The name is historical: it is not always the newest.
   */
  latest: {
    run_id: string;
    period_month: string;
    /** `October 2026`. */
    label: string;
    status: PayrollRun['status'];
    paid_at: string | null;
    /** Null when unknown. */
    paid_by_name: string | null;
    /** Payslips in the run. */
    headcount: number;
    paid_count: number;
    gross_cents: number;
    net_cents: number;
    /** Everything between gross and net: the four statutory figures and the deduction lines. */
    deductions_cents: number;
    epf_cents: number;
    socso_cents: number;
    eis_cents: number;
    pcb_cents: number;
    /** The deduction lines, summed ("Other"). */
    other_cents: number;
    slips: PayslipRow[];
  } | null;
  /** Gross in ringgit per run, oldest first. */
  by_month: Bucket[];
  /** The chosen run's deductions in cents, as recorded on the payslips; "Other" last. Empty when there is none. */
  deductions: { key: string; label: string; value: number }[];
};

type DeductionField = 'epf_cents' | 'socso_cents' | 'eis_cents' | 'pcb_cents' | 'other_deductions_cents';

const sum = (rows: Payslip[], field: DeductionField) => rows.reduce((total, row) => total + row[field], 0);

/** Everything between a payslip's gross and net, as the row records them. The one place it is derived. */
export const deductionsOf = (p: Payslip): number => p.gross_cents - p.net_cents;

const rowOf = (p: Payslip): PayslipRow => ({ ...p, deductions_cents: deductionsOf(p) });

/**
 * `runId` picks a run; an id that names no run falls back to the newest run, empty or not. Only the chart
 * (`by_month`) is about payslips: it leaves out a run that has none.
 */
export function payrollModel(runs: PayrollRun[], payslips: Payslip[], runId?: string | null): PayrollModel {
  // Newest first. A run with no payslips has nothing to chart, so the chart leaves it out (the Dashboard's chart does the same).
  const totals = payrollSummary(runs, payslips).filter((t) => t.headcount > 0);
  const options: PayrollRunOption[] = [...runs]
    .sort((a, b) => b.period_month.localeCompare(a.period_month))
    .map((r) => ({
      id: r.id,
      period_month: r.period_month,
      label: monthYearLabel(r.period_month),
      status: r.status,
      headcount: payslips.filter((p) => p.payroll_run_id === r.id).length,
    }));
  const asked = runId ? runs.find((r) => r.id === runId) : undefined;
  const newest = [...runs].sort((a, b) => b.period_month.localeCompare(a.period_month))[0];
  const chosen = asked ?? newest;
  if (!chosen) return { runs: options, latest: null, by_month: [], deductions: [] };

  const slips = payslips
    .filter((p) => p.payroll_run_id === chosen.id)
    .map(rowOf)
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  const gross = slips.reduce((total, row) => total + row.gross_cents, 0);
  const net = slips.reduce((total, row) => total + row.net_cents, 0);
  const epf = sum(slips, 'epf_cents');
  const socso = sum(slips, 'socso_cents');
  const eis = sum(slips, 'eis_cents');
  const pcb = sum(slips, 'pcb_cents');
  const other = sum(slips, 'other_deductions_cents');
  return {
    runs: options,
    latest: {
      run_id: chosen.id,
      period_month: chosen.period_month,
      label: monthYearLabel(chosen.period_month),
      status: chosen.status,
      paid_at: chosen.paid_at,
      paid_by_name: chosen.paid_by_name,
      headcount: slips.length,
      paid_count: slips.filter((s) => s.status === 'paid').length,
      gross_cents: gross,
      net_cents: net,
      deductions_cents: gross - net,
      epf_cents: epf,
      socso_cents: socso,
      eis_cents: eis,
      pcb_cents: pcb,
      other_cents: other,
      slips,
    },
    by_month: totals
      .slice(0, RUN_MONTHS)
      .reverse()
      .map((t) => ({
        start: t.period_month,
        label: monthLabel(t.period_month),
        value: t.gross_cents / 100,
      })),
    deductions: [
      { key: 'epf', label: 'EPF', value: epf },
      { key: 'pcb', label: 'PCB', value: pcb },
      { key: 'socso', label: 'SOCSO', value: socso },
      { key: 'eis', label: 'EIS', value: eis },
      { key: 'other', label: 'Other', value: other },
    ],
  };
}

export type OwnPayslip = PayslipRow & {
  /** `October 2026`. */
  label: string;
};

/**
 * My Payslips: the viewer's own paid payslips, newest first. It filters to paid and to the viewer's employee
 * itself, so a wrong row from the provider is never shown. A draft is not something an employee sees.
 */
export function ownPayslipsModel(payslips: Payslip[], employeeId: string | null): OwnPayslip[] {
  if (!employeeId) return [];
  return payslips
    .filter((p) => p.status === 'paid' && p.employee_id === employeeId)
    .sort((a, b) => b.period_month.localeCompare(a.period_month))
    .map((p) => ({ ...rowOf(p), label: monthYearLabel(p.period_month) }));
}

/** Reads and builds the payroll model; null (and no read) unless the viewer is HR or in the demo. */
export async function readPayroll(
  data: PeopleData,
  viewer: PeopleViewer,
  runId?: string | null,
): Promise<PayrollModel | null> {
  if (!isTeamView(viewer)) return null;
  const [runs, payslips] = await Promise.all([data.listPayrollRuns(), data.listPayslips()]);
  return payrollModel(runs, payslips, runId);
}

// ---- The Payroll screen and the payslip detail: what each control offers and says ----------------

/** Shown on a draft run. */
export const DRAFT_BANNER = "Draft: employees can't see this yet";
/** Shown in place of the Run payroll dialog when no month is left to run. */
export const NO_MONTH_TO_RUN = 'Every month up to now already has a payroll run.';
/** Under "Proposed deductions" wherever the four figures are listed. */
export const PROPOSED_NOTE = 'Proposed figures. Check them before marking the run as paid.';

export type RunControls = {
  runPayroll: boolean;
  recalculate: boolean;
  markPaid: boolean;
  deleteDraft: boolean;
  undoPaid: boolean;
};

/**
 * Which controls the Payroll screen offers for the chosen run. In the demo, none. A paid run offers Undo paid
 * only; a draft offers Recalculate, Mark as paid and Delete. An empty draft can be paid: a month with nobody to
 * pay is a real record.
 */
export function runControls(
  run: { status: PayrollRun['status']; headcount: number } | null,
  viewer: { isDemo: boolean },
): RunControls {
  if (viewer.isDemo) {
    return { runPayroll: false, recalculate: false, markPaid: false, deleteDraft: false, undoPaid: false };
  }
  const draft = run !== null && run.status === 'draft';
  return {
    runPayroll: true,
    recalculate: draft,
    markPaid: draft,
    deleteDraft: draft,
    undoPaid: run !== null && run.status === 'paid',
  };
}

const payslipCount = (n: number) => `${n} ${n === 1 ? 'payslip' : 'payslips'}`;

/** `monthText` is `October 2026`. */
export const runPayrollSentence = (monthText: string) =>
  `Creates a draft for ${monthText}. Nobody is paid and employees can't see it yet.`;

/** `monthText` is `October 2026`; it is used only for a run with no payslips. */
export const markPaidSentence = (count: number, monthText: string) =>
  count === 0
    ? `Marks ${monthText} as paid with no payslips. The next month can then be run.`
    : `Marks ${payslipCount(count)} as paid. ${count === 1 ? 'The employee will see it.' : 'Employees will see them.'}`;

export const undoPaidSentence = (count: number, monthText: string) =>
  count === 0
    ? `Puts ${monthText} back to draft.`
    : `Puts ${payslipCount(count)} back to draft. ${
        count === 1 ? 'The employee will no longer see it.' : 'Employees will no longer see them.'
      }`;

/** A run's line in the month picker: "October 2026 · Draft · no payslips". */
export function runOptionLabel(run: { label: string; status: PayrollRun['status']; headcount: number }): string {
  return `${run.label} · ${run.status === 'draft' ? 'Draft' : 'Paid'}${run.headcount === 0 ? ' · no payslips' : ''}`;
}

/** The Run payroll dialog's success text. */
export function runCreatedSentence(monthText: string, payslips: number): string {
  return payslips === 0
    ? `Draft created for ${monthText} with no payslips: nobody active has a base salary recorded. Mark it as paid to record that nothing was paid, or add salaries and recalculate.`
    : `Draft created for ${monthText} with ${payslipCount(payslips)}. Check it, then mark it as paid.`;
}

/** The note after Recalculate; `added` is how many payslips are new. */
export function recalculateNote(added: number | undefined): string {
  return added ? `Recalculated. ${payslipCount(added)} added.` : 'Recalculated. No new payslips.';
}

/** What a run with nobody on it means; null when it has payslips. */
export function emptyRunNote(run: { status: PayrollRun['status']; headcount: number; label: string }): string | null {
  if (run.headcount > 0) return null;
  return run.status === 'draft'
    ? 'Nobody is on this run. Mark it as paid to record that nothing was paid this month, or delete it.'
    : `Nothing was paid for ${run.label}.`;
}

/** The "Headcount paid" card's note. A draft has paid nobody yet, so it says who is on it. */
export function headcountNote(run: { status: PayrollRun['status']; headcount: number; paid_count: number }): string {
  return run.status === 'draft' ? 'On this run' : `${run.paid_count} of ${run.headcount} payslips paid`;
}

/**
 * While the newest run is still a draft the database accepts no next month; says what to do first, else null.
 * `runs` carry `period_month` as `YYYY-MM-DD`.
 */
export function draftBlocksRun(runs: Pick<PayrollRun, 'period_month' | 'status'>[]): string | null {
  const latest = runs.reduce<Pick<PayrollRun, 'period_month' | 'status'> | null>(
    (best, r) => (best === null || r.period_month > best.period_month ? r : best),
    null,
  );
  return latest?.status === 'draft'
    ? `Mark ${monthYearLabel(latest.period_month)} as paid or delete it before running the next month.`
    : null;
}

/**
 * How many overtime lines on these payslips are for work done before `month` (`YYYY-MM` or `YYYY-MM-DD`): late
 * overtime the run swept in. Derived from the lines, so it follows the payslips as they change. A line with no
 * date (not overtime, or a record the caller cannot read) is not counted.
 */
export function earlierOvertimeCount(payslips: Payslip[], month: string): number {
  const first = `${month.slice(0, 7)}-01`;
  let count = 0;
  for (const slip of payslips) {
    for (const line of slip.lines) {
      if (line.source === 'overtime' && line.work_date && line.work_date < first) count += 1;
    }
  }
  return count;
}

/**
 * Active employees with no payslip on this run, by name. Someone who joins after the month is not expected on it.
 * (Why they are missing, such as no base salary, is not known here: salaries are read one employee at a time.)
 */
export function notOnRun(
  employees: Pick<Employee, 'id' | 'name' | 'status' | 'join_date'>[],
  payslips: Pick<Payslip, 'employee_id' | 'payroll_run_id'>[],
  runId: string,
  month: string,
): string[] {
  const on = new Set(payslips.filter((p) => p.payroll_run_id === runId).map((p) => p.employee_id));
  const last = month.slice(0, 7);
  return employees
    .filter((e) => e.status === 'active' && !on.has(e.id) && (e.join_date === null || e.join_date.slice(0, 7) <= last))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function notOnRunLine(names: string[]): string | null {
  if (names.length === 0) return null;
  return `${names.length} active ${names.length === 1 ? 'employee is' : 'employees are'} not on this run: ${names.join(', ')}.`;
}

export const deleteDraftSentence = (monthText: string, count: number) =>
  count === 0
    ? `Deletes the empty ${monthText} draft.`
    : `Deletes the ${monthText} draft and its ${payslipCount(count)}, with any lines and figures set by hand.`;

export const removePayslipSentence = (employeeName: string, monthText: string) =>
  `Removes ${employeeName}'s payslip from the ${monthText} draft. Recalculate would bring it back.`;

/** "Marked as paid on 09 Oct 2026", with " by <name>" only when the name is known; empty with no date. */
export function paidLine(run: { paid_at: string | null; paid_by_name: string | null }): string {
  const day = run.paid_at ? malaysiaDate(run.paid_at) : '';
  if (!day) return '';
  return `Marked as paid on ${formatDate(day)}${run.paid_by_name ? ` by ${run.paid_by_name}` : ''}`;
}

/** The people a run left out, each with why. */
export function skippedRows(
  skipped: { employee_id: string; name: string; reason: 'no_salary' }[],
): { id: string; name: string; reason: string }[] {
  return skipped.map((s) => ({ id: s.employee_id, name: s.name, reason: 'No base salary recorded' }));
}

/** `?run=` as a single trimmed id, or null. Whether it names a real run is `payrollModel`'s call. */
export function runIdFromParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Cents as the text a form field holds: `1200.50`. Integer arithmetic only. */
export function centsToField(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Shown in the Run payroll dialog when the workspace has no run yet. */
export const FIRST_RUN_NOTE =
  'The first run can be any month up to this one. After that, months follow one another.';

export type RunMonthChoice =
  | { kind: 'fixed'; month: string }
  | { kind: 'choose'; first: string; last: string; default: string };

/**
 * What the Run payroll dialog asks. With a run on record the database accepts exactly one month, the one after
 * the latest, so it is shown as fixed. With none, any month up to this one (`today` is `YYYY-MM-DD`, Malaysia
 * time) and this month to start with. Null when nothing can be run (the latest run is this month or later).
 */
export function runMonthChoice(runs: Pick<PayrollRun, 'period_month'>[], today: string): RunMonthChoice | null {
  const current = today.slice(0, 7);
  const next = nextRunMonth(runs, today);
  if (next === null) return null;
  return runs.length === 0
    ? { kind: 'choose', first: '2000-01', last: current, default: current }
    : { kind: 'fixed', month: next };
}

/** The note under a run or recalculation about overtime for work before the run's month; null for none. */
export function earlierOvertimeLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? 'Includes 1 overtime claim from an earlier month.'
    : `Includes ${count} overtime claims from earlier months.`;
}

/** Whether `month` (`YYYY-MM`) is a real month from `first` through `last`, both inclusive. */
export function monthInRange(month: string, first: string, last: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= first && month <= last;
}

const FIGURES: {
  field: StatutoryField;
  label: string;
  key: 'epf_cents' | 'socso_cents' | 'eis_cents' | 'pcb_cents';
}[] = [
  { field: 'epf', label: 'EPF', key: 'epf_cents' },
  { field: 'socso', label: 'SOCSO', key: 'socso_cents' },
  { field: 'eis', label: 'EIS', key: 'eis_cents' },
  { field: 'pcb', label: 'PCB', key: 'pcb_cents' },
];

export type DetailLine = {
  id: string;
  label: string;
  kind: PayslipLine['kind'];
  /** Earnings positive; unpaid and deduction lines negative, for display. */
  signed_cents: number;
  amount_cents: number;
  /** Only a line an owner or admin added can be changed. */
  editable: boolean;
  system_note: string | null;
};

export type PayslipDetailModel = {
  basic_cents: number;
  /** Earnings and unpaid lines: what moves basic to gross. */
  pay_lines: DetailLine[];
  gross_cents: number;
  figures: { field: StatutoryField; label: string; amount_cents: number; set_by_hr: boolean }[];
  /** The deduction lines: they come off net, after the four figures. */
  deduction_lines: DetailLine[];
  /** The deduction lines, as the payslip records them. */
  other_cents: number;
  /** Everything between gross and net. */
  deductions_cents: number;
  net_cents: number;
};

const detailLine = (l: PayslipLine): DetailLine => ({
  id: l.id,
  label: l.label,
  kind: l.kind,
  signed_cents: l.kind === 'earning' ? l.amount_cents : -l.amount_cents,
  amount_cents: l.amount_cents,
  editable: l.source === 'hr',
  system_note: l.source === 'hr' ? null : 'Worked out by the system',
});

/** The rows the payslip detail shows. Every figure is the payslip's own; nothing is worked out here. */
export function payslipDetailModel(p: Payslip): PayslipDetailModel {
  return {
    basic_cents: p.basic_cents,
    pay_lines: p.lines.filter((l) => l.kind !== 'deduction').map(detailLine),
    deduction_lines: p.lines.filter((l) => l.kind === 'deduction').map(detailLine),
    gross_cents: p.gross_cents,
    figures: FIGURES.map((f) => ({
      field: f.field,
      label: f.label,
      amount_cents: p[f.key],
      set_by_hr: p.set_by_hr.includes(f.field),
    })),
    other_cents: p.other_deductions_cents,
    deductions_cents: deductionsOf(p),
    net_cents: p.net_cents,
  };
}

export type VouchersModel = {
  count: number;
  total_cents: number;
  paid_count: number;
  draft_count: number;
  /** Issued but not yet paid, whatever the date. */
  outstanding_count: number;
  outstanding_cents: number;
  /** Vouchers dated this month; a draft has not been issued, so it is in neither figure. */
  month: { issued_cents: number; paid_cents: number };
  /** Ringgit per month, last 6 months, oldest first. */
  by_month: Bucket[];
  /** Cents per voucher type, largest first. */
  by_type: { key: string; value: number }[];
  /** Newest first. */
  rows: PaymentVoucher[];
};

export function vouchersModel(vouchers: PaymentVoucher[], today: string): VouchersModel {
  const total = (rows: PaymentVoucher[]) => rows.reduce((t, v) => t + v.amount_cents, 0);
  const thisMonth = vouchers.filter((v) => v.issued_date.slice(0, 7) === today.slice(0, 7));
  const outstanding = vouchers.filter((v) => v.status === 'issued');
  return {
    count: vouchers.length,
    total_cents: total(vouchers),
    paid_count: vouchers.filter((v) => v.status === 'paid').length,
    draft_count: vouchers.filter((v) => v.status === 'draft').length,
    outstanding_count: outstanding.length,
    outstanding_cents: total(outstanding),
    month: {
      issued_cents: total(thisMonth.filter((v) => v.status !== 'draft')),
      paid_cents: total(thisMonth.filter((v) => v.status === 'paid')),
    },
    by_month: bucketByMonth(vouchers, (v) => v.issued_date, (v) => v.amount_cents / 100, today, 6),
    by_type: sumBy(vouchers, (v) => v.voucher_type, (v) => v.amount_cents),
    rows: [...vouchers].sort(
      (a, b) => b.issued_date.localeCompare(a.issued_date) || b.voucher_no.localeCompare(a.voucher_no),
    ),
  };
}

/** Reads and builds the vouchers model; null (and no read) unless the viewer is HR or in the demo. */
export async function readVouchers(
  data: PeopleData,
  viewer: PeopleViewer,
  today: string,
): Promise<VouchersModel | null> {
  if (!isTeamView(viewer)) return null;
  return vouchersModel(await data.listPaymentVouchers(), today);
}
