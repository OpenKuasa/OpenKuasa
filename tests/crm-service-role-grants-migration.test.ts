import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILE = join(process.cwd(), 'supabase/migrations/20261201090000_kasturi_service_role_grants.sql');
/** The migration's statements, without comment lines. */
const sql = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

function columns(table: string, verb: 'select' | 'update'): Set<string> {
  const match = sql.match(new RegExp(`grant ${verb} \\(([^)]+)\\)\\s+on public\\.${table} to service_role;`));
  expect(match, `${verb} on ${table}`).not.toBeNull();
  return new Set(match![1].split(',').map((column) => column.trim()));
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
    const first = sql.search(/grant (select|update)/);
    expect(revoke).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(revoke);
  });

  test('the columns the Kasturi worker reads are pinned, and nothing else', () => {
    expect([...columns('crm_contacts', 'select')].sort()).toEqual(
      ['company', 'created_at', 'first_name', 'id', 'last_name', 'org_id', 'source', 'status', 'tags'].sort(),
    );
    expect([...columns('crm_deals', 'select')].sort()).toEqual(
      ['contact_id', 'created_at', 'expected_close_date', 'id', 'last_activity_at', 'org_id', 'status', 'title', 'value_cents'].sort(),
    );
    expect([...columns('crm_activities', 'select')].sort()).toEqual(
      ['completed_at', 'contact_id', 'created_at', 'deal_id', 'due_at', 'id', 'org_id', 'title', 'type'].sort(),
    );
    expect([...columns('crm_notes', 'select')].sort()).toEqual(
      ['contact_id', 'created_at', 'deal_id', 'id', 'org_id'].sort(),
    );
  });

  // src/lib/crm/broadcast-send.ts marks each recipient with
  // .update(patch).eq('id', row.id) and, on a retry, .neq('status', 'sent'), so
  // the update reads id and status as well as writing the four columns.
  test('the broadcast marking path keeps the columns its update reads and writes', () => {
    expect([...columns('crm_broadcast_recipients', 'select')].sort()).toEqual(['id', 'status']);
    expect([...columns('crm_broadcast_recipients', 'update')].sort()).toEqual(
      ['error', 'provider_id', 'sent_at', 'status'].sort(),
    );
  });

  test('the pin is read and that one update, nothing else', () => {
    expect(sql.match(/\bgrant\b/g)).toHaveLength(6);
    expect(sql).not.toMatch(/grant (all|insert|delete|truncate|references|trigger)/);
    expect(sql).not.toMatch(/\bon public\.crm_\w+ to (anon|authenticated|public)\b/);
  });
});
