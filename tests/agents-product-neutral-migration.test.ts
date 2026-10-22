// tests/agents-product-neutral-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261125130000_agents_product_neutral.sql'),
  'utf8',
);

describe('agents product-neutral migration', () => {
  test('agent_spend_cents gains an optional per-agent filter', () => {
    const start = sql.indexOf('create or replace function public.agent_spend_cents(');
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf('$$;', start));
    expect(body).toMatch(
      /agent_spend_cents\(\s*p_org_id uuid,\s*p_since timestamptz,\s*p_agent_key text default null\s*\)/,
    );
    expect(body).toContain('security invoker');
    expect(body).toContain('where r.org_id = p_org_id and r.started_at >= p_since');
    expect(body).toContain('and (p_agent_key is null or r.agent_key = p_agent_key)');
    expect(body).toContain('coalesce(c.max_cost_cents, 200)');
  });

  test('the old two-argument overload is dropped and the new one granted', () => {
    expect(sql).toContain('drop function public.agent_spend_cents(uuid, timestamptz);');
    expect(sql).toContain(
      'revoke all on function public.agent_spend_cents(uuid, timestamptz, text) from public, anon;',
    );
    expect(sql).toContain(
      'grant execute on function public.agent_spend_cents(uuid, timestamptz, text) to authenticated, service_role;',
    );
  });

  test('agent_runs.trigger allows interpret', () => {
    expect(sql).toContain("check (trigger in ('schedule','manual','interpret'))");
    expect(sql).toContain('pg_constraint');
  });

  test('agent_proposals gets a bounded nullable check_key', () => {
    expect(sql).toContain('alter table public.agent_proposals add column check_key text');
    expect(sql).toContain('check (check_key is null or length(check_key) <= 64)');
  });
});
