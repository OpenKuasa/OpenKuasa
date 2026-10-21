-- The work week for any member (public.hr_work_week, issue #234) access check.
-- Leaves nothing behind: the block always ends with RAISE, so every row and
-- helper below is rolled back. Read the message:
--   PEOPLE_WORK_WEEK_CHECK PASSED ...   or   PEOPLE_WORK_WEEK_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (it adds a member to the demo, which the
-- scheduled re-seed rebuilds then). Its results do not depend on the clock.
-- g(who, q, claims) runs q as one signed-in person and says what came back:
-- =<json> or the refusal. t(who, what, q, want, claims) is g compared with want.
do $$
declare
  org uuid := gen_random_uuid(); bare uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mgr uuid := gen_random_uuid(); rep uuid := gen_random_uuid();
  peer uuid := gen_random_uuid(); mfa uuid := gen_random_uuid(); outs uuid := gen_random_uuid(); lone uuid := gen_random_uuid();
  dm uuid := gen_random_uuid(); e_mgr uuid := gen_random_uuid(); e_rep uuid := gen_random_uuid();
  q text := format('public.hr_work_week(%L)', org);
  bad jsonb; a text; i int; ctx text; fails text[] := '{}';
begin
  begin
  -- ---- 0. the catalogue ----------------------------------------------------------------
  select count(*) into i from pg_proc p where p.oid = to_regprocedure('public.hr_work_week(uuid)')
    and p.prosecdef and p.provolatile = 's' and not p.proretset and p.prorettype = 'jsonb'::regtype
    and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 1 then fails := fails || 'hr_work_week(uuid) is not a stable definer function returning jsonb on a fixed search path that signed-in users, and only they, may call'::text; end if;
  -- The settings table itself stays closed to a plain member: this function is the only new way in.
  select count(*) into i from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_settings';
  if i <> 2 or (select p.qual from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_settings' and p.policyname = 'hr_settings_select')
     not like '%is_org_admin(org_id)%' then
    fails := fails || format('hr_settings should keep its two policies (%s) and its owner-or-admin read rule', i);
  end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  -- ---- helpers ----------------------------------------------------------------------------
  execute $f$
    create function pg_temp.g(who uuid, q text, extra jsonb default '{}') returns text language plpgsql as $b$
    declare r jsonb; got text;
    begin
      perform set_config('request.jwt.claims', (jsonb_strip_nulls(jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', case when who is not null then 'aal1' end)) || extra)::text, true);
      set local role authenticated;
      begin
        execute 'select to_jsonb(' || q || ')' into r; got := '=' || coalesce(r::text, 'null');
      exception when insufficient_privilege then got := 'denied'; when undefined_function then got := 'gone'; when others then got := sqlerrm; end;
      reset role;
      return got;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.t(who uuid, label text, q text, want text, extra jsonb default '{}') returns text[] language plpgsql as $b$
    declare got text := pg_temp.g(who, q, extra);
    begin
      if got = want or (left(want, 1) = '=' and left(got, 1) = '=' and substr(got, 2)::jsonb = substr(want, 2)::jsonb) then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
    end $b$
  $f$;

  -- ---- the cast ---------------------------------------------------------------------------
  -- org: an owner, an admin, a manager (mgr, rep reports to them), a plain member (peer) and a member who owes a
  -- second factor (mfa); its week is Saturday, Monday, an unknown key and Tuesday. bare: one owner (lone), no
  -- settings row. oth: outs, with a week of its own. The demo: dm, a plain member.
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u || '@work-week-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mgr, rep, peer, mfa, outs, lone, dm]) u;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now());
  insert into public.orgs (id, name) values (org, 'Work Week Check Sdn Bhd'), (bare, 'Work Week Bare Sdn Bhd'), (oth, 'Work Week Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, mgr, 'member'), (org, rep, 'member'),
    (org, peer, 'member'), (org, mfa, 'member'), (bare, lone, 'owner'), (oth, outs, 'owner');
  if demo is not null then insert into public.org_members (org_id, user_id, role) values (demo, dm, 'member'); end if;
  insert into public.hr_employees (id, org_id, employee_no, name, user_id) values
    (e_mgr, org, 'W01', 'Week Manager', mgr), (e_rep, org, 'W02', 'Week Report', rep);
  update public.hr_employees set reports_to = e_mgr where id = e_rep;
  insert into public.hr_settings (org_id, work_week) values (org, '["sat","mon","xyz","tue"]'::jsonb), (oth, '["sun"]'::jsonb)
    on conflict (org_id) do update set work_week = excluded.work_week;
  delete from public.hr_settings where org_id = bare;

  -- ---- 1. who reads it ----------------------------------------------------------------------
  fails := fails
    || pg_temp.t(own, 'an owner reads the known days in week order', q, '=["mon","tue","sat"]')
    || pg_temp.t(adm, 'an admin reads the same', q, '=["mon","tue","sat"]')
    || pg_temp.t(mgr, 'a manager reads the same', q, '=["mon","tue","sat"]')
    || pg_temp.t(rep, 'a report reads the same', q, '=["mon","tue","sat"]')
    || pg_temp.t(peer, 'a plain member reads the same', q, '=["mon","tue","sat"]')
    || pg_temp.t(mfa, 'a member who owes a second factor reads nothing', q, '=null')
    || pg_temp.t(mfa, 'and reads it with the second factor given', q, '=["mon","tue","sat"]', '{"aal":"aal2"}')
    || pg_temp.t(outs, 'a member of another workspace reads nothing', q, '=null')
    || pg_temp.t(outs, 'and reads their own workspace''s week', format('public.hr_work_week(%L)', oth), '=["sun"]')
    || pg_temp.t(null, 'no session reads nothing', q, '=null')
    || pg_temp.t(peer, 'no workspace named: nothing', 'public.hr_work_week(null)', '=null')
    || pg_temp.t(peer, 'a workspace that does not exist: nothing', format('public.hr_work_week(%L)', gen_random_uuid()), '=null')
    || pg_temp.t(lone, 'no settings row: Monday to Friday', format('public.hr_work_week(%L)', bare), '=["mon","tue","wed","thu","fri"]');
  -- A plain member still cannot read the settings table itself.
  fails := fails || pg_temp.t(peer, 'a plain member reads no settings row', format('(select count(*) from public.hr_settings s where s.org_id = %L)', org), '=0');
  -- The demo: any member reads its week, whatever it is, and it is a list.
  if demo is not null then
    a := pg_temp.g(dm, format('public.hr_work_week(%L)', demo));
    if left(a, 2) <> '=[' then fails := fails || format('a demo member should read the demo''s week, got %s', a); end if;
  end if;

  -- ---- 2. a stored week that names no day reads as clock-in reads it ------------------------
  foreach bad in array array['[]'::jsonb, '["xyz"]'::jsonb, '"mon"'::jsonb, '{"mon":true}'::jsonb, 'null'::jsonb] loop
    update public.hr_settings set work_week = bad where org_id = org;
    fails := fails || pg_temp.t(peer, format('a stored week of %s reads as Monday to Friday', bad), q, '=["mon","tue","wed","thu","fri"]');
  end loop;
  update public.hr_settings set work_week = '["sun","sat","fri","thu","wed","tue","mon","mon"]'::jsonb where org_id = org;
  fails := fails || pg_temp.t(peer, 'all seven days, out of order and repeated, read once each in week order', q, '=["mon","tue","wed","thu","fri","sat","sun"]');
  -- The function agrees with private.hr_is_working_day on every day of one week.
  update public.hr_settings set work_week = '["tue","sat"]'::jsonb where org_id = org;
  select count(*) into i from generate_series(date '2026-01-05', date '2026-01-11', interval '1 day') d
  where private.hr_is_working_day(org, d::date) is distinct from (
    '["tue","sat"]'::jsonb ? (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from d)::int]);
  if i <> 0 then fails := fails || format('hr_is_working_day disagrees with the stored week on %s days (planted: no holidays)', i); end if;
  fails := fails || pg_temp.t(peer, 'and the function reads the same two days', q, '=["tue","sat"]');

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_WORK_WEEK_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
