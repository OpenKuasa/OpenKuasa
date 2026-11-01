import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261125170200_finance_agent_service_reads.sql'),
  'utf8',
);
const canonicalCheck = readFileSync(
  resolve('supabase/tests/bendahara_agent_notes_check.sql'),
  'utf8',
);

describe('the finance agent service-role migration', () => {
  it('removes the remaining fresh-project Finance grants before adding the worker columns', () => {
    const revoke = migration.indexOf('revoke all on');
    const firstGrant = migration.indexOf('grant select (');

    expect(revoke).toBeGreaterThan(-1);
    expect(firstGrant).toBeGreaterThan(revoke);
    const cleanup = migration.slice(revoke, firstGrant);
    for (const table of [
      'public.finance_settings',
      'public.finance_sst_return_figures',
      'public.finance_sst_settings',
      'public.finance_sst_returns',
    ]) {
      expect(cleanup).toContain(table);
    }
    expect(cleanup).toContain('from service_role;');
  });

  it('checks effective privileges in both arbiters so a PUBLIC grant cannot bypass them', () => {
    for (const sql of [migration, canonicalCheck]) {
      for (const table of [
        "('finance_settings')",
        "('finance_sst_return_figures')",
        "('finance_sst_settings')",
        "('finance_sst_returns')",
      ]) {
        expect(sql).toContain(table);
      }
      expect(sql).toContain('has_table_privilege(');
      expect(sql).toContain("'select,insert,update,delete,truncate,references,trigger,maintain'");
      expect(sql).not.toContain('aclexplode(c.relacl)');
    }
  });
});
