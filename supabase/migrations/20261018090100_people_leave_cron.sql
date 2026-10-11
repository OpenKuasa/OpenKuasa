-- The new year's leave balances. Its own migration so a pg_cron problem can
-- never block the leave functions. 16:00 UTC on 31 December is midnight on
-- 1 January in Malaysia; the function works the year out in Malaysia time
-- (in UTC it is still the old year), and skips the demo workspace.
create extension if not exists pg_cron;
select cron.schedule('ensure-leave-balances', '0 16 31 12 *', $$select private.hr_ensure_leave_balances_all()$$);
