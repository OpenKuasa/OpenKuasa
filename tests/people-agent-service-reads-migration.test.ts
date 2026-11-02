import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('supabase/migrations/20261125200200_people_agent_service_reads.sql'),
  'utf8',
);

describe('the people agent service-role migration', () => {
  it('removes fresh-project table grants before granting selected read columns', () => {
    const revoke = migration.indexOf('select c.relname from pg_catalog.pg_class c');
    const grant = migration.indexOf('grant select (id, org_id, name, status)');

    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    const cleanup = migration.slice(revoke, grant);
    expect(cleanup).toContain("c.relnamespace = 'public'::regnamespace");
    expect(cleanup).toContain("c.relkind in ('r', 'p', 'v', 'm')");
    expect(cleanup).toContain("c.relname like 'hr\\_%'");
    expect(cleanup).toContain("format('revoke all on public.%I from service_role', t)");
  });
});
