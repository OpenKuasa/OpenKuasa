import type { Payslip } from '@/lib/people/types';
import { PayslipLayout } from './payslip-rows';

/**
 * One payslip, read-only: basic, each line, gross, the four proposed figures, the deduction lines and net, as
 * recorded. Safe to import into a member's page: it imports nothing that edits or reaches a server action
 * (a test walks its imports to prove it).
 *
 * `editable` is accepted so callers can say what they mean, but it NEVER mounts a control. The Payroll screen
 * renders `PayslipEditor` (`payslip-editor.tsx`) for a draft instead.
 */
export function PayslipDetail({ payslip }: { payslip: Payslip; editable: boolean }) {
  return <PayslipLayout payslip={payslip} />;
}
