-- supabase/migrations/20261029090000_hire_talent_pool.sql
-- Lekir slice 3d: the talent pool. Two functions are the only way to change a
-- candidate's pool status; members still have select only. hire_add_candidate
-- is replaced with one expression changed. The one-time move of the people
-- already added by hand with no job is the next migration, a file of its own.

-- ---------------------------------------------------------------------------
-- Set a candidate's pool status: add (from none), change, or remove (to none).
-- With p_only_if_outside, someone already in the pool is refused and left as
-- they are: an "Add to pool" pressed on a stale screen must not overwrite.
-- ---------------------------------------------------------------------------
create or replace function public.hire_set_pool_status(
  p_candidate_id uuid,
  p_status text,
  p_only_if_outside boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_from text;
begin
  select c.org_id into v_org from public.hire_candidates c where c.id = p_candidate_id;
  -- An id that is not there and one in a workspace the caller is not in read the same.
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  if p_status is null or p_status not in ('none', 'available', 'passive', 're_engaged')
     or (p_only_if_outside is true and p_status = 'none') then
    return jsonb_build_object('word', 'invalid_status');
  end if;

  select c.pool_status into v_from
    from public.hire_candidates c
   where c.id = p_candidate_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;

  if p_only_if_outside is true and v_from <> 'none' then
    return jsonb_build_object('word', 'already_in_pool', 'from', v_from);
  end if;
  if v_from = p_status then
    return jsonb_build_object('word', 'same_status', 'from', v_from);
  end if;

  update public.hire_candidates set pool_status = p_status where id = p_candidate_id;
  return jsonb_build_object('word', 'ok', 'from', v_from, 'to', p_status);
end $$;

-- ---------------------------------------------------------------------------
-- Move a pool member to the pipeline: one application by hand at Applied for
-- an open or paused job, and the pool status becomes re_engaged. Locks in the
-- order the public apply form and the hand-add use: the job's row, then the
-- workspace-and-email lock, then the candidate's row. If the person already
-- has an application to that job, nothing is changed, the pool status included.
-- ---------------------------------------------------------------------------
create or replace function public.hire_move_to_pipeline(p_candidate_id uuid, p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_email text;
  v_status text;
  v_from text;
  v_source text;
  v_application_id uuid;
  v_outcome text;
begin
  select c.org_id, lower(c.email) into v_org, v_email
    from public.hire_candidates c where c.id = p_candidate_id;
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  -- Held as it is until this ends: it cannot be closed or deleted halfway through.
  select j.status into v_status
    from public.hire_jobs j
   where j.id = p_job_id and j.org_id = v_org
     for share;
  if v_status is null then return jsonb_build_object('word', 'job_not_found'); end if;
  if v_status not in ('open', 'paused') then return jsonb_build_object('word', 'job_not_open'); end if;

  -- The public form's lock, so this and an application from the same person take turns.
  -- A candidate with no email cannot be found by the form: no lock is needed.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_email, 0));
  end if;

  select c.pool_status, c.source into v_from, v_source
    from public.hire_candidates c
   where c.id = p_candidate_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;
  if v_from = 'none' then return jsonb_build_object('word', 'not_in_pool'); end if;

  insert into public.hire_applications
    (org_id, candidate_id, job_id, stage, outcome, source)
  values
    (v_org, p_candidate_id, p_job_id, 'applied', 'active', coalesce(private.hire_one_line(v_source), 'Added by hand'))
  on conflict (candidate_id, job_id) do nothing
  returning id into v_application_id;

  if v_application_id is null then
    select a.id, a.outcome into v_application_id, v_outcome
      from public.hire_applications a
     where a.candidate_id = p_candidate_id and a.job_id = p_job_id;
    return jsonb_build_object('word', 'already_applied', 'application_id', v_application_id, 'outcome', v_outcome);
  end if;

  update public.hire_candidates set pool_status = 're_engaged' where id = p_candidate_id;
  return jsonb_build_object('word', 'ok', 'application_id', v_application_id, 'from', v_from, 'to', 're_engaged');
end $$;

-- ---------------------------------------------------------------------------
-- Add a candidate by hand. Copied whole from 20261026090000: the one change is
-- that a NEW candidate saved with no job goes into the talent pool as
-- available, so nobody added by hand is on no screen. A candidate already on
-- file is still left exactly as they are.
-- ---------------------------------------------------------------------------
create or replace function public.hire_add_candidate(
  p_org_id uuid,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_headline text default null,
  p_location text default null,
  p_skills text[] default null,
  p_source text default null,
  p_job_id uuid default null,
  p_cover_letter text default null,
  p_cv_url text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.hire_one_line(p_name);
  v_email text := lower(private.hire_one_line(p_email));
  v_phone text := private.hire_one_line(p_phone);
  v_headline text := private.hire_one_line(p_headline);
  v_location text := private.hire_one_line(p_location);
  v_source text := coalesce(private.hire_one_line(p_source), 'Added by hand');
  v_cover text := nullif(regexp_replace(coalesce(p_cover_letter, ''), '^\s+|\s+$', '', 'g'), '');
  v_cv text := nullif(btrim(coalesce(p_cv_url, '')), '');
  v_skills text[];
  v_status text;
  v_candidate_id uuid;
  v_application_id uuid;
  v_candidate text := 'created';
  v_application text := 'none';
begin
  -- Without a job there is no application to hold a cover note or a CV link: they are dropped.
  if p_job_id is null then
    v_cover := null;
    v_cv := null;
  end if;

  if p_org_id is null or private.is_org_member(p_org_id) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(p_org_id) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  if v_name is null then return jsonb_build_object('word', 'invalid_name'); end if;
  if char_length(v_name) > 120 or char_length(v_email) > 254 or char_length(v_phone) > 40
     or char_length(v_headline) > 160 or char_length(v_location) > 120 or char_length(v_source) > 60
     or char_length(v_cover) > 4000 or char_length(v_cv) > 500 then
    return jsonb_build_object('word', 'too_long');
  end if;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return jsonb_build_object('word', 'invalid_email');
  end if;
  if v_cv is not null and v_cv !~ '^https?://[^\s]+$' then
    return jsonb_build_object('word', 'invalid_url');
  end if;

  -- Skills: trimmed, blanks and repeats dropped, in the order given.
  select coalesce(array_agg(x.s order by x.ord), '{}'::text[]) into v_skills
    from (select btrim(u.t) as s, min(u.ord) as ord
            from unnest(coalesce(p_skills, '{}'::text[])) with ordinality as u(t, ord)
           where btrim(u.t) <> ''
           group by btrim(u.t)) x;
  if coalesce(array_length(v_skills, 1), 0) > 20
     or exists (select 1 from unnest(v_skills) as s(v) where char_length(s.v) > 40) then
    return jsonb_build_object('word', 'too_long');
  end if;

  -- The job is checked before anything is written: a refused add leaves nothing behind.
  if p_job_id is not null then
    select j.status into v_status
      from public.hire_jobs j
     where j.id = p_job_id and j.org_id = p_org_id
       for share;
    if v_status is null then return jsonb_build_object('word', 'job_not_found'); end if;
    if v_status not in ('open', 'paused') then return jsonb_build_object('word', 'job_not_open'); end if;
  end if;

  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_email, 0));
    select c.id into v_candidate_id
      from public.hire_candidates c
     where c.org_id = p_org_id and lower(c.email) = v_email;
  end if;

  if v_candidate_id is null then
    insert into public.hire_candidates (org_id, name, email, phone, headline, location, skills, source, pool_status)
    -- THE ONE CHANGE: with no job, the new person goes into the talent pool.
    values (p_org_id, v_name, v_email, v_phone, v_headline, v_location, v_skills, v_source, case when p_job_id is null then 'available' else 'none' end)
    returning id into v_candidate_id;
  else
    -- A candidate already on file is left exactly as they are.
    v_candidate := 'existing';
  end if;

  if p_job_id is not null then
    insert into public.hire_applications
      (org_id, candidate_id, job_id, stage, outcome, source, cover_letter, cv_url)
    values
      (p_org_id, v_candidate_id, p_job_id, 'applied', 'active', v_source, v_cover, v_cv)
    on conflict (candidate_id, job_id) do nothing
    returning id into v_application_id;
    if v_application_id is not null then
      v_application := 'created';
    else
      v_application := 'existing';
      select a.id into v_application_id
        from public.hire_applications a
       where a.candidate_id = v_candidate_id and a.job_id = p_job_id;
    end if;
  end if;

  return jsonb_build_object(
    'word', 'ok', 'candidate_id', v_candidate_id, 'application_id', v_application_id,
    'candidate', v_candidate, 'application', v_application);
end $$;

revoke execute on function public.hire_set_pool_status(uuid, text, boolean) from public, anon, service_role;
revoke execute on function public.hire_move_to_pipeline(uuid, uuid) from public, anon, service_role;
revoke execute on function public.hire_add_candidate(uuid, text, text, text, text, text, text[], text, uuid, text, text) from public, anon, service_role;
grant execute on function public.hire_set_pool_status(uuid, text, boolean) to authenticated;
grant execute on function public.hire_move_to_pipeline(uuid, uuid) to authenticated;
grant execute on function public.hire_add_candidate(uuid, text, text, text, text, text, text[], text, uuid, text, text) to authenticated;

-- The people already added by hand with no job are moved into the pool by the next
-- migration, 20261029090100_hire_talent_pool_backfill.sql. It is a file of its own so
-- that running these functions again can never repeat a change to people's records.
