-- Workspace logo and letterhead access check. Leaves nothing behind: the block
-- always ends with RAISE, so every row and helper below is rolled back.
--   PEOPLE_LETTERHEAD_CHECK PASSED ...   or   PEOPLE_LETTERHEAD_CHECK FAILED (n): <what went wrong>
-- Not in minutes :00 to :02 of an hour (it plants a letter in the demo), not
-- beside another people check. It reads no clock: every row it counts is one
-- it planted. t(who, what, q, want, claims) runs q as one signed-in person:
-- a statement gives ok, none (no row touched) or denied; a call gives
-- =<json> or the refusal. want '*' = it must go through, whatever it returns.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid; b uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mfa uuid := gen_random_uuid(); mb uuid := gen_random_uuid(); vw uuid := gen_random_uuid();
  outs uuid := gen_random_uuid(); dv uuid := gen_random_uuid(); da uuid := gen_random_uuid();
  ea uuid; e uuid; de uuid; ld uuid; li uuid; dl uuid; tf uuid; g uuid;
  f1 text; f2 text; f3 text; fo text; fd text; fx text; r record; c bigint; i int; ctx text; q text;
  u text := gen_random_uuid()::text;
  put text := 'insert into storage.objects (bucket_id, name) values (''org-logos'', %L)';
  keys text := '=["ack_requested", "acknowledged_at", "body", "employee_id", "id", "issued_on", "letter_type", "status", "title"]';
  fails text[] := '{}';
begin
  begin
  -- 0. the catalogue
  select count(*) into i from pg_proc p where p.oid in (to_regprocedure('public.set_org_logo(uuid,text)'), to_regprocedure('public.clear_org_logo(uuid)'),
      to_regprocedure('public.hr_request_letter_ack(uuid,boolean)'), to_regprocedure('public.hr_start_letter_from_template(uuid,uuid)'), to_regprocedure('public.hr_issue_letter(uuid)'))
    and p.prosecdef and p.proconfig @> array['search_path=public'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute');
  if i <> 5 then fails := fails || format('%s of 5 functions are definer functions on a fixed search path for signed-in users only', i); end if;
  select count(*) into i from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role', 'public']) x
  where n.nspname = 'private' and p.proname in ('hr_prune_released_documents', 'hr_backfill_ms_letter_templates', 'hr_starter_letter_templates', 'hr_seed_letter_templates', 'hr_letter_fill')
    and (x <> 'service_role' or p.proname = 'hr_prune_released_documents') and has_function_privilege(x, p.oid, 'execute');
  if i <> 0 or to_regprocedure('private.hr_prune_released_documents()') is null then fails := fails || format('%s grants on the private functions (0)', i); end if;
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
      exception when insufficient_privilege then got := 'denied'; when others then got := sqlerrm; end;
      reset role;
      if got = want or (want = '*' and left(got, 1) = '=') or (left(want, 1) = '=' and left(got, 1) = '=' and substr(got, 2)::jsonb = substr(want, 2)::jsonb) then return '{}'; end if;
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

  -- 1. the logo functions: who may call them
  fails := fails || pg_temp.t(own, 'the owner sets a logo', format('set_org_logo(%L,%L)', org, f1), format('={"logo_path":"%s","old_path":null}', f1));
  for r in select * from (values (mb, 'a member'), (vw, 'a viewer'), (outs, 'another workspace''s owner'), (null, 'nobody'), (mfa, 'an admin who owes a second factor')) x(who, lbl) loop
    fails := fails || pg_temp.t(r.who, r.lbl || ' sets the logo', format('set_org_logo(%L,%L)', org, f2), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' removes the logo', format('clear_org_logo(%L)', org), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' asks for a letter''s acknowledgement', format('hr_request_letter_ack(%L,true)', ld), case when r.who is null then 'LETTER_NOT_ALLOWED' else 'LETTER_NOT_FOUND' end)
      || pg_temp.t(r.who, r.lbl || ' issues a letter', format('hr_issue_letter(%L)', ld), case when r.who is null then 'LETTER_NOT_ALLOWED' else 'LETTER_NOT_FOUND' end)
      || pg_temp.t(r.who, r.lbl || ' starts a letter', format('hr_start_letter_from_template(%L,%L)', ea, tf), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' uploads a logo', format(put, org || '/' || gen_random_uuid() || '.png'), 'denied')
      || pg_temp.t(r.who, r.lbl || ' writes the column', format('update public.orgs set logo_path = null where id = %L', org), 'denied');
  end loop;
  for r in select * from (values (dv, 'a demo visitor'), (da, 'a demo admin')) x(who, lbl) loop
    fails := fails || pg_temp.t(r.who, r.lbl || ' sets the demo''s logo', format('set_org_logo(%L,%L)', demo, fd), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' removes the demo''s logo', format('clear_org_logo(%L)', demo), 'LOGO_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' asks for a demo letter''s acknowledgement', format('hr_request_letter_ack(%L,true)', dl), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' issues a demo letter', format('hr_issue_letter(%L)', dl), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' starts a demo letter', format('hr_start_letter_from_template(%L,%L)', de, tf), 'LETTER_NOT_ALLOWED')
      || pg_temp.t(r.who, r.lbl || ' uploads a logo to the demo', format(put, demo || '/' || gen_random_uuid() || '.png'), 'denied');
  end loop;
  fails := fails || pg_temp.t(own, 'a workspace that does not exist', format('set_org_logo(%L,%L)', gen_random_uuid(), f2), 'LOGO_NOT_ALLOWED')
    || pg_temp.t(own, 'no workspace', format('set_org_logo(null,%L)', f2), 'LOGO_NOT_ALLOWED') || pg_temp.t(own, 'no workspace to clear', 'clear_org_logo(null)', 'LOGO_NOT_ALLOWED')
    || pg_temp.t(own, 'another workspace''s logo', format('set_org_logo(%L,%L)', oth, fo), 'LOGO_NOT_ALLOWED')
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
    fails := fails || pg_temp.t(own, 'set with ' || r.lbl, format('set_org_logo(%L,%L)', org, r.path), 'LOGO_BAD_FILE');
  end loop;
  for r in select * from (values ('.png', 'application/pdf'), ('.png', 'image/jpeg'), ('.jpg', 'image/png'), ('.webp', 'image/svg+xml')) x(ext, mime) loop
    fx := org || '/' || gen_random_uuid() || r.ext;
    insert into storage.objects (bucket_id, name, metadata) values ('org-logos', fx, jsonb_build_object('mimetype', r.mime));
    fails := fails || pg_temp.t(adm, format('a %s file recorded as %s', r.ext, r.mime), format('set_org_logo(%L,%L)', org, fx), 'LOGO_BAD_FILE');
  end loop;
  select count(*) into c from public.activity_log a where a.org_id in (org, oth, demo) and a.action like '%workspace logo' and a.actor_id in (own, adm, mfa, mb, vw, outs, dv, da);
  if c <> 1 or (select logo_path from public.orgs where id = org) is distinct from f1 or exists (select 1 from public.orgs where id in (oth, demo) and logo_path is not null) then
    fails := fails || format('a refused call changed a logo or recorded an entry (%s entries, 1 expected)', c);
  end if;

  -- 3. replacing and removing: the old path is handed back each time, and each change is recorded once
  fails := fails || pg_temp.t(adm, 'the admin replaces it', format('set_org_logo(%L,%L)', org, f2), format('={"logo_path":"%s","old_path":"%s"}', f2, f1))
    || pg_temp.t(adm, 'the same path again hands back nothing to remove', format('set_org_logo(%L,%L)', org, f2), format('={"logo_path":"%s","old_path":null}', f2))
    || pg_temp.t(mfa, 'an admin who entered their second factor', format('set_org_logo(%L,%L)', org, f3), format('={"logo_path":"%s","old_path":"%s"}', f3, f2), '{"aal":"aal2"}')
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
  if c <> 10 then fails := fails || format('%s files of the one shape in the workspace''s folder, 10 expected (3 planted, 4 of a wrong type, 3 uploaded)', c); end if;

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

  -- 8. pruning the released paths: over 30 days and no file behind it
  insert into private.hr_released_documents (path, released_at) values (org || '/old-gone', now() - interval '31 days'), (org || '/old-kept', now() - interval '31 days'),
    (org || '/old-elsewhere', now() - interval '400 days'), (org || '/young', now() - interval '29 days'), (org || '/new', now());
  insert into storage.objects (bucket_id, name) values ('hr-documents', org || '/old-kept'), ('org-logos', org || '/old-elsewhere');
  i := private.hr_prune_released_documents();
  select string_agg(split_part(x.path, '/', 2), ',' order by x.path) into ctx from private.hr_released_documents x where left(x.path, 36) = org::text;
  if i < 2 or ctx is distinct from 'new,old-kept,young' then fails := fails || format('pruning removed %s and left %s of the five planted (new, old-kept and young expected)', i, ctx); end if;

  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_LETTERHEAD_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
