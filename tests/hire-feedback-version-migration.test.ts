// tests/hire-feedback-version-migration.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILE = '20261125090100_hire_feedback_version.sql';
const path = join(process.cwd(), 'supabase/migrations', FILE);
const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
// Comment lines are dropped so an explanation can never satisfy a check.
const sql = raw.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
const inOrder = (body: string, pieces: string[]) => {
  let last = -1;
  for (const piece of pieces) {
    const at = body.indexOf(piece, last + 1);
    expect(at, piece).toBeGreaterThan(last);
    last = at;
  }
};

describe('feedback version migration: clearing takes the version the caller saw', () => {
  test('the file is there and sorts after every migration it builds on', () => {
    expect(raw).not.toBe('');
    expect(FILE > '20261113090100_hire_interview_feedback_writes.sql').toBe(true);
  });

  test('drops the one-argument function first, so no overload is left for a one-argument call to trip on', () => {
    inOrder(sql, [
      'drop function if exists public.hire_clear_interview_feedback(uuid);',
      'create or replace function public.hire_clear_interview_feedback( p_interview_id uuid, p_if_feedback_at timestamptz default null )',
    ]);
  });

  test('keeps the house style: security definer, empty search path, membership then writer, a word back', () => {
    inOrder(sql, [
      "returns text language plpgsql security definer set search_path = '' as $$",
      'select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;',
      "if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;",
      "if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;",
      'for update;',
    ]);
  });

  test('says no_feedback before changed, and refuses a version that is not the stored one', () => {
    inOrder(sql, [
      "if v_feedback_at is null then return 'no_feedback'; end if;",
      "if p_if_feedback_at is not null and p_if_feedback_at is distinct from v_feedback_at then return 'changed'; end if;",
      'update public.hire_interviews set feedback_rating = null, feedback_recommendation = null, feedback_comments = null, feedback_at = null, updated_at = now() where id = p_interview_id;',
      "return 'ok';",
    ]);
  });

  test('is granted to authenticated only, on the new signature', () => {
    expect(sql).toContain(
      'revoke execute on function public.hire_clear_interview_feedback(uuid, timestamptz) from public, anon, service_role;',
    );
    expect(sql).toContain('grant execute on function public.hire_clear_interview_feedback(uuid, timestamptz) to authenticated;');
    expect(sql).not.toMatch(/grant execute[^;]*to (anon|public|service_role)/);
    // Only the clear function is touched: the save already takes a version.
    expect(sql).not.toContain('hire_save_interview_feedback');
  });
});
