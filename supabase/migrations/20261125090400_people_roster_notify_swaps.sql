-- Lekiu: roster notifications and shift swaps.
--
-- 1. When an owner or admin saves a week of the roster, each employee whose
--    own shifts changed on today or a later day (Malaysia date) is told once
--    per save, in the app. A change to past days only tells nobody; neither
--    does a cell saved with the type it already had, an employee linked to no
--    member, or the person who saved it.
-- 2. Shift swaps. A member asks to swap one of their own future shifts with a
--    colleague's future shift (the same day or another). The colleague accepts
--    or declines; then an owner or admin, or a manager of both people, approves
--    or rejects. Either of the two may cancel until it is decided. On approval
--    the two shifts are exchanged in one transaction, and only if the roster
--    has not moved under the request.
--
-- hr_shift_swaps gets no insert, update or delete grant and no write policy.
-- Every change is one of the functions below, which run as the table owner.
-- Never in the demo workspace.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message:
--   SWAP_NOT_ALLOWED  SWAP_NOT_FOUND  SWAP_BAD_INPUT  SWAP_NOT_YOUR_SHIFT  SWAP_BAD_COLLEAGUE
--   SWAP_INACTIVE_EMPLOYEE  SWAP_NOT_FUTURE  SWAP_CLASH  SWAP_ALREADY_OPEN  SWAP_NOT_PENDING
--   SWAP_SHIFT_CHANGED  SWAP_OWN_REQUEST
--
-- "Future" for a swap is a day after today in Malaysia: today's shift has
-- already begun or is about to.
--
-- The functions redefined here, each from its newest definition:
--   hr_save_roster      from 20261124140000_people_rosters_and_hours (only the
--                       lines that work out who changed and tell them added)
--   hr_waiting_counts   from 20261115133700_people_reporting_lines (two
--                       counts added; the four it had are as before)

-- ---- 1. telling people their roster changed ---------------------------------------
-- In-app only, through private.deliver_notification, which honours each
-- person's preferences. Never raises: a notification must never be the reason
-- a roster save is lost.

create or replace function private.hr_notify_roster_changed(p_org uuid, p_week date, p_employees uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  title text;
begin
  if p_org is null or p_week is null or coalesce(cardinality(p_employees), 0) = 0 or private.is_demo_org(p_org) then return; end if;
  title := 'Your shifts for the week of ' || to_char(p_week, 'FMDD Mon') || ' changed';
  for r in
    select distinct e.user_id
    from public.hr_employees e
    join public.org_members om on om.org_id = e.org_id and om.user_id = e.user_id
    where e.org_id = p_org and e.id = any(p_employees) and e.user_id is distinct from auth.uid()
  loop
    perform private.deliver_notification(r.user_id, p_org, 'hr_roster_changed', title, null,
      '/people/shift-calendar?week=' || to_char(p_week, 'YYYY-MM-DD'));
  end loop;
exception when others then
  raise log 'hr_notify_roster_changed: notification skipped (%)', sqlstate;
end; $$;
revoke all on function private.hr_notify_roster_changed(uuid, date, uuid[]) from public, anon, authenticated;

-- ---- 2. save a week of the roster, now telling who changed ------------------------
-- The body from 20261124140000_people_rosters_and_hours.sql with three
-- additions: two declared variables; before the writes, the employees whose
-- cell on today or later is about to change (a cell already holding that type,
-- or cleared while empty, is no change); after the writes, one notification
-- each. Everything else is as it was.

create or replace function public.hr_save_roster(p_org uuid, p_week date, p_cells jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cell jsonb;
  emps uuid[] := '{}';
  days date[] := '{}';
  types uuid[] := '{}';
  emp uuid;
  day date;
  kind uuid;
  n_saved int := 0;
  n_removed int := 0;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  changed uuid[];
begin
  if auth.uid() is null or p_org is null then raise exception 'ROSTER_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'ROSTER_NOT_ALLOWED'; end if;
  if not private.is_org_admin(p_org) then raise exception 'ROSTER_NOT_ALLOWED'; end if;

  if p_week is null or p_week < date '2000-01-01' or p_week > date '2100-12-31' then raise exception 'ROSTER_BAD_INPUT'; end if;
  if extract(isodow from p_week) <> 1 then raise exception 'ROSTER_NOT_MONDAY'; end if;
  if p_cells is null or jsonb_typeof(p_cells) <> 'array' or jsonb_array_length(p_cells) > 7000 then
    raise exception 'ROSTER_BAD_INPUT';
  end if;

  begin
    for cell in select c.value from jsonb_array_elements(p_cells) as c(value) loop
      if jsonb_typeof(cell) <> 'object' or not (cell ? 'employee_id' and cell ? 'work_date' and cell ? 'shift_type_id') then
        raise exception 'ROSTER_BAD_INPUT';
      end if;
      emp := (cell->>'employee_id')::uuid;
      day := (cell->>'work_date')::date;
      kind := (cell->>'shift_type_id')::uuid;
      if emp is null or day is null or day < p_week or day > p_week + 6 then
        raise exception 'ROSTER_BAD_INPUT';
      end if;
      emps := emps || emp;
      days := days || day;
      types := types || kind;
    end loop;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'ROSTER_BAD_INPUT';
  end;

  -- The same cell twice is a mistake, not a choice of which one wins.
  if (select count(*) <> count(distinct (c.e, c.d)) from unnest(emps, days) as c(e, d)) then
    raise exception 'ROSTER_BAD_INPUT';
  end if;

  -- This workspace's roster saves take turns.
  perform 1 from public.orgs o where o.id = p_org for no key update;

  -- Asked before writing, so another workspace's employee or type is refused
  -- with a code and never reaches the table's foreign keys.
  if exists (
    select 1 from unnest(emps) as c(e)
    where not exists (select 1 from public.hr_employees e where e.id = c.e and e.org_id = p_org)
  ) then
    raise exception 'ROSTER_BAD_EMPLOYEE';
  end if;
  if exists (
    select 1 from unnest(emps) as c(e)
    join public.hr_employees e on e.id = c.e
    where e.status is distinct from 'active'
  ) then
    raise exception 'ROSTER_INACTIVE_EMPLOYEE';
  end if;
  if exists (
    select 1 from unnest(types) as c(t)
    where c.t is not null and not exists (select 1 from public.hr_shift_types t where t.id = c.t and t.org_id = p_org)
  ) then
    raise exception 'ROSTER_BAD_SHIFT_TYPE';
  end if;
  if exists (
    select 1 from unnest(types) as c(t)
    join public.hr_shift_types t on t.id = c.t
    where t.archived_at is not null
  ) then
    raise exception 'ROSTER_ARCHIVED_SHIFT_TYPE';
  end if;

  -- Who is told: an employee with a cell on today or later whose type is about to change.
  select coalesce(array_agg(distinct c.e), '{}') into changed
  from unnest(emps, days, types) as c(e, d, t)
  left join public.hr_shifts s on s.employee_id = c.e and s.work_date = c.d
  where c.d >= today and s.shift_type_id is distinct from c.t;

  delete from public.hr_shifts s
  using unnest(emps, days, types) as c(e, d, t)
  where c.t is null and s.employee_id = c.e and s.work_date = c.d and s.org_id = p_org;
  get diagnostics n_removed = row_count;

  insert into public.hr_shifts as s (org_id, employee_id, work_date, shift_type_id, shift)
  select p_org, c.e, c.d, c.t, t.default_kind
  from unnest(emps, days, types) as c(e, d, t)
  join public.hr_shift_types t on t.id = c.t
  order by c.e, c.d
  on conflict (employee_id, work_date) do update set shift_type_id = excluded.shift_type_id, shift = excluded.shift
  where s.shift_type_id is distinct from excluded.shift_type_id;
  get diagnostics n_saved = row_count;

  perform private.hr_notify_roster_changed(p_org, p_week, changed);

  return jsonb_build_object('week', p_week, 'saved', n_saved, 'removed', n_removed);
end; $$;
revoke all on function public.hr_save_roster(uuid, date, jsonb) from public, anon;
grant execute on function public.hr_save_roster(uuid, date, jsonb) to authenticated;

-- ---- 3. shift swaps -------------------------------------------------------------------
-- A swap names two cells of the roster: the requester's shift (requester_date)
-- and the colleague's (colleague_date), with the type each held when asked.
-- For two different days it also keeps what each person had on the other's
-- day when asked (an off type or nothing; a working shift there is a clash),
-- because on approval the two people exchange both days' cells. A swap is
-- approved only while all of these still hold.
-- Status: requested -> accepted -> approved, or declined (the colleague),
-- rejected (an approver) or cancelled (either of the two, before a decision).

create table public.hr_shift_swaps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  requester_employee_id uuid not null,
  colleague_employee_id uuid not null,
  requester_date date not null,
  requester_type_id uuid not null,
  colleague_date date not null,
  colleague_type_id uuid not null,
  requester_other_type_id uuid,
  colleague_other_type_id uuid,
  note text check (note is null or char_length(note) between 1 and 500),
  status text not null default 'requested'
    check (status in ('requested', 'accepted', 'declined', 'approved', 'rejected', 'cancelled')),
  requested_by uuid references auth.users(id) on delete set null,
  replied_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) between 1 and 500),
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (requester_employee_id <> colleague_employee_id),
  foreign key (requester_employee_id, org_id) references public.hr_employees (id, org_id) on delete cascade,
  foreign key (colleague_employee_id, org_id) references public.hr_employees (id, org_id) on delete cascade,
  foreign key (requester_type_id, org_id) references public.hr_shift_types (id, org_id),
  foreign key (colleague_type_id, org_id) references public.hr_shift_types (id, org_id),
  foreign key (requester_other_type_id, org_id) references public.hr_shift_types (id, org_id),
  foreign key (colleague_other_type_id, org_id) references public.hr_shift_types (id, org_id)
);
create index hr_shift_swaps_org_status_idx on public.hr_shift_swaps (org_id, status);
create index hr_shift_swaps_requester_idx on public.hr_shift_swaps (requester_employee_id, requester_date);
create index hr_shift_swaps_colleague_idx on public.hr_shift_swaps (colleague_employee_id, colleague_date);

-- Read by the two people in it, owners and admins, and a manager of both of
-- them. Written only by the functions below.
alter table public.hr_shift_swaps enable row level security;
create policy hr_shift_swaps_select on public.hr_shift_swaps for select to authenticated using (
  private.is_org_admin(org_id)
  or private.is_own_employee(requester_employee_id)
  or private.is_own_employee(colleague_employee_id)
  or (private.is_manager_of(requester_employee_id) and private.is_manager_of(colleague_employee_id))
);
create policy mfa_required on public.hr_shift_swaps as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.hr_shift_swaps from anon, authenticated;
grant select on public.hr_shift_swaps to authenticated;

-- The same test as the read policy, for the functions: someone it is false
-- for is told SWAP_NOT_FOUND, as for an id that is no swap.
create or replace function private.hr_may_see_swap(p_swap public.hr_shift_swaps)
returns boolean language sql security definer stable set search_path = public as $$
  select private.is_org_admin(p_swap.org_id)
    or private.is_own_employee(p_swap.requester_employee_id)
    or private.is_own_employee(p_swap.colleague_employee_id)
    or (private.is_manager_of(p_swap.requester_employee_id) and private.is_manager_of(p_swap.colleague_employee_id));
$$;
revoke all on function private.hr_may_see_swap(public.hr_shift_swaps) from public, anon, authenticated;

-- The type an employee has on a day, or null for no shift.
create or replace function private.hr_shift_type_on(p_employee uuid, p_day date)
returns uuid language sql security definer stable set search_path = public as $$
  select s.shift_type_id from public.hr_shifts s where s.employee_id = p_employee and s.work_date = p_day;
$$;
revoke all on function private.hr_shift_type_on(uuid, date) from public, anon, authenticated;

-- An employee who can take part in a swap: active, linked, and that member
-- still in the workspace.
create or replace function private.hr_swap_ready(p_employee uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.hr_employees e
    join public.org_members om on om.org_id = e.org_id and om.user_id = e.user_id
    where e.id = p_employee and e.status = 'active'
  );
$$;
revoke all on function private.hr_swap_ready(uuid) from public, anon, authenticated;

-- ---- 4. telling people about a swap -----------------------------------------------------
-- p_step is what just happened. Each person told is the employee's linked
-- member, never the caller. Never raises.
--   requested  the colleague
--   accepted   the requester; and the one manager both people report to, if
--              there is one (that manager may approve it; owners and admins
--              see it on their badge)
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
      if mgr_user is not null and mgr_user is distinct from me and mgr_user is distinct from req_user and mgr_user is distinct from col_user then
        perform private.deliver_notification(mgr_user, sw.org_id, 'hr_request_filed',
          'Shift swap from ' || req_name || ' and ' || col_name, null, '/people/approve-shift-swaps');
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

-- ---- 5. the shifts a member may offer and ask for ---------------------------------------
-- The roster is otherwise closed to a member beyond their own row, so this is
-- how they see what they can ask for: their own shifts and those of every
-- active colleague linked to a member, from tomorrow up to 60 days ahead. For
-- a member whose own record is active and linked, in a workspace that is not
-- the demo; anyone else gets nothing.

create or replace function public.hr_swap_options(p_org uuid)
returns table (shift_id uuid, employee_id uuid, employee_name text, work_date date, shift_type_id uuid, mine boolean)
language sql security definer stable set search_path = public as $$
  with me as (
    select e.id from public.hr_employees e
    where e.org_id = p_org and e.user_id = auth.uid() and e.status = 'active'
      and private.is_own_employee(e.id) and not private.is_demo_org(p_org)
  ), today as (
    select (now() at time zone 'Asia/Kuala_Lumpur')::date as d
  )
  select s.id, s.employee_id, e.name, s.work_date, s.shift_type_id, s.employee_id = (select me.id from me)
  from public.hr_shifts s
  join public.hr_employees e on e.id = s.employee_id and e.org_id = s.org_id and e.status = 'active'
  join public.org_members om on om.org_id = e.org_id and om.user_id = e.user_id
  cross join today
  where exists (select 1 from me) and s.org_id = p_org
    and s.work_date > today.d and s.work_date <= today.d + 60
  order by s.work_date, e.name, s.id;
$$;
revoke all on function public.hr_swap_options(uuid) from public, anon;
grant execute on function public.hr_swap_options(uuid) to authenticated;

-- ---- 6. asking for a swap ---------------------------------------------------------------
-- p_my_shift is one of the caller's own shifts, p_their_shift a colleague's in
-- the same workspace; both after today. The caller's and the colleague's
-- records are active and linked. On two different days neither may already
-- work on the other's day (an off type there is fine and is exchanged too).
-- A swap that would change nothing is refused, and so is one that touches a
-- cell already in an open swap. p_note is optional, up to 500 characters.
-- Returns {id, status}.

create or replace function public.hr_request_shift_swap(p_my_shift uuid, p_their_shift uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  mine public.hr_shifts;
  theirs public.hr_shifts;
  my_other uuid;
  their_other uuid;
  v_note text := nullif(trim(p_note), '');
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  saved public.hr_shift_swaps;
begin
  if auth.uid() is null then raise exception 'SWAP_NOT_ALLOWED'; end if;
  if p_my_shift is null or p_their_shift is null or char_length(v_note) > 500 then raise exception 'SWAP_BAD_INPUT'; end if;
  select s.org_id into org from public.hr_shifts s where s.id = p_my_shift;
  if org is null then raise exception 'SWAP_NOT_YOUR_SHIFT'; end if;
  if private.is_demo_org(org) then raise exception 'SWAP_NOT_ALLOWED'; end if;

  -- Swaps and roster saves in one workspace take turns; the shifts are read after.
  perform 1 from public.orgs o where o.id = org for no key update;
  select * into mine from public.hr_shifts s where s.id = p_my_shift;
  if not found or not private.is_own_employee(mine.employee_id) then raise exception 'SWAP_NOT_YOUR_SHIFT'; end if;
  if not private.hr_swap_ready(mine.employee_id) then raise exception 'SWAP_INACTIVE_EMPLOYEE'; end if;
  select * into theirs from public.hr_shifts s where s.id = p_their_shift;
  if not found or theirs.org_id <> mine.org_id or theirs.employee_id = mine.employee_id
     or not private.hr_swap_ready(theirs.employee_id) then
    raise exception 'SWAP_BAD_COLLEAGUE';
  end if;
  if mine.work_date <= today or theirs.work_date <= today then raise exception 'SWAP_NOT_FUTURE'; end if;

  if mine.work_date <> theirs.work_date then
    my_other := private.hr_shift_type_on(mine.employee_id, theirs.work_date);
    their_other := private.hr_shift_type_on(theirs.employee_id, mine.work_date);
    if exists (select 1 from public.hr_shift_types t where t.id in (my_other, their_other) and not t.is_off) then
      raise exception 'SWAP_CLASH';
    end if;
    if mine.shift_type_id is not distinct from their_other and my_other is not distinct from theirs.shift_type_id then
      raise exception 'SWAP_BAD_INPUT';
    end if;
  elsif mine.shift_type_id = theirs.shift_type_id then
    raise exception 'SWAP_BAD_INPUT';
  end if;

  if exists (
    select 1 from public.hr_shift_swaps w
    where w.org_id = org and w.status in ('requested', 'accepted')
      and ((w.requester_employee_id, w.requester_date) in ((mine.employee_id, mine.work_date), (theirs.employee_id, theirs.work_date))
        or (w.colleague_employee_id, w.colleague_date) in ((mine.employee_id, mine.work_date), (theirs.employee_id, theirs.work_date)))
  ) then
    raise exception 'SWAP_ALREADY_OPEN';
  end if;

  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id,
    colleague_date, colleague_type_id, requester_other_type_id, colleague_other_type_id, note, requested_by)
  values (org, mine.employee_id, theirs.employee_id, mine.work_date, mine.shift_type_id,
    theirs.work_date, theirs.shift_type_id, my_other, their_other, v_note, auth.uid())
  returning * into saved;

  perform private.hr_notify_swap(saved.id, 'requested');
  return jsonb_build_object('id', saved.id, 'status', saved.status);
end; $$;
revoke all on function public.hr_request_shift_swap(uuid, uuid, text) from public, anon;
grant execute on function public.hr_request_shift_swap(uuid, uuid, text) to authenticated;

-- ---- 7. the colleague accepts or declines -------------------------------------------------
-- Only the colleague named in the swap, while it is requested. Accepting needs
-- both days still to come and the colleague's record active.

create or replace function public.hr_reply_shift_swap(p_swap uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sw public.hr_shift_swaps;
  outcome text;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  if auth.uid() is null then raise exception 'SWAP_NOT_ALLOWED'; end if;
  select * into sw from public.hr_shift_swaps w where w.id = p_swap;
  if not found or not private.hr_may_see_swap(sw) then raise exception 'SWAP_NOT_FOUND'; end if;
  if private.is_demo_org(sw.org_id) or not private.is_own_employee(sw.colleague_employee_id) then raise exception 'SWAP_NOT_ALLOWED'; end if;
  if p_accept is null then raise exception 'SWAP_BAD_INPUT'; end if;

  perform 1 from public.orgs o where o.id = sw.org_id for no key update;
  select * into sw from public.hr_shift_swaps w where w.id = p_swap for update;
  if sw.status <> 'requested' then raise exception 'SWAP_NOT_PENDING'; end if;
  if p_accept then
    if sw.requester_date <= today or sw.colleague_date <= today then raise exception 'SWAP_NOT_FUTURE'; end if;
    if not private.hr_swap_ready(sw.colleague_employee_id) then raise exception 'SWAP_INACTIVE_EMPLOYEE'; end if;
  end if;

  outcome := case when p_accept then 'accepted' else 'declined' end;
  update public.hr_shift_swaps set status = outcome, replied_at = now() where id = sw.id;
  perform private.hr_notify_swap(sw.id, outcome);
  return jsonb_build_object('id', sw.id, 'status', outcome);
end; $$;
revoke all on function public.hr_reply_shift_swap(uuid, boolean) from public, anon;
grant execute on function public.hr_reply_shift_swap(uuid, boolean) to authenticated;

-- ---- 8. approving or rejecting ----------------------------------------------------------
-- An owner or admin of the workspace, or a manager of both people. One of the
-- two people may not decide their own swap unless they own the workspace (as
-- for leave). Only an accepted swap. Approving needs both days still to come,
-- both records still active, and every cell the swap names still as it was
-- when asked; then, on each day the swap touches, the two people exchange
-- their cells (a cell may be no shift). The shifts are written as a roster
-- save writes them, the old text column filled from the type's kind.
-- p_note (optional, up to 500 characters) is kept on a rejection only.

create or replace function public.hr_decide_shift_swap(p_swap uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sw public.hr_shift_swaps;
  v_note text := nullif(trim(p_note), '');
  outcome text;
  is_admin boolean;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  d date;
  ta uuid;
  tb uuid;
begin
  if auth.uid() is null then raise exception 'SWAP_NOT_ALLOWED'; end if;
  select * into sw from public.hr_shift_swaps w where w.id = p_swap;
  if not found or not private.hr_may_see_swap(sw) then raise exception 'SWAP_NOT_FOUND'; end if;
  if private.is_demo_org(sw.org_id) then raise exception 'SWAP_NOT_ALLOWED'; end if;
  is_admin := private.is_org_admin(sw.org_id);
  if not (is_admin or (private.is_manager_of(sw.requester_employee_id) and private.is_manager_of(sw.colleague_employee_id))) then
    raise exception 'SWAP_NOT_ALLOWED';
  end if;
  if (private.is_own_employee(sw.requester_employee_id) or private.is_own_employee(sw.colleague_employee_id))
     and not private.is_org_owner(sw.org_id) then
    raise exception 'SWAP_OWN_REQUEST';
  end if;
  if p_approve is null or char_length(v_note) > 500 then raise exception 'SWAP_BAD_INPUT'; end if;

  perform 1 from public.orgs o where o.id = sw.org_id for no key update;
  select * into sw from public.hr_shift_swaps w where w.id = p_swap for update;
  if sw.status <> 'accepted' then raise exception 'SWAP_NOT_PENDING'; end if;

  if p_approve then
    if sw.requester_date <= today or sw.colleague_date <= today then raise exception 'SWAP_NOT_FUTURE'; end if;
    if not exists (select 1 from public.hr_employees e where e.id = sw.requester_employee_id and e.status = 'active')
       or not exists (select 1 from public.hr_employees e where e.id = sw.colleague_employee_id and e.status = 'active') then
      raise exception 'SWAP_INACTIVE_EMPLOYEE';
    end if;
    if private.hr_shift_type_on(sw.requester_employee_id, sw.requester_date) is distinct from sw.requester_type_id
       or private.hr_shift_type_on(sw.colleague_employee_id, sw.colleague_date) is distinct from sw.colleague_type_id
       or (sw.requester_date <> sw.colleague_date and (
         private.hr_shift_type_on(sw.requester_employee_id, sw.colleague_date) is distinct from sw.requester_other_type_id
         or private.hr_shift_type_on(sw.colleague_employee_id, sw.requester_date) is distinct from sw.colleague_other_type_id)) then
      raise exception 'SWAP_SHIFT_CHANGED';
    end if;

    for d in select distinct x from unnest(array[sw.requester_date, sw.colleague_date]) as x loop
      ta := private.hr_shift_type_on(sw.requester_employee_id, d);
      tb := private.hr_shift_type_on(sw.colleague_employee_id, d);
      delete from public.hr_shifts s
      where s.org_id = sw.org_id and s.work_date = d and s.employee_id in (sw.requester_employee_id, sw.colleague_employee_id);
      insert into public.hr_shifts (org_id, employee_id, work_date, shift_type_id, shift)
      select sw.org_id, x.e, d, x.t, t.default_kind
      from (values (sw.requester_employee_id, tb), (sw.colleague_employee_id, ta)) as x(e, t)
      join public.hr_shift_types t on t.id = x.t;
    end loop;
  end if;

  outcome := case when p_approve then 'approved' else 'rejected' end;
  update public.hr_shift_swaps
  set status = outcome, decided_by = auth.uid(), decided_at = now(),
      decision_note = case when p_approve then null else v_note end
  where id = sw.id;
  perform private.hr_notify_swap(sw.id, outcome);
  return jsonb_build_object('id', sw.id, 'status', outcome);
end; $$;
revoke all on function public.hr_decide_shift_swap(uuid, boolean, text) from public, anon;
grant execute on function public.hr_decide_shift_swap(uuid, boolean, text) to authenticated;

-- ---- 9. cancelling ----------------------------------------------------------------------
-- Either of the two people, while the swap is requested or accepted.

create or replace function public.hr_cancel_shift_swap(p_swap uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sw public.hr_shift_swaps;
begin
  if auth.uid() is null then raise exception 'SWAP_NOT_ALLOWED'; end if;
  select * into sw from public.hr_shift_swaps w where w.id = p_swap;
  if not found or not private.hr_may_see_swap(sw) then raise exception 'SWAP_NOT_FOUND'; end if;
  if private.is_demo_org(sw.org_id)
     or not (private.is_own_employee(sw.requester_employee_id) or private.is_own_employee(sw.colleague_employee_id)) then
    raise exception 'SWAP_NOT_ALLOWED';
  end if;

  perform 1 from public.orgs o where o.id = sw.org_id for no key update;
  select * into sw from public.hr_shift_swaps w where w.id = p_swap for update;
  if sw.status not in ('requested', 'accepted') then raise exception 'SWAP_NOT_PENDING'; end if;

  update public.hr_shift_swaps set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now() where id = sw.id;
  perform private.hr_notify_swap(sw.id, 'cancelled');
  return jsonb_build_object('id', sw.id, 'status', 'cancelled');
end; $$;
revoke all on function public.hr_cancel_shift_swap(uuid) from public, anon;
grant execute on function public.hr_cancel_shift_swap(uuid) to authenticated;

-- ---- 10. what is waiting for the caller ---------------------------------------------------
-- The body from 20261115133700_people_reporting_lines.sql with two counts added:
--   swaps         accepted swaps the caller may decide, both days still to
--                 come: for an owner or admin every one but those they are in
--                 (an owner's own included); for a manager those of two of
--                 their reports.
--   swap_replies  swaps asking the caller, as the colleague, to accept or
--                 decline, both days still to come. Any member.
-- Everyone in the demo, and anyone else, gets zeros.

create or replace function public.hr_waiting_counts(p_org uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  is_admin boolean;
  is_owner boolean;
  n_leave int := 0;
  n_time_off int := 0;
  n_claims int := 0;
  n_overtime int := 0;
  n_swaps int := 0;
  n_replies int := 0;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  if auth.uid() is not null and p_org is not null and not private.is_demo_org(p_org)
     and private.is_org_member(p_org) then
    is_admin := private.is_org_admin(p_org);
    if is_admin or private.hr_manages_any(p_org) then
      is_owner := private.is_org_owner(p_org);
      select count(*) into n_leave from public.hr_leave_requests r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_time_off from public.hr_time_off_requests r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_claims from public.hr_claims r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_overtime from public.hr_overtime_records r
      where r.org_id = p_org and r.status = 'pending'
        and case when is_admin then (is_owner or not private.is_own_employee(r.employee_id))
                 else private.is_manager_of(r.employee_id) end;
      select count(*) into n_swaps from public.hr_shift_swaps w
      where w.org_id = p_org and w.status = 'accepted' and w.requester_date > today and w.colleague_date > today
        and case when is_admin then (is_owner or not (private.is_own_employee(w.requester_employee_id) or private.is_own_employee(w.colleague_employee_id)))
                 else (private.is_manager_of(w.requester_employee_id) and private.is_manager_of(w.colleague_employee_id)) end;
    end if;
    select count(*) into n_replies from public.hr_shift_swaps w
    where w.org_id = p_org and w.status = 'requested' and w.requester_date > today and w.colleague_date > today
      and private.is_own_employee(w.colleague_employee_id);
  end if;
  return jsonb_build_object('leave', n_leave, 'time_off', n_time_off, 'claims', n_claims, 'overtime', n_overtime,
    'swaps', n_swaps, 'swap_replies', n_replies);
end; $$;
revoke all on function public.hr_waiting_counts(uuid) from public, anon;
grant execute on function public.hr_waiting_counts(uuid) to authenticated;
