-- Workspace logo and letterhead access check. Leaves nothing behind: the block
-- always ends with RAISE, so every row and helper below is rolled back.
--   PEOPLE_LETTERHEAD_CHECK PASSED ...   or   PEOPLE_LETTERHEAD_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (it plants a letter in the demo), not
-- beside another people check. It reads no clock: every row it counts is one
-- it planted. t(who, what, q, want, claims) runs q as one signed-in person:
-- a statement gives ok, none (no row touched) or denied; a call gives
-- =<json> or the refusal (gone: no such function). want '*' = it must go
-- through, whatever it returns. s(what, q, want, claims) runs q as the app's
-- server does, as service_role: only it may set a logo or list stray files.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid; b uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mfa uuid := gen_random_uuid(); mb uuid := gen_random_uuid(); vw uuid := gen_random_uuid();
  outs uuid := gen_random_uuid(); dv uuid := gen_random_uuid(); da uuid := gen_random_uuid(); lw uuid := gen_random_uuid(); gone uuid := gen_random_uuid();
  ea uuid; e uuid; de uuid; ld uuid; li uuid; dl uuid; tf uuid; tm uuid; g uuid;
  f1 text; f2 text; f3 text; fo text; fd text; fx text; r record; c bigint; i int; ctx text; q text;
  oa text; ol text; oy text; og text; os text; planted text[];
  months text[] := array['Januari','Februari','Mac','April','Mei','Jun','Julai','Ogos','September','Oktober','November','Disember'];
  u text := gen_random_uuid()::text;
  put text := 'insert into storage.objects (bucket_id, name) values (''org-logos'', %L)';
  keys text := '=["ack_requested", "acknowledged_at", "body", "employee_id", "id", "issued_on", "letter_type", "status", "title"]';
  fails text[] := '{}';
begin
  begin
  -- 0. the catalogue
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.hr_save_letter_template(uuid,uuid,text,text,text,text,text)'), to_regprocedure('public.clear_org_logo(uuid)'),
      to_regprocedure('public.hr_request_letter_ack(uuid,boolean)'), to_regprocedure('public.hr_start_letter_from_template(uuid,uuid)'), to_regprocedure('public.hr_issue_letter(uuid)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 5 then fails := fails || format('%s of 5 functions are definer functions on a fixed search path for signed-in users only', i); end if;
  -- Setting a logo and finding the stray files are the server's: service_role and nobody else. The functions they replace are gone.
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.set_org_logo(uuid,uuid,text)'), to_regprocedure('public.org_orphaned_logo_files()'),
      to_regprocedure('public.org_logo_file_is_orphaned(text)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 3 then fails := fails || format('%s of 3 functions are definer functions on a fixed search path for service_role only', i); end if;
  select count(*) into i from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('set_org_logo', 'hr_save_letter_template', 'org_orphaned_logo_files', 'org_logo_file_is_orphaned', 'clear_org_logo');
  if i <> 5 or to_regprocedure('public.set_org_logo(uuid,text)') is not null or to_regprocedure('public.hr_save_letter_template(uuid,uuid,text,text,text,text)') is not null then
    fails := fails || format('%s functions under the five names (5, one each): the two-argument set_org_logo and the six-argument hr_save_letter_template should be gone', i);
  end if;
  if (select p.provolatile::text || p.proretset::text from pg_proc p where p.oid = to_regprocedure('public.org_orphaned_logo_files()')) is distinct from 'strue'
     or (select p.provolatile::text from pg_proc p where p.oid = to_regprocedure('public.org_logo_file_is_orphaned(text)')) is distinct from 's' then
    fails := fails || 'the two stray-file functions should be stable, the first a set'::text;
  end if;
  select count(*) into i from information_schema.columns k where k.table_schema = 'public' and k.table_name = 'hr_letter_templates' and k.column_name = 'lang'
    and k.data_type = 'text' and k.is_nullable = 'NO' and k.column_default = '''en''::text';
  select count(*) into c from pg_constraint k where k.conrelid = 'public.hr_letter_templates'::regclass and k.contype = 'c' and pg_get_constraintdef(k.oid) like '%lang%' and pg_get_constraintdef(k.oid) like '%''en''%''ms''%';
  if i <> 1 or c <> 1 then fails := fails || format('hr_letter_templates.lang is not a required text of en or ms that defaults to en (column %s, rule %s)', i, c); end if;
  select count(*) into i from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role', 'public']) x
  where n.nspname = 'private' and p.proname in ('hr_prune_released_documents', 'hr_backfill_ms_letter_templates', 'hr_starter_letter_templates', 'hr_seed_letter_templates', 'hr_letter_fill',
      'hr_ms_letter_templates_as_seeded', 'hr_mark_ms_letter_templates', 'hr_correct_ms_letter_templates', 'hr_letter_date')
    and (x <> 'service_role' or p.proname in ('hr_prune_released_documents', 'hr_mark_ms_letter_templates', 'hr_correct_ms_letter_templates')) and has_function_privilege(x, p.oid, 'execute');
  if i <> 0 or to_regprocedure('private.hr_prune_released_documents()') is null or to_regprocedure('private.hr_letter_date(date,text)') is null
     or to_regprocedure('private.hr_mark_ms_letter_templates()') is null or to_regprocedure('private.hr_correct_ms_letter_templates()') is null
     or to_regprocedure('private.hr_ms_letter_templates_as_seeded()') is null then
    fails := fails || format('%s grants on the private functions (0), or one of them is missing', i);
  end if;
  if has_column_privilege('authenticated', 'public.orgs', 'logo_path', 'UPDATE') or has_column_privilege('anon', 'public.orgs', 'logo_path', 'SELECT, UPDATE')
     or not has_column_privilege('authenticated', 'public.orgs', 'logo_path', 'SELECT') or not has_column_privilege('authenticated', 'public.orgs', 'name', 'UPDATE') then
    fails := fails || 'logo_path should be read by signed-in users and written by none, beside the company details they do write'::text;
  end if;
  select count(*) into i from storage.buckets k where k.id = 'org-logos' and k.public and k.file_size_limit = 1048576
    and k.allowed_mime_types @> array['image/png','image/jpeg','image/webp'] and cardinality(k.allowed_mime_types) = 3;
  select count(*), count(*) filter (where (p.policyname, p.cmd, p.permissive) in (('org_logos_insert', 'INSERT', 'PERMISSIVE'), ('org_logos_mfa_required', 'ALL', 'RESTRICTIVE'))
    and p.roles = array['authenticated']::name[]) into c, ctx from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects' and (p.policyname like 'org\_logo%' or p.qual like '%org-logos%' or p.with_check like '%org-logos%');
  if i <> 1 or c <> 2 or ctx <> '2' then fails := fails || format('the org-logos bucket (%s of 1) or its policies (%s, %s as expected, of 2) are not as expected', i, c, ctx); end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select count(*) from cron.job where jobname = 'prune-released-documents' and schedule = '40 18 * * *' and active and command = 'select private.hr_prune_released_documents()'$q$ into i;
    if i <> 1 then fails := fails || 'the daily pruning job is not scheduled'::text; end if;
  end if;
  -- The migration marked and corrected the templates that existed: none is left that is still a Bahasa Malaysia starter as first seeded
  -- (its name and its text) and marked English, or with the wording since corrected. Looked at before this check plants any.
  select count(*) filter (where t.lang <> 'ms'), count(*) filter (where not exists (select 1 from private.hr_starter_letter_templates() v where v.name = t.name and v.body = t.body)) into i, c
  from public.hr_letter_templates t join private.hr_ms_letter_templates_as_seeded() w on w.name = t.name and w.body_md5 = md5(t.body);
  if i <> 0 or c <> 0 then fails := fails || format('%s unedited Bahasa Malaysia starter(s) are marked English and %s keep the wording since corrected (0 and 0)', i, c); end if;
  if cardinality(fails) > 0 then raise exception 'the catalogue is not as expected, so nothing else was tried'; end if;

  execute $f$
    create function pg_temp.t(who uuid, label text, q text, want text, extra jsonb default '{}') returns text[] language plpgsql as $b$
    declare r jsonb; got text; n int;
    begin
      perform set_config('request.jwt.claims', (jsonb_strip_nulls(jsonb_build_object('sub', who, 'role', 'authenticated', 'aal', case when who is not null then 'aal1' end)) || extra)::text, true);
      set local role authenticated;
      begin
        if q ~ '^(insert|update|delete) ' then execute q; get diagnostics n = row_count; got := case when n > 0 then 'ok' else 'none' end;
        else execute 'select to_jsonb(' || q || ')' into r; got := '=' || coalesce(r::text, 'null'); end if;
      exception when insufficient_privilege then got := 'denied'; when undefined_function then got := 'gone'; when others then got := sqlerrm; end;
      reset role;
      -- "none" is "nothing was touched": real storage refuses a direct delete outright, which is the same thing.
      if got = want or (want = 'none' and got = 'denied') or (want = '*' and left(got, 1) = '=') or (left(want, 1) = '=' and left(got, 1) = '=' and substr(got, 2)::jsonb = substr(want, 2)::jsonb) then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
    end $b$
  $f$;
  -- As the app's server: the service key's claims and role. `extra` overrides a claim (a signed-in user's token under the service role's database role).
  execute $f$
    create function pg_temp.s(label text, q text, want text, extra jsonb default '{}') returns text[] language plpgsql as $b$
    declare r jsonb; got text;
    begin
      perform set_config('request.jwt.claims', jsonb_strip_nulls('{"role":"service_role"}'::jsonb || extra)::text, true);
      set local role service_role;
      begin
        execute 'select to_jsonb(' || q || ')' into r; got := '=' || coalesce(r::text, 'null');
      exception when insufficient_privilege then got := 'denied'; when undefined_function then got := 'gone'; when others then got := sqlerrm; end;
      reset role;
      if got = want or (left(want, 1) = '=' and left(got, 1) = '=' and substr(got, 2)::jsonb = substr(want, 2)::jsonb) then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
    end $b$
  $f$;

  -- people and workspaces. own: owner; adm: admin; mfa: an admin with a verified authenticator; mb: a member with an
  -- employee record; vw: a viewer; outs: owner of another workspace; dv, da: a visitor and an admin of the demo.
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x || '@letterhead-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mfa, mb, vw, outs, dv, da]) x;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now());
  insert into public.orgs (id, name) values (org, 'Letterhead Check Sdn Bhd'), (oth, 'Letterhead Other Sdn Bhd');
  insert into public.orgs (id, name) select x, 'Letterhead Backfill' from unnest(b) x;
  insert into public.org_members (org_id, user_id, role) values (org, own, 'owner'), (org, adm, 'admin'), (org, mfa, 'admin'), (org, mb, 'member'), (org, vw, 'viewer'),
    (oth, outs, 'owner'), (demo, dv, 'viewer'), (demo, da, 'admin');
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'A', 'Member A', mb) returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name) values (demo, 'LH-CHECK', 'Letterhead Check') returning id into de;
  insert into public.hr_letters (org_id, employee_id, letter_type, title, body) values (org, ea, 'offer', 'Draft', 'Body') returning id into ld;
  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, issued_on) values (org, ea, 'offer', 'Issued', 'Body', 'issued', '2026-01-05') returning id into li;
  insert into public.hr_letters (org_id, employee_id, letter_type, title, body) values (demo, de, 'offer', 'Demo draft', 'Body') returning id into dl;
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body) values (org, 'Pay', 'other', 'Pay', '{salary} for {employee_name} {Salary} { salary }') returning id into tf;
  -- Files as storage would hold them: three good ones, one in the other workspace's folder, one in the demo's.
  f1 := org || '/' || gen_random_uuid() || '.png'; f2 := org || '/' || gen_random_uuid() || '.jpg'; f3 := org || '/' || gen_random_uuid() || '.webp';
  fo := oth || '/' || gen_random_uuid() || '.png'; fd := demo || '/' || gen_random_uuid() || '.png';
  insert into storage.objects (bucket_id, name, metadata) values ('org-logos', f1, '{"mimetype":"image/png","size":10}'), ('org-logos', f2, null),
    ('org-logos', f3, '{"mimetype":"image/webp"}'), ('org-logos', fo, null), ('org-logos', fd, null);

  -- 1. the logo functions: who may call them. Setting is the server's alone, in the name of an owner or admin it names.
  fails := fails || pg_temp.t(own, 'the owner calls the old two-argument function', format('set_org_logo(%L,%L)', org, f1), 'gone')
    || pg_temp.t(own, 'the owner calls the new one themselves', format('set_org_logo(%L,%L,%L)', org, own, f1), 'denied')
    || pg_temp.t(adm, 'an admin calls it with a token that says service_role', format('set_org_logo(%L,%L,%L)', org, adm, f1), 'denied', '{"role":"service_role"}')
    || pg_temp.t(null, 'nobody calls it', format('set_org_logo(%L,%L,%L)', org, own, f1), 'denied')
    || pg_temp.s('the service role''s database role under a signed-in user''s token', format('set_org_logo(%L,%L,%L)', org, own, f1), 'LOGO_NOT_ALLOWED', jsonb_build_object('role', 'authenticated', 'sub', own))
    || pg_temp.s('the service role''s database role with no token', format('set_org_logo(%L,%L,%L)', org, own, f1), 'LOGO_NOT_ALLOWED', '{"role":null}')
    || pg_temp.t(own, 'the owner lists the stray files', '(select count(*) from org_orphaned_logo_files())', 'denied')
    || pg_temp.t(own, 'the owner asks about one file', format('org_logo_file_is_orphaned(%L)', f1), 'denied');
  if exists (select 1 from public.orgs where id = org and logo_path is not null) then fails := fails || 'a refused caller set the logo'::text; end if;
  fails := fails || pg_temp.s('the server sets a logo for the owner', format('set_org_logo(%L,%L,%L)', org, own, f1), format('={"logo_path":"%s","old_path":null}', f1));
  for r in select * from (values (mb, 'a member'), (vw, 'a viewer'), (outs, 'another workspace''s owner'), (null, 'nobody'), (gen_random_uuid(), 'somebody unknown')) x(who, lbl) loop
    fails := fails || pg_temp.s('the server sets the logo for ' || r.lbl, format('set_org_logo(%L,%L,%L)', org, r.who, f2), 'LOGO_NOT_ALLOWED');
  end loop;
  for r in select * from (values (mb, 'a member'), (vw, 'a viewer'), (outs, 'another workspace''s owner'), (null, 'nobody'), (mfa, 'an admin who owes a second factor')) x(who, lbl) loop
    fails := fails || pg_temp.t(r.who, r.lbl || ' removes the logo', format('clear_org_logo(%L)', org), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' asks for a letter''s acknowledgement', format('hr_request_letter_ack(%L,true)', ld), case when r.who is null then 'LETTER_NOT_ALLOWED' else 'LETTER_NOT_FOUND' end)
      || pg_temp.t(r.who, r.lbl || ' issues a letter', format('hr_issue_letter(%L)', ld), case when r.who is null then 'LETTER_NOT_ALLOWED' else 'LETTER_NOT_FOUND' end)
      || pg_temp.t(r.who, r.lbl || ' starts a letter', format('hr_start_letter_from_template(%L,%L)', ea, tf), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' uploads a logo', format(put, org || '/' || gen_random_uuid() || '.png'), 'denied')
      || pg_temp.t(r.who, r.lbl || ' writes the column', format('update public.orgs set logo_path = null where id = %L', org), 'denied');
  end loop;
  for r in select * from (values (dv, 'a demo visitor'), (da, 'a demo admin')) x(who, lbl) loop
    fails := fails || pg_temp.s('the server sets the demo''s logo for ' || r.lbl, format('set_org_logo(%L,%L,%L)', demo, r.who, fd), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' removes the demo''s logo', format('clear_org_logo(%L)', demo), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' asks for a demo letter''s acknowledgement', format('hr_request_letter_ack(%L,true)', dl), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' issues a demo letter', format('hr_issue_letter(%L)', dl), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' starts a demo letter', format('hr_start_letter_from_template(%L,%L)', de, tf), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' uploads a logo to the demo', format(put, demo || '/' || gen_random_uuid() || '.png'), 'denied');
  end loop;
  fails := fails || pg_temp.s('a workspace that does not exist', format('set_org_logo(%L,%L,%L)', gen_random_uuid(), own, f2), 'LOGO_NOT_ALLOWED')
    || pg_temp.s('no workspace', format('set_org_logo(null,%L,%L)', own, f2), 'LOGO_NOT_ALLOWED') || pg_temp.t(own, 'no workspace to clear', 'clear_org_logo(null)', 'LOGO_NOT_ALLOWED')
    || pg_temp.s('another workspace''s logo, for this one''s owner', format('set_org_logo(%L,%L,%L)', oth, own, fo), 'LOGO_NOT_ALLOWED')
    || pg_temp.t(mfa, 'an admin of one workspace clears another''s', format('clear_org_logo(%L)', oth), 'LOGO_NOT_ALLOWED', '{"aal":"aal2"}');

  -- 2. the path and the file. A crafted name is refused as an upload; then, with a file planted behind it (but for the last two), as a logo.
  for r in select * from (values ('no path', null), ('another workspace''s file', fo), ('a path with no file', org || '/' || gen_random_uuid() || '.png'),
    ('capitals', upper(org::text) || '/' || u || '.png'), ('a capital extension', org || '/' || u || '.PNG'), ('an extra segment', org || '/x/' || u || '.png'),
    ('a way up', org || '/../' || oth || '/' || u || '.png'), ('another extension', org || '/' || u || '.svg'), ('no extension', org || '/' || u),
    ('a name that is no uuid', org || '/logo.png'), ('a trailing line', org || '/' || u || E'.png\n'), ('a leading slash', '/' || org || '/' || u || '.png')) x(lbl, path) loop
    if r.lbl not in ('no path', 'another workspace''s file', 'a path with no file') then
      fails := fails || pg_temp.t(own, 'upload with ' || r.lbl, format(put, r.path), 'denied');
      if r.lbl not in ('a trailing line', 'a leading slash') then insert into storage.objects (bucket_id, name) values ('org-logos', r.path); end if;
    end if;
    fails := fails || pg_temp.s('set with ' || r.lbl, format('set_org_logo(%L,%L,%L)', org, own, r.path), 'LOGO_BAD_FILE');
  end loop;
  for r in select * from (values ('.png', 'application/pdf'), ('.png', 'image/jpeg'), ('.jpg', 'image/png'), ('.webp', 'image/svg+xml')) x(ext, mime) loop
    fx := org || '/' || gen_random_uuid() || r.ext;
    insert into storage.objects (bucket_id, name, metadata) values ('org-logos', fx, jsonb_build_object('mimetype', r.mime));
    fails := fails || pg_temp.s(format('a %s file recorded as %s', r.ext, r.mime), format('set_org_logo(%L,%L,%L)', org, adm, fx), 'LOGO_BAD_FILE');
  end loop;
  -- A file is set within the hour of its upload or not at all (the sweep lists it after a day), unless it already is the logo.
  for r in select * from (values ('two hours', now() - interval '2 hours'), ('two days', now() - interval '2 days'), ('no time', null)) x(lbl, made) loop
    fx := org || '/' || gen_random_uuid() || '.png';
    insert into storage.objects (bucket_id, name, created_at) values ('org-logos', fx, r.made);
    fails := fails || pg_temp.s('a file uploaded ' || r.lbl || ' ago', format('set_org_logo(%L,%L,%L)', org, adm, fx), 'LOGO_BAD_FILE');
  end loop;
  fx := org || '/' || gen_random_uuid() || '.png';
  insert into storage.objects (bucket_id, name) values ('hr-documents', fx);
  fails := fails || pg_temp.s('a file of that name in another bucket', format('set_org_logo(%L,%L,%L)', org, adm, fx), 'LOGO_BAD_FILE');
  update storage.objects set created_at = now() - interval '59 minutes' where bucket_id = 'org-logos' and name = f2;
  update storage.objects set created_at = now() - interval '3 days' where bucket_id = 'org-logos' and name = f1;
  fails := fails || pg_temp.s('the logo it already is, however old its file', format('set_org_logo(%L,%L,%L)', org, own, f1), format('={"logo_path":"%s","old_path":null}', f1));
  select count(*) into c from public.activity_log a where a.org_id in (org, oth, demo) and a.action like '%workspace logo' and a.actor_id in (own, adm, mfa, mb, vw, outs, dv, da);
  if c <> 1 or (select logo_path from public.orgs where id = org) is distinct from f1 or exists (select 1 from public.orgs where id in (oth, demo) and logo_path is not null) then
    fails := fails || format('a refused call changed a logo or recorded an entry (%s entries, 1 expected)', c);
  end if;

  -- 3. replacing and removing: the old path is handed back each time, and each change is recorded once
  fails := fails || pg_temp.s('the server replaces it for the admin, with a file 59 minutes old', format('set_org_logo(%L,%L,%L)', org, adm, f2), format('={"logo_path":"%s","old_path":"%s"}', f2, f1))
    || pg_temp.s('the same path again hands back nothing to remove', format('set_org_logo(%L,%L,%L)', org, adm, f2), format('={"logo_path":"%s","old_path":null}', f2))
    || pg_temp.s('for another admin', format('set_org_logo(%L,%L,%L)', org, mfa, f3), format('={"logo_path":"%s","old_path":"%s"}', f3, f2))
    || pg_temp.t(mb, 'a member reads the logo', format('(select logo_path from orgs where id = %L)', org), format('="%s"', f3))
    || pg_temp.t(outs, 'an outsider reads no workspace of theirs', format('(select count(*) from orgs where id = %L)', org), '=0')
    || pg_temp.t(own, 'the owner still saves the company details', format('update public.orgs set city = ''Ipoh'' where id = %L', org), 'ok')
    || pg_temp.t(own, 'the owner writes the column', format('update public.orgs set logo_path = %L where id = %L', f1, org), 'denied')
    || pg_temp.t(own, 'the owner removes it', format('clear_org_logo(%L)', org), format('={"old_path":"%s"}', f3))
    || pg_temp.t(adm, 'removed again', format('clear_org_logo(%L)', org), '={"old_path":null}');
  select string_agg(a.action || '/' || a.category || '/' || a.audience || '/' || a.target || '/' || a.actor_name, ', ' order by a.action, a.actor_name) into ctx
  from public.activity_log a where a.org_id = org and a.actor_id in (own, adm, mfa) and a.action like '%workspace logo';
  q := format('Removed the workspace logo/data/members/Letterhead Check Sdn Bhd/%1$s, Updated the workspace logo/data/members/Letterhead Check Sdn Bhd/%2$s,'
    || ' Updated the workspace logo/data/members/Letterhead Check Sdn Bhd/%3$s, Updated the workspace logo/data/members/Letterhead Check Sdn Bhd/%1$s',
    private.display_name(own), private.display_name(adm), private.display_name(mfa));
  if ctx is distinct from (select string_agg(x, ', ' order by x) from unnest(string_to_array(q, ', ')) x) then fails := fails || format('the activity entries: %s', ctx); end if;

  -- 4. the bucket: an owner or admin uploads into their own folder and nowhere else; nobody lists, changes or removes
  update public.orgs set logo_path = org || '/' || u || '.jpg' where id = org;
  fails := fails || pg_temp.t(own, 'the owner uploads', format(put, org || '/' || gen_random_uuid() || '.png'), 'ok')
    || pg_temp.t(adm, 'the admin uploads', format(put, org || '/' || gen_random_uuid() || '.webp'), 'ok')
    || pg_temp.t(mfa, 'an admin who entered their second factor uploads', format(put, org || '/' || gen_random_uuid() || '.jpg'), 'ok', '{"aal":"aal2"}')
    || pg_temp.t(own, 'the owner uploads to another workspace', format(put, oth || '/' || gen_random_uuid() || '.png'), 'denied')
    || pg_temp.t(own, 'an account still anonymous uploads', format(put, org || '/' || gen_random_uuid() || '.png'), 'denied', '{"is_anonymous":true}')
    || pg_temp.t(own, 'an upload at the path that is the logo, its file gone', format(put, org || '/' || u || '.jpg'), 'denied')
    || pg_temp.t(own, 'the same name in another bucket', format('insert into storage.objects (bucket_id, name) values (''hr-documents'', %L)', org || '/' || gen_random_uuid() || '.png'), 'denied');
  for r in select * from (values (own, 'the owner'), (mb, 'a member'), (outs, 'an outsider')) x(who, lbl) loop
    fails := fails || pg_temp.t(r.who, r.lbl || ' lists the bucket', '(select count(*) from storage.objects where bucket_id = ''org-logos'')', '=0')
      || pg_temp.t(r.who, r.lbl || ' changes a file', 'update storage.objects set metadata = ''{}'' where bucket_id = ''org-logos''', 'none')
      || pg_temp.t(r.who, r.lbl || ' renames a file', format('update storage.objects set name = %L where name = %L', org || '/' || gen_random_uuid() || '.png', f1), 'none')
      || pg_temp.t(r.who, r.lbl || ' removes a file', 'delete from storage.objects where bucket_id = ''org-logos''', 'none');
  end loop;
  select count(*) into c from storage.objects o where o.bucket_id = 'org-logos' and left(o.name, 36) = org::text and o.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$';
  if c <> 13 then fails := fails || format('%s files of the one shape in the workspace''s folder, 13 expected (3 planted, 4 of a wrong type, 3 of the wrong age, 3 uploaded)', c); end if;

  -- 5. {salary}: filled from the basic salary of the same workspace, left in place when there is none, and no letter issued with it
  for r in select * from (values (450000, 'RM 4,500.00 per month'), (5, 'RM 0.05 per month'), (100, 'RM 1.00 per month'), (123456789, 'RM 1,234,567.89 per month'),
    (9223372036854775807, 'RM 92,233,720,368,547,758.07 per month'), (0, null), (null, null), (-1, null)) x(cents, said) loop
    insert into public.hr_employees (org_id, employee_no, name) values (org, 'S' || coalesce(r.cents::text, 'none'), 'S') returning id into e;
    -- none: no private row at all; -1: a private row with no salary on it.
    if r.cents is not null then insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (e, org, nullif(r.cents, -1)); end if;
    fails := fails || pg_temp.t(adm, format('a letter started for a salary of %s', coalesce(r.cents::text, 'none')),
      format('(select jsonb_build_array(s #>> ''{letter,body}'', s -> ''unfilled'') from hr_start_letter_from_template(%L,%L) s)', e, tf),
      format('=["%s for S {Salary} { salary }", %s]', coalesce(r.said, '{salary}'), case when r.said is null then '["salary"]' else '[]' end));
    select l.id into g from public.hr_letters l where l.employee_id = e;
    fails := fails || pg_temp.t(own, format('issued for a salary of %s', coalesce(r.cents::text, 'none')), format('hr_issue_letter(%L) ->> ''status''', g), case when r.said is null then 'LETTER_PLACEHOLDER' else '="issued"' end);
  end loop;
  fails := fails || pg_temp.t(adm, 'the placeholder moved to the title', format('hr_save_letter(%L,%L,''other'',''Pay {salary}'',''Body'',null)', e, g), '*')
    || pg_temp.t(adm, 'issued with it in the title', format('hr_issue_letter(%L)', g), 'LETTER_PLACEHOLDER')
    || pg_temp.t(adm, 'the placeholder typed over', format('hr_save_letter(%L,%L,''other'',''Pay'',''{Salary} {salary {employee} RM 1 per month'',null)', e, g), '*')
    || pg_temp.t(adm, 'issued without it', format('hr_issue_letter(%L) ->> ''status''', g), '="issued"');

  -- 5b. a template's language: its dates and its salary are written in it; an English template is filled as it always was
  select count(*) into i from generate_series(1, 12) m where private.hr_letter_date(make_date(2026, m, 5), 'ms') is distinct from '5 ' || months[m] || ' 2026'
    or private.hr_letter_date(make_date(2026, m, 5), 'en') is distinct from to_char(make_date(2026, m, 5), 'FMDD FMMonth YYYY');
  if i <> 0 or private.hr_letter_date(null, 'ms') is not null or private.hr_letter_date(null, 'en') is not null
     or private.hr_letter_date('2026-10-12', null) <> '12 October 2026' or private.hr_letter_date('2026-10-12', 'MS') <> '12 October 2026'
     or private.hr_letter_date('2026-10-12', 'ms') <> '12 Oktober 2026' or private.hr_letter_date('2025-03-03', 'ms') <> '3 Mac 2025' or private.hr_letter_date('2024-08-31', 'ms') <> '31 Ogos 2024' then
    fails := fails || format('dates are not written as expected (%s of 24 months wrong)', i);
  end if;
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body, lang) values (org, 'Gaji', 'other', 'Mula {join_date}', '{join_date} / {salary} / {today}', 'ms') returning id into tm;
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body) values (org, 'Gaji in English', 'other', 'Mula {join_date}', '{join_date} / {salary} / {today}') returning id into g;
  q := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'FMDD FMMonth YYYY');
  ctx := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'FMDD') || ' ' || months[extract(month from (now() at time zone 'Asia/Kuala_Lumpur')::date)::int] || ' ' || to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY');
  for r in select * from (values (date '2025-03-03', 400000, '3 Mac 2025', 'RM 4,000.00 sebulan', '3 March 2025', 'RM 4,000.00 per month'),
    (date '2024-08-31', 123456789, '31 Ogos 2024', 'RM 1,234,567.89 sebulan', '31 August 2024', 'RM 1,234,567.89 per month'),
    (null, 0, '{join_date}', '{salary}', '{join_date}', '{salary}')) x(joined, cents, ms_date, ms_pay, en_date, en_pay) loop
    insert into public.hr_employees (org_id, employee_no, name, join_date) values (org, 'L' || r.cents, 'L', r.joined) returning id into e;
    insert into public.hr_employee_private (employee_id, org_id, base_salary_cents) values (e, org, r.cents);
    fails := fails || pg_temp.t(adm, format('a Bahasa Malaysia template for someone who joined on %s', coalesce(r.joined::text, 'no date')),
        format('(select jsonb_build_array(s #>> ''{letter,title}'', s #>> ''{letter,body}'', s -> ''unfilled'') from hr_start_letter_from_template(%L,%L) s)', e, tm),
        format('=["Mula %s", "%s / %s / %s", %s]', r.ms_date, r.ms_date, r.ms_pay, ctx, case when r.joined is null then '["join_date","salary"]' else '[]' end))
      || pg_temp.t(adm, format('an English template for someone who joined on %s', coalesce(r.joined::text, 'no date')),
        format('(select jsonb_build_array(s #>> ''{letter,title}'', s #>> ''{letter,body}'', s -> ''unfilled'') from hr_start_letter_from_template(%L,%L) s)', e, g),
        format('=["Mula %s", "%s / %s / %s", %s]', r.en_date, r.en_date, r.en_pay, q, case when r.joined is null then '["join_date","salary"]' else '[]' end));
  end loop;
  if exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = 'hr_letters' and k.column_name = 'lang') then fails := fails || 'a letter should keep no language of its own'::text; end if;

  -- 6. asking for an acknowledgement: a draft only, and nothing else of it changes
  fails := fails || pg_temp.t(own, 'the owner asks', format('hr_request_letter_ack(%L,true) - ''id''', ld), format('={"employee_id":"%s","letter_type":"offer","title":"Draft","body":"Body","status":"draft","issued_on":null,"ack_requested":true,"acknowledged_at":null}', ea))
    || pg_temp.t(adm, 'the admin stops asking', format('hr_request_letter_ack(%L,false) -> ''ack_requested''', ld), '=false')
    || pg_temp.t(adm, 'the letter as hr_save_letter hands it back', format('(select jsonb_agg(k order by k) from jsonb_object_keys(hr_request_letter_ack(%L,true)) k)', ld), keys)
    || pg_temp.t(adm, 'the same from hr_save_letter', format('(select jsonb_agg(k order by k) from jsonb_object_keys(hr_save_letter(%L,%L,''offer'',''Draft'',''Body'',true)) k)', ea, ld), keys)
    || pg_temp.t(adm, 'nothing said', format('hr_request_letter_ack(%L,null)', ld), 'LETTER_BAD_INPUT')
    || pg_temp.t(adm, 'an issued letter', format('hr_request_letter_ack(%L,true)', li), 'LETTER_NOT_DRAFT')
    || pg_temp.t(mb, 'its employee, once issued', format('hr_request_letter_ack(%L,true)', li), 'LETTER_NOT_FOUND')
    || pg_temp.t(adm, 'no letter', 'hr_request_letter_ack(null,true)', 'LETTER_NOT_FOUND')
    || pg_temp.t(outs, 'a letter that is nothing', format('hr_request_letter_ack(%L,true)', gen_random_uuid()), 'LETTER_NOT_FOUND');
  select count(*) filter (where l.ack_requested) || '/' || count(*) filter (where l.title in ('Draft', 'Issued', 'Demo draft') and l.body = 'Body') into ctx from public.hr_letters l where l.id in (ld, li, dl);
  if ctx is distinct from '1/3' then fails := fails || format('the three planted letters: %s asked for or unchanged, 1/3 expected', ctx); end if;

  -- 7. the starter set and the backfill. b1: the six English only; b2: at 48; b3: none; b4: at 46, one of them under a name of the six in other capitals.
  select count(*) || '/' || count(distinct letter_type) || '/' || count(*) filter (where body like '%{salary}%' and letter_type in ('offer', 'confirmation') and name like 'Surat %')
    || '/' || count(*) filter (where name in ('Surat Tawaran Pekerjaan', 'Surat Pengesahan Jawatan', 'Surat Kenaikan Pangkat', 'Surat Amaran', 'Surat Pembaharuan Kontrak', 'Surat Pengesahan Majikan'))
    || '/' || count(*) filter (where body ~ '\{salary\}') into ctx from public.hr_letter_templates where org_id = oth;
  if ctx is distinct from '12/6/2/6/2' then fails := fails || format('a new workspace was given %s (templates/types/Bahasa Malaysia with a salary/Bahasa Malaysia names/with a salary), 12/6/2/6/2 expected', ctx); end if;
  select count(*) filter (where lang = 'ms' and name like 'Surat %') || '/' || count(*) filter (where lang = 'en' and name not like 'Surat %') || '/' || count(*) filter (where body like '%di Jabatan {department}%' and lang = 'ms')
    || '/' || count(*) filter (where body like '%di jabatan {department}%') || '/' || count(*) filter (where body like '%{department}%' and lang = 'ms') into ctx from public.hr_letter_templates where org_id = oth;
  if ctx is distinct from '6/6/5/0/5' then fails := fails || format('a new workspace''s templates: %s (Bahasa Malaysia/English by language, "di Jabatan", "di jabatan", Bahasa Malaysia with a department), 6/6/5/0/5 expected', ctx); end if;
  perform private.hr_seed_letter_templates(oth);
  delete from public.hr_letter_templates where org_id = any (b) and (name like 'Surat %' or org_id = b[3]);
  insert into public.hr_letter_templates (org_id, name, letter_type, title) select x, 'Planted ' || s, 'other', 'T' from generate_series(1, 42) s, unnest(b[2:2] || b[4]) x where x = b[2] or s <= 40;
  update public.hr_letter_templates set name = 'SURAT amaran' where org_id = b[4] and name = 'Warning';
  select string_agg(private.hr_backfill_ms_letter_templates(x)::text, '/' order by n) into ctx from unnest(b) with ordinality as w(x, n);
  select ctx || ' ' || string_agg(private.hr_backfill_ms_letter_templates(x)::text, '/' order by n) into ctx from unnest(b) with ordinality as w(x, n);
  select ctx || ' ' || string_agg(s.c, '/' order by s.n) into ctx from (select w.n, count(t.id) || ':' || count(*) filter (where t.name like 'Surat %') || ':' || count(*) filter (where lower(t.name) = 'surat amaran') as c
    from unnest(b) with ordinality as w(x, n) left join public.hr_letter_templates t on t.org_id = w.x group by w.n) s;
  select ctx || ' ' || coalesce(string_agg(right(t.name, 7), ',' order by t.org_id = b[4], t.name), 'none') into ctx from public.hr_letter_templates t where t.org_id in (b[2], b[4]) and t.name like 'Surat %';
  if ctx is distinct from '6/2/0/4 0/0/0/0 12:6:1/50:2:0/0:0:0/50:4:1 Jawatan,kerjaan,Pangkat,Kontrak,Jawatan,kerjaan' or (select count(*) from public.hr_letter_templates where org_id = oth) <> 12 then
    fails := fails || format('the backfill (added, added again, templates:Bahasa Malaysia:named Surat Amaran per workspace, the names the two full ones took): %s', ctx);
  end if;
  if exists (select 1 from public.hr_letter_templates t where t.org_id = any (b) and t.name like 'Surat %' and t.lang <> 'ms') then fails := fails || 'the backfill added a Bahasa Malaysia template marked English'::text; end if;

  -- 8. pruning the released paths: over 30 days and no file behind it
  insert into private.hr_released_documents (path, released_at) values (org || '/old-gone', now() - interval '31 days'), (org || '/old-kept', now() - interval '31 days'),
    (org || '/old-elsewhere', now() - interval '400 days'), (org || '/young', now() - interval '29 days'), (org || '/new', now());
  insert into storage.objects (bucket_id, name) values ('hr-documents', org || '/old-kept'), ('org-logos', org || '/old-elsewhere');
  i := private.hr_prune_released_documents();
  select string_agg(split_part(x.path, '/', 2), ',' order by x.path) into ctx from private.hr_released_documents x where left(x.path, 36) = org::text;
  if i < 2 or ctx is distinct from 'new,old-kept,young' then fails := fails || format('pruning removed %s and left %s of the five planted (new, old-kept and young expected)', i, ctx); end if;

  -- 9. the stray logo files: in the bucket, no workspace's logo, over a day old. Listed oldest first; each asked about again by name.
  -- oa: never set, two days; ol: the other workspace's logo, five days; oy: never set, 23 hours; og: a workspace that is gone, three days;
  -- os: a name of no shape, four days; and a file as old in another bucket.
  oa := org || '/' || gen_random_uuid() || '.png'; ol := oth || '/' || gen_random_uuid() || '.png'; oy := org || '/' || gen_random_uuid() || '.webp';
  og := gone || '/' || gen_random_uuid() || '.jpg'; os := 'stray-' || u || '.txt';
  insert into storage.objects (bucket_id, name, created_at) values ('org-logos', oa, now() - interval '2 days'), ('org-logos', ol, now() - interval '5 days'),
    ('org-logos', oy, now() - interval '23 hours'), ('org-logos', og, now() - interval '3 days'), ('org-logos', os, now() - interval '4 days'),
    ('hr-documents', 'old-' || u, now() - interval '9 days');
  update public.orgs set logo_path = ol where id = oth;
  planted := array[oa, ol, oy, og, os, 'old-' || u];
  select string_agg(f.x, ',' order by f.n) into ctx from public.org_orphaned_logo_files() with ordinality as f(x, n) where f.x = any (planted);
  if ctx is distinct from os || ',' || og || ',' || oa then fails := fails || format('the stray files listed: %s', replace(replace(replace(replace(replace(coalesce(ctx, 'none'), oa, 'oa'), ol, 'ol'), oy, 'oy'), og, 'og'), os, 'os')); end if;
  fails := fails || pg_temp.s('the server lists the stray files', format('(select count(*) from org_orphaned_logo_files() f where f = any (%L::text[]))', planted), '=3')
    || pg_temp.s('a file never set, two days old', format('org_logo_file_is_orphaned(%L)', oa), '=true')
    || pg_temp.s('a deleted workspace''s file', format('org_logo_file_is_orphaned(%L)', og), '=true')
    || pg_temp.s('a name of no shape', format('org_logo_file_is_orphaned(%L)', os), '=true')
    || pg_temp.s('a workspace''s logo, however old', format('org_logo_file_is_orphaned(%L)', ol), '=false')
    || pg_temp.s('a file 23 hours old', format('org_logo_file_is_orphaned(%L)', oy), '=false')
    || pg_temp.s('a file of another bucket', format('org_logo_file_is_orphaned(%L)', 'old-' || u), '=false')
    || pg_temp.s('a name with no file', format('org_logo_file_is_orphaned(%L)', org || '/' || gen_random_uuid() || '.png'), '=false')
    || pg_temp.s('no name', 'org_logo_file_is_orphaned(null)', '=false')
    || pg_temp.s('a listed file can no longer be set', format('set_org_logo(%L,%L,%L)', org, own, oa), 'LOGO_BAD_FILE');
  -- A logo that was removed, its file still there: stray from then on.
  update public.orgs set logo_path = null where id = oth;
  fails := fails || pg_temp.s('a removed logo whose file stayed', format('org_logo_file_is_orphaned(%L)', ol), '=true');
  if (select count(*) from storage.objects o where o.bucket_id in ('org-logos', 'hr-documents') and o.name = any (planted)) <> 6 then fails := fails || 'listing the stray files removed one'::text; end if;

  -- 10. the templates that existed: marked Bahasa Malaysia by name or by text, and the wording corrected only in an unedited copy.
  -- lw is put back as the earlier file left a workspace: every template English, the six with "di jabatan". Then:
  -- Tawaran untouched; Jawatan edited; Kenaikan renamed; Kontrak renamed and edited; Majikan in other capitals; Amaran edited and in other
  -- capitals; and one of the owner's own with the new text.
  insert into public.orgs (id, name) values (lw, 'Letterhead Language Sdn Bhd');
  update public.hr_letter_templates set lang = 'en', body = replace(body, 'di Jabatan {department}', 'di jabatan {department}') where org_id = lw;
  select count(*) into i from public.hr_letter_templates t join private.hr_ms_letter_templates_as_seeded() w on w.name = t.name and w.body_md5 = md5(t.body) where t.org_id = lw;
  if i <> 6 then fails := fails || format('%s of the 6 Bahasa Malaysia bodies as they were seeded are known by their md5', i); end if;
  update public.hr_letter_templates set body = body || ' Edited.' where org_id = lw and name = 'Surat Pengesahan Jawatan';
  update public.hr_letter_templates set name = 'Naik Pangkat' where org_id = lw and name = 'Surat Kenaikan Pangkat';
  update public.hr_letter_templates set name = 'Kontrak Baharu', body = body || ' Edited.' where org_id = lw and name = 'Surat Pembaharuan Kontrak';
  update public.hr_letter_templates set name = 'SURAT PENGESAHAN MAJIKAN' where org_id = lw and name = 'Surat Pengesahan Majikan';
  update public.hr_letter_templates set name = 'surat AMARAN', body = body || ' Edited.' where org_id = lw and name = 'Surat Amaran';
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body) select lw, 'Mine', 'offer', 'T', v.body from private.hr_starter_letter_templates() v where v.name = 'Surat Tawaran Pekerjaan';
  i := private.hr_mark_ms_letter_templates();
  ctx := (i >= 6)::text || '/' || private.hr_mark_ms_letter_templates();
  i := private.hr_correct_ms_letter_templates();
  ctx := ctx || '/' || (i >= 1)::text || '/' || private.hr_correct_ms_letter_templates();
  select ctx || ' ' || string_agg(t.name || ':' || t.lang || ':' || (t.body like '%di Jabatan {department}%')::int || (t.body like '%di jabatan {department}%')::int || (t.body like '% Edited.')::int, ', ' order by t.name collate "C")
    || ' ' || (select count(*) from public.hr_letter_templates x where x.org_id = lw and x.lang = 'en' and x.name in ('Offer of employment', 'Confirmation of employment', 'Promotion', 'Warning', 'Contract renewal', 'General letter'))
    || ' ' || (select count(*) from public.hr_letter_templates x join private.hr_starter_letter_templates() v on v.name = x.name and v.body = x.body where x.org_id = lw)
    into ctx from public.hr_letter_templates t where t.org_id = lw and t.name not in ('Offer of employment', 'Confirmation of employment', 'Promotion', 'Warning', 'Contract renewal', 'General letter');
  if ctx is distinct from 'true/0/true/0 Kontrak Baharu:en:011, Mine:ms:100, Naik Pangkat:ms:010, SURAT PENGESAHAN MAJIKAN:ms:010, Surat Pengesahan Jawatan:ms:011, Surat Tawaran Pekerjaan:ms:100, surat AMARAN:ms:001 6 7' then
    fails := fails || format('marking and correcting the templates that existed (marked 6 or more/again/corrected 1 or more/again, name:language:Jabatan-jabatan-edited, English left, as the starters): %s', ctx);
  end if;

  -- 11. saving a template: the language is the last argument; not said, a new template is English and a changed one keeps its own
  fails := fails || pg_temp.t(adm, 'a new template, no language said', format('hr_save_letter_template(%L,null,''L1'',''other'',''T'',''B'') -> ''lang''', org), '="en"')
    || pg_temp.t(adm, 'a new template in Bahasa Malaysia', format('hr_save_letter_template(%L,null,''L2'',''other'',''T'',''B'',''ms'') - ''id''', org), '={"name":"L2","letter_type":"other","title":"T","body":"B","lang":"ms"}')
    || pg_temp.t(adm, 'a new template as the app before this slice names its six arguments',
      format('hr_save_letter_template(p_org => %L, p_template => null, p_name => ''L3'', p_letter_type => ''offer'', p_title => ''T'', p_body => ''B'') - ''id''', org), '={"name":"L3","letter_type":"offer","title":"T","body":"B","lang":"en"}');
  select t.id into g from public.hr_letter_templates t where t.org_id = org and t.name = 'L2';
  fails := fails || pg_temp.t(adm, 'changed with no language said, it keeps its own', format('hr_save_letter_template(%L,%L,''L2'',''offer'',''T2'',''B2'') -> ''lang''', org, g), '="ms"')
    || pg_temp.t(own, 'changed as the app before this slice names its six arguments',
      format('hr_save_letter_template(p_org => %L, p_template => %L, p_name => ''L2'', p_letter_type => ''offer'', p_title => ''T3'', p_body => ''B3'')', org, g), format('={"id":"%s","name":"L2","letter_type":"offer","title":"T3","body":"B3","lang":"ms"}', g))
    || pg_temp.t(adm, 'changed to English', format('hr_save_letter_template(%L,%L,''L2'',''offer'',''T3'',''B3'',''en'') -> ''lang''', org, g), '="en"')
    || pg_temp.t(adm, 'and back, by the name of the argument', format('hr_save_letter_template(%L,%L,''L2'',''offer'',''T3'',''B3'', p_lang => ''ms'') -> ''lang''', org, g), '="ms"');
  for r in select * from (values ('fr'), (''), ('MS'), ('en ')) x(said) loop
    fails := fails || pg_temp.t(adm, format('a new template in "%s"', r.said), format('hr_save_letter_template(%L,null,''L9'',''other'',''T'',''B'',%L)', org, r.said), 'LETTER_BAD_INPUT')
      || pg_temp.t(adm, format('a template changed to "%s"', r.said), format('hr_save_letter_template(%L,%L,''L2'',''offer'',''T3'',''B3'',%L)', org, g, r.said), 'LETTER_BAD_INPUT');
  end loop;
  fails := fails || pg_temp.t(mb, 'a member saves a template in Bahasa Malaysia', format('hr_save_letter_template(%L,null,''L8'',''other'',''T'',''B'',''ms'')', org), 'LETTER_NOT_ALLOWED')
    || pg_temp.t(adm, 'the old six-argument function by its own types', format('hr_save_letter_template(%L::uuid,null::uuid,''L7''::text,''other''::text,''T''::text,''B''::text) -> ''lang''', org), '="en"');
  select string_agg(t.name || ':' || t.lang || ':' || t.title, ',' order by t.name) into ctx from public.hr_letter_templates t where t.org_id = org and t.name ~ '^L[0-9]$';
  if ctx is distinct from 'L1:en:T,L2:ms:T3,L3:en:T,L7:en:T' then fails := fails || format('the templates saved: %s', ctx); end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_LETTERHEAD_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
