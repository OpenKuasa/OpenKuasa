-- supabase/migrations/20261101093000_rate_limits_cron.sql
-- Clears finished windows out of the attempt counter once an hour. Its own
-- migration so a pg_cron problem can never block the counter itself: without
-- this job the counter still works, and a key that keeps being used still
-- clears its own old windows; only keys never seen again would pile up.
create extension if not exists pg_cron;
select cron.schedule('rate-limits-sweep', '17 * * * *', $$select private.rate_limits_sweep()$$);
