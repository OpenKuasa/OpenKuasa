-- supabase/migrations/20261029090100_hire_talent_pool_backfill.sql
-- Lekir slice 3d, ONE TIME ONLY: the people already added by hand with no job
-- go into the talent pool as Available. They are the ones not in the pool,
-- with no application of any kind, and not from the public apply form (its
-- applicants agreed to apply for one job, not to be kept for others).
--
-- Never run this file again after release: nothing stored says when someone
-- left the pool, so a second run would put back people a recruiter has since
-- removed. It is kept apart from the functions in 20261029090000 for that reason.
update public.hire_candidates c
   set pool_status = 'available'
 where c.pool_status = 'none'
   and not exists (select 1 from public.hire_applications a where a.candidate_id = c.id)
   and c.source is distinct from 'Careers page';
