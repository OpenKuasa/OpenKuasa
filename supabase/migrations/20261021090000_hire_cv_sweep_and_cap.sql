-- supabase/migrations/20261021090000_hire_cv_sweep_and_cap.sql
-- Lekir CV files, two gaps closed.
--
-- 1. A file is stored before its application is recorded. If the server stops
--    between the two, cannot tell whether the application was kept, or fails to
--    remove a refused file, the file is held by nothing and nothing removed it.
--    The cleanup run now queues such files once they are an hour old.
-- 2. The daily limit was per workspace, and a workspace costs one confirmed
--    email to make, so the bucket as a whole had no ceiling. It has one now.

-- Queues every stored CV that no application holds and that is at least an hour
-- old (far longer than storing and recording take), for the cleanup run to
-- remove. Answers how many it queued.
create or replace function public.hire_cv_queue_orphans()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into private.hire_cv_deletions (path)
  select o.name
    from storage.objects o
   where o.bucket_id = 'hire-cvs'
     and o.created_at < now() - interval '1 hour'
     and not exists (select 1 from public.hire_applications a where a.cv_path = o.name)
  on conflict (path) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.hire_cv_queue_orphans() from public, anon, authenticated;
grant execute on function public.hire_cv_queue_orphans() to service_role;

-- True when this workspace may not be sent files: nobody with a real sign-in
-- owns it, or the bucket already holds 500 MB of CVs across every workspace.
-- Such a workspace still takes links. Asked by the server before it uploads.
create or replace function public.hire_cv_files_refused(p_org_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select not exists (
           select 1 from public.org_members m
             join auth.users u on u.id = m.user_id
            where m.org_id = p_org_id and m.role = 'owner' and u.is_anonymous is not true)
      or (select coalesce(sum((o.metadata ->> 'size')::bigint), 0)
            from storage.objects o
           where o.bucket_id = 'hire-cvs') >= 524288000;
$$;

-- True when the job has taken its 30 applications this minute, or its workspace
-- has taken 50 CV files in the last day (250 MB at most, half the bucket's
-- ceiling, so one workspace cannot use up everyone's room in a day).
create or replace function public.hire_apply_throttled(p_job_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select (select count(*) >= 30 from private.hire_apply_ticks t
           where t.job_id = p_job_id and t.at > now() - interval '1 minute')
      or (select count(*) >= 50 from public.hire_applications a
            join public.hire_jobs j on j.org_id = a.org_id
           where j.id = p_job_id and a.cv_path is not null
             and a.created_at > now() - interval '1 day');
$$;
