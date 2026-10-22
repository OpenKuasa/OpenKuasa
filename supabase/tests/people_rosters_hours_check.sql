-- Rosters and hours (hr_save_roster, hr_save_hours, the manager read branch on
-- hr_shifts and hr_timesheet_entries) access check. Leaves nothing behind: the
-- block always ends with RAISE, so every row and helper below is rolled back.
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
  wk date := date '2030-01-07';          -- a Monday
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  mon date;                               -- this week's Monday in Malaysia
  q text; a text; i int; ctx text; fails text[] := '{}';
  roster_fn text := 'public.hr_save_roster(uuid,date,jsonb)';
  hours_fn text := 'public.hr_save_hours(uuid,date,numeric,numeric)';
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
  -- Any private hr_ helper stays closed.
  select count(*) into i from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'private' and p.proname like 'hr\_%'
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
  if i <> 0 then fails := fails || format('%s private hr_ helpers can be called directly', i); end if;
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
  -- A roster call on org for week wk with these cells.
  execute $f$
    create function pg_temp.roster(o uuid, w date, cells jsonb) returns text language sql as $b$
      select format('public.hr_save_roster(%L, %L, %L::jsonb)', o, w, cells)
    $b$
  $f$;
  execute $f$
    create function pg_temp.cell(e uuid, d date, k text) returns jsonb language sql as $b$
      select jsonb_build_object('employee_id', e, 'work_date', d, 'shift', k)
    $b$
  $f$;
  execute $f$
    create function pg_temp.hours(e uuid, d date, h numeric, b numeric) returns text language sql as $b$
      select format('public.hr_save_hours(%L, %L, %s, %s)', e, d, coalesce(h::text, 'null'), coalesce(b::text, 'null'))
    $b$
  $f$;
  execute $f$
    create function pg_temp.shift_of(e uuid, d date) returns text language sql as $b$
      select coalesce((select s.shift from public.hr_shifts s where s.employee_id = e and s.work_date = d), '-')
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
    || pg_temp.t(own, 'a shift that is not one of the three', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'evening'))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'the same cell twice', pg_temp.roster(org, wk, jsonb_build_array(pg_temp.cell(e_peer, wk, 'off'), pg_temp.cell(e_peer, wk, 'night'))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a cell with no shift key', pg_temp.roster(org, wk, jsonb_build_array(jsonb_build_object('employee_id', e_peer, 'work_date', wk))), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'an id that is not a uuid', pg_temp.roster(org, wk, '[{"employee_id":"nope","work_date":"2030-01-07","shift":"off"}]'), 'ROSTER_BAD_INPUT')
    || pg_temp.t(own, 'a date that is not a date', pg_temp.roster(org, wk, format('[{"employee_id":"%s","work_date":"2030-02-30","shift":"off"}]', e_peer)::jsonb), 'ROSTER_BAD_INPUT')
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

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_ROSTERS_HOURS_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
