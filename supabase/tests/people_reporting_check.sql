-- Reporting lines (the manager tier) access check. Leaves nothing behind: the
-- block always ends with RAISE, so every row and helper below is rolled back.
--   PEOPLE_REPORTING_CHECK PASSED ...   or   PEOPLE_REPORTING_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (it plants two employees in the demo),
-- not beside another people check. Its results do not depend on the clock:
-- every date is fixed, and every row it counts is one it planted or caused.
-- g(who, q, claims) runs q as one signed-in person and says what came back: a
-- statement gives ok, none (no row touched) or denied; a call gives =<json> or
-- the refusal. t(who, what, q, want, claims) is g compared with want ('*' = it
-- must go through, whatever it returns). sees(who, employee) is six digits:
-- how many of that employee's planted rows `who` reads in six tables (leave
-- request, leave balance, time-off, claim, overtime, attendance day). A
-- manager reads five of them for a report, so 111101: the overtime table is
-- closed to a manager (its rate is the salary) and is read through
-- hr_team_overtime, which returns no pay. inbox() lists, then clears, the notifications the planted
-- users have been sent: "who|event|title|body|href", body ~ when there is none.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); org2 uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mgr uuid := gen_random_uuid(); rep uuid := gen_random_uuid();
  sub uuid := gen_random_uuid(); peer uuid := gen_random_uuid(); mgr2 uuid := gen_random_uuid(); mfa uuid := gen_random_uuid();
  rep2 uuid := gen_random_uuid(); outs uuid := gen_random_uuid(); own2 uuid := gen_random_uuid(); adm2 uuid := gen_random_uuid();
  m2 uuid := gen_random_uuid(); m2b uuid := gen_random_uuid(); da uuid := gen_random_uuid(); dm uuid := gen_random_uuid();
  e_own uuid := gen_random_uuid(); e_adm uuid := gen_random_uuid(); e_mgr uuid := gen_random_uuid(); e_rep uuid := gen_random_uuid();
  e_sub uuid := gen_random_uuid(); e_peer uuid := gen_random_uuid(); e_unl uuid := gen_random_uuid(); e_mgr2 uuid := gen_random_uuid();
  e_peer2 uuid := gen_random_uuid(); e_rep2 uuid := gen_random_uuid(); e_mfa uuid := gen_random_uuid(); e_mfarep uuid := gen_random_uuid();
  e_oth uuid := gen_random_uuid(); e2a uuid := gen_random_uuid(); e2b uuid := gen_random_uuid(); e2c uuid := gen_random_uuid();
  de1 uuid := gen_random_uuid(); de2 uuid := gen_random_uuid(); nobody uuid := gen_random_uuid();
  team uuid[]; six text[] := array['hr_leave_requests', 'hr_leave_balances', 'hr_time_off_requests', 'hr_claims', 'hr_overtime_records', 'hr_attendance_days'];
  five text[] := array['hr_leave_requests', 'hr_leave_balances', 'hr_time_off_requests', 'hr_claims', 'hr_attendance_days'];
  cols text := 'id,org_id,employee_id,work_date,hours,day_kind,rate_multiplier,reason,status,requested_by,decided_by,decided_at,decision_note,created_at';
  kinds text[] := array['leave', 'time_off', 'claim', 'overtime'];
  granted text[] := array['user_id', 'employee_no', 'name', 'work_email', 'department_id', 'designation', 'employment_type', 'is_manager', 'join_date', 'status', 'date_of_birth_day', 'date_of_birth_month'];
  w uuid[]; x uuid; y uuid; z uuid; run uuid := gen_random_uuid(); slip uuid := gen_random_uuid(); trn uuid := gen_random_uuid(); dept uuid := gen_random_uuid();
  f_rep text; f_sub text; f_doc text; chain uuid[]; r record; c bigint; i int; k text; a text; b text; ctx text; fails text[] := '{}';
  zeros text := '={"leave":0,"time_off":0,"claims":0,"overtime":0}';
begin
  begin
  -- ---- 0. the catalogue ----------------------------------------------------------------
  select count(*) into i from information_schema.columns k where k.table_schema = 'public' and k.table_name = 'hr_employees' and k.column_name = 'reports_to'
    and k.data_type = 'uuid' and k.is_nullable = 'YES' and k.column_default is null;
  select count(*) into c from pg_constraint k where k.conrelid = 'public.hr_employees'::regclass and k.contype = 'f' and k.confrelid = 'public.hr_employees'::regclass and k.confdeltype = 'n'
    and k.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = k.conrelid and a.attname = 'reports_to')]
    and k.confkey = array[(select a.attnum from pg_attribute a where a.attrelid = k.conrelid and a.attname = 'id')];
  if i <> 1 or c <> 1 then fails := fails || format('reports_to is not a nullable uuid (%s of 1) that points at an employee and is blanked when that employee goes (%s of 1)', i, c); end if;
  select count(*) into i from pg_indexes x where x.schemaname = 'public' and x.indexname = 'hr_employees_reports_to_idx' and x.indexdef like '%(org_id, reports_to)';
  if i <> 1 then fails := fails || 'the index hr_employees_reports_to_idx on (org_id, reports_to) is missing'::text; end if;
  if not has_column_privilege('authenticated', 'public.hr_employees', 'reports_to', 'SELECT') or has_column_privilege('authenticated', 'public.hr_employees', 'reports_to', 'UPDATE')
     or has_column_privilege('anon', 'public.hr_employees', 'reports_to', 'SELECT') or has_column_privilege('anon', 'public.hr_employees', 'reports_to', 'UPDATE') then
    fails := fails || 'reports_to should be read by signed-in users and updated by none'::text;
  end if;
  select count(*) into i from unnest(granted) col where has_column_privilege('authenticated', 'public.hr_employees', col, 'UPDATE');
  if i <> 12 or not has_table_privilege('authenticated', 'public.hr_employees', 'INSERT') or has_table_privilege('authenticated', 'public.hr_employees', 'UPDATE')
     or has_table_privilege('authenticated', 'public.hr_employees', 'DELETE') then
    fails := fails || format('signed-in users should still update the twelve columns (%s) and insert, and hold no update of the whole table and no delete', i);
  end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.hr_my_team(uuid)'), to_regprocedure('public.hr_set_reports_to(uuid,uuid)'), to_regprocedure('public.hr_waiting_counts(uuid)'),
      to_regprocedure('private.is_manager_of(uuid)'), to_regprocedure('public.hr_team_overtime(uuid)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 5 then fails := fails || format('%s of 5 functions are definer functions on a fixed search path for signed-in users only', i); end if;
  -- What hr_team_overtime returns, by the catalogue: the table's columns but the three that tell pay.
  select string_agg(x.name, ',' order by x.ord) into ctx from pg_proc p, unnest(p.proargnames, p.proargmodes) with ordinality x(name, mode, ord)
  where p.oid = to_regprocedure('public.hr_team_overtime(uuid)') and x.mode = 't';
  select string_agg(a.attname::text, ',' order by a.attname::text) into k from pg_attribute a
  where a.attrelid = 'public.hr_overtime_records'::regclass and a.attnum > 0 and not a.attisdropped and not (a.attname::text = any(string_to_array(cols, ',')));
  if ctx is distinct from cols or k is distinct from 'amount_cents,hourly_rate_cents,payslip_id' or ctx like '%cents%' or ctx like '%payslip%'
     or (select p.provolatile::text || p.proretset::text from pg_proc p where p.oid = to_regprocedure('public.hr_team_overtime(uuid)')) is distinct from 'strue' then
    fails := fails || format('hr_team_overtime returns %s, leaving out %s of the table (wanted every column but amount_cents, hourly_rate_cents, payslip_id), or is not a stable set', ctx, k);
  end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('private.hr_manages_any(uuid)'), to_regprocedure('private.hr_notify_request_filed(uuid,uuid,text)'),
      to_regprocedure('private.hr_notify_request_decided(uuid,uuid,text,text)'), to_regprocedure('private.hr_reports_to_guard()'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 4 then fails := fails || format('%s of 4 private functions are definer functions on a fixed search path that no signed-in user may call', i); end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.hr_decide_leave(uuid,boolean,text)'), to_regprocedure('public.hr_decide_time_off(uuid,boolean,text)'),
      to_regprocedure('public.hr_decide_claim(uuid,boolean,text)'), to_regprocedure('public.hr_decide_overtime(uuid,boolean,text)'), to_regprocedure('public.hr_apply_leave(uuid,text,date,date,boolean,text)'),
      to_regprocedure('public.hr_apply_time_off(uuid,date,time,time,text)'), to_regprocedure('public.hr_submit_claim(uuid,text,bigint,date,text,text)'), to_regprocedure('public.hr_submit_overtime(uuid,date,numeric,text)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 8 or has_function_privilege('authenticated', 'private.reseed_demo_people()', 'execute') then fails := fails || format('%s of the 8 replaced functions kept who may call them, or the demo re-seed is open', i); end if;
  select count(*) into i from pg_trigger g where g.tgrelid = 'public.hr_employees'::regclass and g.tgname = 'hr_employees_reports_to_guard' and not g.tgisinternal and g.tgenabled = 'O'
    and g.tgtype = 23 and g.tgfoid = to_regprocedure('private.hr_reports_to_guard()')
    and (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a where a.attrelid = g.tgrelid and a.attnum = any(g.tgattr::int2[])) = array['org_id', 'reports_to'];
  if i <> 1 then fails := fails || 'the guard trigger is not a row trigger before insert or update of reports_to and org_id'::text; end if;
  select count(*) filter (where p.policyname = p.tablename || '_select' and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE' and p.roles = array['authenticated']::name[] and p.qual like '%is_manager_of(employee_id)%'),
    count(*) filter (where p.policyname = 'mfa_required' and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'), count(*) into i, c, ctx
  from pg_policies p where p.schemaname = 'public' and p.tablename = any(six);
  if i <> 5 or c <> 6 or ctx <> '12' then fails := fails || format('the six tables: %s read rules with the manager branch (5: not overtime), %s second-factor rules (6), %s policies in all (12)', i, c, ctx); end if;
  if (select p.qual from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_overtime_records' and p.policyname = 'hr_overtime_records_select')
     is distinct from (select p.qual from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_employee_private' and p.policyname = 'hr_employee_private_select') then
    fails := fails || 'the overtime read rule is not the plain personal rule (owner or admin, the employee, the demo)'::text;
  end if;
  select string_agg(p.policyname, ',' order by p.policyname), count(*) filter (where p.policyname = 'hr_receipts_select' and p.cmd = 'SELECT' and p.qual like '%is_manager_of(c.employee_id)%') into ctx, i
  from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname like 'hr\_receipts%';
  if ctx is distinct from 'hr_receipts_insert_own,hr_receipts_mfa_required,hr_receipts_select' or i <> 1 then fails := fails || format('the receipt policies are %s, the read rule with the manager branch %s of 1', ctx, i); end if;
  select count(*), string_agg(p.tablename, ',' order by p.tablename) filter (where not (p.tablename = any(five) or p.policyname = 'hr_receipts_select')) into i, ctx
  from pg_policies p where coalesce(p.qual, '') || coalesce(p.with_check, '') like '%is_manager_of%';
  if i <> 6 or ctx is not null then fails := fails || format('%s policies mention a manager (6: the five tables and the receipts); others: %s', i, coalesce(ctx, 'none')); end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  -- ---- helpers ----------------------------------------------------------------------------
  execute $f$
    create function pg_temp.g(who uuid, q text, extra jsonb default '{}') returns text language plpgsql as $b$
    declare r jsonb; got text; n int;
    begin
      perform set_config('request.jwt.claims', (jsonb_strip_nulls(jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', case when who is not null then 'aal1' end)) || extra)::text, true);
      set local role authenticated;
      begin
        if q ~ '^(insert|update|delete) ' then execute q; get diagnostics n = row_count; got := case when n > 0 then 'ok' else 'none' end;
        else execute 'select to_jsonb(' || q || ')' into r; got := '=' || coalesce(r::text, 'null'); end if;
      exception when insufficient_privilege then got := 'denied'; when undefined_function then got := 'gone'; when others then got := sqlerrm; end;
      reset role;
      return got;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.t(who uuid, label text, q text, want text, extra jsonb default '{}') returns text[] language plpgsql as $b$
    declare got text := pg_temp.g(who, q, extra);
    begin
      if got = want or (want = '*' and left(got, 1) = '=') or (left(want, 1) = '=' and left(got, 1) = '=' and substr(got, 2)::jsonb = substr(want, 2)::jsonb) then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
    end $b$
  $f$;
  -- What the script planted (basic: the one row per employee and table that sees() counts) and who its users are.
  create temp table rl_planted (tbl text, emp uuid, id uuid, basic boolean) on commit drop;
  create temp table rl_cast (name text, uid uuid) on commit drop;
  create temp table rl_seen (said text) on commit drop;
  create temp sequence rl_n;
  create temp sequence rl_f;
  execute $f$
    create function pg_temp.tbl(kind text) returns text language sql as $b$
      select case kind when 'leave' then 'hr_leave_requests' when 'time_off' then 'hr_time_off_requests' when 'claim' then 'hr_claims' when 'overtime' then 'hr_overtime_records'
        when 'balance' then 'hr_leave_balances' when 'attendance' then 'hr_attendance_days' end
    $b$
  $f$;
  -- A pending request of one kind for one employee, written as the table owner. Leave on a Monday of 2031, the rest on fixed days.
  execute $f$
    create function pg_temp.mk(kind text, o uuid, e uuid, basic boolean default false) returns uuid language plpgsql as $b$
    declare id uuid := gen_random_uuid(); n int := nextval('rl_n');
    begin
      if kind = 'leave' then
        insert into public.hr_leave_requests (id, org_id, employee_id, leave_type, start_date, end_date, days, reason, status)
        values (id, o, e, 'annual', date '2031-01-06' + 7 * (n % 51), date '2031-01-06' + 7 * (n % 51), 1, 'ZZREASONZZ', 'pending');
      elsif kind = 'time_off' then
        insert into public.hr_time_off_requests (id, org_id, employee_id, off_date, start_time, end_time, reason, status) values (id, o, e, date '2031-06-02', '14:00', '15:00', 'ZZREASONZZ', 'pending');
      elsif kind = 'claim' then
        insert into public.hr_claims (id, org_id, employee_id, category, amount_cents, claim_date, description, status) values (id, o, e, 'travel', 123456, date '2026-01-05', 'ZZREASONZZ', 'pending');
      elsif kind = 'overtime' then
        insert into public.hr_overtime_records (id, org_id, employee_id, work_date, hours, reason, status) values (id, o, e, date '2026-01-06', 2, 'ZZREASONZZ', 'pending');
      elsif kind = 'balance' then
        insert into public.hr_leave_balances (id, org_id, employee_id, leave_type, year, entitled_days) values (id, o, e, 'annual', 2031, 16);
      else
        insert into public.hr_attendance_days (id, org_id, employee_id, work_date, status) values (id, o, e, date '2026-01-07', 'absent');
      end if;
      insert into rl_planted values (kind, e, id, basic);
      return id;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.p(kind text, e uuid) returns uuid language sql as $b$ select id from rl_planted where tbl = kind and emp = e and basic $b$
  $f$;
  execute $f$
    create function pg_temp.sees(who uuid, e uuid, extra jsonb default '{}') returns text language plpgsql as $b$
    declare out text := ''; kind text;
    begin
      foreach kind in array array['leave', 'balance', 'time_off', 'claim', 'overtime', 'attendance'] loop
        out := out || substr(pg_temp.g(who, format('(select count(*) from public.%I x where x.id = %L)', pg_temp.tbl(kind), pg_temp.p(kind, e)), extra), 2);
      end loop;
      return out;
    end $b$
  $f$;
  -- The call that decides, and the call that files, one request.
  execute $f$
    create function pg_temp.dq(kind text, id uuid, approve boolean default true, note text default null) returns text language sql as $b$
      select format('public.hr_decide_%s(%L, %s, %L)', kind, id, coalesce(approve::text, 'null'), note)
    $b$
  $f$;
  execute $f$
    create function pg_temp.fq(kind text, e uuid) returns text language plpgsql as $b$
    declare n int := nextval('rl_f');
    begin
      -- Every call gets days of its own (leave on a Tuesday of 2031), so no two filings can overlap.
      if n > 50 then raise exception 'the check files more requests than it has days for'; end if;
      return case kind
        when 'leave' then format('public.hr_apply_leave(%L, ''annual'', %L, %L, false, ''ZZREASONZZ'')', e, date '2031-01-07' + 7 * (n % 51), date '2031-01-07' + 7 * (n % 51))
        when 'time_off' then format('public.hr_apply_time_off(%L, %L, ''09:00'', ''10:00'', ''ZZREASONZZ'')', e, date '2031-07-01' + n)
        when 'claim' then format('public.hr_submit_claim(%L, ''travel'', 123456, ''2026-01-05'', ''ZZREASONZZ'', null)', e)
        else format('public.hr_submit_overtime(%L, %L, 1, ''ZZREASONZZ'')', e, date '2025-06-01' + n) end;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.inbox() returns text language plpgsql as $b$
    declare out text;
    begin
      select coalesce(string_agg(c.name || '|' || n.event || '|' || n.title || '|' || coalesce(n.body, '~') || '|' || coalesce(n.href, '~'), ' ; ' order by c.name, n.event, n.title), '') into out
      from public.notifications n join rl_cast c on c.uid = n.user_id;
      insert into rl_seen select n.title || ' ' || coalesce(n.body, '') || ' ' || coalesce(n.href, '') from public.notifications n join rl_cast c on c.uid = n.user_id;
      delete from public.notifications n using rl_cast c where c.uid = n.user_id;
      return out;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.locked(o uuid) returns boolean language sql as $b$
      select exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1
        and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('hr_reports_to:' || o::text, 0))
    $b$
  $f$;
  execute $f$
    create function pg_temp.wc(l int, o int, cl int, ot int) returns text language sql as $b$
      select '=' || jsonb_build_object('leave', l, 'time_off', o, 'claims', cl, 'overtime', ot)::text
    $b$
  $f$;

  -- ---- the cast ------------------------------------------------------------------------------
  -- org: own (owner), adm (admin), and members mgr, rep, sub, peer, mgr2, rep2 and mfa (who has an authenticator and so
  -- owes a second factor). Lines: rep and the unlinked "unl" report to mgr; sub to rep; peer2 to mgr2; rep2 to adm;
  -- mfarep to mfa; peer, mgr, adm and own to nobody. oth: outs and one employee. org2: no line anywhere (the app
  -- before this release). The demo: de1 reports to de2, who is linked to its admin da.
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into rl_cast values ('own', own), ('adm', adm), ('mgr', mgr), ('rep', rep), ('sub', sub), ('peer', peer), ('mgr2', mgr2), ('mfa', mfa), ('rep2', rep2), ('outs', outs),
    ('own2', own2), ('adm2', adm2), ('m2', m2), ('m2b', m2b), ('da', da), ('dm', dm);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select c.uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', c.uid || '@reporting-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from rl_cast c;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now());
  insert into public.orgs (id, name) values (org, 'Reporting Check Sdn Bhd'), (oth, 'Reporting Other Sdn Bhd'), (org2, 'Reporting Before Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, mgr, 'member'), (org, rep, 'member'), (org, sub, 'member'), (org, peer, 'member'),
    (org, mgr2, 'member'), (org, mfa, 'member'), (org, rep2, 'member'), (oth, outs, 'owner'), (org2, own2, 'owner'), (org2, adm2, 'admin'), (org2, m2, 'member'), (org2, m2b, 'member'),
    (demo, da, 'admin'), (demo, dm, 'member');
  -- peer's record is made with an old updated_at, to see it move when the line is set (an insert is not touched by the trigger).
  insert into public.hr_employees (id, org_id, employee_no, name, user_id, updated_at) values
    (e_own, org, 'R01', 'Owner Check', own, now()), (e_adm, org, 'R02', 'Admin Check', adm, now()), (e_mgr, org, 'R03', 'Manager Check', mgr, now()), (e_rep, org, 'R04', 'Rep Check', rep, now()),
    (e_sub, org, 'R05', 'Sub Check', sub, now()), (e_peer, org, 'R06', 'Peer Check', peer, timestamptz '2020-01-01 00:00+00'), (e_unl, org, 'R07', 'Unlinked Check', null, now()),
    (e_mgr2, org, 'R08', 'Second Manager', mgr2, now()), (e_peer2, org, 'R09', 'Second Peer', null, now()), (e_rep2, org, 'R10', 'Reptwo Check', rep2, now()), (e_mfa, org, 'R11', 'Factor Check', mfa, now()),
    (e_mfarep, org, 'R12', 'Factor Report', null, now()), (e_oth, oth, 'O01', 'Other Check', outs, now()),
    (e2a, org2, 'B01', 'Before Member', m2, now()), (e2b, org2, 'B02', 'Before Unlinked', null, now()), (e2c, org2, 'B03', 'Before Admin', adm2, now()),
    (de2, demo, 'RL-CHECK-2', 'Reporting Lead', da, now()), (de1, demo, 'RL-CHECK-1', 'Reporting Check', null, now());
  team := array[e_own, e_adm, e_mgr, e_rep, e_sub, e_peer, e_unl, e_mgr2, e_peer2, e_rep2, e_mfa, e_mfarep];
  update public.hr_employees set reports_to = e_mgr where id in (e_rep, e_unl);
  update public.hr_employees set reports_to = e_rep where id = e_sub;
  update public.hr_employees set reports_to = e_mgr2 where id = e_peer2;
  update public.hr_employees set reports_to = e_adm where id = e_rep2;
  update public.hr_employees set reports_to = e_mfa where id = e_mfarep;
  update public.hr_employees set reports_to = de2 where id = de1;
  if exists (select 1 from public.hr_employees where org_id in (org2, oth) and reports_to is not null) or (select updated_at from public.hr_employees where id = e_peer) <> timestamptz '2020-01-01 00:00+00' then
    raise exception 'the cast is not as planted';
  end if;
  -- One row in each of the six tables for each of the twelve; every request is pending.
  foreach x in array team loop
    foreach k in array array['leave', 'balance', 'time_off', 'claim', 'overtime', 'attendance'] loop perform pg_temp.mk(k, org, x, true); end loop;
  end loop;
  foreach k in array kinds loop perform pg_temp.mk(k, demo, de1, true); end loop;
  -- Fixed times on two overtime rows, to see the order team overtime comes in.
  update public.hr_overtime_records set created_at = timestamptz '2026-01-06 10:00+00' where id = pg_temp.p('overtime', e_rep);
  update public.hr_overtime_records set created_at = timestamptz '2026-01-07 10:00+00' where id = pg_temp.p('overtime', e_unl);
  -- rep and sub each attached a receipt to their claim, in their own folder.
  f_rep := rep || '/' || gen_random_uuid() || '.png'; f_sub := sub || '/' || gen_random_uuid() || '.png'; f_doc := org || '/' || e_rep || '/' || gen_random_uuid() || '.pdf';
  insert into storage.objects (bucket_id, name, owner) values ('hr-receipts', f_rep, rep), ('hr-receipts', f_sub, sub);
  insert into storage.objects (bucket_id, name) values ('hr-documents', f_doc);
  update public.hr_claims set has_receipt = true, receipt_path = f_rep where id = pg_temp.p('claim', e_rep);
  update public.hr_claims set has_receipt = true, receipt_path = f_sub where id = pg_temp.p('claim', e_sub);
  -- rep's rows in everything a manager must NOT read, each of the kind its own employee may read (paid, issued, released).
  insert into public.hr_departments (id, org_id, name) values (dept, org, 'Reporting Department');
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (e_rep, org, 416000);
  insert into public.hr_settings (org_id) values (org) on conflict (org_id) do nothing;
  insert into public.hr_payroll_runs (id, org_id, period_month, status, paid_at) values (run, org, date '2025-12-01', 'paid', timestamptz '2025-12-28 00:00+00');
  insert into public.hr_payslips (id, org_id, employee_id, payroll_run_id, period_month, basic_cents, gross_cents, status) values (slip, org, e_rep, run, date '2025-12-01', 416000, 416000, 'paid');
  insert into public.hr_trainings (id, org_id, title) values (trn, org, 'Reporting course');
  insert into public.hr_payment_vouchers (org_id, voucher_no, payee, voucher_type, amount_cents, issued_date) values (org, 'RL-1', 'Rep Check', 'Advance', 5000, date '2026-01-05');
  create temp table rl_closed (tbl text, id uuid) on commit drop;
  with a as (insert into public.hr_payslip_lines (org_id, payslip_id, kind, source, label, amount_cents) values (org, slip, 'earning', 'hr', 'Bonus', 5000) returning id) insert into rl_closed select 'hr_payslip_lines', id from a;
  with a as (insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, issued_on) values (org, e_rep, 'offer', 'Offer', 'Body', 'issued', date '2026-01-05') returning id) insert into rl_closed select 'hr_letters', id from a;
  with a as (insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type) values (org, e_rep, 'Contract', 'contract', f_doc, 'c.pdf', 10, 'application/pdf') returning id)
    insert into rl_closed select 'hr_documents', id from a;
  with a as (insert into public.hr_reviews (org_id, employee_id, period, rating, score, status, released_at) values (org, e_rep, 'H1 2026', 'meets', 3.5, 'released', timestamptz '2026-01-05 00:00+00') returning id)
    insert into rl_closed select 'hr_reviews', id from a;
  with a as (insert into public.hr_scorecards (org_id, employee_id, period, score, released_at) values (org, e_rep, 'H1 2026', 3.5, timestamptz '2026-01-05 00:00+00') returning id) insert into rl_closed select 'hr_scorecards', id from a;
  with a as (insert into public.hr_goals (org_id, employee_id, title) values (org, e_rep, 'A goal') returning id) insert into rl_closed select 'hr_goals', id from a;
  with a as (insert into public.hr_training_enrolments (org_id, employee_id, training_id) values (org, e_rep, trn) returning id) insert into rl_closed select 'hr_training_enrolments', id from a;
  with a as (insert into public.hr_timesheet_entries (org_id, employee_id, work_date, hours) values (org, e_rep, date '2026-01-07', 8) returning id) insert into rl_closed select 'hr_timesheet_entries', id from a;
  with a as (insert into public.hr_shifts (org_id, employee_id, work_date, shift) values (org, e_rep, date '2026-01-07', 'morning') returning id) insert into rl_closed select 'hr_shifts', id from a;
  insert into rl_closed values ('hr_payslips', slip);
  perform pg_temp.inbox();

  -- ---- 8. waiting counts and the team, before anything is decided ------------------------------
  -- Twelve pending requests of each kind in org: one per employee.
  fails := fails
    || pg_temp.t(own, 'the owner counts every pending request, their own included', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(12, 12, 12, 12))
    || pg_temp.t(adm, 'an admin counts every pending request but their own', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(11, 11, 11, 11))
    || pg_temp.t(mgr, 'a manager counts their two reports'' requests', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(2, 2, 2, 2))
    || pg_temp.t(rep, 'a report who has a report counts that one''s only', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(1, 1, 1, 1))
    || pg_temp.t(mgr2, 'the second manager counts their one report''s', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(1, 1, 1, 1))
    || pg_temp.t(peer, 'a member with no report counts nothing', format('public.hr_waiting_counts(%L)', org), zeros)
    || pg_temp.t(outs, 'an outsider counts nothing in the workspace', format('public.hr_waiting_counts(%L)', org), zeros)
    || pg_temp.t(mgr, 'no workspace named: nothing', 'public.hr_waiting_counts(null)', zeros)
    || pg_temp.t(null, 'no session: nothing', format('public.hr_waiting_counts(%L)', org), zeros)
    || pg_temp.t(mfa, 'a manager who owes a second factor counts nothing', format('public.hr_waiting_counts(%L)', org), zeros)
    || pg_temp.t(mfa, 'the same manager with the second factor given counts their report''s', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(1, 1, 1, 1), '{"aal":"aal2"}')
    || pg_temp.t(da, 'in the demo an admin linked to a lead counts nothing', format('public.hr_waiting_counts(%L)', demo), zeros)
    || pg_temp.t(dm, 'in the demo a member counts nothing', format('public.hr_waiting_counts(%L)', demo), zeros)
    || pg_temp.t(mgr, 'a manager''s team, by name', format('public.hr_my_team(%L)', org), format('=["%s","%s"]', e_rep, e_unl))
    || pg_temp.t(rep, 'rep''s team', format('public.hr_my_team(%L)', org), format('=["%s"]', e_sub))
    || pg_temp.t(adm, 'an admin''s team is their named reports', format('public.hr_my_team(%L)', org), format('=["%s"]', e_rep2))
    || pg_temp.t(mfa, 'a manager who owes a second factor has no team', format('public.hr_my_team(%L)', org), '=[]')
    || pg_temp.t(mfa, 'and has one with the second factor given', format('public.hr_my_team(%L)', org), format('=["%s"]', e_mfarep), '{"aal":"aal2"}')
    || pg_temp.t(da, 'nobody has a team in the demo', format('public.hr_my_team(%L)', demo), '=[]')
    || pg_temp.t(mgr, 'no workspace named: an empty team, not null', 'public.hr_my_team(null)', '=[]')
    || pg_temp.t(mgr, 'a manager''s team in a workspace they are not in', format('public.hr_my_team(%L)', oth), '=[]');
  foreach x in array array[peer, own, outs] loop
    fails := fails || pg_temp.t(x, 'someone with no report has an empty team', format('public.hr_my_team(%L)', org), '=[]');
  end loop;
  -- The rule itself, asked directly as the policies ask it.
  fails := fails
    || pg_temp.t(mgr, 'the rule: a manager of their report', format('private.is_manager_of(%L)', e_rep), '=true')
    || pg_temp.t(mgr, 'the rule: a manager of a report''s report', format('private.is_manager_of(%L)', e_sub), '=false')
    || pg_temp.t(mgr, 'the rule: a manager of themselves', format('private.is_manager_of(%L)', e_mgr), '=false')
    || pg_temp.t(rep, 'the rule: a report of their manager', format('private.is_manager_of(%L)', e_mgr), '=false')
    || pg_temp.t(mgr, 'the rule: a made-up employee', format('private.is_manager_of(%L)', nobody), '=false')
    || pg_temp.t(mgr, 'the rule: no employee named', 'private.is_manager_of(null)', '=false')
    || pg_temp.t(null, 'the rule: no session', format('private.is_manager_of(%L)', e_rep), '=false')
    || pg_temp.t(mfa, 'the rule: a manager who owes a second factor', format('private.is_manager_of(%L)', e_mfarep), '=false')
    || pg_temp.t(da, 'the rule: never in the demo, even for the lead''s own account', format('private.is_manager_of(%L)', de1), '=false')
    || pg_temp.t(mgr, 'a signed-in user may not ask whether they manage anyone except through the public functions', format('private.hr_manages_any(%L)', org), 'denied');
  fails := fails || pg_temp.t(null, 'no session: an empty team', format('public.hr_my_team(%L)', org), '=[]');

  -- ---- 1. reading the six tables ----------------------------------------------------------------
  for r in select * from (values
      (mgr, e_rep, '111101', 'a manager reads a report''s rows, but not the overtime table'), (mgr, e_unl, '111101', 'a manager reads the rows of a report with no account, but not the overtime table'),
      (mgr, e_mgr, '111111', 'a manager reads their own rows'), (mgr, e_sub, '000000', 'a manager reads nothing of a report''s report'),
      (mgr, e_peer, '000000', 'a manager reads nothing of a colleague'), (mgr, e_adm, '000000', 'a manager reads nothing of the admin'),
      (mgr, e_own, '000000', 'a manager reads nothing of the owner'), (mgr, e_peer2, '000000', 'a manager reads nothing of another manager''s report'),
      (mgr, e_rep2, '000000', 'a manager reads nothing of the admin''s report'), (rep, e_sub, '111101', 'rep reads their own report''s rows, but not the overtime table'),
      (rep, e_mgr, '000000', 'a report reads nothing of their manager'), (rep, e_unl, '000000', 'a report reads nothing of a fellow report'),
      (peer, e_peer, '111111', 'a member reads their own rows'), (peer, e_rep, '000000', 'a member with no report reads nothing of rep'),
      (peer, e_sub, '000000', 'a member with no report reads nothing of sub'), (mfa, e_mfarep, '000000', 'a manager who owes a second factor reads nothing of their report'),
      (mgr2, e_peer2, '111101', 'the second manager reads their report''s rows, but not the overtime table'), (rep, e_rep, '111111', 'a report who is a manager reads all six of their own'), (mgr2, e_rep, '000000', 'the second manager reads nothing of rep'),
      (adm, e_rep2, '111111', 'an admin reads their report''s rows')) v(who, emp, want, label) loop
    a := pg_temp.sees(r.who, r.emp);
    if a is distinct from r.want then fails := fails || format('%s: wanted %s, got %s', r.label, r.want, a); end if;
  end loop;
  a := pg_temp.sees(mfa, e_mfarep, '{"aal":"aal2"}');
  if a is distinct from '111101' then fails := fails || format('with the second factor given, that manager reads their report''s rows: wanted 111101, got %s', a); end if;

  -- ---- 1b. team overtime: through the function, without its pay ---------------------------------------
  fails := fails
    || pg_temp.t(mgr, 'a manager''s team overtime is their two reports'' rows, the newer first', format('(select jsonb_agg(x.id) from public.hr_team_overtime(%L) x)', org),
         format('=["%s","%s"]', pg_temp.p('overtime', e_unl), pg_temp.p('overtime', e_rep)))
    || pg_temp.t(mgr, 'a row of team overtime has these keys and no other', format('(select string_agg(distinct (select string_agg(j.key, '','' order by j.key) from jsonb_object_keys(to_jsonb(x)) j(key)), ''|'') from public.hr_team_overtime(%L) x)', org),
         '="created_at,day_kind,decided_at,decided_by,decision_note,employee_id,hours,id,org_id,rate_multiplier,reason,requested_by,status,work_date"')
    || pg_temp.t(mgr, 'a row of team overtime says what was asked', format('(select x.employee_id || ''/'' || x.work_date || ''/'' || trim_scale(x.hours) || ''/'' || x.status || ''/'' || x.reason from public.hr_team_overtime(%L) x where x.id = %L)', org, pg_temp.p('overtime', e_rep)),
         format('="%s/2026-01-06/2/pending/ZZREASONZZ"', e_rep))
    || pg_temp.t(rep, 'rep''s team overtime is sub''s row', format('(select array_agg(x.employee_id) from public.hr_team_overtime(%L) x)', org), format('=["%s"]', e_sub))
    || pg_temp.t(adm, 'an admin gets only the overtime of who reports to them by name', format('(select array_agg(x.employee_id) from public.hr_team_overtime(%L) x)', org), format('=["%s"]', e_rep2))
    || pg_temp.t(own, 'an owner with no report gets no team overtime', format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=0')
    || pg_temp.t(peer, 'a member with no report gets no team overtime', format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=0')
    || pg_temp.t(outs, 'an outsider gets no team overtime', format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=0')
    || pg_temp.t(mgr, 'a manager gets none from a workspace they are not in', format('(select count(*) from public.hr_team_overtime(%L) x)', oth), '=0')
    || pg_temp.t(mgr, 'no workspace named: no team overtime', '(select count(*) from public.hr_team_overtime(null) x)', '=0')
    || pg_temp.t(null, 'no session: no team overtime', format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=0')
    || pg_temp.t(mfa, 'a manager who owes a second factor gets no team overtime', format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=0')
    || pg_temp.t(mfa, 'and gets their report''s with the second factor given', format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=1', '{"aal":"aal2"}')
    || pg_temp.t(da, 'nobody gets team overtime in the demo', format('(select count(*) from public.hr_team_overtime(%L) x)', demo), '=0')
    || pg_temp.t(dm, 'a member of the demo neither', format('(select count(*) from public.hr_team_overtime(%L) x)', demo), '=0')
    || pg_temp.t(mgr, 'the overtime table itself gives a manager their own rows only', format('(select count(*) || ''/'' || count(*) filter (where x.employee_id = %L) from public.hr_overtime_records x where x.org_id = %L)', e_mgr, org), '="1/1"')
    || pg_temp.t(mgr, 'a manager cannot read a report''s rate or amount from the table', format('(select count(*) from public.hr_overtime_records x where x.employee_id in (%L, %L))', e_rep, e_unl), '=0');
  foreach x in array team loop
    a := pg_temp.sees(outs, x); b := pg_temp.sees(own, x) || pg_temp.sees(adm, x);
    if a is distinct from '000000' or b is distinct from '111111111111' then fails := fails || format('an outsider reads nothing (%s) and the owner and admin everything (%s) of each employee', a, b); end if;
  end loop;

  -- ---- 2. reading everything else: closed to a manager ---------------------------------------------
  for r in select * from rl_closed union all select 'hr_employee_private', null loop
    a := pg_temp.g(adm, format('(select count(*) from public.%I x where %s)', r.tbl, case when r.id is null then format('x.employee_id = %L', e_rep) else format('x.id = %L', r.id) end));
    b := pg_temp.g(mgr, format('(select count(*) from public.%I x where %s)', r.tbl, case when r.id is null then format('x.employee_id = %L', e_rep) else format('x.id = %L', r.id) end));
    if a is distinct from '=1' or b is distinct from '=0' then fails := fails || format('rep''s row in %s: the admin reads it (%s, wanted =1) and the manager does not (%s, wanted =0)', r.tbl, a, b); end if;
  end loop;
  -- rep reads their own of the kinds an employee may read, so the rows above are not hidden from everyone.
  select count(*) into i from rl_closed q where pg_temp.g(rep, format('(select count(*) from public.%I x where x.id = %L)', q.tbl, q.id)) = '=1';
  if i <> 10 then fails := fails || format('rep reads %s of their own 10 rows in the closed tables', i); end if;
  foreach k in array array['hr_payroll_runs', 'hr_payment_vouchers', 'hr_settings', 'hr_letter_templates'] loop
    a := pg_temp.g(adm, format('(select count(*) > 0 from public.%I x where x.org_id = %L)', k, org));
    b := pg_temp.g(mgr, format('(select count(*) from public.%I x where x.org_id = %L)', k, org));
    if a is distinct from '=true' or b is distinct from '=0' then fails := fails || format('%s: the admin reads rows (%s) and the manager none (%s, wanted =0)', k, a, b); end if;
  end loop;
  fails := fails
    || pg_temp.t(adm, 'the admin reads rep''s document file', format('(select count(*) from storage.objects o where o.name = %L)', f_doc), '=1')
    || pg_temp.t(rep, 'rep reads their own document file', format('(select count(*) from storage.objects o where o.name = %L)', f_doc), '=1')
    || pg_temp.t(mgr, 'a manager does not read a report''s document file', format('(select count(*) from storage.objects o where o.name = %L)', f_doc), '=0')
    || pg_temp.t(mgr, 'a manager reads the whole directory, lines included', format('(select count(*) || ''/'' || count(x.reports_to) from public.hr_employees x where x.org_id = %L)', org), '="12/6"')
    || pg_temp.t(peer, 'so does any member', format('(select count(*) || ''/'' || count(x.reports_to) from public.hr_employees x where x.org_id = %L)', org), '="12/6"')
    || pg_temp.t(outs, 'an outsider reads none of the directory', format('(select count(*) from public.hr_employees x where x.org_id = %L)', org), '=0');

  -- ---- 3. the receipt ------------------------------------------------------------------------------
  fails := fails
    || pg_temp.t(mgr, 'a manager reads the receipt on a report''s claim', format('(select count(*) from storage.objects o where o.name = %L)', f_rep), '=1')
    || pg_temp.t(rep, 'the uploader reads it', format('(select count(*) from storage.objects o where o.name = %L)', f_rep), '=1')
    || pg_temp.t(adm, 'an admin reads it', format('(select count(*) from storage.objects o where o.name = %L)', f_rep), '=1')
    || pg_temp.t(peer, 'a colleague does not', format('(select count(*) from storage.objects o where o.name = %L)', f_rep), '=0')
    || pg_temp.t(outs, 'an outsider does not', format('(select count(*) from storage.objects o where o.name = %L)', f_rep), '=0')
    || pg_temp.t(mgr, 'a manager does not read the receipt on a report''s report''s claim', format('(select count(*) from storage.objects o where o.name = %L)', f_sub), '=0')
    || pg_temp.t(rep, 'sub''s manager does', format('(select count(*) from storage.objects o where o.name = %L)', f_sub), '=1')
    || pg_temp.t(mfa, 'a manager who owes a second factor reads no receipt', format('(select count(*) from storage.objects o where o.bucket_id = %L)', 'hr-receipts'), '=0');

  -- ---- 9. the app before this release (org2: no line anywhere) -------------------------------------
  fails := fails
    || pg_temp.t(m2, 'the old directory query still runs', format('(select count(*) from (select x.id, x.is_manager from public.hr_employees x where x.org_id = %L) q)', org2), '=3')
    || pg_temp.t(adm2, 'an insert naming the columns the app names', format('insert into public.hr_employees (org_id, name, employee_no, work_email, department_id, designation, employment_type, is_manager, join_date, status, '
        || 'date_of_birth_day, date_of_birth_month) values (%L, ''Old App'', ''B04'', ''old.app@reporting-check.openkuasa-test.dev'', null, ''Clerk'', ''full_time'', true, ''2026-01-05'', ''active'', 5, 1)', org2), 'ok');
  select id into z from public.hr_employees where org_id = org2 and employee_no = 'B04';
  if (select reports_to from public.hr_employees where id = z) is not null then fails := fails || 'an employee added the old way has a manager'::text; end if;
  for r in select * from (values ('user_id', 'null'), ('employee_no', '''B05'''), ('name', '''Old App Two'''), ('work_email', 'null'), ('department_id', 'null'), ('designation', '''Senior clerk'''),
      ('employment_type', '''contract'''), ('is_manager', 'false'), ('join_date', '''2026-01-06'''), ('status', '''inactive'''), ('date_of_birth_day', '6'), ('date_of_birth_month', '2')) v(col, val) loop
    fails := fails || pg_temp.t(adm2, format('an admin updates %s as before', r.col), format('update public.hr_employees set %I = %s where id = %L', r.col, r.val, z), 'ok');
  end loop;
  if pg_temp.locked(org2) then fails := fails || 'a write that names no manager took the reporting-line lock'::text; end if;
  -- Filing and deciding with no line: as before, and nobody is told that a request was filed.
  w := '{}';
  foreach k in array kinds loop
    fails := fails || pg_temp.t(m2, format('with no line anywhere, a member files %s', k), pg_temp.fq(k, e2a), '*');
    execute format('select id from public.%I where employee_id = %L', pg_temp.tbl(k), e2a) into x;
    w := w || x;
  end loop;
  a := pg_temp.inbox();
  if a <> '' then fails := fails || format('with no line anywhere, filing told someone: %s', a); end if;
  for i in 1..4 loop
    k := kinds[i]; ctx := case when i <= 2 then 'LEAVE' else 'PAY' end;
    fails := fails
      || pg_temp.t(m2b, format('no line: another member on that %s', k), pg_temp.dq(k, w[i]), ctx || '_NOT_FOUND')
      || pg_temp.t(m2, format('no line: the member on their own %s', k), pg_temp.dq(k, w[i]), ctx || '_NOT_ALLOWED')
      || pg_temp.t(adm2, format('no line: an admin decides the %s', k), pg_temp.dq(k, w[i]) || ' ->> ''status''', '="approved"')
      || pg_temp.t(own2, format('no line: a second decision on the %s', k), pg_temp.dq(k, w[i]), ctx || '_NOT_PENDING');
  end loop;
  a := pg_temp.inbox();
  if a is distinct from 'm2|hr_request_decided|Your claim was approved|~|/people/claims ; m2|hr_request_decided|Your leave request was approved|~|/people/leave ; '
      || 'm2|hr_request_decided|Your overtime request was approved|~|/people/ot-claims ; m2|hr_request_decided|Your time-off request was approved|~|/people/time-off' then
    fails := fails || format('with no line anywhere, the four decisions told: %s', a);
  end if;
  x := pg_temp.mk('leave', org2, e2c);
  fails := fails || pg_temp.t(adm2, 'no line: an admin on their own request', pg_temp.dq('leave', x), 'LEAVE_OWN_REQUEST')
    || pg_temp.t(own2, 'no line: the owner decides it', pg_temp.dq('leave', x, false, 'ZZNOTEZZ') || ' ->> ''status''', '="rejected"');
  a := pg_temp.inbox();
  if a is distinct from 'adm2|hr_request_decided|Your leave request was rejected|~|/people/leave' then fails := fails || format('a rejection told: %s', a); end if;
  if pg_temp.locked(org2) then fails := fails || 'filing or deciding took the reporting-line lock'::text; end if;
  -- The probe itself: a line set in org2 does take the lock.
  update public.hr_employees set reports_to = e2c where id = e2b;
  if not pg_temp.locked(org2) then fails := fails || 'setting a line did not take the reporting-line lock (or the probe cannot see it)'::text; end if;

  -- ---- 7. who is told when a request is filed ----------------------------------------------------------
  for r in select * from (values ('leave', 'Leave request', '/people/approve-leave'), ('time_off', 'Time-off request', '/people/approve-time-off'), ('claim', 'Claim', '/people/approve-claims'),
      ('overtime', 'Overtime request', '/people/approve-overtime')) v(kind, label, href) loop
    fails := fails || pg_temp.t(rep, format('rep files %s', r.kind), pg_temp.fq(r.kind, e_rep), '*');
    a := pg_temp.inbox(); b := format('mgr|hr_request_filed|%s from Rep Check|~|%s', r.label, r.href);
    if a is distinct from b then fails := fails || format('rep files %s: wanted the one notification "%s", got "%s"', r.kind, b, a); end if;
    fails := fails || pg_temp.t(adm, format('an admin files %s for rep', r.kind), pg_temp.fq(r.kind, e_rep), '*');
    a := pg_temp.inbox();
    if a is distinct from b then fails := fails || format('an admin files %s for rep: wanted the one notification "%s", got "%s"', r.kind, b, a); end if;
    fails := fails || pg_temp.t(adm, format('an admin files %s for their own report', r.kind), pg_temp.fq(r.kind, e_rep2), '*');
    a := pg_temp.inbox();
    if a <> '' then fails := fails || format('a manager who files %s for their own report is told nothing: got "%s"', r.kind, a); end if;
    fails := fails || pg_temp.t(peer, format('a member with no manager files %s', r.kind), pg_temp.fq(r.kind, e_peer), '*');
    a := pg_temp.inbox();
    if a <> '' then fails := fails || format('a %s filed by someone with no manager tells nobody: got "%s"', r.kind, a); end if;
  end loop;
  fails := fails || pg_temp.t(rep2, 'the admin''s report files leave', pg_temp.fq('leave', e_rep2), '*');
  a := pg_temp.inbox();
  if a is distinct from 'adm|hr_request_filed|Leave request from Reptwo Check|~|/people/approve-leave' then fails := fails || format('the admin''s report files: their named manager alone is told, got "%s"', a); end if;
  fails := fails || pg_temp.t(sub, 'sub files a claim', pg_temp.fq('claim', e_sub), '*');
  a := pg_temp.inbox();
  if a is distinct from 'rep|hr_request_filed|Claim from Sub Check|~|/people/approve-claims' then fails := fails || format('sub files: rep alone is told, not rep''s manager, got "%s"', a); end if;
  fails := fails || pg_temp.t(adm, 'an admin files for the report with no account', pg_temp.fq('overtime', e_unl), '*');
  a := pg_temp.inbox();
  if a is distinct from 'mgr|hr_request_filed|Overtime request from Unlinked Check|~|/people/approve-overtime' then fails := fails || format('filed for a report with no account: got "%s"', a); end if;
  -- Preferences: the in-app channel off for the manager, then the one event off for the employee.
  update public.profiles set notification_prefs = '{"channels":{"inapp":false}}' where user_id = mgr;
  update public.profiles set notification_prefs = '{"events":{"hr_request_decided":{"inapp":false}}}' where user_id = rep;
  if (select count(*) from public.profiles where user_id in (mgr, rep) and notification_prefs <> '{}') <> 2 then fails := fails || 'the two preference rows were not there to set'::text; end if;
  a := pg_temp.g(rep, pg_temp.fq('leave', e_rep));
  if left(a, 1) <> '=' then raise exception 'rep could not file with the manager''s in-app channel off: %', a; end if;
  x := (substr(a, 2)::jsonb ->> 'id')::uuid;
  fails := fails || pg_temp.t(mgr, 'the manager decides it with the employee''s event off', pg_temp.dq('leave', x, false) || ' ->> ''status''', '="rejected"');
  a := pg_temp.inbox();
  if a <> '' then fails := fails || format('preferences off: the request and the decision went through and nobody was told, got "%s"', a); end if;
  update public.profiles set notification_prefs = '{}' where user_id in (mgr, rep);
  -- Tidy: what was filed above is no longer waiting, so the counts below are the planted rows alone.
  update public.hr_leave_requests q set status = 'cancelled' where q.org_id = org and q.status = 'pending' and not exists (select 1 from rl_planted p where p.id = q.id);
  update public.hr_time_off_requests q set status = 'cancelled' where q.org_id = org and q.status = 'pending' and not exists (select 1 from rl_planted p where p.id = q.id);
  update public.hr_claims q set status = 'cancelled' where q.org_id = org and q.status = 'pending' and not exists (select 1 from rl_planted p where p.id = q.id);
  update public.hr_overtime_records q set status = 'cancelled' where q.org_id = org and q.status = 'pending' and not exists (select 1 from rl_planted p where p.id = q.id);

  -- ---- 4. deciding ---------------------------------------------------------------------------------------
  -- Refusals first, on the planted rows, so that nothing is decided yet.
  for i in 1..4 loop
    k := kinds[i]; ctx := case when i <= 2 then 'LEAVE' else 'PAY' end;
    a := pg_temp.g(mgr, pg_temp.dq(k, nobody));
    if a is distinct from ctx || '_NOT_FOUND' then fails := fails || format('a manager on a made-up %s: wanted %s_NOT_FOUND, got %s', k, ctx, a); end if;
    foreach x in array array[e_sub, e_peer, e_adm, e_own, e_peer2, e_rep2] loop
      b := pg_temp.g(mgr, pg_temp.dq(k, pg_temp.p(k, x)));
      if b is distinct from a then fails := fails || format('a manager on the %s of someone who is not their report: wanted what a made-up id gets (%s), got %s', k, a, b); end if;
    end loop;
    b := pg_temp.g(peer, pg_temp.dq(k, pg_temp.p(k, e_rep))) || ' ' || pg_temp.g(outs, pg_temp.dq(k, pg_temp.p(k, e_rep))) || ' ' || pg_temp.g(rep, pg_temp.dq(k, pg_temp.p(k, e_mgr)))
      || ' ' || pg_temp.g(mfa, pg_temp.dq(k, pg_temp.p(k, e_mfarep)));
    if b is distinct from a || ' ' || a || ' ' || a || ' ' || a then
      fails := fails || format('a colleague and an outsider on rep''s %s, rep on their manager''s, and a manager who owes a second factor on their report''s: wanted %s four times, got %s', k, a, b);
    end if;
    fails := fails
      || pg_temp.t(mgr, format('a manager on their own %s', k), pg_temp.dq(k, pg_temp.p(k, e_mgr)), ctx || '_NOT_ALLOWED')
      || pg_temp.t(rep, format('a report who is also a manager, on their own %s', k), pg_temp.dq(k, pg_temp.p(k, e_rep)), ctx || '_NOT_ALLOWED')
      || pg_temp.t(peer, format('a member on their own %s', k), pg_temp.dq(k, pg_temp.p(k, e_peer)), ctx || '_NOT_ALLOWED')
      || pg_temp.t(adm, format('an admin on their own %s', k), pg_temp.dq(k, pg_temp.p(k, e_adm)), ctx || '_OWN_REQUEST')
      || pg_temp.t(null, format('no session on a %s', k), pg_temp.dq(k, pg_temp.p(k, e_rep)), ctx || '_NOT_ALLOWED')
      || pg_temp.t(mgr, format('a manager says neither yes nor no to a %s', k), pg_temp.dq(k, pg_temp.p(k, e_rep), null), ctx || '_BAD_INPUT')
      || pg_temp.t(mgr, format('a manager''s note of 501 characters on a %s', k), pg_temp.dq(k, pg_temp.p(k, e_rep), false, repeat('n', 501)), ctx || '_BAD_INPUT')
      || pg_temp.t(da, format('in the demo, the admin linked to the lead on the %s of the lead''s report', k), pg_temp.dq(k, pg_temp.p(k, de1)), ctx || '_NOT_ALLOWED')
      || pg_temp.t(dm, format('in the demo, a member on that %s', k), pg_temp.dq(k, pg_temp.p(k, de1)), ctx || '_NOT_ALLOWED');
    -- What a manager may not do to a report's request: only owners and admins cancel someone else's.
    a := pg_temp.g(mgr, format('public.hr_cancel_%s(%L)', k, pg_temp.p(k, e_rep))); b := pg_temp.g(peer, format('public.hr_cancel_%s(%L)', k, pg_temp.p(k, e_rep)));
    if a is distinct from ctx || '_NOT_FOUND' or b is distinct from a then fails := fails || format('a manager cancels a report''s %s: wanted what a colleague gets (%s_NOT_FOUND), got %s and %s', k, ctx, a, b); end if;
  end loop;
  select count(*) into i from rl_planted p where p.basic and p.tbl = any(kinds) and p.emp = any(team)
    and (select to_jsonb(q) ->> 'status' from (select status from public.hr_leave_requests where id = p.id union all select status from public.hr_time_off_requests where id = p.id
         union all select status from public.hr_claims where id = p.id union all select status from public.hr_overtime_records where id = p.id) q) = 'pending';
  if i <> 48 then fails := fails || format('after the refusals %s of the 48 planted requests are still pending', i); end if;
  a := pg_temp.inbox();
  if a <> '' then fails := fails || format('a refusal told someone: %s', a); end if;

  -- A manager decides each kind for a report. The leave balance moves as it always did.
  fails := fails || pg_temp.t(mgr, 'a manager approves a report''s leave', pg_temp.dq('leave', pg_temp.p('leave', e_rep)), format('={"id":"%s","status":"approved"}', pg_temp.p('leave', e_rep)))
    || pg_temp.t(mgr, 'after one decision the manager''s leave count drops by one', format('public.hr_waiting_counts(%L)', org), pg_temp.wc(1, 2, 2, 2))
    || pg_temp.t(mgr, 'a manager rejects a report''s time-off with a note', pg_temp.dq('time_off', pg_temp.p('time_off', e_rep), false, ' ZZNOTEZZ '), format('={"id":"%s","status":"rejected"}', pg_temp.p('time_off', e_rep)))
    || pg_temp.t(mgr, 'a manager approves a report''s claim', pg_temp.dq('claim', pg_temp.p('claim', e_rep)), format('={"id":"%s","status":"approved"}', pg_temp.p('claim', e_rep)))
    || pg_temp.t(mgr, 'a manager approves a report''s overtime, and the reply carries no amount', pg_temp.dq('overtime', pg_temp.p('overtime', e_rep)),
         format('={"id":"%s","status":"approved","amount_cents":null}', pg_temp.p('overtime', e_rep)))
    -- The row now holds the rate (2000) and the amount (6000). Neither reaches the manager, by any name.
    || pg_temp.t(mgr, 'the approved overtime is in the manager''s team overtime', format('(select x.status || ''/'' || (x.decided_by = %L) from public.hr_team_overtime(%L) x where x.id = %L)', mgr, org, pg_temp.p('overtime', e_rep)), '="approved/true"')
    || pg_temp.t(mgr, 'no value in the manager''s team overtime is the rate or the amount',
         format('(select count(*) from public.hr_team_overtime(%L) x, jsonb_each_text(to_jsonb(x)) v where v.value in (''2000'', ''6000'', ''416000''))', org), '=0')
    || pg_temp.t(adm, 'the admin reads both on the table', format('(select x.hourly_rate_cents || ''/'' || x.amount_cents from public.hr_overtime_records x where x.id = %L)', pg_temp.p('overtime', e_rep)), '="2000/6000"');
  x := pg_temp.mk('overtime', org, e_rep);
  fails := fails || pg_temp.t(adm, 'an admin approves a report''s overtime, and the reply carries the amount', pg_temp.dq('overtime', x), format('={"id":"%s","status":"approved","amount_cents":6000}', x));
  z := x;
  x := pg_temp.mk('overtime', org, e_rep);
  fails := fails || pg_temp.t(own, 'the owner approves a report''s overtime, and the reply carries the amount', pg_temp.dq('overtime', x), format('={"id":"%s","status":"approved","amount_cents":6000}', x));
  y := pg_temp.mk('overtime', org, e_rep);
  fails := fails || pg_temp.t(mgr, 'a manager rejects overtime: no amount in the reply either', pg_temp.dq('overtime', y, false), format('={"id":"%s","status":"rejected","amount_cents":null}', y));
  select q.status || '/' || (q.decided_by = mgr) || '/' || coalesce(q.decision_note, '~') into a from public.hr_leave_requests q where q.id = pg_temp.p('leave', e_rep);
  select q.status || '/' || (q.decided_by = mgr) || '/' || coalesce(q.decision_note, '~') into b from public.hr_time_off_requests q where q.id = pg_temp.p('time_off', e_rep);
  select q.status || '/' || (q.decided_by = mgr) || '/' || coalesce(q.decision_note, '~') into ctx from public.hr_claims q where q.id = pg_temp.p('claim', e_rep);
  select q.status || '/' || (q.decided_by = mgr) || '/' || q.amount_cents || '/' || q.hourly_rate_cents into k from public.hr_overtime_records q where q.id = pg_temp.p('overtime', e_rep);
  if a is distinct from 'approved/true/~' or b is distinct from 'rejected/true/ZZNOTEZZ' or ctx is distinct from 'approved/true/~' or k is distinct from 'approved/true/6000/2000' then
    fails := fails || format('the four rows a manager decided: %s, %s, %s, %s', a, b, ctx, k);
  end if;
  if (select q.used_days from public.hr_leave_balances q where q.id = pg_temp.p('balance', e_rep)) is distinct from 1::numeric then fails := fails || 'the approved day of leave is not on the balance'::text; end if;
  a := pg_temp.inbox();
  if a is distinct from 'rep|hr_request_decided|Your claim was approved|~|/people/claims ; rep|hr_request_decided|Your leave request was approved|~|/people/leave ; '
      || 'rep|hr_request_decided|Your overtime request was approved|~|/people/ot-claims ; rep|hr_request_decided|Your overtime request was approved|~|/people/ot-claims ; '
      || 'rep|hr_request_decided|Your overtime request was approved|~|/people/ot-claims ; '
      || 'rep|hr_request_decided|Your overtime request was rejected|~|/people/ot-claims ; rep|hr_request_decided|Your time-off request was rejected|~|/people/time-off' then
    fails := fails || format('the seven decisions (four kinds, then overtime three times more) told: %s', a);
  end if;
  for i in 1..4 loop
    k := kinds[i]; ctx := case when i <= 2 then 'LEAVE' else 'PAY' end;
    fails := fails
      || pg_temp.t(adm, format('an admin on the %s a manager decided', k), pg_temp.dq(k, pg_temp.p(k, e_rep)), ctx || '_NOT_PENDING')
      || pg_temp.t(mgr, format('the manager again on that %s', k), pg_temp.dq(k, pg_temp.p(k, e_rep), false), ctx || '_NOT_PENDING')
      || pg_temp.t(mgr, format('a manager decides the %s of a report with no account', k), pg_temp.dq(k, pg_temp.p(k, e_unl), i <> 2) || ' ->> ''status''', case when i <> 2 then '="approved"' else '="rejected"' end);
    x := pg_temp.mk(k, org, e_rep);
    fails := fails
      || pg_temp.t(adm, format('an admin decides a %s first', k), pg_temp.dq(k, x, false) || ' ->> ''status''', '="rejected"')
      || pg_temp.t(mgr, format('then the manager on that %s', k), pg_temp.dq(k, x), ctx || '_NOT_PENDING')
      || pg_temp.t(own, format('the owner decides their own %s', k), pg_temp.dq(k, pg_temp.p(k, e_own)) || ' ->> ''status''', '="approved"')
      || pg_temp.t(adm, format('an admin who is also the manager decides their report''s %s', k), pg_temp.dq(k, pg_temp.p(k, e_rep2)) || ' ->> ''status''', '="approved"')
      || pg_temp.t(rep, format('rep decides their own report''s %s', k), pg_temp.dq(k, pg_temp.p(k, e_sub)) || ' ->> ''status''', '="approved"');
  end loop;
  select string_agg(q.status || (q.decided_by = mgr), ',') into a from public.hr_leave_requests q where q.id = pg_temp.p('leave', e_unl);
  if a is distinct from 'approvedtrue' then fails := fails || format('the leave of the report with no account: %s', a); end if;
  -- rep was told of the admin's four rejections; rep2 and sub of their four approvals; the owner and the report with no account of nothing.
  select count(*) filter (where n.user_id = rep and n.title like '% was rejected'), count(*) filter (where n.user_id = rep2 and n.title like '% was approved'),
    count(*) filter (where n.user_id = sub and n.title like '% was approved'), count(*) into i, c, ctx, k
  from public.notifications n join rl_cast q on q.uid = n.user_id where n.event = 'hr_request_decided';
  if i <> 4 or c <> 4 or ctx <> '4' or k <> '12' or (select count(*) from public.notifications n join rl_cast q on q.uid = n.user_id) <> 12 then
    fails := fails || format('after those decisions: rep %s, rep2 %s, sub %s of %s notifications (4, 4, 4 of 12), and no other', i, c, ctx, k);
  end if;
  perform pg_temp.inbox();
  -- An admin who is also the employee's named manager is an admin: the amount is in their reply.
  insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (e_rep2, org, 416000);
  x := pg_temp.mk('overtime', org, e_rep2);
  fails := fails || pg_temp.t(adm, 'an admin who is also the manager approves overtime, and the reply carries the amount', pg_temp.dq('overtime', x), format('={"id":"%s","status":"approved","amount_cents":6000}', x));
  perform pg_temp.inbox();
  -- Overtime already paid in a payroll run.
  x := pg_temp.mk('overtime', org, e_rep);
  update public.hr_overtime_records set payslip_id = slip where id = x;
  fails := fails || pg_temp.t(mgr, 'a manager on overtime in a paid run', pg_temp.dq('overtime', x), 'PAY_IN_PAID_RUN');
  update public.hr_overtime_records set status = 'cancelled', payslip_id = null where id = x;
  -- Whether a report's approved overtime was paid is pay. z is the record the admin approved: a manager who tries it again
  -- hears the same thing before it is on a paid payslip and after, while an owner or admin is still told about the paid run.
  if (select q.status || '/' || coalesce(q.payslip_id::text, '~') from public.hr_overtime_records q where q.id = z) is distinct from 'approved/~' then raise exception 'the approved overtime is not as planted'; end if;
  a := pg_temp.g(mgr, pg_temp.dq('overtime', z)) || ' ' || pg_temp.g(mgr, pg_temp.dq('overtime', z, false));
  update public.hr_overtime_records set payslip_id = slip where id = z;
  b := pg_temp.g(mgr, pg_temp.dq('overtime', z)) || ' ' || pg_temp.g(mgr, pg_temp.dq('overtime', z, false));
  if a is distinct from 'PAY_NOT_PENDING PAY_NOT_PENDING' or b is distinct from a then
    fails := fails || format('a manager again on approved overtime, before its run is paid and after: wanted PAY_NOT_PENDING each time, got "%s" then "%s"', a, b);
  end if;
  fails := fails || pg_temp.t(adm, 'an admin on approved overtime in a paid run', pg_temp.dq('overtime', z), 'PAY_IN_PAID_RUN')
    || pg_temp.t(own, 'the owner on approved overtime in a paid run', pg_temp.dq('overtime', z, false), 'PAY_IN_PAID_RUN');
  update public.hr_overtime_records set payslip_id = null where id = z;
  fails := fails || pg_temp.t(adm, 'an admin on approved overtime in no run', pg_temp.dq('overtime', z), 'PAY_NOT_PENDING');
  -- Owners and admins only, as before. A manager is answered as a colleague is.
  y := pg_temp.p('claim', e_rep);
  for r in select * from (values ('marks a report''s approved claim paid', format('public.hr_mark_claim_paid(%L, ''2026-01-10'', ''REF'')', y), 'PAY_NOT_FOUND'),
      ('takes the paid mark off a report''s claim', format('public.hr_unmark_claim_paid(%L)', y), 'PAY_NOT_FOUND'),
      ('corrects a report''s attendance', format('public.hr_correct_attendance(%L, ''2026-01-07'', ''present'', ''09:00'', ''18:00'', ''x'')', e_rep), 'ATT_NOT_ALLOWED'),
      ('sets a report''s leave entitlement', format('public.hr_set_leave_entitlement(%L, ''annual'', 2031, 20)', e_rep), 'LEAVE_NOT_ALLOWED'),
      ('files leave for a report', pg_temp.fq('leave', e_rep), 'LEAVE_NOT_ALLOWED'), ('files a claim for a report', pg_temp.fq('claim', e_rep), 'PAY_NOT_ALLOWED'),
      ('deletes a report', format('public.hr_delete_employee(%L, %L)', org, e_rep), '=null')) v(label, q, want) loop
    a := pg_temp.g(mgr, r.q); b := pg_temp.g(peer, r.q);
    if a is distinct from r.want or b is distinct from a then fails := fails || format('a manager %s: wanted what a colleague gets (%s), got %s and %s', r.label, r.want, a, b); end if;
  end loop;
  fails := fails || pg_temp.t(adm, 'an admin still marks that claim paid', format('public.hr_mark_claim_paid(%L, ''2026-01-10'', ''REF'') ->> ''status''', y), '="paid"');

  -- ---- 5. a manager who has stopped being one --------------------------------------------------------------
  for r in select * from (values ('inactive'), ('unlinked'), ('removed from the workspace')) v(how) loop
    w := array[pg_temp.mk('leave', org, e_rep), pg_temp.mk('time_off', org, e_rep), pg_temp.mk('claim', org, e_rep), pg_temp.mk('overtime', org, e_rep)];
    if r.how = 'inactive' then update public.hr_employees set status = 'inactive' where id = e_mgr;
    elsif r.how = 'unlinked' then update public.hr_employees set user_id = null where id = e_mgr;
    else delete from public.org_members where org_id = org and user_id = mgr; end if;
    a := pg_temp.sees(mgr, e_rep) || pg_temp.sees(mgr, e_unl);
    if a is distinct from '000000000000' then fails := fails || format('a manager now %s reads nothing of their reports: got %s', r.how, a); end if;
    for i in 1..4 loop
      fails := fails || pg_temp.t(mgr, format('a manager now %s on a report''s %s', r.how, kinds[i]), pg_temp.dq(kinds[i], w[i]), case when i <= 2 then 'LEAVE' else 'PAY' end || '_NOT_FOUND');
    end loop;
    fails := fails
      || pg_temp.t(mgr, format('a manager now %s has no team', r.how), format('public.hr_my_team(%L)', org), '=[]')
      || pg_temp.t(mgr, format('a manager now %s gets no team overtime', r.how), format('(select count(*) from public.hr_team_overtime(%L) x)', org), '=0')
      || pg_temp.t(mgr, format('a manager now %s counts nothing', r.how), format('public.hr_waiting_counts(%L)', org), zeros)
      || pg_temp.t(mgr, format('a manager now %s does not read the receipt', r.how), format('(select count(*) from storage.objects o where o.name = %L)', f_rep), '=0')
      || pg_temp.t(rep, format('rep files while their manager is %s', r.how), pg_temp.fq('leave', e_rep), '*');
    a := pg_temp.inbox();
    if a <> '' then fails := fails || format('a manager now %s is told nothing: got "%s"', r.how, a); end if;
    if (select count(*) from public.hr_employees x where x.id in (e_rep, e_unl) and x.reports_to = e_mgr) <> 2 then fails := fails || format('the line itself went when the manager became %s', r.how); end if;
    fails := fails || pg_temp.t(adm, format('an admin decides while the manager is %s', r.how), pg_temp.dq('leave', w[1]) || ' ->> ''status''', '="approved"');
    perform pg_temp.inbox();
    -- Back as they were, and seen to be.
    if r.how = 'inactive' then update public.hr_employees set status = 'active' where id = e_mgr;
    elsif r.how = 'unlinked' then update public.hr_employees set user_id = mgr where id = e_mgr;
    else
      if (select user_id from public.hr_employees where id = e_mgr) is not null then fails := fails || 'leaving the workspace did not unlink the employee record'::text; end if;
      insert into public.org_members (org_id, user_id, role) values (org, mgr, 'member');
      update public.hr_employees set user_id = mgr where id = e_mgr;
    end if;
    a := pg_temp.sees(mgr, e_rep);
    if a is distinct from '111101' then fails := fails || format('restored after "%s", the manager reads their report again: got %s', r.how, a); end if;
    fails := fails || pg_temp.t(mgr, format('restored after "%s", the manager decides', r.how), pg_temp.dq('time_off', w[2]) || ' ->> ''status''', '="approved"');
    update public.hr_claims set status = 'cancelled' where id = w[3];
    update public.hr_overtime_records set status = 'cancelled' where id = w[4];
    update public.hr_leave_requests q set status = 'cancelled' where q.employee_id = e_rep and q.status = 'pending';
    perform pg_temp.inbox();
  end loop;
  -- The line moves while a request waits.
  x := pg_temp.mk('claim', org, e_rep); y := pg_temp.mk('claim', org, e_rep);
  fails := fails || pg_temp.t(adm, 'an admin moves rep to the second manager', format('public.hr_set_reports_to(%L, %L)', e_rep, e_mgr2), format('={"id":"%s","reports_to":"%s"}', e_rep, e_mgr2))
    || pg_temp.t(mgr, 'the old manager on the waiting claim', pg_temp.dq('claim', x), 'PAY_NOT_FOUND')
    || pg_temp.t(mgr2, 'the new manager decides it', pg_temp.dq('claim', x) || ' ->> ''status''', '="approved"')
    || pg_temp.t(mgr, 'the old manager''s team', format('public.hr_my_team(%L)', org), format('=["%s"]', e_unl))
    || pg_temp.t(mgr2, 'the new manager''s team', format('public.hr_my_team(%L)', org), format('=["%s","%s"]', e_rep, e_peer2));
  a := pg_temp.sees(mgr, e_rep) || pg_temp.sees(mgr2, e_rep);
  if a is distinct from '000000111101' then fails := fails || format('after the move the old manager reads nothing of rep and the new one what a manager reads: got %s', a); end if;
  fails := fails || pg_temp.t(mgr, 'after the move the old manager''s team overtime has nothing of rep', format('(select count(*) from public.hr_team_overtime(%L) x where x.employee_id = %L)', org, e_rep), '=0')
    || pg_temp.t(mgr2, 'and the new manager''s has rep''s', format('(select count(*) > 0 from public.hr_team_overtime(%L) x where x.employee_id = %L)', org, e_rep), '=true');
  if (select q.decided_by from public.hr_leave_requests q where q.id = pg_temp.p('leave', e_rep)) is distinct from mgr or (select q.decided_by from public.hr_claims q where q.id = x) is distinct from mgr2 then
    fails := fails || 'a past decision lost its decider when the line moved, or the new one is not stamped'::text;
  end if;
  fails := fails || pg_temp.t(adm, 'an admin moves rep back', format('public.hr_set_reports_to(%L, %L) ->> ''reports_to''', e_rep, e_mgr), format('="%s"', e_mgr))
    || pg_temp.t(mgr, 'and the first manager decides the other claim', pg_temp.dq('claim', y, false) || ' ->> ''status''', '="rejected"');
  perform pg_temp.inbox();

  -- ---- 6. setting the line --------------------------------------------------------------------------------
  fails := fails || pg_temp.t(own, 'the owner sets a line', format('public.hr_set_reports_to(%L, %L)', e_peer, e_mgr), format('={"id":"%s","reports_to":"%s"}', e_peer, e_mgr));
  if (select x.reports_to from public.hr_employees x where x.id = e_peer) is distinct from e_mgr or (select x.updated_at from public.hr_employees x where x.id = e_peer) <= timestamptz '2020-01-01 00:00+00' then
    fails := fails || 'the line the owner set is not on the record, or the record''s updated_at did not move'::text;
  end if;
  fails := fails || pg_temp.t(adm, 'an admin changes it', format('public.hr_set_reports_to(%L, %L)', e_peer, e_mgr2), format('={"id":"%s","reports_to":"%s"}', e_peer, e_mgr2))
    || pg_temp.t(adm, 'an admin clears it', format('public.hr_set_reports_to(%L, null)', e_peer), format('={"id":"%s","reports_to":null}', e_peer))
    || pg_temp.t(adm, 'clearing a line that is not set', format('public.hr_set_reports_to(%L, null) -> ''reports_to''', e_peer), '=null')
    || pg_temp.t(adm, 'a loop of one', format('public.hr_set_reports_to(%L, %L)', e_rep, e_rep), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'a loop of two', format('public.hr_set_reports_to(%L, %L)', e_mgr, e_rep), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'a loop of three', format('public.hr_set_reports_to(%L, %L)', e_mgr, e_sub), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'an employee of another workspace, by an admin of this one', format('public.hr_set_reports_to(%L, null)', e_oth), 'EMP_NOT_FOUND')
    || pg_temp.t(adm, 'a made-up employee', format('public.hr_set_reports_to(%L, null)', nobody), 'EMP_NOT_FOUND')
    || pg_temp.t(outs, 'an outsider', format('public.hr_set_reports_to(%L, %L)', e_peer, e_mgr), 'EMP_NOT_FOUND')
    || pg_temp.t(mfa, 'a member who owes a second factor', format('public.hr_set_reports_to(%L, %L)', e_peer, e_mgr), 'EMP_NOT_FOUND')
    || pg_temp.t(null, 'no session', format('public.hr_set_reports_to(%L, %L)', e_peer, e_mgr), 'EMP_NOT_ALLOWED')
    || pg_temp.t(da, 'the demo''s admin', format('public.hr_set_reports_to(%L, null)', de1), 'EMP_NOT_ALLOWED')
    || pg_temp.t(dm, 'a member of the demo', format('public.hr_set_reports_to(%L, null)', de1), 'EMP_NOT_ALLOWED')
    || pg_temp.t(adm, 'a direct update of the column by an admin', format('update public.hr_employees set reports_to = %L where id = %L', e_mgr, e_peer), 'denied')
    || pg_temp.t(adm, 'a direct update that blanks the column', format('update public.hr_employees set reports_to = null where id = %L', e_rep), 'denied')
    || pg_temp.t(adm, 'a direct update of the name by an admin', format('update public.hr_employees set name = ''Peer Check'' where id = %L', e_peer), 'ok')
    || pg_temp.t(adm, 'a direct insert that names no manager', format('insert into public.hr_employees (org_id, employee_no, name) values (%L, ''D1'', ''Direct One'')', org), 'ok')
    || pg_temp.t(adm, 'a direct insert under another workspace''s employee', format('insert into public.hr_employees (org_id, employee_no, name, reports_to) values (%L, ''D2'', ''Direct Two'', %L)', org, e_oth), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'a direct insert under a made-up employee', format('insert into public.hr_employees (org_id, employee_no, name, reports_to) values (%L, ''D2'', ''Direct Two'', %L)', org, nobody), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'a direct insert under a manager of this workspace', format('insert into public.hr_employees (org_id, employee_no, name, reports_to) values (%L, ''D3'', ''Direct Three'', %L)', org, e_mgr), 'ok')
    || pg_temp.t(mgr, 'a member''s direct insert', format('insert into public.hr_employees (org_id, employee_no, name, reports_to) values (%L, ''D4'', ''Direct Four'', %L)', org, e_mgr), 'denied');
  foreach x in array array[mgr, rep, peer] loop
    fails := fails || pg_temp.t(x, 'a member of the workspace sets a line', format('public.hr_set_reports_to(%L, %L)', e_peer, e_mgr), 'EMP_NOT_ALLOWED');
  end loop;
  a := pg_temp.g(adm, format('public.hr_set_reports_to(%L, %L)', e_peer, e_oth)); b := pg_temp.g(adm, format('public.hr_set_reports_to(%L, %L)', e_peer, nobody));
  if a is distinct from 'EMP_BAD_MANAGER' or b is distinct from a then fails := fails || format('a manager in another workspace and a made-up manager are answered alike: got %s and %s', a, b); end if;
  select string_agg(x.employee_no || ':' || coalesce((select m.employee_no from public.hr_employees m where m.id = x.reports_to), '~'), ',' order by x.employee_no) into a from public.hr_employees x where x.org_id in (org, demo)
    and (x.org_id = org or x.id in (de1, de2));
  if a is distinct from 'D1:~,D3:R03,R01:~,R02:~,R03:~,R04:R03,R05:R04,R06:~,R07:R03,R08:~,R09:R08,R10:R02,R11:~,R12:R11,RL-CHECK-1:RL-CHECK-2,RL-CHECK-2:~' then fails := fails || format('the lines after all that: %s', a); end if;
  -- The guard holds for the table owner too.
  begin update public.hr_employees set reports_to = id where id = e_peer; a := 'ok'; exception when others then a := sqlerrm; end;
  begin update public.hr_employees set reports_to = e_sub where id = e_mgr; b := 'ok'; exception when others then b := sqlerrm; end;
  begin update public.hr_employees set reports_to = e_oth where id = e_peer; ctx := 'ok'; exception when others then ctx := sqlerrm; end;
  begin update public.hr_employees set reports_to = null where id = e_peer; k := 'ok'; exception when others then k := sqlerrm; end;
  if a || '/' || b || '/' || ctx || '/' || k is distinct from 'EMP_BAD_MANAGER/EMP_BAD_MANAGER/EMP_BAD_MANAGER/ok' then fails := fails || format('the table owner on a loop of one, a loop of three, another workspace, a blank: %s/%s/%s/%s', a, b, ctx, k); end if;
  -- A chain: c50 reports to nobody, c49 to c50, ... c1 to c2. The walk up from c1 is 50 steps, which is allowed; one more is not.
  chain := array(select gen_random_uuid() from generate_series(1, 52));
  for i in reverse 50..1 loop
    insert into public.hr_employees (id, org_id, employee_no, name, reports_to) values (chain[i], org, 'C' || i, 'Chain ' || i, case when i < 50 then chain[i + 1] end);
  end loop;
  insert into public.hr_employees (id, org_id, employee_no, name) values (chain[51], org, 'C51', 'Chain 51'), (chain[52], org, 'C52', 'Chain 52');
  fails := fails || pg_temp.t(adm, 'under a chain of 50', format('public.hr_set_reports_to(%L, %L) ->> ''reports_to''', chain[51], chain[1]), format('="%s"', chain[1]))
    || pg_temp.t(adm, 'under a chain of 51', format('public.hr_set_reports_to(%L, %L)', chain[52], chain[51]), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'the top of the chain under its bottom', format('public.hr_set_reports_to(%L, %L)', chain[50], chain[51]), 'EMP_BAD_MANAGER')
    || pg_temp.t(adm, 'under the second of the chain', format('public.hr_set_reports_to(%L, %L) ->> ''reports_to''', chain[52], chain[2]), format('="%s"', chain[2]));

  -- ---- delivery fails: the request and the decision are not lost ----------------------------------------------
  perform pg_temp.inbox();
  execute $f$
    create or replace function private.deliver_notification(p_user uuid, p_org uuid, p_event text, p_title text, p_body text, p_href text)
    returns void language plpgsql security definer set search_path = public as $b$ begin raise exception 'delivery is down'; end $b$
  $f$;
  for i in 1..4 loop
    a := pg_temp.g(rep, pg_temp.fq(kinds[i], e_rep));
    if left(a, 1) <> '=' or substr(a, 2)::jsonb ->> 'status' is distinct from 'pending' then
      fails := fails || format('delivery down: rep files %s: wanted the usual reply, got %s', kinds[i], a);
      continue;
    end if;
    x := (substr(a, 2)::jsonb ->> 'id')::uuid;
    fails := fails || pg_temp.t(mgr, format('delivery down: the manager decides the %s', kinds[i]), pg_temp.dq(kinds[i], x, false, 'ZZNOTEZZ') || ' ->> ''status''', '="rejected"');
  end loop;
  a := pg_temp.inbox();
  if a <> '' then fails := fails || format('with delivery down nothing is delivered: got "%s"', a); end if;

  -- ---- the manager's record is deleted ---------------------------------------------------------------------------
  fails := fails || pg_temp.t(adm, 'an admin deletes the manager''s record', format('public.hr_delete_employee(%L, %L) ->> ''id''', org, e_mgr), format('="%s"', e_mgr));
  select count(*) filter (where x.reports_to is null), count(*) into i, c from public.hr_employees x where x.id in (e_rep, e_unl) or x.employee_no = 'D3' and x.org_id = org;
  if i <> 3 or c <> 3 or exists (select 1 from public.hr_employees x where x.id = e_mgr) then fails := fails || format('with the manager gone %s of their %s reports have a blank line (3 of 3)', i, c); end if;
  if (select x.reports_to from public.hr_employees x where x.id = e_sub) is distinct from e_rep then fails := fails || 'deleting the manager touched a line that was not theirs'::text; end if;
  select count(*) into i from rl_planted p where p.emp = e_rep and p.basic and (exists (select 1 from public.hr_leave_requests q where q.id = p.id) or exists (select 1 from public.hr_leave_balances q where q.id = p.id)
    or exists (select 1 from public.hr_time_off_requests q where q.id = p.id) or exists (select 1 from public.hr_claims q where q.id = p.id) or exists (select 1 from public.hr_overtime_records q where q.id = p.id)
    or exists (select 1 from public.hr_attendance_days q where q.id = p.id));
  if i <> 6 then fails := fails || format('%s of rep''s six planted rows are left after their manager was deleted', i); end if;
  fails := fails || pg_temp.t(mgr, 'the user whose record is gone has no team', format('public.hr_my_team(%L)', org), '=[]');
  a := pg_temp.sees(mgr, e_rep);
  if a is distinct from '000000' then fails := fails || format('the user whose record is gone reads nothing of rep: got %s', a); end if;

  -- ---- what a notification may say -----------------------------------------------------------------------------------
  select count(*), count(*) filter (where s.said like '%123456%' or s.said like '%1,234%' or s.said like '%ZZREASONZZ%' or s.said like '%ZZNOTEZZ%' or s.said ~ '[0-9]{4}-[0-9]{2}'
    or s.said ~* '(travel|annual|medical|meals|equipment)' or s.said ~ '(RM|[0-9]{3})') into i, c from rl_seen s;
  if i < 40 or c <> 0 then fails := fails || format('%s of the %s notifications sent (40 or more) carry an amount, a reason, a note, a date or a category', c, i); end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_REPORTING_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
