/**
 * Pure builders for the payroll screens (Payroll, My Payslips, Payment Vouchers).
 * Payroll and Payment Vouchers are for owners and admins: `readPayroll` /
 * `readVouchers` return null without reading anything for anyone else.
 *
 * Nothing here works out a payslip. Gross, the four statutory figures, the
 * deductions total and net are whatever the row carries; the models only add
 * rows up and order them.
 */

import { monthLabel, monthYearLabel } from './dates';
import { isTeamView } from './own';
import { bucketByMonth, sumBy } from './series';
import type { Bucket } from './series';
import { payrollSummary } from './summaries';
import type { PaymentVoucher, PayrollRun, PeopleData, PeopleViewer, Payslip } from './types';

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
   * The chosen run: the one asked for, else the newest with payslips. Null when the workspace has no run (or
   * every run is empty and none was asked for). The name is historical: it is not always the newest.
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

const rowOf = (p: Payslip): PayslipRow => ({ ...p, deductions_cents: p.gross_cents - p.net_cents });

/**
 * `runId` picks a run; an id that names no run falls back to the newest with payslips.
 */
export function payrollModel(runs: PayrollRun[], payslips: Payslip[], runId?: string | null): PayrollModel {
  // Newest first. A run with no payslips has nothing to chart, so it is left out of the totals (the Dashboard does the same).
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
  const chosen = asked ?? runs.find((r) => r.period_month === totals[0]?.period_month);
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
