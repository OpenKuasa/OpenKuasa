-- supabase/migrations/20261125200400_purge_demo_guests.sql
-- "Try the demo" signs a visitor in anonymously and adds them to the demo workspace. Nothing removed those
-- guest accounts, so thousands piled up. Once a day, at midnight Malaysia time (16:00 UTC), delete anonymous
-- accounts older than a day that belong to no workspace other than the demo. Their demo membership, free
-- question counts and the like go with them (those tables cascade). A guest still in the demo when their account
-- turns a day old is signed out and can start the demo again.
--
-- Never touched: anyone who is not anonymous, an anonymous account in any real workspace (with or without a slug), and an account named
-- on a decided agent proposal (that reference does not cascade, so deleting would fail the whole run).
-- At most `max_rows` per run, oldest first, so one run never holds locks for long.

create or replace function private.purge_demo_guests(max_rows integer default 5000)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  delete from auth.users u
   where u.id in (
     select g.id
       from auth.users g
      where g.is_anonymous
        and g.created_at < now() - interval '24 hours'
        and not exists (
          select 1 from public.org_members m join public.orgs o on o.id = m.org_id
           where m.user_id = g.id and o.slug is distinct from 'rimba-ventures-demo')
        and not exists (select 1 from public.agent_proposals p where p.decided_by = g.id)
      order by g.created_at
      limit greatest(max_rows, 0)
        for update skip locked);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function private.purge_demo_guests(integer) from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.schedule('purge-demo-guests', '0 16 * * *', $$select private.purge_demo_guests()$$);
