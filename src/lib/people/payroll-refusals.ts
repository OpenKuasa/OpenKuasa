/**
 * The sentences for every payroll refusal code. A leaf module with no imports, so the files that need one
 * sentence (`capabilities.ts`, `pay-requests.ts`) can read it without loading the write path.
 */

/** Each refusal code the payroll functions raise, and what the person is told. */
export const PAYROLL_REFUSALS: Record<string, string> = {
  PAYROLL_NOT_ALLOWED: "You can't make that change.",
  PAYROLL_NOT_FOUND: 'That payroll record could not be found.',
  PAYROLL_RUN_EXISTS: 'Payroll for that month has already been run.',
  PAYROLL_MONTH_NOT_STARTED: 'That month has not started yet.',
  PAYROLL_EARLIER_DRAFT: 'An earlier month is still a draft. Mark it as paid or delete it first.',
  PAYROLL_SKIPS_MONTH: 'Run payroll for the month after the latest run first.',
  PAYROLL_NOT_DRAFT: 'That run is already paid. Undo paid first to change it.',
  PAYROLL_NOT_PAID: 'That run is not marked as paid.',
  PAYROLL_LATER_RUN: 'A later month already has a payroll run. Delete that run first.',
  PAYROLL_NEGATIVE_NET: "A payslip's net pay is below zero. Fix it before marking the run as paid.",
  PAYROLL_STALE: 'An overtime claim on this run has changed. Recalculate first.',
  PAYROLL_SYSTEM_LINE: "That line is worked out by the system and can't be changed.",
  PAYROLL_BAD_INPUT: 'Some of that was not accepted. Check the name and the amount, and try again.',
  PAY_IN_PAID_RUN: 'This overtime was paid in a payroll run. Undo paid on that run first.',
  HR_EMPLOYEE_HAS_PAID_PAYSLIPS: 'This employee has paid payslips. Make them inactive instead.',
};
