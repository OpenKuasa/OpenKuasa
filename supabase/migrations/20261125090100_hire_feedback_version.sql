-- supabase/migrations/20261125090100_hire_feedback_version.sql
-- Clearing interview feedback can now say which version the caller saw, as
-- saving it already can. The assistant's Approve card and the screen's clear
-- confirm show the feedback that will be cleared; if a colleague saved new
-- feedback after that, the clear is refused ('changed') instead of removing
-- feedback nobody looked at.
--
-- The function gains one parameter with a default, so a call that sends only
-- p_interview_id works as before. The one-argument function is dropped first:
-- leaving it beside the new one would make every one-argument call ambiguous.
-- Safe to run again. Do not run 20261113090100_hire_interview_feedback_writes.sql
-- again after this file: it would put the one-argument function back beside this one.

drop function if exists public.hire_clear_interview_feedback(uuid);

-- ---------------------------------------------------------------------------
-- Clear the feedback on an interview: the rating, the recommendation, the
-- comments and the saved time all go. The interview stays as it is.
-- p_if_feedback_at: the time the feedback the caller saw was last saved. If
-- the stored one is another, nothing is cleared. Feedback that is already gone
-- answers 'no_feedback' first: what the caller wanted is already true.
-- ---------------------------------------------------------------------------
create or replace function public.hire_clear_interview_feedback(
  p_interview_id uuid,
  p_if_feedback_at timestamptz default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_feedback_at timestamptz;
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  -- An id that is not there and one in a workspace the caller is not in read the same.
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select i.feedback_at into v_feedback_at
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return 'not_found'; end if;
  if v_feedback_at is null then return 'no_feedback'; end if;
  -- Compared to the microsecond: the caller sends the time exactly as it read it.
  if p_if_feedback_at is not null and p_if_feedback_at is distinct from v_feedback_at then return 'changed'; end if;

  update public.hire_interviews
     set feedback_rating = null, feedback_recommendation = null, feedback_comments = null, feedback_at = null,
         updated_at = now()
   where id = p_interview_id;
  return 'ok';
end $$;

revoke execute on function public.hire_clear_interview_feedback(uuid, timestamptz) from public, anon, service_role;
grant execute on function public.hire_clear_interview_feedback(uuid, timestamptz) to authenticated;
