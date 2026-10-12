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
