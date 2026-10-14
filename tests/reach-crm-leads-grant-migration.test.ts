import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CAPTURED_CONTACT_COLUMNS } from '@/lib/reach/crm-leads';

const FILE = join(process.cwd(), 'supabase/migrations/20261118090000_reach_agent_reads_captured_contacts.sql');
/** The migration's statements, without comment lines. */
const sql = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('the Weekly Studio worker may read captured contacts', () => {
  // The worker reads leads with the service-role client, which has no table
  // grants by default; without this its every run fails on crm_contacts.
  const grant = sql.match(/grant select \(([^)]+)\)\s+on public\.crm_contacts to service_role;/);

  test('grants select on crm_contacts to service_role, by column', () => {
    expect(grant).not.toBeNull();
  });

  test('covers every column listLeads selects, filters on and sorts by', () => {
    const granted = new Set(grant![1].split(',').map((column) => column.trim()));
    for (const column of [...CAPTURED_CONTACT_COLUMNS.split(','), 'org_id', 'tags']) {
      expect(granted, column).toContain(column);
    }
  });

  test('grants nothing else', () => {
    expect(sql.match(/\bgrant\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/);
  });
});
