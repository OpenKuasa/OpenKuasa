-- supabase/migrations/20261028090000_hire_deletions.sql
-- Lekir slice 3c: a recruiter can delete an application, or a candidate with
-- everything held about them. Two functions are the only way: members get no
-- delete on any hiring table. Nothing here touches a stored file: the trigger
-- hire_applications_cv_deleted queues the CV of every application that goes,
-- cascades included, and the cleanup run removes it.

-- ---------------------------------------------------------------------------
-- Delete one application, at any stage. Its interviews go by the cascade and
-- its CV file is queued by the trigger. The candidate is not touched.
-- ---------------------------------------------------------------------------
create or replace function public.hire_delete_application(p_application_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_candidate uuid;
  v_job uuid;
  v_path text;
  v_name text;
  v_title text;
  v_interviews integer;
begin
  select a.org_id into v_org from public.hire_applications a where a.id = p_application_id;
  -- An id that is not there and one in a workspace the caller is not in read the same.
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  select a.candidate_id, a.job_id, a.cv_path into v_candidate, v_job, v_path
    from public.hire_applications a
   where a.id = p_application_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;

  -- What goes, worked out before it goes: afterwards there is nothing left to read.
  select c.name into v_name from public.hire_candidates c where c.id = v_candidate;
  select j.title into v_title from public.hire_jobs j where j.id = v_job;
  select count(*)::integer into v_interviews
    from public.hire_interviews i where i.application_id = p_application_id;

  delete from public.hire_applications where id = p_application_id;

  return jsonb_build_object(
    'word', 'ok', 'name', coalesce(v_name, ''), 'job', coalesce(v_title, ''),
    'applications', 1, 'interviews', v_interviews,
    'cv_files', case when v_path is null then 0 else 1 end);
end $$;

-- ---------------------------------------------------------------------------
-- Delete one candidate with every application, interview and CV file of
-- theirs. Takes the lock the public apply form and the hand-add take
-- (workspace and lowercased email), before the row: both of those find a
-- candidate by email and then insert an application for it, and a delete
-- between those two steps would make the insert fail on its foreign key.
-- ---------------------------------------------------------------------------
create or replace function public.hire_delete_candidate(p_candidate_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_email text;
  v_locked_email text;
  v_name text;
  v_ids uuid[];
  v_applications integer;
  v_cv_files integer;
  v_interviews integer;
begin
  select c.org_id, lower(c.email) into v_org, v_email
    from public.hire_candidates c where c.id = p_candidate_id;
  if v_org is null or private.is_org_member(v_org) is not true then
    return jsonb_build_object('word', 'not_found');
  end if;
  if private.is_org_writer(v_org) is not true then
    return jsonb_build_object('word', 'forbidden');
  end if;

  -- A candidate with no email cannot be found by either way of applying: no lock is needed.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_email, 0));
  end if;

  select c.name, lower(c.email) into v_name, v_locked_email
    from public.hire_candidates c
   where c.id = p_candidate_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;
  -- Someone edited the email between the read and the lock: the lock held is for the
  -- old address, and taking another one now, after the row, could deadlock with an edit.
  if v_locked_email is distinct from v_email then
    return jsonb_build_object('word', 'changed');
  end if;

  -- The applications are locked so a move or a rating in flight finishes first, and counted
  -- before the cascade removes them. No new one can arrive: the candidate's row is locked.
  perform 1 from public.hire_applications a where a.candidate_id = p_candidate_id order by a.id for update;
  select coalesce(array_agg(a.id), '{}'::uuid[]), count(*)::integer, count(a.cv_path)::integer
    into v_ids, v_applications, v_cv_files
    from public.hire_applications a
   where a.candidate_id = p_candidate_id;
  select count(*)::integer into v_interviews
    from public.hire_interviews i where i.application_id = any(v_ids);

  delete from public.hire_candidates where id = p_candidate_id;

  return jsonb_build_object(
    'word', 'ok', 'name', coalesce(v_name, ''),
    'applications', v_applications, 'interviews', v_interviews, 'cv_files', v_cv_files);
end $$;

revoke execute on function public.hire_delete_application(uuid) from public, anon, service_role;
revoke execute on function public.hire_delete_candidate(uuid) from public, anon, service_role;
grant execute on function public.hire_delete_application(uuid) to authenticated;
grant execute on function public.hire_delete_candidate(uuid) to authenticated;
