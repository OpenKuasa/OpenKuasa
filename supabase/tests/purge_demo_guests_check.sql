-- The daily demo-guest clean-up (private.purge_demo_guests) check.
-- Leaves nothing behind: the block always ends with RAISE, so every row below, and anything the clean-up deleted
-- while it ran, is rolled back. Read the message:
--   PURGE_DEMO_GUESTS_CHECK PASSED ...   or   PURGE_DEMO_GUESTS_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (the demo re-seed runs then).
do $$
declare
  demo uuid; real_org uuid := gen_random_uuid();
  old_guest uuid := gen_random_uuid();   -- anonymous, demo only, two days old: goes
  bare_guest uuid := gen_random_uuid();  -- anonymous, no workspace, two days old: goes
  new_guest uuid := gen_random_uuid();   -- anonymous, demo only, an hour old: stays
  kept_guest uuid := gen_random_uuid();  -- anonymous but in a real workspace, two days old: stays
  person uuid := gen_random_uuid();      -- a real account, two days old, also in the demo: stays
  n int; i int; fails text[] := '{}';
begin
  begin
  -- ---- the catalogue -------------------------------------------------------------------
  select count(*) into i from pg_proc p where p.oid = to_regprocedure('private.purge_demo_guests(integer)')
    and p.prosecdef and p.proconfig @> array['search_path=""']
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute');
  if i <> 1 then fails := fails || 'purge_demo_guests(integer) is not a definer function on an empty search path closed to signed-in and anonymous callers'::text; end if;
  select count(*) into i from cron.job where jobname = 'purge-demo-guests' and schedule = '0 16 * * *' and active
    and command = 'select private.purge_demo_guests()';
  if i <> 1 then fails := fails || 'the purge-demo-guests job is not scheduled daily at 16:00 UTC'::text; end if;

  -- ---- the people ----------------------------------------------------------------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null then fails := fails || 'no demo workspace to test with'::text; raise exception 'stop'; end if;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', null,
         case when u = new_guest then now() - interval '1 hour' else timestamptz '2000-01-01 00:00+00' end, now(), '{}'::jsonb, '{}'::jsonb, true
    from unnest(array[old_guest, bare_guest, new_guest, kept_guest]) u;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (person, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', person || '@purge-check.openkuasa-test.dev', '', now(),
          timestamptz '2000-01-01 00:00+00', now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (real_org, 'Purge Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values
    (demo, old_guest, 'viewer'), (demo, new_guest, 'viewer'), (demo, kept_guest, 'viewer'), (real_org, kept_guest, 'member'),
    (demo, person, 'viewer');

  -- ---- the clean-up --------------------------------------------------------------------
  -- The test accounts are dated 2000, so they come first in the oldest-first order.
  n := private.purge_demo_guests(100000);
  if n < 2 then fails := fails || format('the clean-up removed %s accounts; it should have removed at least the 2 old guests', n); end if;
  if exists (select 1 from auth.users where id = old_guest) then fails := fails || 'an old demo guest was kept'::text; end if;
  if exists (select 1 from auth.users where id = bare_guest) then fails := fails || 'an old guest with no workspace was kept'::text; end if;
  if exists (select 1 from public.org_members where user_id = old_guest) then fails := fails || 'a removed guest kept their demo membership'::text; end if;
  if not exists (select 1 from auth.users where id = new_guest) then fails := fails || 'a guest under a day old was removed'::text; end if;
  if not exists (select 1 from auth.users where id = kept_guest) then fails := fails || 'an anonymous account in a real workspace was removed'::text; end if;
  if not exists (select 1 from auth.users where id = person) then fails := fails || 'a real account was removed'::text; end if;
  if not exists (select 1 from public.orgs where id = real_org) then fails := fails || 'a real workspace was removed'::text; end if;
  if not exists (select 1 from public.orgs where id = demo) then fails := fails || 'the demo workspace was removed'::text; end if;
  if private.purge_demo_guests(0) <> 0 then fails := fails || 'a limit of 0 still removed accounts'::text; end if;

  raise exception 'done';
  exception when others then
    if sqlerrm not in ('done', 'stop') then fails := fails || ('error: ' || sqlerrm); end if;
  end;
  if cardinality(fails) = 0 then
    raise exception 'PURGE_DEMO_GUESTS_CHECK PASSED (old guests removed; new guests, real accounts and real workspaces kept)';
  end if;
  raise exception 'PURGE_DEMO_GUESTS_CHECK FAILED (%): %', cardinality(fails), array_to_string(fails, ' | ');
end $$;
