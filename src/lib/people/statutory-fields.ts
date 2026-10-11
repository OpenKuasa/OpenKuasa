/**
 * The four statutory figures on a payslip, in the order the database reports them (`set_by_hr`). Declared once:
 * the write path, the provider and the forms all read this list. A leaf module with no imports.
 */
export const STATUTORY_FIELDS = ['epf', 'socso', 'eis', 'pcb'] as const;
