import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { WORKSPACE_NAME_MAX } from '@/lib/auth/workspace-name';

const FILE = join(
  process.cwd(),
  'supabase/migrations/20261030131500_demo_guests_cannot_create_workspaces.sql',
);
/** The migration's statements, without comment lines. */
const sql = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/** The text of one function: from its `create or replace` to the closing `$$;`. */
function definition(signature: string): string {
  const start = sql.indexOf(`create or replace function ${signature}`);
  expect(start, `${signature} is defined`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Every part is present, in this order. */
function expectInOrder(text: string, ...parts: string[]) {
  const at = parts.map((part) => text.indexOf(part));
  for (const [i, pos] of at.entries()) expect(pos, parts[i]).toBeGreaterThanOrEqual(0);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
}

describe('demo guests cannot create workspaces migration', () => {
  const createOrg = definition('public.create_org_for_current_user(org_name text)');
  const joinDemo = definition('public.join_demo_org()');

  test('replaces exactly the two membership functions and touches no data', () => {
    expect(sql.match(/create or replace function [^\n(]+/g)).toEqual([
      'create or replace function public.create_org_for_current_user',
      'create or replace function public.join_demo_org',
    ]);
    expect(sql).not.toMatch(/\b(drop|delete|truncate|alter|update)\b/i);
  });

  test('both stay security definer functions returning uuid with a pinned search path', () => {
    for (const fn of [createOrg, joinDemo]) {
      expect(fn).toContain('returns uuid language plpgsql security definer set search_path = public as $$');
    }
  });

  test('creating a workspace checks the session, then the second factor, then for a signed-up account', () => {
    expectInOrder(
      createOrg,
      "if auth.uid() is null then raise exception 'not authenticated'; end if;",
      "if not private.mfa_ok() then raise exception 'second factor required'; end if;",
      'select 1 from auth.users where id = auth.uid() and is_anonymous is not true',
      "raise exception 'demo guests cannot create a workspace';",
      'insert into public.orgs',
    );
  });

  test('the name is trimmed, required and capped at the length the form allows', () => {
    expect(createOrg).toContain("regexp_replace(org_name, '^\\s+|\\s+$', '', 'g')");
    expectInOrder(
      createOrg,
      "raise exception 'workspace name required';",
      `if char_length(clean_name) > ${WORKSPACE_NAME_MAX} then`,
      "raise exception 'workspace name too long';",
      'insert into public.orgs (name) values (clean_name) returning id into new_id;',
    );
    expect(createOrg).not.toContain('values (org_name)');
  });

  test('the caller still becomes the owner of the new workspace', () => {
    expect(createOrg).toMatch(
      /insert into public\.org_members \(org_id, user_id, role\)\s+values \(new_id, auth\.uid\(\), 'owner'\);/,
    );
  });

  test('joining the demo checks the session, then the second factor, then for a guest session', () => {
    expectInOrder(
      joinDemo,
      "if auth.uid() is null then raise exception 'not authenticated'; end if;",
      "if not private.mfa_ok() then raise exception 'second factor required'; end if;",
      'select 1 from auth.users where id = auth.uid() and is_anonymous is true',
      "raise exception 'the demo is for guests only';",
      "select id into demo_id from public.orgs where slug = 'rimba-ventures-demo';",
      "values (demo_id, auth.uid(), 'viewer')",
    );
  });

  test('both are revoked from public and anon and granted to signed-in sessions only', () => {
    expect(sql).toContain(
      'revoke all on function public.create_org_for_current_user(text) from public, anon;',
    );
    expect(sql).toContain('revoke all on function public.join_demo_org() from public, anon;');
    expect(sql.match(/grant [^;]*;/g)).toEqual([
      'grant execute on function public.create_org_for_current_user(text) to authenticated;',
      'grant execute on function public.join_demo_org() to authenticated;',
    ]);
  });
});
