-- The Lekir agent worker may read the hiring columns its scan reads.
--
-- The worker builds its snapshot (src/lib/hire/agent/) with the service-role
-- client. In this project service_role holds no table grants unless one is written
-- (see 20261015100000_agent_service_role_grants.sql), so without these grants every
-- run fails with permission denied.
--
-- Read only, and only these columns. The worker never reads a candidate's email,
-- phone, location, skills, headline or source; an application's CV, cover letter,
-- salary, rating, source or reject reason; an interview's notes or feedback text;
-- a job's description or salary; or a note's body or label.
set local lock_timeout = '5s';

-- Supabase grants service_role table privileges by default on fresh projects.
-- Remove those broad grants before adding the worker's column-level reads.
revoke all on
  public.hire_applications,
  public.hire_candidates,
  public.hire_interviews,
  public.hire_jobs,
  public.hire_agent_notes
  from service_role;

grant select (id, org_id, candidate_id, job_id, stage, outcome, applied_at, offered_at, hired_at)
  on public.hire_applications to service_role;
grant select (id, org_id, name, pool_status, created_at)
  on public.hire_candidates to service_role;
grant select (id, org_id, application_id, scheduled_at, status, created_at, updated_at, feedback_at)
  on public.hire_interviews to service_role;
grant select (id, org_id, title, status, opened_at, created_at, closes_on, headcount)
  on public.hire_jobs to service_role;
grant select (org_id, entity_type, entity_id, agent_proposal_id, created_at)
  on public.hire_agent_notes to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: every column granted above is readable, the private columns are
-- not, and service_role writes nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  missing text;
begin
  for r in
    select * from (values
      ('hire_applications', 'id,org_id,candidate_id,job_id,stage,outcome,applied_at,offered_at,hired_at'),
      ('hire_candidates', 'id,org_id,name,pool_status,created_at'),
      ('hire_interviews', 'id,org_id,application_id,scheduled_at,status,created_at,updated_at,feedback_at'),
      ('hire_jobs', 'id,org_id,title,status,opened_at,created_at,closes_on,headcount'),
      ('hire_agent_notes', 'org_id,entity_type,entity_id,agent_proposal_id,created_at')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into missing from unnest(string_to_array(r.cols, ',')) c
     where not has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if missing is not null then
      raise exception 'service_role may not read %.%', r.tbl, missing;
    end if;
    if has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'insert')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'update')
       or has_table_privilege('service_role', ('public.' || r.tbl)::regclass, 'delete') then
      raise exception 'service_role may write %', r.tbl;
    end if;
  end loop;
  -- Every private column the header names stays unreadable.
  select string_agg(v.tbl || '.' || v.col, ', ') into missing
    from (values
      ('hire_candidates', 'email'), ('hire_candidates', 'phone'), ('hire_candidates', 'headline'),
      ('hire_candidates', 'location'), ('hire_candidates', 'skills'), ('hire_candidates', 'source'),
      ('hire_applications', 'cv_url'), ('hire_applications', 'cv_path'), ('hire_applications', 'cover_letter'),
      ('hire_applications', 'portfolio_url'), ('hire_applications', 'expected_salary_cents'),
      ('hire_applications', 'rating'), ('hire_applications', 'source'), ('hire_applications', 'reject_reason'),
      ('hire_interviews', 'notes'), ('hire_interviews', 'feedback_rating'),
      ('hire_interviews', 'feedback_recommendation'), ('hire_interviews', 'feedback_comments'),
      ('hire_jobs', 'description'), ('hire_jobs', 'salary_min_cents'), ('hire_jobs', 'salary_max_cents'),
      ('hire_agent_notes', 'body'), ('hire_agent_notes', 'entity_label')
    ) v(tbl, col)
   where has_column_privilege('service_role', ('public.' || v.tbl)::regclass, v.col, 'select');
  if missing is not null then
    raise exception 'service_role may read private columns: %', missing;
  end if;
end $$;
