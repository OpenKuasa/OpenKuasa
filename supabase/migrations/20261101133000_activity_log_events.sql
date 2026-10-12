-- The activity log and in-app notifications are written by the database from a
-- fixed list of events, and entries that carry an email address are for owners
-- and admins.
--
--   1. activity_log gains an `audience` ('members' | 'admins'). Members read the
--      'members' entries, owners and admins read everything, and everyone reads
--      the entries they made themselves.
--   2. create_invite and revoke_invite write their entries for 'admins' (the
--      target of those entries is the invited address; org_invites is already
--      owner/admin-only). Existing entries of that kind are moved to 'admins'.
--   3. log_event takes an event key. The sentence, category, target and any
--      notification are built here; the caller supplies no text.
--   4. crm_audit_logs is no longer insertable by a signed-in session.
--
-- APPLY ORDER: apply this file, then release the app build that calls
-- log_event(p_key). The earlier log_event(text x 8) is removed here, so a build
-- from before this change records no app-side activity entries until it is
-- replaced (its calls fail quietly; nothing a user does is blocked by that).
-- Entries written by the database itself (invites, roles, workspace AI key) are
-- unaffected in either order.
--
-- Safe to apply twice.

-- ---------------------------------------------------------------------------
-- 1. Who an entry is for.
-- ---------------------------------------------------------------------------
alter table public.activity_log
  add column if not exists audience text not null default 'members'
    check (audience in ('members','admins'));

-- Replaces activity_log_select from
-- 20261010100000_activity_invites_notifications_avatars.sql (lines 56-57). The
-- restrictive mfa_required policy on this table
-- (20261010120000_enforce_second_factor.sql, lines 77-79) is not touched.
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (
    private.is_org_member(org_id)
    and (
      audience = 'members'
      or actor_id = (select auth.uid())
      or private.is_org_admin(org_id)
    )
  );

-- Still read-only for clients (restated; the new column is covered by the
-- table-level select).
revoke all on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;

-- Entries already written whose target is an email address.
update public.activity_log
   set audience = 'admins'
 where audience = 'members'
   and (
     action like 'Invited a member as %'
     or action = 'Revoked an invite'
     or (action like 'Joined the workspace as %' and target is not null)
     or action = 'Requested an email change'
   );

-- ---------------------------------------------------------------------------
-- 2. Invite entries are written for owners and admins.
--    Both functions are the definitions in
--    20261010100000_activity_invites_notifications_avatars.sql (create_invite:
--    lines 173-201, revoke_invite: lines 203-216) with one difference each: the
--    activity entry is written with audience 'admins'.
-- ---------------------------------------------------------------------------
create or replace function public.create_invite(p_email text, p_role text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  org uuid;
  addr text := lower(trim(p_email));
  new_token uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  if org is null or not private.is_org_admin(org) then raise exception 'not allowed'; end if;
  if p_role not in ('admin','member','viewer') then raise exception 'invalid role'; end if;
  if addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  if exists (
    select 1 from public.org_members m
    join public.profiles p on p.user_id = m.user_id
    where m.org_id = org and lower(p.email) = addr
  ) then raise exception 'already a member'; end if;

  update public.org_invites set revoked_at = now()
  where org_id = org and email = addr and accepted_at is null and revoked_at is null;

  insert into public.org_invites (org_id, email, role, invited_by)
  values (org, addr, p_role, uid) returning token into new_token;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (org, uid, private.display_name(uid), 'Invited a member as ' || p_role, addr, 'team', 'admins');
  return new_token;
end; $$;

create or replace function public.revoke_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.org_invites;
begin
  select * into inv from public.org_invites where id = p_invite;
  if inv.id is null or not private.is_org_admin(inv.org_id) then raise exception 'not allowed'; end if;
  update public.org_invites set revoked_at = now()
  where id = p_invite and accepted_at is null and revoked_at is null;
  if found then
    insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
    values (inv.org_id, auth.uid(), private.display_name(auth.uid()), 'Revoked an invite', inv.email, 'team', 'admins');
  end if;
end; $$;

revoke all on function public.create_invite(text, text) from public, anon;
revoke all on function public.revoke_invite(uuid) from public, anon;
grant execute on function public.create_invite(text, text) to authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. log_event(p_key): one entry for the caller's current workspace, from a
--    fixed list. Replaces log_event(text x 8) from
--    20261010100000_activity_invites_notifications_avatars.sql (lines 108-147).
--
--    Kept from it: the caller must be signed in; nothing is written for a
--    caller with no current workspace or for a viewer (which includes demo
--    guests); a session that still owes a second-factor code has no current
--    workspace (private.current_org).
--
--    Different:
--      * the caller names an event and supplies nothing else. An unknown key is
--        refused ('unknown event');
--      * a target, where the event has one, is read from the database: the
--        workspace's name, or the address the caller's own pending email change
--        is going to;
--      * a notification, where the event has one, goes only to the caller, with
--        the fixed title, text and link below. There is no fan-out to owners
--        and admins from this function any more (the app never used it);
--      * the two-factor events are written only when the caller's account is in
--        the state the event describes.
--
--    The 'security' entries listed here describe things the caller did to their
--    own sign-in (password, two-factor, email, sessions); Supabase Auth performs
--    those, so the app is where they are observed. Workspace-level security
--    entries (roles, invites, the workspace AI key) are written only by the
--    functions that make those changes.
--
--    KEEP IN STEP with src/lib/events.ts; tests/events.test.ts compares the two.
-- ---------------------------------------------------------------------------
drop function if exists public.log_event(text, text, text, text, text, text, text, text);

create or replace function public.log_event(p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  org uuid;
  v_action text;
  v_category text;
  v_target text;
  v_audience text := 'members';
  v_title text;
  v_body text;
  v_href text;
  two_factor_on boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  if org is null then return; end if;
  if not exists (
    select 1 from public.org_members
    where org_id = org and user_id = uid and role <> 'viewer'
  ) then return; end if;

  two_factor_on := exists (
    select 1 from auth.mfa_factors where user_id = uid and status = 'verified'
  );

  case p_key
    when 'signed_in' then
      v_action := 'Signed in'; v_category := 'auth';
    when 'workspace_created' then
      v_action := 'Created the workspace'; v_category := 'team';
      select name into v_target from public.orgs where id = org;
    when 'profile_updated' then
      v_action := 'Updated their profile'; v_category := 'data';
    when 'profile_photo_updated' then
      v_action := 'Updated their profile photo'; v_category := 'data';
    when 'profile_photo_removed' then
      v_action := 'Removed their profile photo'; v_category := 'data';
    when 'company_updated' then
      v_action := 'Updated company details'; v_category := 'data';
      select name into v_target from public.orgs where id = org;
    when 'notification_prefs_updated' then
      v_action := 'Updated notification preferences'; v_category := 'data';
    when 'password_changed' then
      v_action := 'Changed password'; v_category := 'security';
      v_title := 'Your password was changed';
      v_body := 'If this was not you, reset your password now.';
      v_href := '/account/security';
    when 'password_reset' then
      v_action := 'Reset password by email'; v_category := 'security';
      v_title := 'Your password was reset';
      v_href := '/account/security';
    when 'other_sessions_signed_out' then
      v_action := 'Signed out other devices'; v_category := 'security';
    when 'email_change_requested' then
      v_action := 'Requested an email change'; v_category := 'security';
      v_audience := 'admins';
      select nullif(lower(email_change), '') into v_target from auth.users where id = uid;
      v_title := 'Email change requested';
      v_body := 'Confirm it from the link sent to ' || coalesce(v_target, 'your new address');
      v_href := '/account/profile';
    when 'mfa_enabled' then
      if not two_factor_on then return; end if;
      v_action := 'Turned on two-factor authentication'; v_category := 'security';
      v_title := 'Two-factor authentication is on';
      v_body := 'You will be asked for a code from your authenticator app when you sign in.';
      v_href := '/account/security';
    when 'mfa_disabled' then
      if two_factor_on then return; end if;
      v_action := 'Turned off two-factor authentication'; v_category := 'security';
      v_title := 'Two-factor authentication was turned off';
      v_body := 'If this was not you, change your password and turn it back on.';
      v_href := '/account/security';
    when 'recovery_codes_regenerated' then
      if not two_factor_on then return; end if;
      v_action := 'Regenerated recovery codes'; v_category := 'security';
    when 'recovery_code_sign_in' then
      if two_factor_on then return; end if;
      v_action := 'Signed in with a recovery code'; v_category := 'security';
      v_title := 'A recovery code was used to sign in';
      v_body := 'Two-factor authentication is now off. Set it up again to stay protected.';
      v_href := '/account/security';
    else
      raise exception 'unknown event';
  end case;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (org, uid, private.display_name(uid), v_action, left(v_target, 200), v_category, v_audience);

  -- Every notification from here describes the caller's own sign-in, so it is
  -- delivered as 'security' (always delivered) and only to the caller.
  if v_title is not null then
    perform private.deliver_notification(uid, org, 'security', v_title, v_body, v_href);
  end if;
end; $$;

revoke all on function public.log_event(text) from public, anon;
grant execute on function public.log_event(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. crm_audit_logs is written by the database only.
--    Nothing in the app inserts into it. Its insert policy
--    (20261011100000_kasturi_crm_schema.sql, lines 235-237) and the matching
--    table privilege (same file, line 255) are removed, so its rows can only
--    come from a trigger or a security-definer function. Reading is unchanged:
--    crm_audit_logs_select and its restrictive mfa_required policy stay.
-- ---------------------------------------------------------------------------
drop policy if exists crm_audit_logs_insert on public.crm_audit_logs;
revoke all on public.crm_audit_logs from anon, authenticated;
grant select on public.crm_audit_logs to authenticated;
