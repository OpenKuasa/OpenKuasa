-- Bendahara save-voucher check. Run it after
-- 20261117100000_bendahara_save_voucher.sql, in the same transaction for a dry
-- run, or by itself once the migration is applied. It needs every finance
-- migration before that one too, the archived-account rule
-- (20261116110000_bendahara_archived_account_rule.sql) included. It goes
-- through finance_save_voucher as an owner, an admin, a member, a viewer, an
-- outsider and a person who is in two workspaces: a draft for a supplier's
-- bills and for a category, editing it, sending it for approval, what the
-- guards then hold (the split of a waiting voucher is locked, only an owner
-- or admin approves, the approved voucher is a payment to be paid on
-- finance_payments_out), and every refusal by its code. It leaves nothing
-- behind either way: the block always ends with RAISE, so every row and the
-- helper function below are rolled back. Read the message:
--   BENDAHARA_SAVE_VOUCHER_CHECK PASSED ...   or   BENDAHARA_SAVE_VOUCHER_CHECK FAILED: <what went wrong>
-- It makes its own workspaces and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  new_org uuid;
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  both_id uuid := gen_random_uuid();
  newcomer uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  member_claims text;
  viewer_claims text;
  outsider_claims text;
  both_claims text;
  newcomer_claims text;
  bank uuid;
  old uuid;
  utilities uuid;
  sales uuid;
  far_category uuid;
  maju uuid;
  jaya uuid;
  far_supplier uuid;
  bill_a uuid;
  bill_b uuid;
  bill_jaya uuid;
  bill_draft uuid;
  far_bill uuid;
  far_draft uuid;
  expense uuid;
  receipt uuid;
  tr uuid;
  v uuid;
  v2 uuid;
  c uuid;
  c2 uuid;
  on_old uuid;
  r record;
  n integer;
  t text;
  ctx text;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  remarks text[] := '{}';
begin
 begin
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way, or a sentence for the report. `want` is 'ok', a
  -- SQLSTATE, or a SQLSTATE and the message it must carry ("FIN09 only a
  -- draft voucher is changed"), for a refusal another rule would also give
  -- with the same code.
  execute $f$
    create function public.bendahara_save_voucher_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok'; said text := '';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate; said := sqlerrm;
      end;
      if got = want or got || ' ' || said = want then return null; end if;
      return format('%s: expected %s, got %s %s', label, want, got, said);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_save_voucher_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select count(*) into n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'finance_save_voucher'
     and not p.prosecdef and 'search_path=""' = any(p.proconfig)
     and pg_get_function_identity_arguments(p.oid) = 'target_org uuid, voucher jsonb, allocations jsonb';
  if n <> 1 then fails := array_append(fails, 'finance_save_voucher is not one function that runs as the caller with a fixed search_path'); end if;
  if not has_function_privilege('authenticated', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute') then
    fails := array_append(fails, 'the authenticated role cannot call finance_save_voucher');
  end if;
  if has_function_privilege('anon', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('public', 'public.finance_save_voucher(uuid, jsonb, jsonb)', 'execute') then
    fails := array_append(fails, 'finance_save_voucher can be called by anon, service_role or public');
  end if;

  -- ---- two workspaces and their people ---------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@voucher.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, member_id, viewer_id, outsider, both_id, newcomer]) as u(id);
  insert into public.orgs (id, name) values (org, 'Voucher Check Sdn Bhd'), (other_org, 'Voucher Check Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, member_id, 'member'), (org, viewer_id, 'viewer'),
         (other_org, outsider, 'owner'), (org, both_id, 'member'), (other_org, both_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  both_claims := json_build_object('sub', both_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  newcomer_claims := json_build_object('sub', newcomer, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  select id into sales from public.finance_categories where org_id = org and kind = 'income' order by name limit 1;
  select id into far_category from public.finance_categories where org_id = other_org and kind = 'expense' order by name limit 1;
  if bank is null or utilities is null or sales is null or far_category is null then
    raise exception 'BENDAHARA_SAVE_VOUCHER_CHECK FAILED: a new workspace was not seeded with a bank account and categories';
  end if;

  -- ---- signing up still works: the workspace is made before the person is its owner
  perform set_config('request.jwt.claims', newcomer_claims, true);
  set local role authenticated;
  new_org := public.create_org_for_current_user('Voucher Check Newcomer Sdn Bhd');
  reset role;
  select count(*) into n from public.finance_accounts where org_id = new_org;
  if n < 1 then fails := array_append(fails, 'a workspace made by signing up has no account'); end if;

  -- ---- what the owners set up: suppliers, posted bills, an expense, a receipt, a transfer
  perform set_config('request.jwt.claims', outsider_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (other_org, 'Far Supplier', false, true) returning id into far_supplier;
  far_bill := public.finance_save_bill(other_org, jsonb_build_object('supplier_id', far_supplier, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(other_org, far_bill);
  far_draft := public.finance_save_voucher(other_org,
    jsonb_build_object('account_id', (select id from public.finance_accounts where org_id = other_org order by created_at limit 1), 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', far_bill, 'amount', 5)));

  perform set_config('request.jwt.claims', owner_claims, true);
  insert into public.finance_accounts (org_id, name, kind) values (org, 'Old', 'bank') returning id into old;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Syarikat Maju', false, true) returning id into maju;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Jaya Enterprise', false, true) returning id into jaya;
  -- Each bill is RM 132.50.
  bill_a := public.finance_save_bill(org, jsonb_build_object('supplier_id', maju, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  bill_b := public.finance_save_bill(org, jsonb_build_object('supplier_id', maju, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  bill_jaya := public.finance_save_bill(org, jsonb_build_object('supplier_id', jaya, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  bill_draft := public.finance_save_bill(org, jsonb_build_object('supplier_id', maju, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill_a);
  perform public.finance_post_bill(org, bill_b);
  perform public.finance_post_bill(org, bill_jaya);
  expense := public.finance_save_expense(org, jsonb_build_object('expense_date', current_date, 'category_id', utilities, 'vendor_name', 'TNB', 'amount', 40));
  receipt := public.finance_save_cash_receipt(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 8, 'category_id', sales, 'party_name', 'Walk-in'), '[]');
  tr := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', old, 'amount', 3));

  -- ==== a member: a draft for a supplier's bills ================================
  perform set_config('request.jwt.claims', member_claims, true);
  -- The payee sent is ignored: whoever is paid is the bills' supplier.
  v := public.finance_save_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '2026-10-20', 'reference', 'REF-1', 'notes', 'First',
      'contact_id', jaya),
    jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 100)));
  select * into r from public.finance_transactions where id = v;
  if r.status <> 'draft' or r.amount <> 100 or r.direction <> 'out' or r.contact_id is distinct from maju or r.party_name is not null
     or r.category_id is not null or r.number is not null or r.approved_at is not null or r.approved_by is not null
     or r.created_by is distinct from member_id or r.txn_date <> date '2026-10-20' or r.reference <> 'REF-1' or r.notes <> 'First' then
    fails := array_append(fails, 'a draft for a bill is not a draft of RM 100 to the bill''s supplier, made by the member, with no number and no approval');
  end if;
  select count(*) into n from public.finance_payment_vouchers where org_id = org and transaction_id = v and kind = 'bill' and status = 'draft';
  if n <> 1 then fails := array_append(fails, 'a draft for a bill is not one row of kind bill on finance_payment_vouchers'); end if;
  -- While it is a draft it holds its part of the bill: RM 132.50 less RM 100 leaves RM 32.50 for anyone else.
  fails := fails || public.bendahara_save_voucher_try('a second draft for more than the first leaves of the bill', 'FIN05',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 32.51))));
  fails := fails || public.bendahara_save_voucher_try('a payment on Payments Out for more than the draft leaves of the bill', 'FIN05',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 32.51))));

  -- Edited: two bills, each part rounded to the sen before it is added (10.005 + 20.005 is RM 30.02).
  fails := fails || public.bendahara_save_voucher_try('the member edits the draft', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', v, 'account_id', bank, 'method', 'cheque'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 20.005), jsonb_build_object('bill_id', bill_a, 'amount', 10.005))));
  select amount, method, reference, notes, status into r from public.finance_transactions where id = v;
  select count(*), coalesce(sum(amount), 0) into n, t from public.finance_allocations where transaction_id = v;
  if r.amount <> 30.02 or n <> 2 or t::numeric <> 30.02 or r.method <> 'cheque' or r.reference is not null or r.notes is not null or r.status <> 'draft' then
    fails := fails || format('an edited draft is %s over %s bills adding up to %s, not RM 30.02 over 2 bills, with the old reference and notes gone', r.amount, n, t);
  end if;

  -- Sent for approval in the same call as an edit.
  fails := fails || public.bendahara_save_voucher_try('the member edits the draft and sends it for approval', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', v, 'account_id', bank, 'method', 'fpx', 'status', 'pending_approval'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 100), jsonb_build_object('bill_id', bill_b, 'amount', 50))));
  select status, amount, approved_at into r from public.finance_transactions where id = v;
  if r.status <> 'pending_approval' or r.amount <> 150 or r.approved_at is not null then
    fails := fails || format('a voucher sent for approval is %s of %s, not pending_approval of 150 that nobody has approved', r.status, r.amount);
  end if;
  select count(*) into n from public.finance_payments_out where org_id = org and transaction_id = v and status = 'pending_approval';
  if n <> 2 then fails := fails || format('a waiting voucher for two bills is %s rows on finance_payments_out, not 2', n); end if;

  -- ---- while it waits, it is exactly what was sent ----------------------------
  fails := fails || public.bendahara_save_voucher_try('a waiting voucher is edited through the function', 'FIN09 only a draft voucher is changed',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', v, 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('the split of a waiting voucher is lowered', 'FIN09',
    format('update public.finance_allocations set amount = 1 where transaction_id = %L and bill_id = %L', v, bill_a));
  fails := fails || public.bendahara_save_voucher_try('a bill is taken off a waiting voucher', 'FIN09',
    format('delete from public.finance_allocations where transaction_id = %L and bill_id = %L', v, bill_b));
  fails := fails || public.bendahara_save_voucher_try('a bill is added to a waiting voucher', 'FIN09',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 1)', org, v, bill_jaya));
  fails := fails || public.bendahara_save_voucher_try('the amount of a waiting voucher is changed', 'FIN14',
    format('update public.finance_transactions set amount = 151 where id = %L', v));
  fails := fails || public.bendahara_save_voucher_try('the member approves it', 'FIN14',
    format('update public.finance_transactions set status = ''scheduled'' where id = %L', v));

  -- ---- an owner or admin approves it: To be paid, exactly as it was sent ------
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_save_voucher_try('the admin approves it', 'ok',
    format('update public.finance_transactions set status = ''scheduled'', updated_at = now() where id = %L and status = ''pending_approval''', v));
  select status, amount, approved_by, number into r from public.finance_transactions where id = v;
  if r.status <> 'scheduled' or r.amount <> 150 or r.approved_by is distinct from admin_id or r.number is not null then
    fails := fails || format('an approved voucher is %s of %s, not scheduled of 150, approved by the admin, with no number', r.status, r.amount);
  end if;
  select count(*) into n from public.finance_payments_out where org_id = org and transaction_id = v and status = 'scheduled';
  if n <> 2 then fails := fails || format('an approved voucher for two bills is %s scheduled rows on finance_payments_out, not 2', n); end if;
  fails := fails || public.bendahara_save_voucher_try('an approved voucher is edited through the function', 'FIN09 only a draft voucher is changed',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', v, 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('the split of an approved voucher is lowered', 'FIN09',
    format('update public.finance_allocations set amount = 1 where transaction_id = %L and bill_id = %L', v, bill_a));
  fails := fails || public.bendahara_save_voucher_try('the admin marks it paid', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v));
  select status, amount, number into r from public.finance_transactions where id = v;
  if r.status <> 'posted' or r.amount <> 150 or r.number is null then
    fails := fails || format('a paid voucher is %s of %s, not posted of 150 with a number', r.status, r.amount);
  end if;

  -- ==== refusals, as the member ================================================
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_save_voucher_try('bills of two suppliers', 'FIN06 one voucher pays one supplier',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1), jsonb_build_object('bill_id', bill_jaya, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a bill that does not exist', 'FIN06 no bill was chosen or found',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', gen_random_uuid(), 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('an expense in the split', 'FIN06 no bill was chosen or found',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('expense_id', expense, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('bills and a category', 'FIN15 a voucher is for bills or for a category, not both',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'category_id', utilities),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('neither bills nor a category', 'FIN15 a voucher names bills or an expense category',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 5, 'party_name', 'X'), '[]'));
  fails := fails || public.bendahara_save_voucher_try('an income category', 'FIN15 a voucher names bills or an expense category',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 5, 'party_name', 'X', 'category_id', sales), '[]'));
  fails := fails || public.bendahara_save_voucher_try('an amount on a bill that is not a number', '23514 a voucher needs amounts that are numbers',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 'NaN'))));
  fails := fails || public.bendahara_save_voucher_try('an amount for a category that is not a number', '23514 a voucher needs an amount that is a number',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 'NaN', 'party_name', 'X', 'category_id', utilities), '[]'));
  fails := fails || public.bendahara_save_voucher_try('an amount of zero for a category', '23514',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 0, 'party_name', 'X', 'category_id', utilities), '[]'));
  fails := fails || public.bendahara_save_voucher_try('no amount for a category', '23502',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'category_id', utilities), '[]'));
  fails := fails || public.bendahara_save_voucher_try('a contact and a typed name for a category', '23514',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 5, 'party_name', 'X', 'contact_id', maju, 'category_id', utilities), '[]'));
  -- Bill A and bill B are paid for RM 100 and RM 50: RM 32.50 and RM 82.50 are still owed.
  fails := fails || public.bendahara_save_voucher_try('more than is still owed on a bill', 'FIN05',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_a, 'amount', 32.51))));
  fails := fails || public.bendahara_save_voucher_try('a bill that is not posted', 'FIN04',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_draft, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('the same bill twice', '23505',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1), jsonb_build_object('bill_id', bill_b, 'amount', 2))));
  fails := fails || public.bendahara_save_voucher_try('asked to schedule', '22023',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('asked to pay', '22023',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'posted'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a method that is not one', '23514',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'barter'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a voucher that does not exist is edited', 'FIN11',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', gen_random_uuid(), 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a draft cash receipt is edited as a voucher', 'FIN11',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', receipt, 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('the money-out side of a transfer is edited as a voucher', 'FIN11',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', (select id from public.finance_transactions where org_id = org and transfer_id = tr and direction = 'out'), 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  reset role;
  select count(*) into n from public.finance_transactions where org_id = org and direction = 'out' and transfer_id is null;
  if n <> 1 then fails := fails || format('the refused calls left %s vouchers behind, expected only the paid one', n - 1); end if;
  select count(*) into n from public.finance_transactions where id = receipt and direction = 'in' and status = 'draft' and amount = 8;
  if n <> 1 then fails := array_append(fails, 'the draft cash receipt was changed by a call that named it as a voucher'); end if;

  -- ==== nothing crosses a workspace ============================================
  -- Someone who is a member here and the owner there can read both workspaces.
  perform set_config('request.jwt.claims', both_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_save_voucher_try('a bill of another workspace the caller can read', 'FIN06 no bill was chosen or found',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', far_bill, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a category of another workspace the caller can read', 'FIN15',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 5, 'party_name', 'X', 'category_id', far_category), '[]'));
  fails := fails || public.bendahara_save_voucher_try('a draft of another workspace is edited as this one''s', 'FIN11',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', far_draft, 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('an account of another workspace', '23503',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', (select id from public.finance_accounts where org_id = other_org order by created_at limit 1), 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  reset role;
  select count(*) into n from public.finance_transactions where id = far_draft and org_id = other_org and status = 'draft' and amount = 5;
  if n <> 1 then fails := array_append(fails, 'a draft of another workspace was changed'); end if;

  -- ==== a viewer and an outsider ===============================================
  perform set_config('request.jwt.claims', viewer_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_save_voucher_try('a viewer saves a draft for a bill', '42501',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a viewer saves a draft for a category', '42501',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 5, 'party_name', 'X', 'category_id', utilities), '[]'));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_save_voucher_try('an outsider saves a draft for a bill', 'FIN06',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('an outsider saves a draft for a category', 'FIN15',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 5, 'party_name', 'X', 'category_id', utilities), '[]'));

  -- ==== a category, saved as a draft and sent ==================================
  perform set_config('request.jwt.claims', member_claims, true);
  c := public.finance_save_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 12.345, 'party_name', 'Kedai Runcit', 'category_id', utilities), '[]');
  select status, amount, party_name, contact_id, category_id into r from public.finance_transactions where id = c;
  if r.status <> 'draft' or r.amount <> 12.35 or r.party_name <> 'Kedai Runcit' or r.contact_id is not null or r.category_id is distinct from utilities then
    fails := array_append(fails, 'a draft for a category is not a draft of RM 12.35 to a typed name with its category');
  end if;
  -- A draft for a category becomes one for bills, and back: the split and the category change places.
  fails := fails || public.bendahara_save_voucher_try('a category draft becomes a draft for a bill', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', c, 'account_id', bank, 'method', 'cash'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 20))));
  select count(*) into n from public.finance_payment_vouchers where transaction_id = c and kind = 'bill' and amount = 20 and category_id is null and contact_id = jaya;
  if n <> 1 then fails := array_append(fails, 'a category draft edited into a bill draft is not RM 20 to the bill''s supplier with no category'); end if;
  fails := fails || public.bendahara_save_voucher_try('a bill draft becomes a draft for a category and is sent', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', c, 'account_id', bank, 'method', 'cash', 'amount', 9, 'contact_id', maju, 'category_id', utilities, 'status', 'pending_approval'), '[]'));
  select count(*) into n from public.finance_payment_vouchers where transaction_id = c and kind = 'other' and amount = 9 and status = 'pending_approval' and contact_id = maju;
  if n <> 1 then fails := array_append(fails, 'a bill draft edited into a category voucher and sent is not waiting, of kind other, RM 9 to the contact'); end if;
  select count(*) into n from public.finance_allocations where transaction_id = c;
  if n <> 0 then fails := array_append(fails, 'a draft edited into a category voucher kept its old split'); end if;

  -- An owner's is not approved by sending it: it waits like anyone's, and an owner or admin approves it.
  perform set_config('request.jwt.claims', owner_claims, true);
  c2 := public.finance_save_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7, 'party_name', 'Owner''s own', 'category_id', utilities, 'status', 'pending_approval'), '[]');
  select status, approved_at into r from public.finance_transactions where id = c2;
  if r.status <> 'pending_approval' or r.approved_at is not null then
    fails := array_append(fails, 'a voucher an owner sends for approval does not wait unapproved');
  end if;
  -- A typed name sent with bills is ignored too.
  v2 := public.finance_save_voucher(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'pending_approval', 'party_name', 'Somebody else'),
    jsonb_build_array(jsonb_build_object('bill_id', bill_b, 'amount', 10)));
  select count(*) into n from public.finance_transactions where id = v2 and contact_id = maju and party_name is null;
  if n <> 1 then fails := array_append(fails, 'a voucher for bills sent with a typed name is not paid to the bills'' supplier alone'); end if;
  fails := fails || public.bendahara_save_voucher_try('the owner approves the voucher they sent', 'ok',
    format('update public.finance_transactions set status = ''scheduled'' where id = %L', v2));
  fails := fails || public.bendahara_save_voucher_try('the owner rejects a waiting voucher', 'ok',
    format('update public.finance_transactions set status = ''rejected'' where id = %L', c2));
  -- A rejected voucher holds nothing and is only deleted; a draft and a waiting one are deleted by any writer.
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_save_voucher_try('a rejected voucher is edited through the function', 'FIN09 only a draft voucher is changed',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', c2, 'account_id', bank, 'method', 'cash', 'amount', 7, 'party_name', 'X', 'category_id', utilities), '[]'));
  fails := fails || public.bendahara_save_voucher_try('the member deletes a rejected voucher', 'ok',
    format('delete from public.finance_transactions where id = %L', c2));
  fails := fails || public.bendahara_save_voucher_try('the member deletes a waiting voucher', 'ok',
    format('delete from public.finance_transactions where id = %L', c));

  -- ==== an archived account ====================================================
  on_old := public.finance_save_voucher(org, jsonb_build_object('account_id', old, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 15)));
  perform set_config('request.jwt.claims', owner_claims, true);
  -- A draft does not stop an account being archived (a waiting or scheduled payment does: FIN30).
  fails := fails || public.bendahara_save_voucher_try('the owner archives an account that holds only a draft voucher', 'ok',
    format('update public.finance_accounts set active = false where id = %L', old));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_save_voucher_try('a new draft on an archived account', 'FIN37',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('account_id', old, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 1))));
  fails := fails || public.bendahara_save_voucher_try('a draft on another account is moved to an archived one', 'FIN37',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', public.finance_save_voucher(org, jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 2))),
        'account_id', old, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 2))));
  fails := fails || public.bendahara_save_voucher_try('a draft that stays on its archived account is edited', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org, jsonb_build_object('id', on_old, 'account_id', old, 'method', 'cheque'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 16))));
  fails := fails || public.bendahara_save_voucher_try('a draft on an archived account is sent for approval through the function', 'FIN37',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', on_old, 'account_id', old, 'method', 'cheque', 'status', 'pending_approval'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 16))));
  fails := fails || public.bendahara_save_voucher_try('a draft on an archived account is sent for approval by its row', 'FIN37',
    format('update public.finance_transactions set status = ''pending_approval'' where id = %L', on_old));
  fails := fails || public.bendahara_save_voucher_try('a draft on an archived account is pointed at an active one and sent', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org,
      jsonb_build_object('id', on_old, 'account_id', bank, 'method', 'cheque', 'status', 'pending_approval'),
      jsonb_build_array(jsonb_build_object('bill_id', bill_jaya, 'amount', 16))));
  reset role;
  -- What is left: the paid voucher, the owner's approved one, the one just sent, and one draft on the bank account.
  select string_agg(status || ' ' || amount, ', ' order by amount) into t from public.finance_transactions
   where org_id = org and direction = 'out' and transfer_id is null;
  if t is distinct from 'draft 2.00, scheduled 10.00, pending_approval 16.00, posted 150.00' then
    fails := fails || format('the vouchers left are: %s', t);
  end if;

  -- ==== a user is deleted by a role with no rights on public tables ============
  -- The member made vouchers that are a draft, waiting and paid. The foreign
  -- keys clear created_by; nothing of this migration runs on that path.
  perform set_config('request.jwt.claims', '{}', true);
  begin
    create role bendahara_save_voucher_auth_role nologin;
    grant bendahara_save_voucher_auth_role to current_user;
    grant usage on schema auth to bendahara_save_voucher_auth_role;
    grant select, delete on auth.users to bendahara_save_voucher_auth_role;
    set local role bendahara_save_voucher_auth_role;
    delete from auth.users where id = member_id;
    reset role;
    select count(*) into n from public.finance_transactions where org_id = org and direction = 'out' and transfer_id is null and created_by is null;
    if n <> 3 then fails := fails || format('a deleted member was cleared from %s vouchers, expected 3', n); end if;
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    reset role;
    if sqlstate like 'FIN%' or ctx ilike '%finance_%' or sqlerrm ilike '%finance_%' then
      fails := fails || format('a user who made vouchers cannot be deleted by a role with no rights on public: %s %s', sqlstate, sqlerrm);
    else
      remarks := array_append(remarks, format('the delete by a role with no rights on public was not tried to the end (%s: %s)', sqlstate, sqlerrm));
    end if;
  end;

  -- ==== the workspaces are deleted, with everything in them ====================
  perform set_config('request.jwt.claims', owner_claims, true);
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s payments and allocations', n); end if;
  delete from public.orgs where id in (other_org, new_org);

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_SAVE_VOUCHER_CHECK PASSED (everything rolled back)%',
      case when array_length(remarks, 1) is null then '' else ' NOTE: ' || array_to_string(remarks, ' | ') end;
  end if;
  raise exception 'BENDAHARA_SAVE_VOUCHER_CHECK FAILED: %', array_to_string(fails, ' | ');
 exception when others then
  if sqlerrm like 'BENDAHARA_SAVE_VOUCHER_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_SAVE_VOUCHER_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
 end;
end $$;
