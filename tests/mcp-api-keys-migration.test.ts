import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261125180000_mcp_api_keys.sql';
const sql = readFileSync(join(DIR, FILE), 'utf8');
// Comments explain; only the statements are checked.
const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
const code = withoutComments(sql);
const flat = code.replace(/\s+/g, ' ');

const policy = (name: string) => {
  const start = flat.indexOf(`create policy ${name} on public.mcp_api_keys`);
  expect(start, name).toBeGreaterThan(-1);
  return flat.slice(start, flat.indexOf(';', start) + 1);
};

describe('mcp api keys migration', () => {
  test('is the only file that touches the table, alone on its version', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const touching = files.filter((f) => withoutComments(readFileSync(join(DIR, f), 'utf8')).includes('mcp_api_keys'));
    expect(touching).toEqual([FILE]);
    expect(files.filter((f) => f.startsWith('20261125180000'))).toEqual([FILE]);
  });

  test('the table keeps a hash, never a key, and a sealed refresh token', () => {
    expect(flat).toContain('create table public.mcp_api_keys (');
    expect(flat).toMatch(/key_hash text not null unique check \(key_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(flat).toMatch(/name text not null check \(name = btrim\(name\) and char_length\(name\) between 1 and 60\)/);
    expect(flat).toMatch(/session_secret text check \(session_secret is null or session_secret like 'v2\.%'\)/);
    expect(flat).toContain('org_id uuid not null references public.orgs(id) on delete cascade');
    expect(flat).toContain('user_id uuid not null references auth.users(id) on delete cascade');
  });

  test('RLS is on: a person sees and revokes their own keys; owners and admins those of their workspace', () => {
    expect(flat).toContain('alter table public.mcp_api_keys enable row level security;');
    const who = '(user_id = (select auth.uid()) or private.is_org_admin(org_id))';
    expect(policy('mcp_api_keys_select')).toBe(`create policy mcp_api_keys_select on public.mcp_api_keys for select to authenticated using ${who};`);
    // Revoking is the only update, and it can never be undone.
    expect(policy('mcp_api_keys_revoke')).toBe(
      `create policy mcp_api_keys_revoke on public.mcp_api_keys for update to authenticated using ${who} with check (revoked_at is not null);`,
    );
    expect(policy('mfa_required')).toBe(
      'create policy mfa_required on public.mcp_api_keys as restrictive for all to authenticated using ((select private.mfa_ok())) with check ((select private.mfa_ok()));',
    );
    // No insert or delete policy: those are the server's alone.
    expect(flat.match(/create policy \w+ on public\.mcp_api_keys/g)).toHaveLength(3);
  });

  test('a signed-in person can never read the hash or the session secret', () => {
    expect(flat).toContain('revoke all on public.mcp_api_keys from public, anon, authenticated;');
    const grants = flat.match(/grant [^;]* on public\.mcp_api_keys to authenticated;/g) ?? [];
    expect(grants).toEqual([
      'grant select (id, org_id, user_id, name, created_at, last_used_at, revoked_at) on public.mcp_api_keys to authenticated;',
      'grant update (revoked_at) on public.mcp_api_keys to authenticated;',
    ]);
    for (const g of grants) {
      expect(g).not.toContain('session_secret');
      expect(g).not.toContain('key_hash');
    }
    // The view runs as the caller, so the table's RLS applies through it, and it leaves both columns out.
    const view = flat.slice(flat.indexOf('create view public.mcp_api_keys_public'), flat.indexOf(';', flat.indexOf('create view public.mcp_api_keys_public')));
    expect(view).toContain('with (security_invoker = true)');
    expect(view).not.toContain('session_secret');
    expect(view).not.toContain('key_hash');
    expect(view).not.toContain('*');
    expect(flat).toContain('revoke all on public.mcp_api_keys_public from public, anon;');
    expect(flat).toContain('grant select on public.mcp_api_keys_public to authenticated;');
  });

  test('the service role is granted what the server uses, explicitly', () => {
    expect(flat).toContain('grant select, insert, update, delete on public.mcp_api_keys to service_role;');
  });

  test('a guard keeps a key bound to its person and workspace, and a revoke final', () => {
    const start = flat.indexOf('create or replace function private.mcp_api_keys_guard()');
    expect(start).toBeGreaterThan(-1);
    const body = flat.slice(start, flat.indexOf('$$;', start));
    expect(body).toContain("set search_path = ''");
    expect(body).toMatch(/new\.org_id is distinct from old\.org_id/);
    expect(body).toMatch(/new\.user_id is distinct from old\.user_id/);
    expect(body).toMatch(/new\.key_hash is distinct from old\.key_hash/);
    // Once revoked, the date stays and no session can be stored again.
    expect(body).toMatch(/if old\.revoked_at is not null then/);
    expect(body).toMatch(/new\.session_secret is not null/);
    // A revoke is stamped by the database, not by the caller.
    expect(body).toContain('new.revoked_at := now();');
    expect(flat).toMatch(/create trigger mcp_api_keys_guard before update on public\.mcp_api_keys for each row execute function private\.mcp_api_keys_guard\(\);/);
    expect(flat).toContain('revoke all on function private.mcp_api_keys_guard() from public, anon, authenticated;');
  });
});
