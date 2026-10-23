import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261125180200_mcp_oauth_bindings.sql';
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
  const start = flat.indexOf(`create policy ${name} on public.mcp_oauth_bindings`);
  expect(start, name).toBeGreaterThan(-1);
  return flat.slice(start, flat.indexOf(';', start) + 1);
};

const OWN = 'user_id = (select auth.uid())';

describe('mcp oauth bindings migration', () => {
  test('is the only file that touches the table, alone on its version', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const touching = files.filter((f) => withoutComments(readFileSync(join(DIR, f), 'utf8')).includes('mcp_oauth_bindings'));
    expect(touching).toEqual([FILE]);
    expect(files.filter((f) => f.startsWith('20261125180200'))).toEqual([FILE]);
    // It sorts after everything before it.
    expect(files[files.length - 1] >= FILE).toBe(true);
  });

  test('one row per person and client, naming the workspace they allowed it in', () => {
    expect(flat).toContain('create table public.mcp_oauth_bindings (');
    expect(flat).toContain('user_id uuid not null references auth.users(id) on delete cascade');
    expect(flat).toContain('client_id text not null check (char_length(client_id) between 1 and 200)');
    expect(flat).toContain('org_id uuid not null references public.orgs(id) on delete cascade');
    expect(flat).toContain('created_at timestamptz not null default now()');
    expect(flat).toContain('primary key (user_id, client_id)');
  });

  test('RLS: a person sees, adds and removes only their own, and adds only for a workspace they belong to', () => {
    expect(flat).toContain('alter table public.mcp_oauth_bindings enable row level security;');
    expect(policy('mcp_oauth_bindings_select')).toBe(
      `create policy mcp_oauth_bindings_select on public.mcp_oauth_bindings for select to authenticated using (${OWN});`,
    );
    expect(policy('mcp_oauth_bindings_insert')).toBe(
      `create policy mcp_oauth_bindings_insert on public.mcp_oauth_bindings for insert to authenticated with check (${OWN} and exists (select 1 from public.org_members m where m.org_id = mcp_oauth_bindings.org_id and m.user_id = (select auth.uid())));`,
    );
    expect(policy('mcp_oauth_bindings_delete')).toBe(
      `create policy mcp_oauth_bindings_delete on public.mcp_oauth_bindings for delete to authenticated using (${OWN});`,
    );
    expect(policy('mfa_required')).toBe(
      'create policy mfa_required on public.mcp_oauth_bindings as restrictive for all to authenticated using ((select private.mfa_ok())) with check ((select private.mfa_ok()));',
    );
    // No update: binding again is a delete and an insert.
    expect(flat.match(/create policy \w+ on public\.mcp_oauth_bindings/g)).toHaveLength(4);
    expect(flat).not.toMatch(/for update/);
  });

  test('grants are explicit, with no update for anyone', () => {
    expect(flat).toContain('revoke all on public.mcp_oauth_bindings from public, anon, authenticated;');
    expect(flat.match(/grant [^;]* on public\.mcp_oauth_bindings to [^;]*;/g)).toEqual([
      'grant select, insert, delete on public.mcp_oauth_bindings to authenticated;',
      // The service role has no default privileges in this project.
      'grant select, delete on public.mcp_oauth_bindings to service_role;',
    ]);
    expect(flat.indexOf('revoke all on public.mcp_oauth_bindings')).toBeLessThan(flat.indexOf('grant select, insert, delete'));
  });

  test('leaving a workspace removes the person\'s connections bound to it', () => {
    const start = flat.indexOf('create or replace function private.mcp_oauth_bindings_on_member_removed()');
    expect(start).toBeGreaterThan(-1);
    const head = flat.slice(start, flat.indexOf('$$', start));
    expect(head).toContain('returns trigger');
    expect(head).toContain('security definer');
    expect(head).toContain("set search_path = ''");
    const body = flat.slice(start, flat.indexOf('$$;', flat.indexOf('$$', start) + 2));
    expect(body).toContain(
      'delete from public.mcp_oauth_bindings where org_id = old.org_id and user_id = old.user_id and exists (select 1 from public.orgs o where o.id = old.org_id);',
    );
    expect(body).toContain('return old;');
    expect(flat).toContain(
      'create trigger mcp_oauth_bindings_on_member_removed after delete on public.org_members for each row execute function private.mcp_oauth_bindings_on_member_removed();',
    );
    expect(flat).toContain('revoke all on function private.mcp_oauth_bindings_on_member_removed() from public, anon, authenticated;');
    expect(flat.indexOf('create table public.mcp_oauth_bindings (')).toBeLessThan(start);
  });
});
