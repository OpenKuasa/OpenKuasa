import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILE = join(process.cwd(), 'supabase/migrations/20261125150300_crm_agent_service_reads.sql');
/** The migration's statements, without comment lines. */
const sql = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

function granted(table: string): Set<string> {
  const match = sql.match(new RegExp(`grant select \\(([^)]+)\\)\\s+on public\\.${table} to service_role;`));
  expect(match, table).not.toBeNull();
  return new Set(match![1].split(',').map((column) => column.trim()));
}

describe('the Kasturi agent worker may read what it scans', () => {
  // The worker reads with the service-role client, which has no table grants
  // by default; without these its every run fails on crm_deals.
  test('crm_deals: the columns the open-deal read selects, filters, sorts and joins on', () => {
    expect([...granted('crm_deals')].sort()).toEqual(
      ['id', 'org_id', 'title', 'value_cents', 'status', 'contact_id', 'expected_close_date', 'last_activity_at', 'created_at'].sort(),
    );
  });

  test('crm_contacts: only company is added (the rest is granted by 20261118090000)', () => {
    expect([...granted('crm_contacts')]).toEqual(['company']);
  });

  test('crm_activities: no body', () => {
    expect([...granted('crm_activities')].sort()).toEqual(
      ['id', 'org_id', 'title', 'contact_id', 'deal_id', 'type', 'due_at', 'completed_at', 'created_at'].sort(),
    );
  });

  test('crm_notes: links and times only, never the body', () => {
    const notes = granted('crm_notes');
    expect([...notes].sort()).toEqual(['id', 'org_id', 'contact_id', 'deal_id', 'created_at'].sort());
    expect(notes.has('body')).toBe(false);
  });

  test('never emails or phones, and grants nothing else', () => {
    expect(sql).not.toMatch(/\b(email|phone|body|notes)\b/);
    expect(sql.match(/\bgrant\b/g)).toHaveLength(4);
    expect(sql).not.toMatch(/\b(insert|update|delete|all)\b/);
  });
});
