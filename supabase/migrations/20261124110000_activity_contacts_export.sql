-- The contacts export is recorded in the activity log (issue #230).
--
-- GET /api/crm/contacts/export gives an owner or admin every contact in the
-- workspace as one CSV file. It now records 'Exported contacts' first, and
-- refuses the file when the entry cannot be written.
--
-- log_event(p_key) gains one key, contacts_exported:
--   * only an owner or admin of the caller's current workspace may record it;
--     anyone else, a viewer or a caller with no current workspace included, is
--     refused ('not allowed') rather than skipped, so the route returns no
--     file. Every other key still returns early for them, as before;
--   * the entry is 'data', for 'admins' (it says how much of the workspace's
--     data left it);
--   * its target is the number of contacts the workspace holds, counted here
--     ('1 contact', '1,234 contacts'); the caller sends no number;
--   * no notification.
--
-- Restated from 20261101133000_activity_log_events.sql (the newest text); only
-- the contacts_exported branch is new. Its grants are restated unchanged.
--
-- APPLY ORDER: apply this file, then release the app build that sends the new
-- key. Additive: every existing key behaves as before, and a build from before
-- this change never sends the new key.
--
-- Safe to apply twice.
--
-- KEEP IN STEP with src/lib/events.ts; tests/events.test.ts compares the two.

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
  v_count bigint;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  -- The contacts export is refused, not skipped, for anyone who is not an
  -- owner or admin of a current workspace: the route then returns no file.
  if p_key = 'contacts_exported' and (org is null or not private.is_org_admin(org)) then
    raise exception 'not allowed';
  end if;
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
    -- Only an owner or admin may export, so only they may say they did. The
    -- count is every contact the workspace holds, as the export reads them.
    when 'contacts_exported' then
      if not private.is_org_admin(org) then raise exception 'not allowed'; end if;
      v_action := 'Exported contacts'; v_category := 'data';
      v_audience := 'admins';
      select count(*) into v_count from public.crm_contacts where org_id = org;
      v_target := to_char(v_count, 'FM999,999,999,990')
        || case v_count when 1 then ' contact' else ' contacts' end;
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

-- Self-check: the function knows the new key, keeps its shape, and is callable
-- by signed-in users only. Otherwise everything rolls back.
do $$
declare
  f oid := to_regprocedure('public.log_event(text)');
begin
  if f is null then
    raise exception 'public.log_event(text) is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = f and p.prosecdef and p.prorettype = 'void'::regtype
       and p.proconfig @> array['search_path=public']
  ) then
    raise exception 'public.log_event(text) is not a void definer function on a fixed search path';
  end if;
  if not has_function_privilege('authenticated', f, 'execute')
     or has_function_privilege('anon', f, 'execute')
     or has_function_privilege('public', f, 'execute') then
    raise exception 'public.log_event(text) should be callable by signed-in users only';
  end if;
  if pg_get_functiondef(f) not like '%when ''contacts_exported'' then%'
     or pg_get_functiondef(f) not like '%v_action := ''Exported contacts''%'
     or pg_get_functiondef(f) not like '%if p_key = ''contacts_exported'' and (org is null or not private.is_org_admin(org)) then%' then
    raise exception 'public.log_event(text) does not know contacts_exported';
  end if;
  if to_regprocedure('public.log_event(text, text, text, text, text, text, text, text)') is not null then
    raise exception 'the earlier log_event(text x 8) is back';
  end if;
end $$;
