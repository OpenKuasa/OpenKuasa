-- Rosters, hours and shift types (hr_save_roster, hr_save_hours, hr_save_shift_type, hr_archive_shift_type,
-- hr_ensure_shift_types, the manager read branch on hr_shifts and hr_timesheet_entries) access check. Leaves
-- nothing behind: the block always ends with RAISE, so every row and helper below is rolled back.
-- Read the message:
--   PEOPLE_ROSTERS_HOURS_CHECK PASSED ...   or   PEOPLE_ROSTERS_HOURS_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (it plants two employees in the demo,
-- which the scheduled re-seed rebuilds then), and not across midnight in
-- Malaysia (the hours cases count days back from today).
-- g(who, q, claims) runs q as one signed-in person and says what came back: a
-- statement gives ok, none (no row touched) or denied; a call gives =<json> or
-- the refusal. t(who, what, q, want, claims) is g compared with want ('*' = it
-- must go through, whatever it returns).
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); amfa uuid := gen_random_uuid(); mgr uuid := gen_random_uuid();
  rep uuid := gen_random_uuid(); peer uuid := gen_random_uuid(); ina uuid := gen_random_uuid(); mfa uuid := gen_random_uuid();
  outs uuid := gen_random_uuid(); da uuid := gen_random_uuid(); dm uuid := gen_random_uuid();
  e_own uuid := gen_random_uuid(); e_mgr uuid := gen_random_uuid(); e_rep uuid := gen_random_uuid(); e_peer uuid := gen_random_uuid();
  e_ina uuid := gen_random_uuid(); e_mfa uuid := gen_random_uuid(); e_unl uuid := gen_random_uuid(); e_old uuid := gen_random_uuid();
  e_oth uuid := gen_random_uuid(); de1 uuid := gen_random_uuid(); de2 uuid := gen_random_uuid();
  fresh uuid := gen_random_uuid(); fresh2 uuid := gen_random_uuid(); fown uuid := gen_random_uuid();   -- workspaces with no shift types yet
  t_m uuid; t_n uuid; t_o uuid; t_oth uuid; t_early uuid; t_new uuid; t_demo uuid;
  wk date := date '2030-01-07';          -- a Monday
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  mon date;                               -- this week's Monday in Malaysia
  q text; a text; i int; ctx text; fails text[] := '{}';
  roster_fn text := 'public.hr_save_roster(uuid,date,jsonb)';
  hours_fn text := 'public.hr_save_hours(uuid,date,numeric,numeric)';
  type_fns text[] := array['public.hr_save_shift_type(uuid,uuid,text,time without time zone,time without time zone,boolean,text)',
    'public.hr_archive_shift_type(uuid,boolean)', 'public.hr_ensure_shift_types(uuid)'];
  t text;
begin
  begin
  mon := date_trunc('week', today::timestamp)::date;

  -- ---- 0. the catalogue ----------------------------------------------------------------
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure(roster_fn), to_regprocedure(hours_fn))
    and p.prosecdef and p.provolatile = 'v' and p.prorettype = 'jsonb'::regtype
    and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 2 then fails := fails || format('%s of 2 functions are definer functions returning jsonb on a fixed search path that signed-in users, and only they, may call', i); end if;
  select count(*) into i from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname in ('hr_save_roster', 'hr_save_hours');
  if i <> 2 then fails := fails || format('%s functions carry the two names, expected 2 (no second version with other arguments)', i); end if;
  foreach t in array array['hr_shifts', 'hr_timesheet_entries'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
      fails := fails || format('%s has a write grant', t);
    end if;
    select count(*) into i from pg_policies p where p.schemaname = 'public' and p.tablename = t;
    if i <> 2 or (select p.qual from pg_policies p where p.schemaname = 'public' and p.tablename = t and p.policyname = t || '_select' and p.cmd = 'SELECT')
       not like '%is_manager_of(employee_id)%' then
      fails := fails || format('%s should have its two policies (%s) and a read rule with the manager branch', t, i);
    end if;
  end loop;
  select count(*) into i from pg_constraint k where k.conrelid = 'public.hr_timesheet_entries'::regclass and k.contype = 'c'
    and replace(pg_get_constraintdef(k.oid), ' ', '') like '%billable_hours<=hours%';
  if i < 1 then fails := fails || 'hr_timesheet_entries has no check that billable hours are at most the hours'::text; end if;
  -- Shift types: three definer functions, a table every member reads and nobody writes directly, and every
  -- shift pointing at one (the old text column kept, no longer required).
  select count(*) into i from pg_proc p where p.oid = any(array(select to_regprocedure(x) from unnest(type_fns) x))
    and p.prosecdef and p.prorettype = 'jsonb'::regtype and p.proconfig @> array['search_path=public']
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 3 then fails := fails || format('%s of 3 shift type functions are definer functions returning jsonb for signed-in users only', i); end if;
  if to_regclass('public.hr_shift_types') is null then
    fails := fails || 'hr_shift_types does not exist'::text;
  else
    if has_table_privilege('authenticated', 'public.hr_shift_types', 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('authenticated', 'public.hr_shift_types', 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.hr_shift_types', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or not has_table_privilege('authenticated', 'public.hr_shift_types', 'SELECT') then
      fails := fails || 'hr_shift_types should be read by signed-in users and written by none'::text;
    end if;
    select count(*) into i from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_shift_types';
    if i <> 2 or (select p.qual from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_shift_types' and p.policyname = 'hr_shift_types_select')
       not like '%is_org_member(org_id)%' then
      fails := fails || format('hr_shift_types should have its two policies (%s) and a members'' read rule', i);
    end if;
  end if;
  select count(*) into i from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'hr_shifts'
    and ((c.column_name = 'shift_type_id' and c.is_nullable = 'NO') or (c.column_name = 'shift' and c.is_nullable = 'YES'));
  if i <> 2 then fails := fails || 'hr_shifts should have a required shift_type_id and an optional shift'::text; end if;
  select count(*) into i from public.hr_shifts s where not exists (select 1 from public.hr_shift_types t where t.id = s.shift_type_id and t.org_id = s.org_id);
  if i <> 0 then fails := fails || format('%s existing shifts point at no type of their own workspace', i); end if;
  select count(*) into i from public.hr_shifts s join public.hr_shift_types t on t.id = s.shift_type_id where s.shift is distinct from t.default_kind;
  if i <> 0 then fails := fails || format('%s existing shifts have an old kind that is not their type''s', i); end if;
  -- Any private hr_ helper stays closed.
  select count(*) into i from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'private' and p.proname like 'hr\_%'
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
  if i <> 0 then fails := fails || format('%s private hr_ helpers can be called directly', i); end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  -- ---- helpers ----------------------------------------------------------------------------
  create temp table rh_ctx (org uuid) on commit drop;
  insert into rh_ctx values (org);
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
  -- A roster call on org for week wk with these cells.
  execute $f$
    create function pg_temp.roster(o uuid, w date, cells jsonb) returns text language sql as $b$
      select format('public.hr_save_roster(%L, %L, %L::jsonb)', o, w, cells)
    $b$
  $f$;
  execute $f$
    create function pg_temp.cell(e uuid, d date, k text) returns jsonb language sql as $b$
      -- k: a default kind (that type of the employee's workspace, else of the main one), a type id, null to
      -- clear, or any other word for a type that does not exist.
      select jsonb_build_object('employee_id', e, 'work_date', d, 'shift_type_id',
        case
          when k is null then null
          when k in ('morning', 'night', 'off') then (
            select t.id from public.hr_shift_types t
            where t.default_kind = k and t.org_id = coalesce((select x.org_id from public.hr_employees x where x.id = e), (select c.org from rh_ctx c)))
          when k ~ '^[0-9a-f-]{36}$' then k::uuid
          else gen_random_uuid()
        end)
    $b$
  $f$;
  execute $f$
    create function pg_temp.hours(e uuid, d date, h numeric, b numeric) returns text language sql as $b$
      select format('public.hr_save_hours(%L, %L, %s, %s)', e, d, coalesce(h::text, 'null'), coalesce(b::text, 'null'))
    $b$
  $f$;
  execute $f$
    create function pg_temp.shift_of(e uuid, d date) returns text language sql as $b$
      select coalesce((select coalesce(t.default_kind, t.name) from public.hr_shifts s join public.hr_shift_types t on t.id = s.shift_type_id
        where s.employee_id = e and s.work_date = d), '-')
    $b$
  $f$;
  execute $f$
    create function pg_temp.hours_of(e uuid, d date) returns text language sql as $b$
      select coalesce((select x.hours::text || '/' || x.billable_hours::text from public.hr_timesheet_entries x where x.employee_id = e and x.work_date = d), '-')
    $b$
  $f$;

  -- ---- the cast ---------------------------------------------------------------------------
  -- org: an owner (linked), an admin, an admin who owes a second factor, a manager (rep reports to them), a plain
  -- member (peer), a member linked to an inactive record, a member who owes a second factor; an active employee
  -- linked to nobody and an inactive one. oth: outs, with e_oth. The demo: da (an admin there) and dm (a member
  -- linked to de1).
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u || '@rosters-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, amfa, mgr, rep, peer, ina, mfa, outs, da, dm]) u;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now()), (gen_random_uuid(), amfa, 'totp', 'verified', now(), now());
  insert into public.orgs (id, name) values (org, 'Rosters Check Sdn Bhd'), (oth, 'Rosters Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, amfa, 'admin'),
    (org, mgr, 'member'), (org, rep, 'member'), (org, peer, 'member'), (org, ina, 'member'), (org, mfa, 'member'), (oth, outs, 'owner');
  insert into public.hr_employees (id, org_id, employee_no, name, user_id, status) values
    (e_own, org, 'R01', 'Roster Owner', own, 'active'), (e_mgr, org, 'R02', 'Roster Manager', mgr, 'active'),
    (e_rep, org, 'R03', 'Roster Report', rep, 'active'), (e_peer, org, 'R04', 'Roster Peer', peer, 'active'),
    (e_ina, org, 'R05', 'Roster Inactive', ina, 'inactive'), (e_mfa, org, 'R06', 'Roster Mfa', mfa, 'active'),
    (e_unl, org, 'R07', 'Roster Unlinked', null, 'active'), (e_old, org, 'R08', 'Roster Old', null, 'inactive'),
    (e_oth, oth, 'O01', 'Other Person', null, 'active');
  update public.hr_employees set reports_to = e_mgr where id = e_rep;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (fown, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', fown || '@rosters-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (fresh, 'Rosters Fresh Sdn Bhd'), (fresh2, 'Rosters Fresh Two Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (fresh, fown, 'owner'), (fresh2, fown, 'owner');
  perform private.hr_ensure_shift_types(org);
  perform private.hr_ensure_shift_types(oth);
  select t.id into t_m from public.hr_shift_types t where t.org_id = org and t.default_kind = 'morning';
  select t.id into t_n from public.hr_shift_types t where t.org_id = org and t.default_kind = 'night';
  select t.id into t_o from public.hr_shift_types t where t.org_id = org and t.default_kind = 'off';
  select t.id into t_oth from public.hr_shift_types t where t.org_id = oth and t.default_kind = 'morning';
  if demo is not null then
    insert into public.org_members (org_id, user_id, role) values (demo, da, 'admin'), (demo, dm, 'member');
    insert into public.hr_employees (id, org_id, employee_no, name, user_id, status) values
      (de1, demo, 'DCHK1', 'Demo Check One', dm, 'active'), (de2, demo, 'DCHK2', 'Demo Check Two', da, 'active');
  end if;

  -- ---- 1. the roster: owners and admins save a week ----------------------------------------
  q := pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'morning'), pg_temp.cell(e_rep, wk + 1, 'night'),
    pg_temp.cell(e_peer, wk + 2, 'off'), pg_temp.cell(e_unl, wk + 6, 'morning')));
  fails := fails || pg_temp.t(own, 'the owner saves a week', q, '={"week":"2030-01-07","saved":4,"removed":0}');
  a := pg_temp.shift_of(e_peer, wk) || pg_temp.shift_of(e_rep, wk + 1) || pg_temp.shift_of(e_peer, wk + 2) || pg_temp.shift_of(e_unl, wk + 6);
  if a is distinct from 'morningnightoffmorning' then fails := fails || format('after the owner''s save the four cells read %s', a); end if;
  select count(*) into i from public.hr_shifts s where s.employee_id in (e_peer, e_rep, e_unl) and s.org_id = org;
  if i <> 4 then fails := fails || format('the owner''s save wrote %s rows, wanted 4', i); end if;
  select count(*) into i from public.hr_shifts s join public.hr_shift_types t on t.id = s.shift_type_id
  where s.org_id = org and s.shift is not distinct from t.default_kind;
  if i <> 4 then fails := fails || format('%s of 4 saved shifts carry their type''s kind in the old column', i); end if;
  q := pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'night'), pg_temp.cell(e_peer, wk + 2, null),
    pg_temp.cell(e_rep, wk + 1, 'night'), pg_temp.cell(e_peer, wk + 3, null)));
  fails := fails || pg_temp.t(adm, 'an admin changes one, clears one, leaves one as it was and clears an empty one', q, '={"week":"2030-01-07","saved":1,"removed":1}');
  a := pg_temp.shift_of(e_peer, wk) || pg_temp.shift_of(e_peer, wk + 2) || pg_temp.shift_of(e_rep, wk + 1);
  if a is distinct from 'night-night' then fails := fails || format('after the admin''s save the cells read %s', a); end if;
  fails := fails
    || pg_temp.t(own, 'an empty list saves nothing', pg_temp.roster(org, wk, '[]'), '={"week":"2030-01-07","saved":0,"removed":0}')
    || pg_temp.t(amfa, 'an admin who owes a second factor is refused', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'off'))), 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(amfa, 'and saves with the second factor given', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk + 4, 'off'))), '*', '{"aal":"aal2"}');

  -- ---- 2. the roster: nobody else -------------------------------------------------------------
  q := pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk + 5, 'morning')));
  fails := fails
    || pg_temp.t(peer, 'a member cannot save the roster', q, 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(peer, 'a member cannot save their own shift', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk + 5, 'off'))), 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(mgr, 'a manager cannot save the roster, even for a report', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_rep, wk + 5, 'off'))), 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(outs, 'the owner of another workspace cannot save this one''s roster', q, 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(null, 'no session cannot save', q, 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(own, 'no workspace named', pg_temp.roster(null, wk, '[]'), 'ROSTER_NOT_ALLOWED')
    || pg_temp.t(peer, 'a member cannot insert a shift directly', format('insert into public.hr_shifts (org_id, employee_id, work_date, shift) values (%L, %L, %L, ''off'')', org, e_peer, wk + 5), 'denied')
    || pg_temp.t(own, 'not even the owner writes the table directly', format('update public.hr_shifts set shift = ''off'' where employee_id = %L', e_peer), 'denied')
    || pg_temp.t(own, 'nor deletes from it', format('delete from public.hr_shifts where employee_id = %L', e_peer), 'denied');
  if pg_temp.shift_of(e_peer, wk + 5) <> '-' then fails := fails || 'a refused roster call still wrote a shift'::text; end if;

  -- ---- 3. the roster: what is refused as input -------------------------------------------------
  fails := fails
    || pg_temp.t(own, 'a week that does not start on a Monday', pg_temp.roster(org, wk + 1, jsonb_build_array(pg_temp.cell(e_peer, wk + 1, 'off'))), 'ROSTER_NOT_MONDAY')
    || pg_temp.t(own, 'a Sunday is not a Monday either', pg_temp.roster(org, wk - 1, '[]'), 'ROSTER_NOT_MONDAY')
    || pg_temp.t(own, 'no week', pg_temp.roster(org, null, '[]'), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a day after the week', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk + 7, 'off'))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a day before the week', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk - 1, 'off'))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a shift type that does not exist', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'evening'))), 'ROSTER_BAD_SHIFT_TYPE')
    || pg_temp.t(own, 'another workspace''s shift type', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, t_oth::text))), 'ROSTER_BAD_SHIFT_TYPE')
    || pg_temp.t(own, 'a type id that is not a uuid', pg_temp.roster(org, wk, format('[{"employee_id":"%s","work_date":"2030-01-07","shift_type_id":"x"}]', e_peer)::jsonb), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'the same cell twice', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'off'), pg_temp.cell(e_peer, wk, 'night'))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a cell with no shift type key', pg_temp.roster(org, wk, jsonb_build_array(jsonb_build_object('employee_id', e_peer, 'work_date', wk, 'shift', 'off'))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'an id that is not a uuid', pg_temp.roster(org, wk, '[{"employee_id":"nope","work_date":"2030-01-07","shift_type_id":null}]'), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a date that is not a date', pg_temp.roster(org, wk, format('[{"employee_id":"%s","work_date":"2030-02-30","shift_type_id":null}]', e_peer)::jsonb), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'cells that are not a list', pg_temp.roster(org, wk, '{"a":1}'), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a cell that is not an object', pg_temp.roster(org, wk, '[1]'), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'an employee of another workspace', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_oth, wk, 'off'))), 'ROSTER_BAD_EMPLOYEE')
    || pg_temp.t(own, 'an employee that does not exist', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(gen_random_uuid(), wk, 'off'))), 'ROSTER_BAD_EMPLOYEE')
    || pg_temp.t(own, 'an inactive employee', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_old, wk, 'off'))), 'ROSTER_INACTIVE_EMPLOYEE')
    || pg_temp.t(own, 'one bad cell refuses the whole save', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk + 5, 'off'), pg_temp.cell(e_oth, wk, 'off'))), 'ROSTER_BAD_EMPLOYEE');
  if pg_temp.shift_of(e_peer, wk + 5) <> '-' then fails := fails || 'a refused save kept its good cell'::text; end if;
  select count(*) into i from public.hr_shifts s where s.employee_id = e_oth;
  if i <> 0 then fails := fails || 'a shift was written for another workspace''s employee'::text; end if;

  -- ---- 4. the demo is read only ----------------------------------------------------------------
  if demo is not null then
    fails := fails
      || pg_temp.t(da, 'an admin in the demo cannot save its roster', pg_temp.roster(demo, wk, jsonb_build_array(pg_temp.cell(de1, wk, 'off'))), 'ROSTER_NOT_ALLOWED')
      || pg_temp.t(dm, 'a demo member cannot save their hours', pg_temp.hours(de1, today, 8, 0), 'HOURS_NOT_ALLOWED')
      || pg_temp.t(da, 'an admin in the demo cannot save anyone''s hours', pg_temp.hours(de1, today, 8, 0), 'HOURS_NOT_ALLOWED')
      || pg_temp.t(da, 'nor their own', pg_temp.hours(de2, today, 8, 0), 'HOURS_NOT_ALLOWED');
  end if;

  -- ---- 5. hours: staff record their own, this week and last ---------------------------------
  fails := fails
    || pg_temp.t(peer, 'a member saves their own hours for today', pg_temp.hours(e_peer, today, 8, 2), format('={"employee_id":"%s","work_date":"%s","hours":8.0,"billable_hours":2.0}', e_peer, today))
    || pg_temp.t(peer, 'and changes them', pg_temp.hours(e_peer, today, 7.5, null), format('={"employee_id":"%s","work_date":"%s","hours":7.5,"billable_hours":0.0}', e_peer, today))
    || pg_temp.t(peer, 'and last Monday', pg_temp.hours(e_peer, mon - 7, 6, 6), '*')
    || pg_temp.t(peer, 'not the Sunday before that', pg_temp.hours(e_peer, mon - 8, 6, 0), 'HOURS_OUTSIDE_WINDOW')
    || pg_temp.t(peer, 'not four weeks back', pg_temp.hours(e_peer, mon - 28, 6, 0), 'HOURS_OUTSIDE_WINDOW')
    || pg_temp.t(peer, 'not a day still to come', pg_temp.hours(e_peer, today + 1, 6, 0), 'HOURS_FUTURE_DAY')
    || pg_temp.t(peer, 'not for someone else', pg_temp.hours(e_rep, today, 6, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(peer, 'not for someone in another workspace', pg_temp.hours(e_oth, today, 6, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(mgr, 'a manager cannot save a report''s hours', pg_temp.hours(e_rep, today, 6, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(mgr, 'but saves their own', pg_temp.hours(e_mgr, today, 9, 0), '*')
    || pg_temp.t(ina, 'a member whose record is inactive cannot', pg_temp.hours(e_ina, today, 6, 0), 'HOURS_INACTIVE_EMPLOYEE')
    || pg_temp.t(mfa, 'a member who owes a second factor cannot', pg_temp.hours(e_mfa, today, 6, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(mfa, 'and can with it given', pg_temp.hours(e_mfa, today, 6, 0), '*', '{"aal":"aal2"}')
    || pg_temp.t(null, 'no session cannot', pg_temp.hours(e_peer, today, 6, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(peer, 'an employee that does not exist', pg_temp.hours(gen_random_uuid(), today, 6, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(peer, 'a member cannot insert hours directly', format('insert into public.hr_timesheet_entries (org_id, employee_id, work_date, hours) values (%L, %L, %L, 1)', org, e_peer, today - 1), 'denied')
    || pg_temp.t(peer, 'nor change them directly', format('update public.hr_timesheet_entries set hours = 1 where employee_id = %L', e_peer), 'denied');
  a := pg_temp.hours_of(e_peer, today) || ' ' || pg_temp.hours_of(e_peer, mon - 7) || ' ' || pg_temp.hours_of(e_peer, mon - 8) || ' ' || pg_temp.hours_of(e_rep, today);
  if a is distinct from '7.5/0.0 6.0/6.0 - -' then fails := fails || format('after the members'' saves the entries read %s', a); end if;

  -- ---- 6. hours: what is refused as input ----------------------------------------------------
  fails := fails
    || pg_temp.t(peer, 'billable above the hours', pg_temp.hours(e_peer, today, 4, 4.5), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'negative hours', pg_temp.hours(e_peer, today, -1, 0), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'negative billable', pg_temp.hours(e_peer, today, 4, -0.5), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'more than 24 hours', pg_temp.hours(e_peer, today, 24.5, 0), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'not in steps of half an hour', pg_temp.hours(e_peer, today, 7.3, 0), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'billable not in steps of half an hour', pg_temp.hours(e_peer, today, 8, 1.25), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'billable with no hours', pg_temp.hours(e_peer, today, null, 1), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'no day', pg_temp.hours(e_peer, null, 8, 0), 'HOURS_BAD_INPUT')
    || pg_temp.t(peer, 'exactly 24 with all of it billable is fine', pg_temp.hours(e_peer, today - 0, 24, 24), '*');
  -- Clearing deletes the entry; clearing a day with none is fine too.
  fails := fails
    || pg_temp.t(peer, 'a member clears their hours for today', pg_temp.hours(e_peer, today, null, null), format('={"employee_id":"%s","work_date":"%s","hours":null,"billable_hours":null}', e_peer, today))
    || pg_temp.t(peer, 'and clears a day that has none', pg_temp.hours(e_peer, today, null, null), '*');
  if pg_temp.hours_of(e_peer, today) <> '-' then fails := fails || 'clearing a day left its entry'::text; end if;

  -- ---- 7. hours: owners and admins correct anyone, any past day -------------------------------
  fails := fails
    || pg_temp.t(own, 'the owner saves a report''s hours four weeks back', pg_temp.hours(e_rep, mon - 28, 8, 3), '*')
    || pg_temp.t(adm, 'an admin saves an unlinked employee''s hours a year back', pg_temp.hours(e_unl, today - 365, 5, 0), '*')
    || pg_temp.t(adm, 'and an inactive employee''s', pg_temp.hours(e_old, today - 3, 5, 0), '*')
    || pg_temp.t(adm, 'but not a day still to come', pg_temp.hours(e_rep, today + 1, 5, 0), 'HOURS_FUTURE_DAY')
    || pg_temp.t(own, 'nor hours for another workspace''s employee', pg_temp.hours(e_oth, today, 5, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(outs, 'and that workspace''s owner cannot save this one''s', pg_temp.hours(e_rep, today, 5, 0), 'HOURS_NOT_ALLOWED')
    || pg_temp.t(amfa, 'an admin who owes a second factor cannot', pg_temp.hours(e_rep, today, 5, 0), 'HOURS_NOT_ALLOWED');
  a := pg_temp.hours_of(e_rep, mon - 28) || ' ' || pg_temp.hours_of(e_unl, today - 365) || ' ' || pg_temp.hours_of(e_old, today - 3);
  if a is distinct from '8.0/3.0 5.0/0.0 5.0/0.0' then fails := fails || format('after the owner''s and admin''s saves the entries read %s', a); end if;

  -- ---- 8. reading: a manager reads their team's rows, nobody else's ---------------------------
  insert into public.hr_timesheet_entries (org_id, employee_id, work_date, hours) values (org, e_rep, wk, 8), (org, e_peer, wk, 8);
  fails := fails
    || pg_temp.t(mgr, 'a manager reads their report''s shifts', format('(select count(*) from public.hr_shifts s where s.employee_id = %L)', e_rep), '=1')
    || pg_temp.t(mgr, 'and their report''s hours', format('(select count(*) from public.hr_timesheet_entries x where x.employee_id = %L)', e_rep), '=2')
    || pg_temp.t(mgr, 'but no one else''s shifts', format('(select count(*) from public.hr_shifts s where s.employee_id in (%L, %L))', e_peer, e_unl), '=0')
    || pg_temp.t(mgr, 'nor hours', format('(select count(*) from public.hr_timesheet_entries x where x.employee_id in (%L, %L))', e_peer, e_unl), '=0')
    || pg_temp.t(mgr, 'and cannot change a report''s shift directly', format('update public.hr_shifts set shift = ''off'' where employee_id = %L', e_rep), 'denied')
    || pg_temp.t(mgr, 'nor a report''s hours', format('delete from public.hr_timesheet_entries where employee_id = %L', e_rep), 'denied')
    || pg_temp.t(rep, 'a report reads their own', format('(select count(*) from public.hr_timesheet_entries x where x.employee_id = %L)', e_rep), '=2')
    || pg_temp.t(rep, 'and not their manager''s', format('(select count(*) from public.hr_timesheet_entries x where x.employee_id = %L)', e_mgr), '=0')
    || pg_temp.t(peer, 'a member reads no one else''s shifts', format('(select count(*) from public.hr_shifts s where s.employee_id = %L)', e_rep), '=0')
    || pg_temp.t(outs, 'an outsider reads nothing', format('(select count(*) from public.hr_timesheet_entries x where x.org_id = %L)', org), '=0')
    || pg_temp.t(adm, 'an admin reads every shift in the workspace', format('(select count(*) from public.hr_shifts s where s.org_id = %L)', org), '=4');

  -- ---- 9. shift types -------------------------------------------------------------------------
  -- The defaults: three, made once, and only for a workspace with no types.
  select string_agg(t.name || ' ' || coalesce(to_char(t.start_time, 'HH24:MI'), '-') || ' ' || coalesce(to_char(t.end_time, 'HH24:MI'), '-') || ' ' || t.is_off::text, ', ' order by t.default_kind)
    into a from public.hr_shift_types t where t.org_id = org;
  if a is distinct from 'Morning 09:00 18:00 false, Night 21:00 06:00 false, Off - - true' then fails := fails || format('the default types read %s', a); end if;
  fails := fails
    || pg_temp.t(own, 'the defaults are not added twice', format('public.hr_ensure_shift_types(%L)', org), '={"added":0}')
    || pg_temp.t(fown, 'a new workspace''s owner gets the three defaults', format('public.hr_ensure_shift_types(%L)', fresh2), '={"added":3}')
    || pg_temp.t(fown, 'once', format('public.hr_ensure_shift_types(%L)', fresh2), '={"added":0}')
    -- A workspace whose first type is a custom one gets the defaults with it.
    || pg_temp.t(fown, 'a first custom type', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', fresh, 'Custom', 'rose'), '*')
    || pg_temp.t(fown, 'comes with the three defaults', format('(select count(*) from public.hr_shift_types t where t.org_id = %L)', fresh), '=4')
    || pg_temp.t(fown, 'which are then not added again', format('public.hr_ensure_shift_types(%L)', fresh), '={"added":0}')
    || pg_temp.t(peer, 'a member cannot ask for them', format('public.hr_ensure_shift_types(%L)', org), 'SHIFT_TYPE_NOT_ALLOWED');

  -- Owners and admins add, change and archive types; times may cross midnight.
  fails := fails || pg_temp.t(own, 'the owner adds a type, its name trimmed', format('public.hr_save_shift_type(%L, null, %L, %L, %L, false, %L)', org, ' Split ', '07:00', '11:00', 'teal'), '*');
  fails := fails || pg_temp.t(own, 'and it is there', format('(select count(*) from public.hr_shift_types t where t.org_id = %L and t.name = %L and t.color = %L)', org, 'Split', 'teal'), '=1');
  select t.id into t_early from public.hr_shift_types t where t.org_id = org and t.name = 'Split';
  fails := fails
    || pg_temp.t(adm, 'an admin adds a shift that crosses midnight', format('public.hr_save_shift_type(%L, null, %L, %L, %L, false, %L)', org, 'Graveyard', '22:00', '06:00', 'slate'), '*')
    || pg_temp.t(adm, 'and one with no times', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Training', 'amber'), '*')
    || pg_temp.t(adm, 'and another off type', format('public.hr_save_shift_type(%L, null, %L, null, null, true, %L)', org, 'Rest day', 'stone'), '*')
    || pg_temp.t(own, 'the owner renames a type and changes its times',
         format('public.hr_save_shift_type(%L, %L, %L, %L, %L, false, %L)', org, t_early, 'Early', '06:00', '14:00', 'sky'),
         format('={"id":"%s","name":"Early","start_time":"06:00:00","end_time":"14:00:00","is_off":false,"color":"sky","archived":false}', t_early))
    || pg_temp.t(own, 'and renames a default', format('public.hr_save_shift_type(%L, %L, %L, %L, %L, false, %L)', org, t_n, 'Late', '21:00', '06:00', 'blue'), '*')
    || pg_temp.t(adm, 'a name already in use, whatever its capitals and spaces', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, ' early ', 'sky'), 'SHIFT_TYPE_EXISTS')
    || pg_temp.t(adm, 'renaming onto another type''s name', format('public.hr_save_shift_type(%L, %L, %L, null, null, true, %L)', org, t_o, 'Morning', 'stone'), 'SHIFT_TYPE_EXISTS')
    || pg_temp.t(adm, 'an off type with times', format('public.hr_save_shift_type(%L, null, %L, %L, %L, true, %L)', org, 'Odd', '09:00', '17:00', 'stone'), 'SHIFT_TYPE_BAD_INPUT')
    || pg_temp.t(adm, 'a start with no end', format('public.hr_save_shift_type(%L, null, %L, %L, null, false, %L)', org, 'Odd', '09:00', 'stone'), 'SHIFT_TYPE_BAD_INPUT')
    || pg_temp.t(adm, 'a colour not in the palette', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Odd', 'purple'), 'SHIFT_TYPE_BAD_INPUT')
    || pg_temp.t(adm, 'violet is not in it either', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Odd', 'violet'), 'SHIFT_TYPE_BAD_INPUT')
    || pg_temp.t(adm, 'an empty name', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, '  ', 'sky'), 'SHIFT_TYPE_BAD_INPUT')
    || pg_temp.t(adm, 'a name over 40 characters', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, repeat('n', 41), 'sky'), 'SHIFT_TYPE_BAD_INPUT')
    || pg_temp.t(adm, 'another workspace''s type, named through this one', format('public.hr_save_shift_type(%L, %L, %L, null, null, false, %L)', org, t_oth, 'Mine now', 'sky'), 'SHIFT_TYPE_NOT_FOUND');
  select count(*) into i from public.hr_shift_types t where t.org_id = org and t.name = 'Graveyard' and t.end_time < t.start_time;
  if i <> 1 then fails := fails || 'the cross-midnight type was not kept with its end before its start'::text; end if;
  if (select t.default_kind from public.hr_shift_types t where t.id = t_n) is distinct from 'night' then fails := fails || 'renaming a default lost its kind'::text; end if;

  -- Nobody else.
  fails := fails
    || pg_temp.t(peer, 'a member cannot add a type', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Mine', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
    || pg_temp.t(mgr, 'a manager cannot add a type', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Mine', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
    || pg_temp.t(peer, 'a member cannot rename one', format('public.hr_save_shift_type(%L, %L, %L, null, null, false, %L)', org, t_m, 'Mine', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
    || pg_temp.t(outs, 'another workspace''s owner cannot add one here', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Mine', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
    || pg_temp.t(null, 'no session cannot', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Mine', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
    || pg_temp.t(amfa, 'an admin who owes a second factor cannot', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', org, 'Mine', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
    || pg_temp.t(peer, 'a member cannot archive one', format('public.hr_archive_shift_type(%L, true)', t_m), 'SHIFT_TYPE_NOT_FOUND')
    || pg_temp.t(outs, 'nor can an outsider', format('public.hr_archive_shift_type(%L, true)', t_m), 'SHIFT_TYPE_NOT_FOUND')
    || pg_temp.t(own, 'an id that is no type', format('public.hr_archive_shift_type(%L, true)', gen_random_uuid()), 'SHIFT_TYPE_NOT_FOUND')
    || pg_temp.t(peer, 'a member cannot write the table directly', format('insert into public.hr_shift_types (org_id, name) values (%L, ''Mine'')', org), 'denied')
    || pg_temp.t(own, 'nor can the owner', format('update public.hr_shift_types set name = ''Mine'' where id = %L', t_m), 'denied');

  -- Everyone in the workspace reads the types; nobody outside it.
  select count(*) into i from public.hr_shift_types t where t.org_id = org;
  fails := fails
    || pg_temp.t(peer, 'a member reads every type of the workspace', format('(select count(*) from public.hr_shift_types t where t.org_id = %L)', org), format('=%s', i))
    || pg_temp.t(mgr, 'a manager too', format('(select count(*) from public.hr_shift_types t where t.org_id = %L)', org), format('=%s', i))
    || pg_temp.t(outs, 'an outsider reads none', format('(select count(*) from public.hr_shift_types t where t.org_id = %L)', org), '=0');

  -- Archiving: the past row keeps the type; a new save cannot pick it; it cannot be changed; its name is free again.
  fails := fails || pg_temp.t(own, 'a shift on the Early type, before it is archived', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_mgr, wk, t_early::text))), '*');
  fails := fails
    || pg_temp.t(adm, 'an admin archives Early', format('public.hr_archive_shift_type(%L, true)', t_early), '*')
    || pg_temp.t(own, 'an archived type cannot be used in a new save', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_mgr, wk + 1, t_early::text))), 'ROSTER_ARCHIVED_SHIFT_TYPE')
    || pg_temp.t(own, 'nor set again on the cell that has it', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_mgr, wk, t_early::text))), 'ROSTER_ARCHIVED_SHIFT_TYPE')
    || pg_temp.t(own, 'an archived type cannot be changed', format('public.hr_save_shift_type(%L, %L, %L, null, null, false, %L)', org, t_early, 'Earlier', 'sky'), 'SHIFT_TYPE_ARCHIVED')
    || pg_temp.t(own, 'its name is free for a new type', format('public.hr_save_shift_type(%L, null, %L, %L, %L, false, %L)', org, 'Early', '05:00', '13:00', 'lime'), '*');
  if pg_temp.shift_of(e_mgr, wk) <> 'Early' then fails := fails || format('the past shift lost its archived type: %s', pg_temp.shift_of(e_mgr, wk)); end if;
  select t.id into t_new from public.hr_shift_types t where t.org_id = org and t.name = 'Early' and t.archived_at is null;
  fails := fails
    || pg_temp.t(own, 'the old one cannot come back while the name is taken', format('public.hr_archive_shift_type(%L, false)', t_early), 'SHIFT_TYPE_EXISTS')
    || pg_temp.t(own, 'a custom type leaves the old column empty', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_mgr, wk + 1, t_new::text))), '*');
  if (select s.shift from public.hr_shifts s where s.employee_id = e_mgr and s.work_date = wk + 1) is not null then
    fails := fails || 'a custom type wrote a kind into the old column'::text;
  end if;
  fails := fails
    || pg_temp.t(own, 'archiving the new one', format('public.hr_archive_shift_type(%L, true)', t_new), '*')
    || pg_temp.t(own, 'lets the old one come back', format('public.hr_archive_shift_type(%L, false)', t_early), format('={"id":"%s","name":"Early","start_time":"06:00:00","end_time":"14:00:00","is_off":false,"color":"sky","archived":false}', t_early));

  -- The demo is read only.
  if demo is not null then
    select t.id into t_demo from public.hr_shift_types t where t.org_id = demo order by t.created_at limit 1;
    fails := fails
      || pg_temp.t(da, 'an admin in the demo cannot add a type', format('public.hr_save_shift_type(%L, null, %L, null, null, false, %L)', demo, 'Demo', 'sky'), 'SHIFT_TYPE_NOT_ALLOWED')
      || pg_temp.t(da, 'nor ask for the defaults', format('public.hr_ensure_shift_types(%L)', demo), 'SHIFT_TYPE_NOT_ALLOWED');
    if t_demo is not null then
      fails := fails
        || pg_temp.t(da, 'nor archive one', format('public.hr_archive_shift_type(%L, true)', t_demo), 'SHIFT_TYPE_NOT_ALLOWED')
        || pg_temp.t(dm, 'a demo member reads the demo''s types', format('(select count(*) > 0 from public.hr_shift_types t where t.org_id = %L)', demo), '=true');
    end if;
  end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_ROSTERS_HOURS_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
