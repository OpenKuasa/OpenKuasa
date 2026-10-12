-- Lekiu payroll access check. Leaves nothing behind: the block always ends
-- with RAISE, so every row below is rolled back, and so are the four helper
-- functions it makes for itself in the session's temporary schema. Read the
-- message:
--   PEOPLE_PAYROLL_CHECK PASSED ...   or   PEOPLE_PAYROLL_CHECK FAILED (n): <what went wrong>
--
-- When not to run it. It rebuilds the demo HR rows inside its transaction and
-- holds them until the rollback, and the scheduled demo reseed commits the
-- same rows at minute 1 of every hour. So:
--   * do not start it in minutes :00 to :02 of an hour, and do not start it so
--     late that it could still be running at the next :01 (it takes seconds;
--     leave it a few minutes);
--   * do not run it at the same time as another people check
--     (people_rls_check, people_leave_check, people_claims_overtime_check,
--     people_attendance_check): each of them rebuilds the demo too;
--   * do not run it while a migration is being applied.
-- Nothing else in it depends on the time: it gives the same answer on any day
-- of the week and any day of the month.
--   * Every payroll month it works out is a fixed month of 2025, with the
--     work week, the public holiday, the leave and the overtime of that month
--     planted here, so no figure depends on today.
--   * "Today" is read in two places only: the month after this one must be
--     refused as not started, and this month must be accepted.
--
-- How it works: pay_try runs one statement as one person (their id in
-- request.jwt.claims, the role `authenticated`) and hands back what the
-- function returned, or {"refused": "<the message>"}. pay_expect compares that
-- with the refusal expected (null when the call must succeed) and returns
-- what went wrong, if anything. pay_slip and pay_lines read a payslip and its
-- lines as the database owner, as one line of text each, so a whole payslip
-- is compared to the cent in one go.
do $$
declare
  org uuid := gen_random_uuid();          -- who may do what; lines; overtime; paying; reading
  corg uuid := gen_random_uuid();         -- the calculation, with fixed inputs
  other_org uuid := gen_random_uuid();    -- another workspace: months with nobody to pay
  first_org uuid := gen_random_uuid();    -- a workspace whose first run is this month
  demo uuid;
  owner_id uuid := gen_random_uuid();     -- owner of org and of corg
  admin_id uuid := gen_random_uuid();     -- admin of org
  mfa_admin uuid := gen_random_uuid();    -- admin of org with a verified authenticator
  ma uuid := gen_random_uuid();           -- member linked to employee A
  mb uuid := gen_random_uuid();           -- member linked to employee B
  mv uuid := gen_random_uuid();           -- workspace role 'viewer', linked to employee V
  outsider uuid := gen_random_uuid();     -- owner of other_org
  dv uuid := gen_random_uuid();           -- demo visitor (viewer)
  da uuid := gen_random_uuid();           -- an admin planted in the demo
  -- org
  ea uuid; eb uuid; ev uuid; en uuid; ex uuid; cal uuid;
  pa uuid; pb uuid; pv uuid; px uuid;
  run_id uuid; feb_run uuid;
  line_id uuid; line2 uuid; ot_line uuid; b_line uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid;
  jan date := date '2025-01-01';
  feb date := date '2025-02-01';
  -- corg
  b1 uuid; ej uuid; u2 uuid; uh uuid; us uuid; jc uuid; ot uuid; hi uuid; lo uuid;
  inact uuid; fj uuid; ns1 uuid; ns2 uuid; ns0 uuid; late uuid;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid;
  mar date := date '2025-03-01';
  apr date := date '2025-04-01';
  mar_run uuid; apr_run uuid;
  -- other_org
  ep uuid; eq uuid; ef uuid; other_run uuid; june_run uuid;
  -- the demo
  demo_draft uuid := md5('rimba-run-0')::uuid;
  demo_paid uuid := md5('rimba-run-1')::uuid;
  demo_slip uuid; demo_line uuid; demo_paid_slip uuid;
  -- today, for the two places that need it
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  this_month date := date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date)::date;
  next_month date := (date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')::date) + interval '1 month')::date;
  who uuid;
  label text;
  q text;
  want text;
  r jsonb;
  n int;
  n2 int;
  n3 int;
  t text;
  sig text;
  snap text;
  rec record;
  ctx text;
  fails text[] := '{}';
  slip_keys text[] := array['basic_cents','eis_cents','employee_id','epf_cents','gross_cents','id','net_cents',
    'other_deductions_cents','pcb_cents','period_month','set_by_hr','socso_cents','status'];
  functions text[] := array[
    'public.hr_run_payroll(uuid,date)',
    'public.hr_recalculate_payroll(uuid)',
    'public.hr_save_payslip_line(uuid,uuid,text,text,bigint)',
    'public.hr_delete_payslip_line(uuid)',
    'public.hr_set_statutory(uuid,text,bigint)',
    'public.hr_remove_payslip(uuid)',
    'public.hr_delete_payroll_run(uuid)',
    'public.hr_mark_payroll_paid(uuid)',
    'public.hr_unmark_payroll_paid(uuid)',
    'public.hr_cancel_overtime(uuid)',
    'public.hr_decide_overtime(uuid,boolean,text)'];
  pay_tables text[] := array['hr_payroll_runs','hr_payslips','hr_payslip_lines'];
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
  -- One of each name: no second function that takes other arguments.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('hr_run_payroll','hr_recalculate_payroll','hr_save_payslip_line','hr_delete_payslip_line',
      'hr_set_statutory','hr_remove_payslip','hr_delete_payroll_run','hr_mark_payroll_paid','hr_unmark_payroll_paid');
  if n <> 9 then fails := array_append(fails, format('%s functions carry the nine payroll names, expected 9', n)); end if;
  -- No hr_ helper in the private schema can be called directly, and the payroll ones exist.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'private' and (p.proname like 'hr\_payroll\_%' or p.proname in ('hr_payslip_json', 'hr_employee_delete_guard'));
  if n <> 13 then fails := array_append(fails, format('%s private payroll helpers exist, expected 13', n)); end if;
  for rec in
    select p.oid::regprocedure::text as sig from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'private' and (p.proname like 'hr\_%' or p.proname = 'reseed_demo_people')
  loop
    if has_function_privilege('authenticated', rec.sig, 'execute') or has_function_privilege('anon', rec.sig, 'execute')
       or has_function_privilege('public', rec.sig, 'execute') then
      fails := array_append(fails, format('%s can be called directly', rec.sig));
    end if;
  end loop;
  foreach t in array pay_tables loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE') then
      fails := array_append(fails, format('%s has a write grant, or is open to signed-out visitors', t));
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      fails := array_append(fails, format('signed-in users cannot read %s at all', t));
    end if;
    select count(*) into n from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname not in (t || '_select', 'mfa_required');
    select count(*) into n2 from pg_policies p
    where p.schemaname = 'public' and p.tablename = t
      and ((p.policyname = t || '_select' and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE')
        or (p.policyname = 'mfa_required' and p.cmd = 'ALL' and p.permissive = 'RESTRICTIVE' and p.qual like '%mfa_ok()%'));
    if n <> 0 or n2 <> 2 then fails := array_append(fails, format('%s does not have exactly its read policy and the second-factor one', t)); end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      fails := array_append(fails, format('%s does not have row level security on', t));
    end if;
  end loop;
  select count(*) into n from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'hr_letters' and p.policyname = 'mfa_required' and p.permissive = 'RESTRICTIVE';
  if n <> 1 then fails := array_append(fails, 'hr_letters lost its second-factor policy'); end if;
  -- The statutory rules: readable, never writable, and the three rows of the spec.
  if has_table_privilege('authenticated', 'public.hr_statutory_rules', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_any_column_privilege('authenticated', 'public.hr_statutory_rules', 'INSERT, UPDATE')
     or has_table_privilege('anon', 'public.hr_statutory_rules', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or not has_table_privilege('authenticated', 'public.hr_statutory_rules', 'SELECT') then
    fails := array_append(fails, 'hr_statutory_rules is not read-only for signed-in users and closed to everyone else');
  end if;
  select string_agg(format('%s %s %s', s.scheme, s.rate, coalesce(s.max_cents::text, 'none')), '; ' order by s.scheme) into t
  from public.hr_statutory_rules s;
  if t is distinct from 'eis 0.00200 1190; epf 0.11000 none; socso 0.00500 2975' then
    fails := array_append(fails, format('the statutory rules are: %s', t));
  end if;
  -- The columns of the spec.
  select count(*) into n from information_schema.columns c
  where c.table_schema = 'public' and c.is_nullable = 'NO' and (
       (c.table_name = 'hr_payslips' and c.column_name = 'basic_cents' and c.data_type = 'bigint' and c.column_default = '0')
    or (c.table_name = 'hr_payslips' and c.column_name = 'other_deductions_cents' and c.data_type = 'bigint' and c.column_default = '0')
    or (c.table_name = 'hr_payslips' and c.column_name = 'set_by_hr' and c.data_type = 'ARRAY' and c.column_default like '%{}%'));
  if n <> 3 then fails := array_append(fails, format('%s of the 3 new payslip columns exist, required, with their defaults', n)); end if;
  select count(*) into n from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'hr_payslips' and c.column_name = 'net_cents' and c.is_generated = 'ALWAYS'
    and replace(replace(c.generation_expression, '(', ''), ')', '')
      = 'gross_cents - epf_cents - socso_cents - eis_cents - pcb_cents - other_deductions_cents';
  if n <> 1 then fails := array_append(fails, 'net pay is not generated as gross less the four figures and the other deductions'); end if;
  select count(*) into n from pg_constraint con
  where con.contype = 'f' and con.confrelid = 'auth.users'::regclass and con.confdeltype = 'n'
    and con.conrelid = 'public.hr_payroll_runs'::regclass;
  if n <> 2 then fails := array_append(fails, 'who made a run and who paid it are not links to a user that empty when the user goes'); end if;
  select count(*) into n from pg_constraint con
  where con.contype = 'f' and con.conrelid = 'public.hr_overtime_records'::regclass
    and con.confrelid = 'public.hr_payslips'::regclass and con.confdeltype = 'n';
  if n <> 1 then fails := array_append(fails, 'an overtime record''s payslip is not a link that empties when the payslip goes'); end if;
  select count(*) into n from pg_constraint con
  where con.contype = 'f' and con.conrelid = 'public.hr_payslip_lines'::regclass and con.confdeltype = 'c'
    and con.confrelid in ('public.hr_payslips'::regclass, 'public.hr_overtime_records'::regclass, 'public.orgs'::regclass);
  if n <> 3 then fails := array_append(fails, 'a payslip line does not go with its payslip, its overtime record and its workspace'); end if;
  select count(*) into n from pg_trigger tg
  where tg.tgrelid = 'public.hr_employees'::regclass and tg.tgname = 'hr_employees_paid_payslips_guard' and not tg.tgisinternal;
  if n <> 1 then fails := array_append(fails, 'the trigger that guards deleting an employee is missing'); end if;
  if cardinality(fails) > 0 then raise exception 'the functions, grants and columns are not as expected, so nothing else was tried'; end if;

  -- ---- the four helpers of this check (temporary; rolled back with the rest) --
  execute $f$
    create function pg_temp.pay_try(who uuid, q text, aal text default 'aal1') returns jsonb language plpgsql as $body$
    declare r jsonb; msg text;
    begin
      perform set_config('request.jwt.claims',
        case when who is null then json_build_object('role', 'authenticated')::text
             else json_build_object('sub', who, 'role', 'authenticated', 'aal', aal)::text end, true);
      set local role authenticated;
      begin
        execute q into r;
      exception when others then
        msg := sqlerrm;
        reset role;
        return jsonb_build_object('refused', msg);
      end;
      reset role;
      return coalesce(r, 'null'::jsonb);
    end $body$
  $f$;
  execute $f$
    create function pg_temp.pay_expect(who uuid, label text, q text, want text, aal text default 'aal1') returns text[] language plpgsql as $body$
    declare r jsonb := pg_temp.pay_try(who, q, aal);
    begin
      if jsonb_typeof(r) = 'object' and r ? 'refused' then
        if want is null then return array[format('%s: refused with %s', label, r->>'refused')]; end if;
        -- A refusal is its code and nothing else.
        if r->>'refused' <> want then return array[format('%s: expected %s, got %s', label, want, r->>'refused')]; end if;
      elsif want is not null then
        return array[format('%s: went through, expected %s', label, want)];
      end if;
      return '{}'::text[];
    end $body$
  $f$;
  execute $f$
    create function pg_temp.pay_slip(p_slip uuid) returns text language sql as $body$
      select format('basic %s gross %s epf %s socso %s eis %s pcb %s other %s net %s set [%s] %s',
        p.basic_cents, p.gross_cents, p.epf_cents, p.socso_cents, p.eis_cents, p.pcb_cents,
        p.other_deductions_cents, p.net_cents, array_to_string(p.set_by_hr, ','), p.status)
      from public.hr_payslips p where p.id = p_slip
    $body$
  $f$;
  execute $f$
    create function pg_temp.pay_lines(p_slip uuid) returns text language sql as $body$
      select coalesce(string_agg(format('%s %s "%s" %s', l.source, l.kind, l.label, l.amount_cents), '; '
        order by array_position(array['joiner','unpaid_leave','overtime','hr'], l.source), l.created_at, l.label), 'none')
      from public.hr_payslip_lines l where l.payslip_id = p_slip
    $body$
  $f$;

  -- ---- people and workspaces ----------------------------------------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@pay-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, mfa_admin, ma, mb, mv, outsider, dv, da]) as u(id);
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), mfa_admin, 'totp', 'verified', now(), now());

  insert into public.orgs (id, name)
  values (org, 'Payroll Check Sdn Bhd'), (corg, 'Payroll Sums Sdn Bhd'), (other_org, 'Payroll Other Sdn Bhd'),
         (first_org, 'Payroll First Run Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, mfa_admin, 'admin'),
         (org, ma, 'member'), (org, mb, 'member'), (org, mv, 'viewer'),
         (corg, owner_id, 'owner'), (other_org, outsider, 'owner'), (first_org, outsider, 'owner'), (demo, dv, 'viewer'), (demo, da, 'admin');

  -- org: A, B and V are linked to a member each; N is active with no salary on file.
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'A', 'Member A', ma) returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'B', 'Member B', mb) returning id into eb;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'V', 'Viewer V', mv) returning id into ev;
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'N', 'No Salary Yet') returning id into en;
  -- Someone who has left, with no salary on file either: never paid, and never listed as skipped.
  insert into public.hr_employees (org_id, employee_no, name, status) values (org, 'Z', 'Gone Without Salary', 'inactive');
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents)
  values (ea, org, 300000), (eb, org, 450000), (ev, org, 200000);
  -- Approved overtime worked in January 2025: one record each for A and B.
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (org, ea, '2025-01-10', 2.0, 5000, 'approved') returning id into o1;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (org, eb, '2025-01-15', 3.0, 7500, 'approved') returning id into o2;
  -- Letters: A has one issued and one still a draft; B has one issued.
  insert into public.hr_letters (org_id, employee_id, letter_type, title, status, issued_on)
  values (org, ea, 'Confirmation', 'Confirmation of employment', 'issued', '2025-01-05'),
         (org, ea, 'Warning', 'Not sent yet', 'draft', null),
         (org, eb, 'Confirmation', 'Confirmation of employment', 'issued', '2025-01-05');

  -- other_org: P is active with no salary; Q has a salary but is inactive.
  insert into public.hr_employees (org_id, employee_no, name) values (other_org, 'P', 'Nothing On File') returning id into ep;
  insert into public.hr_employees (org_id, employee_no, name, status) values (other_org, 'Q', 'Left Already', 'inactive') returning id into eq;
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (ep, other_org, null), (eq, other_org, 300000);
  -- first_org: one employee with a salary.
  insert into public.hr_employees (org_id, employee_no, name) values (first_org, 'F', 'First Run') returning id into ef;
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (ef, first_org, 100000);

  -- The demo: a draft run for this month and paid runs before it, from the reseed.
  perform private.reseed_demo_people();
  select p.id into demo_slip from public.hr_payslips p
  where p.payroll_run_id = demo_draft and p.employee_id = md5('rimba-emp-12')::uuid;
  select l.id into demo_line from public.hr_payslip_lines l where l.payslip_id = demo_slip and l.source = 'hr';
  select p.id into demo_paid_slip from public.hr_payslips p
  where p.payroll_run_id = demo_paid and p.employee_id = md5('rimba-emp-1')::uuid;
  if demo_slip is null or demo_line is null or demo_paid_slip is null then
    raise exception 'the demo has no draft payslip with an HR line, or no paid payslip, to try the functions on';
  end if;

  -- ==== 1. who may do what ====================================================
  -- The owner, then the admin, each take one month through all nine functions.
  -- While the owner's draft exists, everyone else tries every function on it.
  foreach who in array array[owner_id, admin_id] loop
    t := case when who = owner_id then 'the owner' else 'the admin' end;
    r := pg_temp.pay_try(who, format('select public.hr_run_payroll(%L, %L)', org, jan));
    if r ? 'refused' then raise exception '% could not run payroll: %', t, r->>'refused'; end if;
    run_id := (r #>> '{run,id}')::uuid;
    if r -> 'run' is distinct from jsonb_build_object('id', run_id, 'period_month', '2025-01-01', 'status', 'draft')
       or r -> 'payslips' is distinct from '3'::jsonb or r -> 'earlier_overtime' is distinct from '0'::jsonb
       or r -> 'skipped' is distinct from jsonb_build_array(jsonb_build_object('employee_id', en, 'name', 'No Salary Yet', 'reason', 'no_salary'))
       or (select array_agg(k order by k) from jsonb_object_keys(r) k) <> array['earlier_overtime','payslips','run','skipped'] then
      fails := array_append(fails, format('%s ran payroll and was handed back: %s', t, r));
    end if;
    select count(*) into n from public.hr_payroll_runs x
    where x.id = run_id and x.org_id = org and x.status = 'draft' and x.created_by = who and x.paid_at is null and x.paid_by is null;
    if n <> 1 then fails := array_append(fails, format('the run %s made is not a draft of this workspace, made by them', t)); end if;
    select p.id into pa from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = ea;
    select p.id into pb from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = eb;
    select p.id into pv from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = ev;
    select l.id into ot_line from public.hr_payslip_lines l where l.payslip_id = pa and l.source = 'overtime';

    r := pg_temp.pay_try(who, format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Commission'', 50000)', pa));
    if r ? 'refused' then raise exception '% could not add a line: %', t, r->>'refused'; end if;
    line_id := (r #>> '{line,id}')::uuid;
    if r -> 'line' is distinct from jsonb_build_object('id', line_id, 'kind', 'earning', 'source', 'hr', 'label', 'Commission', 'amount_cents', 50000)
       or (select array_agg(k order by k) from jsonb_object_keys(r -> 'payslip') k) <> slip_keys
       or r #> '{payslip,id}' is distinct from to_jsonb(pa) or r #> '{payslip,employee_id}' is distinct from to_jsonb(ea)
       or r #>> '{payslip,period_month}' <> '2025-01-01' or r #> '{payslip,gross_cents}' is distinct from '355000'::jsonb
       or r #> '{payslip,set_by_hr}' is distinct from '[]'::jsonb or r #>> '{payslip,status}' <> 'pending' then
      fails := array_append(fails, format('%s added a line and was handed back: %s', t, r));
    end if;

    if who = owner_id then
      -- Everyone who may not: a member, a viewer, the owner of another workspace,
      -- a demo visitor, and a call with no session. Nothing they try changes a row.
      select md5(string_agg(x.line, ',' order by x.line)) into snap from (
        select p::text as line from public.hr_payslips p where p.org_id = org
        union all select l::text from public.hr_payslip_lines l where l.org_id = org
        union all select x::text from public.hr_payroll_runs x where x.org_id = org
        union all select o::text from public.hr_overtime_records o where o.org_id = org
      ) x;
      for who, label in
        select * from (values (ma, 'a member'), (mv, 'a viewer'), (outsider, 'the owner of another workspace'),
          (dv, 'a demo visitor'), (mfa_admin, 'an admin who owes a second factor'), (null::uuid, 'nobody (no session)')) as c(who, label)
      loop
        want := case when who is null then 'PAYROLL_NOT_ALLOWED' else 'PAYROLL_NOT_FOUND' end;
        fails := fails
          || pg_temp.pay_expect(who, label || ' runs payroll', format('select public.hr_run_payroll(%L, %L)', org, feb), 'PAYROLL_NOT_ALLOWED')
          || pg_temp.pay_expect(who, label || ' recalculates', format('select public.hr_recalculate_payroll(%L)', run_id), want)
          || pg_temp.pay_expect(who, label || ' adds a line', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Mine'', 100)', pa), want)
          || pg_temp.pay_expect(who, label || ' changes a line', format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''Mine'', 100)', pa, line_id), want)
          || pg_temp.pay_expect(who, label || ' removes a line', format('select public.hr_delete_payslip_line(%L)', line_id), want)
          || pg_temp.pay_expect(who, label || ' sets a statutory figure', format('select public.hr_set_statutory(%L, ''epf'', 1)', pa), want)
          || pg_temp.pay_expect(who, label || ' removes a payslip', format('select public.hr_remove_payslip(%L)', pa), want)
          || pg_temp.pay_expect(who, label || ' deletes the run', format('select public.hr_delete_payroll_run(%L)', run_id), want)
          || pg_temp.pay_expect(who, label || ' marks the run as paid', format('select public.hr_mark_payroll_paid(%L)', run_id), want)
          || pg_temp.pay_expect(who, label || ' undoes paid', format('select public.hr_unmark_payroll_paid(%L)', run_id), want);
      end loop;
      who := owner_id;
      select md5(string_agg(x.line, ',' order by x.line)) into t from (
        select p::text as line from public.hr_payslips p where p.org_id = org
        union all select l::text from public.hr_payslip_lines l where l.org_id = org
        union all select x::text from public.hr_payroll_runs x where x.org_id = org
        union all select o::text from public.hr_overtime_records o where o.org_id = org
      ) x;
      if t is distinct from snap then fails := array_append(fails, 'someone who may not act changed a payroll row'); end if;
      t := 'the owner';
      -- With the second factor entered, that admin is an admin again.
      fails := fails || pg_temp.pay_expect(mfa_admin, 'an admin who entered their second factor recalculates',
        format('select public.hr_recalculate_payroll(%L)', run_id), null, 'aal2');
      -- Signed out altogether: the functions cannot even be called.
      set local role anon;
      begin
        perform public.hr_recalculate_payroll(run_id);
        fails := array_append(fails, 'a signed-out visitor called a payroll function');
      exception
        when insufficient_privilege then null;
        when others then fails := array_append(fails, 'a signed-out visitor was refused for another reason: ' || sqlerrm);
      end;
      reset role;
      -- An id that is nothing is answered as an id the caller may not use is.
      fails := fails
        || pg_temp.pay_expect(who, 'a run that does not exist', format('select public.hr_recalculate_payroll(%L)', gen_random_uuid()), 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a run that is null', 'select public.hr_mark_payroll_paid(null)', 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a payslip that does not exist', format('select public.hr_set_statutory(%L, ''epf'', 1)', gen_random_uuid()), 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a payslip that is null', 'select public.hr_remove_payslip(null)', 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a line that does not exist', format('select public.hr_delete_payslip_line(%L)', gen_random_uuid()), 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a line that is null', 'select public.hr_delete_payslip_line(null)', 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a line that does not exist, on a real payslip', format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''x'', 1)', pa, gen_random_uuid()), 'PAYROLL_NOT_FOUND')
        || pg_temp.pay_expect(who, 'a workspace that does not exist', format('select public.hr_run_payroll(%L, %L)', gen_random_uuid(), feb), 'PAYROLL_NOT_ALLOWED')
        || pg_temp.pay_expect(who, 'a workspace that is null', format('select public.hr_run_payroll(null, %L)', feb), 'PAYROLL_NOT_ALLOWED')
        || pg_temp.pay_expect(who, 'a workspace the owner is no part of', format('select public.hr_run_payroll(%L, %L)', other_org, feb), 'PAYROLL_NOT_ALLOWED');
    end if;

    r := pg_temp.pay_try(who, format('select public.hr_recalculate_payroll(%L)', run_id));
    if r is distinct from jsonb_build_object('run', jsonb_build_object('id', run_id, 'period_month', '2025-01-01', 'status', 'draft'),
         'payslips', 3, 'added', 0, 'earlier_overtime', 0,
         'skipped', jsonb_build_array(jsonb_build_object('employee_id', en, 'name', 'No Salary Yet', 'reason', 'no_salary'))) then
      fails := array_append(fails, format('%s recalculated and was handed back: %s', t, r));
    end if;
    r := pg_temp.pay_try(who, format('select public.hr_save_payslip_line(%L, %L, ''deduction'', ''Advance'', 20000)', pa, line_id));
    if r -> 'line' is distinct from jsonb_build_object('id', line_id, 'kind', 'deduction', 'source', 'hr', 'label', 'Advance', 'amount_cents', 20000) then
      fails := array_append(fails, format('%s changed a line and was handed back: %s', t, r));
    end if;
    r := pg_temp.pay_try(who, format('select public.hr_set_statutory(%L, ''pcb'', 1500)', pa));
    if r #> '{payslip,pcb_cents}' is distinct from '1500'::jsonb or r #> '{payslip,set_by_hr}' is distinct from '["pcb"]'::jsonb
       or (select array_agg(k order by k) from jsonb_object_keys(r) k) <> array['payslip'] then
      fails := array_append(fails, format('%s set a statutory figure and was handed back: %s', t, r));
    end if;
    r := pg_temp.pay_try(who, format('select public.hr_delete_payslip_line(%L)', line_id));
    if r #> '{payslip,other_deductions_cents}' is distinct from '0'::jsonb or r #> '{payslip,id}' is distinct from to_jsonb(pa)
       or (select array_agg(k order by k) from jsonb_object_keys(r) k) <> array['payslip'] then
      fails := array_append(fails, format('%s removed a line and was handed back: %s', t, r));
    end if;
    r := pg_temp.pay_try(who, format('select public.hr_remove_payslip(%L)', pv));
    if r is distinct from jsonb_build_object('run_id', run_id, 'employee_id', ev) then
      fails := array_append(fails, format('%s removed a payslip and was handed back: %s', t, r));
    end if;
    r := pg_temp.pay_try(who, format('select public.hr_mark_payroll_paid(%L)', run_id));
    if r - 'paid_at' is distinct from jsonb_build_object('id', run_id, 'period_month', '2025-01-01', 'status', 'paid')
       or (r ->> 'paid_at')::timestamptz is distinct from now() then
      fails := array_append(fails, format('%s marked the run as paid and was handed back: %s', t, r));
    end if;
    select count(*) into n from public.hr_payroll_runs x
    where x.id = run_id and x.status = 'paid' and x.paid_at = now() and x.paid_by = who and x.created_by = who;
    select count(*) filter (where p.status = 'paid'), count(*) into n2, n3 from public.hr_payslips p where p.payroll_run_id = run_id;
    if n <> 1 or n2 <> 2 or n3 <> 2 then
      fails := array_append(fails, format('after %s paid the run it is not paid by them, or its 2 payslips are not all paid', t));
    end if;
    r := pg_temp.pay_try(who, format('select public.hr_unmark_payroll_paid(%L)', run_id));
    if r is distinct from jsonb_build_object('id', run_id, 'period_month', '2025-01-01', 'status', 'draft') then
      fails := array_append(fails, format('%s undid paid and was handed back: %s', t, r));
    end if;
    select count(*) into n from public.hr_payroll_runs x
    where x.id = run_id and x.status = 'draft' and x.paid_at is null and x.paid_by is null;
    select count(*) into n2 from public.hr_payslips p where p.payroll_run_id = run_id and p.status = 'pending';
    if n <> 1 or n2 <> 2 then fails := array_append(fails, format('after %s undid paid the run is not a draft with 2 pending payslips', t)); end if;
    r := pg_temp.pay_try(who, format('select public.hr_delete_payroll_run(%L)', run_id));
    if r is distinct from jsonb_build_object('id', run_id) then
      fails := array_append(fails, format('%s deleted the draft and was handed back: %s', t, r));
    end if;
    select (select count(*) from public.hr_payroll_runs x where x.org_id = org)
         + (select count(*) from public.hr_payslips p where p.org_id = org)
         + (select count(*) from public.hr_payslip_lines l where l.org_id = org)
         + (select count(*) from public.hr_overtime_records o where o.org_id = org and o.payslip_id is not null) into n;
    if n <> 0 then fails := array_append(fails, format('deleting the draft left %s payroll rows or held overtime records behind', n)); end if;
  end loop;

  -- ---- the demo: read-only for everyone -----------------------------------------
  select md5(string_agg(x.line, ',' order by x.line)) into snap from (
    select p::text as line from public.hr_payslips p where p.org_id = demo
    union all select l::text from public.hr_payslip_lines l where l.org_id = demo
    union all select x::text from public.hr_payroll_runs x where x.org_id = demo
    union all select o::text from public.hr_overtime_records o where o.org_id = demo
  ) x;
  for who, label, want in
    select * from (values (dv, 'a demo visitor', 'PAYROLL_NOT_ALLOWED'), (da, 'an admin of the demo', 'PAYROLL_NOT_ALLOWED'),
      (owner_id, 'someone outside the demo', 'PAYROLL_NOT_FOUND')) as c(who, label, want)
  loop
    fails := fails
      || pg_temp.pay_expect(who, label || ' runs payroll in the demo', format('select public.hr_run_payroll(%L, ''2020-01-01'')', demo), 'PAYROLL_NOT_ALLOWED')
      || pg_temp.pay_expect(who, label || ' recalculates in the demo', format('select public.hr_recalculate_payroll(%L)', demo_draft), want)
      || pg_temp.pay_expect(who, label || ' adds a line in the demo', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Mine'', 100)', demo_slip), want)
      || pg_temp.pay_expect(who, label || ' changes a line in the demo', format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''Mine'', 100)', demo_slip, demo_line), want)
      || pg_temp.pay_expect(who, label || ' removes a line in the demo', format('select public.hr_delete_payslip_line(%L)', demo_line), want)
      || pg_temp.pay_expect(who, label || ' sets a statutory figure in the demo', format('select public.hr_set_statutory(%L, ''epf'', 1)', demo_slip), want)
      || pg_temp.pay_expect(who, label || ' removes a payslip in the demo', format('select public.hr_remove_payslip(%L)', demo_slip), want)
      || pg_temp.pay_expect(who, label || ' deletes the demo''s draft', format('select public.hr_delete_payroll_run(%L)', demo_draft), want)
      || pg_temp.pay_expect(who, label || ' marks the demo''s draft as paid', format('select public.hr_mark_payroll_paid(%L)', demo_draft), want)
      || pg_temp.pay_expect(who, label || ' undoes paid in the demo', format('select public.hr_unmark_payroll_paid(%L)', demo_paid), want);
  end loop;
  select md5(string_agg(x.line, ',' order by x.line)) into t from (
    select p::text as line from public.hr_payslips p where p.org_id = demo
    union all select l::text from public.hr_payslip_lines l where l.org_id = demo
    union all select x::text from public.hr_payroll_runs x where x.org_id = demo
    union all select o::text from public.hr_overtime_records o where o.org_id = demo
  ) x;
  if t is distinct from snap then fails := array_append(fails, 'a payroll row was changed in the demo workspace'); end if;

  -- ==== 2. running payroll: what is refused ====================================
  fails := fails
    || pg_temp.pay_expect(owner_id, 'a month given as its 15th', format('select public.hr_run_payroll(%L, ''2025-01-15'')', org), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a month given as its last day', format('select public.hr_run_payroll(%L, ''2025-01-31'')', org), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'no month', format('select public.hr_run_payroll(%L, null)', org), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a month before 2000', format('select public.hr_run_payroll(%L, ''1999-12-01'')', org), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'next month', format('select public.hr_run_payroll(%L, %L)', org, next_month), 'PAYROLL_MONTH_NOT_STARTED')
    || pg_temp.pay_expect(owner_id, 'a month far ahead', format('select public.hr_run_payroll(%L, ''2099-01-01'')', org), 'PAYROLL_MONTH_NOT_STARTED')
    || pg_temp.pay_expect(owner_id, 'the owner runs January', format('select public.hr_run_payroll(%L, %L)', org, jan), null)
    || pg_temp.pay_expect(admin_id, 'January a second time', format('select public.hr_run_payroll(%L, %L)', org, jan), 'PAYROLL_RUN_EXISTS')
    || pg_temp.pay_expect(admin_id, 'February while January is a draft', format('select public.hr_run_payroll(%L, %L)', org, feb), 'PAYROLL_EARLIER_DRAFT')
    || pg_temp.pay_expect(admin_id, 'this month while January is a draft', format('select public.hr_run_payroll(%L, %L)', org, this_month), 'PAYROLL_EARLIER_DRAFT')
    -- Runs are made in order of month: an earlier month cannot be filled in behind a later run.
    || pg_temp.pay_expect(admin_id, 'December 2024 while January is a draft', format('select public.hr_run_payroll(%L, ''2024-12-01'')', org), 'PAYROLL_LATER_RUN')
    || pg_temp.pay_expect(owner_id, 'a month years before the draft', format('select public.hr_run_payroll(%L, ''2001-06-01'')', org), 'PAYROLL_LATER_RUN')
    ;
  select count(*) into n from public.hr_payroll_runs x where x.org_id = org;
  if n <> 1 then fails := array_append(fails, format('the workspace has %s runs after the refusals, expected January alone', n)); end if;

  -- This month has started, so it can be run. It is this workspace's first
  -- run, so it may be any month: the runs of the other workspaces have no say.
  r := pg_temp.pay_try(outsider, format('select public.hr_run_payroll(%L, %L)', first_org, this_month));
  if r ? 'refused' or r -> 'payslips' is distinct from '1'::jsonb or r -> 'skipped' is distinct from '[]'::jsonb
     or r #>> '{run,period_month}' is distinct from this_month::text then
    fails := array_append(fails, format('a first run for this month, which has started, gave: %s', r));
  end if;
  fails := fails || pg_temp.pay_expect(outsider, 'next month, after this month''s draft', format('select public.hr_run_payroll(%L, %L)', first_org, next_month), 'PAYROLL_MONTH_NOT_STARTED');

  -- ---- a month with nobody to pay is still a month -------------------------------
  -- The only active employee has no salary; the only salary belongs to someone
  -- inactive. May 2025 is run all the same: a draft with no payslips.
  r := pg_temp.pay_try(outsider, format('select public.hr_run_payroll(%L, ''2025-05-01'')', other_org));
  other_run := (r #>> '{run,id}')::uuid;
  if other_run is null
     or r is distinct from jsonb_build_object('run', jsonb_build_object('id', other_run, 'period_month', '2025-05-01', 'status', 'draft'),
          'payslips', 0, 'earlier_overtime', 0,
          'skipped', jsonb_build_array(jsonb_build_object('employee_id', ep, 'name', 'Nothing On File', 'reason', 'no_salary'))) then
    fails := array_append(fails, format('running a month with nobody to pay gave: %s', r));
  end if;
  select count(*) into n from public.hr_payroll_runs x where x.org_id = other_org and x.status = 'draft' and x.created_by = outsider;
  select count(*) into n2 from public.hr_payslips p where p.org_id = other_org;
  if n <> 1 or n2 <> 0 then fails := array_append(fails, format('a month with nobody to pay left %s draft runs and %s payslips, expected 1 and 0', n, n2)); end if;
  -- An empty draft is a draft: it holds up the next month until it is paid.
  fails := fails || pg_temp.pay_expect(outsider, 'June while the empty May is a draft', format('select public.hr_run_payroll(%L, ''2025-06-01'')', other_org), 'PAYROLL_EARLIER_DRAFT');
  -- Recalculating it finds nobody, and says so.
  r := pg_temp.pay_try(outsider, format('select public.hr_recalculate_payroll(%L)', other_run));
  if r -> 'payslips' is distinct from '0'::jsonb or r -> 'added' is distinct from '0'::jsonb or r -> 'earlier_overtime' is distinct from '0'::jsonb
     or jsonb_array_length(r -> 'skipped') is distinct from 1 then
    fails := array_append(fails, format('recalculating an empty draft with nobody to add gave: %s', r));
  end if;
  -- It can be marked as paid: the record that nobody was paid that month.
  r := pg_temp.pay_try(outsider, format('select public.hr_mark_payroll_paid(%L)', other_run));
  select count(*) into n from public.hr_payroll_runs x
  where x.id = other_run and x.status = 'paid' and x.paid_at = now() and x.paid_by = outsider;
  if n <> 1 or r - 'paid_at' is distinct from jsonb_build_object('id', other_run, 'period_month', '2025-05-01', 'status', 'paid') then
    fails := array_append(fails, format('marking an empty run as paid gave: %s', r));
  end if;
  -- It is the workspace's latest run like any other: July would skip June.
  fails := fails || pg_temp.pay_expect(outsider, 'July after the empty May was paid', format('select public.hr_run_payroll(%L, ''2025-07-01'')', other_org), 'PAYROLL_SKIPS_MONTH');
  -- And then the next month runs, empty again.
  r := pg_temp.pay_try(outsider, format('select public.hr_run_payroll(%L, ''2025-06-01'')', other_org));
  june_run := (r #>> '{run,id}')::uuid;
  if june_run is null or r -> 'payslips' is distinct from '0'::jsonb then
    fails := array_append(fails, format('the month after an empty paid month gave: %s', r));
  end if;
  -- Undoing paid works on an empty run as on any other: not while a later run exists, then yes.
  fails := fails
    || pg_temp.pay_expect(outsider, 'paid is undone on the empty May while June exists', format('select public.hr_unmark_payroll_paid(%L)', other_run), 'PAYROLL_LATER_RUN')
    || pg_temp.pay_expect(outsider, 'the empty June draft is deleted', format('select public.hr_delete_payroll_run(%L)', june_run), null);
  r := pg_temp.pay_try(outsider, format('select public.hr_unmark_payroll_paid(%L)', other_run));
  select count(*) into n from public.hr_payroll_runs x
  where x.id = other_run and x.status = 'draft' and x.paid_at is null and x.paid_by is null;
  if n <> 1 or r is distinct from jsonb_build_object('id', other_run, 'period_month', '2025-05-01', 'status', 'draft') then
    fails := array_append(fails, format('undoing paid on an empty run gave: %s', r));
  end if;
  -- A salary is put on file. Recalculating the empty draft gives that employee a payslip.
  update public.hr_employee_private set base_salary_cents = 100000 where employee_id = ep;
  r := pg_temp.pay_try(outsider, format('select public.hr_recalculate_payroll(%L)', other_run));
  if r -> 'added' is distinct from '1'::jsonb or r -> 'payslips' is distinct from '1'::jsonb or r -> 'skipped' is distinct from '[]'::jsonb then
    fails := array_append(fails, format('recalculating an empty draft once someone is eligible gave: %s', r));
  end if;
  -- An inactive employee with a salary gets no payslip and is not listed as skipped.
  select count(*) into n from public.hr_payslips p where p.employee_id = eq;
  if n <> 0 then fails := array_append(fails, 'an inactive employee got a payslip'); end if;
  -- Removing its only payslip leaves the draft there, empty; it can still be paid, and June then runs.
  select p.id into t from public.hr_payslips p where p.payroll_run_id = other_run;
  r := pg_temp.pay_try(outsider, format('select public.hr_remove_payslip(%L)', t));
  select count(*) into n from public.hr_payroll_runs x where x.id = other_run and x.status = 'draft';
  select count(*) into n2 from public.hr_payslips p where p.payroll_run_id = other_run;
  if r is distinct from jsonb_build_object('run_id', other_run, 'employee_id', ep) or n <> 1 or n2 <> 0 then
    fails := array_append(fails, format('removing the last payslip of a draft did not leave an empty draft: %s', r));
  end if;
  fails := fails
    || pg_temp.pay_expect(outsider, 'a draft emptied by removing its payslips is marked as paid', format('select public.hr_mark_payroll_paid(%L)', other_run), null);
  r := pg_temp.pay_try(outsider, format('select public.hr_run_payroll(%L, ''2025-06-01'')', other_org));
  if r -> 'payslips' is distinct from '1'::jsonb or r -> 'earlier_overtime' is distinct from '0'::jsonb then
    fails := array_append(fails, format('the month after an emptied, paid month gave: %s', r));
  end if;
  select count(*) filter (where x.status = 'paid'), count(*) into n, n2 from public.hr_payroll_runs x where x.org_id = other_org;
  if n <> 1 or n2 <> 2 then fails := array_append(fails, format('the workspace has %s paid of %s runs, expected the empty May paid and June a draft', n, n2)); end if;

  -- ==== 3. lines ================================================================
  select x.id into run_id from public.hr_payroll_runs x where x.org_id = org and x.period_month = jan;
  select p.id into pa from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = ea;
  select p.id into pb from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = eb;
  select p.id into pv from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = ev;
  select l.id into ot_line from public.hr_payslip_lines l where l.payslip_id = pa and l.source = 'overtime';
  -- A starts from basic and the one overtime record.
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 305000 epf 33550 socso 1525 eis 610 pcb 0 other 0 net 269315 set [] pending' then
    fails := array_append(fails, 'A in January: ' || coalesce(pg_temp.pay_slip(pa), 'no payslip'));
  end if;
  -- An earning raises gross, and the proposals follow it.
  r := pg_temp.pay_try(owner_id, format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Commission'', 50000)', pa));
  line_id := (r #>> '{line,id}')::uuid;
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 355000 epf 39050 socso 1775 eis 710 pcb 0 other 0 net 313465 set [] pending' then
    fails := array_append(fails, 'A after an earning of 500.00: ' || pg_temp.pay_slip(pa));
  end if;
  -- A deduction changes net only. Its name is trimmed.
  r := pg_temp.pay_try(admin_id, format('select public.hr_save_payslip_line(%L, null, ''deduction'', ''  Advance  '', 20000)', pa));
  line2 := (r #>> '{line,id}')::uuid;
  if r #>> '{line,label}' is distinct from 'Advance'
     or pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 355000 epf 39050 socso 1775 eis 710 pcb 0 other 20000 net 293465 set [] pending' then
    fails := array_append(fails, format('A after a deduction of 200.00: %s (%s)', pg_temp.pay_slip(pa), r -> 'line'));
  end if;
  -- Changing a line: its name and amount, and the totals follow.
  fails := fails || pg_temp.pay_expect(owner_id, 'the deduction is changed',
    format('select public.hr_save_payslip_line(%L, %L, ''deduction'', ''Salary advance'', 25000)', pa, line2), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 355000 epf 39050 socso 1775 eis 710 pcb 0 other 25000 net 288465 set [] pending'
     or pg_temp.pay_lines(pa) is distinct from 'overtime earning "Overtime, 10 Jan 2025, 2 h" 5000; hr earning "Commission" 50000; hr deduction "Salary advance" 25000' then
    fails := array_append(fails, format('A after the deduction became 250.00: %s / %s', pg_temp.pay_slip(pa), pg_temp.pay_lines(pa)));
  end if;
  -- A line can change its kind: the same line as an earning, and back.
  fails := fails || pg_temp.pay_expect(owner_id, 'the deduction becomes an earning',
    format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''Salary advance'', 25000)', pa, line2), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 380000 epf 41800 socso 1900 eis 760 pcb 0 other 0 net 335540 set [] pending' then
    fails := array_append(fails, 'A with the deduction turned into an earning: ' || pg_temp.pay_slip(pa));
  end if;
  fails := fails || pg_temp.pay_expect(owner_id, 'the earning becomes a deduction again',
    format('select public.hr_save_payslip_line(%L, %L, ''deduction'', ''Salary advance'', 25000)', pa, line2), null);
  -- B's payslip, for a line that belongs to another payslip.
  r := pg_temp.pay_try(owner_id, format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Allowance'', 1000)', pb));
  b_line := (r #>> '{line,id}')::uuid;
  select md5(string_agg(x.line, ',' order by x.line)) into snap from (
    select p::text as line from public.hr_payslips p where p.org_id = org
    union all select l::text from public.hr_payslip_lines l where l.org_id = org
  ) x;
  fails := fails
    || pg_temp.pay_expect(owner_id, 'a system line is changed', format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''Mine now'', 1)', pa, ot_line), 'PAYROLL_SYSTEM_LINE')
    || pg_temp.pay_expect(owner_id, 'a system line is changed, with bad input too', format('select public.hr_save_payslip_line(%L, %L, ''unpaid'', '''', 0)', pa, ot_line), 'PAYROLL_SYSTEM_LINE')
    || pg_temp.pay_expect(admin_id, 'a system line is removed', format('select public.hr_delete_payslip_line(%L)', ot_line), 'PAYROLL_SYSTEM_LINE')
    || pg_temp.pay_expect(owner_id, 'a line of another payslip is changed through this one', format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''Moved'', 1)', pa, b_line), 'PAYROLL_NOT_FOUND')
    || pg_temp.pay_expect(owner_id, 'a line of the kind unpaid', format('select public.hr_save_payslip_line(%L, null, ''unpaid'', ''Unpaid'', 100)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line of a kind that does not exist', format('select public.hr_save_payslip_line(%L, null, ''bonus'', ''Bonus'', 100)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line of no kind', format('select public.hr_save_payslip_line(%L, null, null, ''Bonus'', 100)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line with an empty name', format('select public.hr_save_payslip_line(%L, null, ''earning'', '''', 100)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line named with spaces only', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''   '', 100)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line with no name', format('select public.hr_save_payslip_line(%L, null, ''earning'', null, 100)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line with a name of 81 characters', format('select public.hr_save_payslip_line(%L, null, ''earning'', %L, 100)', pa, repeat('n', 81)), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'an existing line renamed to 81 characters', format('select public.hr_save_payslip_line(%L, %L, ''earning'', %L, 100)', pa, line_id, repeat('n', 81)), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line of zero', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Zero'', 0)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line below zero', format('select public.hr_save_payslip_line(%L, null, ''deduction'', ''Minus'', -1)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line with no amount', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''None'', null)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a line above a billion ringgit', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Huge'', 100000000001)', pa), 'PAYROLL_BAD_INPUT');
  select md5(string_agg(x.line, ',' order by x.line)) into t from (
    select p::text as line from public.hr_payslips p where p.org_id = org
    union all select l::text from public.hr_payslip_lines l where l.org_id = org
  ) x;
  if t is distinct from snap then fails := array_append(fails, 'a refused line change changed a payslip or a line'); end if;
  -- A name of exactly 80 characters is taken, and can be removed again.
  r := pg_temp.pay_try(owner_id, format('select public.hr_save_payslip_line(%L, null, ''earning'', %L, 1)', pv, repeat('n', 80)));
  if r ? 'refused' or char_length(r #>> '{line,label}') <> 80 then
    fails := array_append(fails, format('a line with a name of 80 characters: %s', r));
  else
    fails := fails || pg_temp.pay_expect(admin_id, 'the admin removes that line', format('select public.hr_delete_payslip_line(%L)', r #>> '{line,id}'), null);
  end if;
  if pg_temp.pay_slip(pv) is distinct from 'basic 200000 gross 200000 epf 22000 socso 1000 eis 400 pcb 0 other 0 net 176600 set [] pending'
     or pg_temp.pay_lines(pv) <> 'none' then
    fails := array_append(fails, format('V after a line was added and removed: %s / %s', pg_temp.pay_slip(pv), pg_temp.pay_lines(pv)));
  end if;

  -- ==== 4. statutory figures ======================================================
  -- A now: gross 355000, the proposals 39050 / 1775 / 710, PCB 0, deductions 25000.
  fails := fails || pg_temp.pay_expect(owner_id, 'EPF is typed over', format('select public.hr_set_statutory(%L, ''epf'', 40000)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 355000 epf 40000 socso 1775 eis 710 pcb 0 other 25000 net 287515 set [epf] pending' then
    fails := array_append(fails, 'A after EPF was set to 400.00: ' || pg_temp.pay_slip(pa));
  end if;
  -- It survives a line change: gross and the other proposals move, EPF stays.
  fails := fails || pg_temp.pay_expect(admin_id, 'an earning is added after EPF was set',
    format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Bonus'', 10000)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40000 socso 1825 eis 730 pcb 0 other 25000 net 297445 set [epf] pending' then
    fails := array_append(fails, 'A after an earning was added with EPF set: ' || pg_temp.pay_slip(pa));
  end if;
  -- And a recalculation, which also keeps every line HR wrote.
  fails := fails || pg_temp.pay_expect(owner_id, 'the draft is recalculated', format('select public.hr_recalculate_payroll(%L)', run_id), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40000 socso 1825 eis 730 pcb 0 other 25000 net 297445 set [epf] pending'
     or pg_temp.pay_lines(pa) is distinct from 'overtime earning "Overtime, 10 Jan 2025, 2 h" 5000; hr earning "Bonus" 10000; hr earning "Commission" 50000; hr deduction "Salary advance" 25000' then
    fails := array_append(fails, format('A after a recalculation with EPF set: %s / %s', pg_temp.pay_slip(pa), pg_temp.pay_lines(pa)));
  end if;
  -- The marks are kept in one order, whatever order they were made in. Zero is an amount.
  -- Each call is looked at on its own: setting one figure leaves the others,
  -- typed or proposed, exactly as they were.
  fails := fails || pg_temp.pay_expect(owner_id, 'PCB is typed over', format('select public.hr_set_statutory(%L, ''pcb'', 1500)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40000 socso 1825 eis 730 pcb 1500 other 25000 net 295945 set [epf,pcb] pending' then
    fails := array_append(fails, 'A after PCB was set, with EPF already typed: ' || pg_temp.pay_slip(pa));
  end if;
  fails := fails || pg_temp.pay_expect(owner_id, 'SOCSO is set to zero', format('select public.hr_set_statutory(%L, ''socso'', 0)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40000 socso 0 eis 730 pcb 1500 other 25000 net 297770 set [epf,socso,pcb] pending' then
    fails := array_append(fails, 'A after SOCSO was set to zero, with EPF and PCB already typed: ' || pg_temp.pay_slip(pa));
  end if;
  fails := fails || pg_temp.pay_expect(owner_id, 'EIS is typed over', format('select public.hr_set_statutory(%L, ''eis'', 700)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40000 socso 0 eis 700 pcb 1500 other 25000 net 297800 set [epf,socso,eis,pcb] pending' then
    fails := array_append(fails, 'A after EIS was set, with the other three already typed: ' || pg_temp.pay_slip(pa));
  end if;
  fails := fails || pg_temp.pay_expect(owner_id, 'EIS is reset', format('select public.hr_set_statutory(%L, ''eis'', null)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40000 socso 0 eis 730 pcb 1500 other 25000 net 297770 set [epf,socso,pcb] pending' then
    fails := array_append(fails, 'A after EIS was reset, with three figures still typed: ' || pg_temp.pay_slip(pa));
  end if;
  fails := fails || pg_temp.pay_expect(owner_id, 'EPF is typed over again', format('select public.hr_set_statutory(%L, ''epf'', 40001)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40001 socso 0 eis 730 pcb 1500 other 25000 net 297769 set [epf,socso,pcb] pending' then
    fails := array_append(fails, 'A with EPF, SOCSO and PCB set: ' || pg_temp.pay_slip(pa));
  end if;
  -- A null amount gives the figure back to the proposal.
  r := pg_temp.pay_try(admin_id, format('select public.hr_set_statutory(%L, ''epf'', null)', pa));
  if r #> '{payslip,set_by_hr}' is distinct from '["socso", "pcb"]'::jsonb or r #> '{payslip,epf_cents}' is distinct from '40150'::jsonb
     or pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40150 socso 0 eis 730 pcb 1500 other 25000 net 297620 set [socso,pcb] pending' then
    fails := array_append(fails, format('A after EPF was reset: %s (%s)', pg_temp.pay_slip(pa), r));
  end if;
  fails := fails
    || pg_temp.pay_expect(admin_id, 'SOCSO is reset', format('select public.hr_set_statutory(%L, ''socso'', null)', pa), null)
    || pg_temp.pay_expect(admin_id, 'EIS, never set, is reset', format('select public.hr_set_statutory(%L, ''eis'', null)', pa), null);
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40150 socso 1825 eis 730 pcb 1500 other 25000 net 295795 set [pcb] pending' then
    fails := array_append(fails, 'A after SOCSO was reset: ' || pg_temp.pay_slip(pa));
  end if;
  fails := fails
    || pg_temp.pay_expect(owner_id, 'a figure that is not one of the four', format('select public.hr_set_statutory(%L, ''net'', 1)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a figure named in capitals', format('select public.hr_set_statutory(%L, ''EPF'', 1)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'no figure named', format('select public.hr_set_statutory(%L, null, 1)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'no figure named, and no amount', format('select public.hr_set_statutory(%L, null, null)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a figure below zero', format('select public.hr_set_statutory(%L, ''epf'', -1)', pa), 'PAYROLL_BAD_INPUT')
    || pg_temp.pay_expect(owner_id, 'a figure above a billion ringgit', format('select public.hr_set_statutory(%L, ''pcb'', 100000000001)', pa), 'PAYROLL_BAD_INPUT');
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40150 socso 1825 eis 730 pcb 1500 other 25000 net 295795 set [pcb] pending' then
    fails := array_append(fails, 'a refused statutory figure changed A: ' || pg_temp.pay_slip(pa));
  end if;

  -- ==== 5. overtime: taken once, and let go ======================================
  select count(*) into n from public.hr_overtime_records o
  where (o.id = o1 and o.payslip_id = pa) or (o.id = o2 and o.payslip_id = pb);
  if n <> 2 then fails := array_append(fails, 'the two approved records are not held by the payslips of the draft'); end if;
  -- One line a record, kept by the table itself.
  begin
    insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents, overtime_record_id)
    values (org, pv, 'earning', 'overtime', 'Twice', 5000, o1);
    fails := array_append(fails, 'one overtime record was put on two lines');
  exception when unique_violation then null;
  end;
  -- Removing a payslip lets its overtime go; recalculating gives the payslip back, and takes it again.
  fails := fails || pg_temp.pay_expect(owner_id, 'B is removed from the draft', format('select public.hr_remove_payslip(%L)', pb), null);
  select count(*) into n from public.hr_overtime_records o where o.id = o2 and o.payslip_id is null and o.status = 'approved';
  select count(*) into n2 from public.hr_payslip_lines l where l.overtime_record_id = o2 or l.payslip_id = pb;
  if n <> 1 or n2 <> 0 then fails := array_append(fails, 'removing a payslip did not let its overtime go, or left a line behind'); end if;
  r := pg_temp.pay_try(admin_id, format('select public.hr_recalculate_payroll(%L)', run_id));
  select p.id into pb from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = eb;
  select count(*) into n from public.hr_overtime_records o where o.id = o2 and o.payslip_id = pb;
  if r -> 'added' is distinct from '1'::jsonb or r -> 'payslips' is distinct from '3'::jsonb or n <> 1
     or pg_temp.pay_slip(pb) is distinct from 'basic 450000 gross 457500 epf 50325 socso 2288 eis 915 pcb 0 other 0 net 403972 set [] pending'
     or pg_temp.pay_lines(pb) is distinct from 'overtime earning "Overtime, 15 Jan 2025, 3 h" 7500' then
    fails := array_append(fails, format('recalculating after B was removed: %s / %s / %s', r, pg_temp.pay_slip(pb), pg_temp.pay_lines(pb)));
  end if;
  -- A's own lines and figure were not touched by that.
  if pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 365000 epf 40150 socso 1825 eis 730 pcb 1500 other 25000 net 295795 set [pcb] pending' then
    fails := array_append(fails, 'a recalculation changed a payslip that had no reason to change: ' || pg_temp.pay_slip(pa));
  end if;
  -- Deleting the draft lets all of it go; a new run takes it again.
  fails := fails || pg_temp.pay_expect(admin_id, 'the draft is deleted', format('select public.hr_delete_payroll_run(%L)', run_id), null);
  select count(*) into n from public.hr_overtime_records o where o.id in (o1, o2) and o.payslip_id is null and o.status = 'approved';
  select count(*) into n2 from public.hr_payslip_lines l where l.org_id = org;
  if n <> 2 or n2 <> 0 then fails := array_append(fails, 'deleting a draft did not let its overtime go, or left lines behind'); end if;
  r := pg_temp.pay_try(admin_id, format('select public.hr_run_payroll(%L, %L)', org, jan));
  run_id := (r #>> '{run,id}')::uuid;
  select p.id into pa from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = ea;
  select p.id into pb from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = eb;
  select p.id into pv from public.hr_payslips p where p.payroll_run_id = run_id and p.employee_id = ev;
  select count(*) into n from public.hr_overtime_records o
  where (o.id = o1 and o.payslip_id = pa) or (o.id = o2 and o.payslip_id = pb);
  if n <> 2 then fails := array_append(fails, 'a new run did not take the overtime the deleted draft let go'); end if;

  -- A record cancelled while in a draft: the draft cannot be paid until it is recalculated.
  fails := fails
    || pg_temp.pay_expect(admin_id, 'overtime in a draft is cancelled', format('select public.hr_cancel_overtime(%L)', o1), null)
    || pg_temp.pay_expect(owner_id, 'a draft with a cancelled record is marked as paid', format('select public.hr_mark_payroll_paid(%L)', run_id), 'PAYROLL_STALE');
  select count(*) into n from public.hr_payroll_runs x where x.id = run_id and x.status = 'draft' and x.paid_at is null;
  select count(*) into n2 from public.hr_payslips p where p.payroll_run_id = run_id and p.status = 'pending';
  if n <> 1 or n2 <> 3 then fails := array_append(fails, 'a refused paid mark changed the run or its payslips'); end if;
  fails := fails || pg_temp.pay_expect(owner_id, 'the draft is recalculated after the cancel', format('select public.hr_recalculate_payroll(%L)', run_id), null);
  select count(*) into n from public.hr_overtime_records o where o.id = o1 and o.payslip_id is null and o.status = 'cancelled';
  if n <> 1 or pg_temp.pay_lines(pa) <> 'none'
     or pg_temp.pay_slip(pa) is distinct from 'basic 300000 gross 300000 epf 33000 socso 1500 eis 600 pcb 0 other 0 net 264900 set [] pending' then
    fails := array_append(fails, format('recalculating did not let a cancelled record go: %s / %s', pg_temp.pay_slip(pa), pg_temp.pay_lines(pa)));
  end if;
  -- A record that no longer points at its payslip is stale too.
  update public.hr_overtime_records set payslip_id = null where id = o2;
  fails := fails
    || pg_temp.pay_expect(owner_id, 'a draft whose record points elsewhere is marked as paid', format('select public.hr_mark_payroll_paid(%L)', run_id), 'PAYROLL_STALE')
    || pg_temp.pay_expect(owner_id, 'the draft is recalculated again', format('select public.hr_recalculate_payroll(%L)', run_id), null);
  select count(*) into n from public.hr_overtime_records o where o.id = o2 and o.payslip_id = pb;
  if n <> 1 then fails := array_append(fails, 'recalculating did not take back a record that had been let go'); end if;

  -- A payslip below zero stops the run being paid.
  r := pg_temp.pay_try(owner_id, format('select public.hr_save_payslip_line(%L, null, ''deduction'', ''Loan'', 300000)', pv));
  line_id := (r #>> '{line,id}')::uuid;
  if pg_temp.pay_slip(pv) is distinct from 'basic 200000 gross 200000 epf 22000 socso 1000 eis 400 pcb 0 other 300000 net -123400 set [] pending' then
    fails := array_append(fails, 'V with a deduction larger than their pay: ' || pg_temp.pay_slip(pv));
  end if;
  fails := fails
    || pg_temp.pay_expect(owner_id, 'a run with a payslip below zero is marked as paid', format('select public.hr_mark_payroll_paid(%L)', run_id), 'PAYROLL_NEGATIVE_NET')
    || pg_temp.pay_expect(owner_id, 'the deduction is brought down to exactly net zero', format('select public.hr_save_payslip_line(%L, %L, ''deduction'', ''Loan'', 176600)', pv, line_id), null);
  if pg_temp.pay_slip(pv) is distinct from 'basic 200000 gross 200000 epf 22000 socso 1000 eis 400 pcb 0 other 176600 net 0 set [] pending' then
    fails := array_append(fails, 'V with net pay of exactly zero: ' || pg_temp.pay_slip(pv));
  end if;

  -- ---- reading, while the run is a draft -------------------------------------------
  select count(*) into n from public.hr_payslip_lines l where l.payslip_id in (pb, pv);
  if n <> 2 then fails := array_append(fails, format('B and V have %s lines between them before the reading tests, expected 2', n)); end if;
  for who, label in select * from (values (ma, 'member A'), (mb, 'member B'), (mv, 'viewer V'), (outsider, 'another workspace')) as c(who, label) loop
    r := pg_temp.pay_try(who, format('select to_jsonb((select count(*) from public.hr_payslips where org_id = %L) + (select count(*) from public.hr_payslip_lines where org_id = %L) + (select count(*) from public.hr_payroll_runs where org_id = %L))', org, org, org));
    if r is distinct from '0'::jsonb then fails := array_append(fails, format('%s reads %s payroll rows while the run is a draft', label, r)); end if;
  end loop;
  for who, label in select * from (values (owner_id, 'the owner'), (admin_id, 'the admin')) as c(who, label) loop
    r := pg_temp.pay_try(who, format('select jsonb_build_array((select count(*) from public.hr_payslips where org_id = %L), (select count(*) from public.hr_payslip_lines where org_id = %L), (select count(*) from public.hr_payroll_runs where org_id = %L))', org, org, org));
    if r is distinct from '[3, 2, 1]'::jsonb then fails := array_append(fails, format('%s reads %s payslips, lines and runs of the draft, expected [3, 2, 1]', label, r)); end if;
  end loop;

  -- ==== 6. paying ====================================================================
  r := pg_temp.pay_try(owner_id, format('select public.hr_mark_payroll_paid(%L)', run_id));
  select count(*) into n from public.hr_payroll_runs x
  where x.id = run_id and x.status = 'paid' and x.paid_at = now() and x.paid_by = owner_id and x.created_by = admin_id;
  select count(*) into n2 from public.hr_payslips p where p.payroll_run_id = run_id and p.status = 'paid';
  if r ? 'refused' or n <> 1 or n2 <> 3 then fails := array_append(fails, format('paying the run: %s', r)); end if;
  -- Paid: nothing of it changes until paid is undone.
  select l.id into b_line from public.hr_payslip_lines l where l.payslip_id = pb;
  select md5(string_agg(x.line, ',' order by x.line)) into snap from (
    select p::text as line from public.hr_payslips p where p.org_id = org
    union all select l::text from public.hr_payslip_lines l where l.org_id = org
    union all select x::text from public.hr_payroll_runs x where x.org_id = org
    union all select o::text from public.hr_overtime_records o where o.org_id = org
  ) x;
  -- A pending record that points at a paid payslip cannot arise through the
  -- functions; it is planted to prove deciding looks.
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status, payslip_id)
  values (org, eb, '2025-01-16', 1.0, 2500, 'pending', pb) returning id into o3;
  for who, label in select * from (values (owner_id, 'the owner'), (admin_id, 'the admin')) as c(who, label) loop
    fails := fails
      || pg_temp.pay_expect(who, label || ' recalculates a paid run', format('select public.hr_recalculate_payroll(%L)', run_id), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' adds a line to a paid payslip', format('select public.hr_save_payslip_line(%L, null, ''earning'', ''Late'', 100)', pa), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' changes a line of a paid payslip', format('select public.hr_save_payslip_line(%L, %L, ''deduction'', ''Loan'', 1)', pv, line_id), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' changes a system line of a paid payslip', format('select public.hr_save_payslip_line(%L, %L, ''earning'', ''x'', 1)', pb, b_line), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' adds a bad line to a paid payslip', format('select public.hr_save_payslip_line(%L, null, ''bonus'', '''', 0)', pa), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' removes a line of a paid payslip', format('select public.hr_delete_payslip_line(%L)', line_id), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' removes a system line of a paid payslip', format('select public.hr_delete_payslip_line(%L)', b_line), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' sets a figure on a paid payslip', format('select public.hr_set_statutory(%L, ''epf'', 1)', pa), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' resets a figure on a paid payslip', format('select public.hr_set_statutory(%L, ''epf'', null)', pa), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' sets an unknown figure on a paid payslip', format('select public.hr_set_statutory(%L, ''net'', -1)', pa), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' removes a paid payslip', format('select public.hr_remove_payslip(%L)', pa), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' deletes a paid run', format('select public.hr_delete_payroll_run(%L)', run_id), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' marks a paid run as paid', format('select public.hr_mark_payroll_paid(%L)', run_id), 'PAYROLL_NOT_DRAFT')
      || pg_temp.pay_expect(who, label || ' runs the paid month again', format('select public.hr_run_payroll(%L, %L)', org, jan), 'PAYROLL_RUN_EXISTS')
      -- A paid later run stops an earlier month being made just as a draft one does.
      || pg_temp.pay_expect(who, label || ' runs the month before the paid one', format('select public.hr_run_payroll(%L, ''2024-12-01'')', org), 'PAYROLL_LATER_RUN')
      -- The latest run is January and it is paid: March would leave February out.
      || pg_temp.pay_expect(who, label || ' runs two months after the latest run', format('select public.hr_run_payroll(%L, ''2025-03-01'')', org), 'PAYROLL_SKIPS_MONTH')
      || pg_temp.pay_expect(who, label || ' runs this month, long after the latest run', format('select public.hr_run_payroll(%L, %L)', org, this_month), 'PAYROLL_SKIPS_MONTH')
      -- Overtime paid in the run cannot be cancelled or decided again.
      || pg_temp.pay_expect(who, label || ' cancels overtime that was paid', format('select public.hr_cancel_overtime(%L)', o2), 'PAY_IN_PAID_RUN')
      || pg_temp.pay_expect(who, label || ' approves a record held by a paid payslip', format('select public.hr_decide_overtime(%L, true, null)', o3), 'PAY_IN_PAID_RUN')
      || pg_temp.pay_expect(who, label || ' rejects a record held by a paid payslip', format('select public.hr_decide_overtime(%L, false, ''no'')', o3), 'PAY_IN_PAID_RUN');
  end loop;
  -- The member it belongs to is told what they were always told for an approved record.
  fails := fails || pg_temp.pay_expect(mb, 'member B cancels their own paid overtime', format('select public.hr_cancel_overtime(%L)', o2), 'PAY_NOT_PENDING');
  delete from public.hr_overtime_records where id = o3;
  select md5(string_agg(x.line, ',' order by x.line)) into t from (
    select p::text as line from public.hr_payslips p where p.org_id = org
    union all select l::text from public.hr_payslip_lines l where l.org_id = org
    union all select x::text from public.hr_payroll_runs x where x.org_id = org
    union all select o::text from public.hr_overtime_records o where o.org_id = org
  ) x;
  if t is distinct from snap then fails := array_append(fails, 'something of a paid run was changed'); end if;

  -- ---- reading, once paid ---------------------------------------------------------------
  -- A second run, still a draft, sits beside the paid one. X joins the workspace
  -- for it and has only that draft payslip.
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'X', 'Draft Only') returning id into ex;
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (ex, org, 250000);
  -- Overtime approved since, worked back in January: February pays it.
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (org, ea, '2025-01-20', 1.5, 4000, 'approved') returning id into o4;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (org, ev, '2025-01-22', 1.0, 3000, 'approved');
  -- January is paid, so the month after it can be made.
  r := pg_temp.pay_try(owner_id, format('select public.hr_run_payroll(%L, %L)', org, feb));
  -- Both records were worked before February: the run says so.
  if r -> 'earlier_overtime' is distinct from '2'::jsonb then
    fails := array_append(fails, format('February, with two records worked in January, says: %s', r));
  end if;
  feb_run := (r #>> '{run,id}')::uuid;
  select p.id into px from public.hr_payslips p where p.payroll_run_id = feb_run and p.employee_id = ex;
  if r -> 'payslips' is distinct from '4'::jsonb or px is null then fails := array_append(fails, format('running February: %s', r)); end if;
  -- Taken once: February holds the new record and not the one January paid.
  select count(*) into n from public.hr_payslip_lines l join public.hr_payslips p on p.id = l.payslip_id
  where p.payroll_run_id = feb_run and l.overtime_record_id is not null;
  select count(*) into n2 from public.hr_overtime_records o
  where (o.id = o2 and o.payslip_id = pb)
     or (o.id = o4 and o.payslip_id = (select p.id from public.hr_payslips p where p.payroll_run_id = feb_run and p.employee_id = ea));
  if n <> 2 or n2 <> 2 then fails := array_append(fails, 'February took overtime January had paid, or did not take the two records approved since'); end if;
  select count(*) into n from public.hr_payslip_lines l where l.overtime_record_id in (o1, o2, o4);
  if n <> 2 then fails := array_append(fails, format('%s lines carry the three records, expected one each for the two that stand', n)); end if;

  -- A member: their own paid payslip and its lines, nothing of the draft, nobody else's.
  for who, label, t, n in
    select * from (values (ma, 'member A', pa::text, 0), (mb, 'member B', pb::text, 1), (mv, 'viewer V', pv::text, 1)) as c(who, label, slip, lines)
  loop
    r := pg_temp.pay_try(who, format(
      'select jsonb_build_array('
      || '(select count(*) from public.hr_payslips where org_id = %1$L), '
      || '(select count(*) from public.hr_payslips where id = %2$L and status = ''paid''), '
      || '(select count(*) from public.hr_payslip_lines where org_id = %1$L), '
      || '(select count(*) from public.hr_payslip_lines where payslip_id = %2$L), '
      || '(select count(*) from public.hr_payroll_runs where org_id = %1$L))', org, t));
    if r is distinct from jsonb_build_array(1, 1, n, n, 0) then
      fails := array_append(fails, format('%s reads %s (payslips, their own paid one, lines, their own lines, runs), expected [1, 1, %s, %s, 0]', label, r, n, n));
    end if;
  end loop;
  r := pg_temp.pay_try(outsider, format('select to_jsonb((select count(*) from public.hr_payslips where org_id = %L) + (select count(*) from public.hr_payslip_lines where org_id = %L))', org, org));
  if r is distinct from '0'::jsonb then fails := array_append(fails, format('another workspace reads %s payslips and lines', r)); end if;
  r := pg_temp.pay_try(mfa_admin, format('select to_jsonb((select count(*) from public.hr_payslips where org_id = %L) + (select count(*) from public.hr_payslip_lines where org_id = %L))', org, org));
  if r is distinct from '0'::jsonb then fails := array_append(fails, format('an admin who owes a second factor reads %s payslips and lines', r)); end if;
  for who, label in select * from (values (owner_id, 'the owner'), (admin_id, 'the admin')) as c(who, label) loop
    r := pg_temp.pay_try(who, format('select jsonb_build_array((select count(*) from public.hr_payslips where org_id = %L), (select count(*) from public.hr_payslip_lines where org_id = %L), (select count(*) from public.hr_payroll_runs where org_id = %L))', org, org, org));
    if r is distinct from '[7, 4, 2]'::jsonb then fails := array_append(fails, format('%s reads %s payslips, lines and runs, expected [7, 4, 2]', label, r)); end if;
  end loop;
  -- Letters: a member reads their own once issued, never a draft, never a colleague's.
  r := pg_temp.pay_try(ma, format('select jsonb_build_array((select count(*) from public.hr_letters where org_id = %L), (select count(*) from public.hr_letters where employee_id = %L and status = ''issued''))', org, ea));
  if r is distinct from '[1, 1]'::jsonb then fails := array_append(fails, format('member A reads %s letters (all, their own issued), expected [1, 1]', r)); end if;
  r := pg_temp.pay_try(admin_id, format('select to_jsonb((select count(*) from public.hr_letters where org_id = %L))', org));
  if r is distinct from '3'::jsonb then fails := array_append(fails, format('the admin reads %s of the 3 letters', r)); end if;
  r := pg_temp.pay_try(mv, format('select to_jsonb((select count(*) from public.hr_letters where org_id = %L))', org));
  if r is distinct from '0'::jsonb then fails := array_append(fails, format('a viewer with no letter reads %s letters', r)); end if;
  -- The demo: any member reads all of it, drafts included.
  select count(*) into n from public.hr_payslips p where p.org_id = demo;
  select count(*) into n2 from public.hr_payslip_lines l where l.org_id = demo;
  r := pg_temp.pay_try(dv, format(
    'select jsonb_build_array((select count(*) from public.hr_payslips where org_id = %1$L), '
    || '(select count(*) from public.hr_payslips where org_id = %1$L and status = ''pending''), '
    || '(select count(*) from public.hr_payslip_lines where org_id = %1$L), '
    || '(select count(*) from public.hr_payslip_lines where payslip_id = %2$L), '
    || '(select count(*) from public.hr_letters where org_id = %1$L), '
    || '(select count(*) from public.hr_letters where org_id = %1$L and status = ''draft''), '
    || '(select count(*) from public.hr_payroll_runs where org_id = %1$L))', demo, demo_slip));
  if r is distinct from jsonb_build_array(n, 20, n2, 1, 5, 2, 8) or n < 150 or n2 < 15 then
    fails := array_append(fails, format('a demo visitor reads %s (payslips, pending ones, lines, a draft payslip''s lines, letters, draft letters, runs) of %s payslips and %s lines', r, n, n2));
  end if;
  r := pg_temp.pay_try(ma, format('select to_jsonb((select count(*) from public.hr_payslips where org_id = %L) + (select count(*) from public.hr_payslip_lines where org_id = %L) + (select count(*) from public.hr_letters where org_id = %L))', demo, demo, demo));
  if r is distinct from '0'::jsonb then fails := array_append(fails, format('someone outside the demo reads %s of its payslips, lines and letters', r)); end if;

  -- ---- no direct writes, for anyone -------------------------------------------------------
  for who, label in select * from (values (owner_id, 'the owner'), (admin_id, 'the admin'), (ma, 'member A')) as c(who, label) loop
    for t, q in
      select * from (values
        ('hr_payroll_runs', format('insert into public.hr_payroll_runs (org_id, period_month) values (%L, ''2025-06-01'')', org)),
        ('hr_payroll_runs', format('update public.hr_payroll_runs set status = ''draft'' where id = %L', run_id)),
        ('hr_payroll_runs', format('update public.hr_payroll_runs set paid_at = now() where id = %L', feb_run)),
        ('hr_payroll_runs', format('delete from public.hr_payroll_runs where id = %L', feb_run)),
        ('hr_payslips', format('insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month, gross_cents) values (%L, %L, %L, %L, 1)', org, en, feb_run, feb)),
        ('hr_payslips', format('update public.hr_payslips set gross_cents = 1 where id = %L', px)),
        ('hr_payslips', format('update public.hr_payslips set status = ''paid'' where id = %L', px)),
        ('hr_payslips', format('update public.hr_payslips set epf_cents = 0, set_by_hr = ''{epf}'' where id = %L', pa)),
        ('hr_payslips', format('delete from public.hr_payslips where id = %L', px)),
        ('hr_payslip_lines', format('insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents) values (%L, %L, ''earning'', ''hr'', ''Mine'', 100000)', org, px)),
        ('hr_payslip_lines', format('update public.hr_payslip_lines set amount_cents = 1 where org_id = %L', org)),
        ('hr_payslip_lines', format('delete from public.hr_payslip_lines where org_id = %L', org)),
        ('hr_statutory_rules', 'insert into public.hr_statutory_rules (scheme, rate) values (''epf'', 0)'),
        ('hr_statutory_rules', 'update public.hr_statutory_rules set rate = 0'),
        ('hr_statutory_rules', 'delete from public.hr_statutory_rules'),
        ('hr_overtime_records', format('update public.hr_overtime_records set payslip_id = null where org_id = %L', org))
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
  foreach q in array array[
    format('insert into public.hr_payroll_runs (org_id, period_month) values (%L, ''2025-06-01'')', org),
    'update public.hr_payslips set gross_cents = 1', 'delete from public.hr_payslip_lines', 'select count(*) from public.hr_payslips',
    'select count(*) from public.hr_payslip_lines', 'select count(*) from public.hr_payroll_runs', 'select count(*) from public.hr_statutory_rules',
    'update public.hr_statutory_rules set rate = 0']
  loop
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    set local role anon;
    begin
      execute q;
      fails := array_append(fails, format('a signed-out visitor ran: %s', q));
    exception
      when insufficient_privilege then null;
      when others then fails := array_append(fails, format('a signed-out visitor was refused for another reason: %s', sqlerrm));
    end;
    reset role;
  end loop;

  -- ---- undo paid ----------------------------------------------------------------------------
  fails := fails
    || pg_temp.pay_expect(owner_id, 'paid is undone on a draft', format('select public.hr_unmark_payroll_paid(%L)', feb_run), 'PAYROLL_NOT_PAID')
    || pg_temp.pay_expect(owner_id, 'paid is undone while a later month has a run', format('select public.hr_unmark_payroll_paid(%L)', run_id), 'PAYROLL_LATER_RUN');
  select count(*) into n from public.hr_payroll_runs x where x.id = run_id and x.status = 'paid' and x.paid_by = owner_id;
  if n <> 1 then fails := array_append(fails, 'a refused undo changed the paid run'); end if;

  -- ---- deleting an employee ---------------------------------------------------------------
  -- With a paid payslip: refused, for the admin through the API and for the
  -- database owner alike. With only a draft payslip: gone, and the payslip too.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  begin
    delete from public.hr_employees where id = ea;
    fails := array_append(fails, 'the admin deleted an employee who has a paid payslip');
  exception when others then
    if sqlerrm <> 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS' then
      fails := array_append(fails, 'deleting an employee with a paid payslip was refused with: ' || sqlerrm);
    end if;
  end;
  begin
    delete from public.hr_employees where id = ex;
    get diagnostics n = row_count;
    if n <> 1 then fails := array_append(fails, 'the admin could not delete an employee who has only a draft payslip'); end if;
  exception when others then
    fails := array_append(fails, 'deleting an employee with only a draft payslip was refused with: ' || sqlerrm);
  end;
  reset role;
  begin
    delete from public.hr_employees where id = eb;
    fails := array_append(fails, 'the database owner deleted an employee who has a paid payslip');
  exception when others then
    if sqlerrm <> 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS' then
      fails := array_append(fails, 'the database owner deleting an employee with a paid payslip was refused with: ' || sqlerrm);
    end if;
  end;
  select count(*) into n from public.hr_employees e where e.id in (ea, eb, ex);
  select count(*) into n2 from public.hr_payslips p where p.id = px or p.employee_id = ex;
  if n <> 2 or n2 <> 0 then fails := array_append(fails, format('%s of A, B and X are left (expected A and B), and X has %s payslips', n, n2)); end if;

  -- Months are consecutive. With February a draft, March is held up by the
  -- draft; with February deleted, January is the latest again, so March would
  -- skip a month and February is the one month that can be made.
  fails := fails
    || pg_temp.pay_expect(owner_id, 'March while February is a draft', format('select public.hr_run_payroll(%L, ''2025-03-01'')', org), 'PAYROLL_EARLIER_DRAFT')
    || pg_temp.pay_expect(admin_id, 'the later draft is deleted', format('select public.hr_delete_payroll_run(%L)', feb_run), null)
    || pg_temp.pay_expect(owner_id, 'March after February was deleted', format('select public.hr_run_payroll(%L, ''2025-03-01'')', org), 'PAYROLL_SKIPS_MONTH')
    || pg_temp.pay_expect(owner_id, 'February again, the month after the latest run', format('select public.hr_run_payroll(%L, %L)', org, feb), null);
  select x.id into feb_run from public.hr_payroll_runs x where x.org_id = org and x.period_month = feb;
  select count(*) into n from public.hr_payroll_runs x where x.org_id = org;
  if feb_run is null or n <> 2 then fails := array_append(fails, format('the workspace has %s runs after February was made again, expected 2', n)); end if;
  -- Deleting the later draft lets its overtime go, and paid can then be undone.
  fails := fails
    || pg_temp.pay_expect(admin_id, 'the later draft is deleted again', format('select public.hr_delete_payroll_run(%L)', feb_run), null)
    || pg_temp.pay_expect(admin_id, 'paid is undone', format('select public.hr_unmark_payroll_paid(%L)', run_id), null);
  select count(*) into n from public.hr_overtime_records o where o.id = o4 and o.payslip_id is null;
  if n <> 1 then fails := array_append(fails, 'deleting February did not let its overtime go'); end if;
  select count(*) into n from public.hr_payroll_runs x where x.id = run_id and x.status = 'draft' and x.paid_at is null and x.paid_by is null;
  select count(*) into n2 from public.hr_payslips p where p.payroll_run_id = run_id and p.status = 'pending';
  if n <> 1 or n2 <> 3 then fails := array_append(fails, 'undoing paid did not put the run back to a draft with 3 pending payslips'); end if;
  -- A draft again: employees read nothing of it, and its overtime can be cancelled and decided.
  r := pg_temp.pay_try(mb, format('select to_jsonb((select count(*) from public.hr_payslips where org_id = %L) + (select count(*) from public.hr_payslip_lines where org_id = %L))', org, org));
  if r is distinct from '0'::jsonb then fails := array_append(fails, format('member B reads %s payslips and lines after paid was undone', r)); end if;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status, payslip_id)
  values (org, eb, '2025-01-16', 1.0, 2500, 'pending', pb) returning id into o3;
  fails := fails
    || pg_temp.pay_expect(admin_id, 'overtime is cancelled after paid was undone', format('select public.hr_cancel_overtime(%L)', o2), null)
    || pg_temp.pay_expect(owner_id, 'a record is decided after paid was undone', format('select public.hr_decide_overtime(%L, false, ''no'')', o3), null)
    || pg_temp.pay_expect(owner_id, 'the reopened draft, now stale, is marked as paid', format('select public.hr_mark_payroll_paid(%L)', run_id), 'PAYROLL_STALE')
    || pg_temp.pay_expect(owner_id, 'the reopened draft is recalculated', format('select public.hr_recalculate_payroll(%L)', run_id), null);
  -- January now pays the record approved since (worked on the 20th); B's cancelled one is gone.
  if pg_temp.pay_lines(pa) is distinct from 'overtime earning "Overtime, 20 Jan 2025, 1.5 h" 4000' or pg_temp.pay_lines(pb) <> 'none'
     or pg_temp.pay_slip(pb) is distinct from 'basic 450000 gross 450000 epf 49500 socso 2250 eis 900 pcb 0 other 0 net 397350 set [] pending' then
    fails := array_append(fails, format('the reopened January after recalculating: A %s / B %s %s', pg_temp.pay_lines(pa), pg_temp.pay_slip(pb), pg_temp.pay_lines(pb)));
  end if;
  fails := fails || pg_temp.pay_expect(admin_id, 'the admin pays the reopened run', format('select public.hr_mark_payroll_paid(%L)', run_id), null);
  select count(*) into n from public.hr_payroll_runs x where x.id = run_id and x.status = 'paid' and x.paid_by = admin_id;
  if n <> 1 then fails := array_append(fails, 'the reopened run was not paid by the admin'); end if;

  -- ==== 7. the calculation, to the cent ============================================
  -- A workspace that works Monday to Saturday, with a public holiday on Tuesday
  -- 18 March 2025. March 2025 then has 25 working days (26 Mondays to Saturdays
  -- less the holiday) and April 2025 has 26.
  insert into public.hr_settings (org_id, work_week) values (corg, '["mon","tue","wed","thu","fri","sat"]'::jsonb);
  insert into public.hr_public_holidays (org_id, name, holiday_date) values (corg, 'A Tuesday Off', '2025-03-18');
  if private.hr_payroll_working_days(corg, mar, date '2025-03-31') <> 25 or private.hr_payroll_working_days(corg, apr, date '2025-04-30') <> 26
     or private.hr_payroll_working_days(corg, date '2025-03-21', date '2025-03-31') <> 9
     or private.hr_payroll_working_days(corg, date '2025-03-31', date '2025-03-30') <> 0 then
    fails := array_append(fails, 'the working days of March and April 2025 are not counted as expected');
  end if;

  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'B1', 'Basic Only') returning id into b1;
  insert into public.hr_employees (org_id, employee_no, name, join_date) values (corg, 'J', 'Joiner', '2025-03-21') returning id into ej;
  insert into public.hr_employees (org_id, employee_no, name, join_date) values (corg, 'U2', 'Two Days Unpaid', '2020-01-01') returning id into u2;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'UH', 'Half Day Unpaid') returning id into uh;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'US', 'Unpaid Over Two Months') returning id into us;
  insert into public.hr_employees (org_id, employee_no, name, join_date) values (corg, 'JC', 'Joiner On Long Leave', '2025-03-21') returning id into jc;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'OT', 'Overtime') returning id into ot;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'HI', 'Above Every Maximum') returning id into hi;
  insert into public.hr_employees (org_id, employee_no, name, join_date) values (corg, 'LO', 'Just Below The Maximum', '2025-03-01') returning id into lo;
  insert into public.hr_employees (org_id, employee_no, name, status) values (corg, 'IN', 'Inactive', 'inactive') returning id into inact;
  insert into public.hr_employees (org_id, employee_no, name, join_date) values (corg, 'FJ', 'Joins In April', '2025-04-15') returning id into fj;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'N1', 'Zed No Salary') returning id into ns1;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'N2', 'Amy No Record') returning id into ns2;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'N0', 'Bob Zero Salary') returning id into ns0;
  -- No salary, and not there yet in March: left out of March altogether, listed in April.
  insert into public.hr_employees (org_id, employee_no, name, join_date) values (corg, 'NC', 'Cal Joins Later', '2025-04-20') returning id into cal;
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents)
  values (b1, corg, 300000), (ej, corg, 311111), (u2, corg, 400000), (uh, corg, 400000), (us, corg, 260000),
         (jc, corg, 311111), (ot, corg, 300000), (hi, corg, 800000), (lo, corg, 594000),
         (inact, corg, 300000), (fj, corg, 300000), (ns1, corg, null), (ns0, corg, 0);
  -- Unpaid leave, approved. Monday and Tuesday; a half day; and Friday 28 March
  -- to Wednesday 2 April, which is 3 working days of March and 2 of April.
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days, half_day, status)
  values (corg, u2, 'unpaid', '2025-03-10', '2025-03-11', 2, false, 'approved'),
         (corg, uh, 'unpaid', '2025-03-12', '2025-03-12', 0.5, true, 'approved'),
         (corg, us, 'unpaid', '2025-03-28', '2025-04-02', 5, false, 'approved'),
         -- None of these count: paid leave, unpaid leave not approved, and unpaid leave in another month.
         (corg, us, 'annual', '2025-03-03', '2025-03-04', 2, false, 'approved'),
         (corg, us, 'unpaid', '2025-03-05', '2025-03-05', 1, false, 'pending'),
         (corg, us, 'unpaid', '2025-03-06', '2025-03-06', 1, false, 'rejected'),
         (corg, us, 'unpaid', '2025-03-07', '2025-03-07', 1, false, 'cancelled'),
         (corg, b1, 'unpaid', '2025-02-24', '2025-02-28', 5, false, 'approved'),
         -- A Sunday and the holiday are not working days, so unpaid leave on them costs nothing.
         (corg, hi, 'unpaid', '2025-03-16', '2025-03-16', 1, false, 'approved'),
         (corg, hi, 'unpaid', '2025-03-18', '2025-03-18', 1, false, 'approved'),
         -- 10 to 31 March is 18 working days: more than is left of the joiner's pay.
         (corg, jc, 'unpaid', '2025-03-10', '2025-03-31', 18, false, 'approved'),
         -- One day in April.
         (corg, u2, 'unpaid', '2025-04-07', '2025-04-07', 1, false, 'approved');
  -- Overtime for OT: two approved in March and one from February are paid in
  -- March; one worth nothing, one worked in April, one pending and one rejected are not.
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-03-05', 2.0, 4327, 'approved') returning id into r1;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-03-20', 2.5, 6000, 'approved') returning id into r2;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-03-22', 1.0, 0, 'approved') returning id into r3;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-04-01', 3.0, 9000, 'approved') returning id into r4;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-02-10', 1.5, 3000, 'approved') returning id into r5;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-03-12', 4.0, 5000, 'pending') returning id into r6;
  insert into public.hr_overtime_records (org_id, employee_id, work_date, hours, amount_cents, status)
  values (corg, ot, '2025-03-13', 4.0, 5000, 'rejected') returning id into r7;

  r := pg_temp.pay_try(owner_id, format('select public.hr_run_payroll(%L, %L)', corg, mar));
  mar_run := (r #>> '{run,id}')::uuid;
  -- Nine payslips. The inactive employee and the one who joins in April have
  -- none; the three with no salary are listed, by name.
  -- One of its three overtime lines is for work done in February.
  if r -> 'payslips' is distinct from '9'::jsonb or r -> 'earlier_overtime' is distinct from '1'::jsonb
     or r -> 'skipped' is distinct from jsonb_build_array(
          jsonb_build_object('employee_id', ns2, 'name', 'Amy No Record', 'reason', 'no_salary'),
          jsonb_build_object('employee_id', ns0, 'name', 'Bob Zero Salary', 'reason', 'no_salary'),
          jsonb_build_object('employee_id', ns1, 'name', 'Zed No Salary', 'reason', 'no_salary')) then
    fails := array_append(fails, format('running March 2025: %s', r));
  end if;
  select count(*) into n from public.hr_payslips p where p.payroll_run_id = mar_run;
  select count(*) into n2 from public.hr_payslips p where p.employee_id in (inact, fj, ns1, ns2, ns0, cal);
  if n <> 9 or n2 <> 0 then fails := array_append(fails, format('March has %s payslips, and %s for people who should have none', n, n2)); end if;
  for label, who, want, t in
    select * from (values
      ('basic only', b1,
        'basic 300000 gross 300000 epf 33000 socso 1500 eis 600 pcb 0 other 0 net 264900 set [] pending', 'none'),
      -- 9 of the 25 working days: 311111 x 9 / 25 = 111999.96, so 112000 is paid and 199111 is not.
      ('a joiner on 21 March', ej,
        'basic 311111 gross 112000 epf 12320 socso 560 eis 224 pcb 0 other 0 net 98896 set [] pending',
        'joiner unpaid "Joined 21 Mar 2025" 199111'),
      -- 400000 / 26 = 15384.6, so 15385 a day.
      ('two days of unpaid leave', u2,
        'basic 400000 gross 369230 epf 40615 socso 1846 eis 738 pcb 0 other 0 net 326031 set [] pending',
        'unpaid_leave unpaid "Unpaid leave, 2 days" 30770'),
      -- Half of 15385 is 7692.5, which rounds up.
      ('half a day of unpaid leave', uh,
        'basic 400000 gross 392307 epf 43154 socso 1962 eis 785 pcb 0 other 0 net 346406 set [] pending',
        'unpaid_leave unpaid "Unpaid leave, 0.5 days" 7693'),
      ('unpaid leave that runs into April', us,
        'basic 260000 gross 230000 epf 25300 socso 1150 eis 460 pcb 0 other 0 net 203090 set [] pending',
        'unpaid_leave unpaid "Unpaid leave, 3 days" 30000'),
      -- The joiner line leaves 112000; 18 days at 11966 would be 215388; the unpaid lines stop at basic.
      ('unpaid lines capped at basic', jc,
        'basic 311111 gross 0 epf 0 socso 0 eis 0 pcb 0 other 0 net 0 set [] pending',
        'joiner unpaid "Joined 21 Mar 2025" 199111; unpaid_leave unpaid "Unpaid leave, 18 days" 112000'),
      ('overtime', ot,
        'basic 300000 gross 313327 epf 34466 socso 1567 eis 627 pcb 0 other 0 net 276667 set [] pending',
        'overtime earning "Overtime, 10 Feb 2025, 1.5 h" 3000; overtime earning "Overtime, 5 Mar 2025, 2 h" 4327; overtime earning "Overtime, 20 Mar 2025, 2.5 h" 6000'),
      -- 0.5% of 8000.00 is 40.00 and 0.2% is 16.00: both stop at the maximum. Leave on a Sunday and on the holiday costs nothing.
      ('gross above every maximum', hi,
        'basic 800000 gross 800000 epf 88000 socso 2975 eis 1190 pcb 0 other 0 net 707835 set [] pending', 'none'),
      -- Joining on the first of the month is not joining part-way through it.
      ('gross just below the maximum', lo,
        'basic 594000 gross 594000 epf 65340 socso 2970 eis 1188 pcb 0 other 0 net 524502 set [] pending', 'none')
    ) as c(label, employee, slip, lines)
  loop
    select p.id into pa from public.hr_payslips p where p.payroll_run_id = mar_run and p.employee_id = who;
    if pg_temp.pay_slip(pa) is distinct from want or pg_temp.pay_lines(pa) is distinct from t then
      fails := array_append(fails, format('March, %s: %s / %s', label, coalesce(pg_temp.pay_slip(pa), 'no payslip'), pg_temp.pay_lines(pa)));
    end if;
  end loop;
  select count(*) into n from public.hr_overtime_records o
  where o.org_id = corg and ((o.id in (r1, r2, r5)) = (o.payslip_id is not null));
  if n <> 7 then fails := array_append(fails, 'March did not take exactly the three overtime records it should'); end if;
  -- The maximum is reached exactly at 5950.00, and a sen above it changes nothing.
  for n, want in select * from (values (595000, '2975 1190'), (594999, '2975 1190'), (594800, '2974 1190'), (594700, '2974 1189'), (595001, '2975 1190'), (0, '0 0'), (1, '0 0')) as c(g, w) loop
    if format('%s %s', private.hr_payroll_proposal('socso', n), private.hr_payroll_proposal('eis', n)) <> want then
      fails := array_append(fails, format('SOCSO and EIS on a gross of %s are %s %s, expected %s', n,
        private.hr_payroll_proposal('socso', n), private.hr_payroll_proposal('eis', n), want));
    end if;
  end loop;
  if private.hr_payroll_proposal('epf', 100000000) <> 11000000 or private.hr_payroll_proposal('epf', 5) <> 1
     or private.hr_payroll_proposal('epf', 4) <> 0 or private.hr_payroll_proposal('pcb', 100000) <> 0 then
    fails := array_append(fails, 'EPF has a maximum, is not rounded to the sen, or a scheme with no rule is not zero');
  end if;

  -- A recalculation after things changed: a new salary, a new employee, a salary
  -- put on file, and someone made inactive (who keeps their payslip).
  select p.id into pa from public.hr_payslips p where p.payroll_run_id = mar_run and p.employee_id = b1;
  fails := fails
    || pg_temp.pay_expect(owner_id, 'B1 gets a line of their own', format('select public.hr_save_payslip_line(%L, null, ''deduction'', ''Parking'', 5000)', pa), null)
    || pg_temp.pay_expect(owner_id, 'B1''s PCB is typed in', format('select public.hr_set_statutory(%L, ''pcb'', 12345)', pa), null);
  update public.hr_employee_private set base_salary_cents = 310000 where employee_id = b1;
  update public.hr_employee_private set base_salary_cents = 150000 where employee_id = ns1;
  update public.hr_employee_private set base_salary_cents = null where employee_id = lo;
  update public.hr_employees set status = 'inactive' where id = hi;
  insert into public.hr_employees (org_id, employee_no, name) values (corg, 'LT', 'Added Late') returning id into late;
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (late, corg, 200000);
  r := pg_temp.pay_try(owner_id, format('select public.hr_recalculate_payroll(%L)', mar_run));
  if r -> 'payslips' is distinct from '11'::jsonb or r -> 'added' is distinct from '2'::jsonb or r -> 'earlier_overtime' is distinct from '1'::jsonb
     or r -> 'skipped' is distinct from jsonb_build_array(
          jsonb_build_object('employee_id', ns2, 'name', 'Amy No Record', 'reason', 'no_salary'),
          jsonb_build_object('employee_id', ns0, 'name', 'Bob Zero Salary', 'reason', 'no_salary')) then
    fails := array_append(fails, format('recalculating March after changes: %s', r));
  end if;
  if pg_temp.pay_slip(pa) is distinct from 'basic 310000 gross 310000 epf 34100 socso 1550 eis 620 pcb 12345 other 5000 net 256385 set [pcb] pending'
     or pg_temp.pay_lines(pa) is distinct from 'hr deduction "Parking" 5000' then
    fails := array_append(fails, format('B1 after a salary change and a recalculation: %s / %s', pg_temp.pay_slip(pa), pg_temp.pay_lines(pa)));
  end if;
  for label, who, want in
    select * from (values
      ('someone whose salary was put on file', ns1, 'basic 150000 gross 150000 epf 16500 socso 750 eis 300 pcb 0 other 0 net 132450 set [] pending'),
      ('someone added since', late, 'basic 200000 gross 200000 epf 22000 socso 1000 eis 400 pcb 0 other 0 net 176600 set [] pending'),
      ('someone made inactive since, who keeps their payslip', hi, 'basic 800000 gross 800000 epf 88000 socso 2975 eis 1190 pcb 0 other 0 net 707835 set [] pending'),
      ('someone whose salary was taken off file, who keeps a payslip of nothing', lo, 'basic 0 gross 0 epf 0 socso 0 eis 0 pcb 0 other 0 net 0 set [] pending'),
      ('overtime, unchanged', ot, 'basic 300000 gross 313327 epf 34466 socso 1567 eis 627 pcb 0 other 0 net 276667 set [] pending')
    ) as c(label, employee, slip)
  loop
    select p.id into pb from public.hr_payslips p where p.payroll_run_id = mar_run and p.employee_id = who;
    if pg_temp.pay_slip(pb) is distinct from want then
      fails := array_append(fails, format('March recalculated, %s: %s', label, coalesce(pg_temp.pay_slip(pb), 'no payslip')));
    end if;
  end loop;
  -- Recalculating twice changes nothing the second time.
  select md5(string_agg(x.line, ',' order by x.line)) into snap from (
    select pg_temp.pay_slip(p.id) || pg_temp.pay_lines(p.id) || p.id as line from public.hr_payslips p where p.payroll_run_id = mar_run
    union all select o.id || coalesce(o.payslip_id::text, '-') from public.hr_overtime_records o where o.org_id = corg
  ) x;
  fails := fails || pg_temp.pay_expect(owner_id, 'March is recalculated a second time', format('select public.hr_recalculate_payroll(%L)', mar_run), null);
  select md5(string_agg(x.line, ',' order by x.line)) into t from (
    select pg_temp.pay_slip(p.id) || pg_temp.pay_lines(p.id) || p.id as line from public.hr_payslips p where p.payroll_run_id = mar_run
    union all select o.id || coalesce(o.payslip_id::text, '-') from public.hr_overtime_records o where o.org_id = corg
  ) x;
  if t is distinct from snap then fails := array_append(fails, 'a second recalculation changed a payslip, a line or which overtime is held'); end if;

  -- PCB: nothing to copy in a first run. Once March is paid, April copies it.
  select count(*) into n from public.hr_payslips p where p.payroll_run_id = mar_run and p.pcb_cents <> 0 and p.employee_id <> b1;
  if n <> 0 then fails := array_append(fails, 'a first payslip has a PCB figure nobody typed'); end if;
  update public.hr_employee_private set base_salary_cents = 594000 where employee_id = lo;
  update public.hr_employees set status = 'active' where id = hi;
  fails := fails || pg_temp.pay_expect(owner_id, 'March is marked as paid', format('select public.hr_mark_payroll_paid(%L)', mar_run), null);
  r := pg_temp.pay_try(owner_id, format('select public.hr_run_payroll(%L, %L)', corg, apr));
  apr_run := (r #>> '{run,id}')::uuid;
  -- March is paid, so April can be made. Its one overtime line is April's own.
  if r -> 'payslips' is distinct from '12'::jsonb or r -> 'earlier_overtime' is distinct from '0'::jsonb
     or r -> 'skipped' is distinct from jsonb_build_array(
          jsonb_build_object('employee_id', ns2, 'name', 'Amy No Record', 'reason', 'no_salary'),
          jsonb_build_object('employee_id', ns0, 'name', 'Bob Zero Salary', 'reason', 'no_salary'),
          jsonb_build_object('employee_id', cal, 'name', 'Cal Joins Later', 'reason', 'no_salary')) then
    fails := array_append(fails, format('running April 2025: %s', r));
  end if;
  for label, who, want, t in
    select * from (values
      -- PCB is copied from March, where it was typed; in April nobody typed it. The line of March is not carried over.
      ('PCB copied from the latest paid payslip', b1,
        'basic 310000 gross 310000 epf 34100 socso 1550 eis 620 pcb 12345 other 0 net 261385 set [] pending', 'none'),
      ('no PCB on the paid payslip to copy', late,
        'basic 200000 gross 200000 epf 22000 socso 1000 eis 400 pcb 0 other 0 net 176600 set [] pending', 'none'),
      -- Joined in March: paid in full in April.
      ('last month''s joiner', ej,
        'basic 311111 gross 311111 epf 34222 socso 1556 eis 622 pcb 0 other 0 net 274711 set [] pending', 'none'),
      -- 14 of April's 26 working days: 300000 x 14 / 26 = 161538.46.
      ('a joiner on 15 April', fj,
        'basic 300000 gross 161538 epf 17769 socso 808 eis 323 pcb 0 other 0 net 142638 set [] pending',
        'joiner unpaid "Joined 15 Apr 2025" 138462'),
      ('the April days of leave that began in March', us,
        'basic 260000 gross 240000 epf 26400 socso 1200 eis 480 pcb 0 other 0 net 211920 set [] pending',
        'unpaid_leave unpaid "Unpaid leave, 2 days" 20000'),
      ('one day of unpaid leave', u2,
        'basic 400000 gross 384615 epf 42308 socso 1923 eis 769 pcb 0 other 0 net 339615 set [] pending',
        'unpaid_leave unpaid "Unpaid leave, 1 day" 15385'),
      -- Only the record worked in April: March's three were paid in March.
      ('overtime worked in April', ot,
        'basic 300000 gross 309000 epf 33990 socso 1545 eis 618 pcb 0 other 0 net 272847 set [] pending',
        'overtime earning "Overtime, 1 Apr 2025, 3 h" 9000')
    ) as c(label, employee, slip, lines)
  loop
    select p.id into pb from public.hr_payslips p where p.payroll_run_id = apr_run and p.employee_id = who;
    if pg_temp.pay_slip(pb) is distinct from want or pg_temp.pay_lines(pb) is distinct from t then
      fails := array_append(fails, format('April, %s: %s / %s', label, coalesce(pg_temp.pay_slip(pb), 'no payslip'), pg_temp.pay_lines(pb)));
    end if;
  end loop;
  select count(*) into n from public.hr_overtime_records o
  join public.hr_payslips p on p.id = o.payslip_id
  where (o.id in (r1, r2, r5) and p.payroll_run_id = mar_run) or (o.id = r4 and p.payroll_run_id = apr_run);
  select count(*) into n2 from public.hr_overtime_records o where o.id in (r3, r6, r7) and o.payslip_id is null;
  if n <> 4 or n2 <> 3 then fails := array_append(fails, 'after April, the overtime records are not each held by the one run that pays them'); end if;
  -- A PCB typed in April and then reset goes back to the figure copied from March.
  select p.id into pb from public.hr_payslips p where p.payroll_run_id = apr_run and p.employee_id = b1;
  fails := fails
    || pg_temp.pay_expect(owner_id, 'April''s PCB is typed over', format('select public.hr_set_statutory(%L, ''pcb'', 99)', pb), null)
    || pg_temp.pay_expect(owner_id, 'April''s PCB is reset', format('select public.hr_set_statutory(%L, ''pcb'', null)', pb), null);
  if pg_temp.pay_slip(pb) is distinct from 'basic 310000 gross 310000 epf 34100 socso 1550 eis 620 pcb 12345 other 0 net 261385 set [] pending' then
    fails := array_append(fails, 'April''s PCB after being typed over and reset: ' || pg_temp.pay_slip(pb));
  end if;
  -- With two paid payslips, the latest is the one copied: April is paid with
  -- another PCB, and May takes April's, not March's.
  fails := fails
    || pg_temp.pay_expect(owner_id, 'April''s PCB is typed over before paying', format('select public.hr_set_statutory(%L, ''pcb'', 222)', pb), null)
    || pg_temp.pay_expect(owner_id, 'April is marked as paid', format('select public.hr_mark_payroll_paid(%L)', apr_run), null)
    || pg_temp.pay_expect(owner_id, 'May is run', format('select public.hr_run_payroll(%L, ''2025-05-01'')', corg), null);
  select p.id into pb from public.hr_payslips p where p.employee_id = b1 and p.period_month = date '2025-05-01';
  if pg_temp.pay_slip(pb) is distinct from 'basic 310000 gross 310000 epf 34100 socso 1550 eis 620 pcb 222 other 0 net 273508 set [] pending' then
    fails := array_append(fails, 'May''s PCB, with March and April both paid: ' || coalesce(pg_temp.pay_slip(pb), 'no payslip'));
  end if;

  -- Every payslip made here adds up, whatever was done to it.
  select count(*) into n from public.hr_payslips p
  where p.org_id in (org, corg, other_org) and (
       p.gross_cents <> greatest(p.basic_cents
         + coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'earning'), 0)
         - coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'unpaid'), 0), 0)
    or p.other_deductions_cents <> coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'deduction'), 0)
    or p.net_cents <> p.gross_cents - p.epf_cents - p.socso_cents - p.eis_cents - p.pcb_cents - p.other_deductions_cents
    or coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'unpaid'), 0) > p.basic_cents);
  select count(*) into n2 from public.hr_payslips p where p.org_id in (org, corg, other_org);
  if n <> 0 or n2 < 25 then fails := array_append(fails, format('%s of %s payslips do not add up', n, n2)); end if;

  -- ==== 8. the demo, after its re-seed ===============================================
  perform private.reseed_demo_people();
  perform private.reseed_demo_people();
  select count(*), count(*) filter (where x.status = 'draft' and x.period_month = this_month),
         count(*) filter (where x.status = 'paid' and x.paid_at is not null) into n, n2, n3
  from public.hr_payroll_runs x where x.org_id = demo;
  if n <> 8 or n2 <> 1 or n3 <> 7 then fails := array_append(fails, 'the demo does not have this month in draft and the seven before it paid'); end if;
  select count(*) into n from public.hr_payslips p join public.hr_payroll_runs x on x.id = p.payroll_run_id
  where p.org_id = demo and ((x.status = 'paid') <> (p.status = 'paid') or p.basic_cents <= 0);
  if n <> 0 then fails := array_append(fails, format('%s demo payslips have no basic pay, or a status that is not their run''s', n)); end if;
  select count(*) into n from public.hr_payslips p
  where p.org_id = demo and (
       p.gross_cents <> greatest(p.basic_cents
         + coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'earning'), 0)
         - coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'unpaid'), 0), 0)
    or p.other_deductions_cents <> coalesce((select sum(l.amount_cents) from public.hr_payslip_lines l where l.payslip_id = p.id and l.kind = 'deduction'), 0)
    or p.net_cents <> p.gross_cents - p.epf_cents - p.socso_cents - p.eis_cents - p.pcb_cents - p.other_deductions_cents
    or p.epf_cents <> private.hr_payroll_proposal('epf', p.gross_cents)
    or p.socso_cents <> private.hr_payroll_proposal('socso', p.gross_cents)
    or p.eis_cents <> private.hr_payroll_proposal('eis', p.gross_cents)
    -- Zero is possible: someone who joined on the last day of a month, a rest day, is paid nothing for it.
    or p.net_cents < 0 or p.set_by_hr <> '{}');
  select count(*) into n2 from public.hr_payslips p where p.org_id = demo;
  if n <> 0 or n2 < 150 then fails := array_append(fails, format('%s of the demo''s %s payslips do not add up', n, n2)); end if;
  -- Lines of every source the demo can have, and every approved record held by one payslip.
  select count(*) filter (where l.source = 'hr'), count(*) filter (where l.source = 'overtime') into n, n2
  from public.hr_payslip_lines l where l.org_id = demo;
  if n <> 6 or n2 <> 10 then fails := array_append(fails, format('the demo has %s HR lines and %s overtime lines, expected 6 and 10', n, n2)); end if;
  select count(*) into n from public.hr_overtime_records o
  where o.org_id = demo and (o.status = 'approved') <> (o.payslip_id is not null and exists (
    select 1 from public.hr_payslip_lines l join public.hr_payslips p on p.id = l.payslip_id
    where l.overtime_record_id = o.id and l.payslip_id = o.payslip_id and l.amount_cents = o.amount_cents
      and p.employee_id = o.employee_id and p.period_month = date_trunc('month', o.work_date)::date));
  if n <> 0 then fails := array_append(fails, format('%s demo overtime records are not held by the payslip of the month they were worked in', n)); end if;
  -- The sample employee has paid payslips to show, and the demo still has its letters.
  select count(*) into n from public.hr_payslips p where p.employee_id = md5('rimba-emp-1')::uuid and p.status = 'paid';
  select count(*) into n2 from public.hr_letters l where l.org_id = demo;
  if n <> 7 or n2 <> 5 then fails := array_append(fails, format('the sample employee has %s paid payslips and the demo %s letters, expected 7 and 5', n, n2)); end if;
  select count(*) into n from public.hr_employees e where e.org_id = demo;
  if n <> 20 then fails := array_append(fails, format('the demo has %s employees after two reseeds, expected 20', n)); end if;

  -- ==== 9. workspaces with payroll in them can still be deleted =====================
  select count(*) into n from public.hr_payslips p where p.org_id in (org, corg) and p.status = 'paid';
  select count(*) into n2 from public.hr_payslip_lines l where l.org_id in (org, corg);
  if n < 10 or n2 < 10 then fails := array_append(fails, format('the workspaces hold %s paid payslips and %s lines, too few to prove deleting them', n, n2)); end if;
  begin
    delete from public.orgs where id in (org, corg, other_org, first_org);
  exception when others then
    fails := array_append(fails, 'deleting a workspace with paid payslips failed: ' || sqlerrm);
  end;
  select (select count(*) from public.hr_payroll_runs x where x.org_id in (org, corg, other_org))
       + (select count(*) from public.hr_payslips p where p.org_id in (org, corg, other_org))
       + (select count(*) from public.hr_payslip_lines l where l.org_id in (org, corg, other_org))
       + (select count(*) from public.hr_overtime_records o where o.org_id in (org, corg, other_org))
       + (select count(*) from public.hr_employees e where e.org_id in (org, corg, other_org)) into n;
  if n <> 0 then fails := array_append(fails, format('%s payroll rows were left behind by deleted workspaces', n)); end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := array_append(fails, format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1)));
  end;

  raise exception 'PEOPLE_PAYROLL_CHECK %', case
    when cardinality(fails) > 0 then format('FAILED (%s): %s', cardinality(fails), array_to_string(fails[1:15], '; '))
    else 'PASSED (everything rolled back)'
  end;
end $$;
