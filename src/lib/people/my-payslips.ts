/**
 * My Payslips: what the signed-in employee sees of their own paid payslips. Pure, so it is testable without a
 * DOM. Every figure shown is what the payslip row carries; nothing is added up here.
 */
import { type OwnPayslip, ownPayslipsModel } from './payroll';
import type { PeopleData, PeopleViewer } from './types';

export const NO_PAYSLIPS_TEXT = 'No payslips yet. A payslip appears here once payroll for the month is marked as paid.';

/**
 * The viewer's own paid payslips, newest first. The read names the employee, so only their rows come back; the
 * model's own filter stays as a second guard. An account linked to nobody reads nothing at all.
 */
export async function readOwnPayslips(data: Pick<PeopleData, 'listPayslips'>, viewer: PeopleViewer): Promise<OwnPayslip[]> {
  if (viewer.employeeId === null) return [];
  return ownPayslipsModel(await data.listPayslips(viewer.employeeId), viewer.employeeId);
}
