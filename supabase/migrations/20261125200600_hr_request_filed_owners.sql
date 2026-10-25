-- A request that waits for approval now always reaches someone who can approve it.
-- With an active manager linked to a member, that manager alone is told, as before
-- (and nobody when that manager is the one who filed it). With no such manager, every
-- owner and admin of the workspace is told, except whoever filed it and the employee's
-- own account. Same event, title and link as before. A shift swap accepted by both
-- people follows the same rule when they share no manager. Never raises; nothing for
-- the demo workspace.

create or replace function private.hr_notify_request_filed(p_org uuid, p_employee uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
declare
  who text;
  emp_user uuid;
  mgr_id uuid;
  mgr_user uuid;
  label text;
  href text;
  r record;
begin
  if private.is_demo_org(p_org) then return; end if;
  label := case p_kind when 'leave' then 'Leave request' when 'time_off' then 'Time-off request'
                       when 'claim' then 'Claim' when 'overtime' then 'Overtime request' end;
  href := case p_kind when 'leave' then '/people/approve-leave' when 'time_off' then '/people/approve-time-off'
                      when 'claim' then '/people/approve-claims' when 'overtime' then '/people/approve-overtime' end;
  if label is null then return; end if;
  select e.name, e.user_id, e.reports_to into who, emp_user, mgr_id
  from public.hr_employees e where e.id = p_employee and e.org_id = p_org;
  if who is null then return; end if;
  select m.user_id into mgr_user
  from public.hr_employees m
  join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
  where m.id = mgr_id and m.org_id = p_org and m.status = 'active';
  if mgr_user is not null then
    if mgr_user = auth.uid() then return; end if;
    perform private.deliver_notification(mgr_user, p_org, 'hr_request_filed', label || ' from ' || who, null, href);
    return;
  end if;
  for r in
    select om.user_id from public.org_members om
    where om.org_id = p_org and om.role in ('owner', 'admin')
      and om.user_id is distinct from auth.uid() and om.user_id is distinct from emp_user
  loop
    perform private.deliver_notification(r.user_id, p_org, 'hr_request_filed', label || ' from ' || who, null, href);
  end loop;
exception when others then
  raise log 'hr_notify_request_filed: notification skipped (%)', sqlstate;
end; $$;
revoke all on function private.hr_notify_request_filed(uuid, uuid, text) from public, anon, authenticated;

-- p_step is what just happened. Each person told is the employee's linked
-- member, never the caller. Never raises.
--   requested  the colleague
--   accepted   the requester; and the one manager both people report to, if
--              there is one; with no such manager, every owner and admin but
--              the caller and the two people
--   declined   the requester
--   approved, rejected, cancelled   both people
create or replace function private.hr_notify_swap(p_swap uuid, p_step text)
returns void language plpgsql security definer set search_path = public as $$
declare
  sw public.hr_shift_swaps;
  req_name text;
  col_name text;
  req_user uuid;
  col_user uuid;
  mgr_user uuid;
  me uuid := auth.uid();
  href text := '/people/shift-calendar';
  r record;
begin
  select * into sw from public.hr_shift_swaps w where w.id = p_swap;
  if not found or private.is_demo_org(sw.org_id) then return; end if;
  select e.name, om.user_id into req_name, req_user from public.hr_employees e
  left join public.org_members om on om.org_id = e.org_id and om.user_id = e.user_id
  where e.id = sw.requester_employee_id;
  select e.name, om.user_id into col_name, col_user from public.hr_employees e
  left join public.org_members om on om.org_id = e.org_id and om.user_id = e.user_id
  where e.id = sw.colleague_employee_id;

  if p_step = 'requested' then
    if col_user is not null and col_user is distinct from me then
      perform private.deliver_notification(col_user, sw.org_id, 'hr_shift_swap', req_name || ' asked to swap shifts with you', null, href);
    end if;
  elsif p_step in ('accepted', 'declined') then
    if req_user is not null and req_user is distinct from me then
      perform private.deliver_notification(req_user, sw.org_id, 'hr_shift_swap', col_name || ' ' || p_step || ' your shift swap', null, href);
    end if;
    if p_step = 'accepted' then
      select m.user_id into mgr_user
      from public.hr_employees a
      join public.hr_employees b on b.id = sw.colleague_employee_id and b.reports_to = a.reports_to
      join public.hr_employees m on m.id = a.reports_to and m.org_id = a.org_id and m.status = 'active'
      join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
      where a.id = sw.requester_employee_id;
      if mgr_user is not null then
        if mgr_user is distinct from me and mgr_user is distinct from req_user and mgr_user is distinct from col_user then
          perform private.deliver_notification(mgr_user, sw.org_id, 'hr_request_filed',
            'Shift swap from ' || req_name || ' and ' || col_name, null, '/people/approve-shift-swaps');
        end if;
      else
        for r in
          select om.user_id from public.org_members om
          where om.org_id = sw.org_id and om.role in ('owner', 'admin')
            and om.user_id is distinct from me and om.user_id is distinct from req_user and om.user_id is distinct from col_user
        loop
          perform private.deliver_notification(r.user_id, sw.org_id, 'hr_request_filed',
            'Shift swap from ' || req_name || ' and ' || col_name, null, '/people/approve-shift-swaps');
        end loop;
      end if;
    end if;
  elsif p_step in ('approved', 'rejected', 'cancelled') then
    if req_user is not null and req_user is distinct from me then
      perform private.deliver_notification(req_user, sw.org_id, 'hr_shift_swap', 'Your shift swap with ' || col_name || ' was ' || p_step, null, href);
    end if;
    if col_user is not null and col_user is distinct from me then
      perform private.deliver_notification(col_user, sw.org_id, 'hr_shift_swap', 'Your shift swap with ' || req_name || ' was ' || p_step, null, href);
    end if;
  end if;
exception when others then
  raise log 'hr_notify_swap: notification skipped (%)', sqlstate;
end; $$;
revoke all on function private.hr_notify_swap(uuid, text) from public, anon, authenticated;
