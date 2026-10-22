-- Roster notifications and shift swaps (hr_save_roster's notifications, hr_shift_swaps, hr_swap_options,
-- hr_request_shift_swap, hr_reply_shift_swap, hr_decide_shift_swap, hr_cancel_shift_swap, the two new
-- hr_waiting_counts figures) access check. Leaves nothing behind: the block always ends with RAISE, so every
-- row and helper below is rolled back.
-- Read the message:
--   PEOPLE_ROSTER_SWAPS_CHECK PASSED ...   or   PEOPLE_ROSTER_SWAPS_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (it plants employees in the demo, which the scheduled re-seed rebuilds
-- then), and not across midnight in Malaysia (the cases count days from today).
-- g(who, q, claims) runs q as one signed-in person and says what came back: a statement gives ok, none (no
-- row touched) or denied; a call gives =<json> or the refusal. t(who, what, q, want, claims) is g compared
-- with want ('*' = it must go through; 'status:x' = it must go through with that status).
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mgr uuid := gen_random_uuid(); mgr2 uuid := gen_random_uuid();
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); peer uuid := gen_random_uuid();
  ina uuid := gen_random_uuid(); outs uuid := gen_random_uuid(); da uuid := gen_random_uuid(); dm uuid := gen_random_uuid();
  e_own uuid := gen_random_uuid(); e_adm uuid := gen_random_uuid(); e_mgr uuid := gen_random_uuid(); e_mgr2 uuid := gen_random_uuid();
  e_a uuid := gen_random_uuid(); e_b uuid := gen_random_uuid(); e_c uuid := gen_random_uuid(); e_peer uuid := gen_random_uuid();
  e_unl uuid := gen_random_uuid(); e_ina uuid := gen_random_uuid(); e_oth uuid := gen_random_uuid();
  de1 uuid := gen_random_uuid(); de2 uuid := gen_random_uuid();
  t_m uuid; t_n uuid; t_o uuid; t_oth uuid; dt uuid;
  wk date := date '2030-01-07';          -- a Monday, far ahead
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  mon date; pw date; fw date;
  sw uuid; sw2 uuid; q text; a text; i int; ctx text; fails text[] := '{}';
  fns text[] := array['public.hr_request_shift_swap(uuid,uuid,text)', 'public.hr_reply_shift_swap(uuid,boolean)',
    'public.hr_decide_shift_swap(uuid,boolean,text)', 'public.hr_cancel_shift_swap(uuid)', 'public.hr_save_roster(uuid,date,jsonb)'];
begin
  begin
  mon := date_trunc('week', today::timestamp)::date;
  pw := mon - 7;   -- last week: every day is past
  fw := mon + 7;   -- next week: every day is to come

  -- ---- 0. the catalogue ----------------------------------------------------------------
  select count(*) into i from pg_proc p where p.oid = any(array(select to_regprocedure(x) from unnest(fns) x))
    and p.prosecdef and p.provolatile = 'v' and p.prorettype = 'jsonb'::regtype and p.proconfig @> array['search_path=public']
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 5 then fails := fails || format('%s of 5 write functions are definer functions returning jsonb that signed-in users, and only they, may call', i); end if;
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.hr_swap_options(uuid)'), to_regprocedure('public.hr_waiting_counts(uuid)'))
    and p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=public']
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 2 then fails := fails || format('%s of 2 read functions are stable definer functions for signed-in users only', i); end if;
  if has_table_privilege('authenticated', 'public.hr_shift_swaps', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_any_column_privilege('authenticated', 'public.hr_shift_swaps', 'INSERT, UPDATE')
     or has_table_privilege('anon', 'public.hr_shift_swaps', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or not has_table_privilege('authenticated', 'public.hr_shift_swaps', 'SELECT') then
    fails := fails || 'hr_shift_swaps should be read by signed-in users and written by none'::text;
  end if;
  select count(*) into i from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_shift_swaps'
    and ((p.policyname = 'hr_shift_swaps_select' and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE')
      or (p.policyname = 'mfa_required' and p.cmd = 'ALL' and p.permissive = 'RESTRICTIVE' and p.qual like '%mfa_ok()%'));
  if i <> 2 or (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'hr_shift_swaps') <> 2 then
    fails := fails || 'hr_shift_swaps should have exactly its read policy and the second-factor policy'::text;
  end if;
  select count(*) into i from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'private' and p.proname like 'hr\_%'
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
  if i <> 0 then fails := fails || format('%s private hr_ helpers can be called directly', i); end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  -- ---- helpers ----------------------------------------------------------------------------
  create temp table rs_ctx (org uuid) on commit drop;
  insert into rs_ctx values (org);
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
      if got = want or (want = '*' and left(got, 1) = '=')
         or (left(want, 7) = 'status:' and left(got, 1) = '=' and substr(got, 2)::jsonb->>'status' = substr(want, 8))
         or (left(want, 1) = '=' and left(got, 1) = '=' and substr(got, 2)::jsonb = substr(want, 2)::jsonb) then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
    end $b$
  $f$;
  execute $f$
    create function pg_temp.roster(o uuid, w date, cells jsonb) returns text language sql as $b$
      select format('public.hr_save_roster(%L, %L, %L::jsonb)', o, w, cells)
    $b$
  $f$;
  execute $f$
    create function pg_temp.cell(e uuid, d date, t uuid) returns jsonb language sql as $b$
      select jsonb_build_object('employee_id', e, 'work_date', d, 'shift_type_id', t)
    $b$
  $f$;
  -- Plants a shift as the table owner (no notification), replacing whatever the cell held.
  execute $f$
    create function pg_temp.put(e uuid, d date, t uuid) returns uuid language plpgsql as $b$
    declare id uuid;
    begin
      delete from public.hr_shifts s where s.employee_id = e and s.work_date = d;
      if t is null then return null; end if;
      insert into public.hr_shifts (org_id, employee_id, work_date, shift_type_id, shift)
      select x.org_id, e, d, t, (select k.default_kind from public.hr_shift_types k where k.id = t)
      from public.hr_employees x where x.id = e
      returning hr_shifts.id into id;
      return id;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.sid(e uuid, d date) returns uuid language sql as $b$
      select s.id from public.hr_shifts s where s.employee_id = e and s.work_date = d
    $b$
  $f$;
  execute $f$
    create function pg_temp.kind(e uuid, d date) returns text language sql as $b$
      select coalesce((select t.default_kind from public.hr_shifts s join public.hr_shift_types t on t.id = s.shift_type_id
        where s.employee_id = e and s.work_date = d), '-')
    $b$
  $f$;
  execute $f$
    create function pg_temp.n(u uuid, ev text) returns int language sql as $b$
      select count(*)::int from public.notifications x where x.user_id = u and x.event = ev
    $b$
  $f$;
  execute $f$
    create function pg_temp.req(s1 uuid, s2 uuid, note text default null) returns text language sql as $b$
      select format('public.hr_request_shift_swap(%L, %L, %L)', s1, s2, note)
    $b$
  $f$;
  -- The newest swap the employee asked for on that day.
  execute $f$
    create function pg_temp.swap_of(e uuid, d date) returns uuid language sql as $b$
      select w.id from public.hr_shift_swaps w where w.requester_employee_id = e and w.requester_date = d
      order by (w.status in ('requested', 'accepted')) desc, w.id limit 1
    $b$
  $f$;
  execute $f$
    create function pg_temp.wc(who uuid, key text) returns int language plpgsql as $b$
    declare got text := pg_temp.g(who, format('public.hr_waiting_counts(%L)', (select c.org from rs_ctx c)));
    begin
      if left(got, 1) <> '=' then return -1; end if;
      return (substr(got, 2)::jsonb->>key)::int;
    end $b$
  $f$;

  -- ---- the cast ---------------------------------------------------------------------------
  -- org: an owner and an admin (both linked); mgr manages a and b; mgr2 manages c; peer reports to nobody; an
  -- active employee linked to nobody; a member linked to an inactive record. oth: outs, with e_oth. The demo:
  -- da (an admin there, linked to de2) and dm (a member linked to de1).
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u || '@swaps-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mgr, mgr2, ua, ub, uc, peer, ina, outs, da, dm]) u;
  insert into public.orgs (id, name) values (org, 'Swaps Check Sdn Bhd'), (oth, 'Swaps Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, mgr, 'member'),
    (org, mgr2, 'member'), (org, ua, 'member'), (org, ub, 'member'), (org, uc, 'member'), (org, peer, 'member'), (org, ina, 'member'),
    (oth, outs, 'owner');
  insert into public.hr_employees (id, org_id, employee_no, name, user_id, status) values
    (e_own, org, 'S01', 'Swap Owner', own, 'active'), (e_adm, org, 'S02', 'Swap Admin', adm, 'active'),
    (e_mgr, org, 'S03', 'Swap Manager', mgr, 'active'), (e_mgr2, org, 'S04', 'Swap Manager Two', mgr2, 'active'),
    (e_a, org, 'S05', 'Swap Alpha', ua, 'active'), (e_b, org, 'S06', 'Swap Bravo', ub, 'active'),
    (e_c, org, 'S07', 'Swap Charlie', uc, 'active'), (e_peer, org, 'S08', 'Swap Peer', peer, 'active'),
    (e_unl, org, 'S09', 'Swap Unlinked', null, 'active'), (e_ina, org, 'S10', 'Swap Inactive', ina, 'inactive'),
    (e_oth, oth, 'O01', 'Other Person', null, 'active');
  update public.hr_employees set reports_to = e_mgr where id in (e_a, e_b);
  update public.hr_employees set reports_to = e_mgr2 where id = e_c;
  perform private.hr_ensure_shift_types(org);
  perform private.hr_ensure_shift_types(oth);
  select t.id into t_m from public.hr_shift_types t where t.org_id = org and t.default_kind = 'morning';
  select t.id into t_n from public.hr_shift_types t where t.org_id = org and t.default_kind = 'night';
  select t.id into t_o from public.hr_shift_types t where t.org_id = org and t.default_kind = 'off';
  select t.id into t_oth from public.hr_shift_types t where t.org_id = oth and t.default_kind = 'morning';
  if demo is not null then
    perform private.hr_ensure_shift_types(demo);
    select t.id into dt from public.hr_shift_types t where t.org_id = demo and t.default_kind = 'morning';
    insert into public.org_members (org_id, user_id, role) values (demo, da, 'admin'), (demo, dm, 'member');
    insert into public.hr_employees (id, org_id, employee_no, name, user_id, status) values
      (de1, demo, 'DSW1', 'Demo Swap One', dm, 'active'), (de2, demo, 'DSW2', 'Demo Swap Two', da, 'active');
  end if;

  -- ---- 1. roster notifications ------------------------------------------------------------
  -- Next week: a and b get a first shift, own (the one saving) and the unlinked employee too.
  q := pg_temp.roster(org, fw, jsonb_build_array(pg_temp.cell(e_a, fw, t_m), pg_temp.cell(e_b, fw, t_n),
    pg_temp.cell(e_b, fw + 1, t_n), pg_temp.cell(e_own, fw, t_m), pg_temp.cell(e_unl, fw, t_m)));
  fails := fails || pg_temp.t(own, 'the owner saves next week', q, '*');
  if pg_temp.n(ua, 'hr_roster_changed') <> 1 or pg_temp.n(ub, 'hr_roster_changed') <> 1 then
    fails := fails || format('each changed employee gets one notice per save: a %s, b %s (b had two cells)', pg_temp.n(ua, 'hr_roster_changed'), pg_temp.n(ub, 'hr_roster_changed'));
  end if;
  if pg_temp.n(own, 'hr_roster_changed') <> 0 then fails := fails || 'the owner was told of their own save'::text; end if;
  select count(*) into i from public.notifications x where x.event = 'hr_roster_changed' and x.org_id = org;
  if i <> 2 then fails := fails || format('%s roster notices after the first save, wanted 2 (nobody for the unlinked employee)', i); end if;
  select count(*) into i from public.notifications x where x.user_id = ua and x.event = 'hr_roster_changed'
    and x.title = 'Your shifts for the week of ' || to_char(fw, 'FMDD Mon') || ' changed' and x.href = '/people/shift-calendar?week=' || fw::text;
  if i <> 1 then fails := fails || 'the notice does not name the week or link to it'::text; end if;

  -- The same week again: a unchanged, b changed on one day, own's cell changed by an admin, a cleared empty cell.
  q := pg_temp.roster(org, fw, jsonb_build_array(pg_temp.cell(e_a, fw, t_m), pg_temp.cell(e_b, fw, t_o),
    pg_temp.cell(e_own, fw, t_n), pg_temp.cell(e_peer, fw + 2, null)));
  fails := fails || pg_temp.t(adm, 'an admin saves next week again', q, '={"week":"' || fw || '","saved":2,"removed":0}');
  a := pg_temp.n(ua, 'hr_roster_changed') || ' ' || pg_temp.n(ub, 'hr_roster_changed') || ' ' || pg_temp.n(own, 'hr_roster_changed') || ' ' || pg_temp.n(peer, 'hr_roster_changed') || ' ' || pg_temp.n(adm, 'hr_roster_changed');
  if a is distinct from '1 2 1 0 0' then fails := fails || format('after the second save the notices (a b own peer admin) are %s, wanted 1 2 1 0 0', a); end if;

  -- Clearing a shift to come is a change.
  fails := fails || pg_temp.t(own, 'the owner clears b''s shift', pg_temp.roster(org, fw, jsonb_build_array(pg_temp.cell(e_b, fw + 1, null))), '={"week":"' || fw || '","saved":0,"removed":1}');
  if pg_temp.n(ub, 'hr_roster_changed') <> 3 then fails := fails || 'clearing a shift to come told nobody'::text; end if;

  -- Last week only: corrections to the past tell nobody.
  fails := fails || pg_temp.t(own, 'the owner corrects last week', pg_temp.roster(org, pw, jsonb_build_array(pg_temp.cell(e_a, pw, t_n), pg_temp.cell(e_c, pw + 6, t_m))), '*');
  if pg_temp.n(ua, 'hr_roster_changed') <> 1 or pg_temp.n(uc, 'hr_roster_changed') <> 0 then fails := fails || 'a past-only change sent a notice'::text; end if;

  -- This week: a change today tells; one before today in the same save does not add a second notice.
  q := pg_temp.roster(org, mon, jsonb_build_array(pg_temp.cell(e_c, today, t_m)) || case when today > mon then jsonb_build_array(pg_temp.cell(e_peer, mon, t_m)) else '[]'::jsonb end);
  fails := fails || pg_temp.t(own, 'the owner changes today', q, '*');
  if pg_temp.n(uc, 'hr_roster_changed') <> 1 then fails := fails || 'a change today told nobody'::text; end if;
  if pg_temp.n(peer, 'hr_roster_changed') <> 0 then fails := fails || 'a change before today in this week sent a notice'::text; end if;
  -- A refused save tells nobody.
  fails := fails || pg_temp.t(own, 'a refused save', pg_temp.roster(org, fw, jsonb_build_array(pg_temp.cell(e_c, fw, t_m), pg_temp.cell(e_oth, fw, t_m))), 'ROSTER_BAD_EMPLOYEE');
  if pg_temp.n(uc, 'hr_roster_changed') <> 1 then fails := fails || 'a refused save sent a notice'::text; end if;

  -- ---- 2. the shifts a member may ask for -----------------------------------------------------
  perform pg_temp.put(e_a, today + 30, t_m); perform pg_temp.put(e_b, today + 30, t_n);
  perform pg_temp.put(e_unl, today + 30, t_n); perform pg_temp.put(e_ina, today + 30, t_n);
  perform pg_temp.put(e_c, today + 61, t_n); perform pg_temp.put(e_oth, today + 30, t_oth);
  q := format('(select jsonb_agg(jsonb_build_object(''e'', o.employee_id, ''mine'', o.mine) order by o.employee_name) from public.hr_swap_options(%L) o where o.work_date = %L or o.work_date = %L)', org, today + 30, today + 61);
  fails := fails
    || pg_temp.t(ua, 'a member sees their own shift and an active, linked colleague''s, up to 60 days ahead', q, format('=[{"e":"%s","mine":true},{"e":"%s","mine":false}]', e_a, e_b))
    || pg_temp.t(peer, 'another member sees the same two, neither theirs', q, format('=[{"e":"%s","mine":false},{"e":"%s","mine":false}]', e_a, e_b))
    || pg_temp.t(ua, 'nothing from today or before', format('(select count(*) from public.hr_swap_options(%L) o where o.work_date <= %L)', org, today), '=0')
    || pg_temp.t(outs, 'an outsider sees nothing', format('(select count(*) from public.hr_swap_options(%L))', org), '=0')
    || pg_temp.t(ina, 'a member linked to an inactive record sees nothing', format('(select count(*) from public.hr_swap_options(%L))', org), '=0')
    || pg_temp.t(ua, 'nor anything of another workspace', format('(select count(*) from public.hr_swap_options(%L))', oth), '=0')
    || pg_temp.t(null, 'no session sees nothing', format('(select count(*) from public.hr_swap_options(%L))', org), '=0');
  if demo is not null then
    perform pg_temp.put(de1, today + 30, dt); perform pg_temp.put(de2, today + 30, dt);
    fails := fails || pg_temp.t(dm, 'a demo member sees nothing', format('(select count(*) from public.hr_swap_options(%L))', demo), '=0');
  end if;

  -- ---- 3. asking for a swap: what is refused -----------------------------------------------------
  -- The far week: a Mon morning, Tue off; b Mon night, Tue morning; c Mon morning, Thu morning; peer Mon night,
  -- Wed morning; the unlinked and inactive employees Mon night; the admin Fri morning; b Sat night.
  perform pg_temp.put(e_a, wk, t_m); perform pg_temp.put(e_a, wk + 1, t_o);
  perform pg_temp.put(e_b, wk, t_n); perform pg_temp.put(e_b, wk + 1, t_m);
  perform pg_temp.put(e_c, wk, t_m); perform pg_temp.put(e_c, wk + 3, t_m);
  perform pg_temp.put(e_peer, wk, t_n); perform pg_temp.put(e_peer, wk + 2, t_m);
  perform pg_temp.put(e_unl, wk, t_n); perform pg_temp.put(e_ina, wk, t_n);
  perform pg_temp.put(e_adm, wk + 4, t_m); perform pg_temp.put(e_b, wk + 5, t_n);
  perform pg_temp.put(e_a, today, t_n); perform pg_temp.put(e_a, today - 1, t_n); perform pg_temp.put(e_b, today - 1, t_m);
  perform pg_temp.put(e_oth, wk, t_oth);
  fails := fails
    || pg_temp.t(ua, 'not someone else''s shift as your own', pg_temp.req(pg_temp.sid(e_b, wk), pg_temp.sid(e_a, wk)), 'SWAP_NOT_YOUR_SHIFT')
    || pg_temp.t(peer, 'nor a shift of a colleague as yours', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_b, wk)), 'SWAP_NOT_YOUR_SHIFT')
    || pg_temp.t(ua, 'nor a shift that does not exist', pg_temp.req(gen_random_uuid(), pg_temp.sid(e_b, wk)), 'SWAP_NOT_YOUR_SHIFT')
    || pg_temp.t(ua, 'not your shift today', pg_temp.req(pg_temp.sid(e_a, today), pg_temp.sid(e_b, wk)), 'SWAP_NOT_FUTURE')
    || pg_temp.t(ua, 'not your shift yesterday', pg_temp.req(pg_temp.sid(e_a, today - 1), pg_temp.sid(e_b, today - 1)), 'SWAP_NOT_FUTURE')
    || pg_temp.t(ua, 'not a colleague''s shift in the past', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_b, today - 1)), 'SWAP_NOT_FUTURE')
    || pg_temp.t(ua, 'not with an employee linked to nobody', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_unl, wk)), 'SWAP_BAD_COLLEAGUE')
    || pg_temp.t(ua, 'not with an inactive employee', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_ina, wk)), 'SWAP_BAD_COLLEAGUE')
    || pg_temp.t(ua, 'not with yourself', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_a, wk + 1)), 'SWAP_BAD_COLLEAGUE')
    || pg_temp.t(ua, 'not with another workspace', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_oth, wk)), 'SWAP_BAD_COLLEAGUE')
    || pg_temp.t(ua, 'the same day and the same type changes nothing', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_c, wk)), 'SWAP_BAD_INPUT')
    || pg_temp.t(ua, 'another day where the colleague already works yours', pg_temp.req(pg_temp.sid(e_a, wk + 1), pg_temp.sid(e_b, wk)), 'SWAP_CLASH')
    || pg_temp.t(ua, 'a note over 500 characters', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_b, wk), repeat('x', 501)), 'SWAP_BAD_INPUT')
    || pg_temp.t(ua, 'no colleague''s shift named', pg_temp.req(pg_temp.sid(e_a, wk), null), 'SWAP_BAD_INPUT')
    || pg_temp.t(ina, 'a member whose record is inactive', pg_temp.req(pg_temp.sid(e_ina, wk), pg_temp.sid(e_c, wk)), 'SWAP_INACTIVE_EMPLOYEE')
    || pg_temp.t(null, 'no session', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_b, wk)), 'SWAP_NOT_ALLOWED')
    || pg_temp.t(ua, 'a member cannot write a swap directly', format('insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id) values (%L, %L, %L, %L, %L, %L, %L)', org, e_a, e_b, wk, t_m, wk, t_n), 'denied');
  if demo is not null then
    fails := fails || pg_temp.t(dm, 'never in the demo', pg_temp.req(pg_temp.sid(de1, today + 30), pg_temp.sid(de2, today + 30)), 'SWAP_NOT_ALLOWED');
  end if;
  select count(*) into i from public.hr_shift_swaps w where w.org_id in (org, oth) or w.org_id = demo;
  if i <> 0 then fails := fails || format('%s swaps were written by refused requests', i); end if;

  -- ---- 4. one swap all the way: the same day, a (morning) with b (night) ------------------------------
  fails := fails || pg_temp.t(ua, 'a asks b to swap Monday', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_b, wk), ' Dentist in the morning '), 'status:requested');
  sw := pg_temp.swap_of(e_a, wk);
  if sw is null or (select w.note from public.hr_shift_swaps w where w.id = sw) is distinct from 'Dentist in the morning' then fails := fails || 'the swap was not kept with its trimmed note'::text; end if;
  if pg_temp.n(ub, 'hr_shift_swap') <> 1 then fails := fails || 'b was not told of the request'::text; end if;
  fails := fails
    || pg_temp.t(ua, 'a cell already in an open swap', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_peer, wk)), 'SWAP_ALREADY_OPEN')
    || pg_temp.t(uc, 'the colleague''s cell is in it too', pg_temp.req(pg_temp.sid(e_c, wk), pg_temp.sid(e_b, wk)), 'SWAP_ALREADY_OPEN');
  -- Reading it: the two people, owners and admins, a manager of both; nobody else.
  q := format('(select count(*) from public.hr_shift_swaps w where w.id = %L)', sw);
  fails := fails
    || pg_temp.t(ua, 'the requester reads it', q, '=1') || pg_temp.t(ub, 'the colleague reads it', q, '=1')
    || pg_temp.t(mgr, 'a manager of both reads it', q, '=1') || pg_temp.t(adm, 'an admin reads it', q, '=1')
    || pg_temp.t(own, 'the owner reads it', q, '=1') || pg_temp.t(uc, 'another member does not', q, '=0')
    || pg_temp.t(mgr2, 'a manager of neither does not', q, '=0') || pg_temp.t(outs, 'an outsider does not', q, '=0')
    || pg_temp.t(null, 'no session does not', q, '=0')
    || pg_temp.t(ua, 'the requester cannot change it directly', format('update public.hr_shift_swaps set status = ''approved'' where id = %L', sw), 'denied')
    || pg_temp.t(adm, 'nor can an admin', format('update public.hr_shift_swaps set status = ''approved'' where id = %L', sw), 'denied')
    || pg_temp.t(ua, 'nor delete it', format('delete from public.hr_shift_swaps where id = %L', sw), 'denied');
  if pg_temp.wc(ub, 'swap_replies') <> 1 or pg_temp.wc(ua, 'swap_replies') <> 0 or pg_temp.wc(adm, 'swaps') <> 0 then
    fails := fails || format('while requested: b''s replies %s (1), a''s %s (0), the admin''s swaps %s (0)', pg_temp.wc(ub, 'swap_replies'), pg_temp.wc(ua, 'swap_replies'), pg_temp.wc(adm, 'swaps'));
  end if;
  -- Only the colleague replies.
  fails := fails
    || pg_temp.t(adm, 'it cannot be approved before b accepts', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_PENDING')
    || pg_temp.t(ua, 'the requester cannot accept for b', format('public.hr_reply_shift_swap(%L, true)', sw), 'SWAP_NOT_ALLOWED')
    || pg_temp.t(mgr, 'nor can their manager', format('public.hr_reply_shift_swap(%L, true)', sw), 'SWAP_NOT_ALLOWED')
    || pg_temp.t(adm, 'nor an admin', format('public.hr_reply_shift_swap(%L, true)', sw), 'SWAP_NOT_ALLOWED')
    || pg_temp.t(uc, 'another member learns nothing', format('public.hr_reply_shift_swap(%L, true)', sw), 'SWAP_NOT_FOUND')
    || pg_temp.t(ub, 'no answer given', format('public.hr_reply_shift_swap(%L, null)', sw), 'SWAP_BAD_INPUT')
    || pg_temp.t(ub, 'b accepts', format('public.hr_reply_shift_swap(%L, true)', sw), 'status:accepted')
    || pg_temp.t(ub, 'and cannot accept twice', format('public.hr_reply_shift_swap(%L, false)', sw), 'SWAP_NOT_PENDING');
  if pg_temp.n(ua, 'hr_shift_swap') <> 1 then fails := fails || 'a was not told b accepted'::text; end if;
  if pg_temp.n(mgr, 'hr_request_filed') <> 1 then fails := fails || 'the manager of both was not told a swap waits for them'::text; end if;
  a := pg_temp.wc(adm, 'swaps') || ' ' || pg_temp.wc(own, 'swaps') || ' ' || pg_temp.wc(mgr, 'swaps') || ' ' || pg_temp.wc(mgr2, 'swaps') || ' ' || pg_temp.wc(ub, 'swap_replies') || ' ' || pg_temp.wc(peer, 'swaps');
  if a is distinct from '1 1 1 0 0 0' then fails := fails || format('once accepted the counts (admin owner manager manager2 b-replies peer) are %s, wanted 1 1 1 0 0 0', a); end if;
  -- Who may decide.
  fails := fails
    || pg_temp.t(peer, 'a member learns nothing', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_FOUND')
    || pg_temp.t(mgr2, 'a manager of neither learns nothing', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_FOUND')
    || pg_temp.t(ua, 'one of the two cannot approve it', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_ALLOWED')
    || pg_temp.t(outs, 'an outsider learns nothing', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_FOUND')
    || pg_temp.t(mgr, 'no decision given', format('public.hr_decide_shift_swap(%L, null, null)', sw), 'SWAP_BAD_INPUT')
    || pg_temp.t(mgr, 'the manager of both approves', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'status:approved');
  a := pg_temp.kind(e_a, wk) || ' ' || pg_temp.kind(e_b, wk);
  if a is distinct from 'night morning' then fails := fails || format('after the approval a and b work %s on Monday, wanted night morning', a); end if;
  select count(*) into i from public.hr_shifts s join public.hr_shift_types t on t.id = s.shift_type_id
  where s.work_date = wk and s.employee_id in (e_a, e_b) and s.shift is not distinct from t.default_kind;
  if i <> 2 then fails := fails || 'the exchanged shifts do not carry their type''s kind in the old column'::text; end if;
  if (select w.decided_by from public.hr_shift_swaps w where w.id = sw) is distinct from mgr then fails := fails || 'the decision does not say who made it'::text; end if;
  if pg_temp.n(ua, 'hr_shift_swap') <> 2 or pg_temp.n(ub, 'hr_shift_swap') <> 2 or pg_temp.n(mgr, 'hr_shift_swap') <> 0 then
    fails := fails || format('after the approval a has %s swap notices (2), b %s (2), the manager %s (0)', pg_temp.n(ua, 'hr_shift_swap'), pg_temp.n(ub, 'hr_shift_swap'), pg_temp.n(mgr, 'hr_shift_swap'));
  end if;
  fails := fails
    || pg_temp.t(adm, 'it cannot be approved twice', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_PENDING')
    || pg_temp.t(ua, 'nor cancelled once approved', format('public.hr_cancel_shift_swap(%L)', sw), 'SWAP_NOT_PENDING');
  if pg_temp.wc(adm, 'swaps') <> 0 then fails := fails || 'an approved swap is still counted as waiting'::text; end if;

  -- ---- 5. two days: peer's Wednesday for c's Thursday, and the roster moving under it -------------------------
  fails := fails
    || pg_temp.t(peer, 'peer asks c for Thursday, giving Wednesday', pg_temp.req(pg_temp.sid(e_peer, wk + 2), pg_temp.sid(e_c, wk + 3)), 'status:requested')
    || pg_temp.t(uc, 'c accepts', format('public.hr_reply_shift_swap(%L, true)', pg_temp.swap_of(e_peer, wk + 2)), 'status:accepted');
  sw := pg_temp.swap_of(e_peer, wk + 2);
  if pg_temp.n(mgr2, 'hr_request_filed') <> 0 then fails := fails || 'a manager of only one of the two was told of the swap'::text; end if;
  -- The colleague's shift changes: refused. Put back: the other day gets a shift for peer: refused. Cleared: approved.
  perform pg_temp.put(e_c, wk + 3, t_n);
  fails := fails || pg_temp.t(adm, 'c''s Thursday changed since the request', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_SHIFT_CHANGED');
  perform pg_temp.put(e_c, wk + 3, t_m); perform pg_temp.put(e_peer, wk + 3, t_o);
  fails := fails || pg_temp.t(adm, 'peer got an off day on Thursday since the request', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_SHIFT_CHANGED');
  perform pg_temp.put(e_peer, wk + 3, null); perform pg_temp.put(e_peer, wk + 2, null); perform pg_temp.put(e_peer, wk + 2, t_m);
  fails := fails || pg_temp.t(adm, 'a shift deleted and made again with the same type is still the same shift', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'status:approved');
  a := pg_temp.kind(e_peer, wk + 2) || ' ' || pg_temp.kind(e_peer, wk + 3) || ' ' || pg_temp.kind(e_c, wk + 2) || ' ' || pg_temp.kind(e_c, wk + 3);
  if a is distinct from '- morning morning -' then fails := fails || format('after the two-day swap (peer Wed, peer Thu, c Wed, c Thu) the cells are %s', a); end if;

  -- ---- 6. a manager of only one, cancelling, declining, rejecting ------------------------------------------
  fails := fails
    || pg_temp.t(ua, 'a (now night) asks c (morning) for Monday', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_c, wk)), 'status:requested')
    || pg_temp.t(uc, 'c accepts', format('public.hr_reply_shift_swap(%L, true)', pg_temp.swap_of(e_a, wk)), 'status:accepted');
  sw := pg_temp.swap_of(e_a, wk);
  fails := fails
    || pg_temp.t(mgr, 'a manager of only one of them learns nothing', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_FOUND')
    || pg_temp.t(mgr, 'and does not read it', format('(select count(*) from public.hr_shift_swaps w where w.id = %L)', sw), '=0')
    || pg_temp.t(mgr2, 'nor does the other', format('(select count(*) from public.hr_shift_swaps w where w.id = %L)', sw), '=0');
  if pg_temp.wc(mgr, 'swaps') <> 0 or pg_temp.wc(mgr2, 'swaps') <> 0 then fails := fails || 'a manager of only one counts the swap'::text; end if;
  i := pg_temp.n(ua, 'hr_shift_swap');
  fails := fails
    || pg_temp.t(mgr, 'nobody but the two may cancel', format('public.hr_cancel_shift_swap(%L)', sw), 'SWAP_NOT_FOUND')
    || pg_temp.t(adm, 'not even an admin', format('public.hr_cancel_shift_swap(%L)', sw), 'SWAP_NOT_ALLOWED')
    || pg_temp.t(uc, 'the colleague cancels after accepting', format('public.hr_cancel_shift_swap(%L)', sw), 'status:cancelled')
    || pg_temp.t(ua, 'and it cannot be cancelled twice', format('public.hr_cancel_shift_swap(%L)', sw), 'SWAP_NOT_PENDING')
    || pg_temp.t(adm, 'nor approved', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_NOT_PENDING');
  if pg_temp.n(ua, 'hr_shift_swap') <> i + 1 then fails := fails || 'a was not told c cancelled'::text; end if;
  if pg_temp.kind(e_a, wk) <> 'night' then fails := fails || 'a cancelled swap changed the roster'::text; end if;

  fails := fails
    || pg_temp.t(ua, 'a asks again', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_c, wk)), 'status:requested')
    || pg_temp.t(ua, 'and cancels it while requested', format('public.hr_cancel_shift_swap(%L)', pg_temp.swap_of(e_a, wk)), 'status:cancelled')
    || pg_temp.t(ua, 'a asks once more', pg_temp.req(pg_temp.sid(e_a, wk), pg_temp.sid(e_c, wk)), 'status:requested');
  i := pg_temp.n(ua, 'hr_shift_swap');
  fails := fails
    || pg_temp.t(uc, 'c declines', format('public.hr_reply_shift_swap(%L, false)', pg_temp.swap_of(e_a, wk)), 'status:declined')
    || pg_temp.t(adm, 'a declined swap cannot be approved', format('public.hr_decide_shift_swap(%L, true, null)', pg_temp.swap_of(e_a, wk)), 'SWAP_NOT_PENDING');
  if pg_temp.n(ua, 'hr_shift_swap') <> i + 1 then fails := fails || 'a was not told c declined'::text; end if;

  -- The admin's own swap: they cannot decide it; the owner can. While it waits the admin counts it out.
  fails := fails
    || pg_temp.t(adm, 'the admin asks b for Saturday, giving Friday', pg_temp.req(pg_temp.sid(e_adm, wk + 4), pg_temp.sid(e_b, wk + 5)), 'status:requested')
    || pg_temp.t(ub, 'b accepts', format('public.hr_reply_shift_swap(%L, true)', pg_temp.swap_of(e_adm, wk + 4)), 'status:accepted');
  sw := pg_temp.swap_of(e_adm, wk + 4);
  if pg_temp.wc(adm, 'swaps') <> 0 or pg_temp.wc(own, 'swaps') <> 1 then fails := fails || 'the admin counts their own swap, or the owner does not'::text; end if;
  fails := fails
    || pg_temp.t(adm, 'the admin cannot decide their own swap', format('public.hr_decide_shift_swap(%L, true, null)', sw), 'SWAP_OWN_REQUEST')
    || pg_temp.t(own, 'a rejection note over 500 characters', format('public.hr_decide_shift_swap(%L, false, %L)', sw, repeat('n', 501)), 'SWAP_BAD_INPUT')
    || pg_temp.t(own, 'the owner rejects it with a note', format('public.hr_decide_shift_swap(%L, false, %L)', sw, 'Short that day'), 'status:rejected');
  if (select w.decision_note from public.hr_shift_swaps w where w.id = sw) is distinct from 'Short that day' then fails := fails || 'the rejection note was not kept'::text; end if;
  if pg_temp.kind(e_adm, wk + 4) <> 'morning' or pg_temp.kind(e_b, wk + 5) <> 'night' then fails := fails || 'a rejected swap changed the roster'::text; end if;
  if pg_temp.n(adm, 'hr_shift_swap') <> 2 then fails := fails || format('the admin has %s swap notices (b accepted, the owner rejected: 2)', pg_temp.n(adm, 'hr_shift_swap')); end if;

  -- ---- 7. days that have passed ---------------------------------------------------------------
  -- Planted as the table owner: swaps whose day is now today.
  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
  values (org, e_b, e_c, today, t_m, wk + 6, t_n, 'accepted'), (org, e_a, e_c, wk + 6, t_m, today, t_n, 'requested');
  fails := fails
    || pg_temp.t(own, 'an accepted swap whose day has come cannot be approved', format('public.hr_decide_shift_swap(%L, true, null)', pg_temp.swap_of(e_b, today)), 'SWAP_NOT_FUTURE')
    || pg_temp.t(own, 'but can be rejected', format('public.hr_decide_shift_swap(%L, false, null)', pg_temp.swap_of(e_b, today)), 'status:rejected')
    || pg_temp.t(uc, 'one whose day has come cannot be accepted', format('public.hr_reply_shift_swap(%L, true)', pg_temp.swap_of(e_a, wk + 6)), 'SWAP_NOT_FUTURE')
    || pg_temp.t(uc, 'but can be declined', format('public.hr_reply_shift_swap(%L, false)', pg_temp.swap_of(e_a, wk + 6)), 'status:declined');
  insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
  values (org, e_a, e_c, wk + 6, t_m, today, t_n, 'requested');
  if pg_temp.wc(uc, 'swap_replies') <> 0 then fails := fails || 'a request whose day has come is counted as waiting'::text; end if;

  -- ---- 8. the demo ------------------------------------------------------------------------------
  if demo is not null then
    insert into public.hr_shift_swaps (org_id, requester_employee_id, colleague_employee_id, requester_date, requester_type_id, colleague_date, colleague_type_id, status)
    values (demo, de1, de2, today + 30, dt, today + 31, dt, 'accepted') returning id into sw2;
    fails := fails
      || pg_temp.t(da, 'an admin in the demo cannot decide a swap', format('public.hr_decide_shift_swap(%L, true, null)', sw2), 'SWAP_NOT_ALLOWED')
      || pg_temp.t(dm, 'a demo member cannot cancel one', format('public.hr_cancel_shift_swap(%L)', sw2), 'SWAP_NOT_ALLOWED')
      || pg_temp.t(da, 'nor reply to one', format('public.hr_reply_shift_swap(%L, true)', sw2), 'SWAP_NOT_ALLOWED')
      || pg_temp.t(dm, 'and the demo counts nothing', format('public.hr_waiting_counts(%L)', demo), '={"leave":0,"time_off":0,"claims":0,"overtime":0,"swaps":0,"swap_replies":0}');
  end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_ROSTER_SWAPS_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
