-- Bendahara archived-account check. Run it after
-- 20261116110000_bendahara_archived_account_rule.sql, in the same transaction
-- for a dry run, or by itself once the migration is applied. It needs every
-- finance migration before that one too. It goes through every way a payment
-- can come to be on an archived account, as an owner, a member, a viewer and
-- an outsider, what must go on working there (void, reject, delete, edit a
-- draft), the order the triggers answer in, and what service_role holds on
-- the finance tables. It leaves nothing behind either way: the block always
-- ends with RAISE, so every row and the helper function below are rolled
-- back. Read the message:
--   BENDAHARA_ARCHIVED_ACCOUNT_CHECK PASSED ...   or   BENDAHARA_ARCHIVED_ACCOUNT_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
-- What it cannot show is two sessions at once: that an archive and a payment
-- wait for each other was run by hand on a local database (see the plan).
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  viewer_claims text;
  outsider_claims text;
  bank uuid;
  till uuid;
  old uuid;
  held uuid;
  sales uuid;
  utilities uuid;
  cust uuid;
  inv uuid;
  d_old uuid;
  d_bank uuid;
  p_old uuid;
  tr uuid;
  sched uuid;
  pend uuid;
  pend2 uuid;
  rc integer;
  pv integer;
  n integer;
  t text;
  ctx text;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  notes text[] := '{}';
begin
 begin
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
  execute $f$
    create function public.bendahara_archived_account_try(label text, want text, q text) returns text
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
  execute 'grant execute on function public.bendahara_archived_account_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname = 'finance_transaction_account_guard'
     and p.prosecdef and 'search_path=""' = any(p.proconfig)
     and p.proowner = (select relowner from pg_class where oid = 'public.finance_transactions'::regclass);
  if n <> 1 then fails := array_append(fails, 'the account guard does not run as the owner of finance_transactions with a fixed search_path'); end if;
  if has_function_privilege('authenticated', 'private.finance_transaction_account_guard()', 'execute')
     or has_function_privilege('anon', 'private.finance_transaction_account_guard()', 'execute')
     or has_function_privilege('service_role', 'private.finance_transaction_account_guard()', 'execute') then
    fails := array_append(fails, 'the account guard can be called directly');
  end if;
  select count(*) into n from pg_proc where proname = 'finance_transaction_account_guard' and prosrc ~* 'for\s+share';
  if n <> 1 then fails := array_append(fails, 'the account guard does not lock the account row for share'); end if;
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p where p.prosrc like '%FIN37%';
  if t is distinct from 'finance_transaction_account_guard' then fails := fails || format('FIN37 is raised by: %s', t); end if;
  -- Every trigger on payments, in name order, which is the order BEFORE ROW triggers fire in.
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_transactions'::regclass and tgenabled = 'O';
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,finance_transaction_still,'
       || 'finance_transaction_unmatch,finance_transfer_id_guard,finance_transfer_pair_delete,finance_transfer_pair_insert,'
       || 'finance_transfer_pair_update,finance_use_account_insert,finance_use_account_update,finance_void_stamp' then
    fails := fails || format('triggers on finance_transactions are: %s', t);
  end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_use_account_insert';
  if t is distinct from 'CREATE TRIGGER finance_use_account_insert BEFORE INSERT ON public.finance_transactions '
       || 'FOR EACH ROW EXECUTE FUNCTION private.finance_transaction_account_guard()' then
    fails := fails || format('finance_use_account_insert is: %s', t);
  end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_use_account_update';
  if t is distinct from 'CREATE TRIGGER finance_use_account_update BEFORE UPDATE ON public.finance_transactions '
       || 'FOR EACH ROW WHEN (((new.account_id IS DISTINCT FROM old.account_id) OR ((new.status = ANY '
       || '(ARRAY[''pending_approval''::text, ''scheduled''::text, ''posted''::text])) AND (new.status IS DISTINCT FROM old.status)))) '
       || 'EXECUTE FUNCTION private.finance_transaction_account_guard()' then
    fails := fails || format('finance_use_account_update is: %s', t);
  end if;
  -- service_role is in no finance relation's privileges, and all 43 are there.
  select count(*), string_agg(c.relname, ',' order by c.relname)
           filter (where exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole))
    into n, t
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
     and (c.relname like 'finance\_%' or c.relname like 'supplier\_bill%');
  if n < 43 then fails := fails || format('expected at least 43 finance tables and views, found %s', n); end if;
  if t is not null then fails := fails || format('service_role holds a privilege on: %s', t); end if;

  -- ---- a workspace and its people --------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@archived.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'Archived Check Sdn Bhd'), (other_org, 'Archived Check Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into sales from public.finance_categories where org_id = org and kind = 'income' order by name limit 1;
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  if bank is null or till is null or sales is null or utilities is null then
    raise exception 'BENDAHARA_ARCHIVED_ACCOUNT_CHECK FAILED: a new workspace was not seeded with a bank account, cash and categories';
  end if;

  -- ---- what is on the accounts before one is archived ---------------------------
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_accounts (org_id, name, kind) values (org, 'Old', 'bank') returning id into old;
  insert into public.finance_accounts (org_id, name, kind) values (org, 'Held', 'bank') returning id into held;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Check Customer', true, false) returning id into cust;
  inv := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv);
  d_old := public.finance_save_cash_receipt(org, jsonb_build_object('account_id', old, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in'), '[]');
  d_bank := public.finance_save_cash_receipt(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 8, 'category_id', sales, 'party_name', 'Walk-in'), '[]');
  p_old := public.finance_record_payment_in(org, jsonb_build_object('account_id', old, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10)));
  tr := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', old, 'amount', 3));
  sched := public.finance_record_voucher(org,
    jsonb_build_object('account_id', held, 'method', 'bank_transfer', 'amount', 5, 'party_name', 'Later', 'category_id', utilities, 'status', 'scheduled'), '[]');
  perform set_config('request.jwt.claims', member_claims, true);
  pend := public.finance_record_voucher(org,
    jsonb_build_object('account_id', held, 'method', 'bank_transfer', 'amount', 6, 'party_name', 'Asked', 'category_id', utilities), '[]');
  pend2 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', held, 'method', 'bank_transfer', 'amount', 6, 'party_name', 'Asked again', 'category_id', utilities), '[]');
  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) into n from public.finance_transactions
   where org_id = org and ((id = sched and status = 'scheduled') or (id in (pend, pend2) and status = 'pending_approval'));
  if n <> 3 then fails := array_append(fails, 'the fixtures on Held are not one scheduled and two waiting payments'); end if;
  -- Old is archived the way a person does it: nothing on it is owed.
  fails := fails || public.bendahara_archived_account_try('the owner archives Old', 'ok',
    format('update public.finance_accounts set active = false where id = %L', old));
  -- Held cannot be (FIN30) ...
  fails := fails || public.bendahara_archived_account_try('the owner archives Held, which has payments to be paid', 'FIN30',
    format('update public.finance_accounts set active = false where id = %L', held));
  reset role;
  -- ... so it is archived by the database owner with nobody signed in, the one
  -- way an archived account can come to hold a scheduled payment after this migration.
  perform set_config('request.jwt.claims', '{}', true);
  update public.finance_accounts set active = false where id = held;
  -- With nobody signed in the rule steps aside, as the other finance guards do.
  fails := fails || public.bendahara_archived_account_try('the database owner, nobody signed in, starts a draft on an archived account', 'ok',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 1, ''cash'', %L)', org, old, sales));
  delete from public.finance_transactions where org_id = org and account_id = old and amount = 1;

  select coalesce((select next_number from public.finance_sequences where org_id = org and doc_type = 'receipt'), 1),
         coalesce((select next_number from public.finance_sequences where org_id = org and doc_type = 'voucher'), 1) into rc, pv;

  -- ==== the owner: nothing is started on, moved to or put to work on an archived account
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_archived_account_try('the owner starts a draft on an archived account', 'FIN37',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, old, sales));
  fails := fails || public.bendahara_archived_account_try('the owner saves a new draft receipt on an archived account', 'FIN37',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', old, 'method', 'cash', 'amount', 7, 'category_id', sales, 'party_name', 'Walk-in')));
  fails := fails || public.bendahara_archived_account_try('the owner records a payment in on an archived account', 'FIN37',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', old, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  fails := fails || public.bendahara_archived_account_try('the owner schedules a voucher on an archived account', 'FIN37',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', old, 'method', 'cash', 'amount', 5, 'party_name', 'Late', 'category_id', utilities, 'status', 'scheduled')));
  fails := fails || public.bendahara_archived_account_try('the owner pays a voucher from an archived account', 'FIN37',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', old, 'method', 'cash', 'amount', 5, 'party_name', 'Late', 'category_id', utilities)));
  fails := fails || public.bendahara_archived_account_try('the owner moves a draft onto an archived account', 'FIN37',
    format('update public.finance_transactions set account_id = %L where id = %L', old, d_bank));
  fails := fails || public.bendahara_archived_account_try('the owner saves a draft receipt onto an archived account', 'FIN37',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('id', d_bank, 'account_id', old, 'method', 'cash', 'amount', 8, 'category_id', sales, 'party_name', 'Walk-in')));
  -- The draft that was on Old when it was archived is still edited there ...
  fails := fails || public.bendahara_archived_account_try('the owner edits the draft that is on an archived account', 'ok',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('id', d_old, 'account_id', old, 'method', 'cash', 'amount', 9, 'category_id', sales, 'party_name', 'Walk-in')));
  -- ... and is not posted, scheduled or sent for approval there.
  fails := fails || public.bendahara_archived_account_try('the owner posts the draft that is on an archived account', 'FIN37',
    format('select public.finance_post_cash_receipt(%L, %L)', org, d_old));
  fails := fails || public.bendahara_archived_account_try('the owner schedules the draft that is on an archived account', 'FIN37',
    format('update public.finance_transactions set status = ''scheduled'' where id = %L', d_old));
  fails := fails || public.bendahara_archived_account_try('the owner sends the draft that is on an archived account for approval', 'FIN37',
    format('update public.finance_transactions set status = ''pending_approval'' where id = %L', d_old));
  -- What waits on Held: approving and paying are refused, rejecting is not.
  fails := fails || public.bendahara_archived_account_try('the owner approves a payment that waits on an archived account', 'FIN37',
    format('update public.finance_transactions set status = ''scheduled'' where id = %L', pend));
  fails := fails || public.bendahara_archived_account_try('the owner marks a scheduled payment on an archived account paid', 'FIN37',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, sched));
  fails := fails || public.bendahara_archived_account_try('the owner rejects a payment that waits on an archived account', 'ok',
    format('update public.finance_transactions set status = ''rejected'' where id = %L', pend2));
  -- A transfer names its own refusal first, as it did.
  fails := fails || public.bendahara_archived_account_try('the owner transfers to an archived account', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org, jsonb_build_object('from_account_id', bank, 'to_account_id', old, 'amount', 5)));
  fails := fails || public.bendahara_archived_account_try('the owner transfers from an archived account', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org, jsonb_build_object('from_account_id', old, 'to_account_id', bank, 'amount', 5)));
  -- An account that is not the workspace's is the foreign key's to refuse.
  fails := fails || public.bendahara_archived_account_try('the owner starts a draft on an account that is not there', '23503',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, gen_random_uuid(), sales));
  -- The guards that were there answer first, with the code they had.
  fails := fails || public.bendahara_archived_account_try('the owner moves a posted payment onto an archived account', 'FIN09',
    format('update public.finance_transactions set account_id = %L where id = (select id from public.finance_transactions where org_id = %L and transfer_id = %L and direction = ''out'')', old, org, tr));
  fails := fails || public.bendahara_archived_account_try('the owner moves a draft onto an archived account and into a transfer', 'FIN16',
    format('update public.finance_transactions set account_id = %L, transfer_id = %L where id = %L', old, gen_random_uuid(), d_bank));
  reset role;
  select count(*) into n from public.finance_transactions where org_id = org and account_id = old;
  if n <> 3 then fails := fails || format('Old has %s payments, not the draft, the posted payment and the side of a transfer', n); end if;
  select count(*) into n from public.finance_sequences
   where org_id = org and ((doc_type = 'receipt' and next_number <> rc) or (doc_type = 'voucher' and next_number <> pv));
  if n <> 0 then fails := array_append(fails, 'a refused payment used up an RC- or PV- number'); end if;

  -- ==== a member, a viewer, an outsider ==========================================
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_archived_account_try('a member starts a draft on an archived account', 'FIN37',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, old, sales));
  fails := fails || public.bendahara_archived_account_try('a member asks for a voucher from an archived account', 'FIN37',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', old, 'method', 'cash', 'amount', 5, 'party_name', 'Late', 'category_id', utilities)));
  fails := fails || public.bendahara_archived_account_try('a member edits the draft that is on an archived account', 'ok',
    format('update public.finance_transactions set amount = 9.5 where id = %L', d_old));
  -- Posting is a sign-off: the sign-off trigger answers a member before this rule does.
  fails := fails || public.bendahara_archived_account_try('a member posts the draft that is on an archived account', 'FIN14',
    format('select public.finance_post_cash_receipt(%L, %L)', org, d_old));
  fails := fails || public.bendahara_archived_account_try('a member sends the draft that is on an archived account for approval', 'FIN37',
    format('update public.finance_transactions set status = ''pending_approval'' where id = %L', d_old));
  reset role;
  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  -- A BEFORE trigger answers before the row policy: FIN37 with an archived account, 42501 with an active one.
  fails := fails || public.bendahara_archived_account_try('a viewer starts a draft on an archived account', 'FIN37',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, old, sales));
  fails := fails || public.bendahara_archived_account_try('a viewer starts a draft on an active account', '42501',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, bank, sales));
  fails := fails || public.bendahara_archived_account_try('a viewer records a payment in on an archived account', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', old, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  update public.finance_transactions set account_id = old where id = d_bank;
  reset role;
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_archived_account_try('an outsider starts a draft on an archived account', 'FIN37',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, old, sales));
  fails := fails || public.bendahara_archived_account_try('an outsider starts a draft on an active account', '42501',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id) values (%L, ''in'', %L, 5, ''cash'', %L)', org, bank, sales));
  -- A writer of another workspace naming this workspace's archived account is told it does not exist: the guard
  -- reads the account by the payment's own workspace and id, so it steps aside and the foreign key answers.
  fails := fails || public.bendahara_archived_account_try('an outsider in their own workspace names this workspace''s archived account', '23503',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method) values (%L, ''in'', %L, 5, ''cash'')', other_org, old));
  update public.finance_transactions set status = 'scheduled' where id = d_old;
  reset role;
  select count(*) into n from public.finance_transactions
   where org_id = org and ((id = d_bank and account_id = bank) or (id = d_old and status = 'draft' and amount = 9.5));
  if n <> 2 then fails := array_append(fails, 'a viewer or an outsider changed a payment, or the member''s edit of the draft was lost'); end if;
  select count(*) into n from public.finance_transactions where org_id = org and account_id = old;
  if n <> 3 then fails := fails || format('after the member, the viewer and the outsider Old has %s payments, not 3', n); end if;

  -- ==== what goes on working on an archived account =============================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_archived_account_try('the owner voids a posted payment on an archived account', 'ok',
    format('update public.finance_transactions set status = ''void'' where id = %L', p_old));
  fails := fails || public.bendahara_archived_account_try('the owner voids a transfer into an archived account', 'ok',
    format('select public.finance_void_transfer(%L, %L)', org, tr));
  -- Re-pointed at an active account, the draft is posted.
  fails := fails || public.bendahara_archived_account_try('the owner points the draft at an active account', 'ok',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('id', d_old, 'account_id', bank, 'method', 'cash', 'amount', 9, 'category_id', sales, 'party_name', 'Walk-in')));
  fails := fails || public.bendahara_archived_account_try('the owner posts the re-pointed draft', 'ok',
    format('select public.finance_post_cash_receipt(%L, %L)', org, d_old));
  -- Restored, the account takes money again: what waited on Held is approved and paid.
  fails := fails || public.bendahara_archived_account_try('the owner restores Held', 'ok',
    format('update public.finance_accounts set active = true where id = %L', held));
  fails := fails || public.bendahara_archived_account_try('the owner approves the payment once the account is restored', 'ok',
    format('update public.finance_transactions set status = ''scheduled'' where id = %L', pend));
  fails := fails || public.bendahara_archived_account_try('the owner marks the scheduled payment paid once the account is restored', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, sched));
  fails := fails || public.bendahara_archived_account_try('the owner deletes a scheduled payment', 'ok',
    format('delete from public.finance_transactions where id = %L', pend));
  reset role;
  select count(*) into n from public.finance_transactions
   where org_id = org and ((id = p_old and status = 'void') or (transfer_id = tr and status = 'void')
     or (id = d_old and status = 'posted' and account_id = bank) or (id = sched and status = 'posted') or (id = pend2 and status = 'rejected'));
  if n <> 6 then fails := fails || format('expected 6 payments voided, posted or rejected as the steps above say, found %s', n); end if;

  -- ==== a user is deleted by a role with no rights on public tables ============
  -- The member made two payments on Held, which is archived again first. The
  -- foreign keys clear created_by with an UPDATE that this rule's WHEN clause
  -- passes by, so the function is not called and the account is not read.
  perform set_config('request.jwt.claims', '{}', true);
  update public.finance_accounts set active = false where id = held;
  begin
    create role bendahara_archived_auth_role nologin;
    grant bendahara_archived_auth_role to current_user;
    grant usage on schema auth to bendahara_archived_auth_role;
    grant select, delete on auth.users to bendahara_archived_auth_role;
    perform set_config('request.jwt.claims', owner_claims, true);
    set local role bendahara_archived_auth_role;
    delete from auth.users where id = member_id;
    reset role;
    select count(*) into n from public.finance_transactions where org_id = org and id = pend2 and created_by is null;
    if n <> 1 then fails := array_append(fails, 'a user deleted by the auth role was not cleared from a payment on an archived account'); end if;
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    reset role;
    if sqlstate like 'FIN%' or ctx ilike '%finance_%' or sqlerrm ilike '%finance_%' then
      fails := fails || format('a user with a payment on an archived account cannot be deleted by a role with no rights on public: %s %s', sqlstate, sqlerrm);
    else
      notes := array_append(notes, format('the delete by a role with no rights on public was not tried to the end (%s: %s)', sqlstate, sqlerrm));
    end if;
  end;

  -- ==== the workspace is deleted, with everything in it =======================
  perform set_config('request.jwt.claims', owner_claims, true);
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_accounts where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s payments and accounts', n); end if;
  delete from public.orgs where id = other_org;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_ARCHIVED_ACCOUNT_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_ARCHIVED_ACCOUNT_CHECK FAILED: %', array_to_string(fails, ' | ');
 exception when others then
  if sqlerrm like 'BENDAHARA_ARCHIVED_ACCOUNT_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_ARCHIVED_ACCOUNT_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
 end;
end $$;
