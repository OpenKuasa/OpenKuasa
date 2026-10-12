-- Lekiu member-tier access check. Leaves nothing behind: the block always ends
-- with RAISE, so every insert below is rolled back. Since the payroll slice a
-- member reads their own payslip (and its lines) only once it is paid, and
-- their own letter only once it is issued. Since the performance slice a
-- member reads their own review only once it is released, an announcement
-- only once it is published, and no read mark but their own. Since the
-- letters and documents slice a letter's type is one of a fixed list, and
-- letter templates are for owners and admins only. Read the message:
--   PEOPLE_RLS_CHECK PASSED ...   or   PEOPLE_RLS_CHECK FAILED: <what went wrong>
-- When not to run it. It rebuilds the demo HR rows inside its transaction and
-- holds them until the rollback, and the scheduled demo reseed commits the
-- same rows at minute 1 of every hour. So:
--   * do not start it in minutes :00 to :02 of an hour, and do not start it so
--     late that it could still be running at the next :01 (it takes seconds;
--     leave it a few minutes);
--   * do not run it at the same time as another people check
--     (people_leave_check, people_claims_overtime_check,
--     people_attendance_check, people_payroll_check,
--     people_performance_check, people_documents_check): each of them
--     rebuilds the demo too;
--   * do not run it while a migration is being applied.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid();
  m2 uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  e1 uuid;
  e2 uuid;
  run_id uuid := gen_random_uuid();       -- last month's run, paid
  draft_run uuid := gen_random_uuid();    -- this month's run, still a draft
  this_month date := date_trunc('month', current_date)::date;
  last_month date := (date_trunc('month', current_date) - interval '1 month')::date;
  demo uuid;
  linked uuid;
  a_pub uuid;
  a_draft uuid;
  n int;
  n2 int;
  t text;
  k text;
  q text;
  ref text;
  ref_rule text;
  core text[] := array['hr_departments','hr_employees','hr_employee_private'];
  shared text[] := array['hr_departments','hr_public_holidays','hr_trainings','hr_announcements'];
  fails text[] := '{}';
  personal text[] := array['hr_employee_private','hr_leave_requests','hr_claims','hr_payslips','hr_payslip_lines','hr_reviews','hr_documents','hr_letters'];
  hr_only text[] := array['hr_payroll_runs','hr_payment_vouchers','hr_settings','hr_letter_templates'];
begin
  -- ---- every table: the right read rule, and no write it should not have --
  for t, k in
    select x.t, x.k from (values
      ('hr_departments','shared'), ('hr_employees','shared'), ('hr_employee_private','personal'),
      ('hr_leave_requests','personal'), ('hr_leave_balances','personal'), ('hr_time_off_requests','personal'),
      ('hr_claims','personal'), ('hr_overtime_records','personal'),
      ('hr_attendance_days','personal'), ('hr_timesheet_entries','personal'), ('hr_shifts','personal'), ('hr_public_holidays','shared'),
      ('hr_payroll_runs','hr'), ('hr_payslips','paid'), ('hr_payslip_lines','lines'), ('hr_payment_vouchers','hr'),
      ('hr_goals','personal'), ('hr_scorecards','released'), ('hr_reviews','released'), ('hr_trainings','shared'), ('hr_training_enrolments','personal'),
      ('hr_announcements','published'), ('hr_documents','personal'), ('hr_letters','issued'), ('hr_settings','hr'),
      ('hr_letter_templates','hr')
    ) as x(t, k)
  loop
    select p.qual into q from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname = t || '_select' and p.cmd = 'SELECT';
    if q is null then
      fails := array_append(fails, format('%s has no read policy', t));
    elsif k = 'shared' and (q not like '%is_org_member(org_id)%' or q like '%is_org_admin%' or q like '%is_own_employee%') then
      fails := array_append(fails, format('%s should be readable by every member, its rule is: %s', t, q));
    elsif k in ('personal', 'paid', 'issued', 'released') and not (q like '%is_org_admin(org_id)%' and q like '%is_own_employee(employee_id)%'
        and q like '%is_demo_org(org_id)%' and q like '%is_org_member(org_id)%') then
      fails := array_append(fails, format('%s should be HR-or-own, its rule is: %s', t, q));
    elsif k = 'lines' and not (q like '%hr_payslips%' and q like '%is_org_admin(p.org_id)%'
        and q like '%is_own_employee(p.employee_id)%'
        and q like '%is_demo_org(p.org_id)%' and q like '%is_org_member(p.org_id)%') then
      fails := array_append(fails, format('%s should be read through its payslip, its rule is: %s', t, q));
    elsif k = 'published' and not (q like '%is_org_admin(org_id)%' and q like '%is_org_member(org_id)%'
        and q like '%is_demo_org(org_id)%' and q like '%published%' and q not like '%is_own_employee%') then
      fails := array_append(fails, format('%s should be for owners and admins, and for members once published, its rule is: %s', t, q));
    elsif k = 'hr' and (q not like '%is_org_admin(org_id)%' or q not like '%is_demo_org(org_id)%' or q like '%is_own_employee%') then
      fails := array_append(fails, format('%s should be HR only, its rule is: %s', t, q));
    end if;

    -- The rule must be word for word the rule of the table of its kind whose
    -- reads are tested as a member further down, so a rule that keeps every
    -- expected term but adds a wider one cannot pass.
    -- A payslip, its lines and a letter have a rule of their own: the
    -- employee reads their own only once it is paid, or issued. Their rules
    -- are not compared as text (how a condition is printed is the database's
    -- business); they are proven by what a member reads further down, where
    -- member one has a paid and a draft payslip, a line on each, and an issued
    -- and a draft letter, and by people_payroll_check.sql. A review (the
    -- employee reads their own only once it is released) and an announcement
    -- (a member reads it only once it is published) likewise: member one has
    -- a released and a draft review, the workspace a published and a draft
    -- announcement, and people_performance_check.sql proves the rest.
    if k in ('personal', 'hr', 'shared') then
      ref := case k when 'hr' then 'hr_payroll_runs' when 'shared' then 'hr_departments' else 'hr_employee_private' end;
      select p.qual into ref_rule from pg_policies p
      where p.schemaname = 'public' and p.tablename = ref and p.policyname = ref || '_select';
      if q is distinct from ref_rule then
        fails := array_append(fails, format('%s does not have the same read rule as %s: %s', t, ref, q));
      end if;
    end if;

    select count(*) into n from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname = t || '_select'
      and p.permissive = 'PERMISSIVE' and p.roles = array['authenticated']::name[];
    if n <> 1 then fails := array_append(fails, format('%s read policy is not for signed-in users only', t)); end if;

    select count(*) into n from pg_policies p
    where p.schemaname = 'public' and p.tablename = t and p.policyname = 'mfa_required'
      and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL' and p.qual like '%mfa_ok()%';
    if n <> 1 then fails := array_append(fails, format('%s has no restrictive second-factor policy', t)); end if;

    select count(*) into n from pg_policies p
    where p.schemaname = 'public' and p.tablename = t
      and p.policyname not in (t || '_select', 'mfa_required')
      and not (t = any(core) and p.policyname = t || '_write');
    if n <> 0 then fails := array_append(fails, format('%s has %s policies nobody expected', t, n)); end if;

    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      fails := array_append(fails, format('%s does not have row level security on', t));
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE')
       or has_any_column_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE') then
      fails := array_append(fails, format('signed-out visitors hold a privilege on %s', t));
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      fails := array_append(fails, format('signed-in users cannot read %s at all', t));
    end if;
    if not (t = any(core)) and (
         has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE')
         or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')) then
      fails := array_append(fails, format('%s is meant to be read-only this slice but has a write grant', t));
    end if;
  end loop;

  -- ---- the statutory rules: the same for every workspace, read-only ------
  select count(*) into n from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'hr_statutory_rules';
  select count(*) into n2 from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'hr_statutory_rules' and p.policyname = 'hr_statutory_rules_select'
    and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE' and p.roles = array['authenticated']::name[] and p.qual = 'true';
  if n <> 1 or n2 <> 1 then fails := array_append(fails, 'hr_statutory_rules does not have exactly one policy, a read for signed-in users'); end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.hr_statutory_rules'::regclass) then
    fails := array_append(fails, 'hr_statutory_rules does not have row level security on');
  end if;
  if has_table_privilege('anon', 'public.hr_statutory_rules', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_any_column_privilege('anon', 'public.hr_statutory_rules', 'SELECT, INSERT, UPDATE') then
    fails := array_append(fails, 'signed-out visitors hold a privilege on hr_statutory_rules');
  end if;
  if not has_table_privilege('authenticated', 'public.hr_statutory_rules', 'SELECT')
     or has_table_privilege('authenticated', 'public.hr_statutory_rules', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_any_column_privilege('authenticated', 'public.hr_statutory_rules', 'INSERT, UPDATE') then
    fails := array_append(fails, 'signed-in users should read hr_statutory_rules and nothing more');
  end if;

  -- ---- read marks: one's own rows, never written directly -----------------
  select count(*) into n from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'hr_announcement_reads';
  select count(*) into n2 from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'hr_announcement_reads' and p.roles = array['authenticated']::name[]
    and ((p.policyname = 'hr_announcement_reads_select' and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE'
          and p.qual like '%user_id = %auth.uid()%' and p.qual not like '% or %')
      or (p.policyname = 'mfa_required' and p.cmd = 'ALL' and p.permissive = 'RESTRICTIVE' and p.qual like '%mfa_ok()%'));
  if n <> 2 or n2 <> 2 then fails := array_append(fails, 'hr_announcement_reads does not have exactly its own-rows read policy and the second-factor one'); end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.hr_announcement_reads'::regclass) then
    fails := array_append(fails, 'hr_announcement_reads does not have row level security on');
  end if;
  if has_table_privilege('anon', 'public.hr_announcement_reads', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_any_column_privilege('anon', 'public.hr_announcement_reads', 'SELECT, INSERT, UPDATE')
     or not has_table_privilege('authenticated', 'public.hr_announcement_reads', 'SELECT')
     or has_table_privilege('authenticated', 'public.hr_announcement_reads', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_any_column_privilege('authenticated', 'public.hr_announcement_reads', 'INSERT, UPDATE') then
    fails := array_append(fails, 'signed-in users should read hr_announcement_reads and nothing more');
  end if;

  -- ---- people and a workspace ----------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@rls-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[admin_id, m1, m2, outsider]) as u(id);

  insert into public.orgs (id, name) values (org, 'RLS Check Sdn Bhd'), (other_org, 'RLS Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, admin_id, 'admin'), (other_org, outsider, 'owner');

  -- A work email that equals a sign-in email links nobody (20261101134500_employee_account_link):
  -- an owner or admin makes the link. The employee exists first, then the member joins.
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'E1', 'Member One', m1 || '@rls-check.openkuasa-test.dev') returning id into e1;
  insert into public.org_members (org_id, user_id, role) values (org, m1, 'member');
  select user_id into linked from public.hr_employees where id = e1;
  if linked is not null then fails := array_append(fails, 'joining linked the employee whose work email matches'); end if;
  update public.hr_employees set user_id = m1 where id = e1;
  select user_id into linked from public.hr_employees where id = e1;
  if linked is distinct from m1 then fails := array_append(fails, 'a member could not be linked to their employee record'); end if;

  -- The member exists first, then the employee is added: not linked either, until someone links them.
  insert into public.org_members (org_id, user_id, role) values (org, m2, 'member');
  insert into public.hr_employees (org_id, employee_no, name, work_email)
  values (org, 'E2', 'Member Two', m2 || '@rls-check.openkuasa-test.dev') returning id into e2;
  select user_id into linked from public.hr_employees where id = e2;
  if linked is not null then fails := array_append(fails, 'adding an employee linked the member whose sign-in email matches'); end if;
  update public.hr_employees set user_id = m2 where id = e2;
  select user_id into linked from public.hr_employees where id = e2;
  if linked is distinct from m2 then fails := array_append(fails, 'a member could not be linked to the employee record added for them'); end if;

  -- A link to someone outside the workspace is refused.
  begin
    update public.hr_employees set user_id = outsider where id = e2;
    fails := array_append(fails, 'linked an employee to a non-member');
  exception when others then
    if sqlerrm not like '%not a member of this workspace%' then
      fails := array_append(fails, 'linking a non-member was refused for another reason: ' || sqlerrm);
    end if;
  end;

  -- ---- one personal row each, and the HR-only rows --------------------
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (e1, org, 400000), (e2, org, 900000);
  insert into public.hr_leave_requests (org_id, employee_id, leave_type, start_date, end_date, days)
  values (org, e1, 'annual', current_date, current_date, 1), (org, e2, 'medical', current_date, current_date, 1);
  insert into public.hr_claims (org_id, employee_id, category, amount_cents, claim_date)
  values (org, e1, 'travel', 1000, current_date), (org, e2, 'medical', 2000, current_date);
  -- Payroll: last month paid, this month a draft. Each employee has a payslip
  -- in both, and each payslip one line.
  insert into public.hr_payroll_runs (id, org_id, period_month, status, paid_at)
  values (run_id, org, last_month, 'paid', now()), (draft_run, org, this_month, 'draft', null);
  insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month, basic_cents, gross_cents, status)
  values (org, e1, run_id, last_month, 400000, 400000, 'paid'),
         (org, e2, run_id, last_month, 900000, 900000, 'paid'),
         (org, e1, draft_run, this_month, 400000, 400000, 'pending'),
         (org, e2, draft_run, this_month, 900000, 900000, 'pending');
  insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents)
  select org, p.id, 'deduction', 'hr', 'Uniform', 1000 from public.hr_payslips p where p.org_id = org;
  -- Letters: one issued and one still a draft for member one, one issued for member two.
  insert into public.hr_letters (org_id, employee_id, letter_type, title, status, issued_on)
  values (org, e1, 'confirmation', 'Confirmation of employment', 'issued', current_date),
         (org, e1, 'warning', 'Not sent yet', 'draft', null),
         (org, e2, 'confirmation', 'Confirmation of employment', 'issued', current_date);
  -- Letter templates: the starter set a new workspace is given, one per letter type.
  select count(*), count(distinct letter_type) into n, n2 from public.hr_letter_templates where org_id = org;
  if n <> 6 or n2 <> 6 then fails := array_append(fails, format('the new workspace was given %s starter templates of %s types, expected 6 of 6', n, n2)); end if;
  -- Reviews: one released and one still a draft for member one, one released for member two.
  insert into public.hr_reviews (org_id, employee_id, period, rating, score, status, released_at)
  values (org, e1, 'H1 2025', 'meets', 3.5, 'released', now()),
         (org, e1, 'H2 2025', 'below', 2.5, 'draft', null),
         (org, e2, 'H1 2025', 'exceeds', 4.5, 'released', now());
  insert into public.hr_documents (org_id, employee_id, title, doc_type)
  values (org, e1, 'Contract', 'contract'), (org, e2, 'Contract', 'contract');
  insert into public.hr_payment_vouchers (org_id, voucher_no, payee, voucher_type, amount_cents, issued_date)
  values (org, 'PV-1', 'Someone', 'Advance', 1000, current_date);
  insert into public.hr_settings (org_id) values (org);
  insert into public.hr_departments (org_id, name) values (org, 'Sales');
  insert into public.hr_public_holidays (org_id, name, holiday_date) values (org, 'Labour Day', current_date);
  insert into public.hr_trainings (org_id, title) values (org, 'Safety refresher');
  -- Announcements: one published and one still a draft. Each member has read the published one.
  insert into public.hr_announcements (org_id, title) values (org, 'Welcome') returning id into a_pub;
  insert into public.hr_announcements (org_id, title, status, published_at) values (org, 'Not posted yet', 'draft', null) returning id into a_draft;
  insert into public.hr_announcement_reads (announcement_id, user_id) values (a_pub, m1), (a_pub, m2), (a_pub, admin_id);

  -- ---- as member one ---------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;

  foreach t in array personal loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 1 then fails := array_append(fails, format('a member reads %s rows of %s, expected only their own 1', n, t)); end if;
  end loop;
  execute format('select count(*) from public.hr_payslips where employee_id = %L', e2) into n;
  if n <> 0 then fails := array_append(fails, 'a member reads a colleague''s payslip'); end if;
  -- The one payslip, line and letter a member reads are the paid and the issued ones.
  execute format('select count(*) from public.hr_payslips where org_id = %L and (status <> ''paid'' or employee_id <> %L or payroll_run_id <> %L)', org, e1, run_id) into n;
  if n <> 0 then fails := array_append(fails, 'a member reads a payslip that is not their own paid one'); end if;
  execute format('select count(*) from public.hr_payslip_lines l where l.org_id = %L and l.payslip_id not in (select p.id from public.hr_payslips p where p.employee_id = %L and p.status = ''paid'')', org, e1) into n;
  if n <> 0 then fails := array_append(fails, 'a member reads a line of a payslip that is not their own paid one'); end if;
  execute format('select count(*) from public.hr_letters where org_id = %L and (status <> ''issued'' or employee_id <> %L)', org, e1) into n;
  if n <> 0 then fails := array_append(fails, 'a member reads a letter that is not their own issued one'); end if;
  execute format('select count(*) from public.hr_reviews where org_id = %L and (status <> ''released'' or employee_id <> %L)', org, e1) into n;
  if n <> 0 then fails := array_append(fails, 'a member reads a review that is not their own released one'); end if;
  execute format('select count(*) from public.hr_announcements where org_id = %L and (status <> ''published'' or id <> %L)', org, a_pub) into n;
  if n <> 0 then fails := array_append(fails, 'a member reads an announcement that is not published'); end if;
  execute format('select count(*), count(*) filter (where user_id = %L) from public.hr_announcement_reads', m1) into n, n2;
  if n <> 1 or n2 <> 1 then fails := array_append(fails, format('a member reads %s read marks, %s of them their own, expected only their own 1', n, n2)); end if;
  begin
    execute format('insert into public.hr_announcement_reads (announcement_id, user_id) values (%L, %L)', a_draft, m1);
    fails := array_append(fails, 'a member wrote a read mark directly');
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.hr_statutory_rules;
  if n <> 3 then fails := array_append(fails, format('a member reads %s statutory rules, expected 3', n)); end if;
  foreach t in array hr_only loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 0 then fails := array_append(fails, format('a member reads %s rows of HR-only %s', n, t)); end if;
  end loop;
  execute format('select count(*) from public.hr_employees where org_id = %L', org) into n;
  if n <> 2 then fails := array_append(fails, format('a member sees %s of 2 colleagues in the directory', n)); end if;
  foreach t in array shared loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 1 then fails := array_append(fails, format('a member reads %s rows of shared %s, expected 1', n, t)); end if;
  end loop;

  begin
    execute format('insert into public.hr_employees (org_id, employee_no, name) values (%L, ''X'', ''Planted'')', org);
    fails := array_append(fails, 'a member added an employee');
  exception when insufficient_privilege then null;
  end;
  execute format('update public.hr_employee_private set base_salary_cents = 1 where employee_id = %L', e1);
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a member changed their own salary'); end if;
  execute format('delete from public.hr_employees where id = %L', e2);
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a member deleted a colleague'); end if;

  reset role;

  -- ---- as the admin ----------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  foreach t in array personal loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    -- Two of everything, but four payslips with a line each (paid and draft), three letters and three reviews.
    n2 := case t when 'hr_payslips' then 4 when 'hr_payslip_lines' then 4 when 'hr_letters' then 3 when 'hr_reviews' then 3 else 2 end;
    if n <> n2 then fails := array_append(fails, format('the admin reads %s rows of %s, expected %s', n, t, n2)); end if;
  end loop;
  foreach t in array hr_only loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    -- One of everything, but two payroll runs (the paid one and the draft) and the six starter templates.
    n2 := case t when 'hr_payroll_runs' then 2 when 'hr_letter_templates' then 6 else 1 end;
    if n <> n2 then fails := array_append(fails, format('the admin reads %s rows of %s, expected %s', n, t, n2)); end if;
  end loop;
  -- Both announcements, the draft included; and of the read marks only their own.
  execute format('select count(*) from public.hr_announcements where org_id = %L', org) into n;
  select count(*) into n2 from public.hr_announcement_reads;
  if n <> 2 or n2 <> 1 then fails := array_append(fails, format('the admin reads %s announcements and %s read marks, expected 2 and their own 1', n, n2)); end if;
  reset role;

  -- ---- as the owner of another workspace -------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  foreach t in array personal || hr_only || shared || array['hr_employees'] loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 0 then fails := array_append(fails, format('another workspace reads %s rows of %s', n, t)); end if;
  end loop;
  select count(*) into n from public.hr_announcement_reads;
  if n <> 0 then fails := array_append(fails, format('another workspace reads %s read marks', n)); end if;
  reset role;

  -- ---- a member who is removed loses their own rows at once -------------
  delete from public.org_members where org_id = org and user_id = m1;
  select user_id into linked from public.hr_employees where id = e1;
  if linked is not null then fails := array_append(fails, 'removing a member left the employee linked'); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  execute format('select count(*) from public.hr_payslips where org_id = %L', org) into n;
  if n <> 0 then fails := array_append(fails, 'a removed member still reads their payslip'); end if;
  execute format('select count(*) from public.hr_payslip_lines where org_id = %L', org) into n;
  if n <> 0 then fails := array_append(fails, 'a removed member still reads the lines of their payslip'); end if;
  execute format('select count(*) from public.hr_letters where org_id = %L', org) into n;
  if n <> 0 then fails := array_append(fails, 'a removed member still reads their letter'); end if;
  execute format('select (select count(*) from public.hr_reviews where org_id = %L) + (select count(*) from public.hr_announcements where org_id = %L)', org, org) into n;
  if n <> 0 then fails := array_append(fails, 'a removed member still reads a review or an announcement'); end if;
  reset role;

  -- ---- the demo reseed keeps its shape when it runs again ---------------
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  perform private.reseed_demo_people();
  perform private.reseed_demo_people();
  select count(*) into n from public.hr_employees where org_id = demo;
  if n <> 20 then fails := array_append(fails, format('the demo has %s employees after two reseeds, expected 20', n)); end if;
  select count(*) into n from public.hr_employees where org_id = demo and id = 'dea97d89-a5b6-f264-bd42-c6df73f664a7' and name = 'Aisyah Rahim';
  if n <> 1 then fails := array_append(fails, 'the demo employee id changed'); end if;
  select count(*) into n from public.hr_leave_requests
  where org_id = demo and status = 'approved'
    and (now() at time zone 'Asia/Kuala_Lumpur')::date between start_date and end_date;
  if n <> 3 then fails := array_append(fails, format('%s people on leave today in the demo, expected 3', n)); end if;
  select (select count(*) from public.hr_leave_requests where org_id = demo and status = 'pending')
       + (select count(*) from public.hr_claims where org_id = demo and status = 'pending')
       + (select count(*) from public.hr_overtime_records where org_id = demo and status = 'pending')
       + (select count(*) from public.hr_time_off_requests where org_id = demo and status = 'pending') into n;
  if n <> 6 then fails := array_append(fails, format('%s pending approvals across the four queues in the demo, expected 6', n)); end if;

  -- ---- a workspace with HR data can still be deleted --------------------
  -- Its employees have paid payslips, which would stop them being deleted one
  -- by one; going with their workspace is allowed.
  begin
    delete from public.orgs where id = org;
  exception when others then
    fails := array_append(fails, ('deleting a workspace with HR data failed: ' || sqlerrm));
  end;

  raise exception 'PEOPLE_RLS_CHECK %', case
    when cardinality(fails) = 0 then 'PASSED (everything rolled back)'
    else 'FAILED: ' || array_to_string(fails, '; ')
  end;
end $$;
