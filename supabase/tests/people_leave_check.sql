-- Lekiu leave and time-off access check. Leaves nothing behind: the block
-- always ends with RAISE, so every row below is rolled back. Read the message:
--   PEOPLE_LEAVE_CHECK PASSED ...   or   PEOPLE_LEAVE_CHECK FAILED: <what went wrong>
-- It rebuilds the demo HR rows inside its transaction and holds them until the
-- rollback, so do not start it at minute 1 of the hour, when the scheduled
-- demo reseed runs.
--
-- How it works: each numbered stage is a list of (who, what, the call, the
-- refusal expected or null when it must succeed). One loop runs every call as
-- that person and records anything that went the other way. Between stages
-- the block looks at the rows as the database owner.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  demo uuid;
  admin_id uuid := gen_random_uuid();
  ma uuid := gen_random_uuid();        -- member linked to employee A
  mb uuid := gen_random_uuid();        -- member linked to employee B
  mu uuid := gen_random_uuid();        -- member with no employee record
  mv uuid := gen_random_uuid();        -- workspace role 'viewer', linked to employee V
  outsider uuid := gen_random_uuid();  -- owner of another workspace
  dv uuid := gen_random_uuid();        -- demo visitor (viewer)
  da uuid := gen_random_uuid();        -- an admin planted in the demo workspace
  ea uuid;
  eb uuid;
  ei uuid;                             -- inactive employee
  ev uuid;
  ec uuid := gen_random_uuid();        -- employee added by the admin's own session
  demo_emp uuid := md5('rimba-emp-1')::uuid;
  demo_req uuid;
  demo_toff uuid;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  this_year int := extract(year from (now() at time zone 'Asia/Kuala_Lumpur'))::int;
  ra1 uuid; ra2 uuid; rhalf uuid; rover uuid; rpast uuid; rtoday uuid;
  rb1 uuid; rbx uuid; rbadm uuid;
  ta1 uuid; ta2 uuid; tnew uuid; tpast uuid; tb1 uuid; tbadm uuid;
  rv uuid; tv uuid; xa uuid; xb uuid;
  stage int;
  who uuid;
  label text;
  q text;
  want text;
  r jsonb;
  n int;
  n2 int;
  d numeric;
  t text;
  sig text;
  rec record;
  ctx text;
  long_text text := repeat('x', 501);
  fails text[] := '{}';
  functions text[] := array[
    'public.hr_leave_preview(uuid,text,date,date,boolean)',
    'public.hr_apply_leave(uuid,text,date,date,boolean,text)',
    'public.hr_apply_time_off(uuid,date,time,time,text)',
    'public.hr_cancel_leave(uuid)',
    'public.hr_cancel_time_off(uuid)',
    'public.hr_decide_leave(uuid,boolean,text)',
    'public.hr_decide_time_off(uuid,boolean,text)',
    'public.hr_set_leave_entitlement(uuid,text,integer,numeric)'];
  helpers text[] := array[
    'private.hr_leave_days(uuid,date,date,boolean)',
    'private.hr_leave_days_in_year(uuid,date,date,boolean,integer)',
    'private.hr_leave_request_days_in_year(uuid,date,date,boolean,numeric,integer)',
    'private.hr_leave_count(uuid,text,date,date,boolean)',
    'private.hr_default_leave_days(uuid,text)',
    'private.hr_leave_may_act(uuid)',
    'private.hr_ensure_leave_balances(uuid,integer,uuid)',
    'private.hr_ensure_leave_balances_all()',
    'private.hr_recount_leave_used(uuid,text)',
    'private.hr_employee_leave_balances()'];
  leave_tables text[] := array['hr_leave_requests','hr_leave_balances','hr_time_off_requests'];
begin
  begin  -- one sub-block, so a step that stops the script is reported, not lost

  -- ---- who may call what, from the catalogue ---------------------------
  foreach sig in array functions loop
    if to_regprocedure(sig) is null then
      fails := array_append(fails, format('%s does not exist', sig));
    else
      if has_function_privilege('anon', sig, 'execute') then
        fails := array_append(fails, format('signed-out visitors may call %s', sig));
      end if;
      if has_function_privilege('public', sig, 'execute') then
        fails := array_append(fails, format('everyone (public) may call %s', sig));
      end if;
      if not has_function_privilege('authenticated', sig, 'execute') then
        fails := array_append(fails, format('signed-in users may not call %s', sig));
      end if;
      select count(*) into n from pg_proc p
      where p.oid = to_regprocedure(sig) and p.prosecdef
        and p.proconfig @> array['search_path=public'];
      if n <> 1 then fails := array_append(fails, format('%s is not security definer with a fixed search path', sig)); end if;
    end if;
  end loop;
  foreach sig in array helpers loop
    if to_regprocedure(sig) is null then
      fails := array_append(fails, format('%s does not exist', sig));
    elsif has_function_privilege('authenticated', sig, 'execute') or has_function_privilege('anon', sig, 'execute')
       or has_function_privilege('public', sig, 'execute') then
      fails := array_append(fails, format('%s can be called directly', sig));
    end if;
  end loop;
  -- And any other hr_ helper in the private schema, listed above or not.
  for rec in
    select p.oid::regprocedure::text as sig from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and p.proname like 'hr\_%'
  loop
    if has_function_privilege('authenticated', rec.sig, 'execute') or has_function_privilege('anon', rec.sig, 'execute')
       or has_function_privilege('public', rec.sig, 'execute') then
      fails := array_append(fails, format('%s can be called directly', rec.sig));
    end if;
  end loop;
  foreach t in array leave_tables loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      fails := array_append(fails, format('%s has a write grant', t));
    end if;
  end loop;
  if cardinality(fails) > 0 then raise exception 'the functions and grants are not as expected, so nothing else was tried'; end if;

  -- ---- people and a workspace ------------------------------------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@leave-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[admin_id, ma, mb, mu, mv, outsider, dv, da]) as u(id);

  insert into public.orgs (id, name) values (org, 'Leave Check Sdn Bhd'), (other_org, 'Leave Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, admin_id, 'admin'), (org, ma, 'member'), (org, mb, 'member'), (org, mu, 'member'), (org, mv, 'viewer'),
         (other_org, outsider, 'owner'), (demo, dv, 'viewer'), (demo, da, 'admin');

  -- No settings row yet: adding an employee must still work, on the table defaults.
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'A', 'Member A', ma || '@leave-check.openkuasa-test.dev') returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'B', 'Member B', mb || '@leave-check.openkuasa-test.dev') returning id into eb;
  insert into public.hr_employees (org_id, employee_no, name, status)
  values (org, 'I', 'Inactive One', 'inactive') returning id into ei;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'V', 'Viewer V', mv || '@leave-check.openkuasa-test.dev') returning id into ev;
  select count(*) into n from public.hr_employees where id in (ea, eb, ev) and user_id in (ma, mb, mv);
  if n <> 3 then fails := array_append(fails, 'the members were not linked to their employee records'); end if;

  select count(*), count(*) filter (where (leave_type, entitled_days) in (('annual', 14), ('medical', 14), ('emergency', 3)) and used_days = 0)
  into n, n2 from public.hr_leave_balances where employee_id = ea and year = this_year;
  if n <> 3 or n2 <> 3 then
    fails := array_append(fails, format('a new employee got %s balance rows (%s on the defaults 14/14/3), expected 3', n, n2));
  end if;
  select count(*) into n from public.hr_leave_balances where employee_id = ei;
  if n <> 0 then fails := array_append(fails, 'an inactive new employee was given balances'); end if;

  insert into public.hr_settings (org_id, default_annual_leave_days) values (org, 20);
  insert into public.hr_public_holidays (org_id, name, holiday_date) values (org, 'Check Day', date '2030-03-20');

  -- An employee added by the admin, as the admin (the route the app takes).
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  insert into public.hr_employees (id, org_id, employee_no, name) values (ec, org, 'C', 'Added By Admin');
  reset role;
  select count(*), count(*) filter (where (leave_type, entitled_days) in (('annual', 20), ('medical', 14), ('emergency', 3)))
  into n, n2 from public.hr_leave_balances where employee_id = ec and year = this_year;
  if n <> 3 or n2 <> 3 then
    fails := array_append(fails, format('an employee added by the admin got %s balance rows (%s on the workspace defaults), expected 3', n, n2));
  end if;

  select id into demo_req from public.hr_leave_requests where org_id = demo and status = 'pending' limit 1;
  select id into demo_toff from public.hr_time_off_requests where org_id = demo limit 1;

  -- ---- the preview, before anything is applied for ----------------------
  -- 2030: 1 Mar is a Friday, 20 Mar (a Wednesday) is the public holiday above.
  -- 30 Dec 2030 is a Monday and 4 Jan 2031 a Saturday.
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;

  r := public.hr_leave_preview(ea, 'annual', date '2030-03-01', date '2030-03-05', false);
  if (r->>'days')::numeric <> 3 or jsonb_typeof(r->'days') <> 'number' then
    fails := array_append(fails, 'Friday to Tuesday should count 3 working days: ' || r::text);
  end if;
  -- No 2030 balance row exists yet, so the workspace default (20) is used.
  if jsonb_array_length(r->'years') <> 1 or (r->'years'->0->>'year')::int <> 2030
     or (r->'years'->0->>'days')::numeric <> 3 or (r->'years'->0->>'entitled')::numeric <> 20
     or (r->'years'->0->>'used')::numeric <> 0 or (r->'years'->0->>'pending')::numeric <> 0
     or (r->'years'->0->>'remaining_after')::numeric <> 17 or (r->>'over_by')::numeric <> 0 then
    fails := array_append(fails, 'a preview with no balance row should use the workspace default: ' || r::text);
  end if;

  r := public.hr_leave_preview(ea, 'annual', date '2030-03-18', date '2030-03-22', false);
  if (r->>'days')::numeric <> 4 then
    fails := array_append(fails, 'a week holding one public holiday should count 4: ' || r::text);
  end if;

  r := public.hr_leave_preview(ea, 'annual', date '2030-03-25', date '2030-03-25', true);
  if (r->>'days')::numeric <> 0.5 then fails := array_append(fails, 'a half day should count 0.5: ' || r::text); end if;

  r := public.hr_leave_preview(ea, 'annual', date '2030-12-30', date '2031-01-04', false);
  if (r->>'days')::numeric <> 5 or jsonb_array_length(r->'years') <> 2
     or (r->'years'->0->>'year')::int <> 2030 or (r->'years'->0->>'days')::numeric <> 2
     or (r->'years'->1->>'year')::int <> 2031 or (r->'years'->1->>'days')::numeric <> 3 then
    fails := array_append(fails, '30 Dec to 4 Jan should be 2 days in 2030 and 3 in 2031: ' || r::text);
  end if;

  r := public.hr_leave_preview(ea, 'unpaid', date '2030-03-01', date '2030-03-05', false);
  if (r->>'days')::numeric <> 3 or r->'years' <> '[]'::jsonb or (r->>'over_by')::numeric <> 0 then
    fails := array_append(fails, 'unpaid leave has no balance to show: ' || r::text);
  end if;

  -- Emergency leave defaults to 3 days; five days is over by 2.
  r := public.hr_leave_preview(ea, 'emergency', date '2030-04-01', date '2030-04-05', false);
  if (r->>'over_by')::numeric <> 2 or (r->'years'->0->>'remaining_after')::numeric <> -2 then
    fails := array_append(fails, 'five days of emergency leave against 3 should be over by 2: ' || r::text);
  end if;
  reset role;

  select count(*) into n from public.hr_leave_balances where org_id = org and year <> this_year;
  if n <> 0 then fails := array_append(fails, format('the preview wrote %s balance rows', n)); end if;
  select count(*) into n from public.hr_leave_requests where org_id = org;
  if n <> 0 then fails := array_append(fails, format('the preview wrote %s requests', n)); end if;

  -- ---- the stages --------------------------------------------------------
  for stage in 1..6 loop
    for who, label, q, want in
      select c.who, c.label, c.q, c.want from (values
        -- 1: applying, and everything that needs no request id
        (1, ma, 'member A applies for own leave', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-01'', ''2030-03-05'', false, ''  Family trip  '')', ea), null),
        (1, ma, 'member A applies over own pending leave', format('select public.hr_apply_leave(%L, ''medical'', ''2030-03-05'', ''2030-03-06'', false, null)', ea), 'LEAVE_OVERLAP'),
        (1, ma, 'member A applies for member B', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', eb), 'LEAVE_NOT_ALLOWED'),
        (1, ma, 'member A previews member B''s leave', format('select public.hr_leave_preview(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false)', eb), 'LEAVE_NOT_ALLOWED'),
        (1, ma, 'member A requests time-off for member B', format('select public.hr_apply_time_off(%L, ''2030-06-03'', ''09:00'', ''10:00'', null)', eb), 'LEAVE_NOT_ALLOWED'),
        (1, ma, 'member A sets own entitlement', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 99)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, ma, 'leave on a Saturday and Sunday only', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-09'', ''2030-03-10'', false, null)', ea), 'LEAVE_NO_WORKING_DAY'),
        (1, ma, 'a preview of a Saturday and Sunday only', format('select public.hr_leave_preview(%L, ''annual'', ''2030-03-09'', ''2030-03-10'', false)', ea), 'LEAVE_NO_WORKING_DAY'),
        (1, ma, 'leave on the public holiday only', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-20'', ''2030-03-20'', false, null)', ea), 'LEAVE_NO_WORKING_DAY'),
        (1, ma, 'a half day on a two-day range', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-11'', ''2030-03-12'', true, null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'a preview of a half day on a two-day range', format('select public.hr_leave_preview(%L, ''annual'', ''2030-03-11'', ''2030-03-12'', true)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'leave that ends before it starts', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-12'', ''2030-03-11'', false, null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'an unknown kind of leave', format('select public.hr_apply_leave(%L, ''sabbatical'', ''2030-03-11'', ''2030-03-12'', false, null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'leave longer than 366 days', format('select public.hr_apply_leave(%L, ''unpaid'', ''2031-01-01'', ''2032-01-02'', false, null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'leave with no dates', format('select public.hr_apply_leave(%L, ''annual'', null, null, false, null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'a reason over 500 characters', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-11'', ''2030-03-12'', false, %L)', ea, long_text), 'LEAVE_BAD_INPUT'),
        (1, ma, 'member A applies for a half day', format('select public.hr_apply_leave(%L, ''medical'', ''2030-03-18'', ''2030-03-18'', true, null)', ea), null),
        (1, ma, 'member A applies for more than is left', format('select public.hr_apply_leave(%L, ''emergency'', ''2030-04-01'', ''2030-04-05'', false, null)', ea), null),
        (1, ma, 'member A applies for leave in the past week', format('select public.hr_apply_leave(%L, ''unpaid'', %L, %L, false, null)', ea, today - 7, today - 1), null),
        (1, ma, 'member A applies for leave starting today', format('select public.hr_apply_leave(%L, ''unpaid'', %L, %L, false, null)', ea, today, today + 6), null),
        (1, ma, 'member A requests own time-off', format('select public.hr_apply_time_off(%L, ''2030-03-13'', ''09:00'', ''11:00'', ''  Bank  '')', ea), null),
        (1, ma, 'member A requests overlapping time-off', format('select public.hr_apply_time_off(%L, ''2030-03-13'', ''10:00'', ''12:00'', null)', ea), 'LEAVE_OVERLAP'),
        (1, ma, 'member A requests time-off that starts as the other ends', format('select public.hr_apply_time_off(%L, ''2030-03-13'', ''11:00'', ''12:00'', null)', ea), null),
        (1, ma, 'time-off that ends before it starts', format('select public.hr_apply_time_off(%L, ''2030-03-14'', ''11:00'', ''10:00'', null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'time-off with no date', format('select public.hr_apply_time_off(%L, null, ''09:00'', ''10:00'', null)', ea), 'LEAVE_BAD_INPUT'),
        (1, ma, 'a time-off reason over 500 characters', format('select public.hr_apply_time_off(%L, ''2030-03-14'', ''09:00'', ''10:00'', %L)', ea, long_text), 'LEAVE_BAD_INPUT'),
        (1, ma, 'member A requests time-off for yesterday', format('select public.hr_apply_time_off(%L, %L, ''09:00'', ''10:00'', null)', ea, today - 1), null),
        (1, ma, 'a member calls the day counter directly', format('select private.hr_leave_days(%L, ''2030-03-01'', ''2030-03-05'', false)', org), 'permission denied'),
        (1, ma, 'a member calls the balance maker directly', format('select private.hr_ensure_leave_balances(%L, 2050)', org), 'permission denied'),
        (1, mb, 'member B applies for own leave on a day A is also away', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-01'', ''2030-03-01'', false, null)', eb), null),
        (1, mb, 'member B applies across New Year', format('select public.hr_apply_leave(%L, ''annual'', ''2030-12-30'', ''2031-01-04'', false, null)', eb), null),
        (1, mb, 'member B requests own time-off at the hours A is away', format('select public.hr_apply_time_off(%L, ''2030-03-13'', ''09:00'', ''11:00'', null)', eb), null),
        (1, mv, 'a linked viewer applies for own leave', format('select public.hr_apply_leave(%L, ''annual'', ''2030-09-02'', ''2030-09-03'', false, null)', ev), null),
        (1, mv, 'a linked viewer previews own leave', format('select public.hr_leave_preview(%L, ''annual'', ''2030-09-09'', ''2030-09-10'', false)', ev), null),
        (1, mv, 'a linked viewer requests own time-off', format('select public.hr_apply_time_off(%L, ''2030-09-04'', ''09:00'', ''10:00'', null)', ev), null),
        (1, mv, 'a linked viewer applies for member A', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, mv, 'a linked viewer requests time-off for member A', format('select public.hr_apply_time_off(%L, ''2030-06-03'', ''09:00'', ''10:00'', null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, mv, 'a linked viewer sets own entitlement', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 99)', ev), 'LEAVE_NOT_ALLOWED'),
        (1, mu, 'an unlinked member applies for member A', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, mu, 'an unlinked member previews member A''s leave', format('select public.hr_leave_preview(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, mu, 'an unlinked member requests time-off for member A', format('select public.hr_apply_time_off(%L, ''2030-06-03'', ''09:00'', ''10:00'', null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, mu, 'an unlinked member applies for the unlinked employee', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', ec), 'LEAVE_NOT_ALLOWED'),
        (1, mu, 'an unlinked member sets an entitlement', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 99)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, outsider, 'another workspace applies for member A', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, outsider, 'another workspace previews member A''s leave', format('select public.hr_leave_preview(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, outsider, 'another workspace requests time-off for member A', format('select public.hr_apply_time_off(%L, ''2030-06-03'', ''09:00'', ''10:00'', null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, outsider, 'another workspace sets an entitlement', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 99)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, null, 'a session with no user applies', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', ea), 'LEAVE_NOT_ALLOWED'),
        (1, admin_id, 'the admin applies for an inactive employee', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', ei), 'LEAVE_INACTIVE_EMPLOYEE'),
        (1, admin_id, 'the admin requests time-off for an inactive employee', format('select public.hr_apply_time_off(%L, ''2030-06-03'', ''09:00'', ''10:00'', null)', ei), 'LEAVE_INACTIVE_EMPLOYEE'),
        (1, admin_id, 'the admin applies for an employee that does not exist', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', gen_random_uuid()), 'LEAVE_NOT_ALLOWED'),
        (1, admin_id, 'an entitlement for unpaid leave', format('select public.hr_set_leave_entitlement(%L, ''unpaid'', 2030, 5)', ea), 'LEAVE_BAD_INPUT'),
        (1, admin_id, 'an entitlement that is not in halves', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 10.3)', ea), 'LEAVE_BAD_INPUT'),
        (1, admin_id, 'an entitlement below zero', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, -1)', ea), 'LEAVE_BAD_INPUT'),
        (1, admin_id, 'an entitlement above 365', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 365.5)', ea), 'LEAVE_BAD_INPUT'),
        (1, admin_id, 'an entitlement for the year 1999', format('select public.hr_set_leave_entitlement(%L, ''annual'', 1999, 10)', ea), 'LEAVE_BAD_INPUT'),
        (1, dv, 'a demo visitor applies for a demo employee', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', demo_emp), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin applies for a demo employee', format('select public.hr_apply_leave(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false, null)', demo_emp), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin previews leave', format('select public.hr_leave_preview(%L, ''annual'', ''2030-06-03'', ''2030-06-04'', false)', demo_emp), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin requests time-off', format('select public.hr_apply_time_off(%L, ''2030-06-03'', ''09:00'', ''10:00'', null)', demo_emp), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin sets an entitlement', format('select public.hr_set_leave_entitlement(%L, ''annual'', %s, 30)', demo_emp, this_year), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin approves a demo request', format('select public.hr_decide_leave(%L, true, null)', demo_req), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin cancels a demo request', format('select public.hr_cancel_leave(%L)', demo_req), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin decides demo time-off', format('select public.hr_decide_time_off(%L, false, null)', demo_toff), 'LEAVE_NOT_ALLOWED'),
        (1, da, 'a demo admin cancels demo time-off', format('select public.hr_cancel_time_off(%L)', demo_toff), 'LEAVE_NOT_ALLOWED'),
        (1, dv, 'a demo visitor cancels a demo request', format('select public.hr_cancel_leave(%L)', demo_req), 'LEAVE_NOT_ALLOWED'),
        (1, dv, 'a demo visitor approves a demo request', format('select public.hr_decide_leave(%L, true, null)', demo_req), 'LEAVE_NOT_ALLOWED'),
        (1, outsider, 'someone outside the demo cancels a demo request', format('select public.hr_cancel_leave(%L)', demo_req), 'LEAVE_NOT_FOUND'),
        (1, outsider, 'someone outside the demo approves demo time-off', format('select public.hr_decide_time_off(%L, true, null)', demo_toff), 'LEAVE_NOT_FOUND'),

        -- 2: a cancelled request does not block a new one
        (2, ma, 'member A cancels own pending leave', format('select public.hr_cancel_leave(%L)', ra1), null),
        (2, ma, 'member A applies again for the cancelled dates', format('select public.hr_apply_leave(%L, ''annual'', ''2030-03-01'', ''2030-03-05'', false, null)', ea), null),
        (2, ma, 'member A cancels own pending time-off', format('select public.hr_cancel_time_off(%L)', ta2), null),
        (2, ma, 'member A requests time-off over the cancelled hours', format('select public.hr_apply_time_off(%L, ''2030-03-13'', ''11:00'', ''12:30'', null)', ea), null),

        -- 3: deciding, and acting on someone else's request
        (3, ma, 'member A approves own leave', format('select public.hr_decide_leave(%L, true, null)', ra2), 'LEAVE_NOT_ALLOWED'),
        (3, ma, 'member A rejects own leave', format('select public.hr_decide_leave(%L, false, null)', ra2), 'LEAVE_NOT_ALLOWED'),
        (3, ma, 'member A approves own time-off', format('select public.hr_decide_time_off(%L, true, null)', ta1), 'LEAVE_NOT_ALLOWED'),
        (3, ma, 'member A approves member B''s leave', format('select public.hr_decide_leave(%L, true, null)', rb1), 'LEAVE_NOT_FOUND'),
        (3, ma, 'member A cancels member B''s leave', format('select public.hr_cancel_leave(%L)', rb1), 'LEAVE_NOT_FOUND'),
        (3, ma, 'member A cancels member B''s time-off', format('select public.hr_cancel_time_off(%L)', tb1), 'LEAVE_NOT_FOUND'),
        (3, mb, 'member B cancels member A''s leave', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_FOUND'),
        (3, mb, 'member B cancels member A''s time-off', format('select public.hr_cancel_time_off(%L)', ta1), 'LEAVE_NOT_FOUND'),
        (3, mb, 'member B approves member A''s time-off', format('select public.hr_decide_time_off(%L, true, null)', ta1), 'LEAVE_NOT_FOUND'),
        (3, mu, 'an unlinked member cancels member A''s leave', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_FOUND'),
        (3, mu, 'an unlinked member approves member A''s leave', format('select public.hr_decide_leave(%L, true, null)', ra2), 'LEAVE_NOT_FOUND'),
        (3, mu, 'an unlinked member cancels member A''s time-off', format('select public.hr_cancel_time_off(%L)', ta1), 'LEAVE_NOT_FOUND'),
        (3, mu, 'an unlinked member approves member A''s time-off', format('select public.hr_decide_time_off(%L, true, null)', ta1), 'LEAVE_NOT_FOUND'),
        (3, outsider, 'another workspace cancels member A''s leave', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_FOUND'),
        (3, outsider, 'another workspace approves member A''s leave', format('select public.hr_decide_leave(%L, true, null)', ra2), 'LEAVE_NOT_FOUND'),
        (3, outsider, 'another workspace cancels member A''s time-off', format('select public.hr_cancel_time_off(%L)', ta1), 'LEAVE_NOT_FOUND'),
        (3, outsider, 'another workspace approves member A''s time-off', format('select public.hr_decide_time_off(%L, true, null)', ta1), 'LEAVE_NOT_FOUND'),
        (3, mv, 'a linked viewer approves own leave', format('select public.hr_decide_leave(%L, true, null)', rv), 'LEAVE_NOT_ALLOWED'),
        (3, mv, 'a linked viewer approves own time-off', format('select public.hr_decide_time_off(%L, true, null)', tv), 'LEAVE_NOT_ALLOWED'),
        (3, mv, 'a linked viewer approves member A''s leave', format('select public.hr_decide_leave(%L, true, null)', ra2), 'LEAVE_NOT_FOUND'),
        (3, mv, 'a linked viewer cancels member A''s leave', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_FOUND'),
        (3, mv, 'a linked viewer cancels member A''s time-off', format('select public.hr_cancel_time_off(%L)', ta1), 'LEAVE_NOT_FOUND'),
        (3, null, 'a session with no user approves leave', format('select public.hr_decide_leave(%L, true, null)', ra2), 'LEAVE_NOT_ALLOWED'),
        (3, null, 'a session with no user cancels leave', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_ALLOWED'),
        (3, admin_id, 'a decision note over 500 characters', format('select public.hr_decide_leave(%L, false, %L)', rover, long_text), 'LEAVE_BAD_INPUT'),
        (3, admin_id, 'a decision that is neither approve nor reject', format('select public.hr_decide_leave(%L, null, null)', rover), 'LEAVE_BAD_INPUT'),
        (3, admin_id, 'a time-off note over 500 characters', format('select public.hr_decide_time_off(%L, false, %L)', tb1, long_text), 'LEAVE_BAD_INPUT'),
        (3, admin_id, 'the admin approves member A''s leave', format('select public.hr_decide_leave(%L, true, ''fine'')', ra2), null),
        (3, admin_id, 'the admin approves it a second time', format('select public.hr_decide_leave(%L, true, null)', ra2), 'LEAVE_NOT_PENDING'),
        (3, admin_id, 'the admin rejects it after approving', format('select public.hr_decide_leave(%L, false, null)', ra2), 'LEAVE_NOT_PENDING'),
        (3, admin_id, 'the admin approves a cancelled request', format('select public.hr_decide_leave(%L, true, null)', ra1), 'LEAVE_NOT_PENDING'),
        (3, admin_id, 'the admin approves the half day', format('select public.hr_decide_leave(%L, true, null)', rhalf), null),
        (3, admin_id, 'the admin approves the past week', format('select public.hr_decide_leave(%L, true, null)', rpast), null),
        (3, admin_id, 'the admin approves the leave starting today', format('select public.hr_decide_leave(%L, true, null)', rtoday), null),
        (3, admin_id, 'the admin rejects the over-balance request', format('select public.hr_decide_leave(%L, false, ''  Too many at once  '')', rover), null),
        (3, admin_id, 'the admin approves member B''s New Year leave', format('select public.hr_decide_leave(%L, true, null)', rbx), null),
        (3, admin_id, 'the admin rejects member B''s single day', format('select public.hr_decide_leave(%L, false, null)', rb1), null),
        (3, admin_id, 'the admin approves member A''s time-off', format('select public.hr_decide_time_off(%L, true, ''fine'')', ta1), null),
        (3, admin_id, 'the admin approves that time-off a second time', format('select public.hr_decide_time_off(%L, true, null)', ta1), 'LEAVE_NOT_PENDING'),
        (3, admin_id, 'the admin approves a cancelled time-off', format('select public.hr_decide_time_off(%L, true, null)', ta2), 'LEAVE_NOT_PENDING'),
        (3, admin_id, 'the admin approves yesterday''s time-off', format('select public.hr_decide_time_off(%L, true, null)', tpast), null),
        (3, admin_id, 'the admin rejects member B''s time-off', format('select public.hr_decide_time_off(%L, false, ''  Busy day  '')', tb1), null),
        (3, admin_id, 'the admin approves leave that does not exist', format('select public.hr_decide_leave(%L, true, null)', gen_random_uuid()), 'LEAVE_NOT_FOUND'),
        (3, admin_id, 'the admin cancels leave that does not exist', format('select public.hr_cancel_leave(%L)', gen_random_uuid()), 'LEAVE_NOT_FOUND'),
        (3, admin_id, 'the admin approves time-off that does not exist', format('select public.hr_decide_time_off(%L, true, null)', gen_random_uuid()), 'LEAVE_NOT_FOUND'),
        (3, admin_id, 'the admin cancels time-off that does not exist', format('select public.hr_cancel_time_off(%L)', gen_random_uuid()), 'LEAVE_NOT_FOUND'),

        -- 4: a member cancelling their own
        (4, ma, 'member A cancels own approved leave that has started', format('select public.hr_cancel_leave(%L)', rpast), 'LEAVE_ALREADY_STARTED'),
        (4, ma, 'member A cancels own approved leave that starts today', format('select public.hr_cancel_leave(%L)', rtoday), 'LEAVE_ALREADY_STARTED'),
        (4, ma, 'member A cancels own approved time-off from yesterday', format('select public.hr_cancel_time_off(%L)', tpast), 'LEAVE_ALREADY_STARTED'),
        (4, ma, 'member A cancels own rejected leave', format('select public.hr_cancel_leave(%L)', rover), 'LEAVE_NOT_PENDING'),
        (4, ma, 'member A cancels own leave twice', format('select public.hr_cancel_leave(%L)', ra1), 'LEAVE_NOT_PENDING'),
        (4, ma, 'member A cancels own approved leave in the future', format('select public.hr_cancel_leave(%L)', ra2), null),
        (4, ma, 'member A cancels own approved time-off in the future', format('select public.hr_cancel_time_off(%L)', ta1), null),
        (4, mv, 'a linked viewer cancels own pending leave', format('select public.hr_cancel_leave(%L)', rv), null),
        (4, mv, 'a linked viewer cancels own pending time-off', format('select public.hr_cancel_time_off(%L)', tv), null),
        (4, mb, 'member B cancels own rejected time-off', format('select public.hr_cancel_time_off(%L)', tb1), 'LEAVE_NOT_PENDING'),
        (4, mb, 'member B cancels own approved New Year leave', format('select public.hr_cancel_leave(%L)', rbx), null),

        -- 5: the admin cancels anything not already cancelled
        (5, admin_id, 'the admin cancels approved leave that has started', format('select public.hr_cancel_leave(%L)', rpast), null),
        (5, admin_id, 'the admin cancels approved leave that starts today', format('select public.hr_cancel_leave(%L)', rtoday), null),
        (5, admin_id, 'the admin cancels a rejected request', format('select public.hr_cancel_leave(%L)', rover), null),
        (5, admin_id, 'the admin cancels it a second time', format('select public.hr_cancel_leave(%L)', rover), 'LEAVE_NOT_PENDING'),
        (5, admin_id, 'the admin cancels member B''s rejected day', format('select public.hr_cancel_leave(%L)', rb1), null),
        (5, admin_id, 'the admin cancels the approved half day', format('select public.hr_cancel_leave(%L)', rhalf), null),
        (5, admin_id, 'the admin cancels a pending request', format('select public.hr_cancel_leave(%L)', rbadm), null),
        (5, admin_id, 'the admin cancels approved time-off from yesterday', format('select public.hr_cancel_time_off(%L)', tpast), null),
        (5, admin_id, 'the admin cancels rejected time-off', format('select public.hr_cancel_time_off(%L)', tb1), null),
        (5, admin_id, 'the admin cancels that time-off a second time', format('select public.hr_cancel_time_off(%L)', tb1), 'LEAVE_NOT_PENDING'),
        (5, admin_id, 'the admin cancels pending time-off', format('select public.hr_cancel_time_off(%L)', tbadm), null),

        -- 6: member A and the admin now have an authenticator, and these sessions have not entered a code
        (6, ma, 'member A applies without the second factor', format('select public.hr_apply_leave(%L, ''annual'', ''2030-07-01'', ''2030-07-02'', false, null)', ea), 'LEAVE_NOT_ALLOWED'),
        (6, ma, 'member A previews without the second factor', format('select public.hr_leave_preview(%L, ''annual'', ''2030-07-01'', ''2030-07-02'', false)', ea), 'LEAVE_NOT_ALLOWED'),
        (6, ma, 'member A requests time-off without the second factor', format('select public.hr_apply_time_off(%L, ''2030-07-01'', ''09:00'', ''10:00'', null)', ea), 'LEAVE_NOT_ALLOWED'),
        (6, ma, 'member A cancels own time-off without the second factor', format('select public.hr_cancel_time_off(%L)', tnew), 'LEAVE_NOT_FOUND'),
        (6, ma, 'member A cancels own leave without the second factor', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_FOUND'),
        (6, admin_id, 'the admin approves time-off without the second factor', format('select public.hr_decide_time_off(%L, true, null)', tnew), 'LEAVE_NOT_FOUND'),
        (6, admin_id, 'the admin cancels time-off without the second factor', format('select public.hr_cancel_time_off(%L)', tnew), 'LEAVE_NOT_FOUND'),
        (6, admin_id, 'the admin rejects leave without the second factor', format('select public.hr_decide_leave(%L, false, null)', ra2), 'LEAVE_NOT_FOUND'),
        (6, admin_id, 'the admin cancels leave without the second factor', format('select public.hr_cancel_leave(%L)', ra2), 'LEAVE_NOT_FOUND'),
        (6, admin_id, 'the admin applies without the second factor', format('select public.hr_apply_leave(%L, ''annual'', ''2030-07-01'', ''2030-07-02'', false, null)', eb), 'LEAVE_NOT_ALLOWED'),
        (6, admin_id, 'the admin sets an entitlement without the second factor', format('select public.hr_set_leave_entitlement(%L, ''annual'', 2030, 12)', eb), 'LEAVE_NOT_ALLOWED')
      ) as c(s, who, label, q, want)
      where c.s = stage
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        execute q;
        if want is not null then
          fails := array_append(fails, format('%s: went through, expected %s', label, want));
        end if;
      exception when others then
        if want is null then
          fails := array_append(fails, format('%s: refused with %s', label, sqlerrm));
        elsif sqlerrm not like want || '%' then
          fails := array_append(fails, format('%s: expected %s, got %s', label, want, sqlerrm));
        end if;
      end;
      reset role;
    end loop;

    if stage = 1 then
      select id into ra1 from public.hr_leave_requests where employee_id = ea and leave_type = 'annual' and start_date = '2030-03-01';
      select id into rhalf from public.hr_leave_requests where employee_id = ea and leave_type = 'medical';
      select id into rover from public.hr_leave_requests where employee_id = ea and leave_type = 'emergency';
      select id into rpast from public.hr_leave_requests where employee_id = ea and start_date = today - 7;
      select id into rtoday from public.hr_leave_requests where employee_id = ea and start_date = today;
      select id into rb1 from public.hr_leave_requests where employee_id = eb and start_date = '2030-03-01';
      select id into rbx from public.hr_leave_requests where employee_id = eb and start_date = '2030-12-30';
      select id into ta1 from public.hr_time_off_requests where employee_id = ea and start_time = '09:00' and off_date = '2030-03-13';
      select id into ta2 from public.hr_time_off_requests where employee_id = ea and start_time = '11:00';
      select id into tpast from public.hr_time_off_requests where employee_id = ea and off_date = today - 1;
      select id into tb1 from public.hr_time_off_requests where employee_id = eb;
      select id into rv from public.hr_leave_requests where employee_id = ev;
      select id into tv from public.hr_time_off_requests where employee_id = ev;
      if rv is null or tv is null then fails := array_append(fails, 'a linked viewer''s own requests were not saved'); end if;

      select count(*) into n from public.hr_leave_requests where org_id = org;
      if n <> 8 then fails := array_append(fails, format('%s leave requests after applying, expected 8', n)); end if;
      select count(*) into n from public.hr_time_off_requests where org_id = org;
      if n <> 5 then fails := array_append(fails, format('%s time-off requests after applying, expected 5', n)); end if;

      select count(*) into n from public.hr_leave_requests
      where id = ra1 and org_id = org and days = 3 and status = 'pending' and reason = 'Family trip'
        and requested_by = ma and half_day = false and decided_by is null and decided_at is null;
      if n <> 1 then fails := array_append(fails, 'member A''s request was not saved as 3 pending days with a trimmed reason and who asked'); end if;
      select count(*) into n from public.hr_leave_requests where id = rhalf and days = 0.5 and half_day and status = 'pending';
      if n <> 1 then fails := array_append(fails, 'the half day was not saved as 0.5'); end if;
      select count(*) into n from public.hr_leave_requests where id = rover and days = 5 and status = 'pending';
      if n <> 1 then fails := array_append(fails, 'the over-balance request was not accepted as 5 pending days'); end if;
      select count(*) into n from public.hr_leave_requests where id = rbx and days = 5;
      if n <> 1 then fails := array_append(fails, 'the New Year request was not saved as 5 days'); end if;
      select count(*) into n from public.hr_time_off_requests
      where id = ta1 and org_id = org and status = 'pending' and reason = 'Bank' and requested_by = ma and end_time = '11:00';
      if n <> 1 then fails := array_append(fails, 'member A''s time-off was not saved pending with a trimmed reason and who asked'); end if;

      -- Applying made the balance rows for the years it touched, on the workspace defaults.
      select count(*) into n from public.hr_leave_balances
      where employee_id = ea and year = 2030 and used_days = 0
        and (leave_type, entitled_days) in (('annual', 20), ('medical', 14), ('emergency', 3));
      if n <> 3 then fails := array_append(fails, format('applying left member A with %s balance rows for 2030, expected 3', n)); end if;
      select count(*) into n from public.hr_leave_balances where employee_id = eb and year = 2031;
      if n <> 3 then fails := array_append(fails, format('applying across New Year left member B with %s balance rows for 2031, expected 3', n)); end if;
      select count(*) into n from public.hr_leave_balances where employee_id = ei;
      if n <> 0 then fails := array_append(fails, 'an inactive employee was given balances'); end if;
      -- Applying makes rows for the person applied for, and for nobody else.
      select count(*) into n from public.hr_leave_balances where org_id = org and year <> this_year and employee_id not in (ea, eb, ev);
      if n <> 0 then fails := array_append(fails, format('applying made %s balance rows for employees who did not apply', n)); end if;
      select count(*) into n from public.hr_leave_balances where org_id = org and year not in (this_year, 2030, 2031);
      if n <> 0 then fails := array_append(fails, format('applying made %s balance rows for years it did not touch', n)); end if;

      -- What comes back, and the admin entering leave for someone.
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_apply_leave(eb, 'annual', date '2030-05-06', date '2030-05-07', false, null);
      rbadm := (r->>'id')::uuid;
      if r->>'employee_id' <> eb::text or r->>'leave_type' <> 'annual' or r->>'start_date' <> '2030-05-06'
         or r->>'end_date' <> '2030-05-07' or (r->>'days')::numeric <> 2 or jsonb_typeof(r->'days') <> 'number'
         or r->'half_day' <> 'false'::jsonb or r->>'status' <> 'pending' then
        fails := array_append(fails, 'applying did not return the request: ' || r::text);
      end if;
      r := public.hr_apply_time_off(eb, date '2030-05-08', time '14:00', time '15:00', null);
      tbadm := (r->>'id')::uuid;
      if r->>'employee_id' <> eb::text or r->>'off_date' <> '2030-05-08' or r->>'start_time' <> '14:00:00'
         or r->>'end_time' <> '15:00:00' or r->>'status' <> 'pending' then
        fails := array_append(fails, 'requesting time-off did not return the request: ' || r::text);
      end if;
      -- The pending 5 days count against what is left for the next request.
      r := public.hr_leave_preview(ea, 'emergency', date '2030-04-08', date '2030-04-08', false);
      if (r->'years'->0->>'pending')::numeric <> 5 or (r->'years'->0->>'remaining_after')::numeric <> -3
         or (r->>'over_by')::numeric <> 3 then
        fails := array_append(fails, 'other pending leave should count against the balance: ' || r::text);
      end if;
      reset role;
      select count(*) into n from public.hr_leave_requests where id = rbadm and requested_by = admin_id and employee_id = eb;
      if n <> 1 then fails := array_append(fails, 'leave entered by the admin does not record the admin as who asked'); end if;

    elsif stage = 2 then
      select count(*) into n from public.hr_leave_requests where id = ra1 and status = 'cancelled';
      if n <> 1 then fails := array_append(fails, 'member A''s pending leave was not cancelled'); end if;
      select id into ra2 from public.hr_leave_requests
      where employee_id = ea and leave_type = 'annual' and start_date = '2030-03-01' and status = 'pending';
      if ra2 is null then fails := array_append(fails, 'a cancelled request blocked a new one for the same dates'); end if;
      select count(*) into n from public.hr_time_off_requests where employee_id = ea and off_date = '2030-03-13' and status = 'pending';
      if n <> 2 then fails := array_append(fails, 'a cancelled time-off request blocked a new one'); end if;
      select id into tnew from public.hr_time_off_requests where employee_id = ea and start_time = '11:00' and status = 'pending';

    elsif stage = 3 then
      select count(*) into n from public.hr_leave_requests
      where id = ra2 and status = 'approved' and decided_by = admin_id and decided_at is not null and decision_note is null;
      if n <> 1 then fails := array_append(fails, 'approving did not record who and when (and no note)'); end if;
      select count(*) into n from public.hr_leave_requests
      where id = rover and status = 'rejected' and decided_by = admin_id and decision_note = 'Too many at once';
      if n <> 1 then fails := array_append(fails, 'rejecting did not record the trimmed note'); end if;
      select count(*) into n from public.hr_time_off_requests
      where id = ta1 and status = 'approved' and decided_by = admin_id and decided_at is not null and decision_note is null;
      if n <> 1 then fails := array_append(fails, 'approving time-off did not record who and when'); end if;
      select count(*) into n from public.hr_time_off_requests where id = tb1 and status = 'rejected' and decision_note = 'Busy day';
      if n <> 1 then fails := array_append(fails, 'rejecting time-off did not record the trimmed note'); end if;

      select used_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'annual' and year = 2030;
      if d is distinct from 3 then fails := array_append(fails, format('member A has used %s annual days after the approval, expected 3', d)); end if;
      select used_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'medical' and year = 2030;
      if d is distinct from 0.5 then fails := array_append(fails, format('member A has used %s medical days after the half day, expected 0.5', d)); end if;
      select used_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'emergency' and year = 2030;
      if d is distinct from 0 then fails := array_append(fails, format('a rejected request used %s days', d)); end if;
      select used_days into d from public.hr_leave_balances where employee_id = eb and leave_type = 'annual' and year = 2030;
      if d is distinct from 2 then fails := array_append(fails, format('member B has used %s days in 2030 for the New Year leave, expected 2', d)); end if;
      select used_days into d from public.hr_leave_balances where employee_id = eb and leave_type = 'annual' and year = 2031;
      if d is distinct from 3 then fails := array_append(fails, format('member B has used %s days in 2031 for the New Year leave, expected 3', d)); end if;

      -- The admin sets an entitlement, and the next preview shows it.
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_set_leave_entitlement(ea, 'annual', 2030, 10.5);
      if r->>'employee_id' <> ea::text or r->>'leave_type' <> 'annual' or (r->>'year')::int <> 2030
         or (r->>'entitled_days')::numeric <> 10.5 or (r->>'used_days')::numeric <> 3 then
        fails := array_append(fails, 'setting an entitlement did not return the balance: ' || r::text);
      end if;
      r := public.hr_leave_preview(ea, 'annual', date '2030-03-11', date '2030-03-12', false);
      if (r->'years'->0->>'entitled')::numeric <> 10.5 or (r->'years'->0->>'used')::numeric <> 3
         or (r->'years'->0->>'pending')::numeric <> 0 or (r->'years'->0->>'remaining_after')::numeric <> 5.5 then
        fails := array_append(fails, 'the preview does not show the new entitlement and the days used: ' || r::text);
      end if;
      -- A year nobody has rows for: the row is made for that employee, inactive or not, and nobody else.
      r := public.hr_set_leave_entitlement(ei, 'medical', 2032, 0);
      if (r->>'entitled_days')::numeric <> 0 or (r->>'used_days')::numeric <> 0 then
        fails := array_append(fails, 'setting an entitlement for a new year did not make the row: ' || r::text);
      end if;
      r := public.hr_set_leave_entitlement(eb, 'medical', 2033, 9);
      reset role;
      select count(*) filter (where year = 2032), count(*) filter (where year = 2033) into n, n2
      from public.hr_leave_balances where org_id = org;
      if n <> 1 or n2 <> 3 then
        fails := array_append(fails, format('setting an entitlement left %s rows for 2032 and %s for 2033, expected 1 (the inactive employee) and 3 (member B only)', n, n2));
      end if;

      -- A request keeps the days counted when it was made. Two holidays are
      -- now added inside leave already approved: 4 Mar 2030 inside member A's
      -- 3 days, and 31 Dec 2030 inside member B's New Year leave (saved as 5,
      -- split 2 + 3). Then other leave is approved and cancelled for each.
      insert into public.hr_public_holidays (org_id, name, holiday_date)
      values (org, 'Added Later', date '2030-03-04'), (org, 'Added Later Too', date '2030-12-31');
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      xa := (public.hr_apply_leave(ea, 'annual', date '2030-03-26', date '2030-03-27', false, null)->>'id')::uuid;
      xb := (public.hr_apply_leave(eb, 'annual', date '2030-06-10', date '2030-06-10', false, null)->>'id')::uuid;
      perform public.hr_decide_leave(xa, true, null);
      perform public.hr_decide_leave(xb, true, null);
      reset role;
      select used_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'annual' and year = 2030;
      if d is distinct from 5 then
        fails := array_append(fails, format('after a holiday was added inside approved leave and more leave approved, member A has used %s days, expected the stored 3 + 2', d));
      end if;
      -- The New Year request still costs 5 in all; the day the new holiday took from 2030 moves to 2031.
      select sum(used_days), max(used_days) filter (where year = 2030), max(used_days) filter (where year = 2031) into d, n, n2
      from public.hr_leave_balances where employee_id = eb and leave_type = 'annual';
      if d is distinct from 6 or n <> 2 or n2 <> 4 then
        fails := array_append(fails, format('after a holiday was added inside New Year leave, member B has used %s days (%s in 2030, %s in 2031), expected the stored 5 + 1 as 2 and 4', d, n, n2));
      end if;
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      perform public.hr_cancel_leave(xa);
      perform public.hr_cancel_leave(xb);
      reset role;
      select used_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'annual' and year = 2030;
      if d is distinct from 3 then
        fails := array_append(fails, format('after cancelling the other leave, member A has used %s days, expected the stored 3', d));
      end if;
      select sum(used_days) into d from public.hr_leave_balances where employee_id = eb and leave_type = 'annual';
      if d is distinct from 5 then
        fails := array_append(fails, format('after cancelling the other leave, member B has used %s days, expected the stored 5', d));
      end if;
      select count(*) into n from public.hr_leave_requests where id in (ra2, rbx) and days in (3, 5);
      if n <> 2 then fails := array_append(fails, 'a later holiday changed the days saved on a request'); end if;

    elsif stage = 4 then
      select count(*) into n from public.hr_leave_requests where id in (ra2, rbx) and status = 'cancelled' and days in (3, 5);
      if n <> 2 then fails := array_append(fails, 'a member could not cancel own approved leave that has not started'); end if;
      select count(*) into n from public.hr_leave_requests where id in (rpast, rtoday) and status = 'approved';
      if n <> 2 then fails := array_append(fails, 'leave that had started did not stay approved'); end if;
      select count(*) into n from public.hr_time_off_requests where id = ta1 and status = 'cancelled';
      if n <> 1 then fails := array_append(fails, 'a member could not cancel own approved time-off in the future'); end if;
      select coalesce(sum(used_days), 0) into d from public.hr_leave_balances
      where (employee_id = ea and leave_type = 'annual' and year = 2030) or (employee_id = eb and leave_type = 'annual');
      if d <> 0 then fails := array_append(fails, format('%s annual days still used after the approved leave was cancelled, expected 0', d)); end if;
      select used_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'medical' and year = 2030;
      if d is distinct from 0.5 then fails := array_append(fails, 'cancelling annual leave changed the medical balance'); end if;
      select entitled_days into d from public.hr_leave_balances where employee_id = ea and leave_type = 'annual' and year = 2030;
      if d is distinct from 10.5 then fails := array_append(fails, 'cancelling leave changed the entitlement'); end if;

    elsif stage = 5 then
      select count(*) into n from public.hr_leave_requests where org_id = org and status <> 'cancelled';
      if n <> 0 then fails := array_append(fails, format('%s leave requests the admin could not cancel', n)); end if;
      select count(*) into n from public.hr_time_off_requests where org_id = org and status = 'cancelled';
      -- Everything but the one member A left pending (11:00 to 12:30).
      if n <> 6 then fails := array_append(fails, format('%s time-off requests cancelled, expected 6', n)); end if;
      select coalesce(sum(used_days), 0) into d from public.hr_leave_balances where org_id = org;
      if d <> 0 then fails := array_append(fails, format('%s days still used after every request was cancelled', d)); end if;

      -- Every column the real auth.mfa_factors requires (none has a default).
      insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), ma, 'totp', 'verified', now(), now()),
             (gen_random_uuid(), admin_id, 'totp', 'verified', now(), now());
    end if;
  end loop;

  -- With the code entered (aal2) the same member is let through again.
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  begin
    perform public.hr_apply_leave(ea, 'annual', date '2030-07-01', date '2030-07-02', false, null);
  exception when others then
    fails := array_append(fails, 'member A with the second factor entered was refused: ' || sqlerrm);
  end;
  reset role;
  delete from auth.mfa_factors where user_id in (ma, admin_id);

  -- ---- no direct writes, for a member or the admin ----------------------
  for who, label in select * from (values (ma, 'a member'), (admin_id, 'the admin')) as w(who, label) loop
    for t, q in
      select x.t, x.q from (values
        ('hr_leave_requests', format('insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days) values (%L, %L, ''annual'', ''2030-08-01'', ''2030-08-01'', 1)', org, ea)),
        ('hr_leave_requests', format('update public.hr_leave_requests set status = ''approved'' where employee_id = %L', ea)),
        ('hr_leave_requests', format('delete from public.hr_leave_requests where employee_id = %L', ea)),
        ('hr_leave_balances', format('insert into public.hr_leave_balances (org_id, employee_id, leave_type, year, entitled_days) values (%L, %L, ''annual'', 2044, 99)', org, ea)),
        ('hr_leave_balances', format('update public.hr_leave_balances set entitled_days = 99 where employee_id = %L', ea)),
        ('hr_leave_balances', format('delete from public.hr_leave_balances where employee_id = %L', ea)),
        ('hr_time_off_requests', format('insert into public.hr_time_off_requests (org_id, employee_id, off_date, start_time, end_time) values (%L, %L, ''2030-08-01'', ''09:00'', ''10:00'')', org, ea)),
        ('hr_time_off_requests', format('update public.hr_time_off_requests set status = ''approved'' where employee_id = %L', ea)),
        ('hr_time_off_requests', format('delete from public.hr_time_off_requests where employee_id = %L', ea))
      ) as x(t, q)
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        execute q;
        fails := array_append(fails, format('%s wrote to %s directly: %s', label, t, split_part(q, ' ', 1)));
      exception
        when insufficient_privilege then null;
        when others then
          fails := array_append(fails, format('%s writing to %s directly was refused for another reason: %s', label, t, sqlerrm));
      end;
      reset role;
    end loop;
  end loop;

  -- ---- a member still reads only their own ------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mb, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.hr_leave_requests where org_id = org and employee_id <> eb;
  select count(*) into n2 from public.hr_leave_requests where org_id = org and employee_id = eb;
  reset role;
  if n <> 0 or n2 <> 4 then
    fails := array_append(fails, format('member B reads %s of a colleague''s requests and %s of their own 4', n, n2));
  end if;

  -- ---- the yearly job, and the demo --------------------------------------
  delete from public.hr_leave_balances where employee_id = ea and year = this_year;
  select count(*) into n from public.hr_leave_balances where org_id = demo;
  perform private.hr_ensure_leave_balances_all();
  select count(*) into n2 from public.hr_leave_balances where employee_id = ea and year = this_year;
  if n2 <> 3 then fails := array_append(fails, format('the yearly job left member A with %s balance rows, expected 3', n2)); end if;
  select count(*) into n2 from public.hr_leave_balances where employee_id = ei and year = this_year;
  if n2 <> 0 then fails := array_append(fails, 'the yearly job gave an inactive employee balances'); end if;
  select count(*) into n2 from public.hr_leave_balances where org_id = demo;
  if n2 <> n then fails := array_append(fails, 'the yearly job touched the demo workspace'); end if;

  perform private.reseed_demo_people();
  select count(*), count(*) filter (where leave_type = 'annual' and entitled_days = 16) into n, n2
  from public.hr_leave_balances where org_id = demo;
  if n <> 60 or n2 <> 20 then
    fails := array_append(fails, format('the demo has %s balance rows (%s annual at 16) after a reseed, expected 60 (20)', n, n2));
  end if;
  select count(*) into n from public.hr_leave_requests where org_id = demo and (half_day or requested_by is not null or decision_note is not null);
  if n <> 0 then fails := array_append(fails, 'the demo reseed set one of the new columns'); end if;

  -- ---- a workspace with leave in it can still be deleted -----------------
  begin
    delete from public.orgs where id = org;
  exception when others then
    fails := array_append(fails, 'deleting a workspace with leave in it failed: ' || sqlerrm);
  end;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := array_append(fails, format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1)));
  end;

  raise exception 'PEOPLE_LEAVE_CHECK %', case
    when cardinality(fails) = 0 then 'PASSED (everything rolled back)'
    else format('FAILED (%s): %s', cardinality(fails), array_to_string(fails[1:15], '; '))
  end;
end $$;
