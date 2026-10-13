-- Account access checks. Three independent changes to existing functions; no
-- table, column, policy or row is added, removed or rewritten.
--
--   1. accept_invite joins a workspace only for an account whose email address
--      has been confirmed.
--   2. redeem_recovery_code counts attempts one caller at a time.
--   3. Sharing the demo workspace does not make two accounts workspace-mates.
--
-- Safe to apply before the matching app release. Every statement is a
-- `create or replace` or a restated grant, so applying it twice changes nothing.

-- ---------------------------------------------------------------------------
-- 1. Invites are accepted by a confirmed email address.
--    Replaces the definition in 20261010120000_enforce_second_factor.sql
--    (lines 94-133). Two differences from it:
--      * the caller's address must be confirmed ('email not confirmed'). The
--        check comes after the address match, so a caller learns nothing new
--        about an invite that is not theirs;
--      * the activity entry no longer repeats the invited address (the member
--        is already named as its actor; the address stays in the notification
--        sent to owners and admins).
--    An account created with email confirmation switched off is confirmed at
--    sign-up, so nothing changes there.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invite(p_token uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  inv public.org_invites;
  my_email text;
  my_email_confirmed boolean;
  who text;
  org_name text;
  r record;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.mfa_ok() then raise exception 'second factor required'; end if;
  select lower(email), email_confirmed_at is not null
    into my_email, my_email_confirmed
    from auth.users where id = uid and is_anonymous is not true;
  select * into inv from public.org_invites where token = p_token for update;
  if inv.id is null then raise exception 'invite not found'; end if;
  if inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at < now() then
    raise exception 'invite no longer valid';
  end if;
  if my_email is null or my_email <> inv.email then raise exception 'invite is for another email'; end if;
  if my_email_confirmed is not true then raise exception 'email not confirmed'; end if;

  insert into public.org_members (org_id, user_id, role)
  values (inv.org_id, uid, inv.role)
  on conflict (org_id, user_id) do nothing;
  update public.org_invites set accepted_at = now() where id = inv.id;
  update public.profiles set current_org_id = inv.org_id where user_id = uid;

  who := private.display_name(uid);
  select name into org_name from public.orgs where id = inv.org_id;
  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (inv.org_id, uid, who, 'Joined the workspace as ' || inv.role, null, 'team');
  for r in
    select user_id from public.org_members
    where org_id = inv.org_id and role in ('owner','admin') and user_id <> uid
  loop
    perform private.deliver_notification(
      r.user_id, inv.org_id, 'team_activity',
      who || ' joined ' || org_name, inv.email || ' accepted their invite.', '/account/team');
  end loop;
  return inv.org_id;
end; $$;

-- create or replace keeps the existing privileges; restated so this file stands
-- on its own (20261010100000_activity_invites_notifications_avatars.sql set them).
revoke all on function public.accept_invite(uuid) from public, anon;
grant execute on function public.accept_invite(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Recovery-code attempts are counted one caller at a time.
--    Replaces the definition in 20261010110000_mfa_recovery_codes.sql
--    (lines 59-86). The one difference: a transaction-scoped advisory lock per
--    user is taken before the recent attempts are counted, so calls made at
--    the same moment for the same user queue up and each sees the attempts the
--    ones before it recorded. Five failures in fifteen minutes stays the limit.
--    The lock is released when the call's transaction ends.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_recovery_code(p_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  matched uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext('redeem_recovery_code'), hashtext(uid::text));
  if (
    select count(*) from public.mfa_recovery_attempts
    where user_id = uid and created_at > now() - interval '15 minutes'
  ) >= 5 then
    raise exception 'too many attempts';
  end if;

  select id into matched from public.mfa_recovery_codes
  where user_id = uid and used_at is null and code_hash = p_hash
  limit 1 for update;

  if matched is null then
    insert into public.mfa_recovery_attempts (user_id) values (uid);
    return false;
  end if;

  delete from auth.mfa_factors where user_id = uid;
  delete from public.mfa_recovery_codes where user_id = uid;
  delete from public.mfa_recovery_attempts where user_id = uid;
  return true;
end; $$;

revoke all on function public.redeem_recovery_code(text) from public, anon;
grant execute on function public.redeem_recovery_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The demo workspace is shared by guests who do not know each other.
--    profiles_select (20261010090000_profiles_and_org_details.sql, lines 51-53)
--    lets an account read its own profile and the profiles of the people it
--    shares a workspace with. Being in the demo workspace together no longer
--    counts as sharing one; every other workspace is unchanged, and everyone
--    still reads their own profile.
--    Replaces the definition in 20261010120000_enforce_second_factor.sql
--    (lines 44-52). The demo workspace is the one private.is_demo_org answers
--    for (20261014090000_people_core.sql, lines 8-15: slug 'rimba-ventures-demo').
--    The policy itself is not touched.
--
--    To list accounts in the demo workspace that are not guests (read-only;
--    run it as the database owner):
--
--      select m.user_id, u.email, u.email_confirmed_at, u.created_at,
--             m.role, m.created_at as joined_at
--        from public.org_members m
--        join public.orgs o on o.id = m.org_id and o.slug = 'rimba-ventures-demo'
--        join auth.users u on u.id = m.user_id
--       where u.is_anonymous is not true
--       order by m.created_at;
-- ---------------------------------------------------------------------------
create or replace function private.shares_org_with(target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select private.mfa_ok() and exists (
    select 1
    from public.org_members mine
    join public.org_members theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid() and theirs.user_id = target
      and not private.is_demo_org(mine.org_id)
  );
$$;

-- Restated from 20261010090000_profiles_and_org_details.sql (lines 48-49); anon
-- is added to the revoke, as the later helpers in this schema do.
revoke execute on function private.shares_org_with(uuid) from public, anon;
grant execute on function private.shares_org_with(uuid) to authenticated;
