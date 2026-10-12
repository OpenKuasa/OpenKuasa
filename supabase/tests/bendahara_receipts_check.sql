-- Bendahara Receipts Inbox check. Run it after
-- 20261107100000_bendahara_receipts_inbox.sql, in the same transaction for a
-- dry run, or by itself once the migration is applied. It goes through the
-- storage rules of the finance-receipts bucket, recording a receipt, what a
-- model and a person write on it, tying it to an expense or a bill and
-- untying it, deleting it, and the clean-up functions, as an owner, an admin,
-- an editor, a viewer, an outsider, an anonymous member, an editor who owns
-- another workspace, and a session with no user. It also checks the fit to
-- the finance write guards: which columns a signed-in person may write, that
-- no existing finance function changed how it runs, and that numbering still
-- works afterwards. The cash book, banking, invoice and follow-on flows are
-- the business of the four other bendahara check scripts, which must still
-- pass beside this one. It leaves nothing behind
-- either way: the block always ends with RAISE, so every row, every stored
-- object row and the helper functions below are rolled back. Read the message:
--   BENDAHARA_RECEIPTS_CHECK PASSED ...   or   BENDAHARA_RECEIPTS_CHECK FAILED: <what went wrong>
-- A statement that should have worked and did not no longer ends the script
-- with its own bare error: the message is still FAILED, with every
-- expectation that had already failed, the section it stopped in and the error.
-- It makes its own workspaces and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims. A file
-- is "uploaded" by inserting its row into storage.objects, which is what the
-- storage service does on a person's behalf and what the bucket's rules judge.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  full_org uuid := gen_random_uuid();
  demo uuid;
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  mover_id uuid := gen_random_uuid();
  guest_id uuid := gen_random_uuid();
  full_owner uuid := gen_random_uuid();
  demo_member uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  editor_claims text;
  viewer_claims text;
  outsider_claims text;
  mover_claims text;
  guest_claims text;
  full_claims text;
  demo_claims text;
  jpg jsonb := '{"size": 204800, "mimetype": "image/jpeg"}';
  png jsonb := '{"size": 512000, "mimetype": "image/png"}';
  pdf jsonb := '{"size": 1048576, "mimetype": "application/pdf"}';
  heic jsonb := '{"size": 2097152, "mimetype": "image/heic"}';
  heif jsonb := '{"size": 3145728, "mimetype": "image/heif"}';
  f1 text;
  f2 text;
  f3 text;
  f4 text;
  f5 text;
  f6 text;
  f7 text;
  f8 text;
  f9 text;
  f10 text;
  f_webp text;
  f_owner text;
  f_theirs text;
  f_old text;
  f_liar text;
  f_bare text;
  f_orphan text;
  f_young text;
  f_held text;
  f_gone text;
  rent uuid;
  travel uuid;
  sales uuid;
  sup uuid;
  their_sup uuid;
  bill_posted uuid;
  bill_draft uuid;
  bill_void uuid;
  their_bill uuid;
  ex_pending uuid;
  ex_approved uuid;
  ex_made uuid;
  ex_owner uuid;
  r1 uuid;
  r2 uuid;
  r3 uuid;
  r4 uuid;
  r5 uuid;
  r6 uuid;
  r7 uuid;
  r8 uuid;
  r9 uuid;
  r10 uuid;
  bill_made uuid;
  r_owner uuid;
  r_seed uuid;
  r_held uuid;
  n integer;
  m integer;
  t text;
  b boolean;
  r record;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  notes text[] := '{}';
  stage text := 'set-up';
  as_auth boolean := true;
  f_other text;
begin
  begin
  -- ---- helpers, rolled back with everything else --------------------------
  stage := 'helpers, rolled back with everything else';
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
  execute $f$
    create function public.bendahara_receipts_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  -- "Uploads" a file as whoever is acting: null when the bucket's rules
  -- answered as expected, or a sentence for the report.
  execute $f$
    create function public.bendahara_receipts_upload(label text, want boolean, path text, meta jsonb) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      begin
        insert into storage.objects (bucket_id, name, owner, metadata)
        values ('finance-receipts', path, auth.uid(), meta);
      exception
        when insufficient_privilege then
          if want then return label || ': refused'; end if;
          return null;
        when others then
          return format('%s: stopped for another reason: %s', label, sqlerrm);
      end;
      if not want then return label || ': went through'; end if;
      return null;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_receipts_try(text, text, text) to authenticated, service_role';
  execute 'grant execute on function public.bendahara_receipts_upload(text, boolean, text, jsonb) to authenticated';

  -- ---- structure ------------------------------------------------------------
  stage := 'structure';
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'finance_receipts';
  if n <> 5 then fails := fails || format('expected 5 policies on finance_receipts, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_receipts' and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 1 then fails := array_append(fails, 'finance_receipts has no restrictive mfa_required policy'); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where c.relrowsecurity
     and ((s.nspname = 'public' and c.relname = 'finance_receipts')
       or (s.nspname = 'private' and c.relname = 'finance_receipt_deletions'));
  if n <> 2 then fails := array_append(fails, 'row-level security is not enabled on finance_receipts and on the list of files to remove'); end if;
  select count(*) into n from pg_policies where schemaname = 'private' and tablename = 'finance_receipt_deletions';
  if n <> 0 then fails := array_append(fails, 'the list of files to remove has a policy: nobody should reach it'); end if;
  select string_agg(policyname || ':' || cmd || ':' || permissive, ',' order by policyname) into t from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname like 'finance_receipt_files_%';
  if t is distinct from 'finance_receipt_files_insert:INSERT:PERMISSIVE,finance_receipt_files_mfa_required:ALL:RESTRICTIVE,finance_receipt_files_select:SELECT:PERMISSIVE' then
    fails := fails || format('the bucket''s rules are: %s', t);
  end if;
  select count(*) into n from storage.buckets
   where id = 'finance-receipts' and public is false and file_size_limit = 10485760
     and allowed_mime_types = array['image/jpeg','image/png','application/pdf','image/heic','image/heif'];
  if n <> 1 then fails := array_append(fails, 'the finance-receipts bucket is not private, 10 MB, JPEG/PNG/PDF/HEIC/HEIF'); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'finance_receipt_inbox' and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 1 then fails := array_append(fails, 'finance_receipt_inbox is not a security_invoker view'); end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_receipt_inbox'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,file_name,mime_type,size_bytes,has_file,vendor,receipt_date,amount,sst_amount,status,'
       || 'expense_id,bill_id,document_kind,document_label,extraction_error,extracted_at,uploaded_by,created_at,updated_at' then
    fails := fails || format('finance_receipt_inbox has the columns: %s', t);
  end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_receipts'::regclass and contype = 'f' and confdeltype = 'n';
  if t is distinct from 'finance_receipts_bill_fkey,finance_receipts_expense_fkey,finance_receipts_uploaded_by_fkey' then
    fails := fails || format('the foreign keys that clear a column on delete are: %s', t);
  end if;
  foreach t in array array[
    'public.finance_register_receipt(uuid, jsonb)',
    'public.finance_set_receipt_extraction(uuid, uuid, jsonb)',
    'public.finance_review_receipt(uuid, uuid, jsonb)',
    'public.finance_attach_receipt(uuid, uuid, uuid, uuid)',
    'public.finance_detach_receipt(uuid, uuid)',
    'public.finance_receipt_to_expense(uuid, uuid, jsonb)',
    'public.finance_receipt_to_bill(uuid, uuid, jsonb, jsonb)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array[
    'public.finance_receipt_queue_orphans()',
    'public.finance_receipt_deletions_due(integer)',
    'public.finance_receipt_deletion_queued(text)',
    'public.finance_receipt_deletions_done(text[])'
  ] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('authenticated', t, 'execute') then
      fails := fails || format('a clean-up function can be called by a signed-in person: %s', t);
    end if;
    if not has_function_privilege('service_role', t, 'execute') then fails := fails || format('service_role cannot execute %s', t); end if;
  end loop;
  foreach t in array array['private.finance_receipt_guard()', 'private.finance_receipt_note_deletion()'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      fails := fails || format('a trigger function can be called directly: %s', t);
    end if;
  end loop;
  foreach t in array array['finance_receipts', 'finance_receipt_inbox'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then fails := fails || format('authenticated cannot read %s', t); end if;
    if has_table_privilege('service_role', 'public.' || t, 'select') then fails := fails || format('service_role was granted %s', t); end if;
  end loop;
  if has_table_privilege('service_role', 'public.finance_receipts', 'insert')
     or has_table_privilege('service_role', 'public.finance_receipts', 'update')
     or has_table_privilege('service_role', 'public.finance_receipts', 'delete') then
    fails := array_append(fails, 'service_role can write finance_receipts');
  end if;
  foreach t in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(t, 'private.finance_receipt_deletions', 'select')
       or has_table_privilege(t, 'private.finance_receipt_deletions', 'insert')
       or has_table_privilege(t, 'private.finance_receipt_deletions', 'delete') then
      fails := fails || format('%s can reach the list of files to remove', t);
    end if;
  end loop;
  -- The columns a signed-in person may write, exactly.
  select string_agg(a.attname, ',' order by a.attname) into t from pg_attribute a
   where a.attrelid = 'public.finance_receipts'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.finance_receipts', a.attname, 'insert');
  if t is distinct from 'file_name,file_path,org_id' then fails := fails || format('authenticated may insert: %s', t); end if;
  select string_agg(a.attname, ',' order by a.attname) into t from pg_attribute a
   where a.attrelid = 'public.finance_receipts'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.finance_receipts', a.attname, 'update');
  if t is distinct from 'amount,bill_id,expense_id,extracted_at,extraction_error,receipt_date,sst_amount,status,updated_at,vendor' then
    fails := fails || format('authenticated may update: %s', t);
  end if;
  if not has_table_privilege('authenticated', 'public.finance_receipts', 'delete') then
    fails := array_append(fails, 'authenticated cannot delete a receipt');
  end if;
  select count(*) into n from pg_attribute a
   where a.attrelid = 'public.finance_receipts'::regclass and a.attnum > 0 and not a.attisdropped
     and (has_column_privilege('service_role', 'public.finance_receipts', a.attname, 'select')
       or has_column_privilege('service_role', 'public.finance_receipts', a.attname, 'insert')
       or has_column_privilege('service_role', 'public.finance_receipts', a.attname, 'update')
       or has_column_privilege('anon', 'public.finance_receipts', a.attname, 'select'));
  if n <> 0 then fails := fails || format('service_role or anon has a right on %s columns of finance_receipts', n); end if;
  -- Nothing but the four clean-up functions answers to the server's role.
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname in ('public', 'private')
     and p.proname in ('finance_register_receipt','finance_set_receipt_extraction','finance_review_receipt','finance_attach_receipt',
       'finance_detach_receipt','finance_receipt_to_expense','finance_receipt_to_bill','finance_receipt_queue_orphans',
       'finance_receipt_deletions_due','finance_receipt_deletion_queued','finance_receipt_deletions_done','finance_receipt_room',
       'finance_receipt_file','finance_receipt_type','finance_receipt_guard','finance_receipt_note_deletion')
     and has_function_privilege('service_role', p.oid, 'execute');
  if t is distinct from 'finance_receipt_deletion_queued,finance_receipt_deletions_done,finance_receipt_deletions_due,finance_receipt_queue_orphans' then
    fails := fails || format('service_role may execute: %s', t);
  end if;
  -- The numbering function is the write guards': run as its owner, closed to the server's role.
  select count(*) into n from pg_proc p
   where p.oid = 'public.finance_next_number(uuid, text)'::regprocedure and p.prosecdef
     and p.proconfig = array['search_path=""'] and not has_function_privilege('anon', p.oid, 'execute')
     and has_function_privilege('authenticated', p.oid, 'execute');
  if n <> 1 then fails := array_append(fails, 'finance_next_number is not the definer function the write guards left'); end if;
  -- The two restrictive second-factor rules say what they are for, and a file is one receipt's.
  select count(*) into n from pg_policies
   where (schemaname, tablename, policyname) in (('storage','objects','finance_receipt_files_mfa_required'), ('public','finance_receipts','mfa_required'))
     and permissive = 'RESTRICTIVE' and qual like '%private.mfa_ok()%' and with_check like '%private.mfa_ok()%';
  if n <> 2 then fails := array_append(fails, 'a restrictive second-factor rule does not ask mfa_ok'); end if;
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'finance_receipts_file_path_key' and indexdef like 'CREATE UNIQUE INDEX%';
  if n <> 1 then fails := array_append(fails, 'file_path is not unique'); end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.finance_receipts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%NaN%';
  if n <> 2 then fails := fails || format('%s check constraints refuse NaN, expected 2 (amount and sst_amount)', n); end if;
  select count(*) into n from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_receipts'::regclass
     and tgname in ('finance_receipt_guard', 'finance_receipt_file_released');
  if n <> 2 then fails := fails || format('expected 2 triggers on finance_receipts, found %s', n); end if;

  -- ---- people and three workspaces ------------------------------------------
  stage := 'people and three workspaces';
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@receipts-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, editor_id, viewer_id, outsider, mover_id, guest_id, full_owner, demo_member]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name)
  values (org, 'Receipts Check Sdn Bhd'), (other_org, 'Receipts Other Sdn Bhd'), (full_org, 'Receipts Full Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'),
         -- An account that never signed up, let in as an editor: it may write rows and may not upload.
         (org, guest_id, 'member'),
         (other_org, outsider, 'owner'),
         -- An editor here who owns the other workspace: what they may decide there, they may not decide here.
         (other_org, mover_id, 'owner'), (org, mover_id, 'member'),
         (full_org, full_owner, 'owner');
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null then
    notes := array_append(notes, 'there is no demo workspace here, so "an editor of the demo cannot upload" was not asked');
  else
    insert into public.org_members (org_id, user_id, role) values (demo, demo_member, 'member');
  end if;
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' and name = 'Rent';
  select id into travel from public.finance_categories where org_id = org and kind = 'expense' and name = 'Travel';
  select id into sales from public.finance_categories where org_id = org and kind = 'income' and name = 'Sales';
  if rent is null or travel is null or sales is null then
    raise exception 'BENDAHARA_RECEIPTS_CHECK cannot run: the new workspace has no categories';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2', 'is_anonymous', false)::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2', 'is_anonymous', false)::text;
  editor_claims := json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text;
  mover_claims := json_build_object('sub', mover_id, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text;
  guest_claims := json_build_object('sub', guest_id, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', true)::text;
  full_claims := json_build_object('sub', full_owner, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text;
  demo_claims := json_build_object('sub', demo_member, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', false)::text;

  f1 := org || '/' || gen_random_uuid() || '.jpg';
  f2 := org || '/' || gen_random_uuid() || '.png';
  f3 := org || '/' || gen_random_uuid() || '.pdf';
  f4 := org || '/' || gen_random_uuid() || '.jpg';
  f5 := org || '/' || gen_random_uuid() || '.jpg';
  f6 := org || '/' || gen_random_uuid() || '.jpg';
  f7 := org || '/' || gen_random_uuid() || '.jpg';
  f8 := org || '/' || gen_random_uuid() || '.heic';
  f9 := org || '/' || gen_random_uuid() || '.heif';
  f10 := org || '/' || gen_random_uuid() || '.jpg';
  f_webp := org || '/' || gen_random_uuid() || '.webp';
  f_owner := org || '/' || gen_random_uuid() || '.pdf';
  f_theirs := other_org || '/' || gen_random_uuid() || '.jpg';
  f_old := org || '/' || gen_random_uuid() || '.jpg';
  f_liar := org || '/' || gen_random_uuid() || '.png';
  f_bare := org || '/' || gen_random_uuid() || '.pdf';
  f_orphan := org || '/' || gen_random_uuid() || '.jpg';
  f_young := org || '/' || gen_random_uuid() || '.jpg';
  f_held := org || '/' || gen_random_uuid() || '.jpg';

  -- ==== the bucket: who may upload, and where ==================================
  stage := 'the bucket: who may upload, and where';
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('an editor uploads a JPEG into the workspace''s folder', true, f1, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a PNG', true, f2, png);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a PDF', true, f3, pdf);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a fourth file', true, f4, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a fifth file', true, f5, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a sixth file', true, f6, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a seventh file', true, f7, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a phone''s HEIC', true, f8, heic);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a HEIF', true, f9, heif);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a tenth file', true, f10, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a file ending .HEIC in capitals', false,
    org || '/' || gen_random_uuid() || '.HEIC', heic);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a PNG that storage was told is a JPEG', true, f_liar, jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a file storage knows nothing more about', true, f_bare, null);
  fails := fails || public.bendahara_receipts_upload('an editor uploads into another workspace''s folder', false,
    other_org || '/' || gen_random_uuid() || '.jpg', jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a file outside any folder', false, gen_random_uuid() || '.jpg', jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads into a folder inside the workspace''s', false,
    org || '/sub/' || gen_random_uuid() || '.jpg', jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads under the file''s own name', false, org || '/receipt.jpg', jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a WebP', false, org || '/' || gen_random_uuid() || '.webp', jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads a file with two extensions', false,
    org || '/' || gen_random_uuid() || '.jpg.exe', jpg);
  fails := fails || public.bendahara_receipts_upload('an editor uploads into a folder that is not a workspace', false,
    'not-a-workspace/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('an owner uploads', true, f_owner, pdf);
  reset role;
  perform set_config('request.jwt.claims', admin_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('an admin uploads', true, org || '/' || gen_random_uuid() || '.png', png);
  reset role;
  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('a viewer uploads', false, org || '/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('someone from another workspace uploads here', false,
    org || '/' || gen_random_uuid() || '.jpg', jpg);
  fails := fails || public.bendahara_receipts_upload('they upload into their own workspace''s folder', true, f_theirs, jpg);
  reset role;
  perform set_config('request.jwt.claims', guest_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('an anonymous editor uploads', false, org || '/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('a session with no user uploads', false, org || '/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  if demo is not null then
    perform set_config('request.jwt.claims', demo_claims, true);
    set local role authenticated;
    fails := fails || public.bendahara_receipts_upload('an editor of the demo workspace uploads into it', false,
      demo || '/' || gen_random_uuid() || '.jpg', jpg);
    reset role;
  end if;

  -- A session that owes a second factor gets nothing: no upload, no file, no row.
  insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), editor_id, 'totp', 'verified', now(), now());
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('an editor who owes a second factor uploads', false,
    org || '/' || gen_random_uuid() || '.jpg', jpg);
  select count(*) into n from storage.objects o where o.bucket_id = 'finance-receipts' and o.name = f1;
  if n <> 0 then fails := array_append(fails, 'an editor who owes a second factor sees a receipt file'); end if;
  reset role;
  delete from auth.mfa_factors where user_id = editor_id;

  -- ---- who reads a file, and that nobody changes or removes one -----------
  stage := 'who reads a file, and that nobody changes or removes one';
  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  select count(*) into n from storage.objects o where o.bucket_id = 'finance-receipts' and o.name in (f1, f_owner);
  if n <> 2 then fails := fails || format('a viewer sees %s of the workspace''s 2 named files', n); end if;
  select count(*) into n from storage.objects o where o.bucket_id = 'finance-receipts' and o.name = f_theirs;
  if n <> 0 then fails := array_append(fails, 'a viewer sees another workspace''s file'); end if;
  reset role;
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  select count(*) into n from storage.objects o where o.bucket_id = 'finance-receipts' and o.name like org || '/%';
  if n <> 0 then fails := fails || format('someone from another workspace sees %s of this one''s files', n); end if;
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  begin
    update storage.objects set name = org || '/' || gen_random_uuid() || '.jpg' where bucket_id = 'finance-receipts' and name = f1;
    get diagnostics n = row_count;
    if n <> 0 then fails := array_append(fails, 'an owner renamed a receipt file'); end if;
  exception when others then null;  -- refused outright is as good
  end;
  begin
    delete from storage.objects where bucket_id = 'finance-receipts' and name = f1;
    get diagnostics n = row_count;
    if n <> 0 then fails := array_append(fails, 'an owner deleted a receipt file'); end if;
  exception when others then null;
  end;
  reset role;

  -- ---- files made the way only this script can: with a time of their own ----
  stage := 'files made the way only this script can: with a time of their own';
  perform set_config('request.jwt.claims', '{}', true);
  insert into storage.objects (bucket_id, name, owner, metadata, created_at) values
    ('finance-receipts', f_old, editor_id, jpg, now() - interval '31 minutes'),
    ('finance-receipts', f_orphan, editor_id, jpg, now() - interval '61 minutes'),
    ('finance-receipts', f_young, editor_id, jpg, now() - interval '59 minutes'),
    ('finance-receipts', f_held, editor_id, jpg, now() - interval '3 hours'),
    -- A file the upload rule would never let in, put there as only the owner of the table can.
    ('finance-receipts', f_webp, editor_id, '{"size": 1000, "mimetype": "image/webp"}', now());

  -- ==== as the owner: what a receipt can be tied to ============================
  stage := 'as the owner: what a receipt can be tied to';
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;
  bill_posted := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill_posted);
  bill_draft := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  bill_void := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill_void);
  update public.supplier_bills set status = 'void' where id = bill_void;
  -- An owner's expense is approved as it is saved.
  ex_approved := public.finance_save_expense(org, jsonb_build_object(
    'expense_date', current_date, 'category_id', rent, 'vendor_name', 'Check Landlord', 'amount', 1500));
  reset role;
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_supplier) values (other_org, 'Their Supplier', true) returning id into their_sup;
  their_bill := public.finance_save_bill(other_org,
    jsonb_build_object('supplier_id', their_sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  reset role;

  -- ==== recording a receipt, as the editor =====================================
  stage := 'recording a receipt, as the editor';
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  ex_pending := public.finance_save_expense(org, jsonb_build_object(
    'expense_date', current_date, 'category_id', travel, 'vendor_name', 'Check Taxi', 'amount', 36));

  r1 := public.finance_register_receipt(org, jsonb_build_object('path', f1, 'name', 'IMG_0042.JPG'));
  select * into r from public.finance_receipt_inbox where id = r1;
  if (r.org_id, r.file_name, r.mime_type, r.size_bytes, r.has_file, r.status, r.uploaded_by)
     is distinct from (org, 'IMG_0042.JPG', 'image/jpeg', 204800::bigint, true, 'review', editor_id)
     or num_nonnulls(r.vendor, r.receipt_date, r.amount, r.sst_amount, r.expense_id, r.bill_id,
                     r.document_kind, r.document_label, r.extraction_error) <> 0 then
    fails := fails || format('a receipt recorded by an editor reads as %s', row_to_json(r));
  end if;
  r2 := public.finance_register_receipt(org, jsonb_build_object('path', f2, 'name', 'resit kedai.png'));
  r3 := public.finance_register_receipt(org, jsonb_build_object('path', f3, 'name', 'invois.pdf'));
  r4 := public.finance_register_receipt(org, jsonb_build_object('path', f4, 'name', 'four.jpg'));
  r5 := public.finance_register_receipt(org, jsonb_build_object('path', f5, 'name', 'five.jpg'));
  r6 := public.finance_register_receipt(org, jsonb_build_object('path', f6, 'name', 'six.jpg'));
  fails := fails || public.bendahara_receipts_try('an editor records a phone''s HEIC', 'ok',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f8, 'name', 'IMG_1001.HEIC')));
  fails := fails || public.bendahara_receipts_try('an editor records a HEIF', 'ok',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f9, 'name', 'IMG_1002.heif')));
  select id into r8 from public.finance_receipts where file_path = f8;
  select id into r9 from public.finance_receipts where file_path = f9;
  select string_agg(mime_type || '/' || size_bytes, ',' order by mime_type) into t
    from public.finance_receipts where id in (r2, r3, r8, r9);
  if t is distinct from 'application/pdf/1048576,image/heic/2097152,image/heif/3145728,image/png/512000' then
    fails := fails || format('a PNG, a PDF, a HEIC and a HEIF were recorded as %s', t);
  end if;
  -- Storage said nothing about the file: it is still a receipt, of the type its name says, with no size.
  r7 := public.finance_register_receipt(org, jsonb_build_object('path', f_bare, 'name', 'bare.pdf'));
  select mime_type || '/' || coalesce(size_bytes::text, 'no size') into t from public.finance_receipts where id = r7;
  if t is distinct from 'application/pdf/no size' then fails := fails || format('a file storage says nothing about was recorded as %s', t); end if;
  fails := fails || public.bendahara_receipts_try('an editor deletes a receipt that is tied to nothing', 'ok',
    format('delete from public.finance_receipts where id = %L', r7));

  -- ---- what recording refuses ------------------------------------------------
  stage := 'what recording refuses';
  fails := fails || public.bendahara_receipts_try('the same file is recorded twice', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f1, 'name', 'again.jpg')));
  fails := fails || public.bendahara_receipts_try('a file that was never uploaded is recorded', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org,
      jsonb_build_object('path', org || '/' || gen_random_uuid() || '.jpg', 'name', 'ghost.jpg')));
  fails := fails || public.bendahara_receipts_try('a file uploaded 31 minutes ago is recorded', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f_old, 'name', 'old.jpg')));
  fails := fails || public.bendahara_receipts_try('a PNG that storage holds as a JPEG is recorded', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f_liar, 'name', 'liar.png')));
  fails := fails || public.bendahara_receipts_try('a receipt is recorded with no file', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('name', 'nothing.jpg')));
  fails := fails || public.bendahara_receipts_try('a receipt is recorded for a path that is not a receipt''s', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', '../../etc/passwd', 'name', 'x.jpg')));
  fails := fails || public.bendahara_receipts_try('a receipt is inserted by hand with no file', 'FIN24',
    format('insert into public.finance_receipts (org_id, file_name) values (%L, %L)', org, 'x.jpg'));
  fails := fails || public.bendahara_receipts_try('another workspace''s file is recorded here', '23514',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f_theirs, 'name', 'theirs.jpg')));
  fails := fails || public.bendahara_receipts_try('a receipt is recorded in a workspace the editor is not in', '42501',
    format('select public.finance_register_receipt(%L, %L)', other_org, jsonb_build_object('path', f_theirs, 'name', 'theirs.jpg')));
  fails := fails || public.bendahara_receipts_try('a receipt''s name has a slash in it', '23514',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f7, 'name', 'a/b.jpg')));
  fails := fails || public.bendahara_receipts_try('a receipt''s name has a line break in it', '23514',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f7, 'name', E'a\nb.jpg')));
  fails := fails || public.bendahara_receipts_try('a receipt''s name is 201 characters', '23514',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f7, 'name', repeat('a', 201))));
  fails := fails || public.bendahara_receipts_try('a receipt has no name', '23502',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f7)));
  -- A signed-in person may insert a workspace, a path and a name. Anything else named is refused by the grants.
  fails := fails || public.bendahara_receipts_try('a receipt is inserted with a type of the caller''s choosing', '42501',
    format('insert into public.finance_receipts (org_id, file_path, file_name, mime_type) values (%L, %L, %L, %L)', org, f7, 'x.jpg', 'application/pdf'));
  fails := fails || public.bendahara_receipts_try('a receipt is inserted in another''s name', '42501',
    format('insert into public.finance_receipts (org_id, file_path, file_name, uploaded_by) values (%L, %L, %L, %L)', org, f7, 'x.jpg', owner_id));
  fails := fails || public.bendahara_receipts_try('a receipt is inserted with a size of the caller''s choosing', '42501',
    format('insert into public.finance_receipts (org_id, file_path, file_name, size_bytes) values (%L, %L, %L, 1)', org, f7, 'x.jpg'));
  fails := fails || public.bendahara_receipts_try('a receipt is inserted with an id of the caller''s choosing', '42501',
    format('insert into public.finance_receipts (id, org_id, file_path, file_name) values (%L, %L, %L, %L)', gen_random_uuid(), org, f7, 'x.jpg'));
  fails := fails || public.bendahara_receipts_try('a receipt is inserted already matched', '42501',
    format('insert into public.finance_receipts (org_id, file_path, file_name, mime_type, status, expense_id) values (%L, %L, %L, %L, %L, %L)',
      org, f7, 'x.jpg', 'image/jpeg', 'matched', ex_pending));
  fails := fails || public.bendahara_receipts_try('a receipt is inserted already reviewed', '42501',
    format('insert into public.finance_receipts (org_id, file_path, file_name, mime_type, status) values (%L, %L, %L, %L, %L)',
      org, f7, 'x.jpg', 'image/jpeg', 'unmatched'));
  -- By hand, with the three columns allowed: who, what type and what size are the database's to say.
  insert into public.finance_receipts (org_id, file_path, file_name) values (org, f7, 'seven.jpg') returning id into r7;
  select uploaded_by::text || '/' || mime_type || '/' || size_bytes || '/' || status into t
    from public.finance_receipts where id = r7;
  if t is distinct from editor_id::text || '/image/jpeg/204800/review' then
    fails := fails || format('a receipt inserted by hand reads %s', t);
  end if;
  reset role;

  -- ---- the guard's own rules, behind the grants -----------------------------
  stage := 'the guard''s own rules, behind the grants';
  -- A write that gets past the grants (a function that runs as its owner on a
  -- person's behalf, should one ever be written) still meets the guard: the
  -- editor is signed in, and the role is the owner's.
  fails := fails || public.bendahara_receipts_try('past the grants, a receipt is inserted already matched', 'FIN23',
    format('insert into public.finance_receipts (org_id, file_path, file_name, status, expense_id) values (%L, %L, %L, %L, %L)',
      org, f_young, 'x.jpg', 'matched', ex_pending));
  -- In another's name, as a PDF of 1 byte: who, what type and what size are still the database's to say.
  insert into public.finance_receipts (org_id, file_path, file_name, mime_type, size_bytes, uploaded_by, extraction_error)
  values (org, f10, 'ten.jpg', 'application/pdf', 1, owner_id, 'made up') returning id into r10;
  select uploaded_by::text || '/' || mime_type || '/' || size_bytes || '/' || coalesce(extraction_error, 'no error') into t
    from public.finance_receipts where id = r10;
  if t is distinct from editor_id::text || '/image/jpeg/204800/no error' then
    fails := fails || format('past the grants, a receipt inserted in another''s name reads %s', t);
  end if;
  delete from public.finance_receipts where id = r10;
  fails := fails || public.bendahara_receipts_try('past the grants, a file of a type that is not a receipt''s is recorded', 'FIN24',
    format('insert into public.finance_receipts (org_id, file_path, file_name, mime_type) values (%L, %L, %L, %L)', org, f_webp, 'x.webp', 'image/jpeg'));
  fails := fails || public.bendahara_receipts_try('past the grants, a file uploaded 59 minutes ago is recorded in another''s name', 'FIN24',
    format('insert into public.finance_receipts (org_id, file_path, file_name, mime_type, size_bytes, uploaded_by) values (%L, %L, %L, %L, 1, %L)',
      org, f_young, 'x.jpg', 'application/pdf', owner_id));
  fails := fails || public.bendahara_receipts_try('past the grants, a receipt''s name is changed', 'FIN23',
    format('update public.finance_receipts set file_name = %L where id = %L', 'other.jpg', r1));
  fails := fails || public.bendahara_receipts_try('past the grants, a receipt is pointed at another file', 'FIN23',
    format('update public.finance_receipts set file_path = %L where id = %L', f_young, r1));
  fails := fails || public.bendahara_receipts_try('past the grants, who uploaded a receipt is changed', 'FIN23',
    format('update public.finance_receipts set uploaded_by = %L where id = %L', owner_id, r1));
  fails := fails || public.bendahara_receipts_try('past the grants, a receipt''s type and size are changed', 'FIN23',
    format('update public.finance_receipts set mime_type = %L, size_bytes = 1 where id = %L', 'application/pdf', r1));
  fails := fails || public.bendahara_receipts_try('past the grants, a receipt is moved to another workspace', 'FIN23',
    format('update public.finance_receipts set org_id = %L where id = %L', other_org, r1));
  select uploaded_by::text || '/' || file_name || '/' || (org_id = org) into t from public.finance_receipts where id = r1;
  if t is distinct from editor_id::text || '/IMG_0042.JPG/true' then fails := fails || format('after those refusals the receipt reads %s', t); end if;

  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('a viewer records a receipt', '42501',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f_young, 'name', 'viewer.jpg')));
  select count(*) into n from public.finance_receipt_inbox where org_id = org;
  if n <> 9 then fails := fails || format('a viewer reads %s of the workspace''s 9 receipts', n); end if;
  reset role;
  -- An anonymous editor cannot upload, so the only file they could record is a colleague's.
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  select (select count(*) from public.finance_receipts where org_id = org)
       + (select count(*) from public.finance_receipt_inbox where org_id = org) into n;
  if n <> 0 then fails := fails || format('someone from another workspace reads %s receipt rows of this one', n); end if;
  fails := fails || public.bendahara_receipts_try('someone from another workspace records a receipt here', '42501',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f_young, 'name', 'outsider.jpg')));
  reset role;

  -- ==== what a model reads, and what a person reviews ==========================
  stage := 'what a model reads, and what a person reviews';
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  b := public.finance_set_receipt_extraction(org, r1, jsonb_build_object(
    'vendor', '  Shell Bangsar  ', 'receipt_date', current_date - 2, 'amount', 142.5, 'sst_amount', 8.07));
  select * into r from public.finance_receipts where id = r1;
  if b is not true or (r.vendor, r.receipt_date, r.amount, r.sst_amount, r.status)
     is distinct from ('Shell Bangsar', current_date - 2, 142.50, 8.07, 'review') or r.extraction_error is not null
     or r.extracted_at is null then
    fails := fails || format('what a model read was written as %s (answer %s)', row_to_json(r), b);
  end if;
  b := public.finance_set_receipt_extraction(org, r2, jsonb_build_object('error', 'The receipt could not be read.'));
  select * into r from public.finance_receipts where id = r2;
  if b is not true or r.status <> 'review' or r.extraction_error is distinct from 'The receipt could not be read.'
     or num_nonnulls(r.vendor, r.receipt_date, r.amount, r.sst_amount, r.extracted_at) <> 0 then
    fails := fails || format('a receipt that could not be read was written as %s', row_to_json(r));
  end if;
  -- A reading that fails after one that worked takes the "read" stamp away with the figures.
  b := public.finance_set_receipt_extraction(org, r8, jsonb_build_object('vendor', 'Petronas', 'amount', 60));
  b := public.finance_set_receipt_extraction(org, r8, jsonb_build_object('error', 'The receipt could not be read.'));
  select num_nonnulls(vendor, amount, extracted_at)::text || '/' || extraction_error into t from public.finance_receipts where id = r8;
  if t is distinct from '0/The receipt could not be read.' then fails := fails || format('a failed second reading left %s', t); end if;
  -- A person's review keeps the stamp of a reading that worked: it is a fact about the receipt.
  b := public.finance_set_receipt_extraction(org, r8, jsonb_build_object('vendor', 'Petronas', 'amount', 60));
  perform public.finance_review_receipt(org, r8, jsonb_build_object('vendor', 'Petronas Bangsar', 'amount', 60));
  select status || '/' || vendor || '/' || (extracted_at is not null) into t from public.finance_receipts where id = r8;
  if t is distinct from 'unmatched/Petronas Bangsar/true' then fails := fails || format('a read and reviewed receipt reads %s', t); end if;
  fails := fails || public.bendahara_receipts_try('a model reads more SST than the amount', '23514',
    format('select public.finance_set_receipt_extraction(%L, %L, %L)', org, r3, jsonb_build_object('amount', 10, 'sst_amount', 10.01)));
  fails := fails || public.bendahara_receipts_try('a model reads an amount of nothing', '23514',
    format('select public.finance_set_receipt_extraction(%L, %L, %L)', org, r3, jsonb_build_object('amount', 0)));
  -- NaN is a numeric, and greater than every number: it is refused by name, on both columns, by every route.
  fails := fails || public.bendahara_receipts_try('an amount that is not a number, typed straight into the row', '23514',
    format('update public.finance_receipts set amount = %L, sst_amount = %L where id = %L', 'NaN', 'NaN', r3));
  fails := fails || public.bendahara_receipts_try('SST that is not a number, on a row with no amount', '23514',
    format('update public.finance_receipts set amount = null, sst_amount = %L where id = %L', 'NaN', r3));
  fails := fails || public.bendahara_receipts_try('a person reviews a receipt with an amount and SST that are not numbers', '23514',
    format('select public.finance_review_receipt(%L, %L, %L)', org, r3, '{"amount":"NaN","sst_amount":"NaN"}'::jsonb));
  fails := fails || public.bendahara_receipts_try('a model reads an amount that is not a number', '23514',
    format('select public.finance_set_receipt_extraction(%L, %L, %L)', org, r3, '{"amount":"NaN"}'::jsonb));
  select count(*) into n from public.finance_receipts where org_id = org and (amount = 'NaN' or sst_amount = 'NaN');
  if n <> 0 then fails := fails || format('%s receipts hold an amount that is not a number', n); end if;
  fails := fails || public.bendahara_receipts_try('a model reads a vendor of 201 characters', '23514',
    format('select public.finance_set_receipt_extraction(%L, %L, %L)', org, r3, jsonb_build_object('vendor', repeat('v', 201))));

  perform public.finance_review_receipt(org, r2, jsonb_build_object(
    'vendor', 'Kedai Runcit', 'receipt_date', current_date - 1, 'amount', 123.4, 'sst_amount', 0));
  select * into r from public.finance_receipts where id = r2;
  if (r.vendor, r.receipt_date, r.amount, r.sst_amount, r.status)
     is distinct from ('Kedai Runcit', current_date - 1, 123.40, 0.00, 'unmatched') or r.extraction_error is not null then
    fails := fails || format('a reviewed receipt reads %s', row_to_json(r));
  end if;
  -- A person has reviewed it: what a model reads later is not written over it.
  b := public.finance_set_receipt_extraction(org, r2, jsonb_build_object('vendor', 'Machine', 'amount', 1));
  select vendor into t from public.finance_receipts where id = r2;
  if b is not false or t is distinct from 'Kedai Runcit' then
    fails := fails || format('a late reading overwrote a reviewed receipt (answer %s, vendor %s)', b, t);
  end if;
  -- Reviewed with nothing typed is still reviewed.
  perform public.finance_review_receipt(org, r3, '{}'::jsonb);
  select status || '/' || num_nonnulls(vendor, receipt_date, amount, sst_amount) into t from public.finance_receipts where id = r3;
  if t is distinct from 'unmatched/0' then fails := fails || format('a receipt reviewed with nothing typed reads %s', t); end if;
  fails := fails || public.bendahara_receipts_try('a receipt that is not there is reviewed', 'FIN11',
    format('select public.finance_review_receipt(%L, %L, %L)', org, gen_random_uuid(), '{}'::jsonb));
  -- Back to review by hand is allowed: nothing hangs on it.
  fails := fails || public.bendahara_receipts_try('a reviewed receipt is put back to review', 'ok',
    format('update public.finance_receipts set status = %L where id = %L', 'review', r3));
  fails := fails || public.bendahara_receipts_try('a receipt is called matched with no document', '23514',
    format('update public.finance_receipts set status = %L where id = %L', 'matched', r3));

  -- ---- what never changes -----------------------------------------------------
  stage := 'what never changes';
  -- For a signed-in person each of these is refused by the grants (42501) before
  -- the guard is asked; the guard's own answers are checked above.
  fails := fails || public.bendahara_receipts_try('a receipt''s name is changed', '42501',
    format('update public.finance_receipts set file_name = %L where id = %L', 'other.jpg', r1));
  fails := fails || public.bendahara_receipts_try('a receipt is pointed at another file', '42501',
    format('update public.finance_receipts set file_path = %L where id = %L', f_young, r1));
  fails := fails || public.bendahara_receipts_try('a receipt''s file is taken away', '42501',
    format('update public.finance_receipts set file_path = null where id = %L', r1));
  fails := fails || public.bendahara_receipts_try('a receipt''s type is changed', '42501',
    format('update public.finance_receipts set mime_type = %L where id = %L', 'application/pdf', r1));
  fails := fails || public.bendahara_receipts_try('a receipt''s size is changed', '42501',
    format('update public.finance_receipts set size_bytes = 1 where id = %L', r1));
  fails := fails || public.bendahara_receipts_try('who uploaded a receipt is changed', '42501',
    format('update public.finance_receipts set uploaded_by = %L where id = %L', owner_id, r1));
  fails := fails || public.bendahara_receipts_try('who uploaded a receipt is blanked', '42501',
    format('update public.finance_receipts set uploaded_by = null where id = %L', r1));
  fails := fails || public.bendahara_receipts_try('when a receipt was uploaded is changed', '42501',
    format('update public.finance_receipts set created_at = now() - interval %L where id = %L', '1 year', r1));
  reset role;
  -- An editor here who owns the other workspace cannot carry a receipt across.
  perform set_config('request.jwt.claims', mover_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('a receipt is moved to another workspace', '42501',
    format('update public.finance_receipts set org_id = %L where id = %L', other_org, r1));
  fails := fails || public.bendahara_receipts_try('a receipt is moved to another workspace with its file re-pointed', '42501',
    format('update public.finance_receipts set org_id = %L, file_path = %L where id = %L', other_org, f_theirs, r1));
  reset role;
  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('a viewer reviews a receipt', 'FIN11',
    format('select public.finance_review_receipt(%L, %L, %L)', org, r1, jsonb_build_object('vendor', 'Viewer')));
  b := public.finance_set_receipt_extraction(org, r1, jsonb_build_object('vendor', 'Viewer'));
  if b is not false then fails := array_append(fails, 'a viewer wrote a reading onto a receipt'); end if;
  delete from public.finance_receipts where id = r1;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer deleted a receipt'); end if;
  fails := fails || public.bendahara_receipts_try('a viewer makes an expense from a receipt', 'FIN11',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, r1,
      jsonb_build_object('category_id', travel, 'vendor_name', 'Viewer', 'amount', 1)));
  fails := fails || public.bendahara_receipts_try('a viewer makes a bill from a receipt', 'FIN11',
    format('select public.finance_receipt_to_bill(%L, %L, %L, %L)', org, r1,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line));
  fails := fails || public.bendahara_receipts_try('a viewer ties a receipt to a bill', 'FIN11',
    format('select public.finance_attach_receipt(%L, %L, null, %L)', org, r1, bill_posted));
  reset role;

  -- ==== tying a receipt to an expense or a bill ================================
  stage := 'tying a receipt to an expense or a bill';
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  -- An expense made from a receipt by an editor waits for approval; the receipt is matched in the same call.
  fails := fails || public.bendahara_receipts_try('an editor makes an expense from a receipt, with another expense''s id passed in', 'ok',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, r1, jsonb_build_object(
      'id', ex_approved, 'expense_date', current_date - 2, 'category_id', travel, 'vendor_name', 'Shell Bangsar', 'amount', 142.5, 'sst_amount', 8.07)));
  select expense_id into ex_made from public.finance_receipts where id = r1;
  select * into r from public.finance_receipt_inbox where id = r1;
  select status || '/' || amount || '/' || created_by into t from public.finance_expenses where id = ex_made;
  if ex_made = ex_approved or (r.status, r.expense_id, r.document_kind, r.document_label) is distinct from ('matched', ex_made, 'expense', 'Travel')
     or r.bill_id is not null or t is distinct from 'pending/142.50/' || editor_id then
    fails := fails || format('an expense made from a receipt reads %s, and the receipt %s', t, row_to_json(r));
  end if;
  select amount::text into t from public.finance_expenses where id = ex_approved;
  if t is distinct from '1500.00' then fails := array_append(fails, 'making an expense from a receipt edited the expense whose id was passed in'); end if;
  fails := fails || public.bendahara_receipts_try('a second expense is made from a matched receipt', 'FIN23',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, r1,
      jsonb_build_object('category_id', travel, 'vendor_name', 'X', 'amount', 1)));
  -- A refused expense leaves no expense and the receipt as it was.
  select count(*) into n from public.finance_expenses where org_id = org;
  fails := fails || public.bendahara_receipts_try('an expense with an income category is made from a receipt', 'FIN15',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, r2,
      jsonb_build_object('category_id', sales, 'vendor_name', 'X', 'amount', 1)));
  fails := fails || public.bendahara_receipts_try('an expense with no vendor is made from a receipt', '23514',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, r2, jsonb_build_object('category_id', travel, 'amount', 1)));
  select count(*) into m from public.finance_expenses where org_id = org;
  select status into t from public.finance_receipts where id = r2;
  if m <> n or t is distinct from 'unmatched' then
    fails := fails || format('a refused expense left %s more expenses and the receipt %s', m - n, t);
  end if;
  fails := fails || public.bendahara_receipts_try('an expense with an amount that is not a number is made from a receipt', '23514',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, r2,
      jsonb_build_object('category_id', travel, 'vendor_name', 'X', 'amount', 'NaN')));
  select count(*) into n from public.finance_expenses where org_id = org and amount = 'NaN';
  if n <> 0 then fails := array_append(fails, 'an expense with an amount that is not a number was made from a receipt'); end if;
  fails := fails || public.bendahara_receipts_try('an expense is made from a receipt that is not there', 'FIN11',
    format('select public.finance_receipt_to_expense(%L, %L, %L)', org, gen_random_uuid(),
      jsonb_build_object('category_id', travel, 'vendor_name', 'X', 'amount', 1)));

  -- ---- a draft bill made from a receipt ---------------------------------------
  stage := 'a draft bill made from a receipt';
  select count(*) into n from public.supplier_bills where org_id = org;
  fails := fails || public.bendahara_receipts_try('an editor makes a draft bill from a receipt, with a posted bill''s id passed in', 'ok',
    format('select public.finance_receipt_to_bill(%L, %L, %L, %L)', org, r8,
      jsonb_build_object('id', bill_posted, 'supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line));
  select bill_id into bill_made from public.finance_receipts where id = r8;
  -- A draft bill has no number yet, so the inbox has no label for it until it is posted.
  select b2.status || '/' || x.status || '/' || x.document_kind || '/' || coalesce(x.document_label, 'no number yet') into t
    from public.supplier_bills b2 join public.finance_receipt_inbox x on x.bill_id = b2.id where b2.id = bill_made and x.id = r8;
  select count(*) into m from public.supplier_bills where org_id = org;
  if bill_made = bill_posted or m <> n + 1 or t is distinct from 'draft/matched/bill/no number yet'
     or (select status from public.supplier_bills where id = bill_posted) <> 'posted' then
    fails := fails || format('a bill made from a receipt reads %s (%s bills, were %s)', t, m, n);
  end if;
  fails := fails || public.bendahara_receipts_try('a second bill is made from a matched receipt', 'FIN23',
    format('select public.finance_receipt_to_bill(%L, %L, %L, %L)', org, r8,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line));
  fails := fails || public.bendahara_receipts_try('a bill with no line is made from a receipt', 'FIN10',
    format('select public.finance_receipt_to_bill(%L, %L, %L, %L)', org, r9,
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), '[]'::jsonb));
  fails := fails || public.bendahara_receipts_try('a bill is made from a receipt that is not there', 'FIN11',
    format('select public.finance_receipt_to_bill(%L, %L, %L, %L)', org, gen_random_uuid(),
      jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line));
  select count(*) into n from public.supplier_bills where org_id = org;
  select status into t from public.finance_receipts where id = r9;
  if n <> m or t is distinct from 'review' then fails := fails || format('a refused bill left %s more bills and the receipt %s', n - m, t); end if;

  -- ---- attach ------------------------------------------------------------------
  stage := 'attach';
  perform public.finance_attach_receipt(org, r2, ex_pending, null);
  perform public.finance_attach_receipt(org, r3, null, bill_posted);
  perform public.finance_attach_receipt(org, r4, ex_approved, null);
  perform public.finance_attach_receipt(org, r5, null, bill_draft);
  -- Two receipts on one bill: a bill can have as many as it needs.
  perform public.finance_attach_receipt(org, r6, null, bill_posted);
  select string_agg(status || ':' || coalesce(document_kind, '-') || ':' || coalesce(document_label, '-'), ',' order by created_at, id) into t
    from public.finance_receipt_inbox where id in (r2, r3, r4, r5, r6);
  select bill_no into strict f_gone from public.supplier_bills where id = bill_posted;
  if (select count(*) from public.finance_receipt_inbox where id in (r2, r3, r4, r5, r6) and status = 'matched') <> 5
     or (select document_label from public.finance_receipt_inbox where id = r3) is distinct from f_gone
     or (select document_kind || '/' || document_label from public.finance_receipt_inbox where id = r4) is distinct from 'expense/Rent'
     or (select document_kind from public.finance_receipt_inbox where id = r5) is distinct from 'bill' then
    fails := fails || format('five attached receipts read %s', t);
  end if;
  fails := fails || public.bendahara_receipts_try('a receipt is tied to an expense and a bill at once', '22023',
    format('select public.finance_attach_receipt(%L, %L, %L, %L)', org, r7, ex_pending, bill_posted));
  fails := fails || public.bendahara_receipts_try('a receipt is tied to nothing', '22023',
    format('select public.finance_attach_receipt(%L, %L, null, null)', org, r7));
  fails := fails || public.bendahara_receipts_try('a matched receipt is tied to something else', 'FIN23',
    format('select public.finance_attach_receipt(%L, %L, null, %L)', org, r2, bill_posted));
  fails := fails || public.bendahara_receipts_try('a receipt is tied to a void bill', 'FIN25',
    format('select public.finance_attach_receipt(%L, %L, null, %L)', org, r7, bill_void));
  fails := fails || public.bendahara_receipts_try('a receipt is tied to another workspace''s bill', '23503',
    format('select public.finance_attach_receipt(%L, %L, null, %L)', org, r7, their_bill));
  fails := fails || public.bendahara_receipts_try('a receipt is tied to an expense that is not there', '23503',
    format('select public.finance_attach_receipt(%L, %L, %L, null)', org, r7, gen_random_uuid()));
  fails := fails || public.bendahara_receipts_try('a receipt is tied to both by hand', '23514',
    format('update public.finance_receipts set expense_id = %L, bill_id = %L where id = %L', ex_pending, bill_draft, r7));
  fails := fails || public.bendahara_receipts_try('a receipt that is not there is tied to a bill', 'FIN11',
    format('select public.finance_attach_receipt(%L, %L, null, %L)', org, gen_random_uuid(), bill_posted));

  -- ---- untie and delete: an approved expense and a posted bill keep their receipt
  stage := 'untie and delete: an approved expense and a posted bill keep their receipt';
  fails := fails || public.bendahara_receipts_try('an editor unties a receipt from an approved expense', 'FIN14',
    format('select public.finance_detach_receipt(%L, %L)', org, r4));
  fails := fails || public.bendahara_receipts_try('an editor unties a receipt from a posted bill', 'FIN14',
    format('select public.finance_detach_receipt(%L, %L)', org, r3));
  fails := fails || public.bendahara_receipts_try('an editor unties a receipt from an approved expense by hand', 'FIN14',
    format('update public.finance_receipts set expense_id = null, status = %L where id = %L', 'unmatched', r4));
  fails := fails || public.bendahara_receipts_try('an editor moves a receipt from an approved expense to a pending one', 'FIN14',
    format('update public.finance_receipts set expense_id = %L where id = %L', ex_pending, r4));
  fails := fails || public.bendahara_receipts_try('an editor moves a receipt from a posted bill to an expense', 'FIN14',
    format('update public.finance_receipts set bill_id = null, expense_id = %L where id = %L', ex_pending, r3));
  fails := fails || public.bendahara_receipts_try('an editor deletes a matched receipt', 'FIN23',
    format('delete from public.finance_receipts where id = %L', r4));
  fails := fails || public.bendahara_receipts_try('an editor deletes a receipt tied to a pending expense without untying it', 'FIN23',
    format('delete from public.finance_receipts where id = %L', r2));
  -- A pending expense and a draft bill are not decided yet: an editor unties from them.
  fails := fails || public.bendahara_receipts_try('an editor unties a receipt from a pending expense', 'ok',
    format('select public.finance_detach_receipt(%L, %L)', org, r2));
  select status || '/' || num_nonnulls(expense_id, bill_id) into t from public.finance_receipts where id = r2;
  if t is distinct from 'unmatched/0' then fails := fails || format('an untied receipt reads %s', t); end if;
  -- Untying what is tied to nothing changes nothing.
  fails := fails || public.bendahara_receipts_try('a receipt tied to nothing is untied', 'ok',
    format('select public.finance_detach_receipt(%L, %L)', org, r2));
  -- An editor moves a receipt from a draft bill to a pending expense in one go.
  fails := fails || public.bendahara_receipts_try('an editor moves a receipt from a draft bill to a pending expense', 'ok',
    format('update public.finance_receipts set bill_id = null, expense_id = %L where id = %L', ex_pending, r5));
  select status || '/' || (expense_id = ex_pending) into t from public.finance_receipts where id = r5;
  if t is distinct from 'matched/true' then fails := fails || format('a receipt moved between documents reads %s', t); end if;
  reset role;

  -- An editor here who owns another workspace is still an editor here.
  perform set_config('request.jwt.claims', mover_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('an editor who owns another workspace unties a receipt from an approved expense', 'FIN14',
    format('select public.finance_detach_receipt(%L, %L)', org, r4));
  reset role;

  perform set_config('request.jwt.claims', admin_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('an admin unties a receipt from a posted bill', 'ok',
    format('select public.finance_detach_receipt(%L, %L)', org, r6));
  fails := fails || public.bendahara_receipts_try('an admin deletes a matched receipt without untying it', 'FIN23',
    format('delete from public.finance_receipts where id = %L', r4));
  reset role;

  -- ==== the write guards still hold around a receipt ===========================
  stage := 'the write guards still hold around a receipt';
  -- A member makes a draft bill from a receipt (above) but does not post or void it.
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('a member posts the bill made from a receipt', 'FIN14',
    format('select public.finance_post_bill(%L, %L)', org, bill_made));
  fails := fails || public.bendahara_receipts_try('a member voids a posted bill to free its receipt', 'FIN14',
    format('update public.supplier_bills set status = %L where id = %L', 'void', bill_posted));
  reset role;
  -- An owner posts it: it takes the next BILL- number, and its receipt reads that number.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  perform public.finance_post_bill(org, bill_made);
  select b2.status || '/' || (b2.bill_no ~ '^BILL-[0-9]+$') || '/' || (x.document_label = b2.bill_no) || '/' || x.status into t
    from public.supplier_bills b2 join public.finance_receipt_inbox x on x.bill_id = b2.id where b2.id = bill_made and x.id = r8;
  if t is distinct from 'posted/true/true/matched' then fails := fails || format('a bill from a receipt, posted by an owner, reads %s', t); end if;
  reset role;

  -- An owner's expense from a receipt is approved at once, as any expense of theirs is.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  r_owner := public.finance_register_receipt(org, jsonb_build_object('path', f_owner, 'name', 'owner.pdf'));
  ex_owner := public.finance_receipt_to_expense(org, r_owner, jsonb_build_object(
    'category_id', rent, 'vendor_name', 'Check Landlord', 'amount', 4500));
  select e.status || '/' || (e.approved_by = owner_id) || '/' || r2x.status into t
    from public.finance_expenses e join public.finance_receipts r2x on r2x.expense_id = e.id where e.id = ex_owner;
  if t is distinct from 'approved/true/matched' then fails := fails || format('an owner''s expense from a receipt reads %s', t); end if;
  reset role;

  -- ==== the document is deleted: its receipt goes back to Unmatched ============
  stage := 'the document is deleted: its receipt goes back to Unmatched';
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_try('an editor deletes a pending expense that has receipts', 'ok',
    format('delete from public.finance_expenses where id = %L', ex_pending));
  select status || '/' || num_nonnulls(expense_id, bill_id) into t from public.finance_receipts where id = r5;
  if t is distinct from 'unmatched/0' then fails := fails || format('the receipt of a deleted expense reads %s', t); end if;
  perform public.finance_attach_receipt(org, r5, null, bill_draft);
  fails := fails || public.bendahara_receipts_try('an editor deletes a draft bill that has a receipt', 'ok',
    format('delete from public.supplier_bills where id = %L', bill_draft));
  select status || '/' || num_nonnulls(expense_id, bill_id) into t from public.finance_receipts where id = r5;
  if t is distinct from 'unmatched/0' then fails := fails || format('the receipt of a deleted draft bill reads %s', t); end if;
  -- An approved expense is not deleted, with or without a receipt (the expense's own rule).
  fails := fails || public.bendahara_receipts_try('an editor deletes an approved expense that has a receipt', 'FIN01',
    format('delete from public.finance_expenses where id = %L', ex_approved));

  -- ==== deleting a receipt lets its file go =====================================
  stage := 'deleting a receipt lets its file go';
  fails := fails || public.bendahara_receipts_try('an editor deletes an unmatched receipt', 'ok',
    format('delete from public.finance_receipts where id = %L', r5));
  fails := fails || public.bendahara_receipts_try('a deleted receipt''s file is recorded again', 'FIN24',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f5, 'name', 'again.jpg')));
  fails := fails || public.bendahara_receipts_try('an editor asks which files are to be removed', '42501',
    'select public.finance_receipt_deletions_due(10)');
  fails := fails || public.bendahara_receipts_try('an editor queues unrecorded files', '42501',
    'select public.finance_receipt_queue_orphans()');
  fails := fails || public.bendahara_receipts_try('an editor takes a path off the list', '42501',
    format('select public.finance_receipt_deletions_done(%L)', array[f5]));
  fails := fails || public.bendahara_receipts_try('an editor asks whether a path is on the list', '42501',
    format('select public.finance_receipt_deletion_queued(%L)', f5));
  fails := fails || public.bendahara_receipts_try('an editor reads the list of files to remove', '42501',
    'select count(*) from private.finance_receipt_deletions');
  reset role;

  -- ==== the clean-up run, as the server ========================================
  stage := 'the clean-up run, as the server';
  -- A receipt whose file is three hours old, made with no user as a migration
  -- could: the run must not take a file a receipt holds, however old.
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.finance_receipts (org_id, file_path, file_name, mime_type)
  values (org, f_held, 'held.jpg', 'image/jpeg') returning id into r_held;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  fails := fails || public.bendahara_receipts_try('the server reads receipts', '42501', 'select count(*) from public.finance_receipts');
  if public.finance_receipt_deletion_queued(f5) is not true or public.finance_receipt_deletion_queued(f1) is not false then
    fails := array_append(fails, 'the list of files to remove does not hold exactly the deleted receipt''s file');
  end if;
  reset role;
  -- An old file of another bucket, which this run has no business with.
  perform set_config('request.jwt.claims', '{}', true);
  f_other := editor_id || '/an-old-claim-receipt.png';
  insert into storage.objects (bucket_id, name, owner, metadata, created_at)
  values ('hr-receipts', f_other, editor_id, png, now() - interval '3 days');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  n := public.finance_receipt_queue_orphans();
  select count(*) into m from public.finance_receipt_deletions_due(500) d(path)
   where d.path in (f_orphan, f_young, f_held, f_old, f1, f_theirs, f5);
  if not (public.finance_receipt_deletion_queued(f_orphan) and public.finance_receipt_deletion_queued(f5))
     or public.finance_receipt_deletion_queued(f_young) or public.finance_receipt_deletion_queued(f_held)
     or public.finance_receipt_deletion_queued(f_old) or public.finance_receipt_deletion_queued(f1)
     or public.finance_receipt_deletion_queued(f_theirs) or m <> 2 or n < 1 then
    fails := fails || format('the run queued %s files; of this script''s files %s are due (the 61-minute-old unrecorded one and the deleted receipt''s were expected)', n, m);
  end if;
  if public.finance_receipt_deletion_queued(f_other) then
    fails := array_append(fails, 'the run queued a file of another bucket');
  end if;
  -- Asked again, it queues nothing new.
  if public.finance_receipt_queue_orphans() <> 0 then fails := array_append(fails, 'the run queued the same files twice'); end if;
  -- A path whose file is still in the bucket stays on the list, whatever the server says.
  n := public.finance_receipt_deletions_done(array[f5, f_orphan]);
  if n <> 0 or public.finance_receipt_deletion_queued(f5) is not true then
    fails := fails || format('%s paths were taken off the list while their files are still in the bucket', n);
  end if;
  reset role;

  -- Real storage refuses a direct delete of an object, so "the file is gone" is
  -- made another way: a path on the list that has no file behind it.
  perform set_config('request.jwt.claims', '{}', true);
  f_gone := org || '/' || gen_random_uuid() || '.jpg';
  insert into private.finance_receipt_deletions (path) values (f_gone);
  set local role service_role;
  n := public.finance_receipt_deletions_done(array[f_gone, f5]);
  if n <> 1 or public.finance_receipt_deletion_queued(f_gone) then
    fails := fails || format('taking a removed file off the list took %s paths', n);
  end if;
  n := public.finance_receipt_deletions_done(null);
  if n <> 0 then fails := array_append(fails, 'taking no paths off the list took some'); end if;
  reset role;

  -- ==== a session with no user ==================================================
  stage := 'a session with no user';
  -- Through the API role it reaches nothing.
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.finance_receipts;
  if n <> 0 then fails := fails || format('a session with no user reads %s receipts', n); end if;
  fails := fails || public.bendahara_receipts_try('a session with no user records a receipt', '42501',
    format('select public.finance_register_receipt(%L, %L)', org, jsonb_build_object('path', f_young, 'name', 'nobody.jpg')));
  reset role;
  -- As a migration (the demo seed): a row with no file, tied by a plain update, and untied.
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.finance_receipts (org_id, file_name, mime_type, size_bytes, vendor, receipt_date, amount, sst_amount)
  values (org, 'receipt-0042.jpg', 'image/jpeg', 184320, 'Seeded Vendor', current_date, 142.5, 0) returning id into r_seed;
  update public.finance_receipts set expense_id = ex_approved where id = r_seed;
  select status || '/' || has_file || '/' || document_label into t from public.finance_receipt_inbox where id = r_seed;
  if t is distinct from 'matched/false/Rent' then fails := fails || format('a seeded receipt reads %s', t); end if;
  update public.finance_receipts set expense_id = null where id = r_seed;
  select status into t from public.finance_receipts where id = r_seed;
  if t is distinct from 'unmatched' then fails := fails || format('a seeded receipt untied reads %s', t); end if;
  delete from public.finance_receipts where id = r_seed;
  select count(*) into n from private.finance_receipt_deletions where path is null;
  if n <> 0 then fails := array_append(fails, 'deleting a receipt with no file queued an empty path'); end if;

  -- ==== room: one workspace, and the bucket =====================================
  stage := 'room: one workspace, and the bucket';
  -- A file of 1 GB in the third workspace's folder, as storage would describe it.
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('finance-receipts', full_org || '/' || gen_random_uuid() || '.pdf', full_owner, '{"size": 1073741824, "mimetype": "application/pdf"}');
  perform set_config('request.jwt.claims', full_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('the owner of a workspace that holds 1 GB of receipts uploads', false,
    full_org || '/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  -- A row whose size is not a whole number counts as nothing, and refuses nobody.
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('finance-receipts', org || '/' || gen_random_uuid() || '.jpg', owner_id, '{"size": "a lot", "mimetype": "image/jpeg"}');
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('another workspace still uploads while that one is full', true,
    org || '/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  -- The bucket's own ceiling: 20 GB across every workspace.
  perform set_config('request.jwt.claims', '{}', true);
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('finance-receipts', full_org || '/' || gen_random_uuid() || '.pdf', full_owner, '{"size": 20401094656, "mimetype": "application/pdf"}');
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_receipts_upload('an owner uploads while the bucket holds 20 GB', false,
    org || '/' || gen_random_uuid() || '.jpg', jpg);
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- ==== a user is deleted: who uploaded is cleared, and nothing else moves ======
  stage := 'a user is deleted: who uploaded is cleared, and nothing else moves';
  -- The auth service deletes users, as its own role: one with no right on any
  -- finance table. So the delete is made as supabase_auth_admin where this
  -- script's role may switch to it (the stage 6 break was a trigger that ran as
  -- that role and was refused). Where it may not, the NOTE says so and the
  -- delete is made as the script's own role, which proves less.
  begin
    execute 'set local role supabase_auth_admin';
  exception when others then
    as_auth := false;
    notes := array_append(notes, format('this script''s role may not act as supabase_auth_admin (%s), so the user was deleted as the script''s own role: run the controller''s separate check of that', sqlstate));
  end;
  begin
    delete from auth.users where id = editor_id;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    if sqlstate like 'FIN%' then
      fails := array_append(fails, format('deleting a user was refused by a finance rule: %s (%s)', sqlerrm, sqlstate));
    elsif as_auth and sqlstate = '42501' then
      fails := array_append(fails, format('deleting a user as the auth service''s role was refused: %s', sqlerrm));
    else
      notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so uploaded_by was cleared by hand', sqlstate, sqlerrm));
    end if;
    -- The clearing its foreign keys would have done, by hand, so the rest of the script can go on.
    update public.finance_expenses set created_by = null where created_by = editor_id;
    update public.finance_receipts set uploaded_by = null where uploaded_by = editor_id;
  end;
  select (select count(*) from public.finance_receipts where id = r1 and status = 'matched' and expense_id = ex_made and uploaded_by is null)
       + (select count(*) from public.finance_receipts where id = r2 and status = 'unmatched' and uploaded_by is null)
       + (select count(*) from public.finance_receipts where id = r3 and status = 'matched' and bill_id = bill_posted and uploaded_by is null)
       + (select count(*) from public.finance_receipts where id = r_owner and uploaded_by = owner_id) into n;
  if n <> 4 then fails := array_append(fails, 'deleting a user did not clear uploaded_by on their receipts and leave the rest as it was'); end if;

  -- ==== the workspace is deleted, with everything in it =========================
  stage := 'the workspace is deleted, with everything in it';
  select count(*) into m from public.finance_receipts where org_id = org and file_path is not null;
  delete from public.orgs where id = org;
  select count(*) into n from public.finance_receipts where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s receipts', n); end if;
  -- Matched receipts went with it, and every file they held is on the list.
  select count(*) into n from private.finance_receipt_deletions d where d.path in (f1, f2, f3, f4, f6, f7, f8, f9, f_owner, f_held);
  if m <> 10 or n <> 10 then
    fails := fails || format('the workspace had %s receipts with a file and %s of their 10 files were queued for removal', m, n);
  end if;

  exception when others then
    -- Everything the block did is undone, but what it had found is kept: the
    -- cause is usually among the expectations that had already failed.
    fails := array_append(fails, format('STOPPED in "%s" by an error no step expected: %s (%s)', stage, sqlerrm, sqlstate));
  end;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_RECEIPTS_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_RECEIPTS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
