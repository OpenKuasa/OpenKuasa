import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/** A SQL file's statements, without `--` comments, whole-line or trailing. */
function statements(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const sql = statements('supabase/migrations/20261202090100_kasturi_service_role_grants.sql');
const defaults = statements('supabase/migrations/20261202090200_service_role_default_privileges.sql');
const check = statements('supabase/tests/kasturi_service_reads_check.sql');

/** Every `grant <verb> (cols) on public.<table> to service_role;` in the migration, as table.column. */
function pinned(verb: 'select' | 'update'): string[] {
  const found: string[] = [];
  for (const match of sql.matchAll(new RegExp(`^grant ${verb} \\(([^)]+)\\)\\s+on public\\.(crm_\\w+) to service_role;`, 'gm'))) {
    for (const column of match[1].split(',')) found.push(`${match[2]}.${column.trim()}`);
  }
  return found.sort();
}

describe('no crm_ relation keeps the table grant a fresh project gives service_role', () => {
  test('the revoke covers every crm_ relation of every relkind, not a list of tables', () => {
    expect(sql).toMatch(/relname like 'crm\\_%'/);
    expect(sql).toMatch(/relkind in \('r', 'p', 'v', 'm', 'f'\)/);
    expect(sql).toMatch(/execute format\('revoke all on public\.%I from service_role', r\.relname\)/);
  });

  // Revoking a table privilege drops the column grants on that relation too, so
  // the revoke has to come first and the pin after it, or the app loses its reads.
  test('the revoke runs before every grant of the pin', () => {
    const revoke = sql.indexOf('revoke all on public.%I from service_role');
    const first = sql.search(/^grant /m);
    expect(revoke).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(revoke);
  });

  test('the columns the Kasturi worker reads are pinned, and nothing else', () => {
    const reads = (table: string) => pinned('select').filter((key) => key.startsWith(`${table}.`));
    expect(reads('crm_contacts')).toEqual(
      ['company', 'created_at', 'first_name', 'id', 'last_name', 'org_id', 'source', 'status', 'tags'].map((c) => `crm_contacts.${c}`),
    );
    expect(reads('crm_deals')).toEqual(
      ['contact_id', 'created_at', 'expected_close_date', 'id', 'last_activity_at', 'org_id', 'status', 'title', 'value_cents'].map(
        (c) => `crm_deals.${c}`,
      ),
    );
    expect(reads('crm_activities')).toEqual(
      ['completed_at', 'contact_id', 'created_at', 'deal_id', 'due_at', 'id', 'org_id', 'title', 'type'].map((c) => `crm_activities.${c}`),
    );
    expect(reads('crm_notes')).toEqual(['contact_id', 'created_at', 'deal_id', 'id', 'org_id'].map((c) => `crm_notes.${c}`));
  });

  // The update PostgREST builds for the sender filters on id and status and
  // returns a constant, so those two reads and the four written columns are all it needs.
  test('the broadcast marking path keeps the columns its update reads and writes', () => {
    expect(pinned('select').filter((key) => key.startsWith('crm_broadcast_recipients.'))).toEqual([
      'crm_broadcast_recipients.id',
      'crm_broadcast_recipients.status',
    ]);
    expect(pinned('update')).toEqual(
      ['error', 'provider_id', 'sent_at', 'status'].map((c) => `crm_broadcast_recipients.${c}`),
    );
  });

  test('every grant statement is one of the pin, and none reaches another role', () => {
    const grants = sql.match(/^grant /gm) ?? [];
    const pins = [...sql.matchAll(/^grant (select|update) \([^)]+\)\s+on public\.crm_\w+ to service_role;/gm)];
    expect(pins.length).toBeGreaterThan(0);
    expect(grants).toHaveLength(pins.length);
    expect(sql).not.toMatch(/^grant (all|insert|delete|truncate|references|trigger|maintain)\b/m);
    expect(sql).not.toMatch(/\bto (anon|authenticated|public)\b/);
  });

  test('the self-check finds no table privilege and nothing reachable beyond the grants', () => {
    expect(sql).toMatch(/create or replace function private\.crm_service_role_access\(\)/);
    expect(sql).toMatch(/revoke all on function private\.crm_service_role_access\(\) from public;/);
    expect(sql).toMatch(/where a\.col is null;/);
    expect(sql).toMatch(/can reach crm_ columns it was not granted here/);
  });
});

describe('the boundary check agrees with the migration', () => {
  test('its pinned array is the migration’s select grants, column for column', () => {
    const array = check.match(/pinned := array\[([\s\S]*?)\];/);
    expect(array).not.toBeNull();
    const listed = [...array![1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    expect(listed).toEqual(pinned('select'));
  });

  test('judges the boundary with the migration’s own function rather than a copy of its queries', () => {
    expect(check).toMatch(/from private\.crm_service_role_access\(\) a/);
    expect(check).not.toMatch(/has_column_privilege\('service_role', c\.oid, a\.attname/);
  });

  // The arbiter's own sensitivity is proved inside the file: grant one column to
  // PUBLIC, expect the inventory to name it, then prove the grant is gone.
  test('proves it catches a column grant made to PUBLIC, and rolls that grant back', () => {
    expect(check).toMatch(/grant update \(status\) on public\.crm_contacts to public;/);
    expect(check).toMatch(/does not see a column grant made to PUBLIC/);
    expect(check).toMatch(/the PUBLIC probe grant was not rolled back/);
  });

  test('runs the marking update in the form PostgREST sends, for a send and for a retry', () => {
    expect(check.match(/WITH pgrst_source AS \(/g)).toHaveLength(2);
    expect(check).toMatch(/json_to_record\(pgrst_payload\.json_data\)/);
    expect(check).toMatch(/"status" <> \$3/);
  });
});

describe('a table made later gives service_role nothing', () => {
  test('the default for new tables in public is changed for service_role only', () => {
    expect(defaults).toMatch(/^alter default privileges in schema public revoke all on tables from service_role;$/m);
    expect(defaults).not.toMatch(/\b(anon|authenticated)\b/);
  });

  test('proves it by making a table and looking at it', () => {
    expect(defaults).toMatch(/create table public\.service_role_default_probe/);
    expect(defaults).toMatch(/drop table public\.service_role_default_probe;/);
  });
});
