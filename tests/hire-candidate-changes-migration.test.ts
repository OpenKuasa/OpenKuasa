// tests/hire-candidate-changes-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const raw = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261026090000_hire_candidate_changes.sql'), 'utf8',
);
// Comment lines are dropped so an explanation can never satisfy an order check.
const sql = raw.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf('end $$;', start);
  expect(end, name).toBeGreaterThan(start);
  return sql.slice(start, end);
};

const ADD_ARGS = 'uuid, text, text, text, text, text, text[], text, uuid, text, text';
const MEMBER = 'private.is_org_member(p_org_id) is not true';
const WRITER = 'private.is_org_writer(p_org_id) is not true';

describe('hire candidate changes migration', () => {
  test('members get no write on any table', () => {
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant[^;]*\b(on\s+)?(table\s+)?(public\.)?hire_(candidates|applications)\b/i);
  });

  test.each(['hire_add_candidate', 'hire_update_candidate', 'hire_attach_cv'])(
    '%s is security definer with an empty search path', (name) => {
      const body = fn(name);
      expect(body).toContain('security definer');
      expect(body).toContain("set search_path = ''");
    },
  );

  test('add: both caller checks come before any write and before the lock', () => {
    const body = fn('hire_add_candidate');
    const member = body.indexOf(MEMBER);
    const writer = body.indexOf(WRITER);
    const firstInsert = body.indexOf('insert into');
    const lock = body.indexOf('pg_advisory_xact_lock');
    expect(member).toBeGreaterThan(-1);
    expect(writer).toBeGreaterThan(member);
    expect(firstInsert).toBeGreaterThan(writer);
    expect(lock).toBeGreaterThan(writer);
  });

  test('add: the job is checked before the candidate is written', () => {
    const body = fn('hire_add_candidate');
    const jobRead = body.indexOf('from public.hire_jobs j');
    const jobNotFound = body.indexOf("'job_not_found'");
    const jobNotOpen = body.indexOf("'job_not_open'");
    const candidateInsert = body.indexOf('insert into public.hire_candidates');
    expect(jobRead).toBeGreaterThan(-1);
    expect(jobNotFound).toBeGreaterThan(jobRead);
    expect(jobNotOpen).toBeGreaterThan(jobNotFound);
    expect(candidateInsert).toBeGreaterThan(jobNotOpen);
    expect(body).toContain('j.id = p_job_id and j.org_id = p_org_id');
  });

  test('add: shares the public form lock key, finds a person by lower email inside the workspace', () => {
    const body = fn('hire_add_candidate');
    expect(body).toContain("pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_email, 0))");
    expect(body).toContain('c.org_id = p_org_id and lower(c.email) = v_email');
    expect(body).toContain('v_email text := lower(private.hire_one_line(p_email));');
    expect(body.indexOf('c.org_id = p_org_id and lower(c.email) = v_email'))
      .toBeGreaterThan(body.indexOf('pg_advisory_xact_lock'));
  });

  test('add: an application never doubles up', () => {
    const body = fn('hire_add_candidate');
    expect(body).toContain('on conflict (candidate_id, job_id) do nothing');
    expect(body.indexOf('on conflict (candidate_id, job_id) do nothing'))
      .toBeGreaterThan(body.indexOf('insert into public.hire_applications'));
  });

  test('update: caller checks come before the row lock; the email lock before the row lock', () => {
    const body = fn('hire_update_candidate');
    const member = body.indexOf('private.is_org_member(v_org) is not true');
    const writer = body.indexOf('private.is_org_writer(v_org) is not true');
    const lock = body.indexOf('pg_advisory_xact_lock');
    const rowLock = body.indexOf('for update');
    expect(member).toBeGreaterThan(-1);
    expect(writer).toBeGreaterThan(member);
    expect(lock).toBeGreaterThan(writer);
    expect(rowLock).toBeGreaterThan(lock);
    expect(body.indexOf('update public.hire_candidates')).toBeGreaterThan(rowLock);
  });

  test('update: email_taken stays in the candidate workspace and skips the candidate itself', () => {
    const body = fn('hire_update_candidate');
    expect(body).toContain('o.org_id = v_org and o.id <> p_candidate_id and lower(o.email) = v_email');
    expect(body).toContain("'email_taken'");
    expect(body).toContain("hashtextextended(v_org::text || ':' || v_email, 0)");
  });

  test('update: an unknown key is invalid_changes, and protected columns are never set', () => {
    const body = fn('hire_update_candidate');
    expect(body).toContain("c_fields constant text[] := array['name','email','phone','headline','location','skills','source'];");
    expect(body).toContain('k.key <> all (c_fields)');
    expect(body).toContain("'invalid_changes'");
    const setStart = body.indexOf('update public.hire_candidates');
    const setClause = body.slice(setStart, body.indexOf(';', setStart));
    for (const col of ['org_id', 'pool_status', 'created_at']) {
      expect(setClause, col).not.toContain(col);
    }
  });

  test('attach: the server role only, once per application, a path built from its own workspace and job', () => {
    const body = fn('hire_attach_cv');
    expect(body).toContain("coalesce((select auth.role()), '') <> 'service_role'");
    expect(body).toContain("'already_attached'");
    expect(body).toContain("'^' || v_org::text || '/' || v_job::text");
    const lock = body.indexOf('for update');
    expect(lock).toBeGreaterThan(-1);
    expect(body.indexOf('auth.role()')).toBeLessThan(lock);
    expect(body.indexOf('update public.hire_applications')).toBeGreaterThan(lock);
    expect(body.indexOf("'invalid_path'")).toBeLessThan(body.indexOf('update public.hire_applications'));
  });

  test('grants: signed-in callers add and edit; only the server attaches', () => {
    expect(sql).toContain(`revoke execute on function public.hire_add_candidate(${ADD_ARGS}) from public, anon, service_role;`);
    expect(sql).toContain('revoke execute on function public.hire_update_candidate(uuid, jsonb) from public, anon, service_role;');
    expect(sql).toContain('revoke execute on function public.hire_attach_cv(uuid, text) from public, anon, authenticated;');
    expect(sql).toContain(`grant execute on function public.hire_add_candidate(${ADD_ARGS}) to authenticated;`);
    expect(sql).toContain('grant execute on function public.hire_update_candidate(uuid, jsonb) to authenticated;');
    expect(sql).toContain('grant execute on function public.hire_attach_cv(uuid, text) to service_role;');
  });

  test('nothing is granted to a visitor or to everyone, in any form', () => {
    expect(sql).not.toMatch(/grant\s+(execute|all)[^;]*\bto\b[^;]*\b(anon|public)\b/i);
    expect(sql).not.toMatch(/grant[^;]*\bto\b[^;]*\b(anon|public)\b/i);
  });

  test('the review hardening holds', () => {
    const live = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    const body = (name: string) => {
      const start = live.indexOf(`create or replace function public.${name}(`);
      return live.slice(start, live.indexOf('end $$;', start));
    };
    const add = body('hire_add_candidate');
    // The candidate is inserted only after the lock and after the lookup under it.
    const lock = add.indexOf('pg_advisory_xact_lock');
    const lookup = add.indexOf('c.org_id = p_org_id and lower(c.email) = v_email');
    const insert = add.indexOf('insert into public.hire_candidates');
    expect(lock).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(lookup);
    // The job is held while the application is made, and only an open or paused one takes it.
    expect(add).toContain('for share;');
    expect(add).toContain("if v_status not in ('open', 'paused') then return jsonb_build_object('word', 'job_not_open'); end if;");
    expect(add.indexOf('for share;')).toBeLessThan(lock);
    // Without a job the cover note and the CV link are dropped before anything is judged.
    expect(add.indexOf('if p_job_id is null then')).toBeLessThan(add.indexOf("'too_long'"));

    const update = body('hire_update_candidate');
    expect(update.indexOf("jsonb_typeof(p_changes) <> 'object' then")).toBeLessThan(update.indexOf('jsonb_object_keys(p_changes)'));

    const attach = body('hire_attach_cv');
    expect(attach).toContain("\\.pdf$')) is not true then");
    expect(attach).toContain('exception when unique_violation then');
    expect(attach).toContain("if v_consented is not null then return 'not_by_hand'; end if;");

    expect(sql).not.toMatch(/grant[^;]*hire_attach_cv[^;]*\b(authenticated|anon|public)\b/i);
    expect(sql).not.toMatch(/grant[^;]*hire_(add|update)_candidate[^;]*\b(service_role|anon|public)\b/i);
  });
});
