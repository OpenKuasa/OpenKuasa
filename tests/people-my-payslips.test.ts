import { describe, expect, it, vi } from 'vitest';
import { NO_PAYSLIPS_TEXT, readOwnPayslips } from '@/lib/people/my-payslips';
import type { Payslip, PeopleViewer } from '@/lib/people/types';

const ME = 'emp-me';
const slip = (over: Partial<Payslip>): Payslip => ({
  id: 's', employee_id: ME, employee_name: 'Me', payroll_run_id: 'r', period_month: '2026-09-01',
  basic_cents: 500000, gross_cents: 525000, epf_cents: 57750, socso_cents: 1000, eis_cents: 500, pcb_cents: 2000,
  other_deductions_cents: 1500, net_cents: 462250, set_by_hr: [], lines: [], status: 'paid', ...over,
});
const viewer = (employeeId: string | null): PeopleViewer => ({ employeeId, isHr: false, isDemo: false });
const dataOf = (slips: Payslip[]) => ({ listPayslips: vi.fn(async (employeeId?: string) => (employeeId ? slips : [])) });

describe('readOwnPayslips', () => {
  it('shows only my paid payslips, newest first', async () => {
    const own = await readOwnPayslips(
      dataOf([
        slip({ id: 'sep', period_month: '2026-09-01' }),
        slip({ id: 'draft-oct', period_month: '2026-10-01', status: 'pending' }),
        slip({ id: 'aug', period_month: '2026-08-01' }),
        slip({ id: 'colleague', employee_id: 'emp-other', period_month: '2026-09-01' }),
      ]),
      viewer(ME),
    );
    expect(own.map((p) => p.id)).toEqual(['sep', 'aug']);
    expect(own.map((p) => p.label)).toEqual(['September 2026', 'August 2026']);
  });

  it('asks the database for my payslips only', async () => {
    const data = dataOf([slip({})]);
    await readOwnPayslips(data, viewer(ME));
    expect(data.listPayslips).toHaveBeenCalledWith(ME);
  });

  it('reads nothing at all for an account linked to no employee', async () => {
    const data = dataOf([slip({})]);
    expect(await readOwnPayslips(data, viewer(null))).toEqual([]);
    expect(data.listPayslips).not.toHaveBeenCalled();
  });

  it('is empty, not an error, when nothing is paid yet', async () => {
    expect(await readOwnPayslips(dataOf([slip({ status: 'pending' })]), viewer(ME))).toEqual([]);
  });

  it('has the spec sentence for no payslips', () => {
    expect(NO_PAYSLIPS_TEXT).toBe('No payslips yet. A payslip appears here once payroll for the month is marked as paid.');
  });
});
