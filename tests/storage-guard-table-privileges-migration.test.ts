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
      expect(body, name).toMatch(/using \(case when bucket_id = '[a-z-]+' and name ~ '\^\[0-9a-f\]\{8\}-/);
    }
  });
});
