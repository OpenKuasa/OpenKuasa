-- Workspace AI keys: saving a key failed for every key. This makes the format
-- check in public.set_org_ai_key one the database can run.
--
-- What broke. 20261030101500_ai_key_workspace_binding.sql checks the sealed
-- value with
--
--     p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{1,1900}$'
--
-- A PostgreSQL regular expression takes no repetition bound above 255
-- (DUPMAX), so `{1,1900}` is not a long match but an error: the pattern is
-- compiled when the line runs and raises 2201B "invalid regular expression:
-- invalid repetition count(s)". The membership check comes first, so an owner
-- or admin saving any key got that error, which the server action shows as
-- "Could not save the key". Nothing was stored and nothing wrong was stored;
-- keys saved before that migration were not touched (chat and agents read and
-- re-seal them without this function).
--
-- What changes. One condition, in one function. The last part of the sealed
-- value is matched with `+`, and its size is bounded by the length of the
-- whole value instead:
--
--     (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$') is not true
--     or length(p_ciphertext) > 2000
--
-- Where 2000 comes from. It is the ceiling the first version of this function
-- had (20261010140000_byok_ai_keys.sql: `length(p_ciphertext) not between 20
-- and 2000`), and it is a little above what the broken pattern was written to
-- allow (3 + 16 + 1 + 22 + 1 + 1900 = 1943 characters). The app never comes
-- near it: src/lib/ai/key-crypto.ts accepts a key of at most 306 characters
-- (`sk-or-` and up to 300 more, all single-byte), AES-256-GCM seals it to the
-- same number of bytes, and 306 bytes are 408 base64url characters, so the
-- longest value the app can send is 3 + 16 + 1 + 22 + 1 + 408 = 451
-- characters. tests/ai-key-format-migration.test.ts seals such a key and
-- checks it against the pattern and the ceiling here, so the two stay in step.
--
-- Everything else in the function is the text of 20261030101500, which no
-- later migration replaced: the same arguments, language, `security definer`,
-- empty `search_path`, checks in the same order, the same two writes.
--
-- Safe with the deployed app, in either order. The app already calls this
-- function with these four arguments (src/app/account/ai/actions.ts); no
-- signature, grant, table or other function changes, and every value the old
-- check was meant to accept is accepted. Before this is applied saving a key
-- fails as it does today; after, it works. Nothing needs to be released first.
--
-- No other migration has this fault: this is the only quantifier above 255 in
-- a regular expression anywhere in supabase/migrations (the same test file
-- checks the newest definition of every function, so a new one fails there).

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
  -- v2.<12-byte iv>.<16-byte tag>.<ciphertext>, base64url parts. No bound in
  -- the pattern may pass 255, so the size is capped on the whole value.
  if (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$') is not true
     or length(p_ciphertext) > 2000
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

-- As 20261030101500 left them. `create or replace` keeps a function's grants;
-- they are stated again so this file says on its own who may call it.
revoke all on function public.set_org_ai_key(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_org_ai_key(uuid, uuid, text, text) to service_role;
