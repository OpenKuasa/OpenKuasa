import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261125170200_finance_agent_service_reads.sql'),
  'utf8',
);

describe('the finance agent service-role migration', () => {
  it('removes fresh-project SST table grants before adding the worker columns', () => {
    const revoke = migration.indexOf(
      'revoke all on public.finance_sst_settings, public.finance_sst_returns from service_role;',
    );
    const firstGrant = migration.indexOf('grant select (');

    expect(revoke).toBeGreaterThan(-1);
    expect(firstGrant).toBeGreaterThan(revoke);
  });

  it('checks both SST tables for surviving table privileges', () => {
    expect(migration).toContain("c.relname in ('finance_sst_settings', 'finance_sst_returns')");
    expect(migration).toContain('aclexplode(c.relacl)');
    expect(migration).toContain("a.grantee = 'service_role'::regrole");
  });
});
