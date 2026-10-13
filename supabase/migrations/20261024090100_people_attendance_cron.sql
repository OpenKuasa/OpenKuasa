-- The nightly close of attendance. Its own migration so a pg_cron problem can
-- never block the attendance functions. pg_cron keeps GMT here, so 16:05 is
-- 00:05 in Malaysia: just after the day ends, the days up to yesterday are
-- closed (absent, or on leave). The function works "today" out in Malaysia
-- time, skips the demo workspace, records nothing before the day the
-- attendance migration was applied, and leaves a workspace alone until the day
-- it first uses attendance, so this job is safe to schedule before anyone can
-- clock in. An employee is closed only from the night after the job first
-- finds them active and linked to an account.
create extension if not exists pg_cron;
select cron.schedule('close-attendance', '5 16 * * *', $$select private.hr_attendance_close()$$);
