import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILE = join(process.cwd(), 'supabase/migrations/20261101134500_employee_account_link.sql');
/** The migration's statements, without comment lines. */
const sql = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('employee account link migration', () => {
  const start = sql.indexOf('create or replace function private.employee_link_guard()');
  const guard = sql.slice(start, sql.indexOf('$$;', start));

  test('changes no employee record: no link is made or cleared by the file itself', () => {
    expect(sql).not.toMatch(/^\s*(update|delete|insert|truncate|alter)\b/im);
    expect(guard).not.toMatch(/\b(update public|delete from|insert into)\b/i);
  });

  test('the guard no longer fills the link from a matching email', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(guard).toContain('returns trigger language plpgsql security definer set search_path = public as $$');
    expect(guard).not.toContain('work_email');
    expect(guard).not.toMatch(/new\.user_id\s*:=/);
    expect(sql).toContain('revoke all on function private.employee_link_guard() from public, anon, authenticated;');
  });

  test('a link is made only to a workspace member with a confirmed sign-up email', () => {
    expect(guard).toContain('if new.user_id is null then return new; end if;');
    expect(guard).toContain('select 1 from public.org_members where org_id = new.org_id and user_id = new.user_id');
    expect(guard).toContain("raise exception 'that user is not a member of this workspace';");
    expect(guard).toContain('being_linked := new.user_id is distinct from old.user_id;');
    expect(guard).toContain('and u.is_anonymous is not true');
    expect(guard).toContain('and u.email_confirmed_at is not null');
    expect(guard).toContain("raise exception 'that member has not confirmed their email address';");
  });

  test('joining a workspace links nobody; leaving one still clears the link', () => {
    expect(sql).toContain('drop trigger if exists org_members_link_employee on public.org_members;');
    expect(sql).toContain('drop function if exists private.link_employee_on_member_join();');
    expect(sql).not.toContain('unlink_employee_on_member_leave');
    expect(sql).not.toContain('org_members_unlink_employee');
  });
});
