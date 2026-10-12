-- supabase/migrations/20261113090100_hire_interview_feedback_writes.sql
-- Lekir slice 4b, part 2 of 2: a recruiter can record feedback on a completed
-- interview, replace it and clear it. Two functions are the only way: members
-- still have select only on hire_interviews. Each answers with a word and
-- never raises. A third function, from slice 4a, is replaced: an interview
-- that has feedback is not marked as scheduled again.
--
-- Safe to run again: it holds only "create or replace function", revokes and
-- grants. The columns these functions use are added in 20261113090000.
-- Do not run 20261107090100_hire_interviews_writes.sql again after this file: it would put back
-- the earlier hire_reopen_interview, which does not know about feedback.

-- ---------------------------------------------------------------------------
-- Record feedback on a completed interview, or replace it. A rating from 1 to
-- 5 and a recommendation are both required; comments are optional, and blank
-- comments are stored as none. Only the interview's row is locked and written:
-- nothing of its application is read, so a "reject" here rejects nothing.
--
-- p_mark_completed: a scheduled interview is marked completed and given its
-- feedback in the same write, both or neither.
-- p_replace: feedback that is already there is overwritten only when the
-- caller says so.
-- p_if_feedback_at: the caller says which version it saw (the time the
-- feedback was last saved). If that is no longer the stored one, even because
-- the feedback was cleared, nothing is saved.
--
-- Answers jsonb: { word } for a refusal, and { word: 'ok', replaced, completed }
-- when saved. Both come from the row as it was locked, never from what was
-- sent: replaced says feedback was there before this call, completed says this
-- call is what marked the interview completed. The sentence a person reads
-- rests on them.
-- ---------------------------------------------------------------------------
create or replace function public.hire_save_interview_feedback(
  p_interview_id uuid,
  p_rating integer,
  p_recommendation text,
  p_comments text,
  p_mark_completed boolean default false,
  p_replace boolean default false,
  p_if_feedback_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_status text;
  v_feedback_at timestamptz;
  v_comments text := nullif(regexp_replace(coalesce(p_comments, ''), '^\s+|\s+$', '', 'g'), '');
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  -- An id that is not there and one in a workspace the caller is not in read the same.
  if v_org is null or private.is_org_member(v_org) is not true then return jsonb_build_object('word', 'not_found'); end if;
  if private.is_org_writer(v_org) is not true then return jsonb_build_object('word', 'forbidden'); end if;

  select i.status, i.feedback_at into v_status, v_feedback_at
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return jsonb_build_object('word', 'not_found'); end if;

  -- The form says which version it saw. A null stored time (cleared meanwhile) differs from any version.
  if p_if_feedback_at is not null and p_if_feedback_at is distinct from v_feedback_at then return jsonb_build_object('word', 'changed'); end if;
  if v_status = 'scheduled' and p_mark_completed is not true then return jsonb_build_object('word', 'not_completed'); end if;
  -- A cancelled interview or a no-show did not take place, whatever was asked.
  if v_status not in ('scheduled', 'completed') then return jsonb_build_object('word', 'not_completed'); end if;
  if v_feedback_at is not null and p_replace is not true then return jsonb_build_object('word', 'has_feedback'); end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then return jsonb_build_object('word', 'invalid_rating'); end if;
  if p_recommendation is null or p_recommendation not in ('advance', 'hold', 'reject') then return jsonb_build_object('word', 'invalid_recommendation'); end if;
  if char_length(v_comments) > 2000 then return jsonb_build_object('word', 'invalid_comments'); end if;

  -- One write: there is never a completed interview missing the feedback that was typed with it. The time of the
  -- save is the clock's, read under the lock, so two saves that took turns never share one.
  update public.hire_interviews
     set status = 'completed', feedback_rating = p_rating::smallint, feedback_recommendation = p_recommendation,
         feedback_comments = v_comments, feedback_at = clock_timestamp(), updated_at = now()
   where id = p_interview_id;
  return jsonb_build_object('word', 'ok', 'replaced', v_feedback_at is not null, 'completed', v_status = 'scheduled');
end $$;

-- ---------------------------------------------------------------------------
-- Clear the feedback on an interview: the rating, the recommendation, the
-- comments and the saved time all go. The interview stays as it is.
-- ---------------------------------------------------------------------------
create or replace function public.hire_clear_interview_feedback(p_interview_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_feedback_at timestamptz;
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select i.feedback_at into v_feedback_at
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return 'not_found'; end if;
  if v_feedback_at is null then return 'no_feedback'; end if;

  update public.hire_interviews
     set feedback_rating = null, feedback_recommendation = null, feedback_comments = null, feedback_at = null,
         updated_at = now()
   where id = p_interview_id;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Mark a cancelled, completed or no-show interview as scheduled again, with
-- its time and details as they were. The time may be in the past.
-- Slice 4a's function, with one rule added: an interview that has feedback is
-- refused until the feedback is cleared, or a scheduled interview would carry
-- feedback.
-- ---------------------------------------------------------------------------
create or replace function public.hire_reopen_interview(p_interview_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_status text;
  v_has_feedback boolean;
begin
  select i.org_id into v_org from public.hire_interviews i where i.id = p_interview_id;
  if v_org is null or private.is_org_member(v_org) is not true then return 'not_found'; end if;
  if private.is_org_writer(v_org) is not true then return 'forbidden'; end if;

  select i.status, i.feedback_at is not null into v_status, v_has_feedback
    from public.hire_interviews i
   where i.id = p_interview_id
     for update;
  if not found then return 'not_found'; end if;
  if v_status = 'scheduled' then return 'not_closed'; end if;
  -- Only a completed interview can have feedback, so this is after the check above.
  if v_has_feedback then return 'has_feedback'; end if;

  -- Deliberately no duplicate check on this undo: it can leave two scheduled interviews of one application at
  -- the same instant. The owner accepted that; do not "fix" it by accident.
  update public.hire_interviews set status = 'scheduled', updated_at = now() where id = p_interview_id;
  return 'ok';
end $$;

revoke execute on function public.hire_save_interview_feedback(uuid, integer, text, text, boolean, boolean, timestamptz) from public, anon, service_role;
revoke execute on function public.hire_clear_interview_feedback(uuid) from public, anon, service_role;
revoke execute on function public.hire_reopen_interview(uuid) from public, anon, service_role;
grant execute on function public.hire_save_interview_feedback(uuid, integer, text, text, boolean, boolean, timestamptz) to authenticated;
grant execute on function public.hire_clear_interview_feedback(uuid) to authenticated;
grant execute on function public.hire_reopen_interview(uuid) to authenticated;
