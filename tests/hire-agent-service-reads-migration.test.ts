import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261125190200_hire_agent_service_reads.sql'),
  'utf8',
);

describe('the hiring agent service-role migration', () => {
  it('removes fresh-project table grants before granting selected read columns', () => {
    const revoke = migration.indexOf('revoke all on');
    const grant = migration.indexOf('grant select (id, org_id, candidate_id');

    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    for (const table of [
      'public.hire_applications',
      'public.hire_candidates',
      'public.hire_interviews',
      'public.hire_jobs',
      'public.hire_agent_notes',
      'public.hire_settings',
    ]) {
      expect(migration.slice(revoke, grant)).toContain(table);
    }
  });

  it('checks the complete hire schema for surviving table privileges', () => {
    expect(migration).toContain("c.relname like 'hire\\_%'");
    expect(migration).toContain('aclexplode(c.relacl)');
    expect(migration).toContain("a.grantee = 'service_role'::regrole");
  });
});
