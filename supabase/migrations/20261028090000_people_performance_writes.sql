-- Lekiu performance, part one: goals and reviews, decided in the database.
-- hr_goals and hr_reviews get NO insert, update or delete grant and no write
-- policy. Every change is one of the six functions below, which run as the
-- table owner and each begin by working out who is calling: the signed-in
-- user, the workspace (from the employee or the review named, never from the
-- caller's word), the second factor, and whether it is the demo.
--   goals    the employee themselves, or an owner or admin;
--   reviews  an owner or admin only.
-- A review is a draft until it is released. The person it is about reads it
-- only once it is released: the read rule below says so, and a member who
-- names their own draft is told PERF_NOT_FOUND, as for an id that is nothing.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message, so
-- nothing a person typed can reach an error or a log:
--   PERF_NOT_ALLOWED  PERF_NOT_FOUND  PERF_BAD_INPUT  PERF_TOO_MANY_GOALS
--   PERF_REVIEW_EXISTS  PERF_NOT_DRAFT  PERF_NOT_RELEASED
--
-- Safe with the app deployed before this slice: every new column is nullable
-- or has a default, hr_scorecards is not touched, and the reviews that exist
-- are the demo's, which every member of the demo still reads.

-- ---- columns ---------------------------------------------------------

-- competencies: the four scores. comment: what the reviewer wrote.
-- status, released_at: a draft until released. reviewer_id: who saved it last.
alter table public.hr_reviews
  add column competencies jsonb not null default '{}'::jsonb,
  add column comment text check (comment is null or char_length(comment) <= 2000),
  add column status text not null default 'draft' check (status in ('draft','released')),
  add column released_at timestamptz,
  add column reviewer_id uuid references auth.users(id) on delete set null,
  add constraint hr_reviews_released_at check ((status = 'released') = (released_at is not null));

-- The score is the average of four half-step scores, so it needs two decimals.
-- Existing scores are kept (3.5 becomes 3.50); the check that it lies between
-- 0 and 5 stays; no view or index reads the column.
alter table public.hr_reviews alter column score type numeric(3,2);

-- ---- who may read ----------------------------------------------------------
-- A review: an owner or admin of the workspace; the employee themselves once
-- it is released; any member of the demo. The restrictive second-factor
-- policy of the table stays as it is.

drop policy hr_reviews_select on public.hr_reviews;
create policy hr_reviews_select on public.hr_reviews for select to authenticated using (
  private.is_org_admin(org_id)
  or (status = 'released' and private.is_own_employee(employee_id))
  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));

-- ---- helpers (private; only the functions of this slice call them) ------

-- The caller's name, for a review's reviewer and an announcement's author:
-- their employee record's name in that workspace when they have one, else
-- their account's name (profiles.full_name, then the part of their email
-- before the @, as private.display_name gives it).
create or replace function private.hr_perf_caller_name(p_org uuid)
returns text language sql stable set search_path = public as $$
  select coalesce(
    (select e.name from public.hr_employees e where e.org_id = p_org and e.user_id = auth.uid()),
    private.display_name(auth.uid()));
$$;
revoke all on function private.hr_perf_caller_name(uuid) from public, anon, authenticated;

-- The employee a call is about, held and checked. Their row is taken
-- `for no key update` before anything of theirs is read, so two callers
-- working on one person's goals or enrolments take turns. Then the caller: an
-- owner or admin of the employee's workspace, or (when p_own) the employee
-- themselves, and not the demo. Anyone else is told PERF_NOT_FOUND, the same
-- as for an id that is no employee, so the answer does not say which ids are
-- real; a member of the demo, who can read everything there, is told
-- PERF_NOT_ALLOWED. (is_org_admin and is_own_employee are also false for a
-- session that owes a second factor.)
create or replace function private.hr_perf_held_employee(p_employee uuid, p_own boolean)
returns public.hr_employees language plpgsql set search_path = public as $$
declare
  emp public.hr_employees;
begin
  if auth.uid() is null then raise exception 'PERF_NOT_ALLOWED'; end if;
  select e.* into emp from public.hr_employees e where e.id = p_employee for no key update;
  if not found then raise exception 'PERF_NOT_FOUND'; end if;
  -- Someone with no business with this employee learns nothing from the answer.
  if not (private.is_org_admin(emp.org_id) or (p_own and private.is_own_employee(emp.id))
          or (private.is_demo_org(emp.org_id) and private.is_org_member(emp.org_id))) then
    raise exception 'PERF_NOT_FOUND';
  end if;
  if private.is_demo_org(emp.org_id) then raise exception 'PERF_NOT_ALLOWED'; end if;
  return emp;
end; $$;
revoke all on function private.hr_perf_held_employee(uuid, boolean) from public, anon, authenticated;

-- The review a call is about, held and checked: owners and admins of its
-- workspace only. Everyone else, the employee it is about included, is told
-- PERF_NOT_FOUND, so a member cannot learn that a draft of theirs exists.
create or replace function private.hr_perf_held_review(p_review uuid)
returns public.hr_reviews language plpgsql set search_path = public as $$
declare
  rev public.hr_reviews;
begin
  if auth.uid() is null then raise exception 'PERF_NOT_ALLOWED'; end if;
  select r.* into rev from public.hr_reviews r where r.id = p_review for update;
  if not found then raise exception 'PERF_NOT_FOUND'; end if;
  if not (private.is_org_admin(rev.org_id)
          or (private.is_demo_org(rev.org_id) and private.is_org_member(rev.org_id))) then
    raise exception 'PERF_NOT_FOUND';
  end if;
  if private.is_demo_org(rev.org_id) then raise exception 'PERF_NOT_ALLOWED'; end if;
  return rev;
end; $$;
revoke all on function private.hr_perf_held_review(uuid) from public, anon, authenticated;

-- A review as the functions hand it back.
create or replace function private.hr_review_json(p_rev public.hr_reviews)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_rev.id, 'employee_id', p_rev.employee_id, 'period', p_rev.period,
    'competencies', p_rev.competencies, 'score', p_rev.score, 'rating', p_rev.rating,
    'comment', p_rev.comment, 'status', p_rev.status, 'released_at', p_rev.released_at,
    'reviewer_name', p_rev.reviewer_name, 'reviewed_at', p_rev.reviewed_at);
$$;
revoke all on function private.hr_review_json(public.hr_reviews) from public, anon, authenticated;

-- ---- a goal: add or change -------------------------------------------------
-- p_goal null adds a goal for that employee; otherwise it changes that goal,
-- which must be a goal of that employee. The title is 1 to 200 characters once
-- trimmed; progress is 0 to 100; the due date is optional, from 2000 to 2100.
-- The status is `done` exactly when progress is 100, whatever p_at_risk says;
-- below 100 it is `at_risk` when p_at_risk is true and `on_track` otherwise.
-- An employee with 30 goals that are not done cannot be given another;
-- changing or finishing the ones they have is never refused for that.

create or replace function public.hr_save_goal(
  p_employee uuid, p_goal uuid, p_title text, p_progress int, p_due_date date, p_at_risk boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  emp public.hr_employees;
  goal public.hr_goals;
  named text := trim(p_title);
  state text;
begin
  emp := private.hr_perf_held_employee(p_employee, true);
  if p_goal is not null then
    select g.* into goal from public.hr_goals g where g.id = p_goal and g.employee_id = emp.id;
    if not found then raise exception 'PERF_NOT_FOUND'; end if;
  end if;
  if named is null or char_length(named) not between 1 and 200
     or p_progress is null or p_progress < 0 or p_progress > 100
     or p_due_date < date '2000-01-01' or p_due_date > date '2100-12-31' then
    raise exception 'PERF_BAD_INPUT';
  end if;
  state := case when p_progress = 100 then 'done' when p_at_risk is true then 'at_risk' else 'on_track' end;

  if p_goal is null then
    if (select count(*) from public.hr_goals g where g.employee_id = emp.id and g.status <> 'done') >= 30 then
      raise exception 'PERF_TOO_MANY_GOALS';
    end if;
    insert into public.hr_goals (org_id, employee_id, title, progress, due_date, status)
    values (emp.org_id, emp.id, named, p_progress, p_due_date, state)
    returning * into goal;
  else
    update public.hr_goals g
    set title = named, progress = p_progress, due_date = p_due_date, status = state
    where g.id = goal.id
    returning g.* into goal;
  end if;

  return jsonb_build_object(
    'id', goal.id, 'employee_id', goal.employee_id, 'title', goal.title,
    'progress', goal.progress, 'due_date', goal.due_date, 'status', goal.status);
end; $$;
revoke all on function public.hr_save_goal(uuid, uuid, text, int, date, boolean) from public, anon;
grant execute on function public.hr_save_goal(uuid, uuid, text, int, date, boolean) to authenticated;

-- ---- a goal: delete ----------------------------------------------------------
-- The goal says whose it is; that employee's row is then held and the caller
-- checked, and the goal is looked for again under the lock.

create or replace function public.hr_delete_goal(p_goal uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  owner_id uuid;
  emp public.hr_employees;
begin
  if auth.uid() is null then raise exception 'PERF_NOT_ALLOWED'; end if;
  select g.employee_id into owner_id from public.hr_goals g where g.id = p_goal;
  if not found then raise exception 'PERF_NOT_FOUND'; end if;
  emp := private.hr_perf_held_employee(owner_id, true);

  delete from public.hr_goals g where g.id = p_goal and g.employee_id = emp.id;
  if not found then raise exception 'PERF_NOT_FOUND'; end if;

  return jsonb_build_object('id', p_goal, 'employee_id', emp.id);
end; $$;
revoke all on function public.hr_delete_goal(uuid) from public, anon;
grant execute on function public.hr_delete_goal(uuid) to authenticated;

-- ---- a review: add or change a draft --------------------------------------------
-- p_review null adds a review of that employee; otherwise it changes that
-- review, which must be a review of that employee and still a draft. A new
-- review is always a draft.
--   period        `H1 <year>`, `H2 <year>` or `FY <year>`, the year 2000 to 2100;
--                 one review per employee per period.
--   competencies  exactly the four keys Delivery, Teamwork, Ownership and
--                 Communication, each a number from 1 to 5 in steps of 0.5.
--   score         their average, to two decimals. Worked out here, never given.
--   rating        exceeds, meets or below, as given.
--   comment       optional, up to 2,000 characters once trimmed.
-- The reviewer (id and name) and the date, today in Malaysia, are set from the
-- caller every time it is saved.
-- Refused, in this order: not a draft; anything above that is not as
-- described; another review of the employee already has the period.

create or replace function public.hr_save_review(
  p_employee uuid, p_review uuid, p_period text, p_competencies jsonb, p_rating text, p_comment text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  emp public.hr_employees;
  rev public.hr_reviews;
  note text := nullif(trim(p_comment), '');
  k text;
  v numeric;
  total numeric := 0;
  scores jsonb := '{}'::jsonb;
begin
  emp := private.hr_perf_held_employee(p_employee, false);
  if p_review is not null then
    select r.* into rev from public.hr_reviews r where r.id = p_review and r.employee_id = emp.id for update;
    if not found then raise exception 'PERF_NOT_FOUND'; end if;
    if rev.status <> 'draft' then raise exception 'PERF_NOT_DRAFT'; end if;
  end if;

  if p_period is null or p_period !~ '^(H1|H2|FY) (20[0-9][0-9]|2100)$'
     or p_rating is null or p_rating not in ('exceeds','meets','below')
     or char_length(note) > 2000
     or p_competencies is null or jsonb_typeof(p_competencies) <> 'object' then
    raise exception 'PERF_BAD_INPUT';
  end if;
  if (select count(*) from jsonb_object_keys(p_competencies)) <> 4 then raise exception 'PERF_BAD_INPUT'; end if;
  foreach k in array array['Delivery','Teamwork','Ownership','Communication'] loop
    if jsonb_typeof(p_competencies -> k) is distinct from 'number' then raise exception 'PERF_BAD_INPUT'; end if;
    v := (p_competencies ->> k)::numeric;
    if v < 1 or v > 5 or v * 2 <> trunc(v * 2) then
      raise exception 'PERF_BAD_INPUT';
    end if;
    total := total + v;
    scores := scores || jsonb_build_object(k, trim_scale(v));
  end loop;
  if exists (
    select 1 from public.hr_reviews r
    where r.employee_id = emp.id and r.period = p_period and r.id is distinct from p_review
  ) then
    raise exception 'PERF_REVIEW_EXISTS';
  end if;

  if p_review is null then
    insert into public.hr_reviews (org_id, employee_id, period, competencies, score, rating, comment,
      status, reviewer_id, reviewer_name, reviewed_at)
    values (emp.org_id, emp.id, p_period, scores, round(total / 4, 2), p_rating, note,
      'draft', auth.uid(), private.hr_perf_caller_name(emp.org_id), today)
    returning * into rev;
  else
    update public.hr_reviews r
    set period = p_period, competencies = scores, score = round(total / 4, 2), rating = p_rating, comment = note,
        reviewer_id = auth.uid(), reviewer_name = private.hr_perf_caller_name(emp.org_id), reviewed_at = today
    where r.id = rev.id
    returning r.* into rev;
  end if;

  return private.hr_review_json(rev);
end; $$;
revoke all on function public.hr_save_review(uuid, uuid, text, jsonb, text, text) from public, anon;
grant execute on function public.hr_save_review(uuid, uuid, text, jsonb, text, text) to authenticated;

-- ---- a review: release -------------------------------------------------------------
-- From now the employee reads it.

create or replace function public.hr_release_review(p_review uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rev public.hr_reviews;
begin
  rev := private.hr_perf_held_review(p_review);
  if rev.status <> 'draft' then raise exception 'PERF_NOT_DRAFT'; end if;

  update public.hr_reviews r set status = 'released', released_at = now()
  where r.id = rev.id
  returning r.* into rev;

  return private.hr_review_json(rev);
end; $$;
revoke all on function public.hr_release_review(uuid) from public, anon;
grant execute on function public.hr_release_review(uuid) to authenticated;

-- ---- a review: pull back to draft ---------------------------------------------------
-- The employee no longer reads it.

create or replace function public.hr_unrelease_review(p_review uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rev public.hr_reviews;
begin
  rev := private.hr_perf_held_review(p_review);
  if rev.status <> 'released' then raise exception 'PERF_NOT_RELEASED'; end if;

  update public.hr_reviews r set status = 'draft', released_at = null
  where r.id = rev.id
  returning r.* into rev;

  return private.hr_review_json(rev);
end; $$;
revoke all on function public.hr_unrelease_review(uuid) from public, anon;
grant execute on function public.hr_unrelease_review(uuid) to authenticated;

-- ---- a review: delete a draft ---------------------------------------------------------

create or replace function public.hr_delete_review(p_review uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rev public.hr_reviews;
begin
  rev := private.hr_perf_held_review(p_review);
  if rev.status <> 'draft' then raise exception 'PERF_NOT_DRAFT'; end if;

  delete from public.hr_reviews r where r.id = rev.id;

  return jsonb_build_object('id', rev.id, 'employee_id', rev.employee_id);
end; $$;
revoke all on function public.hr_delete_review(uuid) from public, anon;
grant execute on function public.hr_delete_review(uuid) to authenticated;
