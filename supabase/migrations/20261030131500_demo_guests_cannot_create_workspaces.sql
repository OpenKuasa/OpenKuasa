-- A workspace belongs to a signed-up account, and the demo to guests.
--
-- Both membership-creating functions are granted to every signed-in session, and
-- a demo guest (an anonymous sign-in) is one. Until now neither asked which kind
-- of session was calling. From here on:
--   * create_org_for_current_user makes a workspace only for an account that has
--     signed up, and only with a real name: trimmed, not empty, at most 120
--     characters (the limit the sign-up form and the company settings form use;
--     public.orgs.name itself carries no length check);
--   * join_demo_org adds only guests to the shared demo workspace. Members of a
--     workspace can read each other's profile, so a signed-up account there
--     would show its email address to every guest.
--
-- Both read auth.users rather than the session's is_anonymous claim, which stays
-- as it was issued until the session is refreshed.
--
-- Everything else is unchanged: same signatures, same owner/viewer rows, same
-- session and second-factor checks in the same order, same grants. No existing
-- workspace or membership is touched.
--
-- KEEP IN STEP with src/lib/auth/workspace-name.ts (the length, and the messages
-- it turns into sentences); tests/demo-guests-migration.test.ts checks both.

-- Replaces the definition in 20261010130000_second_factor_remaining_gaps.sql.
create or replace function public.create_org_for_current_user(org_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
  clean_name text := regexp_replace(org_name, '^\s+|\s+$', '', 'g');
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.mfa_ok() then raise exception 'second factor required'; end if;
  if not exists (
    select 1 from auth.users where id = auth.uid() and is_anonymous is not true
  ) then
    raise exception 'demo guests cannot create a workspace';
  end if;
  if clean_name is null or clean_name = '' then
    raise exception 'workspace name required';
  end if;
  if char_length(clean_name) > 120 then
    raise exception 'workspace name too long';
  end if;
  insert into public.orgs (name) values (clean_name) returning id into new_id;
  insert into public.org_members (org_id, user_id, role)
  values (new_id, auth.uid(), 'owner');
  return new_id;
end; $$;

-- Replaces the definition in 20261010130000_second_factor_remaining_gaps.sql.
create or replace function public.join_demo_org()
returns uuid language plpgsql security definer set search_path = public as $$
declare demo_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.mfa_ok() then raise exception 'second factor required'; end if;
  if not exists (
    select 1 from auth.users where id = auth.uid() and is_anonymous is true
  ) then
    raise exception 'the demo is for guests only';
  end if;
  select id into demo_id from public.orgs where slug = 'rimba-ventures-demo';
  if demo_id is null then raise exception 'demo org missing'; end if;
  insert into public.org_members (org_id, user_id, role)
  values (demo_id, auth.uid(), 'viewer')
  on conflict (org_id, user_id) do nothing;
  return demo_id;
end; $$;

-- create or replace keeps the existing privileges; restated so this file stands
-- on its own (20261009090200_tenancy_functions_and_seed.sql and
-- 20261009090600_tighten_tenancy_grants.sql set them).
revoke all on function public.create_org_for_current_user(text) from public, anon;
grant execute on function public.create_org_for_current_user(text) to authenticated;
revoke all on function public.join_demo_org() from public, anon;
grant execute on function public.join_demo_org() to authenticated;
