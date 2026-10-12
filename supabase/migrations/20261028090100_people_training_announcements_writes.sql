-- Lekiu performance, part two: training and announcements, decided in the
-- database. hr_trainings, hr_training_enrolments, hr_announcements and the new
-- hr_announcement_reads get NO insert, update or delete grant and no write
-- policy. Every change is one of the eleven functions below, which run as the
-- table owner and each begin by working out who is calling: the signed-in
-- user, the workspace (from the course, employee or announcement named; from
-- an argument only for a new course or a new announcement, and then checked
-- against the caller's role there), the second factor, and whether it is the
-- demo.
--   courses, completion, announcements   an owner or admin only;
--   enrolling and withdrawing            the employee themselves, or an owner or admin;
--   read marks                           any member, for themselves only.
-- A course's status is not stored: it follows from its dates and today's date
-- in Malaysia (d): upcoming while d < starts_on, in progress from starts_on
-- to ends_on, completed once d > ends_on. A course with no dates has neither
-- started nor ended. hr_trainings.status is left as it is for the app
-- deployed before this slice, and is no longer written.
-- An announcement is a draft or published. A member reads it only once it is
-- published: the read rule below says so.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message:
--   PERF_NOT_ALLOWED  PERF_NOT_FOUND  PERF_BAD_INPUT  PERF_ALREADY_ENROLLED
--   PERF_NOT_ENROLLED  PERF_COURSE_ENDED  PERF_COURSE_STARTED
--   PERF_COURSE_NOT_STARTED  PERF_COMPLETED  PERF_INACTIVE_EMPLOYEE
--   ANN_NOT_ALLOWED  ANN_NOT_FOUND  ANN_BAD_INPUT  ANN_NOT_DRAFT  ANN_NOT_PUBLISHED
--
-- Safe with the app deployed before this slice: every new column is nullable
-- or has a default, every announcement that exists stays published with its
-- time, and published_at keeps its default.

-- ---- columns ---------------------------------------------------------

alter table public.hr_training_enrolments
  add column completed_at timestamptz,
  add column completed_by uuid references auth.users(id) on delete set null;

-- A draft has no publish time; a published announcement always has one.
alter table public.hr_announcements
  add column status text not null default 'published' check (status in ('draft','published')),
  add column author_id uuid references auth.users(id) on delete set null,
  add column edited_at timestamptz,
  alter column published_at drop not null,
  add constraint hr_announcements_published_at check ((status = 'published') = (published_at is not null)),
  add constraint hr_announcements_body_length check (char_length(body) <= 5000);

-- ---- read marks ---------------------------------------------------------------
-- One row per person per announcement they have seen. They go with the
-- announcement and with the person.

create table public.hr_announcement_reads (
  announcement_id uuid not null references public.hr_announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create index hr_announcement_reads_user_idx on public.hr_announcement_reads (user_id);

-- ---- who may read ----------------------------------------------------------
-- An announcement: an owner or admin of the workspace; any member once it is
-- published; any member of the demo. A read mark: the person it belongs to,
-- and nobody else. hr_announcements keeps its restrictive second-factor
-- policy; the new table gets one.

drop policy hr_announcements_select on public.hr_announcements;
create policy hr_announcements_select on public.hr_announcements for select to authenticated using (
  private.is_org_admin(org_id)
  or (status = 'published' and private.is_org_member(org_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));

alter table public.hr_announcement_reads enable row level security;
create policy hr_announcement_reads_select on public.hr_announcement_reads for select to authenticated
  using (user_id = (select auth.uid()));
create policy mfa_required on public.hr_announcement_reads as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.hr_announcement_reads from anon, authenticated;
grant select on public.hr_announcement_reads to authenticated;

-- ---- helpers (private; only the functions in this file call them) ------

-- The course a call is about, for owners and admins. With no course named it
-- is a new one, and the workspace is the caller's word: owners and admins of
-- it only, never the demo, else PERF_NOT_ALLOWED. With a course named, its row
-- is taken `for update` before anything on it is read, and the workspace is
-- the course's: anyone but an owner or admin of it is told PERF_NOT_FOUND, as
-- for an id that is no course (a member of the demo: PERF_NOT_ALLOWED), and
-- so is a caller who names another workspace beside it. A function that
-- only ever takes a course (or an announcement) answers a missing id itself,
-- as not found, before it comes here.
create or replace function private.hr_perf_held_training(p_org uuid, p_training uuid)
returns public.hr_trainings language plpgsql set search_path = public as $$
declare
  course public.hr_trainings;
begin
  if auth.uid() is null then raise exception 'PERF_NOT_ALLOWED'; end if;
  if p_training is null then
    if p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then
      raise exception 'PERF_NOT_ALLOWED';
    end if;
    course.org_id := p_org;
    return course;
  end if;
  select t.* into course from public.hr_trainings t where t.id = p_training for update;
  if not found then raise exception 'PERF_NOT_FOUND'; end if;
  if not (private.is_org_admin(course.org_id)
          or (private.is_demo_org(course.org_id) and private.is_org_member(course.org_id))) then
    raise exception 'PERF_NOT_FOUND';
  end if;
  if private.is_demo_org(course.org_id) then raise exception 'PERF_NOT_ALLOWED'; end if;
  if p_org <> course.org_id then raise exception 'PERF_NOT_FOUND'; end if;
  return course;
end; $$;
revoke all on function private.hr_perf_held_training(uuid, uuid) from public, anon, authenticated;

-- The course of an enrolment, which must be a course of the employee's
-- workspace. Its row is shared-locked, so its dates cannot change and it
-- cannot be deleted while the enrolment is being decided. The caller has
-- already been checked, through the employee.
create or replace function private.hr_perf_course(p_training uuid, p_org uuid)
returns public.hr_trainings language plpgsql set search_path = public as $$
declare
  course public.hr_trainings;
begin
  select t.* into course from public.hr_trainings t where t.id = p_training and t.org_id = p_org for share;
  if not found then raise exception 'PERF_NOT_FOUND'; end if;
  return course;
end; $$;
revoke all on function private.hr_perf_course(uuid, uuid) from public, anon, authenticated;

-- The announcement a call is about, for owners and admins: as the course
-- above, with the announcement codes.
create or replace function private.hr_ann_held(p_org uuid, p_announcement uuid)
returns public.hr_announcements language plpgsql set search_path = public as $$
declare
  ann public.hr_announcements;
begin
  if auth.uid() is null then raise exception 'ANN_NOT_ALLOWED'; end if;
  if p_announcement is null then
    if p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then
      raise exception 'ANN_NOT_ALLOWED';
    end if;
    ann.org_id := p_org;
    return ann;
  end if;
  select a.* into ann from public.hr_announcements a where a.id = p_announcement for update;
  if not found then raise exception 'ANN_NOT_FOUND'; end if;
  if not (private.is_org_admin(ann.org_id)
          or (private.is_demo_org(ann.org_id) and private.is_org_member(ann.org_id))) then
    raise exception 'ANN_NOT_FOUND';
  end if;
  if private.is_demo_org(ann.org_id) then raise exception 'ANN_NOT_ALLOWED'; end if;
  if p_org <> ann.org_id then raise exception 'ANN_NOT_FOUND'; end if;
  return ann;
end; $$;
revoke all on function private.hr_ann_held(uuid, uuid) from public, anon, authenticated;

-- An announcement as the functions hand it back.
create or replace function private.hr_announcement_json(p_ann public.hr_announcements)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_ann.id, 'title', p_ann.title, 'body', p_ann.body, 'category', p_ann.category,
    'status', p_ann.status, 'published_at', p_ann.published_at, 'edited_at', p_ann.edited_at,
    'author_name', p_ann.author_name);
$$;
revoke all on function private.hr_announcement_json(public.hr_announcements) from public, anon, authenticated;

-- The announcements of a workspace that are unread for the caller: published,
-- published after the caller joined the workspace, and with no read mark of
-- theirs. None for someone who is not a member. This is the one place the
-- rule is written; the count and the marking both read it.
create or replace function private.hr_ann_unread(p_org uuid)
returns setof uuid language sql stable set search_path = public as $$
  select a.id
  from public.hr_announcements a
  join public.org_members m on m.org_id = a.org_id and m.user_id = auth.uid()
  where a.org_id = p_org and a.status = 'published' and a.published_at > m.created_at
    and not exists (
      select 1 from public.hr_announcement_reads x
      where x.announcement_id = a.id and x.user_id = auth.uid()
    );
$$;
revoke all on function private.hr_ann_unread(uuid) from public, anon, authenticated;

-- ---- a course: add or change ------------------------------------------------------
-- p_training null adds a course to the workspace named; otherwise it changes
-- that course. The title is 1 to 200 characters once trimmed; the category
-- and the provider are optional, up to 80 characters each; both dates are
-- needed, the end not before the start.

create or replace function public.hr_save_training(
  p_org uuid, p_training uuid, p_title text, p_category text, p_provider text, p_starts_on date, p_ends_on date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  course public.hr_trainings;
  named text := trim(p_title);
  kind text := nullif(trim(p_category), '');
  giver text := nullif(trim(p_provider), '');
begin
  course := private.hr_perf_held_training(p_org, p_training);
  if named is null or char_length(named) not between 1 and 200
     or char_length(kind) > 80 or char_length(giver) > 80
     or p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'PERF_BAD_INPUT';
  end if;

  if p_training is null then
    insert into public.hr_trainings (org_id, title, category, provider, starts_on, ends_on)
    values (course.org_id, named, kind, giver, p_starts_on, p_ends_on)
    returning * into course;
  else
    update public.hr_trainings t
    set title = named, category = kind, provider = giver, starts_on = p_starts_on, ends_on = p_ends_on
    where t.id = course.id
    returning t.* into course;
  end if;

  return jsonb_build_object(
    'id', course.id, 'title', course.title, 'category', course.category, 'provider', course.provider,
    'starts_on', course.starts_on, 'ends_on', course.ends_on);
end; $$;
revoke all on function public.hr_save_training(uuid, uuid, text, text, text, date, date) from public, anon;
grant execute on function public.hr_save_training(uuid, uuid, text, text, text, date, date) to authenticated;

-- ---- a course: delete -----------------------------------------------------------------
-- Its enrolments go with it. Refused while anyone is marked completed on it.

create or replace function public.hr_delete_training(p_training uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  course public.hr_trainings;
begin
  if p_training is null and auth.uid() is not null then raise exception 'PERF_NOT_FOUND'; end if;
  course := private.hr_perf_held_training(null, p_training);
  if exists (
    select 1 from public.hr_training_enrolments n where n.training_id = course.id and n.completed
  ) then
    raise exception 'PERF_COMPLETED';
  end if;

  delete from public.hr_trainings t where t.id = course.id;

  return jsonb_build_object('id', course.id);
end; $$;
revoke all on function public.hr_delete_training(uuid) from public, anon;
grant execute on function public.hr_delete_training(uuid) to authenticated;

-- ---- enrol ---------------------------------------------------------------------------
-- An owner or admin enrols any employee of the workspace, at any time. An
-- employee enrols themselves while their record is active and the course has
-- not ended. Refused, in this order: already enrolled; (for oneself) an
-- inactive record; (for oneself) the course has ended.

create or replace function public.hr_enrol(p_training uuid, p_employee uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  emp public.hr_employees;
  course public.hr_trainings;
begin
  emp := private.hr_perf_held_employee(p_employee, true);
  course := private.hr_perf_course(p_training, emp.org_id);
  if exists (
    select 1 from public.hr_training_enrolments n where n.training_id = course.id and n.employee_id = emp.id
  ) then
    raise exception 'PERF_ALREADY_ENROLLED';
  end if;
  if not private.is_org_admin(emp.org_id) then
    if emp.status <> 'active' then raise exception 'PERF_INACTIVE_EMPLOYEE'; end if;
    if today > course.ends_on then raise exception 'PERF_COURSE_ENDED'; end if;
  end if;

  insert into public.hr_training_enrolments (org_id, employee_id, training_id)
  values (emp.org_id, emp.id, course.id);

  return jsonb_build_object('training_id', course.id, 'employee_id', emp.id, 'completed', false);
end; $$;
revoke all on function public.hr_enrol(uuid, uuid) from public, anon;
grant execute on function public.hr_enrol(uuid, uuid) to authenticated;

-- ---- withdraw, or remove ---------------------------------------------------------------
-- An owner or admin removes any enrolment that is not marked completed. An
-- employee withdraws themselves until the course starts. Refused, in this
-- order: not enrolled; (for oneself) the course has started; marked completed.

create or replace function public.hr_unenrol(p_training uuid, p_employee uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  emp public.hr_employees;
  course public.hr_trainings;
  done boolean;
begin
  emp := private.hr_perf_held_employee(p_employee, true);
  course := private.hr_perf_course(p_training, emp.org_id);
  select n.completed into done from public.hr_training_enrolments n
  where n.training_id = course.id and n.employee_id = emp.id;
  if not found then raise exception 'PERF_NOT_ENROLLED'; end if;
  if not private.is_org_admin(emp.org_id) then
    if today >= course.starts_on then raise exception 'PERF_COURSE_STARTED'; end if;
  end if;
  if done then raise exception 'PERF_COMPLETED'; end if;

  delete from public.hr_training_enrolments n where n.training_id = course.id and n.employee_id = emp.id;

  return jsonb_build_object('training_id', course.id, 'employee_id', emp.id);
end; $$;
revoke all on function public.hr_unenrol(uuid, uuid) from public, anon;
grant execute on function public.hr_unenrol(uuid, uuid) to authenticated;

-- ---- completion: mark, or undo -----------------------------------------------------------
-- For someone enrolled. Marking needs the course to have started, and stamps
-- when and by whom. Undoing clears both and is never refused for the dates,
-- so a completion cannot be left stuck on a course whose dates were moved.
-- Refused, in this order: neither true nor false; not enrolled; (marking)
-- the course has not started, or has no start date.

create or replace function public.hr_set_training_completed(p_training uuid, p_employee uuid, p_completed boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  emp public.hr_employees;
  course public.hr_trainings;
  done boolean;
begin
  emp := private.hr_perf_held_employee(p_employee, false);
  course := private.hr_perf_course(p_training, emp.org_id);
  if p_completed is null then raise exception 'PERF_BAD_INPUT'; end if;
  select n.completed into done from public.hr_training_enrolments n
  where n.training_id = course.id and n.employee_id = emp.id;
  if not found then raise exception 'PERF_NOT_ENROLLED'; end if;
  if p_completed and (course.starts_on is null or today < course.starts_on) then raise exception 'PERF_COURSE_NOT_STARTED'; end if;

  if done <> p_completed then
    update public.hr_training_enrolments n
    set completed = p_completed,
        completed_at = case when p_completed then now() end,
        completed_by = case when p_completed then auth.uid() end
    where n.training_id = course.id and n.employee_id = emp.id;
  end if;

  return jsonb_build_object('training_id', course.id, 'employee_id', emp.id, 'completed', p_completed);
end; $$;
revoke all on function public.hr_set_training_completed(uuid, uuid, boolean) from public, anon;
grant execute on function public.hr_set_training_completed(uuid, uuid, boolean) to authenticated;

-- ---- an announcement: add or change ------------------------------------------------------
-- p_announcement null adds one to the workspace named; otherwise it changes
-- that one. The title is 1 to 200 characters once trimmed; the body is up to
-- 5,000 characters, kept as typed; the category is one of the five.
--   a new one, or a draft   stays a draft, unless p_publish is true: then it
--                           is published now, by the caller;
--   a published one         stays published with the time it had, and
--                           edited_at is set. p_publish changes nothing.

create or replace function public.hr_save_announcement(
  p_org uuid, p_announcement uuid, p_title text, p_body text, p_category text, p_publish boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ann public.hr_announcements;
  named text := trim(p_title);
  words text := coalesce(p_body, '');
  publish boolean := p_publish is true;
begin
  ann := private.hr_ann_held(p_org, p_announcement);
  if named is null or char_length(named) not between 1 and 200 or char_length(words) > 5000
     or p_category is null or p_category not in ('general','holiday','benefits','strategy','policy') then
    raise exception 'ANN_BAD_INPUT';
  end if;

  if p_announcement is null then
    insert into public.hr_announcements (org_id, title, body, category, status, published_at, author_id, author_name)
    values (ann.org_id, named, words, p_category,
      case when publish then 'published' else 'draft' end,
      case when publish then now() end,
      case when publish then auth.uid() end,
      case when publish then private.hr_perf_caller_name(ann.org_id) end)
    returning * into ann;
  elsif ann.status = 'published' then
    update public.hr_announcements a
    set title = named, body = words, category = p_category, edited_at = now()
    where a.id = ann.id
    returning a.* into ann;
  elsif publish then
    update public.hr_announcements a
    set title = named, body = words, category = p_category,
        status = 'published', published_at = now(), edited_at = null,
        author_id = auth.uid(), author_name = private.hr_perf_caller_name(ann.org_id)
    where a.id = ann.id
    returning a.* into ann;
  else
    update public.hr_announcements a
    set title = named, body = words, category = p_category
    where a.id = ann.id
    returning a.* into ann;
  end if;

  return private.hr_announcement_json(ann);
end; $$;
revoke all on function public.hr_save_announcement(uuid, uuid, text, text, text, boolean) from public, anon;
grant execute on function public.hr_save_announcement(uuid, uuid, text, text, text, boolean) to authenticated;

-- ---- an announcement: publish a draft -----------------------------------------------------
-- Published now, by the caller. Publishing again after a pull-back sets a new
-- time; the read marks people already have stay.

create or replace function public.hr_publish_announcement(p_announcement uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ann public.hr_announcements;
begin
  if p_announcement is null and auth.uid() is not null then raise exception 'ANN_NOT_FOUND'; end if;
  ann := private.hr_ann_held(null, p_announcement);
  if ann.status <> 'draft' then raise exception 'ANN_NOT_DRAFT'; end if;

  update public.hr_announcements a
  set status = 'published', published_at = now(), edited_at = null,
      author_id = auth.uid(), author_name = private.hr_perf_caller_name(ann.org_id)
  where a.id = ann.id
  returning a.* into ann;

  return private.hr_announcement_json(ann);
end; $$;
revoke all on function public.hr_publish_announcement(uuid) from public, anon;
grant execute on function public.hr_publish_announcement(uuid) to authenticated;

-- ---- an announcement: pull back to draft --------------------------------------------------

create or replace function public.hr_unpublish_announcement(p_announcement uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ann public.hr_announcements;
begin
  if p_announcement is null and auth.uid() is not null then raise exception 'ANN_NOT_FOUND'; end if;
  ann := private.hr_ann_held(null, p_announcement);
  if ann.status <> 'published' then raise exception 'ANN_NOT_PUBLISHED'; end if;

  update public.hr_announcements a set status = 'draft', published_at = null
  where a.id = ann.id
  returning a.* into ann;

  return private.hr_announcement_json(ann);
end; $$;
revoke all on function public.hr_unpublish_announcement(uuid) from public, anon;
grant execute on function public.hr_unpublish_announcement(uuid) to authenticated;

-- ---- an announcement: delete ---------------------------------------------------------------
-- A draft or a published one. Its read marks go with it.

create or replace function public.hr_delete_announcement(p_announcement uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ann public.hr_announcements;
begin
  if p_announcement is null and auth.uid() is not null then raise exception 'ANN_NOT_FOUND'; end if;
  ann := private.hr_ann_held(null, p_announcement);

  delete from public.hr_announcements a where a.id = ann.id;

  return jsonb_build_object('id', ann.id);
end; $$;
revoke all on function public.hr_delete_announcement(uuid) from public, anon;
grant execute on function public.hr_delete_announcement(uuid) to authenticated;

-- ---- read marks: mark everything read ------------------------------------------------------
-- For the caller, in one workspace they are a member of: a mark for every
-- announcement that is unread for them. Never for anyone else, and never in
-- the demo, where nobody has marks.

create or replace function public.hr_mark_announcements_read(p_org uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null or p_org is null then raise exception 'ANN_NOT_ALLOWED'; end if;
  if private.is_demo_org(p_org) then raise exception 'ANN_NOT_ALLOWED'; end if;
  if not private.is_org_member(p_org) then raise exception 'ANN_NOT_ALLOWED'; end if;

  with marked as (
    insert into public.hr_announcement_reads (announcement_id, user_id)
    select u.id, auth.uid() from private.hr_ann_unread(p_org) as u(id)
    on conflict do nothing
    returning 1
  )
  select count(*)::int into n from marked;

  return jsonb_build_object('marked', n);
end; $$;
revoke all on function public.hr_mark_announcements_read(uuid) from public, anon;
grant execute on function public.hr_mark_announcements_read(uuid) to authenticated;

-- ---- read marks: how many are unread -------------------------------------------------------
-- The caller's own count in one workspace. It never refuses: it is 0 in the
-- demo, and 0 for someone who is signed out, owes a second factor or is not a
-- member, so a page that shows the count has nothing to handle.

create or replace function public.hr_unread_announcements(p_org uuid)
returns int language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or p_org is null or private.is_demo_org(p_org) or not private.is_org_member(p_org) then
    return 0;
  end if;
  return (select count(*)::int from private.hr_ann_unread(p_org));
end; $$;
revoke all on function public.hr_unread_announcements(uuid) from public, anon;
grant execute on function public.hr_unread_announcements(uuid) to authenticated;
