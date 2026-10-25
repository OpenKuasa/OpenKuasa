-- Web Push (subscriptions, outbox, queuing trigger) and approval routing check.
-- Leaves nothing behind: the block always ends with RAISE, so every row and helper below is rolled back.
--   PUSH_NOTIFICATIONS_CHECK PASSED ...   or   PUSH_NOTIFICATIONS_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (the demo re-seed runs then).
-- g(who, q) runs q as one signed-in person: a statement gives ok / none / denied, a call gives =<json> or the
-- refusal. t(who, label, q, want) is g compared with want ('*' = it must go through). told() lists, then
-- clears, who of the planted people was sent what: "name:event" sorted, comma separated.
do $$
declare
  org uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); adm2 uuid := gen_random_uuid(); mgr uuid := gen_random_uuid();
  rep uuid := gen_random_uuid(); rep2 uuid := gen_random_uuid(); lone uuid := gen_random_uuid(); lone2 uuid := gen_random_uuid();
  vwr uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uq uuid := gen_random_uuid();
  anon_u uuid := gen_random_uuid(); demo_u uuid := gen_random_uuid();
  e_own uuid := gen_random_uuid(); e_mgr uuid := gen_random_uuid(); e_rep uuid := gen_random_uuid(); e_rep2 uuid := gen_random_uuid();
  e_lone uuid := gen_random_uuid(); e_lone2 uuid := gen_random_uuid(); e_unl uuid := gen_random_uuid(); e_adm uuid := gen_random_uuid();
  st uuid := gen_random_uuid(); sw uuid;
  ep text := 'https://fcm.googleapis.com/fcm/send/check-' || gen_random_uuid();
  s1 uuid; s2 uuid; sq uuid; sq2 uuid; n1 uuid; ob bigint; a text; c int; i int; r record; fails text[] := '{}';
begin
  begin
  -- ---- 0. the catalogue ----------------------------------------------------------------------------------
  if not (select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'private.push_outbox'::regclass) then
    fails := fails || 'row level security is off on push_subscriptions or push_outbox'::text;
  end if;
  select string_agg(p.policyname || ':' || p.cmd || ':' || array_to_string(p.roles, '/'), ',' order by p.policyname) into a
  from pg_policies p where p.schemaname = 'public' and p.tablename = 'push_subscriptions' and p.qual like '%auth.uid()%';
  if a is distinct from 'push_subscriptions_delete:DELETE:authenticated,push_subscriptions_select:SELECT:authenticated'
     or (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'push_subscriptions') <> 2
     or exists (select 1 from pg_policies p where p.schemaname = 'private' and p.tablename = 'push_outbox') then
    fails := fails || format('push_subscriptions should hold just the own-row select and delete rules, the outbox none: got %s', a);
  end if;
  if not has_table_privilege('authenticated', 'public.push_subscriptions', 'SELECT') or not has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE')
     or has_table_privilege('authenticated', 'public.push_subscriptions', 'INSERT') or has_table_privilege('authenticated', 'public.push_subscriptions', 'UPDATE')
     or has_table_privilege('anon', 'public.push_subscriptions', 'SELECT') or has_table_privilege('anon', 'public.push_subscriptions', 'INSERT')
     or has_table_privilege('authenticated', 'private.push_outbox', 'SELECT') or has_table_privilege('anon', 'private.push_outbox', 'SELECT') then
    fails := fails || 'signed-in users should read and delete push_subscriptions only, and nobody but the sender touch the outbox'::text;
  end if;
  -- The sender works only through push_pending and push_result: it holds no grant on the tables or the schema.
  select count(*) into i from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) priv
  where has_table_privilege('service_role', 'private.push_outbox', priv) or has_table_privilege('service_role', 'public.push_subscriptions', priv)
     or has_table_privilege('service_role', 'public.notifications', priv);
  select count(*) into c from pg_attribute a where a.attrelid = 'public.notifications'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege('service_role', 'public.notifications', a.attname::text, 'SELECT');
  if i <> 0 or c <> 0 or has_schema_privilege('service_role', 'private', 'USAGE') then
    fails := fails || format('the sender holds %s table privileges and %s notification columns, or usage on private: it should hold none', i, c);
  end if;
  if (select count(*) from information_schema.columns k where k.table_schema = 'private' and k.table_name = 'push_outbox' and k.column_name = 'claimed_at'
        and k.data_type = 'timestamp with time zone' and k.is_nullable = 'YES') <> 1 then
    fails := fails || 'the outbox has no nullable claimed_at'::text;
  end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.push_subscribe(text,text,text,text)'), to_regprocedure('public.push_unsubscribe(text)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute');
  if i <> 2 then fails := fails || format('%s of 2 subscribe functions are definer functions on a fixed search path for signed-in users only', i); end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.push_pending(integer)'), to_regprocedure('public.push_result(bigint,text)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute');
  if i <> 2 then fails := fails || format('%s of 2 sender functions are definer functions on a fixed search path for the service role only', i); end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('private.push_queue_notification()'), to_regprocedure('private.hr_notify_request_filed(uuid,uuid,text)'),
      to_regprocedure('private.hr_notify_swap(uuid,text)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute');
  if i <> 3 then fails := fails || format('%s of 3 private functions are definer functions on a fixed search path that no signed-in user may call', i); end if;
  select count(*) into i from pg_trigger g where g.tgrelid = 'public.notifications'::regclass and g.tgname = 'notifications_push_queue' and not g.tgisinternal
    and g.tgenabled = 'O' and g.tgtype = 5 and g.tgfoid = to_regprocedure('private.push_queue_notification()');
  if i <> 1 then fails := fails || 'the queuing trigger is not an after-insert row trigger on notifications'::text; end if;
  select count(*) into i from pg_constraint k where k.contype = 'u' and (
      (k.conrelid = 'public.push_subscriptions'::regclass and k.conkey = array[(select attnum from pg_attribute where attrelid = k.conrelid and attname = 'endpoint')])
   or (k.conrelid = 'private.push_outbox'::regclass and pg_get_constraintdef(k.oid) = 'UNIQUE (subscription_id, notification_id)'));
  select count(*) into c from pg_constraint k where k.contype = 'f' and k.confdeltype = 'c' and k.conrelid in ('public.push_subscriptions'::regclass, 'private.push_outbox'::regclass);
  if i <> 2 or c <> 3 then fails := fails || format('unique endpoint / unique queue item: %s of 2; foreign keys that cascade: %s of 3', i, c); end if;
  if cardinality(fails) > 0 then raise exception 'stop'; end if;

  -- ---- helpers -------------------------------------------------------------------------------------------
  execute $f$
    create function pg_temp.g(who uuid, q text) returns text language plpgsql as $b$
    declare r jsonb; got text; n int;
    begin
      perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', case when who is not null then 'aal1' end))::text, true);
      set local role authenticated;
      begin
        if q ~ '^(insert|update|delete) ' then execute q; get diagnostics n = row_count; got := case when n > 0 then 'ok' else 'none' end;
        else execute 'select to_jsonb(' || q || ')' into r; got := '=' || coalesce(r::text, 'null'); end if;
      exception when insufficient_privilege then got := 'denied'; when others then got := sqlerrm; end;
      reset role;
      perform set_config('request.jwt.claims', '', true);
      return got;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.t(who uuid, label text, q text, want text) returns text[] language plpgsql as $b$
    declare got text := pg_temp.g(who, q);
    begin
      if got = want or (want = '*' and left(got, 1) = '=') then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
    end $b$
  $f$;
  create temp table pn_cast (name text, uid uuid) on commit drop;
  execute $f$
    create function pg_temp.told() returns text language plpgsql as $b$
    declare out text;
    begin
      select coalesce(string_agg(c.name || ':' || n.event, ',' order by c.name, n.event), '') into out from public.notifications n join pn_cast c on c.uid = n.user_id;
      delete from public.notifications n using pn_cast c where c.uid = n.user_id;
      return out;
    end $b$
  $f$;
  -- Runs one private function as `who` (they are closed to signed-in callers, so no role switch).
  execute $f$
    create function pg_temp.as_user(who uuid, q text) returns void language plpgsql as $b$
    begin
      perform set_config('request.jwt.claims', jsonb_build_object('sub', who, 'role', 'authenticated')::text, true);
      execute 'select ' || q;
      perform set_config('request.jwt.claims', '', true);
    end $b$
  $f$;

  -- ---- the people ----------------------------------------------------------------------------------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null then fails := fails || 'no demo workspace to test with'::text; raise exception 'stop'; end if;
  insert into pn_cast values ('own', own), ('adm', adm), ('adm2', adm2), ('mgr', mgr), ('rep', rep), ('rep2', rep2), ('lone', lone), ('lone2', lone2),
    ('vwr', vwr), ('ua', ua), ('ub', ub), ('uq', uq), ('anon', anon_u), ('demo', demo_u);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select c.uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         case when c.uid = anon_u then null else c.uid || '@push-check.openkuasa-test.dev' end, '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, c.uid = anon_u
  from pn_cast c;
  insert into public.orgs (id, name) values (org, 'Push Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, adm2, 'admin'), (org, mgr, 'member'),
    (org, rep, 'member'), (org, rep2, 'member'), (org, lone, 'member'), (org, lone2, 'member'), (org, vwr, 'viewer'), (org, ua, 'member'), (org, ub, 'member'),
    (org, uq, 'member'), (demo, demo_u, 'viewer'), (demo, anon_u, 'viewer');
  insert into public.hr_employees (id, org_id, employee_no, name, user_id) values
    (e_own, org, 'P01', 'Owner Check', own), (e_mgr, org, 'P02', 'Manager Check', mgr), (e_rep, org, 'P03', 'Rep Check', rep), (e_rep2, org, 'P04', 'Reptwo Check', rep2),
    (e_lone, org, 'P05', 'Lone Check', lone), (e_lone2, org, 'P06', 'Lonetwo Check', lone2), (e_unl, org, 'P07', 'Unlinked Check', null), (e_adm, org, 'P08', 'Admin Check', adm);
  update public.hr_employees set reports_to = e_mgr where id in (e_rep, e_rep2);
  perform pg_temp.told();

  -- ---- 1. subscribing: one row per endpoint, re-owned by the latest person (Review Focus 4) ----------------
  a := pg_temp.g(ua, format('public.push_subscribe(%L, ''pk-a'', ''au-a'', ''Phone'')', ep));
  if left(a, 1) <> '=' then raise exception 'A could not subscribe: %', a; end if;
  s1 := (substr(a, 2)::jsonb #>> '{}')::uuid;
  a := pg_temp.g(ua, format('public.push_subscribe(%L, ''pk-a2'', ''au-a2'', ''Phone'')', ep));
  if a is distinct from format('="%s"', s1) or (select count(*) from public.push_subscriptions where endpoint = ep) <> 1 then
    fails := fails || format('subscribing the same browser twice should keep one row with the same id: got %s', a);
  end if;
  insert into public.notifications (user_id, org_id, event, title, href) values (ua, org, 'team_activity', 'For A only', '/command') returning id into n1;
  insert into private.push_outbox (subscription_id, notification_id) values (s1, n1);
  fails := fails || pg_temp.t(ua, 'A reads their own subscription', format('(select count(*) from public.push_subscriptions where endpoint = %L)', ep), '=1')
    || pg_temp.t(ub, 'B does not read A''s subscription', format('(select count(*) from public.push_subscriptions where endpoint = %L)', ep), '=0')
    || pg_temp.t(ub, 'B cannot delete A''s subscription', format('delete from public.push_subscriptions where endpoint = %L', ep), 'none');
  a := pg_temp.g(ub, format('public.push_subscribe(%L, ''pk-b'', ''au-b'', ''Laptop'')', ep));
  select count(*), max(user_id::text) into i, a from public.push_subscriptions where endpoint = ep;
  if i <> 1 or a is distinct from ub::text then fails := fails || format('B subscribing A''s browser should re-own the one row: %s rows, owner %s', i, a); end if;
  if exists (select 1 from private.push_outbox where notification_id = n1) then fails := fails || 'A''s queued notification stayed on the browser B now owns'::text; end if;
  if not exists (select 1 from public.push_subscriptions where endpoint = ep and p256dh = 'pk-b' and auth = 'au-b' and device_label = 'Laptop') then
    fails := fails || 'the re-owned subscription did not take B''s keys and label'::text;
  end if;
  fails := fails
    || pg_temp.t(ua, 'A unsubscribing B''s browser changes nothing', format('public.push_unsubscribe(%L)', ep), '=""')
    || pg_temp.t(ub, 'B cannot write a subscription directly', format('insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (%L, ''https://fcm.googleapis.com/fcm/send/x'', ''k'', ''a'')', ub), 'denied')
    || pg_temp.t(ub, 'B cannot update their subscription directly', format('update public.push_subscriptions set user_id = %L where endpoint = %L', ua, ep), 'denied')
    || pg_temp.t(ub, 'B cannot read the outbox', '(select count(*) from private.push_outbox)', 'denied')
    || pg_temp.t(anon_u, 'an anonymous guest cannot subscribe', 'public.push_subscribe(''https://fcm.googleapis.com/fcm/send/anon'', ''k'', ''a'', null)', 'PUSH_DEMO')
    || pg_temp.t(demo_u, 'someone only in the demo cannot subscribe', 'public.push_subscribe(''https://fcm.googleapis.com/fcm/send/demo'', ''k'', ''a'', null)', 'PUSH_DEMO')
    || pg_temp.t(null, 'nobody signed in cannot subscribe', 'public.push_subscribe(''https://fcm.googleapis.com/fcm/send/none'', ''k'', ''a'', null)', 'PUSH_NOT_SIGNED_IN')
    || pg_temp.t(ub, 'empty keys are refused', 'public.push_subscribe(''https://fcm.googleapis.com/fcm/send/empty'', '''', ''a'', null)', 'PUSH_BAD_SUBSCRIPTION');
  -- Only real push services, by a plainly written host.
  for r in select * from (values
      ('http://fcm.googleapis.com/fcm/send/plain', 'PUSH_BAD_SUBSCRIPTION'), ('https://push.example.test/x', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://user@fcm.googleapis.com/fcm/send/x', 'PUSH_BAD_SUBSCRIPTION'), ('https://fcm.googleapis.com@evil.test/x', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://fcm.googleapis.com:8443/fcm/send/x', 'PUSH_BAD_SUBSCRIPTION'), ('https://fcm.googleapis.com.evil.test/x', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://evil.test/fcm.googleapis.com/x', 'PUSH_BAD_SUBSCRIPTION'), ('https://fcm.googleapis.com', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://push.apple.com/x', 'PUSH_BAD_SUBSCRIPTION'), ('https://evilpush.apple.com/x', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://web..push.apple.com/x', 'PUSH_BAD_SUBSCRIPTION'), ('https://web.push.apple.com.evil.test/x', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://xn--fcm.googleapis.com/x', 'PUSH_BAD_SUBSCRIPTION'), ('https:///fcm.googleapis.com/x', 'PUSH_BAD_SUBSCRIPTION'),
      ('https://fcm.googleapis.com/fcm/send/ok-' || gen_random_uuid(), '*'), ('https://FCM.googleapis.com/fcm/send/ok-' || gen_random_uuid(), '*'),
      ('https://updates.push.services.mozilla.com/wpush/v2/ok-' || gen_random_uuid(), '*'), ('https://web.push.apple.com/ok-' || gen_random_uuid(), '*'),
      ('https://wns2-par02p.notify.windows.com/w/?token=ok-' || gen_random_uuid(), '*')) v(url, want) loop
    fails := fails || pg_temp.t(lone2, format('the endpoint %s', r.url), format('public.push_subscribe(%L, ''k'', ''a'', null)', r.url), r.want);
  end loop;
  if (select count(*) from public.push_subscriptions where user_id = lone2) <> 5 then fails := fails || 'the five real push services were not all kept'::text; end if;
  -- At most 10 browsers each; re-subscribing one of them does not count.
  for i in 1..10 loop
    fails := fails || pg_temp.t(lone, format('browser %s of 10', i), format('public.push_subscribe(%L, ''k'', ''a'', null)', 'https://fcm.googleapis.com/fcm/send/cap-' || i || '-' || ep), '*');
  end loop;
  fails := fails
    || pg_temp.t(lone, 'an 11th browser is refused', format('public.push_subscribe(%L, ''k'', ''a'', null)', 'https://fcm.googleapis.com/fcm/send/cap-11-' || ep), 'PUSH_TOO_MANY')
    || pg_temp.t(lone, 're-subscribing one of the ten is fine', format('public.push_subscribe(%L, ''k2'', ''a2'', null)', 'https://fcm.googleapis.com/fcm/send/cap-3-' || ep), '*');
  if (select count(*) from public.push_subscriptions where user_id = lone) <> 10 then fails := fails || 'the cap left other than 10 browsers'::text; end if;
  delete from public.push_subscriptions where user_id in (lone, lone2);
  if (select count(*) from public.push_subscriptions where endpoint = ep) <> 1 then fails := fails || 'A''s unsubscribe removed B''s browser'::text; end if;
  fails := fails || pg_temp.t(ub, 'B unsubscribes', format('public.push_unsubscribe(%L)', ep), '=""');
  if exists (select 1 from public.push_subscriptions where endpoint = ep) then fails := fails || 'B''s unsubscribe left the row'::text; end if;

  -- ---- 2. queuing: off unless switched on (Review Focus 1) ---------------------------------------------------
  sq := (substr(pg_temp.g(uq, format('public.push_subscribe(%L, ''pk-q'', ''au-q'', null)', ep || '-q')), 2)::jsonb #>> '{}')::uuid;
  if sq is null then raise exception 'Q could not subscribe'; end if;
  for r in select * from (values
      (1, '{}', 'hr_request_filed', org, 0), (2, '{}', 'security', org, 0),
      (3, '{"channels":{"inapp":true}}', 'hr_request_filed', org, 0),
      (4, '{"channels":{"push":true}}', 'team_activity', org, 0),
      (5, '{"channels":{"push":true}}', 'hr_request_filed', org, 1),
      (6, '{"channels":{"push":true},"events":{"hr_request_filed":{"push":false}}}', 'hr_request_filed', org, 0),
      (7, '{"channels":{"push":true},"events":{"security":{"push":false}}}', 'security', org, 1),
      (8, '{"channels":{"push":true},"events":{"team_activity":{"push":true}}}', 'team_activity', org, 1),
      (9, '{"channels":{"push":false},"events":{"team_activity":{"push":true}}}', 'team_activity', org, 0),
      (10, '{"channels":{"push":true},"events":{"team_activity":{"push":true}}}', 'team_activity', demo, 0),
      (11, '{"channels":{"push":"yes"},"events":{"team_activity":{"push":true}}}', 'team_activity', org, 0),
      (12, '{"channels":{"push":true},"events":{"team_activity":{"inapp":true}}}', 'team_activity', org, 0),
      (13, '{"channels":{"push":true},"events":{"hr_shift_swap":{"push":true}}}', 'hr_request_filed', null, 1)
    ) v(k, prefs, event, o, want) loop
    update public.profiles set notification_prefs = r.prefs::jsonb where user_id = uq;
    insert into public.notifications (user_id, org_id, event, title, href) values (uq, r.o, r.event, 'Queue case ' || r.k, '/command') returning id into n1;
    select count(*) into c from private.push_outbox where notification_id = n1;
    if c <> r.want then fails := fails || format('queue case %s (%s, %s): wanted %s queued, got %s', r.k, r.prefs, r.event, r.want, c); end if;
  end loop;
  update public.profiles set notification_prefs = '{"channels":{"push":true}}' where user_id = uq;
  insert into public.notifications (user_id, org_id, event, title, href, read_at) values (uq, org, 'hr_request_filed', 'Already read', '/command', now()) returning id into n1;
  if exists (select 1 from private.push_outbox where notification_id = n1) then fails := fails || 'a notification inserted as read was queued'::text; end if;
  sq2 := (substr(pg_temp.g(uq, format('public.push_subscribe(%L, ''pk-q2'', ''au-q2'', null)', ep || '-q2')), 2)::jsonb #>> '{}')::uuid;
  insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Two devices', '/command') returning id into n1;
  if (select count(*) from private.push_outbox where notification_id = n1) <> 2 then fails := fails || 'a person with two devices did not get one queue item per device'::text; end if;
  if exists (select 1 from private.push_outbox o join public.push_subscriptions s on s.id = o.subscription_id join public.notifications n on n.id = o.notification_id where n.user_id <> s.user_id) then
    fails := fails || 'something was queued on a device that belongs to someone else'::text;
  end if;

  -- ---- 3. queuing never blocks the notification (Review Focus 7) ---------------------------------------------
  alter table private.push_outbox add constraint push_check_breaks check (attempts < 0) not valid;
  begin
    insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Queue broken', '/command') returning id into n1;
  exception when others then
    fails := fails || ('a failing queue blocked the notification: ' || sqlerrm); n1 := null;
  end;
  if n1 is not null and not exists (select 1 from public.notifications where id = n1) then fails := fails || 'the notification is missing after the queue failed'::text; end if;
  alter table private.push_outbox drop constraint push_check_breaks;
  update public.profiles set notification_prefs = '{"channels":{"push":true},"events":"oops"}' where user_id = uq;
  begin
    insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Odd prefs', '/command') returning id into n1;
  exception when others then
    fails := fails || ('odd preferences blocked the notification: ' || sqlerrm);
  end;
  -- Filing a request with the queue broken still goes through and still tells the manager.
  alter table private.push_outbox add constraint push_check_breaks check (attempts < 0) not valid;
  update public.profiles set notification_prefs = '{"channels":{"push":true}}' where user_id = mgr;
  perform pg_temp.told();
  perform pg_temp.as_user(rep, format('private.hr_notify_request_filed(%L, %L, ''leave'')', org, e_rep));
  a := pg_temp.told();
  if a is distinct from 'mgr:hr_request_filed' then fails := fails || format('with the queue broken the manager was not told: got "%s"', a); end if;
  alter table private.push_outbox drop constraint push_check_breaks;
  update public.profiles set notification_prefs = '{}' where user_id = mgr;

  -- ---- 4. the sender's calls ------------------------------------------------------------------------------
  delete from private.push_outbox where subscription_id in (sq, sq2);
  update public.profiles set notification_prefs = '{"channels":{"push":true}}' where user_id = uq;
  delete from public.push_subscriptions where id = sq2;
  -- Two overlapping runs never get the same item; one claimed over 10 minutes ago (its run died) is handed out again.
  insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Claim one', '/command'), (uq, org, 'hr_request_filed', 'Claim two', '/command');
  select count(*) into c from public.push_pending(100) p where p.title in ('Claim one', 'Claim two');
  select count(*) into i from public.push_pending(100) p where p.title in ('Claim one', 'Claim two');
  if c <> 2 or i <> 0 then fails := fails || format('the first run should claim both items (got %s) and the next none (got %s)', c, i); end if;
  update private.push_outbox o set claimed_at = now() - interval '11 minutes' from public.notifications n where n.id = o.notification_id and n.title = 'Claim one';
  select count(*) into c from public.push_pending(100) p where p.title in ('Claim one', 'Claim two');
  if c <> 1 then fails := fails || format('an item claimed 11 minutes ago should be handed out again, alone: got %s', c); end if;
  delete from private.push_outbox o using public.notifications n where n.id = o.notification_id and n.title like 'Claim %';
  insert into public.notifications (user_id, org_id, event, title, body, href) values (uq, org, 'hr_request_filed', 'Send me', 'Body', '/people/approve-leave') returning id into n1;
  set local role service_role;
  select count(*), max(p.outbox_id) into c, ob from public.push_pending(100) p where p.notification_id = n1 and p.endpoint = ep || '-q' and p.title = 'Send me' and p.href = '/people/approve-leave';
  reset role;
  if c <> 1 then fails := fails || format('the sender (as service_role) saw %s of the 1 queued item', c); end if;
  perform public.push_result(ob, 'failed'); perform public.push_result(ob, 'failed');
  if (select attempts::text || '/' || (claimed_at is null)::text from private.push_outbox where id = ob) is distinct from '2/true' then
    fails := fails || 'two failures did not count two attempts and release the claim'::text;
  end if;
  perform public.push_result(ob, 'failed'); perform public.push_result(ob, 'failed'); perform public.push_result(ob, 'failed');
  if exists (select 1 from private.push_outbox where id = ob) then fails := fails || 'an item that failed five times was kept'::text; end if;
  if not exists (select 1 from public.push_subscriptions where id = sq) then fails := fails || 'failures removed the subscription'::text; end if;
  insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Read before sending', '/command') returning id into n1;
  update public.notifications set read_at = now() where id = n1;
  select count(*) into c from public.push_pending(100) p where p.notification_id = n1;
  if c > 0 or exists (select 1 from private.push_outbox where notification_id = n1) then
    fails := fails || 'a notification read in the app before sending was still sent or kept (Review Focus 6)'::text;
  end if;
  insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Sent', '/command') returning id into n1;
  select id into ob from private.push_outbox where notification_id = n1;
  perform public.push_result(ob, 'sent');
  if exists (select 1 from private.push_outbox where id = ob) or (select last_used_at from public.push_subscriptions where id = sq) is null then
    fails := fails || 'a sent item was kept, or the device''s last use was not stamped'::text;
  end if;
  insert into public.notifications (user_id, org_id, event, title, href) values (uq, org, 'hr_request_filed', 'Gone', '/command') returning id into n1;
  select id into ob from private.push_outbox where notification_id = n1;
  perform public.push_result(ob, 'gone');
  if exists (select 1 from public.push_subscriptions where id = sq) or exists (select 1 from private.push_outbox where id = ob) then
    fails := fails || 'a subscription the push service says is gone was kept'::text;
  end if;
  begin
    perform public.push_result(1, 'maybe');
    fails := fails || 'an unknown outcome was accepted'::text;
  exception when others then
    if sqlerrm <> 'PUSH_BAD_OUTCOME' then fails := fails || ('an unknown outcome: ' || sqlerrm); end if;
  end;
  update public.profiles set notification_prefs = '{}' where user_id = uq;

  -- ---- 5. who is told a request waits (Review Focus 5) --------------------------------------------------------
  perform pg_temp.told();
  perform pg_temp.as_user(rep, format('private.hr_notify_request_filed(%L, %L, ''leave'')', org, e_rep));
  a := pg_temp.told();
  if a is distinct from 'mgr:hr_request_filed' then fails := fails || format('with a manager, the manager alone is told: got "%s"', a); end if;
  perform pg_temp.as_user(mgr, format('private.hr_notify_request_filed(%L, %L, ''claim'')', org, e_rep));
  a := pg_temp.told();
  if a <> '' then fails := fails || format('a manager filing for their own report tells nobody, as before: got "%s"', a); end if;
  perform pg_temp.as_user(lone, format('private.hr_notify_request_filed(%L, %L, ''leave'')', org, e_lone));
  a := pg_temp.told();
  if a is distinct from 'adm:hr_request_filed,adm2:hr_request_filed,own:hr_request_filed' then
    fails := fails || format('with no manager, each owner and admin is told once and the requester and viewer never: got "%s"', a);
  end if;
  perform pg_temp.as_user(lone, format('private.hr_notify_request_filed(%L, %L, ''overtime'')', org, e_lone));
  select string_agg(n.title || '|' || coalesce(n.body, '~') || '|' || n.href, ',') into a from public.notifications n where n.user_id = own;
  if a is distinct from 'Overtime request from Lone Check|~|/people/approve-overtime' then fails := fails || format('the owner''s notice has the same title and link as a manager''s: got "%s"', a); end if;
  perform pg_temp.told();
  perform pg_temp.as_user(adm, format('private.hr_notify_request_filed(%L, %L, ''claim'')', org, e_lone));
  a := pg_temp.told();
  if a is distinct from 'adm2:hr_request_filed,own:hr_request_filed' then fails := fails || format('an admin filing for someone with no manager is not told themselves: got "%s"', a); end if;
  perform pg_temp.as_user(adm, format('private.hr_notify_request_filed(%L, %L, ''time_off'')', org, e_adm));
  a := pg_temp.told();
  if a is distinct from 'adm2:hr_request_filed,own:hr_request_filed' then fails := fails || format('an admin''s own request goes to the other owners and admins: got "%s"', a); end if;
  perform pg_temp.as_user(own, format('private.hr_notify_request_filed(%L, %L, ''leave'')', org, e_unl));
  a := pg_temp.told();
  if a is distinct from 'adm:hr_request_filed,adm2:hr_request_filed' then fails := fails || format('an owner filing for an unlinked employee with no manager: got "%s"', a); end if;
  update public.hr_employees set status = 'inactive' where id = e_mgr;
  perform pg_temp.as_user(rep, format('private.hr_notify_request_filed(%L, %L, ''leave'')', org, e_rep));
  a := pg_temp.told();
  if a is distinct from 'adm:hr_request_filed,adm2:hr_request_filed,own:hr_request_filed' then fails := fails || format('with the manager inactive, owners and admins are told: got "%s"', a); end if;
  update public.hr_employees set status = 'active' where id = e_mgr;
  perform pg_temp.as_user(rep, format('private.hr_notify_request_filed(%L, %L, ''nonsense'')', org, e_rep));
  if pg_temp.told() <> '' then fails := fails || 'an unknown kind told someone'::text; end if;
  insert into public.hr_employees (id, org_id, employee_no, name, user_id) values (gen_random_uuid(), demo, 'PUSH-CHECK', 'Push Demo', null) returning id into s2;
  perform pg_temp.as_user(own, format('private.hr_notify_request_filed(%L, %L, ''leave'')', demo, s2));
  select count(*) into c from public.notifications n where n.org_id = demo and n.title like '%Push Demo%';
  if c <> 0 then fails := fails || 'a request in the demo told someone'::text; end if;

  -- ---- 6. a shift swap both people accepted ------------------------------------------------------------------
  insert into public.hr_shift_types (id, org_id, name) values (st, org, 'Push check');
  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
  values (org, e_rep, e_rep2, date '2031-03-03', st, date '2031-03-04', st, 'accepted') returning id into sw;
  perform pg_temp.told();
  perform pg_temp.as_user(rep2, format('private.hr_notify_swap(%L, ''accepted'')', sw));
  a := pg_temp.told();
  if a is distinct from 'mgr:hr_request_filed,rep:hr_shift_swap' then fails := fails || format('a swap under one manager tells that manager alone: got "%s"', a); end if;
  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
  values (org, e_lone, e_lone2, date '2031-03-03', st, date '2031-03-04', st, 'accepted') returning id into sw;
  perform pg_temp.as_user(lone2, format('private.hr_notify_swap(%L, ''accepted'')', sw));
  a := pg_temp.told();
  if a is distinct from 'adm:hr_request_filed,adm2:hr_request_filed,lone:hr_shift_swap,own:hr_request_filed' then
    fails := fails || format('a swap with no shared manager tells the owners and admins: got "%s"', a);
  end if;
  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
  values (org, e_lone, e_adm, date '2031-03-05', st, date '2031-03-06', st, 'accepted') returning id into sw;
  perform pg_temp.as_user(adm, format('private.hr_notify_swap(%L, ''accepted'')', sw));
  a := pg_temp.told();
  if a is distinct from 'adm2:hr_request_filed,lone:hr_shift_swap,own:hr_request_filed' then
    fails := fails || format('an admin in the swap is not told to approve it: got "%s"', a);
  end if;
  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
  values (org, e_rep, e_lone, date '2031-03-07', st, date '2031-03-08', st, 'declined') returning id into sw;
  perform pg_temp.as_user(lone, format('private.hr_notify_swap(%L, ''declined'')', sw));
  a := pg_temp.told();
  if a is distinct from 'rep:hr_shift_swap' then fails := fails || format('a declined swap tells the requester alone: got "%s"', a); end if;

  raise exception 'done';
  exception when others then
    if sqlerrm not in ('done', 'stop') then fails := fails || ('error: ' || sqlerrm); end if;
  end;
  if cardinality(fails) = 0 then
    raise exception 'PUSH_NOTIFICATIONS_CHECK PASSED (catalogue; one row per browser, re-owned with its queue cleared; push off unless on; queuing never blocks; sender calls; approvals reach owners and admins with no manager)';
  end if;
  raise exception 'PUSH_NOTIFICATIONS_CHECK FAILED (%): %', cardinality(fails), array_to_string(fails, ' | ');
end $$;
