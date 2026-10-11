/**
 * My Payslips: what the signed-in employee sees of their own paid payslips. Pure, so it is testable without a
 * DOM. Every figure shown is what the payslip row carries; nothing is added up here.
 */
import { type OwnPayslip, ownPayslipsModel } from './payroll';
import { centsToRinggit } from './payroll-forms';
import type { Payslip, PeopleData, PeopleViewer } from './types';

export const NO_PAYSLIPS_TEXT = 'No payslips yet. A payslip appears here once payroll for the month is marked as paid.';

/** The viewer's own paid payslips, newest first. An account linked to nobody reads nothing at all. */
export async function readOwnPayslips(data: Pick<PeopleData, 'listPayslips'>, viewer: PeopleViewer): Promise<OwnPayslip[]> {
  if (viewer.employeeId === null) return [];
  return ownPayslipsModel(await data.listPayslips(), viewer.employeeId);
}

export type BreakdownRow = { key: string; label: string; value: string; tone?: 'minus' };

/** The lines of a payslip as shown read-only: basic, each line, gross, the four figures, deductions, net. */
export function payslipBreakdown(p: Payslip): BreakdownRow[] {
  const rows: BreakdownRow[] = [{ key: 'basic', label: 'Basic salary', value: centsToRinggit(p.basic_cents) }];
  for (const line of p.lines) {
    const minus = line.kind !== 'earning';
    rows.push({
      key: line.id,
      label: line.label,
      value: `${minus ? '-' : ''}${centsToRinggit(line.amount_cents)}`,
      ...(minus ? { tone: 'minus' as const } : {}),
    });
  }
  rows.push({ key: 'gross', label: 'Gross pay', value: centsToRinggit(p.gross_cents) });
  const statutory: [string, string, number][] = [
    ['epf', 'EPF', p.epf_cents],
    ['socso', 'SOCSO', p.socso_cents],
    ['eis', 'EIS', p.eis_cents],
    ['pcb', 'PCB', p.pcb_cents],
  ];
  for (const [key, label, cents] of statutory) {
    rows.push({ key, label, value: `-${centsToRinggit(cents)}`, tone: 'minus' });
  }
  rows.push({ key: 'other', label: 'Other deductions', value: `-${centsToRinggit(p.other_deductions_cents)}`, tone: 'minus' });
  rows.push({ key: 'net', label: 'Net pay', value: centsToRinggit(p.net_cents) });
  return rows;
}
