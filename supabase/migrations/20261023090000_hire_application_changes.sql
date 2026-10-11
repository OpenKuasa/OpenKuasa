-- supabase/migrations/20261023090000_hire_application_changes.sql
-- Lekir slice 3a: a recruiter can move, close, reopen and rate an application.
-- Four functions are the only way: members get no write on the table, so the
-- rules below hold for the screens, for Lekir and for a direct call alike.

alter table public.hire_applications
  add column reject_reason text
    check (reject_reason in ('skills','experience','salary','role_filled','not_reachable','other')),
  add constraint hire_applications_reason_when_closed
    check (outcome <> 'active' or reject_reason is null);

-- ---------------------------------------------------------------------------
-- Move to another stage: forward to any later one, or back by exactly one.
-- The offer date is set exactly while the stage is offer or hired, and the
-- hire date exactly while it is hired.
-- ---------------------------------------------------------------------------
create or replace function public.hire_move_application(p_application_id uuid, p_stage text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c_stages constant text[] := array['applied','screening','interview','offer','hired'];
  v_org uuid;
  v_stage text;
  v_outcome text;
  v_offered timestamptz;
  v_hired timestamptz;
  v_from integer;
  v_to integer;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  -- An id that is not there and one in a workspace the caller is not in read the same.
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select a.stage, a.outcome, a.offered_at, a.hired_at
    into v_stage, v_outcome, v_offered, v_hired
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return 'not_found'; end if;

  v_to := array_position(c_stages, p_stage);
  if v_to is null then return 'invalid_stage'; end if;
  if v_outcome <> 'active' then return 'not_active'; end if;
  v_from := array_position(c_stages, v_stage);
  if v_to = v_from then return 'same_stage'; end if;
  if v_to < v_from - 1 then return 'too_far_back'; end if;

  update public.hire_applications
     set stage = p_stage,
         offered_at = case when v_to >= 4 then coalesce(v_offered, now()) else null end,
         hired_at = case when v_to = 5 then coalesce(v_hired, now()) else null end
   where id = p_application_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Close a live application: rejected (by the workspace) or withdrawn (by the
-- candidate), with a reason from the list or none. The stage and dates stay.
-- ---------------------------------------------------------------------------
create or replace function public.hire_close_application(
  p_application_id uuid, p_outcome text, p_reason text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_outcome text;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select a.outcome into v_outcome
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return 'not_found'; end if;

  if p_outcome is null or p_outcome not in ('rejected','withdrawn') then return 'invalid_outcome'; end if;
  if p_reason is not null
     and p_reason not in ('skills','experience','salary','role_filled','not_reachable','other') then
    return 'invalid_reason';
  end if;
  if v_outcome <> 'active' then return 'not_active'; end if;

  update public.hire_applications
     set outcome = p_outcome, reject_reason = p_reason
   where id = p_application_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Reopen a rejected or withdrawn application at the stage it was in.
-- ---------------------------------------------------------------------------
create or replace function public.hire_reopen_application(p_application_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_outcome text;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select a.outcome into v_outcome
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return 'not_found'; end if;
  if v_outcome = 'active' then return 'not_closed'; end if;

  update public.hire_applications
     set outcome = 'active', reject_reason = null
   where id = p_application_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Rate 1 to 5, or clear the rating with null. Any outcome.
-- ---------------------------------------------------------------------------
create or replace function public.hire_rate_application(p_application_id uuid, p_rating smallint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  perform 1 from public.hire_applications a where a.id = p_application_id for update;
  if not found then return 'not_found'; end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then return 'invalid_rating'; end if;

  update public.hire_applications set rating = p_rating where id = p_application_id;
  return 'ok';
end $$;

revoke execute on function public.hire_move_application(uuid, text) from public, anon, service_role;
revoke execute on function public.hire_close_application(uuid, text, text) from public, anon, service_role;
revoke execute on function public.hire_reopen_application(uuid) from public, anon, service_role;
revoke execute on function public.hire_rate_application(uuid, smallint) from public, anon, service_role;
grant execute on function public.hire_move_application(uuid, text) to authenticated;
grant execute on function public.hire_close_application(uuid, text, text) to authenticated;
grant execute on function public.hire_reopen_application(uuid) to authenticated;
grant execute on function public.hire_rate_application(uuid, smallint) to authenticated;
