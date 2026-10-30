import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261125200200_people_agent_service_reads.sql'),
  'utf8',
);

describe('the people agent service-role migration', () => {
  it('removes fresh-project table grants before granting selected read columns', () => {
    const revoke = migration.indexOf('revoke all on');
    const grant = migration.indexOf('grant select (id, org_id, name, status)');

    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    for (const table of [
      'public.hr_employees',
      'public.hr_documents',
      'public.hr_goals',
      'public.hr_leave_requests',
      'public.hr_claims',
      'public.hr_overtime_records',
      'public.hr_letters',
      'public.hr_attendance_days',
      'public.hr_payroll_runs',
      'public.hr_employee_private',
      'public.hr_agent_notes',
    ]) {
      expect(migration.slice(revoke, grant)).toContain(table);
    }
  });
});
