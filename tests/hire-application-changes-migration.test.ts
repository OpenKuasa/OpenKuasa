// tests/hire-application-changes-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261023090000_hire_application_changes.sql'), 'utf8',
);
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  return sql.slice(start, end);
};

const ALLOWED = [
  'ok', 'not_found', 'forbidden', 'not_active', 'not_closed', 'same_stage', 'too_far_back',
  'invalid_stage', 'invalid_outcome', 'invalid_reason', 'invalid_rating',
];
const FUNCTIONS = [
  { name: 'hire_move_application', args: 'uuid, text' },
  { name: 'hire_close_application', args: 'uuid, text, text' },
  { name: 'hire_reopen_application', args: 'uuid' },
  { name: 'hire_rate_application', args: 'uuid, smallint' },
];

describe('hire application changes migration', () => {
  test('a closed reason is one of six, and only on a closed application', () => {
    expect(sql).toContain('add column reject_reason text');
    expect(sql).toContain(
      "check (reject_reason in ('skills','experience','salary','role_filled','not_reachable','other'))",
    );
    expect(sql).toContain(
      "add constraint hire_applications_reason_when_closed\n    check (outcome <> 'active' or reject_reason is null)",
    );
  });

  test('members get no write on the table', () => {
    expect(sql).not.toMatch(/grant[^;]*hire_applications/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  test.each(FUNCTIONS)('$name checks the caller before it locks the row', ({ name }) => {
    const body = fn(name);
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    const readOrg = body.indexOf('select a.org_id into v_org');
    const member = body.indexOf('if v_org is null or private.is_org_member(v_org) is not true then return \'not_found\'; end if;');
    const writer = body.indexOf('if private.is_org_writer(v_org) is not true then return \'forbidden\'; end if;');
    const lock = body.indexOf('for update');
    expect(readOrg).toBeGreaterThan(-1);
    expect(member).toBeGreaterThan(readOrg);
    expect(writer).toBeGreaterThan(member);
    expect(lock).toBeGreaterThan(writer);
  });

  test.each(FUNCTIONS)('$name answers only with an allowed word', ({ name }) => {
    const body = fn(name);
    const words = [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(ALLOWED, `${name}: ${w}`).toContain(w);
    expect(words).toContain('ok');
  });

  test('move: forward to any stage, back by one, dates follow the stage', () => {
    const body = fn('hire_move_application');
    expect(body).toContain("return 'same_stage'");
    expect(body).toContain("return 'too_far_back'");
    expect(body).toContain('v_to < v_from - 1');
    expect(body).toContain('offered_at = case when v_to >= 4 then coalesce(v_offered, now()) else null end,');
    expect(body).toContain('hired_at = case when v_to = 5 then coalesce(v_hired, now()) else null end');
  });

  test('only a signed-in caller may run them', () => {
    for (const { name, args } of FUNCTIONS) {
      expect(sql).toContain(`revoke execute on function public.${name}(${args}) from public, anon, service_role;`);
      expect(sql).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*\banon\b/);
  });

  test('each rule that refuses is there, and every write comes after the row is locked', () => {
    const live = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    const body = (name: string) => {
      const start = live.indexOf(`create or replace function public.${name}(`);
      return live.slice(start, live.indexOf('end $$;', start));
    };
    expect(body('hire_move_application')).toContain("if v_outcome <> 'active' then return 'not_active'; end if;");
    expect(body('hire_close_application')).toContain("if v_outcome <> 'active' then return 'not_active'; end if;");
    expect(body('hire_reopen_application')).toContain("if v_outcome = 'active' then return 'not_closed'; end if;");
    expect(body('hire_reopen_application')).toContain("set outcome = 'active', reject_reason = null");
    for (const name of ['hire_move_application', 'hire_close_application', 'hire_reopen_application', 'hire_rate_application']) {
      const b = body(name);
      expect(b.indexOf('for update'), name).toBeGreaterThan(-1);
      expect(b.indexOf('update public.hire_applications'), name).toBeGreaterThan(b.indexOf('for update'));
      expect(b.indexOf('is_org_writer'), name).toBeLessThan(b.indexOf('for update'));
    }
  });

  test('nothing is granted to a visitor, to everyone, or to the server role, in any form', () => {
    expect(sql).not.toMatch(/grant\s+(execute|all)[^;]*\bto\b[^;]*\b(anon|public|service_role)\b/i);
  });
});
