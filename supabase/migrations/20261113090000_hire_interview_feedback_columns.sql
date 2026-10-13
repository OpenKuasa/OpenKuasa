-- supabase/migrations/20261113090000_hire_interview_feedback_columns.sql
-- Lekir slice 4b, part 1 of 2: an interview can hold one feedback. Four
-- columns: a rating from 1 to 5, a recommendation (advance, hold or reject),
-- comments, and the time the feedback was last saved.
--
-- NOT safe to run twice: the second run fails at the first "add column". The
-- functions that write these columns are in 20261113090100, which can be run
-- again.
--
-- Existing rows: every column is nullable and has no default, so every
-- interview that exists has no feedback, and both table checks hold for it.
-- No row is changed here. The hourly demo refill names the columns it
-- inserts, and none of these, so it keeps working as it is and the demo
-- workspace shows no feedback.
--
-- Two checks hold the rules in the table itself, whoever writes to it:
-- feedback is whole (a rating and a recommendation together, with the time
-- they were saved; comments are optional), and only a completed interview has
-- any.
alter table public.hire_interviews
  add column feedback_rating smallint,
  add column feedback_recommendation text,
  add column feedback_comments text,
  add column feedback_at timestamptz,
  add constraint hire_interviews_feedback_rating_range check (feedback_rating between 1 and 5),
  add constraint hire_interviews_feedback_recommendation_known check (feedback_recommendation in ('advance', 'hold', 'reject')),
  add constraint hire_interviews_feedback_comments_length check (char_length(feedback_comments) <= 2000),
  add constraint hire_interviews_feedback_whole check ((feedback_at is null and feedback_rating is null and feedback_recommendation is null and feedback_comments is null) or (feedback_at is not null and feedback_rating is not null and feedback_recommendation is not null)),
  add constraint hire_interviews_feedback_when_completed check (feedback_at is null or status = 'completed');
