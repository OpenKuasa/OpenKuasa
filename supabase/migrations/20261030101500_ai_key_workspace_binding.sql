-- Workspace AI keys: bind each stored key to its workspace and keep the sealed
-- value on the server.
--
-- The app now seals a workspace's OpenRouter key in a `v2` format that
-- authenticates the workspace id together with the key, so a stored value only
-- opens for the workspace it was sealed for. The database cannot check a seal,
-- so this migration makes the server the only reader and the only writer of
-- `org_ai_keys.ciphertext`:
--
--   * `org_ai_key_ciphertext()` is no longer callable by signed-in sessions.
--     The chat route reads the sealed value with the service-role client, for
--     the workspace of the verified session.
--   * `set_org_ai_key` becomes a service-role-only function. The server action
--     checks the caller (owner/admin, second factor passed), seals the key for
--     the caller's workspace and stores it; the function re-checks that the
--     acting user is an owner or admin of that workspace.
--   * Only `v2` values can be stored from now on. Rows already holding the
--     earlier `v1` format stay readable and are re-sealed by the server the
--     first time they are opened (chat, or an agent run).
--
-- APPLY AFTER the app release that reads keys on the server is live. The
-- previous release calls `org_ai_key_ciphertext()` and the two-argument
-- `set_org_ai_key` as the signed-in user; both stop working once this runs.
-- Between that release and this migration, chat and agent runs work as before;
-- saving a new key fails (the server-only function does not exist yet) and
-- earlier-format keys are not yet re-sealed (no UPDATE grant yet), so apply
-- this soon after the release.
--
-- Unchanged: `org_ai_key_status()` (members see whether a key is set and its
-- last four characters) and `clear_org_ai_key()` (owner/admin, as the caller).

-- ---------------------------------------------------------------------------
-- 1. The sealed value is no longer readable through the data API.
--    The function is kept (not dropped) so that rolling the app back is a
--    single grant; it can be dropped with the v1 fallback.
-- ---------------------------------------------------------------------------
revoke all on function public.org_ai_key_ciphertext() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Storing a key is a server-only operation.
--    The earlier signature took whatever sealed text the caller sent; it is
--    removed so no grant to `authenticated` survives on an old overload.
-- ---------------------------------------------------------------------------
drop function if exists public.set_org_ai_key(text, text);

-- `p_org` and `p_actor` are supplied by the server from the verified session
-- (never from request input). `p_ciphertext` was sealed by the server for
-- `p_org`. The membership check here is a second line behind the server
-- action's own check; the second-factor requirement is enforced where the
-- session is, by the `mfa_required` policies the action's role lookup reads
-- through.
create or replace function public.set_org_ai_key(
  p_org uuid,
  p_actor uuid,
  p_ciphertext text,
  p_hint text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'not allowed';
  end if;
  if p_org is null or p_actor is null or not exists (
    select 1 from public.org_members m
     where m.org_id = p_org and m.user_id = p_actor and m.role in ('owner', 'admin')
  ) then
    raise exception 'not allowed';
  end if;
  -- v2.<12-byte iv>.<16-byte tag>.<ciphertext>, base64url parts.
  if (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{1,1900}$') is not true
     or (p_hint ~ '^sk-or-…[A-Za-z0-9_-]{4}$') is not true then
    raise exception 'invalid key';
  end if;

  insert into public.org_ai_keys (org_id, ciphertext, key_hint, updated_by, updated_at)
  values (p_org, p_ciphertext, p_hint, p_actor, now())
  on conflict (org_id) do update
    set ciphertext = excluded.ciphertext,
        key_hint = excluded.key_hint,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (p_org, p_actor, private.display_name(p_actor), 'Set the workspace AI key', p_hint, 'security');
end; $$;

revoke all on function public.set_org_ai_key(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_org_ai_key(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Re-sealing an earlier-format key on first use.
--    `service_role` has no default DML in this project and holds only SELECT
--    on this table (20261015100000_agent_service_role_grants.sql). The server
--    replaces a `v1` value with its `v2` re-seal, so it needs UPDATE on that
--    one column and nothing else: no INSERT, no DELETE, no other column.
-- ---------------------------------------------------------------------------
grant update (ciphertext) on public.org_ai_keys to service_role;

-- ---------------------------------------------------------------------------
-- 4. Nothing but the bound format can be written from here on, by any role.
--    Existing `v1` rows are left in place: a row can move from v1 to v2 but
--    never the other way. A trigger on writes to `ciphertext` is used rather
--    than a CHECK constraint, because a constraint is re-checked on every
--    update of the row, including the `updated_by` reset when the user who
--    saved a `v1` key is deleted, and would make that delete fail. Once no
--    `v1` row is left this can become a plain CHECK (ciphertext like 'v2.%').
-- ---------------------------------------------------------------------------
create or replace function private.org_ai_keys_bound_format()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.ciphertext not like 'v2.%' then
    raise exception 'invalid key';
  end if;
  return new;
end; $$;
revoke all on function private.org_ai_keys_bound_format() from public, anon, authenticated;

drop trigger if exists org_ai_keys_bound_format on public.org_ai_keys;
create trigger org_ai_keys_bound_format
  before insert or update of ciphertext on public.org_ai_keys
  for each row execute function private.org_ai_keys_bound_format();
