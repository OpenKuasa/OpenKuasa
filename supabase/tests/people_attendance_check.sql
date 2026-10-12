-- Lekiu attendance access check. Leaves nothing behind: the block always ends
-- with RAISE, so every row below is rolled back, and so is the date it moves
-- the attendance epoch to. Read the message:
--   PEOPLE_ATTENDANCE_CHECK PASSED ...   or   PEOPLE_ATTENDANCE_CHECK FAILED (n): <what went wrong>
-- It rebuilds the demo HR rows inside its transaction and holds them until the
-- rollback, so do not start it at minute 1 of the hour, when the scheduled
-- demo reseed runs, nor at minute 5 past midnight in Malaysia, when the
-- nightly close runs, nor in the whole first minute after midnight in
-- Malaysia (00:00:00 to 00:00:59): late is judged to the minute, so no
-- clock-in can be late then and the late cases would fail.
--
-- How it works: each numbered stage is a list of (who, what, the call, the
-- refusal expected or null when it must succeed). One loop runs every call as
-- that person and records anything that went the other way. Between stages
-- the block looks at the rows as the database owner.
--
-- Clocking in reads the real clock, so nothing here waits for a time of day:
--   * present and late are driven by saving a start time an hour ahead of, or
--     an hour behind, the Malaysia time of this transaction, with no grace;
--   * the boundary itself is asked of private.hr_attendance_status directly,
--     with fixed timestamps;
--   * when today is outside the default Monday-to-Friday week, the clock cases
--     run on a work week widened to include it, and the last line says so.
-- The nightly close is run by calling private.hr_attendance_close() after the
-- epoch is moved back, on a second workspace whose leave, holidays and
-- attendance are planted at dates counted back from today, and whose start
-- (the day a workspace first used attendance) is planted too, as is the day
-- the close first saw an employee linked and active. While it runs, the
-- close also works through every real workspace inside this transaction; all
-- of that is rolled back with the rest.
do $$
declare
  org uuid := gen_random_uuid();        -- where people clock in and out
  other_org uuid := gen_random_uuid();
  corg uuid := gen_random_uuid();       -- where the nightly close is tried
  sorg uuid := gen_random_uuid();       -- a workspace that has not started using attendance
  s1 uuid; s2 uuid;
  s_from date;                          -- the first real attendance day of that workspace, once it has one
  s1_own date[] := '{}'; s2_own date[] := '{}';
  ku uuid;                              -- an active employee of the close workspace linked to nobody
  ku_id uuid;                           -- a day an admin corrected for them, before the epoch
  stray_id uuid;                        -- a row in the not-started workspace that nobody clocked or corrected
  el uuid;                              -- a linked employee of the other workspace
  o_days date[];                        -- the days the other workspace's linked employee must be closed for
  er uuid;                              -- an employee of the other workspace, linked but inactive until run 5
  sat_id uuid;                          -- a row in the third workspace on a holiday before it started
  demo uuid;
  admin_id uuid := gen_random_uuid();   -- admin of org, linked to employee AD
  ma uuid := gen_random_uuid();         -- member linked to employee A
  mb uuid := gen_random_uuid();         -- member linked to employee B
  mv uuid := gen_random_uuid();         -- workspace role 'viewer', linked to employee V
  mu uuid := gen_random_uuid();         -- member with no employee record
  mi uuid := gen_random_uuid();         -- member linked to an inactive employee
  m3 uuid := gen_random_uuid();         -- member on approved full-day leave today
  m4 uuid := gen_random_uuid();         -- member on approved half-day leave today
  m5 uuid := gen_random_uuid();         -- member whose leave for today is still pending
  outsider uuid := gen_random_uuid();   -- owner of another workspace
  dv uuid := gen_random_uuid();         -- demo visitor (viewer)
  da uuid := gen_random_uuid();         -- an admin planted in the demo, linked to a demo employee
  ead uuid; ea uuid; eb uuid; ev uuid; ei uuid; e3 uuid; e4 uuid; e5 uuid;
  ec uuid;                              -- active employee linked to nobody
  eo uuid;                              -- an employee of the other workspace
  demo_emp uuid := md5('rimba-emp-1')::uuid;
  demo_emp2 uuid := md5('rimba-emp-2')::uuid;
  h_org uuid; h_org2 uuid; h_other uuid; demo_h uuid;
  sys_id uuid;
  pre_id uuid;                          -- a row from before the epoch, on a Saturday
  -- the close
  k1 uuid; k2 uuid; k3 uuid; k4 uuid; k5 uuid; k6 uuid; k7 uuid; k8 uuid; k9 uuid;
  wd date[];                            -- Monday-to-Friday dates in the last 12 days, oldest first
  sat date;                             -- the latest Saturday before today
  last_sun date;                        -- the latest Sunday before today
  hol date[];
  days date[];
  k2_leave date[]; k3_leave date[]; k8_leave date[]; k6_own date[];
  k4_from date; k7_from date;
  l2 uuid; l8 uuid;
  wk jsonb;
  exp text[]; act text[]; diff text[];
  snap text; snap2 text; own_snap text; demo_att text; demo_rest text;
  run int;
  -- the clock
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  mins int := extract(hour from (now() at time zone 'Asia/Kuala_Lumpur'))::int * 60
            + extract(minute from (now() at time zone 'Asia/Kuala_Lumpur'))::int;
  ahead time;                           -- a start time an hour from now: clocking in is on time
  behind time;                          -- a start time an hour ago: clocking in is late
  today_key text := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'dy');
  widened boolean;
  week_with_today jsonb;
  week_without_today jsonb;
  default_week jsonb := '["mon","tue","wed","thu","fri"]'::jsonb;
  orig_tz text := current_setting('timezone');
  zone text;
  at_time timestamptz;
  stage int;
  who uuid;
  label text;
  q text;
  want text;
  r jsonb;
  n int;
  n2 int;
  t text;
  sig text;
  rec record;
  ctx text;
  long_text text := repeat('x', 501);
  long_name text := repeat('n', 121);
  ok_name text := repeat('n', 120);
  day_keys text[] := array['clock_in','clock_out','employee_id','id','status','work_date'];
  fails text[] := '{}';
  functions text[] := array[
    'public.hr_clock_in(uuid)',
    'public.hr_clock_out(uuid)',
    'public.hr_correct_attendance(uuid,date,text,time without time zone,time without time zone,text)',
    'public.hr_save_holiday(uuid,uuid,text,date)',
    'public.hr_delete_holiday(uuid)',
    'public.hr_save_attendance_settings(uuid,jsonb,time without time zone,integer)'];
  helpers text[] := array[
    'private.hr_is_working_day(uuid,date)',
    'private.hr_on_approved_leave(uuid,date,boolean)',
    'private.hr_attendance_status(uuid,timestamp with time zone)',
    'private.hr_attendance_may_clock(uuid)',
    'private.hr_attendance_admin_only(uuid)',
    'private.hr_attendance_day_json(public.hr_attendance_days)',
    'private.hr_attendance_close()'];
  att_tables text[] := array['hr_attendance_days','hr_public_holidays','hr_settings'];
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
        and p.proconfig @> array['search_path=public'] and p.prorettype = 'jsonb'::regtype;
      if n <> 1 then fails := array_append(fails, format('%s is not security definer with a fixed search path, returning jsonb', sig)); end if;
    end if;
  end loop;
  -- One of each, so there is no second clock function that takes a time or a date.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('hr_clock_in','hr_clock_out','hr_correct_attendance','hr_save_holiday','hr_delete_holiday','hr_save_attendance_settings');
  if n <> 6 then fails := array_append(fails, format('%s functions carry the six attendance names, expected 6', n)); end if;
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
  if to_regprocedure('private.hr_attendance_close()') is not null then
    if has_function_privilege('service_role', 'private.hr_attendance_close()', 'execute') then
      fails := array_append(fails, 'the service role may run the nightly close');
    end if;
    select count(*) into n from pg_proc p where p.oid = to_regprocedure('private.hr_attendance_close()') and p.prosecdef
      and p.proconfig @> array['search_path=public'];
    if n <> 1 then fails := array_append(fails, 'the nightly close does not run as its owner on a fixed search path'); end if;
  end if;
  foreach t in array att_tables loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      fails := array_append(fails, format('%s has a write grant', t));
    end if;
    select count(*) into n from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname not in (t || '_select', 'mfa_required');
    select count(*) into n2 from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname in (t || '_select', 'mfa_required');
    if n <> 0 or n2 <> 2 then fails := array_append(fails, format('%s does not have exactly its read policy and the second-factor one', t)); end if;
  end loop;
  select count(*) into n from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'hr_attendance_days'
    and (c.column_name, c.data_type) in (('corrected_by', 'uuid'), ('corrected_at', 'timestamp with time zone'), ('correction_note', 'text'))
    and c.is_nullable = 'YES' and c.column_default is null;
  if n <> 3 then fails := array_append(fails, format('%s of the 3 new attendance columns exist as nullable columns with no default', n)); end if;
  select count(*) into n from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'hr_settings' and c.is_nullable = 'NO'
    and ((c.column_name = 'work_start_time' and c.data_type = 'time without time zone' and c.column_default like '%09:00%')
      or (c.column_name = 'late_grace_minutes' and c.data_type = 'integer' and c.column_default = '15'));
  if n <> 2 then fails := array_append(fails, format('%s of the 2 new settings columns exist, required, with their defaults', n)); end if;
  select count(*) into n from pg_constraint con
  where con.conrelid = 'public.hr_attendance_days'::regclass and con.contype = 'f'
    and con.confrelid = 'auth.users'::regclass and con.confdeltype = 'n';
  if n <> 1 then fails := array_append(fails, 'who corrected a day is not a link to a user that empties when the user goes'); end if;

  -- The epoch: one row, in a table nobody may touch.
  if to_regclass('private.hr_attendance_epoch') is null then
    fails := array_append(fails, 'private.hr_attendance_epoch does not exist');
  else
    foreach t in array array['anon', 'authenticated', 'service_role', 'public'] loop
      if has_table_privilege(t, 'private.hr_attendance_epoch', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         or has_any_column_privilege(t, 'private.hr_attendance_epoch', 'SELECT, INSERT, UPDATE') then
        fails := array_append(fails, format('%s holds a privilege on the epoch table', t));
      end if;
    end loop;
    select count(*) into n from pg_class c where c.oid = 'private.hr_attendance_epoch'::regclass and c.relrowsecurity;
    select count(*) into n2 from pg_policies p where p.schemaname = 'private' and p.tablename = 'hr_attendance_epoch';
    if n <> 1 or n2 <> 0 then fails := array_append(fails, 'the epoch table does not have row level security on with no policy'); end if;
    execute 'select count(*), count(*) filter (where started_on <= $1) from private.hr_attendance_epoch' into n, n2 using today;
    if n <> 1 or n2 <> 1 then fails := array_append(fails, format('the epoch table holds %s rows (%s not after today), expected one', n, n2)); end if;
    begin
      execute 'insert into private.hr_attendance_epoch (started_on) values ($1)' using today - 400;
      fails := array_append(fails, 'the epoch table took a second row');
    exception when others then null;
    end;
  end if;
  -- The day each workspace first used attendance: a table nobody may touch,
  -- one row a workspace, gone with the workspace.
  if to_regclass('private.hr_attendance_started') is null then
    fails := array_append(fails, 'private.hr_attendance_started does not exist');
  else
    foreach t in array array['anon', 'authenticated', 'service_role', 'public'] loop
      if has_table_privilege(t, 'private.hr_attendance_started', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         or has_any_column_privilege(t, 'private.hr_attendance_started', 'SELECT, INSERT, UPDATE') then
        fails := array_append(fails, format('%s holds a privilege on the table of workspace start days', t));
      end if;
    end loop;
    select count(*) into n from pg_class c where c.oid = 'private.hr_attendance_started'::regclass and c.relrowsecurity;
    select count(*) into n2 from pg_policies p where p.schemaname = 'private' and p.tablename = 'hr_attendance_started';
    if n <> 1 or n2 <> 0 then fails := array_append(fails, 'the table of workspace start days does not have row level security on with no policy'); end if;
    select count(*) into n from pg_constraint con
    where con.conrelid = 'private.hr_attendance_started'::regclass
      and ((con.contype = 'p' and pg_get_constraintdef(con.oid) = 'PRIMARY KEY (org_id)')
        or (con.contype = 'f' and con.confrelid = 'public.orgs'::regclass and con.confdeltype = 'c'));
    if n <> 2 then fails := array_append(fails, 'the table of workspace start days is not keyed by workspace, or does not go with its workspace'); end if;
  end if;
  -- The day the close first saw each employee linked and active: a table nobody
  -- may touch, one row an employee, gone with the employee.
  if to_regclass('private.hr_attendance_covered') is null then
    fails := array_append(fails, 'private.hr_attendance_covered does not exist');
  else
    foreach t in array array['anon', 'authenticated', 'service_role', 'public'] loop
      if has_table_privilege(t, 'private.hr_attendance_covered', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         or has_any_column_privilege(t, 'private.hr_attendance_covered', 'SELECT, INSERT, UPDATE') then
        fails := array_append(fails, format('%s holds a privilege on the table of covered employees', t));
      end if;
    end loop;
    select count(*) into n from pg_class c where c.oid = 'private.hr_attendance_covered'::regclass and c.relrowsecurity;
    select count(*) into n2 from pg_policies p where p.schemaname = 'private' and p.tablename = 'hr_attendance_covered';
    if n <> 1 or n2 <> 0 then fails := array_append(fails, 'the table of covered employees does not have row level security on with no policy'); end if;
    select count(*) into n from pg_constraint con
    where con.conrelid = 'private.hr_attendance_covered'::regclass
      and ((con.contype = 'p' and pg_get_constraintdef(con.oid) = 'PRIMARY KEY (employee_id)')
        or (con.contype = 'f' and con.confrelid = 'public.hr_employees'::regclass and con.confdeltype = 'c'));
    if n <> 2 then fails := array_append(fails, 'the table of covered employees is not keyed by employee, or does not go with its employee'); end if;
  end if;
  -- Where pg_cron is installed, the nightly job is there, once, at 00:05 in Malaysia.
  if to_regclass('cron.job') is not null then
    execute 'select count(*), count(*) filter (where schedule = ''5 16 * * *'' and command like ''%private.hr_attendance_close()%'')'
         || ' from cron.job where jobname = ''close-attendance'' or command like ''%hr_attendance_close%''' into n, n2;
    if n <> 1 or n2 <> 1 then fails := array_append(fails, format('%s scheduled jobs run the nightly close (%s as expected), expected one at 5 16 * * *', n, n2)); end if;
  end if;
  if cardinality(fails) > 0 then raise exception 'the functions, grants and columns are not as expected, so nothing else was tried'; end if;

  -- ---- the clock, and a week with today in it -----------------------------
  ahead := case when mins + 60 >= 1440 then time '23:59:59.999999' else make_time((mins + 60) / 60, (mins + 60) % 60, 0) end;
  behind := case when mins < 60 then time '00:00' else make_time((mins - 60) / 60, (mins - 60) % 60, 0) end;
  widened := today_key in ('sat', 'sun');
  select jsonb_agg(k.key order by k.pos) into week_with_today
  from unnest(array['mon','tue','wed','thu','fri','sat','sun']) with ordinality as k(key, pos)
  where k.key in ('mon','tue','wed','thu','fri') or k.key = today_key;
  select jsonb_agg(k.key order by k.pos) into week_without_today
  from unnest(array['mon','tue','wed','thu','fri','sat','sun']) with ordinality as k(key, pos)
  where k.key <> today_key;

  -- ---- people and workspaces ----------------------------------------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@att-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[admin_id, ma, mb, mv, mu, mi, m3, m4, m5, outsider, dv, da]) as u(id);

  insert into public.orgs (id, name)
  values (org, 'Attendance Check Sdn Bhd'), (other_org, 'Attendance Other Sdn Bhd'), (corg, 'Attendance Close Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, admin_id, 'admin'), (org, ma, 'member'), (org, mb, 'member'), (org, mv, 'viewer'), (org, mu, 'member'),
         (org, mi, 'member'), (org, m3, 'member'), (org, m4, 'member'), (org, m5, 'member'),
         (other_org, outsider, 'owner'), (other_org, ma, 'member'), (other_org, mb, 'member'), (demo, dv, 'viewer'), (demo, da, 'admin');

  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'AD', 'Admin Own Record', admin_id || '@att-check.openkuasa-test.dev') returning id into ead;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'A', 'Member A', ma || '@att-check.openkuasa-test.dev') returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'B', 'Member B', mb || '@att-check.openkuasa-test.dev') returning id into eb;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'V', 'Viewer V', mv || '@att-check.openkuasa-test.dev') returning id into ev;
  insert into public.hr_employees (org_id, employee_no, name, work_email, status)
  values (org, 'I', 'Inactive One', mi || '@att-check.openkuasa-test.dev', 'inactive') returning id into ei;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, '3', 'On Leave Today', m3 || '@att-check.openkuasa-test.dev') returning id into e3;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, '4', 'Half Day Today', m4 || '@att-check.openkuasa-test.dev') returning id into e4;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, '5', 'Leave Still Pending', m5 || '@att-check.openkuasa-test.dev') returning id into e5;
  insert into public.hr_employees (org_id, employee_no, name)
  values (org, 'C', 'Linked To Nobody') returning id into ec;
  insert into public.hr_employees (org_id, employee_no, name)
  values (other_org, 'O', 'Someone Elsewhere') returning id into eo;
  insert into public.hr_employees (org_id, employee_no, name, user_id)
  values (other_org, 'L', 'Member A Elsewhere', ma) returning id into el;
  insert into public.hr_employees (org_id, employee_no, name, user_id, status)
  values (other_org, 'R', 'Member B Elsewhere', mb, 'inactive') returning id into er;
  -- Linked by hand, as an owner or admin links them: a matching email links nobody (20261101134500_employee_account_link).
  update public.hr_employees e set user_id = v.u
  from (values (ead, admin_id), (ea, ma), (eb, mb), (ev, mv), (ei, mi), (e3, m3), (e4, m4), (e5, m5)) as v(e, u) where e.id = v.e;
  select count(*) into n from public.hr_employees
  where (id, user_id) in ((ead, admin_id), (ea, ma), (eb, mb), (ev, mv), (ei, mi), (e3, m3), (e4, m4), (e5, m5));
  if n <> 8 then fails := array_append(fails, format('%s of 8 members were linked to their employee records', n)); end if;
  -- A demo admin who is also linked to a demo employee: the demo still refuses them.
  update public.hr_employees set user_id = da where id = demo_emp2;

  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, half_day, status)
  values (org, e3, 'annual', today - 1, today + 1, 3, false, 'approved'),
         (org, e4, 'annual', today, today, 0.5, true, 'approved'),
         (org, e5, 'annual', today, today, 1, false, 'pending'),
         (org, e5, 'annual', today, today, 1, false, 'rejected'),
         (org, e5, 'annual', today - 1, today + 1, 3, false, 'cancelled');
  insert into public.hr_public_holidays (org_id, name, holiday_date, scope, state)
  values (org, 'Planted Day', date '2024-03-05', 'state', 'Selangor') returning id into h_org;
  insert into public.hr_public_holidays (org_id, name, holiday_date)
  values (org, 'Planted To Remove', date '2024-03-19') returning id into h_org2;
  insert into public.hr_public_holidays (org_id, name, holiday_date)
  values (other_org, 'Other Day', date '2024-03-05') returning id into h_other;
  select id into demo_h from public.hr_public_holidays where org_id = demo order by holiday_date limit 1;
  if demo_h is null then fails := array_append(fails, 'the demo workspace has no public holiday to try'); end if;
  select md5(coalesce(string_agg(x.line, ',' order by x.line), '')) into demo_rest from (
    select h::text as line from public.hr_public_holidays h where h.org_id = demo
    union all select s::text from public.hr_settings s where s.org_id = demo
  ) x;

  -- ---- present or late, to the minute ---------------------------------------
  -- Asked of the one function that decides it, as the owner, with fixed
  -- timestamps: with no settings row, with a row on its defaults, and with
  -- custom settings. Each is asked in three session time zones, since the
  -- answer is about the clock in Malaysia whatever zone the server keeps.
  -- A clock-in is on time up to and including the minute of start plus grace:
  -- the seconds are not counted, so the answer agrees with the time shown.
  for stage in 1..6 loop
    if stage = 2 then
      insert into public.hr_settings (org_id) values (org);
    elsif stage = 3 then
      update public.hr_settings set work_start_time = '08:30', late_grace_minutes = 10 where org_id = org;
    elsif stage = 4 then
      update public.hr_settings set work_start_time = '08:30', late_grace_minutes = 0 where org_id = org;
    elsif stage = 5 then
      update public.hr_settings set work_start_time = '23:00', late_grace_minutes = 240 where org_id = org;
    elsif stage = 6 then
      update public.hr_settings set work_start_time = '00:00', late_grace_minutes = 0 where org_id = org;
    end if;
    for at_time, want, label in
      select c.at_time, c.want, c.label from (values
        (1, timestamptz '2024-03-04 09:15:00+08', 'present', 'no settings row, at 09:15'),
        (1, timestamptz '2024-03-04 09:16:00+08', 'late', 'no settings row, at 09:16'),
        (1, timestamptz '2024-03-04 09:15:01+08', 'present', 'no settings row, one second after 09:15 (still that minute)'),
        (1, timestamptz '2024-03-04 09:15:20+08', 'present', 'no settings row, at 09:15:20'),
        (1, timestamptz '2024-03-04 09:15:59.999+08', 'present', 'no settings row, at the end of the minute of 09:15'),
        (1, timestamptz '2024-03-04 09:00:00+08', 'present', 'no settings row, at 09:00'),
        (1, timestamptz '2024-03-04 00:00:00+08', 'present', 'no settings row, at midnight'),
        (1, timestamptz '2024-03-04 01:15:00+00', 'present', 'no settings row, 09:15 written in UTC'),
        (1, timestamptz '2024-03-04 01:16:00+00', 'late', 'no settings row, 09:16 written in UTC'),
        (1, timestamptz '2024-03-03 20:15:00-05', 'present', 'no settings row, 09:15 written in New York time'),
        (1, timestamptz '2024-03-03 20:16:00-05', 'late', 'no settings row, 09:16 written in New York time'),
        (2, timestamptz '2024-03-04 09:15:00+08', 'present', 'a settings row on its defaults, at 09:15'),
        (2, timestamptz '2024-03-04 09:16:00+08', 'late', 'a settings row on its defaults, at 09:16'),
        (3, timestamptz '2024-03-04 08:30:00+08', 'present', '08:30 with 10 minutes, at 08:30'),
        (3, timestamptz '2024-03-04 08:40:00+08', 'present', '08:30 with 10 minutes, at 08:40'),
        (3, timestamptz '2024-03-04 08:40:59+08', 'present', '08:30 with 10 minutes, at 08:40:59'),
        (3, timestamptz '2024-03-04 08:41:00+08', 'late', '08:30 with 10 minutes, at 08:41'),
        (3, timestamptz '2024-03-04 09:15:00+08', 'late', '08:30 with 10 minutes, at 09:15'),
        (4, timestamptz '2024-03-04 08:30:00+08', 'present', '08:30 with no grace, at 08:30'),
        (4, timestamptz '2024-03-04 08:31:00+08', 'late', '08:30 with no grace, at 08:31'),
        (5, timestamptz '2024-03-04 23:59:00+08', 'present', '23:00 with 240 minutes, at 23:59 (the limit does not wrap past midnight)'),
        (5, timestamptz '2024-03-04 07:00:00+08', 'present', '23:00 with 240 minutes, in the morning'),
        (6, timestamptz '2024-03-04 00:00:00+08', 'present', 'midnight with no grace, at midnight'),
        (6, timestamptz '2024-03-04 00:00:59+08', 'present', 'midnight with no grace, at 00:00:59'),
        (6, timestamptz '2024-03-04 00:01:00+08', 'late', 'midnight with no grace, at 00:01')
      ) as c(s, at_time, want, label)
      where c.s = stage
    loop
      foreach zone in array array['UTC', 'America/New_York', 'Asia/Kuala_Lumpur'] loop
        perform set_config('timezone', zone, true);
        t := private.hr_attendance_status(org, at_time);
        if t is distinct from want then
          fails := array_append(fails, format('present or late (%s, session zone %s): got %s, expected %s', label, zone, t, want));
        end if;
      end loop;
    end loop;
  end loop;
  perform set_config('timezone', orig_tz, true);
  t := private.hr_attendance_status(gen_random_uuid(), timestamptz '2024-03-04 09:16:00+08');
  if t is distinct from 'late' then fails := array_append(fails, 'present or late for a workspace that does not exist did not fall back to 09:00 and 15 minutes'); end if;
  -- The table itself keeps the grace within 0 to 240 minutes.
  begin
    update public.hr_settings set late_grace_minutes = 241 where org_id = org;
    fails := array_append(fails, 'the table took a grace period of 241 minutes');
  exception when check_violation then null;
  end;
  begin
    update public.hr_settings set late_grace_minutes = -1 where org_id = org;
    fails := array_append(fails, 'the table took a grace period below zero');
  exception when check_violation then null;
  end;
  delete from public.hr_settings where org_id = org;
  -- The other workspace has settings of its own, which saving must leave alone.
  insert into public.hr_settings (org_id, default_annual_leave_days, overtime_rates, notifications, updated_at)
  values (other_org, 20, '{"weekday": 2.5}'::jsonb, '{"birthdays": true}'::jsonb, now() - interval '1 day');

  -- ---- the stages --------------------------------------------------------
  for stage in 1..4 loop
    if stage = 3 then
      -- A day the system recorded: no clock-in, nobody corrected it.
      insert into public.hr_attendance_days (org_id, employee_id, work_date, status)
      values (org, ec, today - 5, 'absent') returning id into sys_id;
    elsif stage = 4 then
      -- Member B, member 5 and the admin now have an authenticator, and these
      -- sessions have not entered a code. Member B's day is cleared, so the
      -- only thing between member B and a clock-in is the second factor.
      delete from public.hr_attendance_days where employee_id = eb and work_date = today;
      -- Every column the real auth.mfa_factors requires (none has a default).
      insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), mb, 'totp', 'verified', now(), now()),
             (gen_random_uuid(), m5, 'totp', 'verified', now(), now()),
             (gen_random_uuid(), admin_id, 'totp', 'verified', now(), now());
    end if;

    for who, label, q, want in
      select c.who, c.label, c.q, c.want from (values
        -- 1: settings, holidays, who may clock whom; the start time is an hour ahead, so a clock-in is on time
        (1, admin_id, 'the admin saves the settings when there is no settings row yet', format('select public.hr_save_attendance_settings(%L, %L, %L, 0)', org, week_with_today, ahead), null),
        (1, admin_id, 'a work week that is empty', format('select public.hr_save_attendance_settings(%L, ''[]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week with a day twice', format('select public.hr_save_attendance_settings(%L, ''["mon","tue","mon"]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week with a day that is not one', format('select public.hr_save_attendance_settings(%L, ''["mon","funday"]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week with a capital letter', format('select public.hr_save_attendance_settings(%L, ''["Mon"]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week that is a word, not a list', format('select public.hr_save_attendance_settings(%L, ''"mon"'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week that is an object', format('select public.hr_save_attendance_settings(%L, ''{"mon": true}'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week of numbers', format('select public.hr_save_attendance_settings(%L, ''[1, 2]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week with a number among the days', format('select public.hr_save_attendance_settings(%L, ''["mon", 2]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week of eight entries', format('select public.hr_save_attendance_settings(%L, ''["mon","tue","wed","thu","fri","sat","sun","mon"]'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a work week that is a JSON null', format('select public.hr_save_attendance_settings(%L, ''null'', ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'no work week at all', format('select public.hr_save_attendance_settings(%L, null, ''09:00'', 15)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a grace period below zero', format('select public.hr_save_attendance_settings(%L, %L, ''09:00'', -1)', org, default_week), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a grace period of 241 minutes', format('select public.hr_save_attendance_settings(%L, %L, ''09:00'', 241)', org, default_week), 'ATT_BAD_INPUT'),
        (1, admin_id, 'no grace period at all', format('select public.hr_save_attendance_settings(%L, %L, ''09:00'', null)', org, default_week), 'ATT_BAD_INPUT'),
        (1, admin_id, 'no start time at all', format('select public.hr_save_attendance_settings(%L, %L, null, 15)', org, default_week), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a start time of 24:00', format('select public.hr_save_attendance_settings(%L, %L, ''24:00'', 15)', org, default_week), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a seven-day week given out of order, with 240 minutes', format('select public.hr_save_attendance_settings(%L, ''["sun","sat","fri","thu","wed","tue","mon"]'', ''23:59'', 240)', org), null),
        (1, admin_id, 'the admin saves the settings for the stage', format('select public.hr_save_attendance_settings(%L, %L, %L, 0)', org, week_with_today, ahead), null),
        (1, ma, 'a member saves the settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', org, default_week), 'ATT_NOT_ALLOWED'),
        (1, mv, 'a linked viewer saves the settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', org, default_week), 'ATT_NOT_ALLOWED'),
        (1, mu, 'an unlinked member saves the settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', org, default_week), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace''s owner saves this workspace''s settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', org, default_week), 'ATT_NOT_ALLOWED'),
        (1, null, 'a session with no user saves the settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', org, default_week), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin saves another workspace''s settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', other_org, default_week), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin saves settings for a workspace that does not exist', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', gen_random_uuid(), default_week), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin saves settings for no workspace', format('select public.hr_save_attendance_settings(null, %L, ''10:00'', 30)', default_week), 'ATT_NOT_ALLOWED'),
        (1, dv, 'a demo visitor saves the demo''s settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', demo, default_week), 'ATT_NOT_ALLOWED'),
        (1, da, 'a demo admin saves the demo''s settings', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', demo, default_week), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'an owner saves their own workspace''s settings', format('select public.hr_save_attendance_settings(%L, ''["sun","mon","tue","wed","thu"]'', ''08:00'', 5)', other_org), null),

        (1, admin_id, 'the admin adds a holiday', format('select public.hr_save_holiday(%L, null, ''  Check Day  '', ''2024-03-06'')', org), null),
        (1, admin_id, 'a second holiday on the same date', format('select public.hr_save_holiday(%L, null, ''Another Name'', ''2024-03-06'')', org), 'ATT_HOLIDAY_EXISTS'),
        (1, admin_id, 'the same holiday a second time', format('select public.hr_save_holiday(%L, null, ''Check Day'', ''2024-03-06'')', org), 'ATT_HOLIDAY_EXISTS'),
        (1, outsider, 'an owner adds a holiday on that date in their own workspace', format('select public.hr_save_holiday(%L, null, ''Check Day'', ''2024-03-06'')', other_org), null),
        (1, admin_id, 'a holiday with an empty name', format('select public.hr_save_holiday(%L, null, '''', ''2024-03-07'')', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday named with spaces only', format('select public.hr_save_holiday(%L, null, ''   '', ''2024-03-07'')', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday with no name', format('select public.hr_save_holiday(%L, null, null, ''2024-03-07'')', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday name of 121 characters', format('select public.hr_save_holiday(%L, null, %L, ''2024-03-07'')', org, long_name), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday with no date', format('select public.hr_save_holiday(%L, null, ''No Date'', null)', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday in 1999', format('select public.hr_save_holiday(%L, null, ''Too Early'', ''1999-12-31'')', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday in 2101', format('select public.hr_save_holiday(%L, null, ''Too Late'', ''2101-01-01'')', org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'a holiday name of 120 characters', format('select public.hr_save_holiday(%L, null, %L, ''2024-03-07'')', org, ok_name), null),
        (1, admin_id, 'a holiday on the first day allowed', format('select public.hr_save_holiday(%L, null, ''First Day'', ''2000-01-01'')', org), null),
        (1, admin_id, 'a holiday on the last day allowed', format('select public.hr_save_holiday(%L, null, ''Last Day'', ''2100-12-31'')', org), null),
        (1, ma, 'a member adds a holiday', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', org), 'ATT_NOT_ALLOWED'),
        (1, mv, 'a linked viewer adds a holiday', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', org), 'ATT_NOT_ALLOWED'),
        (1, mu, 'an unlinked member adds a holiday', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', org), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace''s owner adds a holiday here', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', org), 'ATT_NOT_ALLOWED'),
        (1, null, 'a session with no user adds a holiday', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', org), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin adds a holiday in another workspace', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', other_org), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin adds a holiday in no workspace', 'select public.hr_save_holiday(null, null, ''Mine'', ''2024-03-08'')', 'ATT_NOT_ALLOWED'),
        (1, dv, 'a demo visitor adds a demo holiday', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', demo), 'ATT_NOT_ALLOWED'),
        (1, da, 'a demo admin adds a demo holiday', format('select public.hr_save_holiday(%L, null, ''Mine'', ''2024-03-08'')', demo), 'ATT_NOT_ALLOWED'),
        (1, da, 'a demo admin edits a demo holiday', format('select public.hr_save_holiday(%L, %L, ''Mine'', ''2024-03-08'')', demo, demo_h), 'ATT_NOT_ALLOWED'),
        (1, ma, 'a member edits a holiday', format('select public.hr_save_holiday(%L, %L, ''Mine'', ''2024-03-08'')', org, h_org), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace''s owner edits a holiday here, naming this workspace', format('select public.hr_save_holiday(%L, %L, ''Mine'', ''2024-03-08'')', org, h_org), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace''s owner edits a holiday here, naming their own', format('select public.hr_save_holiday(%L, %L, ''Mine'', ''2024-03-08'')', other_org, h_org), 'ATT_NOT_FOUND'),
        (1, admin_id, 'the admin edits another workspace''s holiday', format('select public.hr_save_holiday(%L, %L, ''Mine'', ''2024-03-08'')', org, h_other), 'ATT_NOT_FOUND'),
        (1, admin_id, 'the admin edits a holiday that does not exist', format('select public.hr_save_holiday(%L, %L, ''Mine'', ''2024-03-08'')', org, gen_random_uuid()), 'ATT_NOT_FOUND'),
        (1, admin_id, 'the admin moves a holiday onto a date that is taken', format('select public.hr_save_holiday(%L, %L, ''Planted Day'', ''2024-03-06'')', org, h_org), 'ATT_HOLIDAY_EXISTS'),
        (1, admin_id, 'the admin edits a holiday into an empty name', format('select public.hr_save_holiday(%L, %L, ''  '', ''2024-03-05'')', org, h_org), 'ATT_BAD_INPUT'),
        (1, admin_id, 'the admin renames a holiday, keeping its date', format('select public.hr_save_holiday(%L, %L, ''Renamed Day'', ''2024-03-05'')', org, h_org), null),
        (1, admin_id, 'the admin moves the holiday to a free date', format('select public.hr_save_holiday(%L, %L, ''  Renamed Day  '', ''2024-03-12'')', org, h_org), null),
        (1, ma, 'a member removes a holiday', format('select public.hr_delete_holiday(%L)', h_org), 'ATT_NOT_FOUND'),
        (1, mv, 'a linked viewer removes a holiday', format('select public.hr_delete_holiday(%L)', h_org), 'ATT_NOT_FOUND'),
        (1, mu, 'an unlinked member removes a holiday', format('select public.hr_delete_holiday(%L)', h_org), 'ATT_NOT_FOUND'),
        (1, outsider, 'another workspace''s owner removes a holiday here', format('select public.hr_delete_holiday(%L)', h_org), 'ATT_NOT_FOUND'),
        (1, null, 'a session with no user removes a holiday', format('select public.hr_delete_holiday(%L)', h_org), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin removes another workspace''s holiday', format('select public.hr_delete_holiday(%L)', h_other), 'ATT_NOT_FOUND'),
        (1, admin_id, 'the admin removes a holiday that does not exist', format('select public.hr_delete_holiday(%L)', gen_random_uuid()), 'ATT_NOT_FOUND'),
        (1, admin_id, 'the admin removes no holiday', 'select public.hr_delete_holiday(null)', 'ATT_NOT_FOUND'),
        (1, dv, 'a demo visitor removes a demo holiday', format('select public.hr_delete_holiday(%L)', demo_h), 'ATT_NOT_FOUND'),
        (1, da, 'a demo admin removes a demo holiday', format('select public.hr_delete_holiday(%L)', demo_h), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'someone outside the demo removes a demo holiday', format('select public.hr_delete_holiday(%L)', demo_h), 'ATT_NOT_FOUND'),
        (1, admin_id, 'the admin removes a holiday', format('select public.hr_delete_holiday(%L)', h_org2), null),
        (1, admin_id, 'the admin removes it a second time', format('select public.hr_delete_holiday(%L)', h_org2), 'ATT_NOT_FOUND'),

        (1, ma, 'member A clocks member B in', format('select public.hr_clock_in(%L)', eb), 'ATT_NOT_ALLOWED'),
        (1, ma, 'member A clocks member B out', format('select public.hr_clock_out(%L)', eb), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin clocks member A in', format('select public.hr_clock_in(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin clocks member A out', format('select public.hr_clock_out(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin clocks in an employee linked to nobody', format('select public.hr_clock_in(%L)', ec), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin clocks in an employee that does not exist', format('select public.hr_clock_in(%L)', gen_random_uuid()), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin clocks out an employee that does not exist', format('select public.hr_clock_out(%L)', gen_random_uuid()), 'ATT_NOT_ALLOWED'),
        (1, ma, 'member A clocks in an employee that does not exist', format('select public.hr_clock_in(%L)', gen_random_uuid()), 'ATT_NOT_ALLOWED'),
        (1, ma, 'member A clocks in nobody', 'select public.hr_clock_in(null)', 'ATT_NOT_ALLOWED'),
        (1, ma, 'member A clocks out nobody', 'select public.hr_clock_out(null)', 'ATT_NOT_ALLOWED'),
        (1, mv, 'a linked viewer clocks member A in', format('select public.hr_clock_in(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, mu, 'an unlinked member clocks member A in', format('select public.hr_clock_in(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, mu, 'an unlinked member clocks in the employee linked to nobody', format('select public.hr_clock_in(%L)', ec), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace clocks member A in', format('select public.hr_clock_in(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace clocks member A out', format('select public.hr_clock_out(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, null, 'a session with no user clocks member A in', format('select public.hr_clock_in(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, null, 'a session with no user clocks member A out', format('select public.hr_clock_out(%L)', ea), 'ATT_NOT_ALLOWED'),
        (1, dv, 'a demo visitor clocks a demo employee in', format('select public.hr_clock_in(%L)', demo_emp), 'ATT_NOT_ALLOWED'),
        (1, dv, 'a demo visitor clocks a demo employee out', format('select public.hr_clock_out(%L)', demo_emp), 'ATT_NOT_ALLOWED'),
        (1, da, 'a demo admin clocks in the demo employee they are linked to', format('select public.hr_clock_in(%L)', demo_emp2), 'ATT_NOT_ALLOWED'),
        (1, da, 'a demo admin clocks out the demo employee they are linked to', format('select public.hr_clock_out(%L)', demo_emp2), 'ATT_NOT_ALLOWED'),
        (1, mi, 'the member linked to an inactive employee clocks in', format('select public.hr_clock_in(%L)', ei), 'ATT_INACTIVE_EMPLOYEE'),
        (1, ma, 'member A clocks out before clocking in', format('select public.hr_clock_out(%L)', ea), 'ATT_NOT_IN'),
        (1, ma, 'member A clocks in', format('select public.hr_clock_in(%L)', ea), null),
        (1, ma, 'member A clocks in a second time', format('select public.hr_clock_in(%L)', ea), 'ATT_ALREADY_IN'),
        (1, admin_id, 'the admin clocks in on their own record', format('select public.hr_clock_in(%L)', ead), null),
        (1, m3, 'a member on approved full-day leave clocks in', format('select public.hr_clock_in(%L)', e3), 'ATT_ON_LEAVE'),
        (1, m4, 'a member on approved half-day leave clocks in', format('select public.hr_clock_in(%L)', e4), null),
        (1, ma, 'a member runs the nightly close', 'select private.hr_attendance_close()', 'permission denied'),
        (1, ma, 'a member asks present-or-late directly', format('select private.hr_attendance_status(%L, now())', org), 'permission denied'),
        (1, ma, 'a member asks the working-day helper directly', format('select private.hr_is_working_day(%L, %L)', org, today), 'permission denied'),
        (1, ma, 'a member asks the leave helper directly', format('select private.hr_on_approved_leave(%L, %L, true)', e3, today), 'permission denied'),
        (1, ma, 'a member calls the clock gate directly', format('select private.hr_attendance_may_clock(%L)', ea), 'permission denied'),
        (1, admin_id, 'the admin calls the owners-and-admins gate directly', format('select private.hr_attendance_admin_only(%L)', org), 'permission denied'),
        (1, admin_id, 'the admin runs the nightly close', 'select private.hr_attendance_close()', 'permission denied'),
        (1, admin_id, 'the admin reads the epoch', 'select started_on from private.hr_attendance_epoch', 'permission denied'),
        (1, admin_id, 'the admin moves the epoch', 'update private.hr_attendance_epoch set started_on = date ''2020-01-01''', 'permission denied'),
        (1, admin_id, 'the admin reads the workspace start days', 'select started_on from private.hr_attendance_started', 'permission denied'),
        (1, admin_id, 'the admin moves a workspace''s start day', 'update private.hr_attendance_started set started_on = date ''2020-01-01''', 'permission denied'),
        (1, admin_id, 'the admin reads who the close covers', 'select covered_from from private.hr_attendance_covered', 'permission denied'),
        (1, ma, 'a member says the close has covered them for a year', format('insert into private.hr_attendance_covered (employee_id, covered_from) values (%L, ''2020-01-01'')', ea), 'permission denied'),
        (1, ma, 'a member gives a workspace a start day', format('insert into private.hr_attendance_started (org_id, started_on) values (%L, ''2020-01-01'')', other_org), 'permission denied'),

        (1, ma, 'member A corrects their own day', format('select public.hr_correct_attendance(%L, %L, ''present'', ''09:00'', ''18:00'', null)', ea, today - 1), 'ATT_NOT_ALLOWED'),
        (1, ma, 'member A corrects member B''s day', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', eb, today - 1), 'ATT_NOT_ALLOWED'),
        (1, mv, 'a linked viewer corrects their own day', format('select public.hr_correct_attendance(%L, %L, ''present'', ''09:00'', null, null)', ev, today - 1), 'ATT_NOT_ALLOWED'),
        (1, mu, 'an unlinked member corrects a day', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', ea, today - 1), 'ATT_NOT_ALLOWED'),
        (1, outsider, 'another workspace corrects a day', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', ea, today - 1), 'ATT_NOT_ALLOWED'),
        (1, null, 'a session with no user corrects a day', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', ea, today - 1), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin corrects a day in another workspace', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', eo, today - 1), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin corrects a day for an employee that does not exist', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', gen_random_uuid(), today - 1), 'ATT_NOT_ALLOWED'),
        (1, admin_id, 'the admin corrects a day for nobody', format('select public.hr_correct_attendance(null, %L, ''absent'', null, null, null)', today - 1), 'ATT_NOT_ALLOWED'),
        (1, dv, 'a demo visitor corrects a demo day', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', demo_emp, today - 1), 'ATT_NOT_ALLOWED'),
        (1, da, 'a demo admin corrects a demo day', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', demo_emp, today - 1), 'ATT_NOT_ALLOWED'),

        -- 2: the start time is now an hour behind, so a clock-in is late; clocking out; days that are not working days
        (2, admin_id, 'the admin moves the start time to an hour ago', format('select public.hr_save_attendance_settings(%L, %L, %L, 0)', org, week_with_today, behind), null),
        (2, mb, 'member B clocks in', format('select public.hr_clock_in(%L)', eb), null),
        (2, ma, 'member A clocks out', format('select public.hr_clock_out(%L)', ea), null),
        (2, ma, 'member A clocks out a second time', format('select public.hr_clock_out(%L)', ea), 'ATT_ALREADY_OUT'),
        (2, ma, 'member A clocks in again after clocking out', format('select public.hr_clock_in(%L)', ea), 'ATT_ALREADY_IN'),
        (2, admin_id, 'the admin takes today out of the work week', format('select public.hr_save_attendance_settings(%L, %L, %L, 0)', org, week_without_today, behind), null),
        (2, m5, 'a member clocks in on a day outside the work week', format('select public.hr_clock_in(%L)', e5), 'ATT_NOT_WORKING_DAY'),
        (2, admin_id, 'the admin puts today back in the work week', format('select public.hr_save_attendance_settings(%L, %L, %L, 0)', org, week_with_today, behind), null),
        (2, admin_id, 'the admin makes today a public holiday', format('select public.hr_save_holiday(%L, null, ''Today Off'', %L)', org, today), null),
        (2, m5, 'a member clocks in on a public holiday', format('select public.hr_clock_in(%L)', e5), 'ATT_NOT_WORKING_DAY'),
        (2, admin_id, 'the admin removes today''s holiday', format('select public.hr_delete_holiday((select h.id from public.hr_public_holidays h where h.org_id = %L and h.holiday_date = %L))', org, today), null),
        (2, m5, 'a member whose leave for today is pending, rejected or cancelled clocks in', format('select public.hr_clock_in(%L)', e5), null),

        -- 3: corrections
        (3, admin_id, 'a correction to a status that is not one', format('select public.hr_correct_attendance(%L, %L, ''holiday'', null, null, null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a correction with no status', format('select public.hr_correct_attendance(%L, %L, null, null, null, null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a correction for tomorrow', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', ec, today + 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a correction for 1999', format('select public.hr_correct_attendance(%L, ''1999-12-31'', ''absent'', null, null, null)', ec), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a correction with no date', format('select public.hr_correct_attendance(%L, null, ''absent'', null, null, null)', ec), 'ATT_BAD_INPUT'),
        (3, admin_id, 'present with no clock-in', format('select public.hr_correct_attendance(%L, %L, ''present'', null, null, null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'late with no clock-in', format('select public.hr_correct_attendance(%L, %L, ''late'', null, null, null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'present with a clock-out and no clock-in', format('select public.hr_correct_attendance(%L, %L, ''present'', null, ''18:00'', null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'present with a clock-out at the clock-in', format('select public.hr_correct_attendance(%L, %L, ''present'', ''09:00'', ''09:00'', null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'late with a clock-out before the clock-in', format('select public.hr_correct_attendance(%L, %L, ''late'', ''10:00'', ''09:59'', null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'absent with a clock-in', format('select public.hr_correct_attendance(%L, %L, ''absent'', ''09:00'', null, null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'absent with a clock-out', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, ''18:00'', null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'on leave with both times', format('select public.hr_correct_attendance(%L, %L, ''on_leave'', ''09:00'', ''18:00'', null)', ec, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a note over 500 characters', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, %L)', ec, today - 1, long_text), 'ATT_BAD_INPUT'),
        (3, admin_id, 'the admin records yesterday as present, with a note', format('select public.hr_correct_attendance(%L, %L, ''present'', ''09:00'', ''18:00'', ''  Forgot to clock in  '')', ec, today - 1), null),
        (3, admin_id, 'the admin corrects that day a second time', format('select public.hr_correct_attendance(%L, %L, ''late'', ''09:40'', ''18:00'', ''Second look'')', ec, today - 1), null),
        (3, admin_id, 'the admin records a late day with no clock-out', format('select public.hr_correct_attendance(%L, %L, ''late'', ''10:30'', null, null)', ec, today - 2), null),
        (3, admin_id, 'the admin records an absence, the note only spaces', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, ''   '')', ec, today - 3), null),
        (3, admin_id, 'the admin records a day on leave', format('select public.hr_correct_attendance(%L, %L, ''on_leave'', null, null, ''MC handed in'')', ec, today - 4), null),
        (3, admin_id, 'the admin corrects a day the system recorded', format('select public.hr_correct_attendance(%L, %L, ''present'', ''09:00'', ''17:00'', null)', ec, today - 5), null),
        (3, admin_id, 'the admin records the first day allowed', format('select public.hr_correct_attendance(%L, ''2000-01-01'', ''absent'', null, null, null)', ec), null),
        (3, admin_id, 'the admin records today', format('select public.hr_correct_attendance(%L, %L, ''present'', ''00:00'', null, null)', ec, today), null),
        (3, admin_id, 'the admin records a day for an inactive employee', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', ei, today - 1), null),
        (3, admin_id, 'the admin corrects their own day', format('select public.hr_correct_attendance(%L, %L, ''present'', ''08:00'', ''17:00'', null)', ead, today - 1), null),
        (3, admin_id, 'the admin marks member A, who clocked in and out today, as absent', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, ''Sent home'')', ea, today), null),
        (3, ma, 'member A clocks out of a day marked absent', format('select public.hr_clock_out(%L)', ea), 'ATT_NOT_IN'),
        (3, ma, 'member A clocks in on a day marked absent early', format('select public.hr_clock_in(%L)', ea), null),
        (3, ma, 'member A clocks in again', format('select public.hr_clock_in(%L)', ea), 'ATT_ALREADY_IN'),
        (3, admin_id, 'a clock-in for today that has not happened yet', format('select public.hr_correct_attendance(%L, %L, ''present'', ''23:59:59.999999'', null, null)', e3, today), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a clock-out for today that has not happened yet', format('select public.hr_correct_attendance(%L, %L, ''present'', ''00:00'', ''23:59:59.999999'', null)', e3, today), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a clock-in of 24:00', format('select public.hr_correct_attendance(%L, %L, ''present'', ''24:00'', null, null)', e3, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'a clock-out of 24:00', format('select public.hr_correct_attendance(%L, %L, ''present'', ''09:00'', ''24:00'', null)', e3, today - 1), 'ATT_BAD_INPUT'),
        (3, admin_id, 'the last second of yesterday as a clock-out', format('select public.hr_correct_attendance(%L, %L, ''late'', ''23:00'', ''23:59:59'', null)', e3, today - 1), null),

        -- 4: sessions that owe a second factor
        (4, mb, 'member B clocks in without the second factor', format('select public.hr_clock_in(%L)', eb), 'ATT_NOT_ALLOWED'),
        (4, m5, 'a member clocks out without the second factor', format('select public.hr_clock_out(%L)', e5), 'ATT_NOT_ALLOWED'),
        (4, admin_id, 'the admin corrects a day without the second factor', format('select public.hr_correct_attendance(%L, %L, ''absent'', null, null, null)', ec, today - 6), 'ATT_NOT_ALLOWED'),
        (4, admin_id, 'the admin adds a holiday without the second factor', format('select public.hr_save_holiday(%L, null, ''No Code'', ''2024-03-20'')', org), 'ATT_NOT_ALLOWED'),
        (4, admin_id, 'the admin edits a holiday without the second factor', format('select public.hr_save_holiday(%L, %L, ''No Code'', ''2024-03-20'')', org, h_org), 'ATT_NOT_ALLOWED'),
        (4, admin_id, 'the admin removes a holiday without the second factor', format('select public.hr_delete_holiday(%L)', h_org), 'ATT_NOT_FOUND'),
        (4, admin_id, 'the admin saves the settings without the second factor', format('select public.hr_save_attendance_settings(%L, %L, ''10:00'', 30)', org, default_week), 'ATT_NOT_ALLOWED'),
        (4, admin_id, 'the admin clocks out on their own record without the second factor', format('select public.hr_clock_out(%L)', ead), 'ATT_NOT_ALLOWED'),
        (4, ma, 'member A, who owes nothing, clocks out', format('select public.hr_clock_out(%L)', ea), null)
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
        elsif (want like 'ATT\_%' and sqlerrm <> want) or sqlerrm not like want || '%' then
          -- A refusal is its code and nothing else.
          fails := array_append(fails, format('%s: expected %s, got %s', label, want, sqlerrm));
        end if;
      end;
      reset role;
    end loop;

    if stage = 1 then
      -- The first clock-in is the workspace's first use of attendance: it starts today.
      select count(*), count(*) filter (where x.started_on = today) into n, n2 from private.hr_attendance_started x where x.org_id = org;
      if n <> 1 or n2 <> 1 then fails := array_append(fails, format('after its first clock-in the workspace has %s start rows (%s for today), expected one', n, n2)); end if;
      select count(*) into n from private.hr_attendance_started x where x.org_id in (demo, other_org, corg);
      if n <> 0 then fails := array_append(fails, 'a workspace nobody clocked or corrected in has a start day, or the demo has one'); end if;
      -- The settings row was made by the function, with the table's defaults for the rest.
      select count(*) into n from public.hr_settings s
      where s.org_id = org and s.work_week = week_with_today and s.work_start_time = ahead and s.late_grace_minutes = 0
        and s.default_annual_leave_days = 14 and s.notifications = '{}'::jsonb
        and s.overtime_rates = '{"weekday":1.5,"rest_day":2.0,"public_holiday":3.0}'::jsonb;
      if n <> 1 then fails := array_append(fails, 'saving settings with no row yet did not create one row with the three values and the defaults for the rest'); end if;
      -- An existing row keeps everything else it had.
      select count(*) into n from public.hr_settings s
      where s.org_id = other_org and s.work_week = '["mon","tue","wed","thu","sun"]'::jsonb and s.work_start_time = time '08:00'
        and s.late_grace_minutes = 5 and s.default_annual_leave_days = 20
        and s.overtime_rates = '{"weekday": 2.5}'::jsonb and s.notifications = '{"birthdays": true}'::jsonb
        and s.updated_at = now();
      if n <> 1 then fails := array_append(fails, 'saving attendance settings changed another setting, or did not save the three (the week in Monday-first order), or did not say when it was updated'); end if;

      select count(*) into n from public.hr_public_holidays h
      where h.org_id = org and h.name = 'Check Day' and h.holiday_date = date '2024-03-06' and h.scope = 'national' and h.state is null;
      if n <> 1 then fails := array_append(fails, 'a new holiday was not saved with a trimmed name and the default scope'); end if;
      select count(*) into n from public.hr_public_holidays h
      where h.id = h_org and h.org_id = org and h.name = 'Renamed Day' and h.holiday_date = date '2024-03-12'
        and h.scope = 'state' and h.state = 'Selangor';
      if n <> 1 then fails := array_append(fails, 'editing a holiday did not save its trimmed name and date, or changed its scope or state'); end if;
      select count(*), count(distinct h.holiday_date) into n, n2 from public.hr_public_holidays h where h.org_id = org;
      if n <> 5 or n2 <> 5 then fails := array_append(fails, format('the workspace has %s holidays on %s dates, expected 5 on 5', n, n2)); end if;
      select count(*) into n from public.hr_public_holidays h where h.id in (h_other, demo_h);
      select count(*) into n2 from public.hr_public_holidays h where h.id = h_org2;
      if n <> 2 or n2 <> 0 then fails := array_append(fails, 'a holiday someone had no right to remove is gone, or the one the admin removed is still there'); end if;

      select count(*) into n from public.hr_attendance_days a
      where a.employee_id in (ea, ead, e4) and a.org_id = org and a.work_date = today and a.clock_in = now()
        and a.clock_out is null and a.status = 'present'
        and a.corrected_by is null and a.corrected_at is null and a.correction_note is null;
      if n <> 3 then fails := array_append(fails, format('%s of 3 clock-ins were saved for today, stamped by the database, on time and open', n)); end if;
      select count(*) into n from public.hr_attendance_days a where a.org_id = org;
      if n <> 3 then fails := array_append(fails, format('%s attendance rows after the first clock-ins, expected 3', n)); end if;
      select count(*) into n from public.hr_attendance_days a where a.employee_id in (demo_emp, demo_emp2) and a.clock_in = now();
      if n <> 0 then fails := array_append(fails, 'someone was clocked in in the demo workspace'); end if;

      -- What clocking in returns: a linked viewer, on time.
      perform set_config('request.jwt.claims', json_build_object('sub', mv, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_clock_in(ev);
      reset role;
      if (select array_agg(k order by k) from jsonb_object_keys(r) k) is distinct from day_keys
         or r->>'employee_id' <> ev::text or r->>'work_date' <> today::text or r->>'status' <> 'present'
         or jsonb_typeof(r->'clock_in') <> 'string' or (r->>'clock_in')::timestamptz <> now()
         or r->'clock_out' <> 'null'::jsonb
         or not exists (select 1 from public.hr_attendance_days a where a.id = (r->>'id')::uuid and a.employee_id = ev) then
        fails := array_append(fails, 'clocking in did not return the day (id, employee, date, a stamped clock-in, a null clock-out, present): ' || r::text);
      end if;

    elsif stage = 2 then
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id in (eb, e5) and a.work_date = today and a.clock_in = now() and a.clock_out is null and a.status = 'late';
      if n <> 2 then fails := array_append(fails, format('%s of 2 clock-ins after the start time were saved as late', n)); end if;
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id = ea and a.work_date = today and a.clock_in = now() and a.clock_out = now() and a.status = 'present'
        and a.corrected_at is null;
      if n <> 1 then fails := array_append(fails, 'clocking out did not stamp the clock-out and leave the rest of the day as it was'); end if;
      select count(*) into n from public.hr_attendance_days a where a.employee_id = e3;
      if n <> 0 then fails := array_append(fails, 'a refused clock-in left a row behind'); end if;
      select count(*) into n from public.hr_public_holidays h where h.org_id = org and h.holiday_date = today;
      if n <> 0 then fails := array_append(fails, 'today''s holiday was not removed'); end if;

      -- What clocking out returns.
      perform set_config('request.jwt.claims', json_build_object('sub', mb, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_clock_out(eb);
      reset role;
      if (select array_agg(k order by k) from jsonb_object_keys(r) k) is distinct from day_keys
         or r->>'employee_id' <> eb::text or r->>'work_date' <> today::text or r->>'status' <> 'late'
         or (r->>'clock_in')::timestamptz <> now() or (r->>'clock_out')::timestamptz <> now()
         or jsonb_typeof(r->'clock_out') <> 'string' then
        fails := array_append(fails, 'clocking out did not return the day with both stamps: ' || r::text);
      end if;

    elsif stage = 3 then
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id = ec and a.work_date = today - 1 and a.status = 'late'
        and a.clock_in = ((today - 1)::text || ' 09:40:00+08')::timestamptz
        and a.clock_out = ((today - 1)::text || ' 18:00:00+08')::timestamptz
        and a.corrected_by = admin_id and a.corrected_at = now() and a.correction_note = 'Second look';
      if n <> 1 then fails := array_append(fails, 'a second correction did not replace the first, with its times read as Malaysia time on that date'); end if;
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id = ec and a.work_date = today - 2 and a.status = 'late'
        and a.clock_in = ((today - 2)::text || ' 10:30:00+08')::timestamptz and a.clock_out is null
        and a.corrected_by = admin_id and a.corrected_at is not null and a.correction_note is null;
      if n <> 1 then fails := array_append(fails, 'a late day with no clock-out was not saved open, with who corrected it'); end if;
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id = ec and a.work_date in (today - 3, today - 4, date '2000-01-01') and a.clock_in is null and a.clock_out is null
        and a.corrected_by = admin_id and a.corrected_at is not null
        and (a.work_date, a.status, coalesce(a.correction_note, '-')) in
          ((today - 3, 'absent', '-'), (today - 4, 'on_leave', 'MC handed in'), (date '2000-01-01', 'absent', '-'));
      if n <> 3 then fails := array_append(fails, format('%s of 3 corrections without times were saved (an empty note as none)', n)); end if;
      select count(*) into n from public.hr_attendance_days a
      where a.id = sys_id and a.status = 'present' and a.clock_in = ((today - 5)::text || ' 09:00:00+08')::timestamptz
        and a.clock_out = ((today - 5)::text || ' 17:00:00+08')::timestamptz and a.corrected_by = admin_id and a.corrected_at is not null;
      if n <> 1 then fails := array_append(fails, 'correcting a day the system recorded did not replace that row'); end if;
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id = ec and a.work_date = today and a.status = 'present' and a.clock_in = (today::text || ' 00:00:00+08')::timestamptz
        and a.corrected_at is not null;
      if n <> 1 then fails := array_append(fails, 'a correction for today was not saved'); end if;
      select count(*) into n from public.hr_attendance_days a where a.employee_id in (ei, ead) and a.work_date = today - 1 and a.corrected_by = admin_id;
      if n <> 2 then fails := array_append(fails, 'a correction for an inactive employee, or for the admin''s own record, was not saved'); end if;
      -- Member A: clocked in and out, marked absent by the admin, then clocked in again.
      select count(*) into n from public.hr_attendance_days a
      where a.employee_id = ea and a.work_date = today and a.clock_in = now() and a.clock_out is null and a.status = 'late'
        and a.corrected_by is null and a.corrected_at is null and a.correction_note is null;
      if n <> 1 then fails := array_append(fails, 'a clock-in on a day marked absent early did not replace the correction (one open row, late, no longer a correction)'); end if;
      select count(*) into n from public.hr_attendance_days a where a.employee_id = ea;
      if n <> 1 then fails := array_append(fails, format('member A has %s rows, expected one for today', n)); end if;

      -- What a correction returns, whatever zone the session keeps.
      perform set_config('timezone', 'America/New_York', true);
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_correct_attendance(eb, today - 1, 'present', time '09:00', time '18:05', ' Badge reader down ');
      reset role;
      perform set_config('timezone', orig_tz, true);
      if (select array_agg(k order by k) from jsonb_object_keys(r) k) is distinct from array['clock_in','clock_out','corrected','employee_id','id','status','work_date']
         or r->>'employee_id' <> eb::text or r->>'work_date' <> (today - 1)::text or r->>'status' <> 'present'
         or r->'corrected' <> 'true'::jsonb
         or (r->>'clock_in')::timestamptz <> ((today - 1)::text || ' 09:00:00+08')::timestamptz
         or (r->>'clock_out')::timestamptz <> ((today - 1)::text || ' 18:05:00+08')::timestamptz then
        fails := array_append(fails, 'a correction did not return the day, corrected, with Malaysia times: ' || r::text);
      end if;
      select count(*) into n from public.hr_attendance_days a
      where a.id = (r->>'id')::uuid and a.correction_note = 'Badge reader down'
        and a.clock_in = ((today - 1)::text || ' 09:00:00+08')::timestamptz;
      if n <> 1 then fails := array_append(fails, 'a correction made in a session on New York time was not saved as Malaysia time, or its note was not trimmed'); end if;
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_correct_attendance(eb, today - 2, 'absent', null, null, null);
      reset role;
      if r->'clock_in' <> 'null'::jsonb or r->'clock_out' <> 'null'::jsonb or r->>'status' <> 'absent' or r->'corrected' <> 'true'::jsonb then
        fails := array_append(fails, 'a correction to absent did not return null times: ' || r::text);
      end if;
      -- The table itself keeps a note within 500 characters.
      begin
        update public.hr_attendance_days set correction_note = long_text where id = sys_id;
        fails := array_append(fails, 'the table took a note over 500 characters');
      exception when check_violation then null;
      end;
    end if;
  end loop;

  -- With the code entered (aal2) the same people are let through again.
  perform set_config('request.jwt.claims', json_build_object('sub', mb, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  begin
    perform public.hr_clock_in(eb);
    perform public.hr_clock_out(eb);
  exception when others then
    fails := array_append(fails, 'member B with the second factor entered was refused: ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  begin
    perform public.hr_correct_attendance(ec, today - 6, 'absent', null, null, null);
    r := public.hr_save_holiday(org, null, 'With Code', date '2024-03-20');
    if r <> jsonb_build_object('id', (r->>'id')::uuid, 'name', 'With Code', 'holiday_date', date '2024-03-20') or r->>'id' is null then
      fails := array_append(fails, 'saving a holiday did not return its id, name and date: ' || r::text);
    end if;
    r := public.hr_delete_holiday((r->>'id')::uuid) - 'id';
    if r <> '{}'::jsonb then fails := array_append(fails, 'removing a holiday returned more than its id: ' || r::text); end if;
    r := public.hr_delete_holiday(h_org);
    if r <> jsonb_build_object('id', h_org) then fails := array_append(fails, 'removing a holiday did not return its id: ' || r::text); end if;
    r := public.hr_save_attendance_settings(org, '["sat","mon","wed"]'::jsonb, time '08:45', 20);
    if r <> jsonb_build_object('work_week', '["mon","wed","sat"]'::jsonb, 'work_start_time', time '08:45', 'late_grace_minutes', 20) then
      fails := array_append(fails, 'saving the settings did not return the three, the week in order: ' || r::text);
    end if;
  exception when others then
    fails := array_append(fails, 'the admin with the second factor entered was refused: ' || sqlerrm);
  end;
  reset role;
  delete from auth.mfa_factors where user_id in (mb, m5, admin_id);
  select count(*) into n from public.hr_attendance_days a where a.employee_id = e5 and a.work_date = today and a.clock_out is null;
  select count(*) into n2 from public.hr_attendance_days a where a.employee_id = ec and a.work_date = today - 6;
  if n <> 1 or n2 <> 1 then fails := array_append(fails, 'a session owing a second factor changed a day, or the admin with a code could not'); end if;

  -- A clock-out that began before today's clock-in was stamped (two taps whose
  -- transactions crossed) is told there is no clock-in, not stopped by the table.
  update public.hr_attendance_days set clock_in = now() + interval '1 second' where employee_id = e5 and work_date = today;
  perform set_config('request.jwt.claims', json_build_object('sub', m5, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  begin
    perform public.hr_clock_out(e5);
    fails := array_append(fails, 'a clock-out before the clock-in''s own stamp went through');
  exception when others then
    if sqlerrm <> 'ATT_NOT_IN' then
      fails := array_append(fails, 'a clock-out before the clock-in''s own stamp: expected ATT_NOT_IN, got ' || sqlerrm);
    end if;
  end;
  reset role;
  update public.hr_attendance_days set clock_in = now() where employee_id = e5 and work_date = today;

  -- ---- no direct writes, for a member or the admin ----------------------
  for who, label in select * from (values (ma, 'a member'), (admin_id, 'the admin')) as w(who, label) loop
    for t, q in
      select x.t, x.q from (values
        ('hr_attendance_days', format('insert into public.hr_attendance_days (org_id, employee_id, work_date, clock_in, status) values (%L, %L, %L, now() - interval ''3 hours'', ''present'')', org, ea, today - 9)),
        ('hr_attendance_days', format('update public.hr_attendance_days set status = ''present'' where employee_id = %L', ea)),
        ('hr_attendance_days', format('update public.hr_attendance_days set clock_in = clock_in - interval ''2 hours'' where employee_id = %L', ea)),
        ('hr_attendance_days', format('update public.hr_attendance_days set correction_note = ''mine'' where employee_id = %L', ea)),
        ('hr_attendance_days', format('delete from public.hr_attendance_days where employee_id = %L', ea)),
        ('hr_public_holidays', format('insert into public.hr_public_holidays (org_id, name, holiday_date) values (%L, ''Mine'', ''2024-04-01'')', org)),
        ('hr_public_holidays', format('update public.hr_public_holidays set name = ''Mine'' where org_id = %L', org)),
        ('hr_public_holidays', format('delete from public.hr_public_holidays where org_id = %L', org)),
        ('hr_settings', format('insert into public.hr_settings (org_id) values (%L)', gen_random_uuid())),
        ('hr_settings', format('update public.hr_settings set work_start_time = ''12:00'' where org_id = %L', org)),
        ('hr_settings', format('update public.hr_settings set late_grace_minutes = 240 where org_id = %L', org)),
        ('hr_settings', format('update public.hr_settings set work_week = ''["sun"]'' where org_id = %L', org)),
        ('hr_settings', format('delete from public.hr_settings where org_id = %L', org))
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
  foreach t in array array['authenticated', 'anon', 'service_role'] loop
    foreach q in array array['select count(*) from private.hr_attendance_epoch', 'update private.hr_attendance_epoch set started_on = date ''2020-01-01''', 'delete from private.hr_attendance_epoch',
      'select count(*) from private.hr_attendance_started', 'update private.hr_attendance_started set started_on = date ''2020-01-01''', 'delete from private.hr_attendance_started',
      format('insert into private.hr_attendance_started (org_id, started_on) values (%L, ''2020-01-01'')', other_org),
      'select count(*) from private.hr_attendance_covered', 'update private.hr_attendance_covered set covered_from = date ''2020-01-01''', 'delete from private.hr_attendance_covered',
      format('insert into private.hr_attendance_covered (employee_id, covered_from) values (%L, ''2020-01-01'')', ea)] loop
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', t, 'aal', 'aal1')::text, true);
      execute format('set local role %I', t);
      begin
        execute q;
        fails := array_append(fails, format('%s touched a private attendance table directly: %s', t, q));
      exception
        when insufficient_privilege then null;
        when others then
          fails := array_append(fails, format('%s touching a private attendance table was refused for another reason: %s', t, sqlerrm));
      end;
      reset role;
    end loop;
  end loop;

  -- ---- a member still reads only their own days; the admin reads them all ---
  perform set_config('request.jwt.claims', json_build_object('sub', mb, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) filter (where a.employee_id <> eb), count(*) filter (where a.employee_id = eb) into n, n2
  from public.hr_attendance_days a where a.org_id = org;
  reset role;
  if n <> 0 or n2 <> 3 then fails := array_append(fails, format('member B reads %s of a colleague''s days and %s of their own 3', n, n2)); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.hr_attendance_days a where a.org_id = org;
  reset role;
  select count(*) into n2 from public.hr_attendance_days a where a.org_id = org;
  if n <> n2 or n < 15 then fails := array_append(fails, format('the admin reads %s of the workspace''s %s days', n, n2)); end if;

  -- ---- the day a workspace first uses attendance -----------------------------
  -- The clocking workspace started today, with its first clock-in, and the
  -- corrections of earlier dates since (one of them for the year 2000) did not
  -- move that. Nothing in the demo gave it a start.
  select count(*), count(*) filter (where x.started_on = today) into n, n2 from private.hr_attendance_started x where x.org_id = org;
  if n <> 1 or n2 <> 1 then fails := array_append(fails, 'correcting earlier dates moved the clocking workspace''s start day'); end if;
  select count(*) into n from private.hr_attendance_started x where x.org_id in (demo, other_org);
  if n <> 0 then fails := array_append(fails, 'the demo, or a workspace nobody has clocked or corrected in, has a start day'); end if;
  -- The other workspace's first use is a correction, for a date three weeks back: it starts today, not then.
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  perform public.hr_correct_attendance(eo, today - 21, 'absent', null, null, null);
  reset role;
  select count(*), count(*) filter (where x.started_on = today) into n, n2 from private.hr_attendance_started x where x.org_id = other_org;
  if n <> 1 or n2 <> 1 then fails := array_append(fails, format('a first correction, for a date three weeks back, left the workspace with %s start rows (%s for today), expected one for today', n, n2)); end if;
  -- Say that was five days ago. A later correction of an even older date does not move it.
  update private.hr_attendance_started set started_on = today - 5 where org_id = other_org;
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  perform public.hr_correct_attendance(eo, today - 40, 'absent', null, null, 'Found in the old book');
  perform public.hr_correct_attendance(eo, today - 21, 'on_leave', null, null, null);
  reset role;
  select count(*), count(*) filter (where x.started_on = today - 5) into n, n2 from private.hr_attendance_started x where x.org_id = other_org;
  if n <> 1 or n2 <> 1 then fails := array_append(fails, 'a later correction moved a workspace''s start day'); end if;
  -- It works every day of the week, so each of the last five days is a working
  -- day there. Its linked employee is not yet known to the close; its inactive
  -- one carries a leftover from when they were active, four days back.
  update public.hr_settings set work_week = '["mon","tue","wed","thu","fri","sat","sun"]'::jsonb where org_id = other_org;
  update public.hr_employees set created_at = now() - interval '90 days' where org_id = other_org;
  insert into private.hr_attendance_covered (employee_id, covered_from) values (er, today - 4);
  -- From run 3, when the check says the close first saw the linked employee three days ago.
  o_days := array(select today - g.i from generate_series(1, 3) as g(i) order by 1);
  select count(*) into n from private.hr_attendance_covered c where c.employee_id <> er;
  if n <> 0 then fails := array_append(fails, format('%s employees are covered before the close has ever run', n)); end if;

  -- ---- the nightly close ----------------------------------------------------
  -- A workspace of its own, on the default week (it has no settings row).
  -- Everything is planted at dates counted back from today; the epoch is moved
  -- to twelve days ago, inside this transaction only.
  wd := array(select today - g.i from generate_series(1, 12) as g(i)
              where to_char(today - g.i, 'dy') not in ('sat', 'sun') order by 1);
  select max(today - g.i) into sat from generate_series(1, 12) as g(i) where to_char(today - g.i, 'dy') = 'sat';
  select max(today - g.i) into last_sun from generate_series(1, 7) as g(i) where to_char(today - g.i, 'dy') = 'sun';
  if cardinality(wd) < 8 or sat is null or last_sun is null then
    raise exception 'the last twelve days hold % weekdays, so the close cannot be laid out', cardinality(wd);
  end if;

  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K1', 'Plain') returning id into k1;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K2', 'Two Days Of Leave') returning id into k2;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K3', 'Half Day') returning id into k3;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K4', 'Joiner') returning id into k4;
  insert into public.hr_employees (org_id, employee_no, name, status) values (corg, 'K5', 'Inactive', 'inactive') returning id into k5;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K6', 'Clocked And Corrected') returning id into k6;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K7', 'Record Made Late') returning id into k7;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K8', 'Leave Approved Late') returning id into k8;
  -- Each is linked to an account (only a linked employee can clock in, so only
  -- a linked employee is ever closed), but for one.
  insert into public.org_members (org_id, user_id, role)
  values (corg, ma, 'member'), (corg, mb, 'member'), (corg, mv, 'member'), (corg, mu, 'member'), (corg, mi, 'member'),
         (corg, m3, 'member'), (corg, m4, 'member'), (corg, m5, 'member'), (corg, outsider, 'member');
  update public.hr_employees e set user_id = m.user_id
  from (values (k1, ma), (k2, mb), (k3, mv), (k4, mu), (k5, mi), (k6, m3), (k7, m4), (k8, m5)) as m(id, user_id)
  where e.id = m.id;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'KU', 'Linked To Nobody') returning id into ku;
  update public.hr_employees set created_at = now() - interval '90 days' where org_id = corg;
  select count(*) into n from public.hr_employees e where e.org_id = corg and e.user_id is not null;
  if n <> 8 then fails := array_append(fails, format('%s of 8 employees of the close workspace were linked', n)); end if;
  -- The workspace first used attendance twenty days ago, which is before the
  -- epoch: an admin corrected a day for the unlinked employee.
  insert into private.hr_attendance_started (org_id, started_on) values (corg, today - 20);
  -- The close has known every employee here for sixty days, so the other
  -- bounds are what is seen. The inactive one and the unlinked one carry a
  -- leftover that the first run must drop.
  insert into private.hr_attendance_covered (employee_id, covered_from)
  select e.id, today - 60 from public.hr_employees e where e.org_id = corg;
  insert into public.hr_attendance_days (org_id, employee_id, work_date, status, corrected_by, corrected_at)
  values (corg, ku, today - 20, 'absent', admin_id, now()) returning id into ku_id;

  -- A third workspace, with two linked employees and no attendance yet.
  insert into public.orgs (id, name) values (sorg, 'Attendance Not Started Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (sorg, ma, 'member'), (sorg, mb, 'member');
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (sorg, 'S1', 'First To Clock', ma) returning id into s1;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (sorg, 'S2', 'Colleague', mb) returning id into s2;
  update public.hr_employees set created_at = now() - interval '90 days' where org_id = sorg;
  -- It has no start day; a row there that nobody clocked or corrected changes nothing.
  insert into public.hr_attendance_days (org_id, employee_id, work_date, status)
  values (sorg, s2, wd[1], 'absent') returning id into stray_id;
  -- And a row like that on a day that is a holiday there, also before the
  -- workspace starts (in run 3, on the fourth weekday): the close removes such
  -- rows only from the start day on, so this one stays.
  insert into public.hr_public_holidays (org_id, name, holiday_date) values (sorg, 'Before The Start', wd[2]);
  insert into public.hr_attendance_days (org_id, employee_id, work_date, status)
  values (sorg, s1, wd[2], 'absent') returning id into sat_id;
  k4_from := wd[6];
  update public.hr_employees set join_date = k4_from where id = k4;
  -- Joined long ago on paper, but the record was made at half past midnight
  -- in Malaysia on the fourth weekday (still the day before in UTC).
  k7_from := wd[4];
  update public.hr_employees
  set join_date = today - 50, created_at = (k7_from::text || ' 00:30:00+08')::timestamptz where id = k7;

  hol := array[wd[2]];
  insert into public.hr_public_holidays (org_id, name, holiday_date) values (corg, 'Close Holiday', wd[2]);
  k2_leave := array(select d from unnest(wd) as d where d between wd[3] and wd[4]);
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, half_day, status)
  values (corg, k2, 'annual', wd[3], wd[4], 2, false, 'approved') returning id into l2;
  k3_leave := array[wd[5]];
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, half_day, status)
  values (corg, k3, 'annual', wd[5], wd[5], 0.5, true, 'approved');
  k8_leave := '{}';
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, half_day, status)
  values (corg, k8, 'annual', wd[7], wd[7], 1, false, 'pending') returning id into l8;
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, half_day, status)
  values (corg, k8, 'annual', wd[6], wd[6], 1, false, 'rejected'), (corg, k8, 'annual', wd[5], wd[5], 1, false, 'cancelled');

  -- Days the close must never touch: a clocked day with no clock-out, a day
  -- worked on the holiday and recorded by a correction, a correction with no
  -- times whose corrector's account has since been deleted, a Saturday someone
  -- clocked in on, and a Sunday an owner or admin marked as leave.
  k6_own := array[wd[1], wd[2], wd[3], sat, last_sun];
  insert into public.hr_attendance_days (org_id, employee_id, work_date, clock_in, clock_out, status, corrected_by, corrected_at, correction_note)
  values (corg, k6, wd[1], (wd[1]::text || ' 09:40:00+08')::timestamptz, null, 'late', null, null, null),
         (corg, k6, wd[2], (wd[2]::text || ' 10:00:00+08')::timestamptz, null, 'present', admin_id, now(), 'Worked the holiday'),
         (corg, k6, wd[3], null, null, 'on_leave', null, now(), 'Told by phone'),
         (corg, k6, sat, (sat::text || ' 09:00:00+08')::timestamptz, (sat::text || ' 13:00:00+08')::timestamptz, 'present', null, null, null),
         (corg, k6, last_sun, null, null, 'on_leave', admin_id, now(), null);
  -- And a row from before the epoch that looks like one the system wrote, on a
  -- Saturday two weeks before the latest: out of the close's reach until the
  -- epoch moves back in run 7.
  insert into public.hr_attendance_days (org_id, employee_id, work_date, status)
  values (corg, k1, sat - 14, 'absent') returning id into pre_id;
  select md5(string_agg(a.ctid::text || a::text, ',' order by a.work_date, a.id)) into own_snap
  from public.hr_attendance_days a where (a.employee_id = k6 and a.work_date = any (k6_own)) or a.id = ku_id;

  -- The demo, made tempting: a start day (no function can give it one), an
  -- employee whose record is old, with a weekday missing and a Sunday the
  -- system seems to have recorded.
  insert into private.hr_attendance_started (org_id, started_on) values (demo, today - 30);
  update public.hr_employees set created_at = now() - interval '90 days' where id = demo_emp;
  delete from public.hr_attendance_days where employee_id = demo_emp and work_date = wd[cardinality(wd)];
  delete from public.hr_attendance_days where employee_id = demo_emp and work_date = last_sun;
  insert into public.hr_attendance_days (org_id, employee_id, work_date, status) values (demo, demo_emp, last_sun, 'absent');
  select count(*) || ':' || md5(coalesce(string_agg(a.ctid::text || a::text, ',' order by a.id), '')) into demo_att
  from public.hr_attendance_days a where a.org_id = demo;

  for run in 1..9 loop
    if run = 1 then
      update private.hr_attendance_epoch set started_on = today - 12;
      days := array(select d from unnest(wd) as d where d <> all (hol));
    elsif run = 3 then
      -- Late changes: leave approved, leave cancelled, a holiday added.
      update public.hr_leave_requests set status = 'approved' where id = l8;
      k8_leave := array[wd[7]];
      update public.hr_leave_requests set status = 'cancelled' where id = l2;
      k2_leave := '{}';
      insert into public.hr_public_holidays (org_id, name, holiday_date) values (corg, 'Added Late', wd[8]);
      hol := hol || wd[8];
      days := array(select d from unnest(wd) as d where d <> all (hol));
      -- And the third workspace started using attendance on the fourth weekday, with one clock-in.
      insert into private.hr_attendance_started (org_id, started_on) values (sorg, wd[4]);
      insert into private.hr_attendance_covered (employee_id, covered_from) values (s1, today - 60), (s2, today - 60);
      -- In the other workspace, say the close first saw the linked employee three days ago.
      update private.hr_attendance_covered set covered_from = today - 3 where employee_id = el;
      insert into public.hr_attendance_days (org_id, employee_id, work_date, clock_in, status)
      values (sorg, s1, wd[4], (wd[4]::text || ' 08:55:00+08')::timestamptz, 'present');
      s_from := wd[4];
      s1_own := array[wd[4]];
    elsif run = 4 then
      -- The work week changes: Saturdays are worked, the first weekday's day of
      -- the week is not, and today's is in it whatever day today is, so that a
      -- close that reached today would show.
      select jsonb_agg(k.key) into wk from unnest(array['mon','tue','wed','thu','fri','sat','sun']) as k(key)
      where k.key <> to_char(wd[1], 'dy') and (k.key <> 'sun' or today_key = 'sun');
      insert into public.hr_settings (org_id, work_week) values (corg, wk);
      days := array(select today - g.i from generate_series(1, 12) as g(i)
                    where wk ? to_char(today - g.i, 'dy') and (today - g.i) <> all (hol) order by 1);
    elsif run = 5 then
      -- A work week that is not a list falls back to Monday to Friday.
      update public.hr_settings set work_week = '{"sat": true, "sun": true}'::jsonb where org_id = corg;
      days := array(select d from unnest(wd) as d where d <> all (hol));
      -- In the third workspace an admin has recorded an earlier day, the second
      -- weekday, for the colleague. Its start day stays where it was.
      insert into public.hr_attendance_days (org_id, employee_id, work_date, status, corrected_by, corrected_at)
      values (sorg, s2, wd[2], 'absent', admin_id, now());
      -- In the other workspace the inactive employee is made active again.
      update public.hr_employees set status = 'active' where id = er;
      s2_own := array[wd[2]];
    elsif run = 6 then
      -- And so does a list with no day in it.
      update public.hr_settings set work_week = '[7, "someday"]'::jsonb where org_id = corg;
    elsif run = 7 then
      -- The epoch far back, and the workspace's start day too: the close still reaches only 31 days.
      update private.hr_attendance_epoch set started_on = today - 60;
      update private.hr_attendance_started set started_on = today - 45 where org_id = corg;
    elsif run = 8 then
      -- The epoch is today, as on the night after the migration: a new
      -- employee, with an old record, gets nothing.
      update private.hr_attendance_epoch set started_on = today;
      insert into public.hr_employees (org_id, employee_no, name) values (corg, 'K9', 'After The Epoch') returning id into k9;
      update public.hr_employees set created_at = now() - interval '90 days', user_id = outsider where id = k9;
    elsif run = 9 then
      -- No epoch at all: nothing is closed, rather than the last 31 days.
      delete from private.hr_attendance_epoch;
    end if;

    select md5(coalesce(string_agg(a.ctid::text || a::text, ',' order by a.id), '')) into snap
    from public.hr_attendance_days a where a.org_id = corg;
    begin
      perform private.hr_attendance_close();
    exception when others then
      fails := array_append(fails, format('close, run %s: raised %s', run, sqlerrm));
    end;
    select md5(coalesce(string_agg(a.ctid::text || a::text, ',' order by a.id), '')) into snap2
    from public.hr_attendance_days a where a.org_id = corg;

    if run in (2, 6, 8, 9) then
      -- Nothing was planted or changed that the close should act on.
      if snap2 is distinct from snap then
        fails := array_append(fails, format('close, run %s: a run with nothing new to do changed rows', run));
      end if;
    elsif run = 7 then
      exp := array(select format('k1 %s absent', today - g.i) from generate_series(1, 31) as g(i)
                   where to_char(today - g.i, 'dy') not in ('sat', 'sun') and (today - g.i) <> all (hol) order by 1);
      act := array(select format('k1 %s %s', a.work_date, a.status) from public.hr_attendance_days a where a.employee_id = k1 order by 1);
      if act is distinct from exp then
        fails := array_append(fails, format('close, run 7: with the epoch 60 days back the plain employee has %s days from %s, expected %s from %s',
          cardinality(act), act[1], cardinality(exp), exp[1]));
      end if;
      select count(*) into n from public.hr_attendance_days a where a.org_id = corg and a.work_date < today - 31 and a.employee_id <> ku;
      if n <> 0 then fails := array_append(fails, format('close, run 7: %s days were recorded more than 31 days back', n)); end if;
      select count(*) into n from public.hr_attendance_days a
      where (a.employee_id = k4 and a.work_date < k4_from) or (a.employee_id = k7 and a.work_date < k7_from) or a.employee_id = k5;
      if n <> 0 then fails := array_append(fails, format('close, run 7: %s days before someone joined, before their record was made, or for an inactive employee', n)); end if;
    else
      -- What the planted facts say the system rows must be.
      exp := array(
        select format('%s %s %s', x.k, x.d, x.st) from (
          select 'k1' as k, d, 'absent' as st from unnest(days) as d
          union all select 'k2', d, case when d = any (k2_leave) then 'on_leave' else 'absent' end from unnest(days) as d
          union all select 'k3', d, case when d = any (k3_leave) then 'on_leave' else 'absent' end from unnest(days) as d
          union all select 'k4', d, 'absent' from unnest(days) as d where d >= k4_from
          union all select 'k6', d, 'absent' from unnest(days) as d where d <> all (k6_own)
          union all select 'k7', d, 'absent' from unnest(days) as d where d >= k7_from
          union all select 'k8', d, case when d = any (k8_leave) then 'on_leave' else 'absent' end from unnest(days) as d
        ) x order by 1);
      act := array(
        select format('%s %s %s', m.k, a.work_date, a.status)
        from public.hr_attendance_days a
        join (values (k1, 'k1'), (k2, 'k2'), (k3, 'k3'), (k4, 'k4'), (k5, 'k5'), (k6, 'k6'), (k7, 'k7'), (k8, 'k8'), (ku, 'ku')) as m(id, k) on m.id = a.employee_id
        where a.org_id = corg and a.clock_in is null and a.corrected_at is null and a.id <> pre_id
        order by 1);
      if act is distinct from exp then
        diff := array(select '-' || x from (select unnest(exp) except select unnest(act)) as t(x) order by 1)
             || array(select '+' || x from (select unnest(act) except select unnest(exp)) as t(x) order by 1);
        fails := array_append(fails, format('close, run %s: %s system rows, expected %s; missing (-) and unexpected (+): %s',
          run, cardinality(act), cardinality(exp), array_to_string(diff[1:8], ', ')));
      end if;
      select count(*) into n from public.hr_attendance_days a
      where a.org_id = corg and a.clock_in is null and a.corrected_at is null
        and (a.clock_out is not null or a.corrected_by is not null or a.correction_note is not null);
      if n <> 0 then fails := array_append(fails, format('close, run %s: %s system rows carry a time, a corrector or a note', run, n)); end if;
    end if;

    -- After every run: today is never closed, nothing before the epoch, the
    -- clocked and corrected days are exactly as they were, the demo too.
    select count(*) into n from public.hr_attendance_days a where a.org_id = corg and a.work_date >= today;
    if n <> 0 then fails := array_append(fails, format('close, run %s: %s days recorded for today or later', run, n)); end if;
    if run < 7 then
      select count(*) into n from public.hr_attendance_days a where a.org_id = corg and a.work_date < today - 12 and a.id not in (pre_id, ku_id);
      if n <> 0 then fails := array_append(fails, format('close, run %s: %s days recorded before the epoch', run, n)); end if;
      select count(*) into n from public.hr_attendance_days a where a.id = pre_id and a.status = 'absent';
      if n <> 1 then fails := array_append(fails, format('close, run %s: a row from before the epoch was removed or changed', run)); end if;
    end if;
    select md5(string_agg(a.ctid::text || a::text, ',' order by a.work_date, a.id)) into t
    from public.hr_attendance_days a where (a.employee_id = k6 and a.work_date = any (k6_own)) or a.id = ku_id;
    if t is distinct from own_snap then fails := array_append(fails, format('close, run %s: a clocked or corrected day was changed or removed', run)); end if;
    select count(*) || ':' || md5(coalesce(string_agg(a.ctid::text || a::text, ',' order by a.id), '')) into t
    from public.hr_attendance_days a where a.org_id = demo;
    if t is distinct from demo_att then fails := array_append(fails, format('close, run %s: the demo workspace''s attendance was changed', run)); end if;
    select count(*) into n from public.hr_attendance_days a where a.employee_id = ku and a.corrected_at is null;
    if n <> 0 then fails := array_append(fails, format('close, run %s: %s days recorded for an employee linked to nobody', run, n)); end if;
    -- The third workspace: nothing until it has a start day, then every
    -- linked employee from that day on, and nothing before it.
    exp := array(
      select format('%s %s absent', x.k, x.d) from (
        select 's1' as k, d from unnest(wd) as d where d >= s_from and d <> all (s1_own)
        union all select 's2', d from unnest(wd) as d where d >= s_from and d <> all (s2_own)
      ) x order by 1);
    act := array(
      select format('%s %s %s', case a.employee_id when s1 then 's1' else 's2' end, a.work_date, a.status)
      from public.hr_attendance_days a
      where a.org_id = sorg and a.clock_in is null and a.corrected_at is null and a.id not in (stray_id, sat_id) order by 1);
    if act is distinct from exp then
      diff := array(select '-' || x from (select unnest(exp) except select unnest(act)) as t(x) order by 1)
           || array(select '+' || x from (select unnest(act) except select unnest(exp)) as t(x) order by 1);
      fails := array_append(fails, format('close, run %s: the workspace that %s has %s system rows, expected %s; missing (-) and unexpected (+): %s',
        run, case when s_from is null then 'has not started using attendance' else 'started on ' || s_from end,
        cardinality(act), cardinality(exp), array_to_string(diff[1:6], ', ')));
    end if;
    select count(*) into n from public.hr_attendance_days a where a.org_id = sorg and (a.clock_in is not null or a.corrected_at is not null);
    if n <> cardinality(s1_own) + cardinality(s2_own) then fails := array_append(fails, format('close, run %s: a clocked or corrected day of the third workspace is gone', run)); end if;
    select count(*) into n from public.hr_attendance_days a where a.id in (stray_id, sat_id);
    if n <> 2 then fails := array_append(fails, format('close, run %s: a row from before the third workspace started was removed', run)); end if;
    select count(*) into n from private.hr_attendance_covered c where c.employee_id in (s1, s2);
    n2 := 0;
    if run >= 3 then n2 := 2; end if;
    if n <> n2 then
      fails := array_append(fails, format('close, run %s: %s employees of the third workspace are covered, which %s', run, n,
        case when run >= 3 then 'has started' else 'has not started' end));
    end if;
    -- The other workspace started five days ago and works every day. Its
    -- linked employee was unknown to the close: the first run writes nothing
    -- for them and notes them from today; so does the second. From run 3 (the
    -- check then says that was three days ago) they are closed for those three
    -- days and never for the two before, although the workspace had started.
    -- The inactive employee's leftover is dropped; made active again before
    -- run 5, they are noted from today, with nothing written for the gap. The
    -- employee linked to nobody is never noted and never closed.
    exp := array(select format('el %s absent', d) from unnest(o_days) as d where run >= 3 order by 1);
    act := array(
      select format('%s %s %s', case a.employee_id when el then 'el' when er then 'er' else 'eo' end, a.work_date, a.status)
      from public.hr_attendance_days a
      where a.org_id = other_org and a.clock_in is null and a.corrected_at is null order by 1);
    if act is distinct from exp then
      fails := array_append(fails, format('close, run %s: the workspace that started five days ago has system rows [%s], expected [%s]',
        run, array_to_string(act[1:8], ', '), array_to_string(exp, ', ')));
    end if;
    exp := array(select x from (values
        (format('el %s', case when run >= 3 then today - 3 else today end)),
        (case when run >= 5 then format('er %s', today) end)) as v(x) where x is not null order by 1);
    act := array(
      select format('%s %s', case c.employee_id when el then 'el' when er then 'er' else 'eo' end, c.covered_from)
      from private.hr_attendance_covered c where c.employee_id in (el, er, eo) order by 1);
    if act is distinct from exp then
      fails := array_append(fails, format('close, run %s: the other workspace''s covered employees are [%s], expected [%s]',
        run, array_to_string(act, ', '), array_to_string(exp, ', ')));
    end if;
    -- The close workspace: the seven linked, active employees keep the day
    -- they were first seen; the inactive and the unlinked one have none.
    select count(*) filter (where c.employee_id in (k1, k2, k3, k4, k6, k7, k8) and c.covered_from = today - 60),
           count(*) filter (where c.employee_id in (k5, ku))
    into n, n2 from private.hr_attendance_covered c;
    if n <> 7 or n2 <> 0 then
      fails := array_append(fails, format('close, run %s: %s of 7 employees kept the day they were first covered, and %s inactive or unlinked ones are covered', run, n, n2));
    end if;
    -- The clocking workspace started today: its seven linked, active employees
    -- are noted from today and nothing is written for anyone; the inactive one
    -- and the unlinked one are not noted.
    select count(*) filter (where c.employee_id in (ead, ea, eb, ev, e3, e4, e5) and c.covered_from = today),
           count(*) filter (where c.employee_id in (ei, ec))
    into n, n2 from private.hr_attendance_covered c;
    if n <> 7 or n2 <> 0 then
      fails := array_append(fails, format('close, run %s: %s of 7 employees of the workspace that started today are covered from today, and %s inactive or unlinked ones are covered', run, n, n2));
    end if;
    select count(*) into n from public.hr_attendance_days a where a.org_id = org and a.clock_in is null and a.corrected_at is null;
    if n <> 0 then fails := array_append(fails, format('close, run %s: %s days were recorded in the workspace that started today', run, n)); end if;
    select count(*) into n from private.hr_attendance_covered c join public.hr_employees e on e.id = c.employee_id where e.org_id = demo;
    if n <> 0 then fails := array_append(fails, format('close, run %s: %s demo employees are covered', run, n)); end if;
    select count(*) into n from public.hr_attendance_days a
    where a.employee_id = eo and a.corrected_by = outsider
      and (a.work_date, a.status) in ((today - 21, 'on_leave'), (today - 40, 'absent'));
    if n <> 2 then fails := array_append(fails, format('close, run %s: a day corrected for a date before the workspace started was changed or removed', run)); end if;
    if run >= 8 then
      select count(*) into n from public.hr_attendance_days a where a.employee_id = k9;
      if n <> 0 then fails := array_append(fails, format('close, run %s: with the epoch at today, or with none, a day was recorded', run)); end if;
    end if;
  end loop;
  -- The clocking workspace was closed too: nothing in it was clocked or
  -- corrected away, and nobody there has a system row for today.
  select count(*) into n from public.hr_attendance_days a
  where a.org_id = org and a.work_date = today and a.clock_in is null and a.corrected_at is null;
  if n <> 0 then fails := array_append(fails, 'the close recorded today in the clocking workspace'); end if;

  -- ---- the demo -----------------------------------------------------------
  select md5(coalesce(string_agg(x.line, ',' order by x.line), '')) into t from (
    select h::text as line from public.hr_public_holidays h where h.org_id = demo
    union all select s::text from public.hr_settings s where s.org_id = demo
  ) x;
  if t is distinct from demo_rest then fails := array_append(fails, 'a holiday or a setting was changed in the demo workspace'); end if;
  select count(*) into n from public.hr_attendance_days a
  where a.org_id = demo and (a.corrected_by is not null or a.corrected_at is not null or a.correction_note is not null);
  if n <> 0 then fails := array_append(fails, 'a day was corrected in the demo workspace'); end if;
  perform private.reseed_demo_people();
  select count(*), count(*) filter (where a.corrected_by is not null or a.corrected_at is not null or a.correction_note is not null)
  into n, n2 from public.hr_attendance_days a where a.org_id = demo;
  if n < 100 or n2 <> 0 then fails := array_append(fails, format('the demo has %s days (%s marked corrected) after a reseed', n, n2)); end if;
  select count(*) into n from public.hr_settings s
  where s.org_id = demo and s.work_start_time = time '09:00' and s.late_grace_minutes = 15;
  if n <> 1 then fails := array_append(fails, 'the demo''s settings are not on 09:00 and 15 minutes after a reseed'); end if;

  -- ---- workspaces with attendance in them can still be deleted -------------
  select count(*) into n from public.hr_attendance_days a where a.org_id in (org, corg);
  if n < 100 then fails := array_append(fails, format('the two workspaces hold %s days, too few to prove deleting them', n)); end if;
  select count(*) into n from private.hr_attendance_started x where x.org_id in (org, corg, sorg, other_org);
  if n <> 4 then fails := array_append(fails, format('%s of the 4 workspaces have a start day before they are deleted', n)); end if;
  -- Deleting an employee, or a workspace, takes the covered rows with it.
  select count(*) into n from private.hr_attendance_covered c where c.employee_id in (el, er);
  delete from public.hr_employees where id = el;
  select count(*) into n2 from private.hr_attendance_covered c where c.employee_id in (el, er);
  if n <> 2 or n2 <> 1 then fails := array_append(fails, format('deleting a covered employee left %s of 2 covered rows, expected 1', n2)); end if;
  select count(*) into n from private.hr_attendance_covered c
  where c.employee_id in (ead, ea, eb, ev, e3, e4, e5, k1, k2, k3, k4, k6, k7, k8, k9, s1, s2, er);
  if n <> 18 then fails := array_append(fails, format('%s of 18 employees are covered before their workspaces are deleted', n)); end if;
  begin
    delete from public.orgs where id in (org, corg, sorg, other_org);
  exception when others then
    fails := array_append(fails, 'deleting a workspace with attendance in it failed: ' || sqlerrm);
  end;
  select count(*) into n from private.hr_attendance_started x where x.org_id in (org, corg, sorg, other_org);
  if n <> 0 then fails := array_append(fails, format('%s start days were left behind by deleted workspaces', n)); end if;
  select count(*) into n from private.hr_attendance_covered c
  where c.employee_id in (ead, ea, eb, ev, e3, e4, e5, k1, k2, k3, k4, k6, k7, k8, k9, s1, s2, er, el);
  if n <> 0 then fails := array_append(fails, format('%s covered rows were left behind by deleted workspaces', n)); end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := array_append(fails, format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1)));
  end;

  raise exception 'PEOPLE_ATTENDANCE_CHECK %', case
    when cardinality(fails) > 0 then format('FAILED (%s): %s', cardinality(fails), array_to_string(fails[1:15], '; '))
    when widened then format('PASSED (everything rolled back; today is a %s in Malaysia, outside the default week, so the clock cases ran on a work week widened to include it)',
      trim(to_char(today, 'Day')))
    else 'PASSED (everything rolled back)'
  end;
end $$;
