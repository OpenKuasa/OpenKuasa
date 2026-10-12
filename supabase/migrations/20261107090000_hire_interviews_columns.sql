-- supabase/migrations/20261107090000_hire_interviews_columns.sql
-- Lekir slice 4a, part 1 of 2: the interviews table gains a length, a place or
-- link, notes for the team and the time of its last change. The interviewer's
-- name gets a length limit.
--
-- NOT safe to run twice: the second run fails at the first "add column". The
-- functions that write to this table are in 20261107090100, which can be run
-- again.
--
-- Existing rows: only the demo workspace has any. Each gets 60 minutes, no
-- place and no notes from the defaults. The update below sets "last changed"
-- to the time the row was created, in place of the time this file ran. The
-- hourly demo refill names the columns it inserts, so it keeps working as it
-- is; the rows it makes get the same defaults.
alter table public.hire_interviews
  add column duration_minutes smallint not null default 60,
  add column place text,
  add column notes text,
  add column updated_at timestamptz not null default now(),
  add constraint hire_interviews_duration_range check (duration_minutes between 15 and 480),
  add constraint hire_interviews_place_length check (char_length(place) <= 300),
  add constraint hire_interviews_notes_length check (char_length(notes) <= 2000),
  add constraint hire_interviews_interviewer_name_length check (char_length(interviewer_name) <= 120);

update public.hire_interviews set updated_at = created_at;
