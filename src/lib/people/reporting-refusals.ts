/** Each refusal code public.hr_set_reports_to raises, and what the person is told. No imports: any module may read these. */
export const REPORTS_TO_REFUSALS: Record<'EMP_NOT_ALLOWED' | 'EMP_NOT_FOUND' | 'EMP_BAD_MANAGER', string> = {
  EMP_NOT_ALLOWED: 'Only owners and admins can change who someone reports to.',
  EMP_NOT_FOUND: 'That employee was not found.',
  EMP_BAD_MANAGER: 'That would make a loop: that person already reports to this employee, directly or through others.',
};

/** The loop refusal with the chosen manager's name, for the form, which knows it. */
export const reportsToLoop = (managerName: string): string =>
  `That would make a loop: ${managerName} already reports to this person, directly or through others.`;

/** The employee's other details went in; the reporting line did not. */
export const REPORTS_TO_SAVED_NOT_LINE = (reason: string): string =>
  `The employee was saved, but "Reports to" was not: ${reason}`;

/** A decide action called by someone who is neither HR nor a manager. */
export const DECIDE_FORBIDDEN = "Only owners, admins and the employee's manager can do that.";
