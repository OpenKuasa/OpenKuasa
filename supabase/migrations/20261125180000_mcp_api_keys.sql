-- Personal API keys for the MCP server. Additive only.
--
-- A key lets an outside AI client (Cursor, Codex, Claude Code) act as the one
-- person who made it, in the one workspace it was made in, under that person's
-- own row-level security. Behind each key is a Supabase session of that
-- person: the server keeps the session's refresh token here, sealed with
-- AI_KEYS_ENCRYPTION_SECRET, and turns it into an access token when the key is
-- used. The key itself is never stored, only its SHA-256.
--
-- Who can do what:
--   * the server (service role) creates rows, looks a key up by its hash,
--     reads and rotates `session_secret`, and stamps `last_used_at`;
--   * a signed-in person sees their own keys, and owners and admins see every
--     key in their workspace. Neither ever reads `key_hash` or
--     `session_secret` (column grants), and the `mcp_api_keys_public` view
--     leaves both out;
--   * the same split may revoke, by setting `revoked_at`, and nothing else.
--     A revoke cannot be undone;
--   * leaving the workspace (an org_members row deleted) revokes that
--     person's keys in it.
--
-- Deploy order: this migration first, then the code that uses it.

create table public.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 60),
  -- SHA-256 of the key, hex. The key is shown once, when it is made.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  -- The key's session refresh token, sealed (`v2.…`). Null once revoked.
  session_secret text check (session_secret is null or session_secret like 'v2.%'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index mcp_api_keys_org_idx on public.mcp_api_keys (org_id, created_at desc);
create index mcp_api_keys_user_idx on public.mcp_api_keys (user_id, created_at desc);

-- A key stays bound to its person and workspace, and a revoke is final: once
-- revoked, its date stays and no session can be stored for it again (a refresh
-- still in flight when the key was revoked cannot bring it back).
create or replace function private.mcp_api_keys_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.user_id is distinct from old.user_id
     or new.key_hash is distinct from old.key_hash
     or new.created_at is distinct from old.created_at then
    raise exception 'an API key cannot be moved' using errcode = 'MCK01';
  end if;
  if old.revoked_at is not null then
    if new.revoked_at is distinct from old.revoked_at then
      raise exception 'this API key is already revoked' using errcode = 'MCK01';
    end if;
    if new.session_secret is not null then
      raise exception 'a revoked API key keeps no session' using errcode = 'MCK01';
    end if;
  elsif new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end $$;

create trigger mcp_api_keys_guard before update on public.mcp_api_keys
  for each row execute function private.mcp_api_keys_guard();

revoke all on function private.mcp_api_keys_guard() from public, anon, authenticated;

-- Leaving a workspace revokes the person's keys there, in the same
-- transaction, and drops their sessions' refresh tokens: a key never outlives
-- its person's membership (the guard allows this, as for any first revoke).
-- Nothing to do when the whole workspace is being deleted: its keys go with it.
create or replace function private.mcp_api_keys_on_member_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.mcp_api_keys set revoked_at = now(), session_secret = null
  where org_id = old.org_id and user_id = old.user_id and revoked_at is null
    and exists (select 1 from public.orgs o where o.id = old.org_id);
  return old;
end; $$;
revoke all on function private.mcp_api_keys_on_member_removed() from public, anon, authenticated;
create trigger mcp_api_keys_revoke_on_member_removed after delete on public.org_members
  for each row execute function private.mcp_api_keys_on_member_removed();

alter table public.mcp_api_keys enable row level security;

create policy mcp_api_keys_select on public.mcp_api_keys
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_org_admin(org_id));
create policy mcp_api_keys_revoke on public.mcp_api_keys
  for update to authenticated
  using (user_id = (select auth.uid()) or private.is_org_admin(org_id))
  with check (revoked_at is not null);
create policy mfa_required on public.mcp_api_keys as restrictive
  for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.mcp_api_keys from public, anon, authenticated;
grant select (id, org_id, user_id, name, created_at, last_used_at, revoked_at) on public.mcp_api_keys to authenticated;
grant update (revoked_at) on public.mcp_api_keys to authenticated;
-- The service role has no default privileges in this project: grant what the server uses.
grant select, insert, update, delete on public.mcp_api_keys to service_role;

-- What the Developers screen lists. It runs as the caller, so the table's RLS
-- decides which rows come back.
create view public.mcp_api_keys_public with (security_invoker = true) as
  select id, org_id, user_id, name, created_at, last_used_at, revoked_at
    from public.mcp_api_keys;

revoke all on public.mcp_api_keys_public from public, anon, authenticated;
grant select on public.mcp_api_keys_public to authenticated;
grant select on public.mcp_api_keys_public to service_role;
