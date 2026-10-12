-- Lekiu letters and documents access check. Leaves nothing behind: the block
-- always ends with RAISE, so every row below is rolled back, and so are the
-- helper functions it makes in the session's temporary schema.
--   PEOPLE_DOCUMENTS_CHECK PASSED ...   or   PEOPLE_DOCUMENTS_CHECK FAILED (n): <what went wrong>
-- When not to run it: as people_rls_check.sql says (it rebuilds the demo HR
-- rows too): not in minutes :00 to :02 of an hour, not beside another people
-- check, not while a migration is being applied. It gives the same answer at
-- any minute of any day: the one date the functions read is today's in
-- Malaysia (d), and every row it counts is one it planted or the demo's.
-- x(who, what, call, want) runs a call as one person: want null = it must go
-- through, '=<json>' = it must return that, else the refusal expected.
-- d(who, what, statement, want) runs a statement: ok, denied, or none (no row touched).
-- v(what, query, want) reads one value as the database owner. up() plants a file
-- (with what storage records of it, when given); p() makes a path with no file.
do $$
declare
  org uuid := gen_random_uuid(); oth uuid := gen_random_uuid(); demo uuid;
  own uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mfa uuid := gen_random_uuid(); ma uuid := gen_random_uuid();
  mb uuid := gen_random_uuid(); mv uuid := gen_random_uuid(); outs uuid := gen_random_uuid(); dv uuid := gen_random_uuid(); da uuid := gen_random_uuid();
  ea uuid; eb uuid; ec uuid; ed uuid; eo uuid; ex uuid; ep uuid; de uuid := md5('rimba-emp-1')::uuid; run uuid := gen_random_uuid();
  dh uuid; dm uuid; da_ uuid; dd uuid; ld uuid; li uuid; la uuid; dl uuid; di uuid; tp uuid; tt uuid; tf uuid; dt uuid; g uuid;
  f1 text; f2 text; f3 text; f4 text; f5 text; fo text; fa text; fb text; fp text;
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  pdf text := ',''a.pdf'',10,''application/pdf'')';
  ins text := 'insert into storage.objects (bucket_id, name, owner) values (''hr-documents'', %L, %L)';
  docj text := '{"employee_id":"%s","title":"%s","doc_type":"%s","expires_on":%s,"file_name":"%s","file_size":%s,"file_type":"%s","source":"hr","ack_requested":%s,"acknowledged_at":null}';
  letj text := '{"employee_id":"%s","letter_type":"%s","title":"%s","body":"%s","status":"%s","issued_on":%s,"ack_requested":%s,"acknowledged_at":null}';
  who uuid; lbl text; q text; want text; snap text; t text; i int; j int; ctx text; fname text; sz text;
  fails text[] := '{}';
  tabs text[] := array['hr_documents','hr_letters','hr_letter_templates'];
  fns text[] := array['hr_add_document(uuid,text,text,date,text,text,bigint,text)','hr_update_document(uuid,text,text,date)',
    'hr_replace_document_file(uuid,text,text,bigint,text)','hr_remove_document(uuid)','hr_release_document_file(text)',
    'hr_request_document_ack(uuid,boolean)','hr_acknowledge_document(uuid)','hr_delete_employee(uuid,uuid)',
    'hr_save_letter(uuid,uuid,text,text,text,boolean)','hr_start_letter_from_template(uuid,uuid)','hr_issue_letter(uuid)',
    'hr_unissue_letter(uuid)','hr_delete_letter(uuid)','hr_acknowledge_letter(uuid)',
    'hr_save_letter_template(uuid,uuid,text,text,text,text)','hr_delete_letter_template(uuid)'];
begin
  begin
  -- the catalogue: functions, grants, policies, the bucket, the service role
  foreach t in array fns loop
    select count(*) into i from pg_proc p where p.oid = to_regprocedure('public.' || t) and p.prosecdef and p.proconfig @> array['search_path=public'];
    if i <> 1 or has_function_privilege('anon', 'public.' || t, 'execute') or has_function_privilege('public', 'public.' || t, 'execute')
       or not has_function_privilege('authenticated', 'public.' || t, 'execute') then
      fails := fails || format('%s is not a definer function on a fixed search path for signed-in users only', t);
    end if;
  end loop;
  select count(*) filter (where n.nspname = 'public' and p.proname = any (select split_part(f, '(', 1) from unnest(fns) f)),
    count(*) filter (where n.nspname = 'private' and p.proname ~ '^hr_(doc|letter|template|seed_letter|orphaned)'),
    count(*) filter (where n.nspname = 'private' and (p.proname like 'hr\_%' or p.proname = 'reseed_demo_people')
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')))
  into i, j, ctx from pg_proc p join pg_namespace n on n.oid = p.pronamespace;
  if i <> 16 or j <> 11 or ctx <> '0' then fails := fails || format('%s public functions (16), %s helpers (11), %s helpers callable (0)', i, j, ctx); end if;
  foreach t in array tabs loop
    select count(*) filter (where (p.policyname = t || '_select' and p.cmd = 'SELECT' and p.permissive = 'PERMISSIVE')
      or (p.policyname = 'mfa_required' and p.cmd = 'ALL' and p.permissive = 'RESTRICTIVE' and p.qual like '%mfa_ok()%')), count(*)
    into i, j from pg_policies p where p.schemaname = 'public' and p.tablename = t;
    if i <> 2 or j <> 2 or not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass)
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE, TRUNCATE') or has_any_column_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') or has_any_column_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE')
       -- (Not TRUNCATE: the live project's defaults leave it to the service role on every table, these included.)
       or has_table_privilege('service_role', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE') or has_any_column_privilege('service_role', 'public.' || t, 'SELECT, INSERT, UPDATE')
       or not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      fails := fails || format('%s is not read-only behind its read policy and the second-factor one, and closed to the service role', t);
    end if;
  end loop;
  foreach t in array array['anon', 'authenticated', 'service_role', 'public'] loop
    if has_table_privilege(t, 'private.hr_released_documents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') or has_any_column_privilege(t, 'private.hr_released_documents', 'SELECT, INSERT, UPDATE')
       or (t <> 'service_role') = has_function_privilege(t, 'public.hr_orphaned_document_files(uuid)', 'execute')
       or (t <> 'service_role') = has_function_privilege(t, 'public.hr_release_orphaned_document_files(uuid,int)', 'execute') then
      fails := fails || format('%s holds the wrong rights on the released list or the two steps of the sweep', t);
    end if;
  end loop;
  select count(*), count(*) filter (where p.prosecdef and p.proconfig @> array['search_path=public']) into i, j from pg_proc p
  where p.oid in (to_regprocedure('public.hr_orphaned_document_files(uuid)'), to_regprocedure('public.hr_release_orphaned_document_files(uuid,int)'));
  if i <> 2 or j <> 2 or (select p.provolatile from pg_proc p where p.oid = to_regprocedure('public.hr_orphaned_document_files(uuid)')) <> 's' then
    fails := fails || 'the two steps of the sweep are not definer functions on a fixed search path, the listing one unable to write'::text;
  end if;
  select count(*) into i from pg_policies p where p.schemaname = 'private' and p.tablename = 'hr_released_documents';
  if i <> 0 or not (select c.relrowsecurity from pg_class c where c.oid = 'private.hr_released_documents'::regclass) then
    fails := fails || 'the released list is not closed behind row level security'::text;
  end if;
  select count(*) into i from storage.buckets b where b.id = 'hr-documents' and b.public is not true and b.file_size_limit = 10485760
    and b.allowed_mime_types @> array['application/pdf','image/jpeg','image/png','image/webp','image/heic'] and cardinality(b.allowed_mime_types) = 5;
  select count(*), count(*) filter (where (p.policyname, p.cmd, p.permissive) in (('hr_document_files_select', 'SELECT', 'PERMISSIVE'),
      ('hr_document_files_insert', 'INSERT', 'PERMISSIVE'), ('hr_document_files_mfa_required', 'ALL', 'RESTRICTIVE')) and p.roles = array['authenticated']::name[])
  into j, ctx from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
    and (p.policyname like 'hr\_document%' or p.qual like '%hr-documents%' or p.with_check like '%hr-documents%');
  if i <> 1 or j <> 3 or ctx <> '3' then fails := fails || format('the hr-documents bucket (%s of 1) or its policies (%s, %s as expected, of 3) are not as expected', i, j, ctx); end if;
  -- An employee is deleted through hr_delete_employee only: signed-in users hold no DELETE on the table, and still add and edit.
  if has_table_privilege('authenticated', 'public.hr_employees', 'DELETE') or has_table_privilege('anon', 'public.hr_employees', 'DELETE')
     or not has_table_privilege('authenticated', 'public.hr_employees', 'INSERT') or not has_any_column_privilege('authenticated', 'public.hr_employees', 'UPDATE') then
    fails := fails || 'signed-in users should add and edit employees directly and delete them only through hr_delete_employee'::text;
  end if;
  if cardinality(fails) > 0 then raise exception 'the functions, grants, policies and bucket are not as expected, so nothing else was tried'; end if;

  execute $f$
    create function pg_temp.x(who uuid, label text, q text, want text, aal text default 'aal1', rol text default 'authenticated') returns text[] language plpgsql as $b$
    declare r jsonb; got text; ok boolean;
    begin
      perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', who, 'role', rol, 'aal', case when who is not null then aal end))::text, true);
      execute 'set local role ' || rol;
      begin execute 'select to_jsonb(' || q || ')' into r;
      exception when others then got := sqlerrm; end;
      reset role;
      ok := case when want is null then got is null when left(want, 1) = '=' then got is null and r = substr(want, 2)::jsonb else got is not distinct from want end;
      if ok then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, coalesce(want, 'it to go through'), coalesce(got, r::text))];
    end $b$
  $f$;
  execute $f$
    create function pg_temp.d(who uuid, label text, q text, want text, rol text default 'authenticated', extra jsonb default '{}') returns text[] language plpgsql as $b$
    declare got text; n int;
    begin
      perform set_config('request.jwt.claims', (jsonb_strip_nulls(jsonb_build_object('sub', who, 'role', rol, 'aal', 'aal1')) || extra)::text, true);
      execute 'set local role ' || rol;
      begin execute q; get diagnostics n = row_count; got := case when n > 0 then 'ok' else 'none' end;
      exception when insufficient_privilege then got := 'denied'; when others then got := 'stopped: ' || sqlerrm; end;
      reset role;
      -- A statement that must touch no row may as well be refused outright (real storage refuses some).
      if got = want or (want = 'none' and got <> 'ok') then return '{}'; end if;
      return array[format('%s: wanted %s, got %s', label, want, got)];
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
    create function pg_temp.p(o uuid, e uuid) returns text language sql as $b$ select o || '/' || e || '/' || gen_random_uuid() || '.pdf' $b$
  $f$;
  execute $f$
    create function pg_temp.up(o uuid, e uuid, ext text default 'pdf', age interval default '0', meta jsonb default null) returns text language plpgsql as $b$
    declare p text := o || '/' || e || '/' || gen_random_uuid() || '.' || ext;
    begin
      insert into storage.objects (bucket_id, name, created_at, metadata) values ('hr-documents', p, now() - age, meta);
      return p;
    end $b$
  $f$;
  execute $f$
    create function pg_temp.snap(o uuid) returns text language sql as $b$
      select md5(coalesce(string_agg(s.x, ',' order by s.x), '')) from (
        select a::text as x from public.hr_documents a where a.org_id = o union all select a::text from public.hr_letters a where a.org_id = o
        union all select a::text from public.hr_letter_templates a where a.org_id = o union all select a::text from public.hr_employees a where a.org_id = o
        union all select a.path from private.hr_released_documents a where left(a.path, 36) = o::text) s
    $b$
  $f$;

  -- people and workspaces
  -- own: owner, no employee record (and an admin of the other workspace).
  -- adm: admin, with an employee record. mfa: admin with a verified
  -- authenticator. ma, mb: members, each linked to an employee; mv: a viewer.
  -- outs: owner of another workspace. dv, da: a visitor and an admin of the demo.
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u || '@docs-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[own, adm, mfa, ma, mb, mv, outs, dv, da]) u;
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values (gen_random_uuid(), mfa, 'totp', 'verified', now(), now());
  insert into public.orgs (id, name) values (org, 'Docs Check Sdn Bhd'), (oth, 'Docs Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  select org, u, case when u = own then 'owner' when u in (adm, mfa) then 'admin' when u = mv then 'viewer' else 'member' end
  from unnest(array[own, adm, mfa, ma, mb, mv]) u;
  insert into public.org_members (org_id, user_id, role) values (oth, outs, 'owner'), (oth, own, 'admin'), (demo, dv, 'viewer'), (demo, da, 'admin');
  insert into public.hr_departments (org_id, name) values (org, 'Sales') returning id into g;
  insert into public.hr_employees (org_id, employee_no, name, user_id, designation, department_id, join_date) values (org, 'A1', 'Member A', ma, ' Engineer ', g, '2020-03-05') returning id into ea;
  insert into public.hr_employees (org_id, employee_no, name, user_id, designation) values (org, 'B', 'Member B', mb, '  ') returning id into eb;
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'C', 'Full Folder') returning id into ec;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (org, 'D', 'Adam Admin', adm) returning id into ed;
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'X', 'Leaver') returning id into ex;
  insert into public.hr_employees (org_id, employee_no, name) values (org, 'P', 'Paid') returning id into ep;
  insert into public.hr_employees (org_id, employee_no, name, user_id) values (oth, 'O', 'Outsider', outs) returning id into eo;
  perform private.reseed_demo_people();
  perform private.reseed_demo_people();
  select a.id into dd from public.hr_documents a where a.employee_id = de and a.ack_requested;
  select a.id into dl from public.hr_letters a where a.org_id = demo and a.status = 'draft' limit 1;
  select a.id into di from public.hr_letters a where a.employee_id = de and a.status = 'issued' and a.ack_requested;
  select a.id into dt from public.hr_letter_templates a where a.org_id = demo and a.letter_type = 'offer';
  select a.id into tp from public.hr_letter_templates a where a.org_id = org and a.letter_type = 'other';
  select a.id into tt from public.hr_letter_templates a where a.org_id = oth and a.letter_type = 'other';
  if dd is null or dl is null or di is null or dt is null or tp is null or tt is null then
    raise exception 'the demo has no document or letter to try, or a new workspace was given no starter templates';
  end if;

  -- 1. who may call what
  -- Rows for everyone to try their hand at: a document HR added to A and one A
  -- uploaded; a file in A's folder on no document; a draft and an issued letter to A.
  f1 := pg_temp.up(org, ea); f2 := pg_temp.up(org, ea); f3 := pg_temp.up(org, ea);
  insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type)
  values (org, ea, 'From HR', 'contract', f1, 'a.pdf', 10, 'application/pdf') returning id into dh;
  insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type, source)
  values (org, ea, 'Mine', 'other', f2, 'a.pdf', 10, 'application/pdf', 'employee') returning id into dm;
  insert into public.hr_documents (org_id, employee_id, title, doc_type, ack_requested) values (org, ed, 'For the admin', 'contract', true) returning id into da_;
  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, ack_requested) values (org, ea, 'offer', 'Draft', 'Body', true) returning id into ld;
  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, status, issued_on, ack_requested) values (org, ea, 'offer', 'Issued', 'Body', 'issued', d, true) returning id into li;
  insert into public.hr_letters (org_id, employee_id, letter_type, title, body, ack_requested) values (org, ed, 'offer', 'To the admin', 'Body', true) returning id into la;
  snap := pg_temp.snap(org);
  for who, lbl in select * from (values (ma, 'the employee'), (mb, 'another member'), (mv, 'a viewer'), (outs, 'another workspace''s owner'),
    (dv, 'a demo visitor'), (mfa, 'an admin who owes a second factor'), (null::uuid, 'nobody')) c(who, lbl)
  loop
    for q, want, i in select * from (values
      (format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, ea, f3), 'DOC_NOT_ALLOWED', 1),
      (format('hr_remove_document(%L)', dm), 'DOC_NOT_FOUND', 1),
      (format('hr_acknowledge_document(%L)', dh), 'DOC_NOT_FOUND', 1),
      (format('hr_acknowledge_letter(%L)', li), 'LETTER_NOT_FOUND', 1),
      (format('hr_release_document_file(%L)', f3), '=false', 1),
      (format('hr_update_document(%L,''T'',''other'',null)', dh), 'DOC_NOT_FOUND', 0),
      (format('hr_update_document(%L,''T'',''other'',null)', dm), 'DOC_NOT_FOUND', 0),
      (format('hr_replace_document_file(%L,%L' || pdf, dm, f3), 'DOC_NOT_FOUND', 0),
      (format('hr_replace_document_file(%L,%L' || pdf, dh, f3), 'DOC_NOT_FOUND', 0),
      (format('hr_remove_document(%L)', dh), 'DOC_NOT_FOUND', 0),
      (format('hr_request_document_ack(%L,true)', dh), 'DOC_NOT_FOUND', 0),
      (format('coalesce(hr_delete_employee(%L,%L),''"no"'')', org, eb), '="no"', 0),
      (format('hr_save_letter(%L,null,''other'',''T'',''B'',false)', ea), 'LETTER_NOT_ALLOWED', 0),
      (format('hr_save_letter(%L,%L,''other'',''T'',''B'',false)', ea, ld), 'LETTER_NOT_ALLOWED', 0),
      (format('hr_start_letter_from_template(%L,%L)', ea, tp), 'LETTER_NOT_ALLOWED', 0),
      (format('hr_issue_letter(%L)', ld), 'LETTER_NOT_FOUND', 0),
      (format('hr_issue_letter(%L)', li), 'LETTER_NOT_FOUND', 0),
      (format('hr_unissue_letter(%L)', li), 'LETTER_NOT_FOUND', 0),
      (format('hr_delete_letter(%L)', ld), 'LETTER_NOT_FOUND', 0),
      (format('hr_delete_letter(%L)', li), 'LETTER_NOT_FOUND', 0),
      (format('hr_acknowledge_letter(%L)', ld), 'LETTER_NOT_FOUND', 0),
      (format('hr_save_letter_template(%L,null,''N'',''other'',''T'',''B'')', org), 'LETTER_NOT_ALLOWED', 0),
      (format('hr_save_letter_template(%L,%L,''N'',''other'',''T'',''B'')', org, tp), 'LETTER_NOT_FOUND', 0),
      (format('hr_delete_letter_template(%L)', tp), 'LETTER_NOT_FOUND', 0)) c(q, want, own_too)
    loop
      -- The employee concerned may do the first five (sections 2 and 4 show them going through).
      continue when who = ma and i = 1;
      fails := fails || pg_temp.x(who, lbl || ': ' || split_part(q, '(', 1), q, case when who is null and left(want, 1) <> '=' then split_part(want, '_', 1) || '_NOT_ALLOWED' else want end);
    end loop;
  end loop;
  fails := fails || pg_temp.v('someone who may not act changed a row', format('select pg_temp.snap(%L)', org), snap);
  fails := fails
    -- An id that is nothing, or of another workspace, is answered as an id the caller may not use is.
    || pg_temp.x(own, 'no such employee', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, gen_random_uuid(), f3), 'DOC_NOT_ALLOWED')
    || pg_temp.x(own, 'a null employee', 'hr_save_letter(null,null,''other'',''T'',''B'',false)', 'LETTER_NOT_ALLOWED')
    || pg_temp.x(own, 'no such document', format('hr_remove_document(%L)', gen_random_uuid()), 'DOC_NOT_FOUND')
    || pg_temp.x(own, 'a null document', 'hr_acknowledge_document(null)', 'DOC_NOT_FOUND')
    || pg_temp.x(own, 'no such letter', format('hr_issue_letter(%L)', gen_random_uuid()), 'LETTER_NOT_FOUND')
    || pg_temp.x(own, 'a null letter', 'hr_delete_letter(null)', 'LETTER_NOT_FOUND')
    || pg_temp.x(own, 'a null template', 'hr_delete_letter_template(null)', 'LETTER_NOT_FOUND')
    || pg_temp.x(null, 'nobody, with no template', 'hr_delete_letter_template(null)', 'LETTER_NOT_ALLOWED')
    || pg_temp.x(own, 'no workspace', 'hr_save_letter_template(null,null,''N'',''other'',''T'',''B'')', 'LETTER_NOT_ALLOWED')
    || pg_temp.x(adm, 'a workspace the admin is no part of', format('hr_save_letter_template(%L,null,''N'',''other'',''T'',''B'')', oth), 'LETTER_NOT_ALLOWED')
    || pg_temp.x(adm, 'another workspace''s template', format('hr_delete_letter_template(%L)', tt), 'LETTER_NOT_FOUND')
    || pg_temp.x(own, 'a template under another workspace''s name', format('hr_save_letter_template(%L,%L,''N'',''other'',''T'',''B'')', org, tt), 'LETTER_NOT_FOUND')
    || pg_temp.x(own, 'a letter from another workspace''s template', format('hr_start_letter_from_template(%L,%L)', ea, tt), 'LETTER_NOT_FOUND')
    || pg_temp.x(adm, 'a letter from no template', format('hr_start_letter_from_template(%L,null)', ea), 'LETTER_NOT_FOUND')
    || pg_temp.x(own, 'an employee under another workspace''s name', format('coalesce(hr_delete_employee(%L,%L),''"no"'')', oth, eb), '="no"')
    || pg_temp.x(adm, 'A''s letter under B''s name', format('hr_save_letter(%L,%L,''other'',''T'',''B'',false)', eb, ld), 'LETTER_NOT_FOUND')
    -- With the second factor entered, that admin is an admin again.
    || pg_temp.x(mfa, 'an admin who entered their second factor', format('hr_update_document(%L,''From HR'',''contract'',null)', dh), null, 'aal2');
  -- The owner, then the admin, take every function through.
  foreach who in array array[own, adm] loop
    lbl := case when who = own then 'the owner ' else 'the admin ' end;
    f4 := org || '/' || eb || '/' || gen_random_uuid() || '.pdf';
    f5 := pg_temp.up(org, eb, 'png');
    fails := fails || pg_temp.d(who, lbl || 'uploads into B''s folder', format(ins, f4, who), 'ok')
      || pg_temp.x(who, lbl || 'adds a document', format('hr_add_document(%L,'' Contract '',''contract'',''2030-01-01'',%L,'' c.pdf '',1234,''application/pdf'') - ''id'' - ''created_at''', eb, f4),
        '=' || format(docj, eb, 'Contract', 'contract', '"2030-01-01"', 'c.pdf', 1234, 'application/pdf', 'false'));
    select a.id into g from public.hr_documents a where a.file_path = f4;
    fails := fails || pg_temp.x(who, lbl || 'changes it', format('hr_update_document(%L,''Pass'',''identity'',null) - ''id'' - ''created_at''', g),
        '=' || format(docj, eb, 'Pass', 'identity', 'null', 'c.pdf', 1234, 'application/pdf', 'false'))
      || pg_temp.x(who, lbl || 'asks for an acknowledgement', format('hr_request_document_ack(%L,true) -> ''ack_requested''', g), '=true')
      || pg_temp.x(mb, 'B acknowledges', format('(hr_acknowledge_document(%L) ->> ''acknowledged_at'')::timestamptz = now()', g), '=true')
      || pg_temp.x(who, lbl || 'replaces the file', format('hr_replace_document_file(%L,%L,''n.png'',99,''image/png'') #- ''{document,id}'' #- ''{document,created_at}''', g, f5),
        format('={"document":%s,"old_path":"%s"}', format(docj, eb, 'Pass', 'identity', 'null', 'n.png', 99, 'image/png', 'true'), f4))
      || pg_temp.v(lbl || 'is the uploader, and the old file is released', format('select uploaded_by || ''/'' || (select count(*) from private.hr_released_documents where path = %L) from public.hr_documents where id = %L', f4, g), who || '/1')
      || pg_temp.x(mb, 'B acknowledges the new file', format('hr_acknowledge_document(%L)', g), null)
      || pg_temp.x(who, lbl || 'withdraws the request', format('hr_request_document_ack(%L,false) - ''id'' - ''created_at''', g),
        '=' || format(docj, eb, 'Pass', 'identity', 'null', 'n.png', 99, 'image/png', 'false'))
      || pg_temp.x(who, lbl || 'removes it', format('hr_remove_document(%L)', g), format('={"id":"%s","employee_id":"%s","path":"%s"}', g, eb, f5))
      || pg_temp.v(lbl || 'removed it, and its file is released', format('select (select count(*) from public.hr_documents where id = %L) || ''/'' || (select count(*) from private.hr_released_documents where path = %L)', g, f5), '0/1')
      || pg_temp.x(who, lbl || 'writes a letter', format('hr_save_letter(%L,null,''offer'','' Hello '','' Body '',true) - ''id''', eb), '=' || format(letj, eb, 'offer', 'Hello', ' Body ', 'draft', 'null', 'true'));
    select a.id into g from public.hr_letters a where a.employee_id = eb and a.title = 'Hello';
    fails := fails || pg_temp.x(mb, 'B does not read the draft', format('(select count(*) from hr_letters where org_id = %L)', org), '=0')
      || pg_temp.x(who, lbl || 'changes the draft', format('hr_save_letter(%L,%L,''warning'',''Hello'',''{salary} is ordinary text'',null) - ''id''', eb, g), '=' || format(letj, eb, 'warning', 'Hello', '{salary} is ordinary text', 'draft', 'null', 'false'))
      || pg_temp.x(who, lbl || 'asks for an acknowledgement of it', format('hr_save_letter(%L,%L,''warning'',''Hello'',''{salary} is ordinary text'',true) -> ''ack_requested''', eb, g), '=true')
      || pg_temp.x(who, lbl || 'issues it', format('hr_issue_letter(%L) - ''id''', g), '=' || format(letj, eb, 'warning', 'Hello', '{salary} is ordinary text', 'issued', '"' || d || '"', 'true'))
      || pg_temp.v(lbl || 'is the issuer', format('select issued_by from public.hr_letters where id = %L', g), who::text)
      || pg_temp.x(mb, 'B reads it once issued', format('(select string_agg(id::text, '','') from hr_letters where org_id = %L)', org), format('="%s"', g))
      || pg_temp.x(mb, 'B acknowledges it', format('(hr_acknowledge_letter(%L) ->> ''acknowledged_at'')::timestamptz = now()', g), '=true')
      || pg_temp.x(who, lbl || 'pulls it back', format('hr_unissue_letter(%L) - ''id''', g), '=' || format(letj, eb, 'warning', 'Hello', '{salary} is ordinary text', 'draft', 'null', 'true'))
      || pg_temp.v(lbl || 'pulled it back: no date, no issuer', format('select coalesce(issued_on::text, issued_by::text, acknowledged_at::text, ''-'') from public.hr_letters where id = %L', g), '-')
      || pg_temp.x(mb, 'B no longer reads it', format('(select count(*) from hr_letters where org_id = %L)', org), '=0')
      || pg_temp.x(who, lbl || 'deletes the draft', format('hr_delete_letter(%L)', g), format('={"id":"%s","employee_id":"%s"}', g, eb))
      || pg_temp.x(who, lbl || 'adds a template', format('hr_save_letter_template(%L,null,'' T1 '',''other'','' Title '',''B'') - ''id''', org), '={"name":"T1","letter_type":"other","title":"Title","body":"B"}');
    select a.id into g from public.hr_letter_templates a where a.org_id = org and a.name = 'T1';
    fails := fails || pg_temp.x(who, lbl || 'changes it', format('hr_save_letter_template(null,%L,''T1'',''offer'',''Title 2'',null)', g), format('={"id":"%s","name":"T1","letter_type":"offer","title":"Title 2","body":""}', g))
      || pg_temp.x(who, lbl || 'starts a letter from it', format('hr_start_letter_from_template(%L,%L) #- ''{letter,id}''', eb, g), format('={"letter":%s,"unfilled":[]}', format(letj, eb, 'offer', 'Title 2', '', 'draft', 'null', 'false')))
      || pg_temp.x(who, lbl || 'deletes the template', format('hr_delete_letter_template(%L)', g), format('={"id":"%s"}', g))
      || pg_temp.v(lbl || 'left the letter started from it', format('select count(*) || ''/'' || count(template_id) from public.hr_letters where employee_id = %L', eb), '1/0')
      || pg_temp.x(who, lbl || 'discards an upload', format('hr_release_document_file(%L)', pg_temp.up(org, eb)), '=true');
    delete from public.hr_letters a where a.employee_id = eb;
  end loop;
  if cardinality(fails) > 0 then raise exception 'who may call what is not as expected, so the rules were not tried'; end if;

  -- 2. documents: types, input, files, the 200, removal, release
  for t, want in select * from (values ('identity', null), ('medical', null), ('certificate', null), ('other', null),
    ('contract', 'DOC_TYPE_NOT_ALLOWED'), ('tax', 'DOC_TYPE_NOT_ALLOWED'), ('benefits', 'DOC_TYPE_NOT_ALLOWED')) c(t, want)
  loop
    fails := fails || pg_temp.x(ma, 'A adds their own ' || t, format('hr_add_document(%L,''Own'',%L,null,%L' || pdf || ' ->> ''source''', ea, t, pg_temp.up(org, ea)), coalesce(want, '="employee"'))
      || pg_temp.x(adm, 'the admin adds A''s ' || t, format('hr_add_document(%L,''Theirs'',%L,null,%L' || pdf || ' ->> ''source''', ea, t, pg_temp.up(org, ea)), '="hr"');
  end loop;
  f4 := pg_temp.up(org, ea);
  for lbl, q in select * from (values ('a blank title', '''  '',''other'',null'), ('no title', 'null,''other'',null'), ('a title of 201', format('%L,''other'',null', repeat('x', 201))),
    ('an old type', '''T'',''payslip'',null'), ('no type', '''T'',null,null'), ('an expiry before 2000', '''T'',''other'',''1999-12-31'''), ('an expiry after 2100', '''T'',''other'',''2101-01-01''')) c(lbl, q)
  loop
    fails := fails || pg_temp.x(adm, 'a document with ' || lbl, format('hr_add_document(%L,%s,%L' || pdf, ea, q, f4), 'DOC_BAD_INPUT')
      || pg_temp.x(adm, 'a document changed to ' || lbl, format('hr_update_document(%L,%s)', dh, q), 'DOC_BAD_INPUT');
  end loop;
  f5 := pg_temp.up(org, ea);
  fb := pg_temp.p(org, ea);
  insert into storage.objects (bucket_id, name) values ('chat-attachments', fb);
  fails := fails || pg_temp.x(adm, 'the admin discards an upload', format('hr_release_document_file(%L)', f5), '=true');
  for lbl, q, fname, sz, t in select * from (values ('another workspace''s file', pg_temp.up(oth, eo), 'a.pdf', '10', 'application/pdf'),
    ('a file in B''s folder', pg_temp.up(org, eb), 'a.pdf', '10', 'application/pdf'), ('A''s folder under another workspace''s name', pg_temp.up(oth, ea), 'a.pdf', '10', 'application/pdf'), ('a file that was never uploaded', pg_temp.p(org, ea), 'a.pdf', '10', 'application/pdf'), ('a file that is in another bucket', fb, 'a.pdf', '10', 'application/pdf'),
    ('a file already on a document', f1, 'a.pdf', '10', 'application/pdf'), ('a released file', f5, 'a.pdf', '10', 'application/pdf'),
    ('a file whose extension is not its type''s', pg_temp.up(org, ea, 'png'), 'a.pdf', '10', 'application/pdf'), ('a path in capitals', upper(f4), 'a.pdf', '10', 'application/pdf'),
    ('a path with more after it', f4 || '/x', 'a.pdf', '10', 'application/pdf'), ('no path', null, 'a.pdf', '10', 'application/pdf'),
    ('an empty file', f4, 'a.pdf', '0', 'application/pdf'), ('a file over 10 MB', f4, 'a.pdf', '10485761', 'application/pdf'), ('no size', f4, 'a.pdf', 'null', 'application/pdf'),
    ('a blank file name', f4, '  ', '10', 'application/pdf'), ('a file name with a slash', f4, 'a/b.pdf', '10', 'application/pdf'),
    ('a file name of 201', f4, repeat('n', 201), '10', 'application/pdf'), ('a type the bucket does not take', f4, 'a.pdf', '10', 'text/plain'), ('no type', f4, 'a.pdf', '10', null)) c(lbl, q, fname, sz, t)
  loop
    fails := fails || pg_temp.x(adm, 'a document with ' || lbl, format('hr_add_document(%L,''T'',''other'',null,%L,%L,%s,%L)', ea, q, fname, sz, t), 'DOC_BAD_FILE')
      || pg_temp.x(adm, 'a file replaced by ' || lbl, format('hr_replace_document_file(%L,%L,%L,%s,%L)', dh, q, fname, sz, t), 'DOC_BAD_FILE');
  end loop;
  -- What storage recorded of a file is what must be said of it; what it did not record is taken on the caller's word.
  fo := pg_temp.up(org, ea, 'pdf', '0', '{"size":10,"mimetype":"application/pdf"}');
  fa := pg_temp.up(org, ea, 'pdf', '0', '{"mimetype":"image/png"}');
  fp := pg_temp.up(org, ea, 'pdf', '0', '{"size":77,"eTag":"x"}');
  fails := fails || pg_temp.x(adm, 'a size that is not the file''s', format('hr_add_document(%L,''T'',''other'',null,%L,''a.pdf'',11,''application/pdf'')', ea, fo), 'DOC_BAD_FILE')
    || pg_temp.x(adm, 'a file replaced by one of another size', format('hr_replace_document_file(%L,%L,''a.pdf'',9,''application/pdf'')', dh, fo), 'DOC_BAD_FILE')
    || pg_temp.x(adm, 'a type that is not the file''s', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, ea, fa), 'DOC_BAD_FILE')
    || pg_temp.x(adm, 'the size and type storage recorded', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf || ' -> ''file_size''', ea, fo), '=10')
    || pg_temp.x(adm, 'the size storage recorded, and a type it did not', format('hr_add_document(%L,''T'',''other'',null,%L,''a.pdf'',77,''application/pdf'') -> ''file_size''', ea, fp), '=77');
  -- The table's own rules, whoever writes: these are the database owner's statements.
  foreach q in array array[
    format('insert into public.hr_documents (org_id, employee_id, title, doc_type, source, ack_requested) values (%L, %L, ''T'', ''other'', ''employee'', true)', org, ea),
    format('update public.hr_documents set acknowledged_at = now() where id = %L', dm),
    format('update public.hr_documents set file_name = null where id = %L', dh),
    format('insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path) values (%L, %L, ''T'', ''other'', %L)', org, ea, pg_temp.p(org, ea)),
    format('update public.hr_documents set doc_type = ''payslip'' where id = %L', dh),
    format('update public.hr_letters set acknowledged_at = now() where id = %L', ld),
    format('update public.hr_letters set issued_on = null where id = %L', li),
    format('update public.hr_letters set issued_on = %L where id = %L', d, ld),
    format('update public.hr_letters set acknowledged_at = now(), ack_requested = false where id = %L', li),
    format('update public.hr_letters set letter_type = ''Offer'' where id = %L', ld)]
  loop
    begin
      execute q;
      fails := fails || ('the table took: ' || q);
    exception when check_violation then null;
    end;
  end loop;
  insert into public.hr_documents (org_id, employee_id, title, doc_type) select org, ec, 'Planted ' || s, 'other' from generate_series(1, 199) s;
  select a.id into g from public.hr_documents a where a.employee_id = ea and a.source = 'employee' and a.doc_type = 'other' and a.id <> dm;
  fails := fails || pg_temp.x(ma, 'A attaches a file from B''s folder', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, ea, pg_temp.up(org, eb)), 'DOC_BAD_FILE')
    || pg_temp.x(adm, 'the largest file, the longest names, the last year', format('hr_add_document(%L,%L,''tax'',''2100-12-31'',%L,%L,10485760,''image/heic'') ->> ''expires_on''', ec, repeat('x', 200), pg_temp.up(org, ec, 'heic'), repeat('n', 200)), '="2100-12-31"')
    || pg_temp.x(adm, 'the 201st document', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, ec, pg_temp.up(org, ec)), 'DOC_TOO_MANY')
    || pg_temp.x(adm, 'the first year', format('hr_update_document(%L,''From HR'',''contract'',''2000-01-01'') ->> ''expires_on''', dh), '="2000-01-01"')
    || pg_temp.x(ma, 'A removes their own upload', format('hr_remove_document(%L)', dm), format('={"id":"%s","employee_id":"%s","path":"%s"}', dm, ea, f2))
    || pg_temp.x(ma, 'A removes it twice', format('hr_remove_document(%L)', dm), 'DOC_NOT_FOUND')
    || pg_temp.x(adm, 'the admin removes one of A''s uploads', format('hr_remove_document(%L) ? ''path''', g), '=true')
    || pg_temp.x(ma, 'A discards their own upload', format('hr_release_document_file(%L)', f3), '=true')
    || pg_temp.x(ma, 'A discards it twice', format('hr_release_document_file(%L)', f3), '=true')
    || pg_temp.x(ma, 'A attaches it after all', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, ea, f3), 'DOC_BAD_FILE')
    || pg_temp.x(ma, 'A discards a file on a document', format('hr_release_document_file(%L)', f1), '=false')
    || pg_temp.x(adm, 'the admin discards a file on a document', format('hr_release_document_file(%L)', f1), '=false')
    || pg_temp.x(adm, 'the admin discards a file that is not there', format('hr_release_document_file(%L)', pg_temp.p(org, ea)), '=false')
    || pg_temp.x(adm, 'the admin discards something that is no path', 'hr_release_document_file(''x'')', '=false')
    || pg_temp.x(adm, 'the admin discards nothing', 'hr_release_document_file(null)', '=false')
    || pg_temp.v('what was released', format('select count(*) from private.hr_released_documents where path in (%L, %L, %L, %L)', f1, f2, f3, f5), '3');

  -- 3. files: who uploads where, who reads what, and nobody changes or removes
  for who, lbl, q, want, t in select * from (values (ma, 'A uploads into their own folder', pg_temp.p(org, ea), 'ok', 'authenticated'),
    (mv, 'the viewer, who is no employee, uploads into A''s folder', pg_temp.p(org, ea), 'denied', 'authenticated'), (mb, 'B uploads into A''s folder', pg_temp.p(org, ea), 'denied', 'authenticated'),
    (ma, 'A uploads into B''s folder', pg_temp.p(org, eb), 'denied', 'authenticated'), (ma, 'A uploads into another workspace', pg_temp.p(oth, eo), 'denied', 'authenticated'),
    (ma, 'A uploads into their folder under another workspace''s name', pg_temp.p(oth, ea), 'denied', 'authenticated'), (ma, 'A uploads a file of another shape', org || '/' || ea || '/notes.txt', 'denied', 'authenticated'),
    (ma, 'A uploads beside their folder', org || '/' || gen_random_uuid() || '.pdf', 'denied', 'authenticated'), (adm, 'the admin uploads into A''s folder', pg_temp.p(org, ea), 'ok', 'authenticated'),
    (adm, 'the admin uploads into another workspace', pg_temp.p(oth, eo), 'denied', 'authenticated'), (adm, 'the admin uploads for another workspace''s employee', pg_temp.p(org, eo), 'denied', 'authenticated'),
    (adm, 'the admin uploads for nobody', pg_temp.p(org, gen_random_uuid()), 'denied', 'authenticated'), (outs, 'another workspace''s owner uploads into A''s folder', pg_temp.p(org, ea), 'denied', 'authenticated'),
    (outs, 'another workspace''s owner uploads into their own', pg_temp.p(oth, eo), 'ok', 'authenticated'), (dv, 'a demo visitor uploads', pg_temp.p(demo, de), 'denied', 'authenticated'),
    (da, 'a demo admin uploads', pg_temp.p(demo, de), 'denied', 'authenticated'), (mfa, 'an admin who owes a second factor uploads', pg_temp.p(org, ea), 'denied', 'authenticated'),
    (null, 'nobody uploads', pg_temp.p(org, ea), 'denied', 'authenticated'), (ma, 'a signed-out visitor uploads', pg_temp.p(org, ea), 'denied', 'anon')) c(who, lbl, q, want, t)
  loop
    fails := fails || pg_temp.d(who, lbl, format(ins, q, who), want, t);
  end loop;
  insert into storage.objects (bucket_id, name) values ('chat-attachments', f1);
  -- A document of A's whose file has gone missing: nobody may put another in its place.
  fa := pg_temp.p(org, ea);
  insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type) values (org, ea, 'File gone', 'contract', fa, 'a.pdf', 10, 'application/pdf');
  fails := fails || pg_temp.d(ma, 'A uploads at the path of their document whose file is gone', format(ins, fa, ma), 'denied')
    || pg_temp.d(adm, 'the admin uploads at that path', format(ins, fa, adm), 'denied');
  delete from public.hr_documents a where a.file_path = fa;
  fails := fails || pg_temp.d(ma, 'A uploads there once no document carries it', format(ins, fa, ma), 'ok');
  insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type) values (org, eb, 'B''s', 'contract', pg_temp.up(org, eb), 'a.pdf', 10, 'application/pdf');
  q := format('(select count(*) || ''/'' || count(*) filter (where o.name not in (select a.file_path from public.hr_documents a where a.employee_id = %%L and a.file_path is not null)) from storage.objects o where left(o.name, 36) = %L)', org);
  fails := fails || pg_temp.d(ma, 'an account still anonymous uploads', format(ins, pg_temp.p(org, ea), ma), 'denied', 'authenticated', '{"is_anonymous":true}')
    || pg_temp.x(ma, 'A reads the files of their own documents and no other', format(q, ea), format('="%s/0"', (select count(*) from public.hr_documents a where a.employee_id = ea and a.file_path is not null)))
    || pg_temp.x(mb, 'B reads the file of their one document', format(q, eb), '="1/0"')
    || pg_temp.x(adm, 'the admin reads every file on a document, and no stray upload', format('(select count(*) from storage.objects o where left(o.name, 36) = %L)', org), format('=%s', (select count(*) from public.hr_documents a where a.org_id = org and a.file_path is not null)))
    || pg_temp.x(ma, 'A reads the file by name in this bucket only', format('(select string_agg(o.bucket_id, '','') from storage.objects o where o.name = %L)', f1), '="hr-documents"')
    || pg_temp.x(mfa, 'an admin who owes a second factor reads no file', format('(select count(*) from storage.objects o where left(o.name, 36) = %L)', org), '=0');
  for who, lbl, t in select * from (values (mv, 'a viewer', 'authenticated'), (outs, 'another workspace''s owner', 'authenticated'), (dv, 'a demo visitor', 'authenticated'), (null::uuid, 'nobody', 'authenticated'), (ma, 'a signed-out visitor', 'anon')) c(who, lbl, t) loop
    fails := fails || pg_temp.x(who, lbl || ' reads no file', format('(select count(*) from storage.objects o where left(o.name, 36) = %L)', org), '=0', 'aal1', t);
  end loop;
  foreach who in array array[ma, adm] loop
    fails := fails || pg_temp.d(who, 'a file was renamed by someone signed in', format('update storage.objects set name = name || ''x'' where name = %L and bucket_id = ''hr-documents''', f1), 'none')
      || pg_temp.d(who, 'a file was removed by someone signed in', format('delete from storage.objects where name = %L and bucket_id = ''hr-documents''', f1), 'none');
  end loop;

  -- 4. acknowledging a document
  select a.id into g from public.hr_documents a where a.employee_id = ea and a.source = 'employee' and a.doc_type = 'identity';
  f5 := pg_temp.up(org, ea);
  fails := fails || pg_temp.x(adm, 'an acknowledgement asked of A''s own upload', format('hr_request_document_ack(%L,true)', g), 'DOC_NOT_ALLOWED')
    || pg_temp.x(adm, 'asked, neither yes nor no', format('hr_request_document_ack(%L,null)', dh), 'DOC_BAD_INPUT')
    || pg_temp.x(ma, 'A acknowledges what nobody asked for', format('hr_acknowledge_document(%L)', dh), 'DOC_ACK_NOT_REQUESTED')
    || pg_temp.x(ma, 'A acknowledges their own upload', format('hr_acknowledge_document(%L)', g), 'DOC_ACK_NOT_REQUESTED')
    || pg_temp.x(adm, 'the admin asks', format('hr_request_document_ack(%L,true)', dh), null)
    || pg_temp.x(adm, 'the admin acknowledges for A', format('hr_acknowledge_document(%L)', dh), 'DOC_NOT_FOUND')
    || pg_temp.x(own, 'the owner acknowledges for A', format('hr_acknowledge_document(%L)', dh), 'DOC_NOT_FOUND')
    || pg_temp.x(mb, 'B acknowledges for A', format('hr_acknowledge_document(%L)', dh), 'DOC_NOT_FOUND')
    || pg_temp.x(ma, 'A acknowledges', format('(hr_acknowledge_document(%L) ->> ''acknowledged_at'')::timestamptz = now()', dh), '=true')
    || pg_temp.x(ma, 'A acknowledges twice', format('hr_acknowledge_document(%L)', dh), 'DOC_ALREADY_ACKNOWLEDGED')
    || pg_temp.x(adm, 'asking again keeps it', format('hr_request_document_ack(%L,true) ->> ''acknowledged_at'' is not null', dh), '=true')
    || pg_temp.x(adm, 'a new file clears it and keeps the request', format('hr_replace_document_file(%L,%L' || pdf || ' #- ''{document,id}'' #- ''{document,created_at}'' -> ''document''', dh, f5),
      '=' || format(docj, ea, 'From HR', 'contract', '"2000-01-01"', 'a.pdf', 10, 'application/pdf', 'true'))
    || pg_temp.x(ma, 'A acknowledges the new file', format('hr_acknowledge_document(%L)', dh), null)
    || pg_temp.x(adm, 'withdrawing the request clears it', format('hr_request_document_ack(%L,false) - ''id'' - ''created_at''', dh),
      '=' || format(docj, ea, 'From HR', 'contract', '"2000-01-01"', 'a.pdf', 10, 'application/pdf', 'false'))
    || pg_temp.x(ma, 'A acknowledges once it is withdrawn', format('hr_acknowledge_document(%L)', dh), 'DOC_ACK_NOT_REQUESTED')
    || pg_temp.x(own, 'the owner acknowledges the admin''s document', format('hr_acknowledge_document(%L)', da_), 'DOC_NOT_FOUND')
    || pg_temp.x(adm, 'the admin acknowledges their own', format('hr_acknowledge_document(%L)', da_), null)
    || pg_temp.v('the acknowledgements on file', format('select count(*) || ''/'' || count(*) filter (where id = %L) from public.hr_documents where org_id = %L and acknowledged_at is not null', da_, org), '1/1');

  -- 5. letters: drafts, issuing, placeholders, acknowledging
  for lbl, q in select * from (values ('a blank title', '''other'','' '',''B'''), ('no title', '''other'',null,''B'''), ('a title of 201', format('''other'',%L,''B''', repeat('x', 201))),
    ('an old type', '''Offer'',''T'',''B'''), ('no type', 'null,''T'',''B'''), ('a body of 10,001', format('''other'',''T'',%L', repeat('x', 10001)))) c(lbl, q)
  loop
    fails := fails || pg_temp.x(adm, 'a letter with ' || lbl, format('hr_save_letter(%L,null,%s,false)', ea, q), 'LETTER_BAD_INPUT')
      || pg_temp.x(adm, 'a letter changed to ' || lbl, format('hr_save_letter(%L,%L,%s,false)', ea, ld, q), 'LETTER_BAD_INPUT');
  end loop;
  fails := fails || pg_temp.x(ma, 'A reads their issued letter only', format('(select string_agg(id::text, '','') from hr_letters where org_id = %L)', org), format('="%s"', li))
    || pg_temp.x(adm, 'the admin reads every letter', format('(select count(*) from hr_letters where org_id = %L)', org), '=3')
    || pg_temp.x(adm, 'an issued letter changed, whatever is sent', format('hr_save_letter(%L,%L,null,'''',null,false)', ea, li), 'LETTER_NOT_DRAFT')
    || pg_temp.x(adm, 'an issued letter deleted', format('hr_delete_letter(%L)', li), 'LETTER_NOT_DRAFT')
    || pg_temp.x(adm, 'an issued letter issued', format('hr_issue_letter(%L)', li), 'LETTER_NOT_DRAFT')
    || pg_temp.x(adm, 'a draft pulled back', format('hr_unissue_letter(%L)', ld), 'LETTER_NOT_ISSUED')
    || pg_temp.x(adm, 'a draft with no body', format('hr_save_letter(%L,%L,''offer'',''Draft'',null,true) ->> ''body''', ea, ld), '=""')
    || pg_temp.x(adm, 'issued with no body', format('hr_issue_letter(%L)', ld), 'LETTER_EMPTY')
    || pg_temp.x(adm, 'a draft of spaces and new lines', format('hr_save_letter(%L,%L,''offer'',''Draft'','' '' || chr(10) || chr(9) || chr(13),true)', ea, ld), null)
    || pg_temp.x(adm, 'issued with nothing but those', format('hr_issue_letter(%L)', ld), 'LETTER_EMPTY')
    || pg_temp.x(adm, 'a placeholder in the title', format('hr_save_letter(%L,%L,''offer'',''To {employee_name}'',''Body'',true)', ea, ld), null)
    || pg_temp.x(adm, 'issued with it', format('hr_issue_letter(%L)', ld), 'LETTER_PLACEHOLDER');
  foreach t in array array['employee_name','employee_no','designation','department','join_date','company_name','today'] loop
    fails := fails || pg_temp.x(adm, 'a draft with {' || t || '}', format('hr_save_letter(%L,%L,''offer'',''Draft'',%L,true)', ea, ld, 'As {' || t || '} says'), null)
      || pg_temp.x(adm, 'issued with {' || t || '} in it', format('hr_issue_letter(%L)', ld), 'LETTER_PLACEHOLDER');
  end loop;
  fails := fails || pg_temp.x(adm, 'a body of 10,000 with other braces', format('hr_save_letter(%L,%L,''offer'',''Draft'',%L,true)', ea, ld, rpad('{salary} {Today} { today } {employee} {today {} ', 10000, 'x')), null)
    || pg_temp.x(ma, 'A acknowledges a draft addressed to them', format('hr_acknowledge_letter(%L)', ld), 'LETTER_NOT_FOUND')
    || pg_temp.x(adm, 'issued with braces that are no placeholder', format('hr_issue_letter(%L) ->> ''issued_on''', ld), format('="%s"', d))
    || pg_temp.x(ma, 'A reads both once it is issued', format('(select count(*) || ''/'' || count(*) filter (where status = ''issued'' and employee_id = %L) from hr_letters where org_id = %L)', ea, org), '="2/2"')
    || pg_temp.x(adm, 'the admin acknowledges for A', format('hr_acknowledge_letter(%L)', li), 'LETTER_NOT_FOUND')
    || pg_temp.x(own, 'the owner acknowledges for A', format('hr_acknowledge_letter(%L)', li), 'LETTER_NOT_FOUND')
    || pg_temp.x(ma, 'A acknowledges', format('(hr_acknowledge_letter(%L) ->> ''acknowledged_at'')::timestamptz = now()', li), '=true')
    || pg_temp.x(ma, 'A acknowledges twice', format('hr_acknowledge_letter(%L)', li), 'LETTER_ALREADY_ACKNOWLEDGED')
    || pg_temp.x(adm, 'pulling it back clears the acknowledgement', format('hr_unissue_letter(%L) - ''id''', li), '=' || format(letj, ea, 'offer', 'Issued', 'Body', 'draft', 'null', 'true'))
    || pg_temp.x(ma, 'A acknowledges it once pulled back', format('hr_acknowledge_letter(%L)', li), 'LETTER_NOT_FOUND')
    || pg_temp.x(adm, 'it no longer asks', format('hr_save_letter(%L,%L,''offer'',''Issued'',''Body'',false)', ea, li), null)
    || pg_temp.x(adm, 'and is issued again', format('hr_issue_letter(%L) -> ''acknowledged_at''', li), '=null')
    || pg_temp.x(ma, 'A acknowledges what nobody asked for', format('hr_acknowledge_letter(%L)', li), 'LETTER_ACK_NOT_REQUESTED')
    || pg_temp.x(adm, 'the admin acknowledges a draft addressed to them', format('hr_acknowledge_letter(%L)', la), 'LETTER_NOT_ISSUED')
    || pg_temp.x(own, 'the owner issues it', format('hr_issue_letter(%L)', la), null)
    || pg_temp.x(own, 'the owner acknowledges it', format('hr_acknowledge_letter(%L)', la), 'LETTER_NOT_FOUND')
    || pg_temp.x(adm, 'the admin acknowledges their own', format('hr_acknowledge_letter(%L)', la), null)
    || pg_temp.x(adm, 'a new draft asks only when told to', format('hr_save_letter(%L,null,''other'',''T'',''B'',false) -> ''ack_requested''', ea), '=false')
    || pg_temp.v('the acknowledgements on file', format('select count(*) || ''/'' || count(*) filter (where id = %L) from public.hr_letters where org_id = %L and acknowledged_at is not null', la, org), '1/1');

  -- 6. templates: the starter set, names, the 50, filling
  for lbl, q in select * from (values ('a blank name', ''' '',''other'',''T'',''B'''), ('no name', 'null,''other'',''T'',''B'''), ('a name of 121', format('%L,''other'',''T'',''B''', repeat('x', 121))),
    ('a blank title', '''N'',''other'','' '',''B'''), ('a title of 201', format('''N'',''other'',%L,''B''', repeat('x', 201))), ('an old type', '''N'',''Offer'',''T'',''B'''),
    ('no type', '''N'',null,''T'',''B'''), ('a body of 10,001', format('''N'',''other'',''T'',%L', repeat('x', 10001)))) c(lbl, q)
  loop
    fails := fails || pg_temp.x(adm, 'a template with ' || lbl, format('hr_save_letter_template(%L,null,%s)', org, q), 'LETTER_BAD_INPUT')
      || pg_temp.x(adm, 'a template changed to ' || lbl, format('hr_save_letter_template(%L,%L,%s)', org, tp, q), 'LETTER_BAD_INPUT');
  end loop;
  insert into public.hr_letter_templates (org_id, name, letter_type, title, body) values (org, 'Fill', 'other', '{employee_name} / {today}',
    'No {employee_no}; {designation} in {department}; joined {join_date}; at {company_name}; {salary} {Today} {employee_name}') returning id into tf;
  q := 'No %s; %s in %s; joined %s; at Docs Check Sdn Bhd; {salary} {Today} %s';
  fails := fails || pg_temp.v('each new workspace was given the starter set', format('select string_agg(c::text, ''/'') from (select count(distinct letter_type) c from public.hr_letter_templates where org_id in (%L, %L) and id <> %L group by org_id) s', org, oth, tf), '6/6')
    || pg_temp.x(adm, 'a name already used, in other capitals', format('hr_save_letter_template(%L,null,'' general LETTER '',''other'',''T'',''B'')', org), 'LETTER_TEMPLATE_EXISTS')
    || pg_temp.x(adm, 'a template renamed onto another', format('hr_save_letter_template(%L,%L,''warning'',''other'',''T'',''B'')', org, tp), 'LETTER_TEMPLATE_EXISTS')
    || pg_temp.x(adm, 'a template renamed in its own capitals', format('hr_save_letter_template(%L,%L,''GENERAL letter'',''other'',''T'',%L) ->> ''name''', org, tp, repeat('x', 10000)), '="GENERAL letter"')
    || pg_temp.x(adm, 'every placeholder filled from A''s record', format('hr_start_letter_from_template(%L,%L) #- ''{letter,id}''', ea, tf),
      format('={"letter":%s,"unfilled":[]}', format(letj, ea, 'other', 'Member A / ' || to_char(d, 'FMDD FMMonth YYYY'), format(q, 'A1', 'Engineer', 'Sales', '5 March 2020', 'Member A'), 'draft', 'null', 'false')))
    || pg_temp.x(adm, 'what B''s record lacks is left as it was', format('hr_start_letter_from_template(%L,%L) #- ''{letter,id}''', eb, tf),
      format('={"letter":%s,"unfilled":["designation","department","join_date"]}', format(letj, eb, 'other', 'Member B / ' || to_char(d, 'FMDD FMMonth YYYY'), format(q, 'B', '{designation}', '{department}', '{join_date}', 'Member B'), 'draft', 'null', 'false')))
;
  select a.id into g from public.hr_letters a where a.employee_id = eb;
  fails := fails || pg_temp.x(adm, 'and that draft cannot be issued', format('hr_issue_letter(%L)', g), 'LETTER_PLACEHOLDER')
    || pg_temp.v('each draft remembers its template', format('select count(*) from public.hr_letters where template_id = %L and status = ''draft''', tf), '2');
  -- A value is never read for placeholders of its own.
  update public.hr_employees set name = '{company_name}', designation = '{today}' where id = eb;
  fails := fails || pg_temp.x(adm, 'a record that holds braces fills as plain text', format('hr_start_letter_from_template(%L,%L) #- ''{letter,id}'' #- ''{letter,title}''', eb, tf),
      format('={"letter":%s,"unfilled":["department","join_date"]}', format(letj, eb, 'other', '-', format(q, 'B', '{today}', '{department}', '{join_date}', '{company_name}'), 'draft', 'null', 'false')::jsonb - 'title'));
  insert into public.hr_letter_templates (org_id, name, letter_type, title) select org, 'Planted ' || s, 'other', 'T' from generate_series(1, 43) s;
  fails := fails || pg_temp.x(adm, 'the 51st template', format('hr_save_letter_template(%L,null,''One more'',''other'',''T'',''B'')', org), 'LETTER_TOO_MANY_TEMPLATES')
    || pg_temp.x(adm, 'one of 50 changed', format('hr_save_letter_template(%L,%L,''Fill'',''offer'',''T'',''B'')', org, tf), null)
    || pg_temp.x(own, 'the other workspace still adds its own', format('hr_save_letter_template(%L,null,''One more'',''other'',''T'',''B'')', oth), null)
    || pg_temp.x(adm, 'the admin reads the 50', format('(select count(*) from hr_letter_templates where org_id = %L)', org), '=50');
  for who, lbl in select * from (values (ma, 'a member'), (mv, 'a viewer'), (outs, 'another workspace''s owner'), (mfa, 'an admin who owes a second factor'), (null::uuid, 'nobody')) c(who, lbl) loop
    fails := fails || pg_temp.x(who, lbl || ' reads no template, document or letter of someone else',
      format('(select (select count(*) from hr_letter_templates where org_id = %1$L) + (select count(*) from hr_documents where org_id = %1$L and employee_id <> %2$L) + (select count(*) from hr_letters where org_id = %1$L and employee_id <> %2$L))', org, ea), '=0');
  end loop;
  fails := fails || pg_temp.x(ma, 'A reads their own documents', format('(select count(*) > 3 from hr_documents where org_id = %L)', org), '=true')
    || pg_temp.x(mb, 'B reads their own document and no letter: all three are drafts', format('(select (select count(*) from hr_documents where org_id = %1$L) || ''/'' || (select count(*) from hr_letters where org_id = %1$L))', org), '="1/0"');

  -- 7. the sweep, and deleting an employee
  fo := pg_temp.up(org, ea, 'pdf', '2 days');
  fa := pg_temp.up(oth, eo, 'pdf', '2 days');
  insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type) values (org, ea, 'Old and attached', 'other', pg_temp.up(org, ea, 'pdf', '2 days'), 'a.pdf', 10, 'application/pdf');
  f4 := pg_temp.up(org, ea, 'pdf', '3 days');
  q := format('(select coalesce(jsonb_agg(f order by f), ''[]'') from %%s(%L%%s) f)', org);
  want := (select jsonb_agg(f order by f) from unnest(array[fo, f4]) f)::text;
  fails := fails || pg_temp.x(adm, 'the admin lists for the sweep', format(q, 'hr_orphaned_document_files', ''), 'permission denied for function hr_orphaned_document_files')
    || pg_temp.x(adm, 'the admin releases for the sweep', format(q, 'hr_release_orphaned_document_files', ''), 'permission denied for function hr_release_orphaned_document_files')
    || pg_temp.x(ma, 'a signed-out visitor lists for the sweep', format(q, 'hr_orphaned_document_files', ''), 'permission denied for function hr_orphaned_document_files', 'aal1', 'anon')
    || pg_temp.x(ma, 'a signed-out visitor releases for the sweep', format(q, 'hr_release_orphaned_document_files', ''), 'permission denied for function hr_release_orphaned_document_files', 'aal1', 'anon')
    || pg_temp.x(null, 'the service role lists the two old files on no document', format(q, 'hr_orphaned_document_files', ''), '=' || want, 'aal1', 'service_role')
    || pg_temp.v('listing released nothing', format('select count(*) from private.hr_released_documents where path in (%L, %L)', fo, f4), '0')
    || pg_temp.x(adm, 'a listed file is attached after all', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf || ' ? ''id''', ea, f4), '=true')
    || pg_temp.x(null, 'the service role releases none when told none', format(q, 'hr_release_orphaned_document_files', ',0'), '=[]', 'aal1', 'service_role')
    || pg_temp.x(null, 'the service role releases the one left', format(q, 'hr_release_orphaned_document_files', ',1'), format('=["%s"]', fo), 'aal1', 'service_role')
    || pg_temp.x(null, 'and is handed it again on a second try', format(q, 'hr_release_orphaned_document_files', ''), format('=["%s"]', fo), 'aal1', 'service_role')
    || pg_temp.v('what the sweep released', format('select string_agg(path, '','') from private.hr_released_documents where path in (%L, %L, %L)', fo, f4, fa), fo)
    || pg_temp.x(adm, 'a released file is attached after all', format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, ea, fo), 'DOC_BAD_FILE')
    || pg_temp.x(null, 'the service role releases the old file of a folder with no workspace behind it', format('(select count(*) from hr_release_orphaned_document_files(%L))', split_part(pg_temp.up(gen_random_uuid(), gen_random_uuid(), 'pdf', '2 days'), '/', 1)), '=1', 'aal1', 'service_role')
    || pg_temp.x(null, 'the service role reads no document', '(select count(*) from public.hr_documents)', 'permission denied for table hr_documents', 'aal1', 'service_role');
  fa := pg_temp.up(org, ex); fb := pg_temp.up(org, ex); fp := pg_temp.up(org, ep);
  insert into public.hr_documents (org_id, employee_id, title, doc_type, file_path, file_name, file_size, file_type) values (org, ex, 'One', 'other', fa, 'a.pdf', 10, 'application/pdf'), (org, ex, 'Two', 'other', fb, 'a.pdf', 10, 'application/pdf'), (org, ep, 'Kept', 'other', fp, 'a.pdf', 10, 'application/pdf');
  insert into public.hr_documents (org_id, employee_id, title, doc_type) values (org, ex, 'No file', 'other');
  insert into public.hr_payroll_runs (id, org_id, period_month, status, paid_at) values (run, org, '2025-01-01', 'paid', now());
  insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month, basic_cents, gross_cents, status) values (org, ep, run, '2025-01-01', 1, 1, 'paid');
  fails := fails || pg_temp.x(adm, 'the admin deletes an employee', format('hr_delete_employee(%L,%L)', org, ex),
      format('={"id":"%s","name":"Leaver","document_paths":%s}', ex, (select jsonb_agg(p order by p) from unnest(array[fa, fb]) p)))
    || pg_temp.v('their documents went, and their files are released', format('select (select count(*) from public.hr_documents where employee_id = %L) || ''/'' || (select count(*) from private.hr_released_documents where path in (%L, %L))', ex, fa, fb), '0/2')
    || pg_temp.x(own, 'the owner deletes one with 200 documents, one of them a file', format('jsonb_array_length(hr_delete_employee(%L,%L) -> ''document_paths'')', org, ec), '=1')
    || pg_temp.x(own, 'the owner deletes one with a paid payslip', format('hr_delete_employee(%L,%L)', org, ep), 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS')
    || pg_temp.v('who is still there, the file not released', format('select (select count(*) from public.hr_documents where employee_id = %L) || ''/'' || (select count(*) from private.hr_released_documents where path = %L)', ep, fp), '1/0')
    -- No way around the function: a direct delete is refused for the owner and the admin alike, and nobody went.
    || pg_temp.d(adm, 'the admin deletes an employee directly, not through the function', format('delete from public.hr_employees where id = %L', eb), 'denied')
    || pg_temp.d(own, 'the owner deletes an employee directly, not through the function', format('delete from public.hr_employees where id = %L', eb), 'denied')
    || pg_temp.d(own, 'the owner deletes every employee directly', 'delete from public.hr_employees', 'denied')
    || pg_temp.v('who is left after the direct deletes', format('select count(*) from public.hr_employees where id in (%L, %L)', eb, ep), '2')
    || pg_temp.x(own, 'the owner deletes that employee through the function', format('hr_delete_employee(%L,%L) ->> ''id''', org, eb), format('="%s"', eb))
    || pg_temp.v('who then is gone', format('select count(*) from public.hr_employees where id = %L', eb), '0');

  -- 8. no direct writes, for anyone
  foreach t in array tabs || array['hr_released_documents'] loop
    q := case when t = 'hr_released_documents' then 'private.' else 'public.' end || t;
    foreach lbl in array array[format('insert into %s default values', q), format('update %s set %2$s = %2$s', q, case when t = 'hr_released_documents' then 'path' else 'id' end), format('delete from %s', q)] loop
      fails := fails || pg_temp.d(own, 'someone signed in ran: ' || lbl, lbl, 'denied') || pg_temp.d(own, 'a signed-out visitor ran: ' || lbl, lbl, 'denied', 'anon');
    end loop;
  end loop;

  -- 9. the demo: read by its members, changed by nobody
  snap := pg_temp.snap(demo);
  for who, lbl in select * from (values (dv, 'a demo visitor'), (da, 'a demo admin'), (own, 'someone outside the demo')) c(who, lbl) loop
    for q, want in select * from (values
      (format('hr_add_document(%L,''T'',''other'',null,%L' || pdf, de, pg_temp.up(demo, de)), 'DOC_NOT_ALLOWED'),
      (format('hr_release_document_file(%L)', pg_temp.up(demo, de)), '=false'),
      (format('coalesce(hr_delete_employee(%L,%L),''"no"'')', demo, md5('rimba-emp-16')::uuid), '="no"'),
      (format('hr_save_letter(%L,null,''other'',''T'',''B'',false)', de), 'LETTER_NOT_ALLOWED'),
      (format('hr_start_letter_from_template(%L,%L)', de, dt), 'LETTER_NOT_ALLOWED'),
      (format('hr_save_letter_template(%L,null,''N'',''other'',''T'',''B'')', demo), 'LETTER_NOT_ALLOWED'),
      (format('hr_update_document(%L,''T'',''other'',null)', dd), 'DOC_NOT_FOUND'),
      (format('hr_replace_document_file(%L,%L' || pdf, dd, pg_temp.up(demo, de)), 'DOC_NOT_FOUND'),
      (format('hr_remove_document(%L)', dd), 'DOC_NOT_FOUND'),
      (format('hr_request_document_ack(%L,false)', dd), 'DOC_NOT_FOUND'),
      (format('hr_acknowledge_document(%L)', dd), 'DOC_NOT_FOUND'),
      (format('hr_issue_letter(%L)', dl), 'LETTER_NOT_FOUND'),
      (format('hr_delete_letter(%L)', dl), 'LETTER_NOT_FOUND'),
      (format('hr_unissue_letter(%L)', di), 'LETTER_NOT_FOUND'),
      (format('hr_acknowledge_letter(%L)', di), 'LETTER_NOT_FOUND'),
      (format('hr_save_letter_template(%L,%L,''N'',''other'',''T'',''B'')', demo, dt), 'LETTER_NOT_FOUND'),
      (format('hr_delete_letter_template(%L)', dt), 'LETTER_NOT_FOUND')) c(q, want)
    loop
      fails := fails || pg_temp.x(who, lbl || ', in the demo: ' || split_part(q, '(', 1), q, case when who = own or left(want, 1) = '=' then want else split_part(want, '_', 1) || '_NOT_ALLOWED' end);
    end loop;
  end loop;
  fails := fails || pg_temp.v('a row was changed in the demo', format('select pg_temp.snap(%L)', demo), snap)
    || pg_temp.x(dv, 'a demo visitor reads every document, letter and template, drafts too', format('(select (select count(*) || ''/'' || count(file_path) from hr_documents where org_id = %1$L)'
      || ' || '' '' || (select count(*) || ''/'' || count(*) filter (where status = ''draft'') from hr_letters where org_id = %1$L) || '' '' || (select count(*) from hr_letter_templates where org_id = %1$L))', demo), '="24/0 5/2 6"')
    || pg_temp.x(ma, 'someone outside the demo reads none of them', format('(select (select count(*) from hr_documents where org_id = %1$L) + (select count(*) from hr_letters where org_id = %1$L) + (select count(*) from hr_letter_templates where org_id = %1$L))', demo), '=0')
    -- What the re-seed built: no placeholder payslip or letter, types the old app can label, letters with a body and no placeholder, an issued date exactly on the issued.
    || pg_temp.v('the demo''s documents', format($q$select count(*) filter (where a.doc_type in ('contract','tax','benefits') and a.status = 'available' and a.source = 'hr' and a.issued_on is not null)
        || '/' || count(*) filter (where a.ack_requested) || '/' || count(*) filter (where a.expires_on < %L) || '/' || count(*) filter (where a.expires_on between %L and %L) from public.hr_documents a where a.org_id = %L$q$, d, d, d + 90, demo), '24/1/1/1')
    || pg_temp.v('the demo''s letters', format($q$select count(*) filter (where length(a.body) > 80 and a.body !~ '\{[a-z_]+\}' and (a.status = 'issued') = (a.issued_on is not null))
        || '/' || count(distinct a.letter_type) || '/' || count(*) filter (where a.ack_requested and a.status = 'issued') from public.hr_letters a where a.org_id = %L$q$, demo), '5/5/1');

  -- 10. a workspace with all of this in it can still be deleted
  begin
    delete from public.orgs where id in (org, oth);
  exception when others then
    fails := fails || ('deleting a workspace failed: ' || sqlerrm);
  end;
  fails := fails || pg_temp.v('rows left behind by a deleted workspace', format('select (select count(*) from public.hr_documents where org_id = %1$L) + (select count(*) from public.hr_letters where org_id = %1$L)'
    || ' + (select count(*) from public.hr_letter_templates where org_id in (%1$L, %2$L))', org, oth), '0');
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    fails := fails || format('the check stopped early: %s (%s)', sqlerrm, split_part(ctx, E'\n', 1));
  end;
  raise exception 'PEOPLE_DOCUMENTS_CHECK %', case when cardinality(fails) > 0
    then format('FAILED (%s): %s%s', cardinality(fails), array_to_string(fails[1:15], '; '),
      case when cardinality(fails) > 15 then format('; ... and %s more', cardinality(fails) - 15) else '' end)
    else 'PASSED (everything rolled back)' end;
end $$;
