// tests/agent-proposals-allow-crm-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261125150200_agent_proposals_allow_crm.sql'),
  'utf8',
);

describe('agent_proposals allow crm migration', () => {
  test('finds the unnamed product check by definition and drops it', () => {
    expect(sql).toContain('pg_constraint');
    expect(sql).toContain("con.conrelid = 'public.agent_proposals'::regclass");
    expect(sql).toContain("pg_get_constraintdef(con.oid) ilike '%product%'");
    expect(sql).toContain("pg_get_constraintdef(con.oid) ilike '%reach%'");
    expect(sql).toContain('alter table public.agent_proposals drop constraint %I');
  });

  test('adds a named check allowing reach and crm', () => {
    expect(sql).toContain('add constraint agent_proposals_product_check');
    expect(sql).toContain("check (product in ('reach','crm'))");
  });

  test('does not change the column default', () => {
    expect(sql).not.toMatch(/alter column product/i);
  });

  test('says it waits for the product-routed approval path', () => {
    expect(sql).toContain('PR #345');
  });
});
