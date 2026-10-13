import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TEST_EMAIL_SQL_PATTERN } from './helpers/live-workspaces';

const FILE = join(process.cwd(), 'supabase/migrations/20261019100000_delete_test_org.sql');
/** The migration's statements, without comment lines. */
const sql = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('delete_test_org migration', () => {
  test('is a security definer function with a pinned search path', () => {
    expect(sql).toMatch(/create or replace function public\.delete_test_org\(p_id uuid\)/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/set search_path = public/);
  });

  test('is revoked from public, anon and authenticated and granted to service_role only', () => {
    expect(sql).toMatch(
      /revoke all on function public\.delete_test_org\(uuid\) from public, anon, authenticated;/,
    );
    const grants = sql.match(/grant [^;]*;/g) ?? [];
    expect(grants).toEqual(['grant execute on function public.delete_test_org(uuid) to service_role;']);
  });

  test('grants nothing on public.orgs', () => {
    expect(sql).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.orgs/i);
  });

  test('only deletes a slugless, recent workspace with no real member', () => {
    expect(sql).toMatch(/o\.slug is null/);
    expect(sql).toMatch(/interval '2 hours'/);
    expect(sql).toMatch(/is_anonymous/);
  });

  test('keeps the not-exists member clause and the negated email match', () => {
    expect(sql).toMatch(/and not exists \(/);
    expect(sql).toMatch(/coalesce\(u.is_anonymous, false\) = false/);
    expect(sql).toContain("coalesce(u.email, '') !~ '");
  });

  test('uses the same test sign-up pattern as the helper', () => {
    expect(TEST_EMAIL_SQL_PATTERN).toBeTruthy();
    expect(sql).toContain(`'${TEST_EMAIL_SQL_PATTERN}'`);
  });
});
