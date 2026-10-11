-- Lekiu claims and overtime access check. Leaves nothing behind: the block
-- always ends with RAISE, so every row below is rolled back. Read the message:
--   PEOPLE_CLAIMS_OVERTIME_CHECK PASSED ...   or   PEOPLE_CLAIMS_OVERTIME_CHECK FAILED (n): <what went wrong>
-- It rebuilds the demo HR rows inside its transaction and holds them until the
-- rollback, so do not start it at minute 1 of the hour, when the scheduled
-- demo reseed runs.
--
-- How it works: each numbered stage is a list of (who, what, the call, the
-- refusal expected or null when it must succeed). One loop runs every call as
-- that person and records anything that went the other way. Between stages
-- the block looks at the rows as the database owner, and a second list says
-- who must and must not be able to read each receipt file at that point.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  demo uuid;
  admin_id uuid := gen_random_uuid();
  ma uuid := gen_random_uuid();        -- member linked to employee A (salary RM 5,202.08: RM 25.01 an hour)
  mb uuid := gen_random_uuid();        -- member linked to employee B (no salary on file until stage 3)
  mu uuid := gen_random_uuid();        -- member with no employee record
  mv uuid := gen_random_uuid();        -- workspace role 'viewer', linked to employee V (salary RM 5,000: RM 24.04 an hour)
  outsider uuid := gen_random_uuid();  -- owner of another workspace
  dv uuid := gen_random_uuid();        -- demo visitor (viewer)
  da uuid := gen_random_uuid();        -- an admin planted in the demo workspace
  guest uuid := gen_random_uuid();     -- an anonymous account
  ea uuid;
  eb uuid;
  ei uuid;                             -- inactive employee
  ev uuid;
  ec uuid;                             -- active employee linked to nobody, with a salary of 0 on file until stage 3
  oc uuid;
  demo_emp uuid := md5('rimba-emp-1')::uuid;
  demo_claim uuid;
  demo_paid uuid;
  demo_ot uuid;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  -- March 2024: Sun 3, Mon 4, Tue 5, Wed 6, Thu 7, Fri 8, Sat 9, Sun 10.
  -- Wed 6 and Sun 10 are public holidays in the test workspace.
  -- Receipt files: f_admin in the admin's folder, f_a1 and f_a2 in member A's, f_b in member B's.
  f_admin text;
  f_a1 text;
  f_a2 text;
  f_b text;
  f_chat text;                         -- in member A's folder, but in another bucket
  f_a3 text;                           -- member A's: goes on a claim in stage 2
  f_a4 text;                           -- member A's: never on a claim; released in stage 1
  f_a5 text;                           -- member A's: on member A's claim in the OTHER workspace
  f_admin2 text;                       -- the admin's: on a second claim the admin enters for member B
  eo uuid;                             -- member A's employee record in the other workspace
  cby uuid;
  got boolean;
  f_gone text;                         -- a released path whose file is no longer in the bucket
  ca1 uuid; ca2 uuid; ca3 uuid; ca4 uuid; cb1 uuid; cb2 uuid; cv1 uuid; cbx uuid; cadm uuid;
  oa1 uuid; oa2 uuid; oa3 uuid; oa4 uuid; oa5 uuid; oa6 uuid; ob1 uuid; ob2 uuid; ov1 uuid; oadm uuid;
  stage int;
  who uuid;
  anon_claim boolean;
  label text;
  q text;
  want text;
  f text;
  ok boolean;
  seen int;
  emp uuid;
  day date;
  hrs numeric;
  w_kind text;
  w_mult numeric;
  w_rate bigint;
  w_amount bigint;
  r jsonb;
  n int;
  n2 int;
  t text;
  sig text;
  rec record;
  ctx text;
  long_text text := repeat('x', 501);
  long_ref text := repeat('r', 101);
  fails text[] := '{}';
  functions text[] := array[
    'public.hr_submit_claim(uuid,text,bigint,date,text,text)',
    'public.hr_cancel_claim(uuid)',
    'public.hr_decide_claim(uuid,boolean,text)',
    'public.hr_mark_claim_paid(uuid,date,text)',
    'public.hr_unmark_claim_paid(uuid)',
    'public.hr_overtime_preview(uuid,date,numeric)',
    'public.hr_submit_overtime(uuid,date,numeric,text)',
    'public.hr_cancel_overtime(uuid)',
    'public.hr_decide_overtime(uuid,boolean,text)'];
  helpers text[] := array[
    'private.hr_pay_may_act(uuid)',
    'private.hr_overtime_figures(uuid,uuid,date,numeric)'];
  pay_tables text[] := array['hr_claims','hr_overtime_records'];
  release_sig text := 'public.hr_release_receipt(text)';
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
  -- The preview is marked stable, so the database itself refuses a write from it.
  select count(*) into n from pg_proc p
  where p.oid = to_regprocedure('public.hr_overtime_preview(uuid,date,numeric)') and p.provolatile = 's';
  if n <> 1 then fails := array_append(fails, 'the overtime preview is not marked stable'); end if;
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
  foreach t in array pay_tables loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      fails := array_append(fails, format('%s has a write grant', t));
    end if;
    select count(*) into n from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname not in (t || '_select', 'mfa_required');
    if n <> 0 then fails := array_append(fails, format('%s has %s policies nobody expected', t, n)); end if;
  end loop;
  select count(*) into n from information_schema.columns c
  where c.table_schema = 'public'
    and (c.table_name, c.column_name) in (
      ('hr_claims', 'requested_by'), ('hr_claims', 'decision_note'), ('hr_claims', 'receipt_path'),
      ('hr_claims', 'paid_on'), ('hr_claims', 'paid_reference'), ('hr_claims', 'paid_by'),
      ('hr_overtime_records', 'requested_by'), ('hr_overtime_records', 'decision_note'), ('hr_overtime_records', 'reason'),
      ('hr_overtime_records', 'hourly_rate_cents'), ('hr_overtime_records', 'day_kind'))
    and c.is_nullable = 'YES' and c.column_default is null;
  if n <> 11 then fails := array_append(fails, format('%s of the 11 new columns exist as nullable columns with no default', n)); end if;

  -- The receipts bucket: private, 5 MB, five types; three policies and no more.
  select count(*) into n from storage.buckets b
  where b.id = 'hr-receipts' and b.public is not true and b.file_size_limit = 5242880
    and b.allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/heic','application/pdf']
    and cardinality(b.allowed_mime_types) = 5;
  if n <> 1 then fails := array_append(fails, 'the hr-receipts bucket is missing, public, or has the wrong size or type limits'); end if;
  select count(*),
    count(*) filter (where (p.policyname, p.cmd, p.permissive) in (
      ('hr_receipts_select', 'SELECT', 'PERMISSIVE'), ('hr_receipts_insert_own', 'INSERT', 'PERMISSIVE'),
      ('hr_receipts_mfa_required', 'ALL', 'RESTRICTIVE')) and p.roles = array['authenticated']::name[])
  into n, n2 from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects'
    and (p.policyname like 'hr\_receipts%' or p.qual like '%hr-receipts%' or p.with_check like '%hr-receipts%');
  if n <> 3 or n2 <> 3 then
    fails := array_append(fails, format('the receipts bucket has %s policies (%s as expected), expected select, insert and the second-factor one', n, n2));
  end if;
  -- Releasing a receipt: one more function, and a table nobody may touch.
  if to_regprocedure(release_sig) is null then
    fails := array_append(fails, format('%s does not exist', release_sig));
  else
    if has_function_privilege('anon', release_sig, 'execute') or has_function_privilege('public', release_sig, 'execute')
       or not has_function_privilege('authenticated', release_sig, 'execute') then
      fails := array_append(fails, format('%s is not callable by signed-in users only', release_sig));
    end if;
    select count(*) into n from pg_proc p
    where p.oid = to_regprocedure(release_sig) and p.prosecdef
      and p.proconfig @> array['search_path=public'] and p.prorettype = 'boolean'::regtype;
    if n <> 1 then fails := array_append(fails, format('%s is not security definer with a fixed search path, returning boolean', release_sig)); end if;
  end if;
  if to_regclass('private.hr_released_receipts') is null then
    fails := array_append(fails, 'private.hr_released_receipts does not exist');
  else
    foreach t in array array['anon', 'authenticated', 'service_role', 'public'] loop
      if has_table_privilege(t, 'private.hr_released_receipts', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
         or has_any_column_privilege(t, 'private.hr_released_receipts', 'SELECT, INSERT, UPDATE') then
        fails := array_append(fails, format('%s holds a privilege on the released-receipts table', t));
      end if;
    end loop;
    select count(*) into n from pg_class c where c.oid = 'private.hr_released_receipts'::regclass and c.relrowsecurity;
    select count(*) into n2 from pg_policies p where p.schemaname = 'private' and p.tablename = 'hr_released_receipts';
    if n <> 1 or n2 <> 0 then fails := array_append(fails, 'the released-receipts table does not have row level security on with no policy'); end if;
  end if;
  if cardinality(fails) > 0 then raise exception 'the functions, grants and bucket are not as expected, so nothing else was tried'; end if;

  -- ---- people and a workspace ------------------------------------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@pay-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, u.id = guest
  from unnest(array[admin_id, ma, mb, mu, mv, outsider, dv, da, guest]) as u(id);

  insert into public.orgs (id, name) values (org, 'Pay Check Sdn Bhd'), (other_org, 'Pay Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, admin_id, 'admin'), (org, ma, 'member'), (org, mb, 'member'), (org, mu, 'member'), (org, mv, 'viewer'),
         (other_org, outsider, 'owner'), (other_org, ma, 'member'), (demo, dv, 'viewer'), (demo, da, 'admin');

  -- No settings row yet: the figures must work on the table defaults.
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'A', 'Member A', ma || '@pay-check.openkuasa-test.dev') returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'B', 'Member B', mb || '@pay-check.openkuasa-test.dev') returning id into eb;
  insert into public.hr_employees (org_id, employee_no, name, status)
  values (org, 'I', 'Inactive One', 'inactive') returning id into ei;
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'V', 'Viewer V', mv || '@pay-check.openkuasa-test.dev') returning id into ev;
  insert into public.hr_employees (org_id, employee_no, name)
  values (org, 'C', 'Linked To Nobody') returning id into ec;
  -- Member A also belongs to the other workspace, with an employee record there.
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (other_org, 'O', 'Member A Elsewhere', ma || '@pay-check.openkuasa-test.dev') returning id into eo;
  select count(*) into n from public.hr_employees where id = eo and user_id = ma;
  if n <> 1 then fails := array_append(fails, 'member A was not linked to their employee record in the other workspace'); end if;
  select count(*) into n from public.hr_employees where id in (ea, eb, ev) and user_id in (ma, mb, mv);
  if n <> 3 then fails := array_append(fails, 'the members were not linked to their employee records'); end if;

  -- 520208 / 208 = 2501 exactly; 500000 / 208 = 2403.85, so 2404.
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents)
  values (ea, org, 520208), (ev, org, 500000), (ec, org, 0);
  insert into public.hr_public_holidays (org_id, name, holiday_date)
  values (org, 'Midweek Day', date '2024-03-06'), (org, 'Sunday Day', date '2024-03-10');

  select id into demo_claim from public.hr_claims where org_id = demo and status = 'pending' limit 1;
  select id into demo_paid from public.hr_claims where org_id = demo and status = 'approved' limit 1;
  select id into demo_ot from public.hr_overtime_records where org_id = demo and status = 'pending' limit 1;
  if demo_claim is null or demo_paid is null or demo_ot is null then
    fails := array_append(fails, 'the demo workspace has no pending claim, approved claim or pending overtime to try');
  end if;

  -- ---- receipt files: who may upload where -------------------------------
  f_admin := admin_id || '/' || gen_random_uuid() || '.pdf';
  f_a1 := ma || '/' || gen_random_uuid() || '.jpg';
  f_a2 := ma || '/' || gen_random_uuid() || '.png';
  f_b := mb || '/' || gen_random_uuid() || '.jpg';
  f_chat := ma || '/' || gen_random_uuid() || '.jpg';
  f_a3 := ma || '/' || gen_random_uuid() || '.jpg';
  f_a4 := ma || '/' || gen_random_uuid() || '.jpg';
  f_a5 := ma || '/' || gen_random_uuid() || '.jpg';
  f_admin2 := admin_id || '/' || gen_random_uuid() || '.pdf';
  for who, anon_claim, label, f, ok in
    select * from (values
      (admin_id, false, 'the admin uploads into their own folder', f_admin, true),
      (ma, false, 'member A uploads into their own folder', f_a1, true),
      (ma, false, 'member A uploads a second file', f_a2, true),
      (ma, false, 'member A uploads a third file', f_a3, true),
      (ma, false, 'member A uploads a fourth file', f_a4, true),
      (ma, false, 'member A uploads a fifth file', f_a5, true),
      (admin_id, false, 'the admin uploads a second file', f_admin2, true),
      (mb, false, 'member B uploads into their own folder', f_b, true),
      (mv, false, 'a linked viewer uploads into their own folder', mv || '/' || gen_random_uuid() || '.jpg', true),
      (ma, false, 'member A uploads into member B''s folder', mb || '/' || gen_random_uuid() || '.jpg', false),
      (ma, false, 'member A uploads into the admin''s folder', admin_id || '/' || gen_random_uuid() || '.jpg', false),
      (ma, false, 'member A uploads a file outside any folder', gen_random_uuid() || '.jpg', false),
      (admin_id, false, 'the admin uploads into member A''s folder', ma || '/' || gen_random_uuid() || '.jpg', false),
      (guest, true, 'an anonymous account uploads into its own folder', guest || '/' || gen_random_uuid() || '.jpg', false),
      (null, false, 'a session with no user uploads', gen_random_uuid() || '/' || gen_random_uuid() || '.jpg', false)
    ) as u(who, anon_claim, label, f, ok)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', anon_claim)::text, true);
    set local role authenticated;
    begin
      insert into storage.objects (bucket_id, name, owner) values ('hr-receipts', f, who);
      if not ok then fails := array_append(fails, format('%s: went through', label)); end if;
    exception
      when insufficient_privilege then
        if ok then fails := array_append(fails, format('%s: refused', label)); end if;
      when others then
        fails := array_append(fails, format('%s: stopped for another reason: %s', label, sqlerrm));
    end;
    reset role;
  end loop;
  -- The same account is let in once it is not anonymous (the folder was right all along).
  perform set_config('request.jwt.claims', json_build_object('sub', guest, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('hr-receipts', guest || '/' || gen_random_uuid() || '.jpg', guest);
  exception when others then
    fails := array_append(fails, 'an account that is not anonymous was refused its own folder: ' || sqlerrm);
  end;
  reset role;
  -- A file in member A's own folder, but in the chat bucket; and a file in the
  -- chat bucket that carries the same name as the admin's receipt.
  insert into storage.objects (bucket_id, name, owner)
  values ('chat-attachments', f_chat, ma), ('chat-attachments', f_admin, admin_id);

  -- ---- the overtime figures, before anything is submitted ----------------
  -- Settings change between the numbered groups; every preview is run as `who`.
  for stage in 1..6 loop
    if stage = 6 then
      -- Just under 1 is below 1 (not rounded up to it); exactly 1 is taken.
      update public.hr_settings set overtime_rates = '{"weekday": 0.97, "rest_day": 0.95, "public_holiday": 1}'::jsonb where org_id = org;
    elsif stage = 2 then
      -- A Sunday-to-Thursday week; one multiplier set, one not a number, one below 1.
      insert into public.hr_settings (org_id, work_week, overtime_rates)
      values (org, '["sun","mon","tue","wed","thu"]'::jsonb, '{"weekday": 2.5, "rest_day": "lots", "public_holiday": 0.5}'::jsonb);
    elsif stage = 3 then
      update public.hr_settings set work_week = '["mon","tue","wed","thu","fri"]'::jsonb, overtime_rates = '{"weekday": 2.5}'::jsonb where org_id = org;
    elsif stage = 4 then
      update public.hr_settings set overtime_rates = '[1, 2]'::jsonb where org_id = org;
    elsif stage = 5 then
      -- The record keeps one decimal place and at most 99.9.
      update public.hr_settings set overtime_rates = '{"weekday": 1.75, "rest_day": 250, "public_holiday": 3.5}'::jsonb where org_id = org;
    end if;
    for who, emp, day, hrs, w_kind, w_mult, w_rate, w_amount, label in
      select c.who, c.emp, c.day, c.hrs, c.w_kind, c.w_mult, c.w_rate, c.w_amount, c.label from (values
        (1, ma, ea, date '2024-03-04', 2, 'weekday', 1.5, 2501, 7503, 'a Monday on the defaults'),
        (1, ma, ea, date '2024-03-04', 0.5, 'weekday', 1.5, 2501, 1876, 'half an hour (1875.75 rounds to 1876)'),
        (1, ma, ea, date '2024-03-09', 3, 'rest_day', 2.0, 2501, 15006, 'a Saturday on the defaults'),
        (1, ma, ea, date '2024-03-06', 1, 'public_holiday', 3.0, 2501, 7503, 'a public holiday in midweek'),
        (1, ma, ea, date '2024-03-10', 1, 'public_holiday', 3.0, 2501, 7503, 'a public holiday that falls on a rest day'),
        (1, admin_id, ea, date '2024-03-04', 24, 'weekday', 1.5, 2501, 90036, 'the admin previews 24 hours for member A'),
        (1, mv, ev, date '2024-03-04', 1.5, 'weekday', 1.5, 2404, 5409, 'a linked viewer, whose hourly rate rounds up'),
        (1, mb, eb, date '2024-03-04', 2, 'weekday', 1.5, null, null, 'an employee with no salary on file'),
        (1, admin_id, ec, date '2024-03-09', 2, 'rest_day', 2.0, null, null, 'the admin previews for an employee whose salary on file is 0'),
        (6, ma, ea, date '2024-03-04', 1, 'weekday', 1.5, 2501, 3752, 'a multiplier of 0.97 is below 1, so the default is used'),
        (6, ma, ea, date '2024-03-09', 1, 'rest_day', 2.0, 2501, 5002, 'a multiplier of 0.95 is below 1, so the default is used'),
        (6, ma, ea, date '2024-03-06', 1, 'public_holiday', 1.0, 2501, 2501, 'a multiplier of exactly 1 is taken'),
        (2, ma, ea, date '2024-03-04', 1, 'weekday', 2.5, 2501, 6253, 'a Monday on a custom weekday multiplier'),
        (2, ma, ea, date '2024-03-03', 1, 'weekday', 2.5, 2501, 6253, 'a Sunday in a Sunday-to-Thursday week'),
        (2, ma, ea, date '2024-03-08', 1, 'rest_day', 2.0, 2501, 5002, 'a Friday in a Sunday-to-Thursday week, the multiplier not a number'),
        (2, ma, ea, date '2024-03-09', 1, 'rest_day', 2.0, 2501, 5002, 'a Saturday in a Sunday-to-Thursday week'),
        (2, ma, ea, date '2024-03-10', 1, 'public_holiday', 3.0, 2501, 7503, 'a public holiday on a working Sunday, the multiplier below 1'),
        (3, ma, ea, date '2024-03-04', 1, 'weekday', 2.5, 2501, 6253, 'a Monday with only the weekday multiplier set'),
        (3, ma, ea, date '2024-03-09', 1, 'rest_day', 2.0, 2501, 5002, 'a Saturday with the rest-day multiplier missing'),
        (3, ma, ea, date '2024-03-06', 1, 'public_holiday', 3.0, 2501, 7503, 'a public holiday with its multiplier missing'),
        (4, ma, ea, date '2024-03-04', 1, 'weekday', 1.5, 2501, 3752, 'a Monday with multipliers that are not an object'),
        (4, ma, ea, date '2024-03-10', 1, 'public_holiday', 3.0, 2501, 7503, 'a holiday with multipliers that are not an object'),
        (5, ma, ea, date '2024-03-04', 1, 'weekday', 1.8, 2501, 4502, 'a multiplier of 1.75 is kept to one decimal place'),
        (5, ma, ea, date '2024-03-09', 1, 'rest_day', 2.0, 2501, 5002, 'a multiplier too large to store falls back to the default'),
        (5, ma, ea, date '2024-03-06', 1, 'public_holiday', 3.5, 2501, 8754, 'a custom public-holiday multiplier (8753.5 rounds to 8754)')
      ) as c(s, who, emp, day, hrs, w_kind, w_mult, w_rate, w_amount, label)
      where c.s = stage
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        r := public.hr_overtime_preview(emp, day, hrs);
        if not (r ?& array['day_kind', 'multiplier', 'hourly_rate_cents', 'amount_cents'])
           or r->>'day_kind' is distinct from w_kind or (r->>'multiplier')::numeric is distinct from w_mult
           or (r->>'hourly_rate_cents')::bigint is distinct from w_rate or (r->>'amount_cents')::bigint is distinct from w_amount then
          fails := array_append(fails, format('preview, %s: expected %s x%s at %s = %s, got %s', label, w_kind, w_mult, w_rate, w_amount, r::text));
        end if;
      exception when others then
        fails := array_append(fails, format('preview, %s: refused with %s', label, sqlerrm));
      end;
      reset role;
    end loop;
  end loop;
  select count(*) into n from public.hr_overtime_records where org_id = org;
  if n <> 0 then fails := array_append(fails, format('the preview wrote %s overtime records', n)); end if;
  -- For the stages: Monday to Friday, weekdays at 2.5, the rest on the defaults.
  update public.hr_settings set overtime_rates = '{"weekday": 2.5}'::jsonb where org_id = org;

  -- ---- the stages --------------------------------------------------------
  for stage in 1..6 loop
    for who, label, q, want in
      select c.who, c.label, c.q, c.want from (values
        -- 1: submitting, and everything that needs no request id
        (1, ma, 'member A submits own claim', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, ''  Taxi to client  '', null)', ea, today - 2), null),
        (1, ma, 'member A submits own claim with own receipt', format('select public.hr_submit_claim(%L, ''medical'', 12000, %L, null, %L)', ea, today, f_a1), null),
        (1, ma, 'member A attaches the same receipt to a second claim', format('select public.hr_submit_claim(%L, ''medical'', 12000, %L, null, %L)', ea, today, f_a1), 'PAY_BAD_RECEIPT'),
        (1, ma, 'member A submits a claim for member B', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', eb, today), 'PAY_NOT_ALLOWED'),
        (1, ma, 'member A attaches a file from the admin''s folder', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, %L)', ea, today, f_admin), 'PAY_BAD_RECEIPT'),
        (1, ma, 'member A attaches a file from member B''s folder', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, %L)', ea, today, f_b), 'PAY_BAD_RECEIPT'),
        (1, ma, 'member A attaches a file that was never uploaded', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, %L)', ea, today, ma || '/' || gen_random_uuid() || '.jpg'), 'PAY_BAD_RECEIPT'),
        (1, ma, 'member A attaches a file from another bucket', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, %L)', ea, today, f_chat), 'PAY_BAD_RECEIPT'),
        (1, ma, 'member A attaches an empty path', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, '''')', ea, today), 'PAY_BAD_RECEIPT'),
        (1, ma, 'a claim of nothing', format('select public.hr_submit_claim(%L, ''travel'', 0, %L, null, null)', ea, today), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim below zero', format('select public.hr_submit_claim(%L, ''travel'', -500, %L, null, null)', ea, today), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim with no amount', format('select public.hr_submit_claim(%L, ''travel'', null, %L, null, null)', ea, today), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim one sen above RM 1,000,000', format('select public.hr_submit_claim(%L, ''travel'', 100000001, %L, null, null)', ea, today), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim dated tomorrow', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ea, today + 1), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim dated 1999', format('select public.hr_submit_claim(%L, ''travel'', 8500, ''1999-12-31'', null, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim with no date', format('select public.hr_submit_claim(%L, ''travel'', 8500, null, null, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim in an unknown category', format('select public.hr_submit_claim(%L, ''bribes'', 8500, %L, null, null)', ea, today), 'PAY_BAD_INPUT'),
        (1, ma, 'a claim with no category', format('select public.hr_submit_claim(%L, null, 8500, %L, null, null)', ea, today), 'PAY_BAD_INPUT'),
        (1, ma, 'a description over 500 characters', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, %L, null)', ea, today, long_text), 'PAY_BAD_INPUT'),
        (1, ma, 'a member calls the pay figures directly', format('select private.hr_overtime_figures(%L, %L, ''2024-03-04'', 2)', org, eb), 'permission denied'),
        (1, ma, 'a member calls the may-act helper directly', format('select private.hr_pay_may_act(%L)', eb), 'permission denied'),
        (1, ma, 'member A submits own overtime', format('select public.hr_submit_overtime(%L, ''2024-03-04'', 2, ''  Month end  '')', ea), null),
        (1, ma, 'member A submits ten hours on a Saturday', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 10, ''first ten'')', ea), null),
        (1, ma, 'member A submits ten more that Saturday', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 10, ''second ten'')', ea), null),
        (1, ma, 'member A submits 4.5 hours on top of 20', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 4.5, null)', ea), 'PAY_TOO_MANY_HOURS'),
        (1, ma, 'member A submits 4 hours to make 24', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 4, null)', ea), null),
        (1, ma, 'member A submits half an hour on top of 24', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 0.5, null)', ea), 'PAY_TOO_MANY_HOURS'),
        (1, ma, 'overtime of no hours', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 0, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime below zero', format('select public.hr_submit_overtime(%L, ''2024-03-05'', -1, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime not in halves', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1.3, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime of 24.5 hours', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 24.5, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime with no hours given', format('select public.hr_submit_overtime(%L, ''2024-03-05'', null, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime dated tomorrow', format('select public.hr_submit_overtime(%L, %L, 1, null)', ea, today + 1), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime dated 1999', format('select public.hr_submit_overtime(%L, ''1999-12-31'', 1, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'overtime with no date', format('select public.hr_submit_overtime(%L, null, 1, null)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'an overtime reason over 500 characters', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, %L)', ea, long_text), 'PAY_BAD_INPUT'),
        (1, ma, 'a preview of hours not in halves', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1.3)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'a preview of 24.5 hours', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 24.5)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'a preview of no hours', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 0)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'a preview for tomorrow', format('select public.hr_overtime_preview(%L, %L, 1)', ea, today + 1), 'PAY_BAD_INPUT'),
        (1, ma, 'a preview with no date', format('select public.hr_overtime_preview(%L, null, 1)', ea), 'PAY_BAD_INPUT'),
        (1, ma, 'member A submits overtime for member B', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', eb), 'PAY_NOT_ALLOWED'),
        (1, ma, 'member A previews member B''s overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', eb), 'PAY_NOT_ALLOWED'),
        (1, mb, 'member B submits own claim', format('select public.hr_submit_claim(%L, ''meals'', 4200, %L, null, null)', eb, today - 1), null),
        (1, mb, 'member B submits a second claim', format('select public.hr_submit_claim(%L, ''other'', 9900, %L, null, null)', eb, today - 1), null),
        (1, mb, 'member B submits own overtime with no salary on file', format('select public.hr_submit_overtime(%L, ''2024-03-04'', 3, null)', eb), null),
        (1, mb, 'member B submits overtime the day after', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 2, null)', eb), null),
        (1, mb, 'member B submits ten hours on the Saturday member A filled', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 10, null)', eb), null),
        (1, mv, 'a linked viewer submits own claim of exactly RM 1,000,000', format('select public.hr_submit_claim(%L, ''equipment'', 100000000, %L, null, null)', ev, today), null),
        (1, mv, 'a linked viewer submits own overtime', format('select public.hr_submit_overtime(%L, %L, 1.5, null)', ev, today), null),
        (1, mv, 'a linked viewer submits a claim for member A', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ea, today), 'PAY_NOT_ALLOWED'),
        (1, mv, 'a linked viewer submits overtime for member A', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', ea), 'PAY_NOT_ALLOWED'),
        (1, mv, 'a linked viewer previews member A''s overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', ea), 'PAY_NOT_ALLOWED'),
        (1, mu, 'an unlinked member submits a claim for member A', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ea, today), 'PAY_NOT_ALLOWED'),
        (1, mu, 'an unlinked member submits a claim for the unlinked employee', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ec, today), 'PAY_NOT_ALLOWED'),
        (1, mu, 'an unlinked member submits overtime for member A', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', ea), 'PAY_NOT_ALLOWED'),
        (1, mu, 'an unlinked member previews member A''s overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', ea), 'PAY_NOT_ALLOWED'),
        (1, outsider, 'another workspace submits a claim for member A', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ea, today), 'PAY_NOT_ALLOWED'),
        (1, outsider, 'another workspace submits overtime for member A', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', ea), 'PAY_NOT_ALLOWED'),
        (1, outsider, 'another workspace previews member A''s overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', ea), 'PAY_NOT_ALLOWED'),
        (1, null, 'a session with no user submits a claim', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ea, today), 'PAY_NOT_ALLOWED'),
        (1, null, 'a session with no user submits overtime', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', ea), 'PAY_NOT_ALLOWED'),
        (1, null, 'a session with no user previews overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', ea), 'PAY_NOT_ALLOWED'),
        (1, admin_id, 'the admin submits a claim for an inactive employee', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ei, today), 'PAY_INACTIVE_EMPLOYEE'),
        (1, admin_id, 'the admin submits overtime for an inactive employee', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', ei), 'PAY_INACTIVE_EMPLOYEE'),
        (1, admin_id, 'the admin submits overtime for an employee whose salary on file is 0', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 2, null)', ec), null),
        (1, admin_id, 'the admin submits a claim for an employee that does not exist', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', gen_random_uuid(), today), 'PAY_NOT_ALLOWED'),
        (1, admin_id, 'the admin submits overtime for an employee that does not exist', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', gen_random_uuid()), 'PAY_NOT_ALLOWED'),
        (1, admin_id, 'the admin previews for an employee that does not exist', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', gen_random_uuid()), 'PAY_NOT_ALLOWED'),
        (1, admin_id, 'the admin attaches a file from member A''s folder', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, %L)', ea, today, f_a2), 'PAY_BAD_RECEIPT'),
        (1, admin_id, 'the admin submits a claim for member B with the admin''s own file', format('select public.hr_submit_claim(%L, ''travel'', 31000, %L, null, %L)', eb, today - 3, f_admin), null),
        (1, admin_id, 'the admin submits a second claim for member B with another of the admin''s files', format('select public.hr_submit_claim(%L, ''medical'', 7700, %L, null, %L)', eb, today - 1, f_admin2), null),
        (1, ma, 'member A submits a claim in the other workspace they belong to, with their own file', format('select public.hr_submit_claim(%L, ''travel'', 5000, %L, null, %L)', eo, today, f_a5), null),
        (1, dv, 'a demo visitor submits a claim for a demo employee', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', demo_emp, today), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor submits overtime for a demo employee', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', demo_emp), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor previews overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', demo_emp), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor cancels a demo claim', format('select public.hr_cancel_claim(%L)', demo_claim), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor approves a demo claim', format('select public.hr_decide_claim(%L, true, null)', demo_claim), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor marks a demo claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', demo_paid, today), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor undoes a paid mark in the demo', format('select public.hr_unmark_claim_paid(%L)', demo_paid), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor cancels demo overtime', format('select public.hr_cancel_overtime(%L)', demo_ot), 'PAY_NOT_ALLOWED'),
        (1, dv, 'a demo visitor approves demo overtime', format('select public.hr_decide_overtime(%L, true, null)', demo_ot), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin submits a claim for a demo employee', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', demo_emp, today), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin submits overtime for a demo employee', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', demo_emp), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin previews overtime', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', demo_emp), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin cancels a demo claim', format('select public.hr_cancel_claim(%L)', demo_claim), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin approves a demo claim', format('select public.hr_decide_claim(%L, true, null)', demo_claim), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin marks a demo claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', demo_paid, today), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin undoes a paid mark in the demo', format('select public.hr_unmark_claim_paid(%L)', demo_paid), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin cancels demo overtime', format('select public.hr_cancel_overtime(%L)', demo_ot), 'PAY_NOT_ALLOWED'),
        (1, da, 'a demo admin rejects demo overtime', format('select public.hr_decide_overtime(%L, false, null)', demo_ot), 'PAY_NOT_ALLOWED'),
        (1, outsider, 'someone outside the demo cancels a demo claim', format('select public.hr_cancel_claim(%L)', demo_claim), 'PAY_NOT_FOUND'),
        (1, outsider, 'someone outside the demo marks a demo claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', demo_paid, today), 'PAY_NOT_FOUND'),
        (1, outsider, 'someone outside the demo approves demo overtime', format('select public.hr_decide_overtime(%L, true, null)', demo_ot), 'PAY_NOT_FOUND'),

        -- 2: a cancelled request frees its hours; its receipt, and a released file, can never be attached again
        (2, ma, 'member A cancels own pending claim, the one with a receipt', format('select public.hr_cancel_claim(%L)', ca2), null),
        (2, ma, 'member A attaches the cancelled claim''s receipt to a new claim', format('select public.hr_submit_claim(%L, ''medical'', 12000, %L, null, %L)', ea, today, f_a1), 'PAY_BAD_RECEIPT'),
        (2, ma, 'member A attaches a file they released', format('select public.hr_submit_claim(%L, ''medical'', 12000, %L, null, %L)', ea, today, f_a4), 'PAY_BAD_RECEIPT'),
        (2, ma, 'member A submits again with a fresh file', format('select public.hr_submit_claim(%L, ''medical'', 12000, %L, ''Second try'', %L)', ea, today, f_a3), null),
        (2, ma, 'member A cancels the first ten hours', format('select public.hr_cancel_overtime(%L)', oa2), null),
        (2, ma, 'member A submits ten hours again that Saturday', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 10, ''third ten'')', ea), null),
        (2, ma, 'member A submits half an hour on top of 24 again', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 0.5, null)', ea), 'PAY_TOO_MANY_HOURS'),

        -- 3: deciding and paying, and acting on someone else's request
        (3, ma, 'member A approves own claim', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_ALLOWED'),
        (3, ma, 'member A rejects own claim', format('select public.hr_decide_claim(%L, false, null)', ca1), 'PAY_NOT_ALLOWED'),
        (3, ma, 'member A marks own claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_ALLOWED'),
        (3, ma, 'member A undoes a paid mark on own claim', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_ALLOWED'),
        (3, ma, 'member A approves own overtime', format('select public.hr_decide_overtime(%L, true, null)', oa1), 'PAY_NOT_ALLOWED'),
        (3, ma, 'member A approves member B''s claim', format('select public.hr_decide_claim(%L, true, null)', cb1), 'PAY_NOT_FOUND'),
        (3, ma, 'member A cancels member B''s claim', format('select public.hr_cancel_claim(%L)', cb1), 'PAY_NOT_FOUND'),
        (3, ma, 'member A marks member B''s claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', cb1, today), 'PAY_NOT_FOUND'),
        (3, ma, 'member A undoes a paid mark on member B''s claim', format('select public.hr_unmark_claim_paid(%L)', cb1), 'PAY_NOT_FOUND'),
        (3, ma, 'member A approves member B''s overtime', format('select public.hr_decide_overtime(%L, true, null)', ob1), 'PAY_NOT_FOUND'),
        (3, ma, 'member A cancels member B''s overtime', format('select public.hr_cancel_overtime(%L)', ob1), 'PAY_NOT_FOUND'),
        (3, mb, 'member B cancels member A''s claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_NOT_FOUND'),
        (3, mb, 'member B approves member A''s claim', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_FOUND'),
        (3, mb, 'member B cancels member A''s overtime', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_FOUND'),
        (3, mb, 'member B approves member A''s overtime', format('select public.hr_decide_overtime(%L, true, null)', oa1), 'PAY_NOT_FOUND'),
        (3, mu, 'an unlinked member cancels member A''s claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_NOT_FOUND'),
        (3, mu, 'an unlinked member approves member A''s claim', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_FOUND'),
        (3, mu, 'an unlinked member marks member A''s claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_FOUND'),
        (3, mu, 'an unlinked member undoes a paid mark', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_FOUND'),
        (3, mu, 'an unlinked member cancels member A''s overtime', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_FOUND'),
        (3, mu, 'an unlinked member approves member A''s overtime', format('select public.hr_decide_overtime(%L, true, null)', oa1), 'PAY_NOT_FOUND'),
        (3, outsider, 'another workspace cancels member A''s claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_NOT_FOUND'),
        (3, outsider, 'another workspace approves member A''s claim', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_FOUND'),
        (3, outsider, 'another workspace marks member A''s claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_FOUND'),
        (3, outsider, 'another workspace undoes a paid mark', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_FOUND'),
        (3, outsider, 'another workspace cancels member A''s overtime', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_FOUND'),
        (3, outsider, 'another workspace approves member A''s overtime', format('select public.hr_decide_overtime(%L, true, null)', oa1), 'PAY_NOT_FOUND'),
        (3, mv, 'a linked viewer approves own claim', format('select public.hr_decide_claim(%L, true, null)', cv1), 'PAY_NOT_ALLOWED'),
        (3, mv, 'a linked viewer marks own claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', cv1, today), 'PAY_NOT_ALLOWED'),
        (3, mv, 'a linked viewer approves own overtime', format('select public.hr_decide_overtime(%L, true, null)', ov1), 'PAY_NOT_ALLOWED'),
        (3, mv, 'a linked viewer approves member A''s claim', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_FOUND'),
        (3, mv, 'a linked viewer cancels member A''s claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_NOT_FOUND'),
        (3, mv, 'a linked viewer cancels member A''s overtime', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_FOUND'),
        (3, null, 'a session with no user approves a claim', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_ALLOWED'),
        (3, null, 'a session with no user cancels a claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_NOT_ALLOWED'),
        (3, null, 'a session with no user marks a claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_ALLOWED'),
        (3, null, 'a session with no user undoes a paid mark', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_ALLOWED'),
        (3, null, 'a session with no user approves overtime', format('select public.hr_decide_overtime(%L, true, null)', oa1), 'PAY_NOT_ALLOWED'),
        (3, null, 'a session with no user cancels overtime', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_ALLOWED'),
        (3, admin_id, 'a claim note over 500 characters', format('select public.hr_decide_claim(%L, false, %L)', ca1, long_text), 'PAY_BAD_INPUT'),
        (3, admin_id, 'a claim decision that is neither approve nor reject', format('select public.hr_decide_claim(%L, null, null)', ca1), 'PAY_BAD_INPUT'),
        (3, admin_id, 'an overtime note over 500 characters', format('select public.hr_decide_overtime(%L, false, %L)', oa1, long_text), 'PAY_BAD_INPUT'),
        (3, admin_id, 'an overtime decision that is neither approve nor reject', format('select public.hr_decide_overtime(%L, null, null)', oa1), 'PAY_BAD_INPUT'),
        (3, admin_id, 'the admin marks a pending claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_APPROVED'),
        (3, admin_id, 'the admin undoes a paid mark on a pending claim', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_PAID'),
        (3, admin_id, 'the admin approves member A''s claim', format('select public.hr_decide_claim(%L, true, ''fine'')', ca1), null),
        (3, admin_id, 'the admin approves it a second time', format('select public.hr_decide_claim(%L, true, null)', ca1), 'PAY_NOT_PENDING'),
        (3, admin_id, 'the admin rejects it after approving', format('select public.hr_decide_claim(%L, false, null)', ca1), 'PAY_NOT_PENDING'),
        (3, admin_id, 'the admin approves a cancelled claim', format('select public.hr_decide_claim(%L, true, null)', ca2), 'PAY_NOT_PENDING'),
        (3, admin_id, 'the admin marks a cancelled claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', ca2, today), 'PAY_NOT_APPROVED'),
        (3, admin_id, 'the admin rejects member B''s second claim', format('select public.hr_decide_claim(%L, false, ''  No receipt  '')', cb2), null),
        (3, admin_id, 'the admin marks a rejected claim paid', format('select public.hr_mark_claim_paid(%L, %L, null)', cb2, today), 'PAY_NOT_APPROVED'),
        (3, admin_id, 'the admin undoes a paid mark on a rejected claim', format('select public.hr_unmark_claim_paid(%L)', cb2), 'PAY_NOT_PAID'),
        (3, admin_id, 'the admin approves member B''s first claim', format('select public.hr_decide_claim(%L, true, null)', cb1), null),
        (3, admin_id, 'the admin approves member A''s claim with a receipt', format('select public.hr_decide_claim(%L, true, null)', ca3), null),
        (3, admin_id, 'the admin undoes a paid mark on an approved claim', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_PAID'),
        (3, admin_id, 'a paid mark with no date', format('select public.hr_mark_claim_paid(%L, null, null)', ca1), 'PAY_BAD_INPUT'),
        (3, admin_id, 'a paid mark dated tomorrow', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today + 1), 'PAY_BAD_INPUT'),
        (3, admin_id, 'a paid mark dated before the claim', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today - 3), 'PAY_BAD_INPUT'),
        (3, admin_id, 'a paid reference over 100 characters', format('select public.hr_mark_claim_paid(%L, %L, %L)', ca1, today, long_ref), 'PAY_BAD_INPUT'),
        (3, admin_id, 'the admin marks member A''s claim paid on the day of the claim', format('select public.hr_mark_claim_paid(%L, %L, ''  TT-123  '')', ca1, today - 2), null),
        (3, admin_id, 'the admin marks it paid a second time', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_APPROVED'),
        (3, admin_id, 'the admin rejects a paid claim', format('select public.hr_decide_claim(%L, false, null)', ca1), 'PAY_NOT_PENDING'),
        (3, admin_id, 'the admin cancels a paid claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_ALREADY_PAID'),
        (3, admin_id, 'the admin marks the claim with a receipt paid today', format('select public.hr_mark_claim_paid(%L, %L, null)', ca3, today), null),
        (3, admin_id, 'the admin approves a claim that does not exist', format('select public.hr_decide_claim(%L, true, null)', gen_random_uuid()), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin cancels a claim that does not exist', format('select public.hr_cancel_claim(%L)', gen_random_uuid()), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin marks paid a claim that does not exist', format('select public.hr_mark_claim_paid(%L, %L, null)', gen_random_uuid(), today), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin undoes a paid mark that does not exist', format('select public.hr_unmark_claim_paid(%L)', gen_random_uuid()), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin approves overtime that does not exist', format('select public.hr_decide_overtime(%L, true, null)', gen_random_uuid()), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin cancels overtime that does not exist', format('select public.hr_cancel_overtime(%L)', gen_random_uuid()), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin passes an overtime id to the claim functions', format('select public.hr_decide_claim(%L, true, null)', oa1), 'PAY_NOT_FOUND'),
        (3, admin_id, 'the admin approves member A''s overtime', format('select public.hr_decide_overtime(%L, true, ''fine'')', oa1), null),
        (3, admin_id, 'the admin approves that overtime a second time', format('select public.hr_decide_overtime(%L, true, null)', oa1), 'PAY_NOT_PENDING'),
        (3, admin_id, 'the admin approves cancelled overtime', format('select public.hr_decide_overtime(%L, true, null)', oa2), 'PAY_NOT_PENDING'),
        (3, admin_id, 'the admin rejects the second ten hours', format('select public.hr_decide_overtime(%L, false, ''  Not agreed  '')', oa3), null),
        (3, admin_id, 'the admin approves the four hours', format('select public.hr_decide_overtime(%L, true, null)', oa4), null),
        (3, admin_id, 'the admin approves member B''s overtime while there is no salary on file', format('select public.hr_decide_overtime(%L, true, null)', ob1), null),

        -- 4: a member cancels only their own, only while pending; a rejected record frees its hours
        (4, ma, 'member A cancels own paid claim', format('select public.hr_cancel_claim(%L)', ca3), 'PAY_NOT_PENDING'),
        (4, ma, 'member A cancels own approved claim', format('select public.hr_cancel_claim(%L)', ca1), 'PAY_NOT_PENDING'),
        (4, ma, 'member A cancels own claim twice', format('select public.hr_cancel_claim(%L)', ca2), 'PAY_NOT_PENDING'),
        (4, mb, 'member B cancels own rejected claim', format('select public.hr_cancel_claim(%L)', cb2), 'PAY_NOT_PENDING'),
        (4, mb, 'member B cancels own approved claim', format('select public.hr_cancel_claim(%L)', cb1), 'PAY_NOT_PENDING'),
        (4, ma, 'member A cancels own approved overtime', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_PENDING'),
        (4, ma, 'member A cancels own rejected overtime', format('select public.hr_cancel_overtime(%L)', oa3), 'PAY_NOT_PENDING'),
        (4, ma, 'member A cancels own overtime twice', format('select public.hr_cancel_overtime(%L)', oa2), 'PAY_NOT_PENDING'),
        (4, ma, 'member A submits ten hours in place of the rejected ten', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 10, ''fourth ten'')', ea), null),
        (4, ma, 'member A submits half an hour on top of 4 approved and 20 pending', format('select public.hr_submit_overtime(%L, ''2024-03-09'', 0.5, null)', ea), 'PAY_TOO_MANY_HOURS'),
        (4, ma, 'member A submits one more claim', format('select public.hr_submit_claim(%L, ''meals'', 2600, %L, null, null)', ea, today), null),
        (4, mv, 'a linked viewer cancels own pending overtime', format('select public.hr_cancel_overtime(%L)', ov1), null),

        -- 5: the admin cancels anything not already cancelled, and no paid claim
        (5, admin_id, 'the admin cancels a paid claim with a receipt', format('select public.hr_cancel_claim(%L)', ca3), 'PAY_ALREADY_PAID'),
        (5, admin_id, 'the admin undoes its paid mark', format('select public.hr_unmark_claim_paid(%L)', ca3), null),
        (5, admin_id, 'the admin undoes it a second time', format('select public.hr_unmark_claim_paid(%L)', ca3), 'PAY_NOT_PAID'),
        (5, admin_id, 'the admin cancels the claim once the mark is undone', format('select public.hr_cancel_claim(%L)', ca3), null),
        (5, admin_id, 'the admin cancels it a second time', format('select public.hr_cancel_claim(%L)', ca3), 'PAY_NOT_PENDING'),
        (5, admin_id, 'the admin cancels an approved claim', format('select public.hr_cancel_claim(%L)', cb1), null),
        (5, admin_id, 'the admin cancels a rejected claim', format('select public.hr_cancel_claim(%L)', cb2), null),
        (5, admin_id, 'the admin cancels a pending claim', format('select public.hr_cancel_claim(%L)', cadm), null),
        (5, admin_id, 'the admin cancels the second claim entered for member B', format('select public.hr_cancel_claim(%L)', cby), null),
        (5, admin_id, 'the admin cancels approved overtime', format('select public.hr_cancel_overtime(%L)', oa1), null),
        (5, admin_id, 'the admin cancels it a second time', format('select public.hr_cancel_overtime(%L)', oa1), 'PAY_NOT_PENDING'),
        (5, admin_id, 'the admin cancels rejected overtime', format('select public.hr_cancel_overtime(%L)', oa3), null),
        (5, admin_id, 'the admin cancels pending overtime', format('select public.hr_cancel_overtime(%L)', oa5), null),
        (5, admin_id, 'the admin cancels overtime approved with no pay worked out', format('select public.hr_cancel_overtime(%L)', ob1), null),

        -- 6: member A and the admin now have an authenticator, and these sessions have not entered a code
        (6, ma, 'member A submits a claim without the second factor', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', ea, today), 'PAY_NOT_ALLOWED'),
        (6, ma, 'member A submits overtime without the second factor', format('select public.hr_submit_overtime(%L, ''2024-03-05'', 1, null)', ea), 'PAY_NOT_ALLOWED'),
        (6, ma, 'member A previews overtime without the second factor', format('select public.hr_overtime_preview(%L, ''2024-03-05'', 1)', ea), 'PAY_NOT_ALLOWED'),
        (6, ma, 'member A cancels own claim without the second factor', format('select public.hr_cancel_claim(%L)', ca4), 'PAY_NOT_FOUND'),
        (6, ma, 'member A cancels own overtime without the second factor', format('select public.hr_cancel_overtime(%L)', oa6), 'PAY_NOT_FOUND'),
        (6, admin_id, 'the admin submits a claim without the second factor', format('select public.hr_submit_claim(%L, ''travel'', 8500, %L, null, null)', eb, today), 'PAY_NOT_ALLOWED'),
        (6, admin_id, 'the admin submits overtime without the second factor', format('select public.hr_submit_overtime(%L, ''2024-03-07'', 1, null)', eb), 'PAY_NOT_ALLOWED'),
        (6, admin_id, 'the admin previews overtime without the second factor', format('select public.hr_overtime_preview(%L, ''2024-03-07'', 1)', eb), 'PAY_NOT_ALLOWED'),
        (6, admin_id, 'the admin approves a claim without the second factor', format('select public.hr_decide_claim(%L, true, null)', ca4), 'PAY_NOT_FOUND'),
        (6, admin_id, 'the admin cancels a claim without the second factor', format('select public.hr_cancel_claim(%L)', ca4), 'PAY_NOT_FOUND'),
        (6, admin_id, 'the admin marks a claim paid without the second factor', format('select public.hr_mark_claim_paid(%L, %L, null)', ca1, today), 'PAY_NOT_FOUND'),
        (6, admin_id, 'the admin undoes a paid mark without the second factor', format('select public.hr_unmark_claim_paid(%L)', ca1), 'PAY_NOT_FOUND'),
        (6, admin_id, 'the admin approves overtime without the second factor', format('select public.hr_decide_overtime(%L, true, null)', oa6), 'PAY_NOT_FOUND'),
        (6, admin_id, 'the admin cancels overtime without the second factor', format('select public.hr_cancel_overtime(%L)', oa6), 'PAY_NOT_FOUND')
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
        elsif (want like 'PAY\_%' and sqlerrm <> want) or sqlerrm not like want || '%' then
          -- A refusal is its code and nothing else.
          fails := array_append(fails, format('%s: expected %s, got %s', label, want, sqlerrm));
        end if;
      end;
      reset role;
    end loop;

    if stage = 1 then
      select id into ca1 from public.hr_claims where employee_id = ea and category = 'travel';
      select id into ca2 from public.hr_claims where employee_id = ea and category = 'medical';
      select id into cb1 from public.hr_claims where employee_id = eb and category = 'meals';
      select id into cb2 from public.hr_claims where employee_id = eb and category = 'other';
      select id into cv1 from public.hr_claims where employee_id = ev;
      select id into cbx from public.hr_claims where employee_id = eb and receipt_path = f_admin;
      select id into cby from public.hr_claims where employee_id = eb and receipt_path = f_admin2;
      select count(*) into n from public.hr_claims where org_id = other_org and employee_id = eo and receipt_path = f_a5;
      if cby is null or n <> 1 then fails := array_append(fails, 'the second claim for member B, or member A''s claim in the other workspace, was not saved'); end if;
      select id into oa1 from public.hr_overtime_records where employee_id = ea and work_date = '2024-03-04';
      select id into oa2 from public.hr_overtime_records where employee_id = ea and reason = 'first ten';
      select id into oa3 from public.hr_overtime_records where employee_id = ea and reason = 'second ten';
      select id into oa4 from public.hr_overtime_records where employee_id = ea and work_date = '2024-03-09' and hours = 4;
      select id into ob1 from public.hr_overtime_records where employee_id = eb and work_date = '2024-03-04';
      select id into ob2 from public.hr_overtime_records where employee_id = eb and work_date = '2024-03-05';
      select id into ov1 from public.hr_overtime_records where employee_id = ev;
      if cv1 is null or ov1 is null then fails := array_append(fails, 'a linked viewer''s own claim and overtime were not saved'); end if;

      select count(*) into n from public.hr_claims where org_id = org;
      if n <> 7 then fails := array_append(fails, format('%s claims after submitting, expected 7', n)); end if;
      select count(*) into n from public.hr_overtime_records where org_id = org;
      if n <> 9 then fails := array_append(fails, format('%s overtime records after submitting, expected 9', n)); end if;
      select id into oc from public.hr_overtime_records where employee_id = ec;
      select count(*) into n from public.hr_overtime_records
      where id = oc and hourly_rate_cents is null and amount_cents = 0 and day_kind = 'weekday';
      if n <> 1 then fails := array_append(fails, 'overtime with a salary of 0 on file was not saved as not calculated (no rate, amount 0)'); end if;

      select count(*) into n from public.hr_claims
      where id = ca1 and org_id = org and amount_cents = 8500 and claim_date = today - 2 and status = 'pending'
        and description = 'Taxi to client' and requested_by = ma and not has_receipt and receipt_path is null
        and decided_by is null and decided_at is null and decision_note is null
        and paid_on is null and paid_reference is null and paid_by is null;
      if n <> 1 then fails := array_append(fails, 'member A''s claim was not saved pending, with a trimmed description, who asked and no receipt'); end if;
      select count(*) into n from public.hr_claims where id = ca2 and has_receipt and receipt_path = f_a1 and description is null;
      if n <> 1 then fails := array_append(fails, 'a claim with a receipt did not record its path and tick has_receipt'); end if;
      select count(*) into n from public.hr_claims where id = cbx and requested_by = admin_id and employee_id = eb and has_receipt and status = 'pending';
      if n <> 1 then fails := array_append(fails, 'a claim entered by the admin does not record the admin as who asked'); end if;

      select count(*) into n from public.hr_overtime_records
      where id = oa1 and org_id = org and hours = 2 and day_kind = 'weekday' and rate_multiplier = 2.5
        and hourly_rate_cents = 2501 and amount_cents = 12505 and status = 'pending' and reason = 'Month end'
        and requested_by = ma and decided_by is null and decided_at is null and decision_note is null;
      if n <> 1 then fails := array_append(fails, 'member A''s overtime was not saved pending with the worked-out figures (2 h x 2.5 x 2501 = 12505), a trimmed reason and who asked'); end if;
      select count(*) into n from public.hr_overtime_records
      where id = oa4 and day_kind = 'rest_day' and rate_multiplier = 2.0 and hourly_rate_cents = 2501 and amount_cents = 20008;
      if n <> 1 then fails := array_append(fails, 'overtime on a Saturday was not saved as a rest day at 2.0'); end if;
      select count(*) into n from public.hr_overtime_records
      where id in (ob1, ob2) and hourly_rate_cents is null and amount_cents = 0 and day_kind = 'weekday' and rate_multiplier = 2.5;
      if n <> 2 then fails := array_append(fails, 'overtime with no salary on file was not saved with no rate and an amount of 0'); end if;

      -- What comes back, and the admin entering either for someone.
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_submit_claim(eb, 'equipment', 45050, today - 5, null, null);
      cadm := (r->>'id')::uuid;
      if r->>'employee_id' <> eb::text or r->>'category' <> 'equipment' or (r->>'amount_cents')::bigint <> 45050
         or jsonb_typeof(r->'amount_cents') <> 'number' or r->>'claim_date' <> (today - 5)::text
         or r->'has_receipt' <> 'false'::jsonb or r->>'status' <> 'pending' or cadm is null then
        fails := array_append(fails, 'submitting a claim did not return the claim: ' || r::text);
      end if;
      r := public.hr_submit_overtime(ea, date '2024-03-06', 1.5, null);
      oadm := (r->>'id')::uuid;
      if r->>'employee_id' <> ea::text or r->>'work_date' <> '2024-03-06' or (r->>'hours')::numeric <> 1.5
         or jsonb_typeof(r->'hours') <> 'number' or r->>'day_kind' <> 'public_holiday' or (r->>'rate_multiplier')::numeric <> 3.0
         or (r->>'hourly_rate_cents')::bigint <> 2501 or (r->>'amount_cents')::bigint <> 11255
         or r->>'status' <> 'pending' or oadm is null then
        fails := array_append(fails, 'submitting overtime did not return the record (1.5 h x 3.0 x 2501 = 11254.5, so 11255): ' || r::text);
      end if;
      reset role;
      select count(*) into n from public.hr_overtime_records where id = oadm and requested_by = admin_id and employee_id = ea;
      if n <> 1 then fails := array_append(fails, 'overtime entered by the admin does not record the admin as who asked'); end if;

      -- A record keeps the figures it was made with: the multipliers, the
      -- holiday list and the salary all change now.
      update public.hr_settings set overtime_rates = '{"weekday":1.5,"rest_day":2.0,"public_holiday":3.0}'::jsonb where org_id = org;
      insert into public.hr_public_holidays (org_id, name, holiday_date) values (org, 'Added Later', date '2024-03-04');
      update public.hr_employee_private set base_salary_cents = 1040000 where employee_id = ea;

      -- No function puts a receipt on a demo claim. One is planted here (and
      -- taken off again after the reads below), because every demo member can
      -- read every demo claim: the file must still be closed to them.
      update public.hr_claims set receipt_path = f_b where id = demo_claim;

      -- The admin entered a claim for member B with a file from the admin's own
      -- folder. Demoted to member, the admin no longer reads that claim, and
      -- still may not have its receipt thrown away.
      update public.org_members set role = 'member' where org_id = org and user_id = admin_id;
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      select count(*) into n from public.hr_claims where id = cby;
      got := public.hr_release_receipt(f_admin2);
      reset role;
      update public.org_members set role = 'admin' where org_id = org and user_id = admin_id;
      if n <> 0 then fails := array_append(fails, 'a demoted admin still reads a claim they entered for someone else'); end if;
      if got is distinct from false then
        fails := array_append(fails, 'a demoted admin released the receipt of a claim they entered for someone else');
      end if;

    elsif stage = 2 then
      select count(*) into n from public.hr_claims where id = ca2 and status = 'cancelled' and receipt_path is null and not has_receipt;
      if n <> 1 then fails := array_append(fails, 'a cancelled claim kept its receipt'); end if;
      select id into ca3 from public.hr_claims where employee_id = ea and description = 'Second try' and receipt_path = f_a3 and has_receipt;
      if ca3 is null then fails := array_append(fails, 'a claim with a fresh file was not saved after another was cancelled'); end if;
      select count(*) into n from public.hr_claims where receipt_path in (f_a1, f_a4);
      if n <> 0 then fails := array_append(fails, 'a cancelled claim''s receipt, or a released file, is on a claim'); end if;
      select count(*) into n from public.hr_overtime_records where id = oa2 and status = 'cancelled';
      if n <> 1 then fails := array_append(fails, 'member A''s pending overtime was not cancelled'); end if;
      select id into oa5 from public.hr_overtime_records where employee_id = ea and reason = 'third ten';
      if oa5 is null then fails := array_append(fails, 'cancelled overtime still counted towards the 24 hours'); end if;

    elsif stage = 3 then
      select count(*) into n from public.hr_claims
      where id = ca1 and status = 'paid' and decided_by = admin_id and decided_at is not null and decision_note is null
        and paid_on = today - 2 and paid_reference = 'TT-123' and paid_by = admin_id;
      if n <> 1 then fails := array_append(fails, 'approving then marking paid did not record who, when, the date paid and the trimmed reference'); end if;
      select count(*) into n from public.hr_claims
      where id = ca3 and status = 'paid' and paid_on = today and paid_reference is null and paid_by = admin_id and receipt_path = f_a3;
      if n <> 1 then fails := array_append(fails, 'a paid mark with no reference was not saved, or it lost the receipt'); end if;
      select count(*) into n from public.hr_claims
      where id = cb2 and status = 'rejected' and decided_by = admin_id and decision_note = 'No receipt' and paid_on is null;
      if n <> 1 then fails := array_append(fails, 'rejecting a claim did not record the trimmed note'); end if;
      select count(*) into n from public.hr_claims where id = cb1 and status = 'approved' and paid_on is null and paid_by is null;
      if n <> 1 then fails := array_append(fails, 'approving a claim set a paid column'); end if;

      -- The table itself ties the paid columns to the status.
      begin
        update public.hr_claims set paid_on = today where id = cb1;
        fails := array_append(fails, 'the table let an approved claim carry a date paid');
      exception when check_violation then null;
      end;
      begin
        update public.hr_claims set paid_on = null where id = ca1;
        fails := array_append(fails, 'the table let a paid claim have no date paid');
      exception when check_violation then null;
      end;
      begin
        update public.hr_claims set status = 'settled' where id = cb1;
        fails := array_append(fails, 'the table took a status it does not know');
      exception when check_violation then null;
      end;

      select count(*) into n from public.hr_overtime_records
      where id = oa1 and status = 'approved' and decided_by = admin_id and decided_at is not null and decision_note is null
        and day_kind = 'weekday' and rate_multiplier = 2.5 and hourly_rate_cents = 2501 and amount_cents = 12505;
      if n <> 1 then fails := array_append(fails, 'approving overtime did not record who and when, or changed figures fixed when it was made'); end if;
      select count(*) into n from public.hr_overtime_records
      where id = oa3 and status = 'rejected' and decided_by = admin_id and decision_note = 'Not agreed';
      if n <> 1 then fails := array_append(fails, 'rejecting overtime did not record the trimmed note'); end if;
      select count(*) into n from public.hr_overtime_records
      where id = ob1 and status = 'approved' and hourly_rate_cents is null and amount_cents = 0 and rate_multiplier = 2.5;
      if n <> 1 then fails := array_append(fails, 'approving overtime with no salary on file did not leave it not calculated'); end if;

      -- A salary is now on file for member B (RM 4,160: RM 20.00 an hour).
      -- Approving works the figures out, on the settings as they are now.
      insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (eb, org, 416000);
      -- And the salary of 0 becomes a real one: the same happens for that record.
      update public.hr_employee_private set base_salary_cents = 416000 where employee_id = ec;
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_decide_overtime(oc, true, null);
      if r->>'status' <> 'approved' or (r->>'amount_cents')::bigint is distinct from 6000 then
        fails := array_append(fails, 'approving overtime made on a salary of 0, after a real salary was set, did not return the worked-out amount (6000): ' || r::text);
      end if;
      r := public.hr_decide_overtime(ob2, true, null);
      if r->>'id' <> ob2::text or r->>'status' <> 'approved' or (r->>'amount_cents')::bigint is distinct from 6000 then
        fails := array_append(fails, 'approving overtime after a salary was set did not return the worked-out amount (2 h x 1.5 x 2000 = 6000): ' || r::text);
      end if;
      -- Rejecting does not work anything out.
      r := public.hr_submit_overtime(eb, date '2024-03-07', 1, null);
      if (r->>'hourly_rate_cents')::bigint is distinct from 2000 or (r->>'amount_cents')::bigint is distinct from 3000 then
        fails := array_append(fails, 'overtime submitted after a salary was set was not worked out: ' || r::text);
      end if;
      r := public.hr_decide_overtime((r->>'id')::uuid, false, null);
      if r->>'status' <> 'rejected' or not (r ? 'amount_cents') then
        fails := array_append(fails, 'rejecting overtime did not return its status and amount: ' || r::text);
      end if;
      r := public.hr_decide_claim(cbx, true, null);
      if r <> jsonb_build_object('id', cbx, 'status', 'approved') then
        fails := array_append(fails, 'deciding a claim did not return its id and status: ' || r::text);
      end if;
      r := public.hr_mark_claim_paid(cbx, today, 'Batch 7');
      if r <> jsonb_build_object('id', cbx, 'status', 'paid', 'paid_on', today) then
        fails := array_append(fails, 'marking a claim paid did not return its id, status and date: ' || r::text);
      end if;
      r := public.hr_unmark_claim_paid(cbx);
      if r <> jsonb_build_object('id', cbx, 'status', 'approved') then
        fails := array_append(fails, 'undoing a paid mark did not return its id and status: ' || r::text);
      end if;
      r := public.hr_unmark_claim_paid(ca1);
      reset role;
      select count(*) into n from public.hr_overtime_records
      where id = ob2 and status = 'approved' and day_kind = 'weekday' and rate_multiplier = 1.5
        and hourly_rate_cents = 2000 and amount_cents = 6000;
      if n <> 1 then fails := array_append(fails, 'approving overtime after a salary was set did not save the worked-out figures'); end if;
      select count(*) into n from public.hr_overtime_records
      where id = oc and status = 'approved' and hourly_rate_cents = 2000 and amount_cents = 6000 and rate_multiplier = 1.5;
      if n <> 1 then fails := array_append(fails, 'approving overtime made on a salary of 0 did not save the worked-out figures once a real salary was set'); end if;
      select count(*) into n from public.hr_overtime_records where id = ob1 and hourly_rate_cents is null and amount_cents = 0;
      if n <> 1 then fails := array_append(fails, 'setting a salary changed overtime that was already approved'); end if;
      select count(*) into n from public.hr_claims
      where id in (ca1, cbx) and status = 'approved' and paid_on is null and paid_reference is null and paid_by is null
        and decided_by = admin_id;
      if n <> 2 then fails := array_append(fails, 'undoing a paid mark did not return the claim to approved with the three paid columns cleared'); end if;

    elsif stage = 4 then
      select count(*) into n from public.hr_claims where id in (ca1, ca3, cb1, cb2) and status in ('approved', 'paid', 'rejected');
      if n <> 4 then fails := array_append(fails, 'a member cancelled a claim that was no longer pending'); end if;
      select id into oa6 from public.hr_overtime_records where employee_id = ea and reason = 'fourth ten';
      if oa6 is null then fails := array_append(fails, 'rejected overtime still counted towards the 24 hours'); end if;
      select id into ca4 from public.hr_claims where employee_id = ea and category = 'meals';
      select count(*) into n from public.hr_overtime_records where id = ov1 and status = 'cancelled';
      if n <> 1 then fails := array_append(fails, 'a linked viewer could not cancel own pending overtime'); end if;

      -- What cancelling returns, with and without a receipt.
      perform set_config('request.jwt.claims', json_build_object('sub', mv, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_cancel_claim(cv1);
      if r <> jsonb_build_object('id', cv1, 'status', 'cancelled', 'removed_receipt_path', null) then
        fails := array_append(fails, 'a linked viewer cancelling own claim did not get id, status and a null path: ' || r::text);
      end if;
      reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_cancel_overtime(oadm);
      if r <> jsonb_build_object('id', oadm, 'status', 'cancelled') then
        fails := array_append(fails, 'member A cancelling pending overtime the admin entered for them did not return id and status: ' || r::text);
      end if;
      reset role;

    elsif stage = 5 then
      select count(*) into n from public.hr_claims where id = ca3 and status = 'cancelled' and receipt_path is null and not has_receipt and paid_on is null;
      if n <> 1 then fails := array_append(fails, 'the admin cancelling a claim did not clear its receipt'); end if;
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      r := public.hr_cancel_claim(cbx);
      if r <> jsonb_build_object('id', cbx, 'status', 'cancelled', 'removed_receipt_path', f_admin) then
        fails := array_append(fails, 'cancelling a claim with a receipt did not return the path it cleared: ' || r::text);
      end if;
      r := public.hr_cancel_claim(ca1);
      -- The path cancel handed back for removal cannot go on another claim.
      begin
        perform public.hr_submit_claim(eb, 'travel', 31000, today - 3, null, f_admin);
        fails := array_append(fails, 'the path a cancel returned was attached to a new claim');
      exception when others then
        if sqlerrm <> 'PAY_BAD_RECEIPT' then
          fails := array_append(fails, 'attaching the path a cancel returned: expected PAY_BAD_RECEIPT, got ' || sqlerrm);
        end if;
      end;
      reset role;
      select count(*) into n from private.hr_released_receipts x where x.path in (f_admin, f_admin2, f_a1, f_a3);
      if n <> 4 then fails := array_append(fails, format('%s of the 4 receipts of cancelled claims are recorded as released', n)); end if;
      select count(*) into n from public.hr_claims where org_id = org and status <> 'cancelled' and id <> ca4;
      if n <> 0 then fails := array_append(fails, format('%s claims the admin could not cancel', n)); end if;
      select count(*) into n from public.hr_claims where org_id = org and (receipt_path is not null or has_receipt);
      if n <> 0 then fails := array_append(fails, format('%s cancelled claims still carry a receipt', n)); end if;
      select count(*) into n from public.hr_overtime_records where id in (oa1, oa3, oa5, ob1) and status = 'cancelled';
      if n <> 4 then fails := array_append(fails, format('%s of 4 overtime records cancelled by the admin', n)); end if;
      -- Cancelling leaves the figures as they were.
      select count(*) into n from public.hr_overtime_records where id = oa1 and amount_cents = 12505 and hourly_rate_cents = 2501;
      if n <> 1 then fails := array_append(fails, 'cancelling overtime changed its figures'); end if;
    end if;

    -- ---- who can read which receipt file, at this point -------------------
    for who, label, f, seen in
      select c.who, c.label, c.f, c.seen from (values
        -- 1: the admin's file is on member B's claim; member A's first file is on member A's claim
        (1, admin_id, 'the admin, their own upload', f_admin, 1),
        (1, mb, 'member B, the receipt on their claim, uploaded by the admin', f_admin, 1),
        (1, ma, 'member A, a colleague''s receipt', f_admin, 0),
        (1, mv, 'a linked viewer, a colleague''s receipt', f_admin, 0),
        (1, mu, 'an unlinked member, a colleague''s receipt', f_admin, 0),
        (1, outsider, 'another workspace, a receipt', f_admin, 0),
        (1, dv, 'a demo visitor, a receipt', f_admin, 0),
        (1, da, 'a demo admin, a receipt', f_admin, 0),
        (1, guest, 'an anonymous account, a receipt', f_admin, 0),
        (1, null, 'a session with no user, a receipt', f_admin, 0),
        (1, ma, 'member A, the receipt on their own claim', f_a1, 1),
        (1, admin_id, 'the admin, the receipt on member A''s claim', f_a1, 1),
        (1, mb, 'member B, member A''s receipt', f_a1, 0),
        (1, mv, 'a linked viewer, member A''s receipt', f_a1, 0),
        (1, mu, 'an unlinked member, member A''s receipt', f_a1, 0),
        (1, outsider, 'another workspace, member A''s receipt', f_a1, 0),
        (1, dv, 'a demo visitor, member A''s receipt', f_a1, 0),
        (1, ma, 'member A, their own file on no claim', f_a2, 1),
        (1, admin_id, 'the admin, member A''s file on no claim', f_a2, 0),
        (1, mb, 'member B, their own file on no claim', f_b, 1),
        (1, admin_id, 'the admin, member B''s file on no claim', f_b, 0),
        (1, ma, 'member A, member B''s file on no claim', f_b, 0),
        (1, dv, 'a demo visitor, a file planted on a demo claim they can read', f_b, 0),
        (1, outsider, 'another workspace, a file planted on a demo claim', f_b, 0),
        -- 2: member A's first file moved from a cancelled claim to a new one
        (2, admin_id, 'the admin, the receipt on member A''s new claim', f_a3, 1),
        -- 5: every claim is cancelled, so no file is anyone's receipt
        (5, mb, 'member B, the file once on their cancelled claim', f_admin, 0),
        (5, admin_id, 'the admin, their own upload after the cancel', f_admin, 1),
        (5, admin_id, 'the admin, the file once on member A''s cancelled claim', f_a1, 0),
        (5, ma, 'member A, their own upload after the cancel', f_a1, 1),
        -- 6: sessions that owe a second factor read nothing, even their own
        (6, ma, 'member A without the second factor, their own upload', f_a1, 0),
        (6, admin_id, 'the admin without the second factor, their own upload', f_admin, 0),
        (6, mb, 'member B, who owes nothing, their own upload', f_b, 1)
      ) as c(s, who, label, f, seen)
      where c.s = stage
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', who is not distinct from guest)::text, true);
      set local role authenticated;
      select count(*) into n from storage.objects o where o.bucket_id = 'hr-receipts' and o.name = f;
      reset role;
      if n <> seen then fails := array_append(fails, format('reading a receipt (%s): saw %s, expected %s', label, n, seen)); end if;
    end loop;

    -- ---- who may have which file thrown away, at this point ----------------
    -- True only for a file in the caller's own folder that no claim, in any
    -- workspace, carries.
    for who, label, f, ok in
      select c.who, c.label, c.f, c.ok from (values
        (1, ma, 'member A, own file on no claim', f_a4, true),
        (1, ma, 'member A, the same file a second time', f_a4, true),
        (1, ma, 'member A, the receipt on their own claim', f_a1, false),
        (1, ma, 'member A, the receipt on their claim in the other workspace', f_a5, false),
        (1, outsider, 'the other workspace''s owner, the receipt on member A''s claim there', f_a5, false),
        (1, mb, 'member B, member A''s file on no claim', f_a2, false),
        (1, admin_id, 'the admin, member A''s file on no claim', f_a2, false),
        (1, mb, 'member B, the receipt on their claim, which is in the admin''s folder', f_admin, false),
        (1, admin_id, 'the admin, their own file on the claim they entered for member B', f_admin, false),
        (1, mb, 'member B, own file while it sits on a claim in a workspace they do not belong to', f_b, false),
        (1, ma, 'member A, member B''s file', f_b, false),
        (1, ma, 'member A, no path at all', null, false),
        (1, ma, 'member A, their own folder with a slash in front', '/' || f_a2, false),
        -- Only a path shaped like a receipt: <user id>/<uuid>.<known extension>, lower case.
        (1, ma, 'member A, an over-long path in their own folder', ma || '/' || repeat('a', 2000) || '.jpg', false),
        (1, ma, 'member A, a path with a third segment', ma || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.jpg', false),
        (1, ma, 'member A, an unknown extension', ma || '/' || gen_random_uuid() || '.gif', false),
        (1, ma, 'member A, no extension', ma || '/' || gen_random_uuid(), false),
        (1, ma, 'member A, upper-case hex in the file name', ma || '/' || upper(gen_random_uuid()::text) || '.jpg', false),
        (1, ma, 'member A, an upper-case extension', ma || '/' || gen_random_uuid() || '.JPG', false),
        (1, ma, 'member A, a receipt path with something after it', f_a2 || E'\n', false),
        (1, ma, 'member A, their own folder and nothing else', ma::text, false),
        -- Only a file that was really uploaded.
        (1, ma, 'member A, a well-shaped path in their own folder with no file behind it', ma || '/' || gen_random_uuid() || '.jpg', false),
        (1, guest, 'an anonymous account, a well-shaped path in its own folder (it cannot upload)', guest || '/' || gen_random_uuid() || '.jpg', false),
        (1, ma, 'member A, a file in their own folder but in another bucket', f_chat, false),
        (1, null, 'a session with no user, member A''s file on no claim', f_a2, false),
        -- 5: the file once planted on a demo claim is on nothing now
        (5, mb, 'member B, own file once it is on no claim', f_b, true),
        -- 6: a session that owes a second factor
        (6, ma, 'member A without the second factor, own file on no claim', f_a2, false)
      ) as c(s, who, label, f, ok)
      where c.s = stage
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        got := public.hr_release_receipt(f);
        if got is distinct from ok then
          fails := array_append(fails, format('releasing a file (%s): got %s, expected %s', label, got, ok));
        end if;
      exception when others then
        fails := array_append(fails, format('releasing a file (%s): raised %s', label, sqlerrm));
      end;
      reset role;
    end loop;
    if stage = 1 then
      -- Only the one file that was let go is recorded; a refusal records nothing.
      select count(*), count(*) filter (where x.path = f_a4) into n, n2
      from private.hr_released_receipts x where x.path in (f_a1, f_a2, f_a4, f_a5, f_b, f_admin, f_admin2, '/' || f_a2);
      if n <> 1 or n2 <> 1 then fails := array_append(fails, format('%s paths recorded as released after stage 1, expected only member A''s unused file', n)); end if;
      -- And nothing that is not shaped like a receipt was recorded under member A's id.
      select count(*) into n from private.hr_released_receipts x where split_part(x.path, '/', 1) = ma::text or x.path like '%' || ma || '%';
      if n <> 1 then fails := array_append(fails, format('%s paths under member A''s id recorded as released, expected 1', n)); end if;

      -- Nobody reads or writes the released list directly.
      for t, q in
        select x.t, x.q from (values
          ('authenticated', 'select count(*) from private.hr_released_receipts'),
          ('authenticated', format('insert into private.hr_released_receipts (path) values (%L)', f_admin)),
          ('authenticated', 'delete from private.hr_released_receipts'),
          ('authenticated', 'update private.hr_released_receipts set path = path || ''x'''),
          ('anon', 'select count(*) from private.hr_released_receipts'),
          ('anon', format('insert into private.hr_released_receipts (path) values (%L)', f_admin)),
          ('anon', 'delete from private.hr_released_receipts')
        ) as x(t, q)
      loop
        perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', t, 'aal', 'aal1')::text, true);
        execute format('set local role %I', t);
        begin
          execute q;
          fails := array_append(fails, format('%s touched the released list directly: %s', t, split_part(q, ' ', 1)));
        exception
          when insufficient_privilege then null;
          when others then
            fails := array_append(fails, format('%s touching the released list was refused for another reason: %s', t, sqlerrm));
        end;
        reset role;
      end loop;
    end if;

    if stage = 1 then
      update public.hr_claims set receipt_path = null where id = demo_claim;

      -- The chat bucket holds a file named like the admin's receipt. Member B
      -- reads the receipt through their claim, and must not read this one.
      perform set_config('request.jwt.claims', json_build_object('sub', mb, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      select count(*) into n from storage.objects o where o.name = f_admin;
      reset role;
      if n <> 1 then fails := array_append(fails, format('member B sees %s files named like the receipt on their claim, expected only the one in the receipts bucket', n)); end if;

      -- Nobody changes or removes a file, not even its uploader.
      perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        update storage.objects set name = ma || '/renamed.jpg' where bucket_id = 'hr-receipts' and name = f_a2;
        get diagnostics n = row_count;
        if n <> 0 then fails := array_append(fails, 'member A renamed their own receipt file'); end if;
      exception when others then null;  -- refused outright is as good
      end;
      begin
        delete from storage.objects where bucket_id = 'hr-receipts' and name = f_a2;
        get diagnostics n = row_count;
        if n <> 0 then fails := array_append(fails, 'member A deleted their own receipt file'); end if;
      exception when others then null;
      end;
      reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      begin
        delete from storage.objects where bucket_id = 'hr-receipts' and name = f_a1;
        get diagnostics n = row_count;
        if n <> 0 then fails := array_append(fails, 'the admin deleted the receipt on member A''s claim'); end if;
      exception when others then null;
      end;
      reset role;
    elsif stage = 5 then
      -- Every column the real auth.mfa_factors requires (none has a default).
      insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), ma, 'totp', 'verified', now(), now()),
             (gen_random_uuid(), admin_id, 'totp', 'verified', now(), now());
    end if;
  end loop;

  -- A session that owes a second factor cannot upload either.
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('hr-receipts', ma || '/' || gen_random_uuid() || '.jpg', ma);
    fails := array_append(fails, 'member A uploaded a receipt without the second factor');
  exception
    when insufficient_privilege then null;
    when others then fails := array_append(fails, 'uploading without the second factor stopped for another reason: ' || sqlerrm);
  end;
  reset role;

  -- With the code entered (aal2) the same member is let through again.
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  begin
    perform public.hr_submit_claim(ea, 'travel', 1200, today, null, f_a2);
    perform public.hr_submit_overtime(ea, date '2024-03-05', 1, null);
    perform public.hr_cancel_claim(ca4);
    insert into storage.objects (bucket_id, name, owner) values ('hr-receipts', ma || '/' || gen_random_uuid() || '.jpg', ma);
    select count(*) into n from storage.objects o where o.bucket_id = 'hr-receipts' and o.name = f_a2;
    if n <> 1 then fails := array_append(fails, 'member A with the second factor entered cannot read their own receipt'); end if;
  exception when others then
    fails := array_append(fails, 'member A with the second factor entered was refused: ' || sqlerrm);
  end;
  reset role;
  delete from auth.mfa_factors where user_id in (ma, admin_id);

  -- ---- a released file that is gone can be released again ----------------
  -- The app may retry a delete that failed, or one whose answer was lost: a
  -- path already released answers true whether or not the file is still there.
  -- Real storage may refuse a direct delete; then the same state is made
  -- another way, by listing as released a path that has no file.
  f_gone := f_a4;
  begin
    delete from storage.objects o where o.bucket_id = 'hr-receipts' and o.name = f_a4;
  exception when others then
    f_gone := ma || '/' || gen_random_uuid() || '.jpg';
    insert into private.hr_released_receipts (path) values (f_gone);
  end;
  select count(*) into n from storage.objects o where o.bucket_id = 'hr-receipts' and o.name = f_gone;
  select count(*) into n2 from private.hr_released_receipts x where x.path = f_gone;
  if n <> 0 or n2 <> 1 then fails := array_append(fails, 'could not set up a released path whose file is gone'); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  got := public.hr_release_receipt(f_gone);
  reset role;
  if got is distinct from true then fails := array_append(fails, 'a released file that is gone could not be released again'); end if;
  -- Someone else still cannot, and it still cannot go on a claim.
  perform set_config('request.jwt.claims', json_build_object('sub', mb, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  got := public.hr_release_receipt(f_gone);
  reset role;
  if got is distinct from false then fails := array_append(fails, 'member B released member A''s released file'); end if;

  -- ---- no direct writes, for a member or the admin ----------------------
  for who, label in select * from (values (ma, 'a member'), (admin_id, 'the admin')) as w(who, label) loop
    for t, q in
      select x.t, x.q from (values
        ('hr_claims', format('insert into public.hr_claims (org_id, employee_id, category, amount_cents, claim_date) values (%L, %L, ''travel'', 100, %L)', org, ea, today)),
        ('hr_claims', format('update public.hr_claims set status = ''approved'' where employee_id = %L', ea)),
        ('hr_claims', format('update public.hr_claims set receipt_path = %L where employee_id = %L', f_b, ea)),
        ('hr_claims', format('delete from public.hr_claims where employee_id = %L', ea)),
        ('hr_overtime_records', format('insert into public.hr_overtime_records (org_id, employee_id, work_date, hours) values (%L, %L, ''2024-03-05'', 1)', org, ea)),
        ('hr_overtime_records', format('update public.hr_overtime_records set status = ''approved'' where employee_id = %L', ea)),
        ('hr_overtime_records', format('update public.hr_overtime_records set amount_cents = 99999999 where employee_id = %L', ea)),
        ('hr_overtime_records', format('delete from public.hr_overtime_records where employee_id = %L', ea))
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
  select (select count(*) from public.hr_claims where org_id = org and employee_id <> eb)
       + (select count(*) from public.hr_overtime_records where org_id = org and employee_id <> eb) into n;
  select (select count(*) from public.hr_claims where org_id = org and employee_id = eb)
       + (select count(*) from public.hr_overtime_records where org_id = org and employee_id = eb) into n2;
  reset role;
  -- Member B's own: 5 claims (two submitted, three entered by the admin) and 4 overtime records.
  if n <> 0 or n2 <> 9 then
    fails := array_append(fails, format('member B reads %s of a colleague''s claims and overtime and %s of their own 9', n, n2));
  end if;

  -- ---- the demo -----------------------------------------------------------
  select count(*) into n from public.hr_claims where org_id = demo
    and (requested_by is not null or receipt_path is not null or status = 'paid');
  select count(*) into n2 from public.hr_overtime_records where org_id = demo and (requested_by is not null or status = 'cancelled');
  if n <> 0 or n2 <> 0 then fails := array_append(fails, 'something was changed in the demo workspace'); end if;
  perform private.reseed_demo_people();
  select count(*), count(*) filter (where status = 'pending') into n, n2 from public.hr_claims where org_id = demo;
  if n <> 12 or n2 <> 2 then
    fails := array_append(fails, format('the demo has %s claims (%s pending) after a reseed, expected 12 (2)', n, n2));
  end if;
  select count(*), count(*) filter (where status = 'pending') into n, n2 from public.hr_overtime_records where org_id = demo;
  if n <> 12 or n2 <> 1 then
    fails := array_append(fails, format('the demo has %s overtime records (%s pending) after a reseed, expected 12 (1)', n, n2));
  end if;
  select count(*) into n from public.hr_claims where org_id = demo and has_receipt;
  if n <> 10 then fails := array_append(fails, format('%s demo claims are ticked as having a receipt after a reseed, expected 10', n)); end if;
  select (select count(*) from public.hr_claims where org_id = demo
            and (requested_by is not null or decision_note is not null or receipt_path is not null
                 or paid_on is not null or paid_reference is not null or paid_by is not null))
       + (select count(*) from public.hr_overtime_records where org_id = demo
            and (requested_by is not null or decision_note is not null or reason is not null
                 or hourly_rate_cents is not null or day_kind is not null)) into n;
  if n <> 0 then fails := array_append(fails, 'the demo reseed set one of the new columns'); end if;

  -- ---- a workspace with claims and overtime in it can still be deleted ----
  select (select count(*) from public.hr_claims where org_id = org) + (select count(*) from public.hr_overtime_records where org_id = org) into n;
  if n < 10 then fails := array_append(fails, 'the workspace had too few claims and overtime records left to prove deleting it'); end if;
  begin
    delete from public.orgs where id = org;
  exception when others then
    fails := array_append(fails, 'deleting a workspace with claims and overtime in it failed: ' || sqlerrm);
  end;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := array_append(fails, format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1)));
  end;

  raise exception 'PEOPLE_CLAIMS_OVERTIME_CHECK %', case
    when cardinality(fails) = 0 then 'PASSED (everything rolled back)'
    else format('FAILED (%s): %s', cardinality(fails), array_to_string(fails[1:15], '; '))
  end;
end $$;
