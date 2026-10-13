// tests/agent-spend-controls-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
const sql = read('20261030111500_agent_spend_controls.sql');
const quota = read('20261030113000_ai_chat_daily_quota.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
};

describe('agent spend controls migration', () => {
  test('agent settings and schedules are written by an owner or admin only', () => {
    for (const table of ['agent_configs', 'agent_schedules']) {
      expect(sql).toContain(`drop policy ${table}_write on public.${table};`);
      expect(sql).toMatch(
        new RegExp(
          `create policy ${table}_write on public\\.${table}\\s+for all to authenticated\\s+` +
            'using \\(private\\.is_org_admin\\(org_id\\)\\) with check \\(private\\.is_org_admin\\(org_id\\)\\);',
        ),
      );
    }
    expect(sql).not.toContain('is_org_writer');
  });

  test('a schedule is always stamped with the member who created it', () => {
    expect(sql).toContain('alter table public.agent_schedules alter column created_by set default auth.uid();');
    expect(sql).toContain('revoke insert (created_by) on public.agent_schedules from authenticated;');
  });

  test('a workspace has at most one run in progress, and older duplicates are closed first', () => {
    const index = sql.indexOf('create unique index agent_runs_one_running_uniq');
    expect(index).toBeGreaterThan(-1);
    expect(sql.slice(index, sql.indexOf(';', index))).toMatch(
      /on public\.agent_runs \(org_id\)\s+where status = 'running'/,
    );
    const cleanup = sql.indexOf("set status = 'failed', error = 'superseded'");
    expect(cleanup).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(index);
  });

  test('the spend for a window is summed in the database, with a run in progress counted at its cap', () => {
    const body = fn('agent_spend_cents');
    expect(body).toContain('p_org_id uuid, p_since timestamptz');
    expect(body).toContain('returns integer');
    expect(body).toContain('security invoker');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain('sum(');
    expect(body).toContain("when r.status = 'running'");
    expect(body).toContain('greatest(r.cost_cents, coalesce(c.max_cost_cents, 200))');
    expect(body).toContain('r.org_id = p_org_id and r.started_at >= p_since');
    expect(sql).toContain(
      'revoke all on function public.agent_spend_cents(uuid, timestamptz) from public, anon;',
    );
    expect(sql).toContain(
      'grant execute on function public.agent_spend_cents(uuid, timestamptz) to authenticated, service_role;',
    );
  });

  test('a video carries its cost, and only the server settles it against the run', () => {
    expect(sql).toMatch(/add column cost_cents integer not null default 0 check \(cost_cents >= 0\)/);
    expect(sql).toContain('add column cost_estimated boolean not null default false');
    const body = fn('agent_settle_video_cost');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain('for update');
    // Settled once: a second call must not move the run's total again.
    expect(body).toContain('if not a.cost_estimated then');
    // Never while the run is still writing its own total.
    expect(body).toContain("and status <> 'running'");
    expect(body).toContain('greatest(0, cost_cents + (p_cost_cents - a.cost_cents))');
    expect(sql).toContain(
      'revoke all on function public.agent_settle_video_cost(uuid, integer) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      'grant execute on function public.agent_settle_video_cost(uuid, integer) to service_role;',
    );
  });
});

describe('chat daily quota migration', () => {
  test('makes sure the per-user daily counter exists and only signed-in users may call it', () => {
    expect(quota).toContain('create table if not exists public.ai_usage');
    expect(quota).toContain('create or replace function public.consume_ai_quota(daily_limit integer)');
    expect(quota).toContain('security definer');
    expect(quota).toContain("set search_path = ''");
    expect(quota).toContain('revoke all on function public.consume_ai_quota(integer) from public, anon;');
    expect(quota).toContain('grant execute on function public.consume_ai_quota(integer) to authenticated;');
  });
});
