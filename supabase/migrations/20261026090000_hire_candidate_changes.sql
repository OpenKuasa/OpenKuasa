-- supabase/migrations/20261026090000_hire_candidate_changes.sql
-- Lekir slice 3b: a recruiter can add a candidate by hand and edit a candidate.
-- Three functions are the only way. Members get no write on either table, and
-- only the server may attach a stored file to an application.

-- One line of text: runs of spaces, tabs and line breaks become one space. Blank is null.
create or replace function private.hire_one_line(p_text text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), '');
$$;
revoke execute on function private.hire_one_line(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Add a candidate by hand, with an application to a job when one is given.
-- An email the workspace already has finds that candidate and changes nothing
-- on them. Takes the public apply form's lock, so the two cannot make the same
-- person twice.
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
    values (p_org_id, v_name, v_email, v_phone, v_headline, v_location, v_skills, v_source, 'none')
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

-- ---------------------------------------------------------------------------
-- Edit a candidate's details. Only the fields named in p_changes are touched;
-- a null or blank value clears one (a name cannot be cleared). The pool
-- status and the candidate's applications are never changed here.
-- ---------------------------------------------------------------------------
create or replace function public.hire_update_candidate(p_candidate_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_fields constant text[] := array['name','email','phone','headline','location','skills','source'];
  v_org uuid;
  v_row public.hire_candidates%rowtype;
  v_name text;
  v_email text;
  v_phone text;
  v_headline text;
  v_location text;
  v_source text;
  v_skills text[];
begin
  select c.org_id into v_org from public.hire_candidates c where c.id = p_candidate_id;
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    return jsonb_build_object('word', 'invalid_changes');
  end if;
  if exists (select 1 from jsonb_object_keys(p_changes) as k(key) where k.key <> all (c_fields)) then
    return jsonb_build_object('word', 'invalid_changes');
  end if;

  -- The new email's lock is taken before the row's, the same order as an add.
  if p_changes ? 'email' then
    v_email := lower(private.hire_one_line(p_changes ->> 'email'));
    if char_length(v_email) > 254 then return jsonb_build_object('word', 'too_long'); end if;
    if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      return jsonb_build_object('word', 'invalid_email');
    end if;
    if v_email is not null then
      perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_email, 0));
    end if;
  end if;

  select c.* into v_row from public.hire_candidates c where c.id = p_candidate_id for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;

  if p_changes ? 'email' then
    if v_email is not null and exists (
         select 1 from public.hire_candidates o
          where o.org_id = v_org and o.id <> p_candidate_id and lower(o.email) = v_email) then
      return jsonb_build_object('word', 'email_taken');
    end if;
  else
    v_email := v_row.email;
  end if;

  v_name := case when p_changes ? 'name' then private.hire_one_line(p_changes ->> 'name') else v_row.name end;
  if v_name is null then return jsonb_build_object('word', 'invalid_name'); end if;
  v_phone := case when p_changes ? 'phone' then private.hire_one_line(p_changes ->> 'phone') else v_row.phone end;
  v_headline := case when p_changes ? 'headline' then private.hire_one_line(p_changes ->> 'headline') else v_row.headline end;
  v_location := case when p_changes ? 'location' then private.hire_one_line(p_changes ->> 'location') else v_row.location end;
  v_source := case when p_changes ? 'source' then private.hire_one_line(p_changes ->> 'source') else v_row.source end;
  if char_length(v_name) > 120 or char_length(v_phone) > 40 or char_length(v_headline) > 160
     or char_length(v_location) > 120 or char_length(v_source) > 60 then
    return jsonb_build_object('word', 'too_long');
  end if;

  if p_changes ? 'skills' then
    if jsonb_typeof(p_changes -> 'skills') not in ('array', 'null') then
      return jsonb_build_object('word', 'invalid_changes');
    end if;
    select coalesce(array_agg(x.s order by x.ord), '{}'::text[]) into v_skills
      from (select btrim(u.t) as s, min(u.ord) as ord
              from jsonb_array_elements_text(
                     case when jsonb_typeof(p_changes -> 'skills') = 'array' then p_changes -> 'skills' else '[]'::jsonb end
                   ) with ordinality as u(t, ord)
             where btrim(u.t) <> ''
             group by btrim(u.t)) x;
    if coalesce(array_length(v_skills, 1), 0) > 20
       or exists (select 1 from unnest(v_skills) as s(v) where char_length(s.v) > 40) then
      return jsonb_build_object('word', 'too_long');
    end if;
  else
    v_skills := v_row.skills;
  end if;

  update public.hire_candidates
     set name = v_name, email = v_email, phone = v_phone, headline = v_headline,
         location = v_location, source = v_source, skills = v_skills
   where id = p_candidate_id;
  return jsonb_build_object('word', 'ok');
end $$;

-- ---------------------------------------------------------------------------
-- Attach a stored CV to an application that has none. The server only: it has
-- just stored the file under this application's own workspace and job.
-- ---------------------------------------------------------------------------
create or replace function public.hire_attach_cv(p_application_id uuid, p_cv_path text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_job uuid;
  v_path text;
  v_consented timestamptz;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return 'forbidden'; end if;

  select a.org_id, a.job_id, a.cv_path, a.consented_at into v_org, v_job, v_path, v_consented
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return 'not_found'; end if;
  if v_path is not null then return 'already_attached'; end if;
  -- Only an application added by hand: one an applicant sent themselves carries their consent date.
  if v_consented is not null then return 'not_by_hand'; end if;
  if (p_cv_path ~ ('^' || v_org::text || '/' || v_job::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$')) is not true then
    return 'invalid_path';
  end if;

  begin
    update public.hire_applications set cv_path = p_cv_path where id = p_application_id;
  exception when unique_violation then
    -- Another application already holds this file.
    return 'invalid_path';
  end;
  return 'ok';
end $$;

revoke execute on function public.hire_add_candidate(uuid, text, text, text, text, text, text[], text, uuid, text, text) from public, anon, service_role;
revoke execute on function public.hire_update_candidate(uuid, jsonb) from public, anon, service_role;
revoke execute on function public.hire_attach_cv(uuid, text) from public, anon, authenticated;
grant execute on function public.hire_add_candidate(uuid, text, text, text, text, text, text[], text, uuid, text, text) to authenticated;
grant execute on function public.hire_update_candidate(uuid, jsonb) to authenticated;
grant execute on function public.hire_attach_cv(uuid, text) to service_role;
