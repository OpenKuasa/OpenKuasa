import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261128094000_service_role_fresh_project_grants.sql'),
  'utf8',
);
const lekirCheck = readFileSync(resolve('supabase/tests/lekir_agent_notes_check.sql'), 'utf8');

describe('the service-role grants catch-up migration', () => {
  it('only touches relations where service_role can still read or change data table-wide', () => {
    expect(migration).toContain("and has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate')");
    for (const name of ["'hire\\_%'", "'hr\\_%'", "'crm_deals'", "'finance_sst_returns'"]) {
      expect(migration).toContain(name);
    }
  });

  it('gives back the column reads a table-level revoke drops, and leaves REFERENCES and TRIGGER alone', () => {
    const revoke = migration.indexOf("'revoke select, insert, update, delete, truncate on public.%I from service_role'");
    const capture = migration.indexOf("x.privilege_type = 'SELECT'");
    const regrant = migration.indexOf("'grant select (%s) on public.%I to service_role'");
    expect(capture).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(capture);
    expect(regrant).toBeGreaterThan(revoke);
    expect(migration).not.toMatch(/revoke all on public\.%I/);
  });

  it('stops when access survives through PUBLIC, and closes the refund function', () => {
    expect(migration).toContain('raise exception');
    expect(migration).toContain('revoke all on function public.finance_record_refund(uuid, jsonb) from service_role;');
  });

  it('runs on PostgreSQL 15 and 16 as well: no MAINTAIN', () => {
    expect(migration).not.toContain('maintain');
    expect(lekirCheck).not.toContain('maintain');
  });
});
