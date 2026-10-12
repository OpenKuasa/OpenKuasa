import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILE = join(process.cwd(), 'supabase/migrations/20261101131500_account_access_checks.sql');
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

describe('account access checks migration', () => {
  test('replaces functions only: no table, column or policy is added or removed', () => {
    expect(sql).not.toMatch(/\b(drop|truncate|alter|create table|create policy)\b/i);
  });

  test('an invite is accepted only by its own, confirmed address, after the second factor', () => {
    const accept = definition('public.accept_invite(p_token uuid)');
    expect(accept).toContain('returns uuid language plpgsql security definer set search_path = public as $$');
    expectInOrder(
      accept,
      "if uid is null then raise exception 'not authenticated'; end if;",
      "if not private.mfa_ok() then raise exception 'second factor required'; end if;",
      'from auth.users where id = uid and is_anonymous is not true;',
      'where token = p_token for update;',
      "raise exception 'invite no longer valid';",
      "if my_email is null or my_email <> inv.email then raise exception 'invite is for another email'; end if;",
      "if my_email_confirmed is not true then raise exception 'email not confirmed'; end if;",
      'insert into public.org_members',
    );
    expect(accept).toContain('email_confirmed_at is not null');
    // The activity entry does not carry the invited address.
    expect(accept).toContain("'Joined the workspace as ' || inv.role, null, 'team'");
    expect(sql).toContain('revoke all on function public.accept_invite(uuid) from public, anon;');
    expect(sql).toContain('grant execute on function public.accept_invite(uuid) to authenticated;');
  });

  test('recovery-code attempts are counted under a per-user lock', () => {
    const redeem = definition('public.redeem_recovery_code(p_hash text)');
    expect(redeem).toContain('returns boolean language plpgsql security definer set search_path = public as $$');
    expectInOrder(
      redeem,
      "if uid is null then raise exception 'not authenticated'; end if;",
      "perform pg_advisory_xact_lock(hashtext('redeem_recovery_code'), hashtext(uid::text));",
      'select count(*) from public.mfa_recovery_attempts',
      ") >= 5 then",
      "raise exception 'too many attempts';",
      'insert into public.mfa_recovery_attempts (user_id) values (uid);',
      'delete from auth.mfa_factors where user_id = uid;',
    );
    expect(sql).toContain('revoke all on function public.redeem_recovery_code(text) from public, anon;');
    expect(sql).toContain('grant execute on function public.redeem_recovery_code(text) to authenticated;');
  });

  test('sharing the demo workspace does not open another account\'s profile', () => {
    const shares = definition('private.shares_org_with(target uuid)');
    expect(shares).toContain('returns boolean language sql security definer stable set search_path = public as $$');
    expectInOrder(
      shares,
      'select private.mfa_ok() and exists (',
      'join public.org_members theirs on theirs.org_id = mine.org_id',
      'where mine.user_id = auth.uid() and theirs.user_id = target',
      'and not private.is_demo_org(mine.org_id)',
    );
    expect(sql).toContain('revoke execute on function private.shares_org_with(uuid) from public, anon;');
    expect(sql).toContain('grant execute on function private.shares_org_with(uuid) to authenticated;');
  });
});
