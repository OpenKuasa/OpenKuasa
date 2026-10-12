-- supabase/migrations/20261107090100_hire_interviews_writes.sql
-- Lekir slice 4a, part 2 of 2: a recruiter can schedule an interview, record
-- one that already took place, change it, cancel it, mark what happened and
-- mark it scheduled again. Six functions are the only way: members still have
-- select only on hire_interviews. Each answers with a word and never raises.
--
-- Safe to run again: it holds only "create or replace function", revokes and
-- grants. The columns these functions use are added in 20261107090000.

-- ---------------------------------------------------------------------------
-- A time that arrives as text becomes an instant only when it says which zone
-- it is in. A parameter typed timestamptz would be cast in the session's zone
-- (UTC) before a function body runs, so "2026-10-20T15:00:00" would be stored
-- as 15:00 UTC, which is 23:00 in Kuala Lumpur, and be answered "ok". All three
-- functions that take a time go through this one check, so the rule cannot
-- drift. The form is checked, then whether it is a real instant, and only then
-- is it cast: null is the answer for anything else, and nothing raises.
-- ---------------------------------------------------------------------------
create or replace function private.hire_zoned_instant(p_text text)
returns timestamptz language plpgsql stable set search_path = '' as $$
begin
  if p_text is null
     or p_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$'
     or pg_input_is_valid(p_text, 'timestamptz') is not true then
    return null;
  end if;
  return p_text::timestamptz;
end $$;
revoke execute on function private.hire_zoned_instant(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule an interview for an active application, at any stage. The new row
-- takes the application's own workspace, read under the application's row
-- lock: the caller never names one. A deletion of the application takes the
-- same lock, so the two take turns. Two calls for the same instant also take
-- turns on it, so the second one sees the first one's row and is refused.
-- ---------------------------------------------------------------------------
create or replace function public.hire_schedule_interview(
  p_application_id uuid,
  p_scheduled_at text,
  p_duration_minutes integer,
  p_kind text,
  p_place text,
  p_interviewer_name text,
  p_notes text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_app_org uuid;
  v_outcome text;
  v_place text := private.hire_one_line(p_place);
  v_interviewer text := private.hire_one_line(p_interviewer_name);
  v_notes text := nullif(regexp_replace(coalesce(p_notes, ''), '^\s+|\s+$', '', 'g'), '');
  v_at timestamptz;
  v_id uuid;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  -- An id that is not there and one in a workspace the caller is not in read the same.
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  select a.org_id, a.outcome into v_app_org, v_outcome
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;
  -- The workspace the caller was checked against must be the one the row is written to.
  if v_app_org is distinct from v_org then return jsonb_build_object('word', 'not_found'); end if;
  if v_outcome <> 'active' then return jsonb_build_object('word', 'not_active'); end if;

  v_at := private.hire_zoned_instant(p_scheduled_at);
  if v_at is null then return jsonb_build_object('word', 'invalid_time'); end if;
  if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 480 then
    return jsonb_build_object('word', 'invalid_duration');
  end if;
  if p_kind is null or p_kind not in ('video', 'onsite', 'phone') then
    return jsonb_build_object('word', 'invalid_kind');
  end if;
  if char_length(v_place) > 300 then return jsonb_build_object('word', 'invalid_place'); end if;
  if char_length(v_interviewer) > 120 then return jsonb_build_object('word', 'invalid_interviewer'); end if;
  if char_length(v_notes) > 2000 then return jsonb_build_object('word', 'invalid_notes'); end if;

  -- Five minutes of grace for a slow form and a clock that is slightly off.
  if v_at < now() - interval '5 minutes' then return jsonb_build_object('word', 'in_past'); end if;
  if v_at > now() + interval '366 days' then return jsonb_build_object('word', 'too_far_ahead'); end if;

  -- Spec: the same application cannot have two scheduled interviews at one instant, so a double submit is harmless at the database. Only a scheduled
  -- interview counts here; the instant is compared exactly, to the microsecond.
  if exists (
       select 1 from public.hire_interviews i
        where i.application_id = p_application_id and i.status = 'scheduled' and i.scheduled_at = v_at) then
    return jsonb_build_object('word', 'duplicate');
  end if;

  -- created_at and updated_at take their defaults: both are now(), so they are equal.
  insert into public.hire_interviews
    (org_id, application_id, scheduled_at, duration_minutes, kind, place, interviewer_name, notes, status)
  values
    (v_app_org, p_application_id, v_at, p_duration_minutes::smallint, p_kind, v_place, v_interviewer, v_notes, 'scheduled')
  returning id into v_id;
  return jsonb_build_object('word', 'ok', 'id', v_id);
end $$;

-- ---------------------------------------------------------------------------
-- Record an interview that already took place and was never entered. The
-- application may be rejected or withdrawn. What happened is required:
-- completed or no_show. The start may not be later than now, nor more than
-- 366 days ago. Same lock and same workspace rule as scheduling.
-- ---------------------------------------------------------------------------
create or replace function public.hire_record_past_interview(
  p_application_id uuid,
  p_scheduled_at text,
  p_duration_minutes integer,
  p_kind text,
  p_outcome text,
  p_place text,
  p_interviewer_name text,
  p_notes text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_app_org uuid;
  v_place text := private.hire_one_line(p_place);
  v_interviewer text := private.hire_one_line(p_interviewer_name);
  v_notes text := nullif(regexp_replace(coalesce(p_notes, ''), '^\s+|\s+$', '', 'g'), '');
  v_at timestamptz;
  v_id uuid;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  select a.org_id into v_app_org
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;
  if v_app_org is distinct from v_org then return jsonb_build_object('word', 'not_found'); end if;

  v_at := private.hire_zoned_instant(p_scheduled_at);
  if v_at is null then return jsonb_build_object('word', 'invalid_time'); end if;
  if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 480 then
    return jsonb_build_object('word', 'invalid_duration');
  end if;
  if p_kind is null or p_kind not in ('video', 'onsite', 'phone') then
    return jsonb_build_object('word', 'invalid_kind');
  end if;
  if p_outcome is null or p_outcome not in ('completed', 'no_show') then
    return jsonb_build_object('word', 'invalid_outcome');
  end if;
  if char_length(v_place) > 300 then return jsonb_build_object('word', 'invalid_place'); end if;
  if char_length(v_interviewer) > 120 then return jsonb_build_object('word', 'invalid_interviewer'); end if;
  if char_length(v_notes) > 2000 then return jsonb_build_object('word', 'invalid_notes'); end if;

  if v_at > now() then return jsonb_build_object('word', 'not_past'); end if;
  if v_at < now() - interval '366 days' then return jsonb_build_object('word', 'too_far_back'); end if;

  -- Spec: the same application cannot have two interviews at one instant whatever their status, a cancelled
  -- one aside (so a second recording of the same meeting is refused). Compared exactly, to the microsecond.
  if exists (
       select 1 from public.hire_interviews i
        where i.application_id = p_application_id and i.status <> 'cancelled' and i.scheduled_at = v_at) then
    return jsonb_build_object('word', 'duplicate');
  end if;

  insert into public.hire_interviews
    (org_id, application_id, scheduled_at, duration_minutes, kind, place, interviewer_name, notes, status)
  values
    (v_app_org, p_application_id, v_at, p_duration_minutes::smallint, p_kind, v_place, v_interviewer, v_notes, p_outcome)
  returning id into v_id;
  return jsonb_build_object('word', 'ok', 'id', v_id);
end $$;

-- ---------------------------------------------------------------------------
-- Change a scheduled interview: its time or any detail. Only the keys named in
-- p_changes are touched; a JSON null clears place, interviewer_name or notes.
-- Locks the application's row first and the interview's row second, the order
-- the two delete functions use, so a change and a deletion cannot deadlock.
-- The past and far-future rules apply only when the time itself changes.
-- Answers jsonb, as the two functions that insert do: { word } for a refusal,
-- and { word: 'ok', moved } when saved, where moved says whether the stored
-- time is a different instant from the one it was. A caller sends the time
-- along unchanged with another change often enough that only this function
-- can say; the invitation's "has a new time" rests on it.
-- ---------------------------------------------------------------------------
create or replace function public.hire_reschedule_interview(
  p_interview_id uuid,
  p_changes jsonb,
  p_if_updated_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_keys constant text[] := array['scheduled_at','duration_minutes','kind','place','interviewer_name','notes'];
  v_org uuid;
  v_application uuid;
  v_app_org uuid;
  v_outcome text;
  v_row public.hire_interviews%rowtype;
  v_number numeric;
  v_at timestamptz;
  v_duration integer;
  v_kind text;
  v_place text;
  v_interviewer text;
  v_notes text;
begin
  select i.org_id, i.application_id into v_org, v_application
    from public.hire_interviews i where i.id = p_interview_id;
  if v_org is null or private.is_org_member(v_org) is not true then return jsonb_build_object('word', 'not_found'); end if;
  if private.is_org_writer(v_org) is not true then return jsonb_build_object('word', 'forbidden'); end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return jsonb_build_object('word', 'invalid_changes'); end if;
  if exists (select 1 from jsonb_object_keys(p_changes) as k(key) where k.key <> all (c_keys)) then
    return jsonb_build_object('word', 'invalid_changes');
  end if;

  -- The application first, always.
  select a.org_id, a.outcome into v_app_org, v_outcome
    from public.hire_applications a
   where a.id = v_application
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;
  -- An interview's application is in the interview's own workspace (the foundation's rule for a child and its
  -- parent). No function here can write a row that breaks it; one that did break it is not acted on.
  if v_app_org is distinct from v_org then return jsonb_build_object('word', 'not_found'); end if;

  select i.* into v_row
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;

  -- The form says when it last saw this row changed. If that is no longer so, save nothing.
  if p_if_updated_at is not null and p_if_updated_at is distinct from v_row.updated_at then return jsonb_build_object('word', 'changed'); end if;
  if v_row.status <> 'scheduled' then return jsonb_build_object('word', 'not_scheduled'); end if;
  if v_outcome <> 'active' then return jsonb_build_object('word', 'not_active'); end if;

  -- The time: text with a zone, checked by the helper shared with the two
  -- functions that insert. Anything else is answered with a word.
  v_at := v_row.scheduled_at;
  if p_changes ? 'scheduled_at' then
    if jsonb_typeof(p_changes -> 'scheduled_at') <> 'string' then return jsonb_build_object('word', 'invalid_time'); end if;
    v_at := private.hire_zoned_instant(p_changes ->> 'scheduled_at');
    if v_at is null then return jsonb_build_object('word', 'invalid_time'); end if;
  end if;

  v_duration := v_row.duration_minutes;
  if p_changes ? 'duration_minutes' then
    if jsonb_typeof(p_changes -> 'duration_minutes') <> 'number' then return jsonb_build_object('word', 'invalid_duration'); end if;
    v_number := (p_changes ->> 'duration_minutes')::numeric;
    if v_number <> trunc(v_number) or v_number < 15 or v_number > 480 then return jsonb_build_object('word', 'invalid_duration'); end if;
    v_duration := v_number::integer;
  end if;

  v_kind := v_row.kind;
  if p_changes ? 'kind' then
    v_kind := p_changes ->> 'kind';
    if jsonb_typeof(p_changes -> 'kind') <> 'string' or v_kind not in ('video', 'onsite', 'phone') then
      return jsonb_build_object('word', 'invalid_kind');
    end if;
  end if;

  v_place := v_row.place;
  if p_changes ? 'place' then
    if jsonb_typeof(p_changes -> 'place') not in ('string', 'null') then return jsonb_build_object('word', 'invalid_place'); end if;
    v_place := private.hire_one_line(p_changes ->> 'place');
    if char_length(v_place) > 300 then return jsonb_build_object('word', 'invalid_place'); end if;
  end if;

  v_interviewer := v_row.interviewer_name;
  if p_changes ? 'interviewer_name' then
    if jsonb_typeof(p_changes -> 'interviewer_name') not in ('string', 'null') then return jsonb_build_object('word', 'invalid_interviewer'); end if;
    v_interviewer := private.hire_one_line(p_changes ->> 'interviewer_name');
    if char_length(v_interviewer) > 120 then return jsonb_build_object('word', 'invalid_interviewer'); end if;
  end if;

  v_notes := v_row.notes;
  if p_changes ? 'notes' then
    if jsonb_typeof(p_changes -> 'notes') not in ('string', 'null') then return jsonb_build_object('word', 'invalid_notes'); end if;
    v_notes := nullif(regexp_replace(coalesce(p_changes ->> 'notes', ''), '^\s+|\s+$', '', 'g'), '');
    if char_length(v_notes) > 2000 then return jsonb_build_object('word', 'invalid_notes'); end if;
  end if;

  -- Nothing differs: nothing is written, and the time of the last change does not move.
  if v_at = v_row.scheduled_at and v_duration = v_row.duration_minutes and v_kind = v_row.kind
     and v_place is not distinct from v_row.place
     and v_interviewer is not distinct from v_row.interviewer_name
     and v_notes is not distinct from v_row.notes then
    return jsonb_build_object('word', 'unchanged');
  end if;

  -- Only a new time is held to the time rules: the notes of an interview that
  -- began an hour ago can still be edited.
  if v_at <> v_row.scheduled_at then
    if v_at < now() - interval '5 minutes' then return jsonb_build_object('word', 'in_past'); end if;
    if v_at > now() + interval '366 days' then return jsonb_build_object('word', 'too_far_ahead'); end if;
    if exists (
         select 1 from public.hire_interviews i
          where i.application_id = v_application and i.id <> p_interview_id
            and i.status = 'scheduled' and i.scheduled_at = v_at) then
      return jsonb_build_object('word', 'duplicate');
    end if;
  end if;

  update public.hire_interviews
     set scheduled_at = v_at, duration_minutes = v_duration::smallint, kind = v_kind,
         place = v_place, interviewer_name = v_interviewer, notes = v_notes, updated_at = now()
   where id = p_interview_id;
  -- v_row is the row as it was locked, before the update: whether the stored time is another instant now.
  return jsonb_build_object('word', 'ok', 'moved', v_at <> v_row.scheduled_at);
end $$;

-- ---------------------------------------------------------------------------
-- Cancel a scheduled interview. It stays in the list as cancelled. The
-- application's outcome does not matter, so only the interview's row is locked.
-- ---------------------------------------------------------------------------
create or replace function public.hire_cancel_interview(p_interview_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_status text;
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select i.status into v_status
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return 'not_found'; end if;
  if v_status <> 'scheduled' then return 'not_scheduled'; end if;

  update public.hire_interviews set status = 'cancelled', updated_at = now() where id = p_interview_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Mark a scheduled interview completed or a no-show, before or after its start.
-- ---------------------------------------------------------------------------
create or replace function public.hire_set_interview_outcome(p_interview_id uuid, p_outcome text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_status text;
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select i.status into v_status
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return 'not_found'; end if;
  if p_outcome is null or p_outcome not in ('completed', 'no_show') then return 'invalid_outcome'; end if;
  if v_status <> 'scheduled' then return 'not_scheduled'; end if;

  update public.hire_interviews set status = p_outcome, updated_at = now() where id = p_interview_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Mark a cancelled, completed or no-show interview as scheduled again, with
-- its time and details as they were. The time may be in the past.
-- ---------------------------------------------------------------------------
create or replace function public.hire_reopen_interview(p_interview_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_status text;
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select i.status into v_status
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return 'not_found'; end if;
  if v_status = 'scheduled' then return 'not_closed'; end if;

  -- Deliberately no duplicate check on this undo: it can leave two scheduled interviews of one application at
  -- the same instant. The owner accepted that; do not "fix" it by accident.
  update public.hire_interviews set status = 'scheduled', updated_at = now() where id = p_interview_id;
  return 'ok';
end $$;

revoke execute on function public.hire_schedule_interview(uuid, text, integer, text, text, text, text) from public, anon, service_role;
revoke execute on function public.hire_record_past_interview(uuid, text, integer, text, text, text, text, text) from public, anon, service_role;
revoke execute on function public.hire_reschedule_interview(uuid, jsonb, timestamptz) from public, anon, service_role;
revoke execute on function public.hire_cancel_interview(uuid) from public, anon, service_role;
revoke execute on function public.hire_set_interview_outcome(uuid, text) from public, anon, service_role;
revoke execute on function public.hire_reopen_interview(uuid) from public, anon, service_role;
grant execute on function public.hire_schedule_interview(uuid, text, integer, text, text, text, text) to authenticated;
grant execute on function public.hire_record_past_interview(uuid, text, integer, text, text, text, text, text) to authenticated;
grant execute on function public.hire_reschedule_interview(uuid, jsonb, timestamptz) to authenticated;
grant execute on function public.hire_cancel_interview(uuid) to authenticated;
grant execute on function public.hire_set_interview_outcome(uuid, text) to authenticated;
grant execute on function public.hire_reopen_interview(uuid) to authenticated;
