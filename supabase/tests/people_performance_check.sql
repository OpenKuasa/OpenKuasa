-- Lekiu performance, training and announcements access check. Leaves nothing
-- behind: the block always ends with RAISE, so every row below is rolled back,
-- and so are the helper functions it makes in the session's temporary schema.
--   PEOPLE_PERFORMANCE_CHECK PASSED ...   or   PEOPLE_PERFORMANCE_CHECK FAILED (n): <what went wrong>
-- When not to run it. It rebuilds the demo HR rows inside its transaction and
-- holds them until the rollback, and the scheduled demo reseed commits the
-- same rows at minute 1 of every hour. So do not start it in minutes :00 to
-- :02 of an hour, nor so late that it could still be running at the next :01;
-- not at the same time as another people check (people_rls_check,
-- people_leave_check, people_claims_overtime_check, people_attendance_check,
-- people_payroll_check: each rebuilds the demo too); not while a migration is
-- being applied. It gives the same answer on any day: periods and due dates
-- are fixed, and the course dates are planted around today's date in Malaysia
-- (d), the one date the functions read.
-- x(who, what, call, want) runs a call as one person: want null = it must go
-- through, '=<json>' = it must return that, else the refusal code expected.
-- v(what, query, want) reads one value as the database owner.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mfa uuid := gen_random_uuid();
  ma uuid := gen_random_uuid(); mb uuid := gen_random_uuid(); mv uuid := gen_random_uuid();
  late uuid := gen_random_uuid(); outs uuid := gen_random_uuid(); dv uuid := gen_random_uuid(); da uuid := gen_random_uuid();
  ea uuid; eb uuid; ev uuid; g uuid; g2 uuid; rd uuid; rr uuid; rb uuid; c0 uuid; c1 uuid; c2 uuid; c3 uuid; co uuid;
  ad uuid; ap uuid; ao uuid; de uuid; dr uuid; dc uuid; dn uuid;
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  sc text := '{"Delivery":4.5,"Teamwork":4,"Ownership":3.5,"Communication":3}';
  who uuid; lbl text; q text; want text; r jsonb; snap text; t text; i int; j int; ctx text;
  fails text[] := '{}';
  tabs text[] := array['hr_goals','hr_scorecards','hr_reviews','hr_trainings','hr_training_enrolments','hr_announcements','hr_announcement_reads'];
  fns text[] := array['hr_save_goal(uuid,uuid,text,int,date,boolean)','hr_delete_goal(uuid)',
    'hr_save_review(uuid,uuid,text,jsonb,text,text)','hr_release_review(uuid)','hr_unrelease_review(uuid)','hr_delete_review(uuid)',
    'hr_save_training(uuid,uuid,text,text,text,date,date)','hr_delete_training(uuid)','hr_enrol(uuid,uuid)','hr_unenrol(uuid,uuid)',
    'hr_set_training_completed(uuid,uuid,boolean)','hr_save_announcement(uuid,uuid,text,text,text,boolean)',
    'hr_publish_announcement(uuid)','hr_unpublish_announcement(uuid)','hr_delete_announcement(uuid)',
    'hr_mark_announcements_read(uuid)','hr_unread_announcements(uuid)'];
begin
  begin
  -- the catalogue: functions, grants, policies
  foreach t in array fns loop
    select count(*) into i from pg_proc p where p.oid = to_regprocedure('public.' || t) and p.prosecdef and p.proconfig @> array['search_path=public'];
    if i <> 1 or has_function_privilege('anon', 'public.' || t, 'execute') or has_function_privilege('public', 'public.' || t, 'execute')
       or not has_function_privilege('authenticated', 'public.' || t, 'execute') then
      fails := fails || format('%s is not a definer function on a fixed search path for signed-in users only', t);
    end if;
  end loop;
  select count(*) filter (where n.nspname = 'public' and p.proname = any (select split_part(f, '(', 1) from unnest(fns) f)),
    count(*) filter (where n.nspname = 'private' and p.proname ~ '^(hr_perf_|hr_ann|hr_review_json)'),
    count(*) filter (where n.nspname = 'private' and (p.proname like 'hr\_%' or p.proname = 'reseed_demo_people')
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')))
  into i, j, ctx from pg_proc p join pg_namespace n on n.oid = p.pronamespace;
  if i <> 17 or j <> 9 or ctx <> '0' then fails := fails || format('%s public functions (17), %s helpers (9), %s helpers callable (0)', i, j, ctx); end if;
  foreach t in array tabs loop
    select count(*) filter (where (p.policyname = t || '_select' and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE')
      or (p.policyname = 'mfa_required' and p.cmd = 'ALL' and p.permissive = 'RESTRICTIVE' and p.qual like '%mfa_ok()%')), count(*)
    into i, j from pg_policies p where p.schemaname = 'public' and p.tablename = t;
    if i <> 2 or j <> 2 or not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass)
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE') or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') or has_any_column_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE')
       or not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      fails := fails || format('%s is not read-only behind its read policy and the second-factor one', t);
    end if;
  end loop;
  if cardinality(fails) > 0 then raise exception 'the functions, grants and policies are not as expected, so nothing else was tried'; end if;

  execute $f$
    create function pg_temp.x(who uuid, label text, q text, want text, aal text default 'aal1') returns text[] language plpgsql as $b$
    declare r jsonb; got text; ok boolean;
    begin
      perform set_config('request.jwt.claims', case when who is null then '{"role":"authenticated"}'
        else json_build_object('sub', who, 'role', 'authenticated', 'aal', aal)::text end, true);
      set local role authenticated;
      begin execute 'select to_jsonb(' || q || ')' into r;
      exception when others then got := sqlerrm; end;
      reset role;
      ok := case when want is null then got is null when left(want, 1) = '=' then got is null and r = substr(want, 2)::jsonb else got is not distinct from want end;
      if ok then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, coalesce(want, 'it to go through'), coalesce(got, r::text))];
    end $b$
  $f$;
  execute $f$
    create function pg_temp.v(label text, q text, want text) returns text[] language plpgsql as $b$
    declare got text;
    begin
      execute 'select (' || q || ')::text' into got;
      return case when got is not distinct from want then '{}' else array[format('%s: wanted %s, got %s', label, want, got)] end;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.snap(o uuid) returns text language sql as $b$
      select md5(coalesce(string_agg(s.x, ',' order by s.x), '')) from (
        select a::text as x from public.hr_goals a where a.org_id = o union all select a::text from public.hr_reviews a where a.org_id = o
        union all select a::text from public.hr_trainings a where a.org_id = o union all select a::text from public.hr_training_enrolments a where a.org_id = o
        union all select a::text from public.hr_announcements a where a.org_id = o union all select x::text from public.hr_announcement_reads x join public.hr_announcements a on a.id = x.announcement_id where a.org_id = o) s
    $b$
  $f$;

  -- people and workspaces
  -- own: owner, no employee record here (one in the other workspace, where
  -- they are an admin). adm: admin, with one. mfa: admin with a
  -- verified authenticator. ma, mb: members; mv: a viewer; each linked to an
  -- employee. late: a member who joins at this very moment. outs: owner of
  -- another workspace. dv, da: a visitor and an admin of the demo.
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u || '@perf-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mfa, ma, mb, mv, late, outs, dv, da]) u;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now());
  update public.profiles set full_name = case user_id when own then 'Olive Owner' else 'Not This Name' end where user_id in (own, adm);
  insert into public.orgs (id, name) values (org, 'Perf Check Sdn Bhd'), (oth, 'Perf Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role, created_at)
  select org, u, case when u = own then 'owner' when u in (adm, mfa) then 'admin' when u = mv then 'viewer' else 'member' end,
    case when u = late then now() else now() - interval '1 day' end
  from unnest(array[own, adm, mfa, ma, mb, mv, late]) u;
  insert into public.org_members (org_id, user_id, role, created_at)
  values (oth, outs, 'owner', now() - interval '1 day'), (oth, own, 'admin', now() - interval '1 day'), (demo, dv, 'viewer', now() - interval '1 year'), (demo, da, 'admin', now() - interval '1 year');
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'A', 'Member A', ma) returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'B', 'Member B', mb) returning id into eb;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'V', 'Viewer V', mv) returning id into ev;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'D', 'Adam Admin', adm), (oth, 'O', 'Other Hat', own);
  insert into public.hr_trainings (org_id, title, starts_on, ends_on) values (oth, 'Elsewhere', d, d) returning id into co;
  insert into public.hr_announcements (org_id, title) values (oth, 'Elsewhere') returning id into ao;
  -- A read mark that is none of this workspace's business: nothing below may count it.
  insert into public.hr_announcement_reads (announcement_id, user_id) values (ao, outs);
  perform private.reseed_demo_people();
  perform private.reseed_demo_people();
  de := md5('rimba-emp-1')::uuid;
  dc := md5('rimba-training-4')::uuid;
  select a.id into dr from public.hr_reviews a where a.org_id = demo and a.status = 'draft' limit 1;
  select a.id into dn from public.hr_announcements a where a.org_id = demo and a.status = 'draft';

  -- 1. who may call what
  -- Rows for everyone to try their hand at: a goal, a draft and a released
  -- review of A; a course running today with B on it; a course starting
  -- tomorrow with A on it; a draft and a published announcement.
  insert into public.hr_goals (org_id, employee_id, title) values (org, ea, 'Planted') returning id into g;
  insert into public.hr_reviews (org_id, employee_id, period, rating, score) values (org, ea, 'H1 2030', 'meets', 3) returning id into rd;
  insert into public.hr_reviews (org_id, employee_id, period, rating, score, status, released_at) values (org, ea, 'H2 2030', 'meets', 3, 'released', now()) returning id into rr;
  insert into public.hr_reviews (org_id, employee_id, period, rating, score, status, released_at) values (org, eb, 'H2 2030', 'meets', 3, 'released', now()) returning id into rb;
  insert into public.hr_trainings (org_id, title, starts_on, ends_on) values (org, 'Running', d - 1, d + 1) returning id into c0;
  insert into public.hr_trainings (org_id, title, starts_on, ends_on) values (org, 'Tomorrow', d + 1, d + 2) returning id into c1;
  insert into public.hr_training_enrolments (org_id, employee_id, training_id) values (org, eb, c0), (org, ea, c1);
  insert into public.hr_announcements (org_id, title, status, published_at) values (org, 'Draft', 'draft', null) returning id into ad;
  insert into public.hr_announcements (org_id, title, published_at) values (org, 'Old news', now() - interval '2 days') returning id into ap;
  snap := pg_temp.snap(org);
  for who, lbl in select * from (values (ma, 'the employee'), (mb, 'another member'), (mv, 'a viewer'), (outs, 'another workspace''s owner'),
    (dv, 'a demo visitor'), (mfa, 'an admin who owes a second factor'), (null::uuid, 'nobody')) c(who, lbl)
  loop
    for q, want, i in select * from (values
      (format('hr_save_goal(%L,null,''Mine'',10,null,false)', ea), 'PERF_NOT_FOUND', 1),
      (format('hr_save_goal(%L,%L,''Mine'',10,null,false)', ea, g), 'PERF_NOT_FOUND', 1),
      (format('hr_delete_goal(%L)', g), 'PERF_NOT_FOUND', 1),
      (format('hr_enrol(%L,%L)', c0, ea), 'PERF_NOT_FOUND', 1),
      (format('hr_unenrol(%L,%L)', c1, ea), 'PERF_NOT_FOUND', 1),
      (format('hr_save_review(%L,null,''FY 2031'',%L,''meets'',null)', ea, sc), 'PERF_NOT_FOUND', 0),
      (format('hr_save_review(%L,%L,''FY 2031'',%L,''meets'',null)', ea, rd, sc), 'PERF_NOT_FOUND', 0),
      (format('hr_release_review(%L)', rd), 'PERF_NOT_FOUND', 0),
      (format('hr_unrelease_review(%L)', rr), 'PERF_NOT_FOUND', 0),
      (format('hr_delete_review(%L)', rd), 'PERF_NOT_FOUND', 0),
      (format('hr_save_training(%L,null,''Mine'',null,null,%L,%L)', org, d, d), 'PERF_NOT_ALLOWED', 0),
      (format('hr_save_training(%L,%L,''Mine'',null,null,%L,%L)', org, c0, d, d), 'PERF_NOT_FOUND', 0),
      (format('hr_delete_training(%L)', c1), 'PERF_NOT_FOUND', 0),
      (format('hr_set_training_completed(%L,%L,true)', c0, eb), 'PERF_NOT_FOUND', 0),
      (format('hr_save_announcement(%L,null,''Mine'','''',''general'',true)', org), 'ANN_NOT_ALLOWED', 0),
      (format('hr_save_announcement(%L,%L,''Mine'','''',''general'',true)', org, ad), 'ANN_NOT_FOUND', 0),
      (format('hr_publish_announcement(%L)', ad), 'ANN_NOT_FOUND', 0),
      (format('hr_unpublish_announcement(%L)', ap), 'ANN_NOT_FOUND', 0),
      (format('hr_delete_announcement(%L)', ap), 'ANN_NOT_FOUND', 0)) c(q, want, own_too)
    loop
      -- The employee concerned may do the first five (section 2 and 4 show them going through).
      continue when who = ma and i = 1;
      fails := fails || pg_temp.x(who, lbl || ': ' || split_part(q, '(', 1), q, case when who is null then split_part(want, '_', 1) || '_NOT_ALLOWED' else want end);
    end loop;
    -- Marks and the count are for members: A, B and the viewer are, the rest are not.
    if who not in (ma, mb, mv) or who is null then
      fails := fails || pg_temp.x(who, lbl || ' marks read', format('hr_mark_announcements_read(%L)', org), 'ANN_NOT_ALLOWED')
        || pg_temp.x(who, lbl || ' counts unread', format('hr_unread_announcements(%L)', org), '=0');
    end if;
  end loop;
  fails := fails || pg_temp.v('someone who may not act changed a row', format('select pg_temp.snap(%L)', org), snap);
  fails := fails
    -- An id that is nothing, or of another workspace, is answered as an id the caller may not use is.
    || pg_temp.x(own, 'no such employee', format('hr_save_goal(%L,null,''x'',1,null,false)', gen_random_uuid()), 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'a null employee', 'hr_save_review(null,null,''FY 2031'',''{}'',''meets'',null)', 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'no such goal', format('hr_delete_goal(%L)', gen_random_uuid()), 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'no such review', format('hr_release_review(%L)', gen_random_uuid()), 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'no such course', format('hr_delete_training(%L)', gen_random_uuid()), 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'a null course', 'hr_delete_training(null)', 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'a null review', 'hr_delete_review(null)', 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'a null goal', 'hr_delete_goal(null)', 'PERF_NOT_FOUND')
    || pg_temp.x(adm, 'another workspace''s course', format('hr_enrol(%L,%L)', co, ea), 'PERF_NOT_FOUND')
    || pg_temp.x(adm, 'a course under another workspace''s name', format('hr_save_training(%L,%L,''x'',null,null,%L,%L)', oth, c0, d, d), 'PERF_NOT_FOUND')
    || pg_temp.x(adm, 'a workspace the admin is no part of', format('hr_save_training(%L,null,''x'',null,null,%L,%L)', oth, d, d), 'PERF_NOT_ALLOWED')
    || pg_temp.x(own, 'no workspace', format('hr_save_training(null,null,''x'',null,null,%L,%L)', d, d), 'PERF_NOT_ALLOWED')
    || pg_temp.x(own, 'no such announcement', format('hr_publish_announcement(%L)', gen_random_uuid()), 'ANN_NOT_FOUND')
    || pg_temp.x(own, 'a null announcement, published', 'hr_publish_announcement(null)', 'ANN_NOT_FOUND')
    || pg_temp.x(own, 'a null announcement, pulled back', 'hr_unpublish_announcement(null)', 'ANN_NOT_FOUND')
    || pg_temp.x(own, 'a null announcement, deleted', 'hr_delete_announcement(null)', 'ANN_NOT_FOUND')
    || pg_temp.x(null, 'nobody, with no id', 'hr_delete_announcement(null)', 'ANN_NOT_ALLOWED')
    || pg_temp.x(null, 'nobody, with no course', 'hr_delete_training(null)', 'PERF_NOT_ALLOWED')
    || pg_temp.x(adm, 'another workspace''s announcement', format('hr_delete_announcement(%L)', ao), 'ANN_NOT_FOUND')
    || pg_temp.x(adm, 'an announcement under another workspace''s name', format('hr_save_announcement(%L,%L,''x'','''',''general'',false)', oth, ad), 'ANN_NOT_FOUND')
    || pg_temp.x(adm, 'an announcement in a workspace the admin is no part of', format('hr_save_announcement(%L,null,''x'','''',''general'',false)', oth), 'ANN_NOT_ALLOWED')
    -- With the second factor entered, that admin is an admin again.
    || pg_temp.x(mfa, 'an admin who entered their second factor', format('hr_release_review(%L)', rd), null, 'aal2')
    || pg_temp.x(mfa, 'the same, pulling it back', format('hr_unrelease_review(%L)', rd), null, 'aal2');
  -- The owner, then the admin, take every function through.
  foreach who in array array[own, adm] loop
    lbl := case when who = own then 'the owner ' else 'the admin ' end;
    fails := fails || pg_temp.x(who, lbl || 'adds a goal', format('hr_save_goal(%L,null,'' Ship it '',40,''2030-06-30'',true) - ''id''', eb),
      format('={"employee_id":"%s","title":"Ship it","progress":40,"due_date":"2030-06-30","status":"at_risk"}', eb));
    select a.id into g2 from public.hr_goals a where a.employee_id = eb;
    fails := fails
      || pg_temp.x(who, lbl || 'changes a goal', format('hr_save_goal(%L,%L,''Shipped'',100,null,true)', eb, g2),
        format('={"id":"%s","employee_id":"%s","title":"Shipped","progress":100,"due_date":null,"status":"done"}', g2, eb))
      || pg_temp.x(who, lbl || 'deletes a goal', format('hr_delete_goal(%L)', g2), format('={"id":"%s","employee_id":"%s"}', g2, eb))
      || pg_temp.x(who, lbl || 'adds a review', format('hr_save_review(%L,null,''FY 2031'',%L,''exceeds'',''  Fine work  '')', eb, sc), null);
    select a.id into g2 from public.hr_reviews a where a.employee_id = eb and a.period = 'FY 2031';
    fails := fails || pg_temp.x(who, lbl || 'changes a review', format('hr_save_review(%L,%L,''FY 2031'',%L,''meets'',''  Fine work  '')', eb, g2, sc),
        format('={"id":"%s","employee_id":"%s","period":"FY 2031","competencies":%s,"score":3.75,"rating":"meets","comment":"Fine work","status":"draft","released_at":null,"reviewer_name":"%s","reviewed_at":"%s"}',
          g2, eb, sc, case when who = own then 'Olive Owner' else 'Adam Admin' end, d))
      || pg_temp.v(lbl || 'is the reviewer', format('select reviewer_id from public.hr_reviews where id = %L', g2), who::text)
      || pg_temp.x(who, lbl || 'releases', format('hr_release_review(%L) - ''released_at''', g2),
        format('={"id":"%s","employee_id":"%s","period":"FY 2031","competencies":%s,"score":3.75,"rating":"meets","comment":"Fine work","status":"released","reviewer_name":"%s","reviewed_at":"%s"}',
          g2, eb, sc, case when who = own then 'Olive Owner' else 'Adam Admin' end, d))
      || pg_temp.v(lbl || 'released it now', format('select status || (released_at = now()) from public.hr_reviews where id = %L', g2), 'releasedtrue')
      || pg_temp.x(who, lbl || 'changes a released review', format('hr_save_review(%L,%L,''FY 2031'',%L,''meets'',null)', eb, g2, sc), 'PERF_NOT_DRAFT')
      || pg_temp.x(who, lbl || 'deletes a released review', format('hr_delete_review(%L)', g2), 'PERF_NOT_DRAFT')
      || pg_temp.x(who, lbl || 'releases twice', format('hr_release_review(%L)', g2), 'PERF_NOT_DRAFT')
      || pg_temp.x(who, lbl || 'pulls back', format('hr_unrelease_review(%L) #>> ''{status}''', g2), '="draft"')
      || pg_temp.v(lbl || 'pulled it back', format('select status || (released_at is null) from public.hr_reviews where id = %L', g2), 'drafttrue')
      || pg_temp.x(who, lbl || 'pulls back twice', format('hr_unrelease_review(%L)', g2), 'PERF_NOT_RELEASED')
      || pg_temp.x(who, lbl || 'deletes a draft', format('hr_delete_review(%L)', g2), format('={"id":"%s","employee_id":"%s"}', g2, eb))
      || pg_temp.x(who, lbl || 'adds a course', format('hr_save_training(%L,null,'' Course '','' Skills '','''',%L,%L) - ''id''', org, d, d + 1),
        format('={"title":"Course","category":"Skills","provider":null,"starts_on":"%s","ends_on":"%s"}', d, d + 1));
    select a.id into g2 from public.hr_trainings a where a.org_id = org and a.title = 'Course';
    fails := fails || pg_temp.x(who, lbl || 'changes a course', format('hr_save_training(null,%L,''Course'',null,''Them'',%L,%L)', g2, d - 1, d),
        format('={"id":"%s","title":"Course","category":null,"provider":"Them","starts_on":"%s","ends_on":"%s"}', g2, d - 1, d))
      || pg_temp.x(who, lbl || 'enrols someone', format('hr_enrol(%L,%L)', g2, eb), format('={"training_id":"%s","employee_id":"%s","completed":false}', g2, eb))
      || pg_temp.x(who, lbl || 'marks completed', format('hr_set_training_completed(%L,%L,true)', g2, eb), format('={"training_id":"%s","employee_id":"%s","completed":true}', g2, eb))
      || pg_temp.v(lbl || 'marked completed', format('select completed || (completed_at = now())::text || completed_by from public.hr_training_enrolments where training_id = %L', g2), 'truetrue' || who)
      || pg_temp.x(who, lbl || 'removes someone completed', format('hr_unenrol(%L,%L)', g2, eb), 'PERF_COMPLETED')
      || pg_temp.x(who, lbl || 'deletes a course with a completion', format('hr_delete_training(%L)', g2), 'PERF_COMPLETED')
      || pg_temp.x(who, lbl || 'undoes completed', format('hr_set_training_completed(%L,%L,false) #> ''{completed}''', g2, eb), '=false')
      || pg_temp.v(lbl || 'undid completed', format('select completed || coalesce(completed_at::text, completed_by::text, ''-'') from public.hr_training_enrolments where training_id = %L', g2), 'false-')
      || pg_temp.x(who, lbl || 'removes someone', format('hr_unenrol(%L,%L)', g2, eb), format('={"training_id":"%s","employee_id":"%s"}', g2, eb))
      || pg_temp.x(who, lbl || 'removes someone twice', format('hr_unenrol(%L,%L)', g2, eb), 'PERF_NOT_ENROLLED')
      || pg_temp.x(who, lbl || 'enrols again', format('hr_enrol(%L,%L)', g2, eb), null)
      || pg_temp.x(who, lbl || 'deletes a course', format('hr_delete_training(%L)', g2), format('={"id":"%s"}', g2))
      || pg_temp.v(lbl || 'deleted its enrolments', format('select count(*) from public.hr_training_enrolments where training_id = %L', g2), '0')
      || pg_temp.x(who, lbl || 'drafts an announcement', format('hr_save_announcement(%L,null,'' Hello '',''Body '',''policy'',null) - ''id''', org),
        '={"title":"Hello","body":"Body ","category":"policy","status":"draft","published_at":null,"edited_at":null,"author_name":null}');
    select a.id into g2 from public.hr_announcements a where a.org_id = org and a.title = 'Hello';
    fails := fails || pg_temp.x(who, lbl || 'changes a draft', format('hr_save_announcement(%L,%L,''Hello'',null,''general'',false) - ''id''', org, g2),
        '={"title":"Hello","body":"","category":"general","status":"draft","published_at":null,"edited_at":null,"author_name":null}')
      || pg_temp.x(who, lbl || 'unpublishes a draft', format('hr_unpublish_announcement(%L)', g2), 'ANN_NOT_PUBLISHED')
      || pg_temp.x(who, lbl || 'publishes', format('hr_publish_announcement(%L) - ''published_at''', g2),
        format('={"id":"%s","title":"Hello","body":"","category":"general","status":"published","edited_at":null,"author_name":"%s"}', g2, case when who = own then 'Olive Owner' else 'Adam Admin' end))
      || pg_temp.v(lbl || 'published it now', format('select (published_at = now())::text || author_id from public.hr_announcements where id = %L', g2), 'true' || who)
      || pg_temp.x(who, lbl || 'publishes twice', format('hr_publish_announcement(%L)', g2), 'ANN_NOT_DRAFT')
      || pg_temp.x(who, lbl || 'pulls an announcement back', format('hr_unpublish_announcement(%L) #>> ''{status}''', g2), '="draft"')
      || pg_temp.x(who, lbl || 'publishes by saving', format('hr_save_announcement(null,%L,''Hello'',''B'',''general'',true) #>> ''{status}''', g2), '="published"')
      || pg_temp.x(who, lbl || 'marks read', format('hr_mark_announcements_read(%L)', org), '={"marked":1}')
      || pg_temp.v(lbl || 'has a mark', format('select count(*) from public.hr_announcement_reads where announcement_id = %L and user_id = %L', g2, who), '1')
      || pg_temp.x(who, lbl || 'deletes an announcement', format('hr_delete_announcement(%L)', g2), format('={"id":"%s"}', g2))
      || pg_temp.v(lbl || 'deleted its marks', format('select count(*) from public.hr_announcement_reads where user_id = %L', who), '0');
  end loop;
  if cardinality(fails) > 0 then raise exception 'who may call what is not as expected, so the rules were not tried'; end if;

  -- 2. goals
  fails := fails
    || pg_temp.x(ma, 'A adds their own goal', format('hr_save_goal(%L,null,''Mine'',0,null,null) #>> ''{status}''', ea), '="on_track"')
    || pg_temp.x(ma, 'A changes their own goal', format('hr_save_goal(%L,%L,''Mine'',99,''2000-01-01'',true) #>> ''{status}''', ea, g), '="at_risk"')
    || pg_temp.x(ma, 'A finishes it, at risk or not', format('hr_save_goal(%L,%L,''Mine'',100,''2100-12-31'',true) #>> ''{status}''', ea, g), '="done"')
    || pg_temp.x(ma, 'A reopens it', format('hr_save_goal(%L,%L,''Mine'',50,null,false) #>> ''{status}''', ea, g), '="on_track"')
    || pg_temp.x(mv, 'the viewer adds their own goal', format('hr_save_goal(%L,null,''Mine'',0,null,false)', ev), null)
    || pg_temp.x(mb, 'B changes A''s goal under their own name', format('hr_save_goal(%L,%L,''Mine'',10,null,false)', eb, g), 'PERF_NOT_FOUND')
    || pg_temp.x(own, 'the owner changes A''s goal under B''s name', format('hr_save_goal(%L,%L,''Mine'',10,null,false)', eb, g), 'PERF_NOT_FOUND');
  for lbl, q in select * from (values ('a blank title', '''  '',10,null'), ('no title', 'null,10,null'), ('a title of 201', format('%L,10,null', repeat('x', 201))),
    ('progress below 0', '''x'',-1,null'), ('progress above 100', '''x'',101,null'), ('no progress', '''x'',null,null'),
    ('a date before 2000', '''x'',10,''1999-12-31'''), ('a date after 2100', '''x'',10,''2101-01-01''')) c(lbl, q)
  loop
    fails := fails || pg_temp.x(ma, 'a goal with ' || lbl, format('hr_save_goal(%L,null,%s,false)', ea, q), 'PERF_BAD_INPUT')
      || pg_temp.x(ma, 'a goal changed to ' || lbl, format('hr_save_goal(%L,%L,%s,false)', ea, g, q), 'PERF_BAD_INPUT');
  end loop;
  -- A has two open goals. With 27 more and five done ones planted, the next is the 30th, and the one after is refused.
  insert into public.hr_goals (org_id, employee_id, title, progress, status)
  select org, ea, 'Planted ' || n, case when n > 27 then 100 else 0 end, case when n > 27 then 'done' else 'on_track' end from generate_series(1, 32) n;
  fails := fails || pg_temp.x(ma, 'the 30th open goal', format('hr_save_goal(%L,null,''Thirty'',1,null,false)', ea), null)
    || pg_temp.x(ma, 'the 31st open goal', format('hr_save_goal(%L,null,''Too many'',1,null,false)', ea), 'PERF_TOO_MANY_GOALS')
    || pg_temp.x(own, 'the 31st, by the owner', format('hr_save_goal(%L,null,''Too many'',1,null,false)', ea), 'PERF_TOO_MANY_GOALS')
    || pg_temp.x(ma, 'changing one of 30', format('hr_save_goal(%L,%L,''Mine'',60,null,false)', ea, g), null)
    || pg_temp.x(ma, 'finishing one of 30', format('hr_save_goal(%L,%L,''Mine'',100,null,false)', ea, g), null)
    || pg_temp.x(ma, 'another once one is done', format('hr_save_goal(%L,null,''Thirty again'',1,null,false)', ea), null)
    || pg_temp.x(ma, 'A deletes their own goal', format('hr_delete_goal(%L)', g), format('={"id":"%s","employee_id":"%s"}', g, ea))
    || pg_temp.x(ma, 'A deletes it twice', format('hr_delete_goal(%L)', g), 'PERF_NOT_FOUND')
    || pg_temp.v('A''s goals', format('select count(*) || ''/'' || count(*) filter (where status <> ''done'') from public.hr_goals where employee_id = %L', ea), '35/30');

  -- 3. reviews
  for lbl, q in select * from (values
    ('a fifth key', '''FY 2031'',''{"Delivery":4,"Teamwork":4,"Ownership":4,"Communication":4,"Extra":4}'',''meets'',null'),
    ('a missing key', '''FY 2031'',''{"Delivery":4,"Teamwork":4,"Ownership":4}'',''meets'',null'),
    ('a key by another name', '''FY 2031'',''{"Delivery":4,"Teamwork":4,"Ownership":4,"communication":4}'',''meets'',null'),
    ('a score of 0.5', '''FY 2031'',''{"Delivery":0.5,"Teamwork":4,"Ownership":4,"Communication":4}'',''meets'',null'),
    ('a score of 5.5', '''FY 2031'',''{"Delivery":4,"Teamwork":4,"Ownership":4,"Communication":5.5}'',''meets'',null'),
    ('a score of 3.25', '''FY 2031'',''{"Delivery":4,"Teamwork":3.25,"Ownership":4,"Communication":4}'',''meets'',null'),
    ('a score in words', '''FY 2031'',''{"Delivery":4,"Teamwork":4,"Ownership":"4","Communication":4}'',''meets'',null'),
    ('a score that is null', '''FY 2031'',''{"Delivery":null,"Teamwork":4,"Ownership":4,"Communication":4}'',''meets'',null'),
    ('a score that is true', '''FY 2031'',''{"Delivery":4,"Teamwork":true,"Ownership":4,"Communication":4}'',''meets'',null'),
    ('scores that are a list', '''FY 2031'',''[4,4,4,4]'',''meets'',null'), ('no scores', '''FY 2031'',null,''meets'',null'),
    ('a quarter', format('''Q1 2031'',%L,''meets'',null', sc)), ('a period with no year', format('''H1'',%L,''meets'',null', sc)),
    ('a period in small letters', format('''h1 2031'',%L,''meets'',null', sc)), ('a period with more after it', format('''H1 2031 '',%L,''meets'',null', sc)),
    ('no period', format('null,%L,''meets'',null', sc)), ('the year 1999', format('''H2 1999'',%L,''meets'',null', sc)),
    ('the year 2101', format('''FY 2101'',%L,''meets'',null', sc)), ('an unknown rating', format('''FY 2031'',%L,''great'',null', sc)),
    ('no rating', format('''FY 2031'',%L,null,null', sc)), ('a comment of 2,001', format('''FY 2031'',%L,''meets'',%L', sc, repeat('x', 2001)))) c(lbl, q)
  loop
    fails := fails || pg_temp.x(adm, 'a review with ' || lbl, format('hr_save_review(%L,null,%s)', ea, q), 'PERF_BAD_INPUT')
      || pg_temp.x(adm, 'a review changed to ' || lbl, format('hr_save_review(%L,%L,%s)', ea, rd, q), 'PERF_BAD_INPUT');
  end loop;
  fails := fails
    || pg_temp.x(adm, 'the first year, a comment of 2,000', format('hr_save_review(%L,null,''H1 2000'',''{"Delivery":5,"Teamwork":5,"Ownership":5,"Communication":4.5}'',''exceeds'',%L) #> ''{score}''', ea, repeat('x', 2000)), '=4.88')
    || pg_temp.x(own, 'the last year', format('hr_save_review(%L,null,''FY 2100'',''{"Delivery":1,"Teamwork":1,"Ownership":1,"Communication":1.5}'',''below'',''  '') - ''id''', ea),
      format('={"employee_id":"%s","period":"FY 2100","competencies":{"Delivery":1,"Teamwork":1,"Ownership":1,"Communication":1.5},"score":1.13,"rating":"below","comment":null,"status":"draft","released_at":null,"reviewer_name":"Olive Owner","reviewed_at":"%s"}', ea, d))
    || pg_temp.x(adm, 'whole scores written with a point', format('hr_save_review(%L,%L,''H1 2030'',''{"Delivery":5.0,"Teamwork":1.0,"Ownership":2.50,"Communication":3}'',''meets'',null) - ''id'' - ''employee_id'' - ''reviewed_at''', ea, rd),
      '={"period":"H1 2030","competencies":{"Delivery":5,"Teamwork":1,"Ownership":2.5,"Communication":3},"score":2.88,"rating":"meets","comment":null,"status":"draft","released_at":null,"reviewer_name":"Adam Admin"}')
    || pg_temp.v('whoever changed it is the reviewer', format('select reviewer_id || ''/'' || reviewer_name || ''/'' || reviewed_at from public.hr_reviews where id = %L', rd), adm || '/Adam Admin/' || d)
    || pg_temp.x(adm, 'a second review for a period', format('hr_save_review(%L,null,''H1 2030'',%L,''meets'',null)', ea, sc), 'PERF_REVIEW_EXISTS')
    || pg_temp.x(adm, 'a second for a released one''s period', format('hr_save_review(%L,null,''H2 2030'',%L,''meets'',null)', ea, sc), 'PERF_REVIEW_EXISTS')
    || pg_temp.x(adm, 'a review moved onto another''s period', format('hr_save_review(%L,%L,''H2 2030'',%L,''meets'',null)', ea, rd, sc), 'PERF_REVIEW_EXISTS')
    || pg_temp.x(adm, 'the same period for someone else', format('hr_save_review(%L,null,''H1 2030'',%L,''meets'',null)', eb, sc), null)
    || pg_temp.x(adm, 'A''s review under B''s name', format('hr_save_review(%L,%L,''FY 2031'',%L,''meets'',null)', eb, rd, sc), 'PERF_NOT_FOUND')
    || pg_temp.x(adm, 'a released review changed', format('hr_save_review(%L,%L,''H2 2030'',''{}'',''great'',null)', ea, rr), 'PERF_NOT_DRAFT')
    -- Reading. A has three drafts and one released review; B one of each.
    || pg_temp.v('reviews on file', format('select count(*) || ''/'' || count(*) filter (where status = ''released'') from public.hr_reviews where org_id = %L', org), '6/2')
    || pg_temp.x(ma, 'A reads their released review only', format('(select string_agg(id::text, '','') from hr_reviews where org_id = %L)', org), format('="%s"', rr))
    || pg_temp.x(mb, 'B reads their released review only', format('(select string_agg(id::text, '','') from hr_reviews where org_id = %L)', org), format('="%s"', rb))
    || pg_temp.x(mv, 'the viewer reads no review', format('(select count(*) from hr_reviews where org_id = %L)', org), '=0')
    || pg_temp.x(outs, 'another workspace reads no review', format('(select count(*) from hr_reviews where org_id = %L)', org), '=0')
    || pg_temp.x(mfa, 'an admin who owes a second factor reads no review', format('(select count(*) from hr_reviews where org_id = %L)', org), '=0')
    || pg_temp.x(adm, 'the admin reads every review', format('(select count(*) from hr_reviews where org_id = %L)', org), '=6')
    || pg_temp.x(own, 'the owner reads every review', format('(select count(*) from hr_reviews where org_id = %L)', org), '=6')
    || pg_temp.x(ma, 'A releases their own draft', format('hr_release_review(%L)', rd), 'PERF_NOT_FOUND')
    || pg_temp.x(adm, 'the admin pulls A''s review back', format('hr_unrelease_review(%L)', rr), null)
    || pg_temp.x(ma, 'A reads nothing once it is pulled back', format('(select count(*) from hr_reviews where org_id = %L)', org), '=0')
    || pg_temp.x(adm, 'the admin releases A''s draft', format('hr_release_review(%L)', rd), null)
    || pg_temp.x(ma, 'A reads the one just released', format('(select string_agg(id::text, '','') from hr_reviews where org_id = %L)', org), format('="%s"', rd));

  -- 4. training
  -- c0 started yesterday and will end today; c1 starts tomorrow; c2 is today only; c3 ended yesterday.
  for lbl, q in select * from (values ('an end before its start', format('''x'',null,null,%L,%L', d, d - 1)), ('no start', format('''x'',null,null,null,%L', d)),
    ('no end', format('''x'',null,null,%L,null', d)), ('a blank title', format(''' '',null,null,%L,%L', d, d)), ('no title', format('null,null,null,%L,%L', d, d)),
    ('a title of 201', format('%L,null,null,%L,%L', repeat('x', 201), d, d)), ('a category of 81', format('''x'',%L,null,%L,%L', repeat('x', 81), d, d)),
    ('a provider of 81', format('''x'',null,%L,%L,%L', repeat('x', 81), d, d))) c(lbl, q)
  loop
    fails := fails || pg_temp.x(adm, 'a course with ' || lbl, format('hr_save_training(%L,null,%s)', org, q), 'PERF_BAD_INPUT')
      || pg_temp.x(adm, 'a course changed to ' || lbl, format('hr_save_training(%L,%L,%s)', org, c0, q), 'PERF_BAD_INPUT');
  end loop;
  fails := fails || pg_temp.x(adm, 'a course of one day, today', format('hr_save_training(%L,null,''Today'',null,null,%L,%L)', org, d, d), null)
    || pg_temp.x(adm, 'a course that ended yesterday', format('hr_save_training(%L,null,''Over'',null,null,%L,%L)', org, d - 2, d - 1), null)
    || pg_temp.x(adm, 'the running course now ends today', format('hr_save_training(%L,%L,''Running'',null,null,%L,%L)', org, c0, d - 1, d), null);
  select a.id into c2 from public.hr_trainings a where a.org_id = org and a.title = 'Today';
  select a.id into c3 from public.hr_trainings a where a.org_id = org and a.title = 'Over';
  insert into public.hr_trainings (org_id, title) values (org, 'No dates') returning id into g2;
  fails := fails || pg_temp.x(ma, 'A withdraws the day before the start', format('hr_unenrol(%L,%L)', c1, ea), format('={"training_id":"%s","employee_id":"%s"}', c1, ea));
  update public.hr_employees set status = 'inactive' where id = ea;
  fails := fails || pg_temp.x(ma, 'A, inactive, enrols', format('hr_enrol(%L,%L)', c1, ea), 'PERF_INACTIVE_EMPLOYEE')
    || pg_temp.x(adm, 'the admin enrols someone inactive in a course that ended', format('hr_enrol(%L,%L)', c3, ea), null);
  update public.hr_employees set status = 'active' where id = ea;
  fails := fails || pg_temp.x(ma, 'A enrols the day before the start', format('hr_enrol(%L,%L)', c1, ea), format('={"training_id":"%s","employee_id":"%s","completed":false}', c1, ea))
    || pg_temp.x(ma, 'A enrols twice', format('hr_enrol(%L,%L)', c1, ea), 'PERF_ALREADY_ENROLLED')
    || pg_temp.x(ma, 'A enrols on the first day', format('hr_enrol(%L,%L)', c2, ea), null)
    || pg_temp.x(ma, 'A enrols on the last day', format('hr_enrol(%L,%L)', c0, ea), null)
    || pg_temp.x(mb, 'B enrols the day after the end', format('hr_enrol(%L,%L)', c3, eb), 'PERF_COURSE_ENDED')
    || pg_temp.x(ma, 'A enrols in a course with no dates', format('hr_enrol(%L,%L)', g2, ea), null)
    || pg_temp.x(ma, 'A withdraws on the first day', format('hr_unenrol(%L,%L)', c2, ea), 'PERF_COURSE_STARTED')
    || pg_temp.x(ma, 'A withdraws after the end', format('hr_unenrol(%L,%L)', c3, ea), 'PERF_COURSE_STARTED')
    || pg_temp.x(mb, 'B withdraws from a course they are not on', format('hr_unenrol(%L,%L)', c3, eb), 'PERF_NOT_ENROLLED')
    || pg_temp.x(mv, 'the viewer enrols themselves', format('hr_enrol(%L,%L)', c1, ev), null)
    || pg_temp.x(mv, 'the viewer withdraws', format('hr_unenrol(%L,%L)', c1, ev), null)
    || pg_temp.x(mb, 'B withdraws A', format('hr_unenrol(%L,%L)', c1, ea), 'PERF_NOT_FOUND')
    || pg_temp.x(adm, 'completed on the first day', format('hr_set_training_completed(%L,%L,true)', c2, ea), null)
    || pg_temp.x(adm, 'and undone', format('hr_set_training_completed(%L,%L,false)', c2, ea), null)
    || pg_temp.x(adm, 'the admin removes someone after the start', format('hr_unenrol(%L,%L)', c2, ea), null)
    || pg_temp.x(adm, 'completed before the start', format('hr_set_training_completed(%L,%L,true)', c1, ea), 'PERF_COURSE_NOT_STARTED')
    || pg_temp.x(adm, 'not completed, undone before the start', format('hr_set_training_completed(%L,%L,false)', c1, ea), null)
    || pg_temp.x(adm, 'completed on a course with no dates', format('hr_set_training_completed(%L,%L,true)', g2, ea), 'PERF_COURSE_NOT_STARTED')
    || pg_temp.x(adm, 'completed for someone not enrolled', format('hr_set_training_completed(%L,%L,true)', c0, ev), 'PERF_NOT_ENROLLED')
    || pg_temp.x(adm, 'completed, neither yes nor no', format('hr_set_training_completed(%L,%L,null)', c0, ea), 'PERF_BAD_INPUT')
    || pg_temp.x(adm, 'completed on the last day', format('hr_set_training_completed(%L,%L,true)', c0, ea), null)
    || pg_temp.x(adm, 'completed after the end', format('hr_set_training_completed(%L,%L,true)', c3, ea), null)
    || pg_temp.x(ma, 'A, completed, withdraws', format('hr_unenrol(%L,%L)', c0, ea), 'PERF_COURSE_STARTED')
    || pg_temp.x(adm, 'the admin removes someone completed', format('hr_unenrol(%L,%L)', c0, ea), 'PERF_COMPLETED')
    || pg_temp.x(adm, 'a course with a completion deleted', format('hr_delete_training(%L)', c3), 'PERF_COMPLETED')
    -- Moved to start tomorrow, the course A completed has not started: the completion still holds A on it.
    || pg_temp.x(adm, 'the course is moved to tomorrow', format('hr_save_training(%L,%L,''Running'',null,null,%L,%L)', org, c0, d + 1, d + 2), null)
    || pg_temp.x(ma, 'A, completed, withdraws before the start', format('hr_unenrol(%L,%L)', c0, ea), 'PERF_COMPLETED')
    || pg_temp.x(adm, 'the completion is undone though the course has yet to start', format('hr_set_training_completed(%L,%L,false)', c0, ea), format('={"training_id":"%s","employee_id":"%s","completed":false}', c0, ea))
    || pg_temp.x(adm, 'and cannot be marked again before the start', format('hr_set_training_completed(%L,%L,true)', c0, ea), 'PERF_COURSE_NOT_STARTED')
    || pg_temp.x(ma, 'A withdraws from a course with no dates', format('hr_unenrol(%L,%L)', g2, ea), null)
    || pg_temp.x(adm, 'the completion is undone', format('hr_set_training_completed(%L,%L,false)', c3, ea), null)
    || pg_temp.x(adm, 'the course is deleted once it is undone', format('hr_delete_training(%L)', c3), null)
    || pg_temp.v('A''s enrolments, completed ones', format('select count(*) || ''/'' || count(*) filter (where completed and completed_at is not null) from public.hr_training_enrolments where employee_id = %L', ea), '2/0')
    || pg_temp.x(mb, 'B reads their own enrolment only', format('(select count(*) || ''/'' || count(*) filter (where employee_id = %L) from hr_training_enrolments where org_id = %L)', eb, org), '="1/1"');

  -- 5. announcements and unread marks
  -- ad is a draft. ap was published two days ago, before anyone joined (a day ago; `late` joins now).
  for lbl, q in select * from (values ('a blank title', ''' '',''b'',''general'''), ('no title', 'null,''b'',''general'''), ('a title of 201', format('%L,''b'',''general''', repeat('x', 201))),
    ('a body of 5,001', format('''x'',%L,''general''', repeat('x', 5001))), ('an unknown category', '''x'',''b'',''news'''), ('no category', '''x'',''b'',null')) c(lbl, q)
  loop
    fails := fails || pg_temp.x(adm, 'an announcement with ' || lbl, format('hr_save_announcement(%L,null,%s,true)', org, q), 'ANN_BAD_INPUT')
      || pg_temp.x(adm, 'an announcement changed to ' || lbl, format('hr_save_announcement(%L,%L,%s,true)', org, ad, q), 'ANN_BAD_INPUT');
  end loop;
  fails := fails || pg_temp.x(adm, 'a draft with a body of 5,000', format('hr_save_announcement(%L,null,''Long'',%L,''general'',false) #>> ''{status}''', org, repeat('x', 5000)), '="draft"')
    || pg_temp.x(ma, 'a member reads the published one only', format('(select string_agg(id::text, '','') from hr_announcements where org_id = %L)', org), format('="%s"', ap))
    || pg_temp.x(late, 'a member who joined later reads it too', format('(select count(*) from hr_announcements where org_id = %L)', org), '=1')
    || pg_temp.x(adm, 'the admin reads the drafts too', format('(select count(*) from hr_announcements where org_id = %L)', org), '=3')
    || pg_temp.x(outs, 'another workspace reads none', format('(select count(*) from hr_announcements where org_id = %L)', org), '=0')
    || pg_temp.x(ma, 'published before A joined, drafts: nothing unread', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(adm, 'nothing unread for the admin either', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(adm, 'the draft is published', format('hr_publish_announcement(%L)', ad), null)
    || pg_temp.x(ma, 'one unread for A', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.x(mv, 'one unread for the viewer', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.x(own, 'one unread for the owner', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.x(late, 'none for someone who joined as it was published', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(mfa, 'none for an admin who owes a second factor', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(mfa, 'one once they enter it', format('hr_unread_announcements(%L)', org), '=1', 'aal2')
    || pg_temp.x(late, 'who marks nothing', format('hr_mark_announcements_read(%L)', org), '={"marked":0}')
    || pg_temp.x(ma, 'A marks read', format('hr_mark_announcements_read(%L)', org), '={"marked":1}')
    || pg_temp.x(ma, 'A marks read twice', format('hr_mark_announcements_read(%L)', org), '={"marked":0}')
    || pg_temp.x(ma, 'none unread for A', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(mb, 'still one for B', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.v('the one mark is A''s, on the one just published', format('select string_agg(announcement_id || ''/'' || user_id, '','') from public.hr_announcement_reads where announcement_id in (select id from public.hr_announcements where org_id = %L)', org), ad || '/' || ma)
    || pg_temp.x(ma, 'A reads their own mark', '(select count(*) from hr_announcement_reads)', '=1')
    || pg_temp.x(mb, 'B reads no mark of A''s', '(select count(*) from hr_announcement_reads)', '=0')
    || pg_temp.x(adm, 'nor does the admin', '(select count(*) from hr_announcement_reads)', '=0');
  -- As if published an hour ago, so the times below can be told apart.
  update public.hr_announcements set published_at = now() - interval '1 hour' where id = ad;
  fails := fails || pg_temp.x(own, 'a published one is edited by someone else', format('hr_save_announcement(%L,%L,''Edited'',''New'',''holiday'',false) - ''id''', org, ad),
      format('={"title":"Edited","body":"New","category":"holiday","status":"published","published_at":%s,"edited_at":%s,"author_name":"Adam Admin"}', to_jsonb(now() - interval '1 hour'), to_jsonb(now())))
    || pg_temp.x(ma, 'an edit does not make it unread again', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(mb, 'an edit leaves B''s count', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.x(own, 'it is pulled back', format('hr_unpublish_announcement(%L) - ''id''', ad),
      format('={"title":"Edited","body":"New","category":"holiday","status":"draft","published_at":null,"edited_at":%s,"author_name":"Adam Admin"}', to_jsonb(now())))
    || pg_temp.x(mb, 'pulled back, it is not unread', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(mb, 'nor read by a member', format('(select count(*) from hr_announcements where id = %L)', ad), '=0')
    || pg_temp.x(own, 'it is published again, at a new time', format('hr_publish_announcement(%L) - ''id''', ad),
      format('={"title":"Edited","body":"New","category":"holiday","status":"published","published_at":%s,"edited_at":null,"author_name":"Olive Owner"}', to_jsonb(now())))
    || pg_temp.x(ma, 'published again, it stays read for A', format('hr_unread_announcements(%L)', org), '=0')
    || pg_temp.x(mb, 'and unread for B', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.x(adm, 'a new one is published by saving', format('hr_save_announcement(%L,null,''Second'',''b'',''general'',true) #>> ''{author_name}''', org), '="Adam Admin"')
    || pg_temp.x(ma, 'one unread for A', format('hr_unread_announcements(%L)', org), '=1')
    || pg_temp.x(mb, 'two for B', format('hr_unread_announcements(%L)', org), '=2')
    || pg_temp.x(mv, 'the viewer marks both', format('hr_mark_announcements_read(%L)', org), '={"marked":2}')
    || pg_temp.x(mb, 'still two for B', format('hr_unread_announcements(%L)', org), '=2')
    || pg_temp.x(adm, 'the announcement is deleted', format('hr_delete_announcement(%L)', ad), null)
    || pg_temp.v('its marks went with it', format('select count(*) || ''/'' || count(*) filter (where user_id = %L) from public.hr_announcement_reads where announcement_id in (select id from public.hr_announcements where org_id = %L)', mv, org), '1/1');

  -- 6. no direct writes, for anyone
  foreach t in array tabs loop
    select c.column_name into lbl from information_schema.columns c where c.table_schema = 'public' and c.table_name = t and c.ordinal_position = 1;
    foreach q in array array[format('insert into public.%I default values', t), format('update public.%I set %I = %I', t, lbl, lbl), format('delete from public.%I', t)] loop
      foreach want in array array['authenticated', 'anon'] loop
        perform set_config('request.jwt.claims', json_build_object('sub', own, 'role', want, 'aal', 'aal2')::text, true);
        execute 'set local role ' || want;
        begin
          execute q;
          reset role;
          fails := fails || format('%s ran: %s', want, q);
        exception when insufficient_privilege then reset role;
          when others then reset role; fails := fails || format('%s, %s: refused for another reason: %s', want, q, sqlerrm);
        end;
      end loop;
    end loop;
  end loop;

  -- 7. the demo: read by its members, changed by nobody
  snap := pg_temp.snap(demo);
  for who, lbl in select * from (values (dv, 'a demo visitor'), (da, 'a demo admin'), (own, 'someone outside the demo')) c(who, lbl) loop
    for q, want in select * from (values
      (format('hr_save_goal(%L,null,''Mine'',10,null,false)', de), 'PERF_NOT_FOUND'),
      (format('hr_delete_goal(%L)', (select a.id from public.hr_goals a where a.employee_id = de limit 1)), 'PERF_NOT_FOUND'),
      (format('hr_save_review(%L,null,''FY 2031'',%L,''meets'',null)', de, sc), 'PERF_NOT_FOUND'),
      (format('hr_release_review(%L)', dr), 'PERF_NOT_FOUND'),
      (format('hr_unrelease_review(%L)', (select a.id from public.hr_reviews a where a.employee_id = de)), 'PERF_NOT_FOUND'),
      (format('hr_delete_review(%L)', dr), 'PERF_NOT_FOUND'),
      (format('hr_save_training(%L,null,''Mine'',null,null,%L,%L)', demo, d, d), 'PERF_NOT_ALLOWED'),
      (format('hr_save_training(%L,%L,''Mine'',null,null,%L,%L)', demo, dc, d, d), 'PERF_NOT_FOUND'),
      (format('hr_delete_training(%L)', dc), 'PERF_NOT_FOUND'),
      (format('hr_enrol(%L,%L)', dc, de), 'PERF_NOT_FOUND'),
      (format('hr_unenrol(%L,%L)', md5('rimba-training-3')::uuid, de), 'PERF_NOT_FOUND'),
      (format('hr_set_training_completed(%L,%L,true)', md5('rimba-training-3')::uuid, de), 'PERF_NOT_FOUND'),
      (format('hr_save_announcement(%L,null,''Mine'','''',''general'',true)', demo), 'ANN_NOT_ALLOWED'),
      (format('hr_save_announcement(%L,%L,''Mine'','''',''general'',true)', demo, dn), 'ANN_NOT_FOUND'),
      (format('hr_publish_announcement(%L)', dn), 'ANN_NOT_FOUND'),
      (format('hr_unpublish_announcement(%L)', (select a.id from public.hr_announcements a where a.org_id = demo and a.status = 'published' limit 1)), 'ANN_NOT_FOUND'),
      (format('hr_delete_announcement(%L)', dn), 'ANN_NOT_FOUND'),
      (format('hr_mark_announcements_read(%L)', demo), 'ANN_NOT_ALLOWED')) c(q, want)
    loop
      fails := fails || pg_temp.x(who, lbl || ', in the demo: ' || split_part(q, '(', 1), q, case when who = own then want else split_part(want, '_', 1) || '_NOT_ALLOWED' end);
    end loop;
    -- Five announcements were published after the visitor joined a year ago: in the demo the count is still 0.
    fails := fails || pg_temp.x(who, lbl || ' counts unread in the demo', format('hr_unread_announcements(%L)', demo), '=0');
  end loop;
  fails := fails || pg_temp.v('a row was changed in the demo', format('select pg_temp.snap(%L)', demo), snap)
    || pg_temp.x(dv, 'a demo visitor reads every review and announcement, drafts too', format('(select (select count(*) || ''/'' || count(*) filter (where status = ''draft'') from hr_reviews where org_id = %1$L)'
      || ' || '' '' || (select count(*) || ''/'' || count(*) filter (where status = ''draft'') from hr_announcements where org_id = %1$L))', demo), '="20/2 6/1"')
    || pg_temp.x(ma, 'someone outside the demo reads none of them', format('(select (select count(*) from hr_reviews where org_id = %1$L) + (select count(*) from hr_announcements where org_id = %1$L))', demo), '=0')
    -- What the re-seed built: every review is a whole one, released unless a draft; one draft announcement; completions carry their time.
    || pg_temp.v('the demo''s reviews', format($q$select count(*) filter (where (a.status = 'released') = (a.released_at is not null) and a.comment <> '' and a.period ~ '^H1 20[0-9][0-9]$'
        and a.reviewer_name = 'Kavitha Nair' and a.rating = case when a.score >= 4.3 then 'exceeds' when a.score >= 3.4 then 'meets' else 'below' end
        and (select count(*) = 4 and bool_and(c.v::numeric between 1 and 5 and c.v::numeric * 2 = trunc(c.v::numeric * 2)) and round(avg(c.v::numeric), 2) = a.score
             from jsonb_each_text(a.competencies) c(k, v) where c.k in ('Delivery','Teamwork','Ownership','Communication')))
        || '/' || count(*) filter (where a.status = 'draft') || '/' || count(distinct a.employee_id) from public.hr_reviews a where a.org_id = %L$q$, demo), '20/2/20')
    || pg_temp.v('the demo''s announcements', format($q$select count(*) filter (where a.status = 'published' and a.published_at < now() and a.author_name = 'Siti Lestari')
        || '/' || count(*) filter (where a.status = 'draft' and a.published_at is null and a.author_name is null) from public.hr_announcements a where a.org_id = %L$q$, demo), '5/1')
    || pg_temp.v('the demo''s enrolments', format($q$select (count(*) filter (where a.completed) > 5) || '/' || count(*) filter (where a.completed <> (a.completed_at is not null))
        || '/' || (select count(*) from public.hr_employees e where e.org_id = a.org_id) from public.hr_training_enrolments a where a.org_id = %L group by a.org_id$q$, demo), 'true/0/20')
    || pg_temp.v('nobody in the demo has a read mark', format('select count(*) from public.hr_announcement_reads x join public.hr_announcements a on a.id = x.announcement_id where a.org_id = %L', demo), '0');

  -- 8. a workspace with all of this in it can still be deleted
  begin
    delete from public.orgs where id in (org, oth);
  exception when others then
    fails := fails || ('deleting a workspace failed: ' || sqlerrm);
  end;
  fails := fails || pg_temp.v('rows left behind by a deleted workspace', format('select (select count(*) from public.hr_announcement_reads where user_id = any(%2$L)) + (select count(*) from public.hr_goals where org_id = %1$L)'
    || ' + (select count(*) from public.hr_reviews where org_id = %1$L) + (select count(*) from public.hr_training_enrolments where org_id = %1$L) + (select count(*) from public.hr_announcements where org_id = %1$L)', org, array[own, adm, mfa, ma, mb, mv, late, outs]), '0');
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_PERFORMANCE_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
