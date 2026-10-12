// tests/hire-deletions-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');
const raw = read('20261028093000_hire_deletions.sql');
// Comment lines are dropped so an explanation can never satisfy an order check.
const sql = raw.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf('end $$;', start);
  expect(end, name).toBeGreaterThan(start);
  return sql.slice(start, end);
};

const FUNCTIONS = ['hire_delete_application', 'hire_delete_candidate'] as const;
const MEMBER = 'private.is_org_member(v_org) is not true';
const WRITER = 'private.is_org_writer(v_org) is not true';
const NOT_FOUND_AFTER_LOCK = "if not found then return jsonb_build_object('word', 'not_found'); end if;";
const LOCK_KEY = "pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_email, 0))";

describe('hire deletions migration', () => {
  test('changes no table, column, trigger, policy or table grant', () => {
    expect(sql).not.toMatch(/alter table|create table|drop table/i);
    expect(sql).not.toMatch(/create policy|drop policy|create trigger|drop trigger/i);
    expect(sql).not.toMatch(/grant[^;]*\bon\s+(table\s+)?(public\.)?hire_/i);
    expect(sql).not.toMatch(/\bstorage\./i);
  });

  test.each(FUNCTIONS)('%s is security definer with an empty search path, answers jsonb and never raises', (name) => {
    const body = fn(name);
    expect(body).toContain('returns jsonb');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).not.toMatch(/\braise\b/i);
    expect(body).not.toMatch(/\bexception\b/i);
  });

  test.each(FUNCTIONS)('%s checks the member, then the writer, before any lock, count or delete', (name) => {
    const body = fn(name);
    const member = body.indexOf(MEMBER);
    const writer = body.indexOf(WRITER);
    expect(member).toBeGreaterThan(-1);
    expect(writer).toBeGreaterThan(member);
    for (const later of ['for update', 'pg_advisory_xact_lock', 'count(', 'delete from']) {
      const at = body.indexOf(later);
      if (later === 'pg_advisory_xact_lock' && name === 'hire_delete_application') {
        expect(at, later).toBe(-1);
      } else {
        expect(at, later).toBeGreaterThan(writer);
      }
    }
    // A stranger and a missing row read the same; a viewer of the workspace is told apart.
    expect(body.slice(member, writer)).toContain("jsonb_build_object('word', 'not_found')");
    expect(body.slice(writer, body.indexOf('for update'))).toContain("jsonb_build_object('word', 'forbidden')");
  });

  test('application: locks the row, answers not_found if it has gone, counts before deleting, deletes that one row', () => {
    const body = fn('hire_delete_application');
    const rowLock = body.indexOf('for update');
    const gone = body.indexOf(NOT_FOUND_AFTER_LOCK);
    const interviews = body.indexOf('from public.hire_interviews i where i.application_id = p_application_id');
    const del = body.indexOf('delete from public.hire_applications where id = p_application_id;');
    expect(gone).toBeGreaterThan(rowLock);
    expect(interviews).toBeGreaterThan(gone);
    expect(del).toBeGreaterThan(interviews);
    // The candidate is never touched here.
    expect(body).not.toContain('delete from public.hire_candidates');
    expect(body.match(/delete from/g)).toHaveLength(1);
  });

  test('candidate: the email lock is the public form\'s, and is taken before the row lock', () => {
    const body = fn('hire_delete_candidate');
    const lock = body.indexOf(LOCK_KEY);
    const rowLock = body.indexOf('for update');
    expect(lock).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(lock);
    expect(body).toContain('if v_email is not null then');
    expect(body).toContain('lower(c.email)');
    // The same key, letter for letter, as the two functions that find a candidate by email.
    const key = "hashtextextended(p_org_id::text || ':' || v_email, 0)";
    expect(read('20261019090000_hire_cv_upload.sql')).toContain(key);
    expect(read('20261026090000_hire_candidate_changes.sql')).toContain(key);
  });

  test('candidate: an email edited between the read and the lock answers changed and deletes nothing', () => {
    const body = fn('hire_delete_candidate');
    const rowLock = body.indexOf('for update');
    const gone = body.indexOf(NOT_FOUND_AFTER_LOCK);
    const changed = body.indexOf('if v_locked_email is distinct from v_email then');
    const del = body.indexOf('delete from');
    expect(gone).toBeGreaterThan(rowLock);
    expect(changed).toBeGreaterThan(gone);
    expect(body.slice(changed, changed + 120)).toContain("jsonb_build_object('word', 'changed')");
    expect(del).toBeGreaterThan(changed);
    // No second advisory lock after the row lock: that order could deadlock with an edit.
    expect(body.match(/pg_advisory_xact_lock/g)).toHaveLength(1);
  });

  test('candidate: locks the applications, counts them, their files and their interviews, then deletes the candidate only', () => {
    const body = fn('hire_delete_candidate');
    const rowLock = body.indexOf('for update');
    const appsLock = body.indexOf('for update', rowLock + 1);
    const counted = body.indexOf('count(a.cv_path)');
    const interviews = body.indexOf('from public.hire_interviews i where i.application_id = any(v_ids)');
    const del = body.indexOf('delete from public.hire_candidates where id = p_candidate_id;');
    expect(body.slice(rowLock, appsLock)).toContain('from public.hire_applications a where a.candidate_id = p_candidate_id');
    expect(counted).toBeGreaterThan(appsLock);
    expect(interviews).toBeGreaterThan(counted);
    expect(del).toBeGreaterThan(interviews);
    // The applications go by the cascade, so the trigger that queues each CV file fires for every one.
    expect(body).not.toContain('delete from public.hire_applications');
    expect(body.match(/delete from/g)).toHaveLength(1);
  });

  test.each(FUNCTIONS)('%s answers ok with the name and the three counts', (name) => {
    const body = fn(name);
    const answer = body.slice(body.lastIndexOf("'word', 'ok'"));
    for (const key of ["'name'", "'applications'", "'interviews'", "'cv_files'"]) expect(answer, key).toContain(key);
    if (name === 'hire_delete_application') expect(answer).toContain("'job'");
  });

  test('both are for signed-in members only', () => {
    for (const name of FUNCTIONS) {
      expect(sql).toContain(`revoke execute on function public.${name}(uuid) from public, anon, service_role;`);
      expect(sql).toContain(`grant execute on function public.${name}(uuid) to authenticated;`);
    }
    expect(sql.match(/grant execute/g)).toHaveLength(2);
    expect(sql).not.toMatch(/grant execute[^;]*to[^;]*\b(anon|service_role|public)\b/i);
  });
});
