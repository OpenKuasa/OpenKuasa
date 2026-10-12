import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const NAME = '20261101140000_storage_policy_guard_and_table_privileges.sql';

/** A migration's statements, without comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const sql = statements(NAME);
const flat = sql.replace(/\s+/g, ' ');

const TABLES = ['orgs', 'org_members', 'ai_usage', 'agent_configs', 'agent_runs', 'agent_run_assets'];

/** Every grant to authenticated on one table, in the order written. */
const grantsOn = (table: string) =>
  [...flat.matchAll(new RegExp(`grant ([^;]+?) on public\\.${table} to authenticated;`, 'g'))].map((m) => m[1]);

describe('storage policy guard and table privileges migration', () => {
  test('the agent-assets policy casts a folder to a uuid only inside its own bucket', () => {
    expect(sql).toContain('drop policy if exists agent_assets_select on storage.objects;');
    expect(flat).toContain(
      "create policy agent_assets_select on storage.objects for select to authenticated using (case when bucket_id = 'agent-assets' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then private.is_org_member(((storage.foldername(name))[1])::uuid) else false end);",
    );
    // The one storage policy this file touches.
    expect(sql.match(/on storage\.objects/g)).toHaveLength(2);
  });

  test('no storage policy in any migration is left casting a folder outside a case', () => {
    const latest = new Map<string, string>();
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const text = statements(file).replace(/\s+/g, ' ');
      for (const m of text.matchAll(/create policy (\w+) on storage\.objects ([^;]+);/g)) latest.set(m[1], m[2]);
    }
    expect(latest.size).toBeGreaterThan(5);
    for (const [name, body] of latest) {
      if (!/foldername\(name\)\)\[1\]\)?::uuid/.test(body)) continue;
      // A read rule opens with `using`, an upload rule with `with check`: either way the cast sits inside the case.
      expect(body, name).toMatch(/(?:using|with check) \( ?case when bucket_id = '[a-z-]+' and name ~ '\^\[0-9a-f\]\{8\}-/);
    }
  });

  test('each of the six tables is revoked from anon and authenticated before it is granted', () => {
    for (const table of TABLES) {
      const revoke = sql.indexOf(`revoke all on public.${table} from anon, authenticated;`);
      const grant = flat.indexOf(` on public.${table} to authenticated;`);
      expect(revoke, table).toBeGreaterThanOrEqual(0);
      expect(grant, table).toBeGreaterThanOrEqual(0);
      expect(sql.slice(0, revoke)).not.toMatch(new RegExp(`grant [^;]* on public\\.${table} to`));
    }
    expect(sql).not.toMatch(/\bto anon\b/);
    expect(sql).not.toMatch(/service_role/);
  });

  test('the grants are exactly the ones the earlier migrations gave', () => {
    expect(grantsOn('orgs')).toEqual([
      'select',
      'update (name, registration_no, sst_no, website, industry, company_size, address, city, state, postcode)',
    ]);
    expect(grantsOn('org_members')).toEqual(['select']);
    expect(grantsOn('ai_usage')).toEqual(['select']);
    expect(grantsOn('agent_configs')).toEqual([
      'select, insert, delete',
      'update (enabled, cadence, max_cost_cents, last_run_at, updated_at, daily_cap_cents, weekly_cap_cents)',
    ]);
    expect(grantsOn('agent_runs')).toEqual(['select']);
    expect(grantsOn('agent_run_assets')).toEqual(['select']);
  });

  test('no policy on those tables is dropped or replaced', () => {
    expect(sql).not.toMatch(/policy [^;]* on public\./);
    expect(sql).not.toMatch(/disable row level security/);
  });
});
