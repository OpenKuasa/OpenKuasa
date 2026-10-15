-- Bendahara banking check. Run it after
-- 20261031090300_bendahara_banking_write_guards_fit.sql, in the same
-- transaction for a dry run, or by itself once the migration is applied. It
-- needs every finance migration before that one too:
-- 20261030123000_finance_write_guards (who signs off, and which columns only
-- the database writes), 20261031090000_bendahara_banking and
-- 20261031090200_bendahara_banking_next_number_definer. It goes through
-- transfers between accounts, account balances, statement imports and
-- matching as an owner, an admin, an editor, a viewer and an outsider, and
-- checks that finance_bank_transactions lists every movement of money once.
-- Everything the three older scripts cover (bendahara_cash_book_check.sql,
-- bendahara_followons_check.sql, bendahara_invoices_check.sql) is theirs. It
-- leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_BANKING_CHECK PASSED ...   or   BENDAHARA_BANKING_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
-- Two short parts, marked "by the database owner", are run as the role that
-- runs this script, with a person's id still in the claims: since the write
-- guards nobody signed in can write a payment's number, so two sides made by
-- hand can only be posted by the owner of the tables, and the rule that keeps
-- a pair whole is proved there.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  mover_id uuid := gen_random_uuid();
  mover_claims text;
  empty_import uuid;
  ctx text;
  owner_claims text;
  admin_claims text;
  editor_claims text;
  bank uuid;
  till uuid;
  savings uuid;
  closed uuid;
  their_bank uuid;
  their_txn uuid;
  utilities uuid;
  sales uuid;
  cust uuid;
  sup uuid;
  inv uuid;
  bill uuid;
  bill2 uuid;
  p_in uuid;
  p_out uuid;
  t1 uuid;
  t2 uuid;
  t3 uuid;
  hand uuid := gen_random_uuid();
  lone uuid := gen_random_uuid();
  bad uuid := gen_random_uuid();
  imp uuid;
  l_in uuid;
  l_out uuid;
  l_transfer uuid;
  l_charge uuid;
  l_interest uuid;
  l_again uuid;
  l_cash uuid;
  charge uuid;
  interest uuid;
  stray uuid;
  side uuid;
  counter integer;
  no text;
  n integer;
  m numeric;
  t text;
  r record;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  notes text[] := '{}';
begin
 -- One handler round everything: a step that stops on an error of its own is
 -- reported as a failure, with what had been collected before it.
 begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
  execute $f$
    create function public.bendahara_banking_try(label text, want text, q text) returns text
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
  execute 'grant execute on function public.bendahara_banking_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  foreach t in array array['finance_statement_imports','finance_statement_lines'] loop
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n <> 5 then fails := fails || format('expected 5 policies on %s, found %s', t, n); end if;
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = t and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
    if n <> 1 then fails := fails || format('%s has no restrictive mfa_required policy', t); end if;
    select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if n <> 1 then fails := fails || format('row-level security is not enabled on %s', t); end if;
    if has_table_privilege('service_role', 'public.' || t, 'select')
       or has_table_privilege('service_role', 'public.' || t, 'insert')
       or has_table_privilege('service_role', 'public.' || t, 'update')
       or has_table_privilege('service_role', 'public.' || t, 'delete') then
      fails := fails || format('service_role was granted %s', t);
    end if;
  end loop;
  foreach t in array array['finance_statement_imports','finance_statement_lines','finance_account_balances','finance_bank_transactions'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then fails := fails || format('authenticated cannot read %s', t); end if;
  end loop;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('finance_account_balances','finance_bank_transactions')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 2 then fails := fails || format('expected 2 new security_invoker views, found %s', n); end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_account_balances'::regclass and attnum > 0 and not attisdropped;
  -- No account_no: nobody signed in may read that column of finance_accounts, and the view runs as its reader.
  if t is distinct from 'id,org_id,name,kind,bank_name,opening_balance,opening_date,active,money_in,money_out,'
       || 'balance,to_be_paid,last_import_at,unmatched_lines,created_at' then
    fails := fails || format('finance_account_balances has the columns: %s', t);
  end if;
  if has_column_privilege('authenticated', 'public.finance_accounts', 'account_no', 'select') then
    fails := array_append(fails, 'authenticated can read finance_accounts.account_no through the table');
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_bank_transactions'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,account_id,account_name,account_kind,direction,txn_date,amount,status,number,'
       || 'method,reference,notes,party_name,kind,category_name,documents,transfer_id,other_account_name,'
       || 'statement_line_id,reconciled,created_at' then
    fails := fails || format('finance_bank_transactions has the columns: %s', t);
  end if;
  foreach t in array array[
    'public.finance_record_transfer(uuid, jsonb)',
    'public.finance_void_transfer(uuid, uuid)',
    'public.finance_import_statement(uuid, uuid, text, jsonb)',
    'public.finance_next_number(uuid, text)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array[
    'private.finance_transfer_id_guard()', 'private.finance_transfer_pair_check()', 'private.finance_transaction_unmatch()',
    'private.finance_statement_line_guard()', 'private.finance_statement_import_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      fails := fails || format('a guard can be called directly: %s', t);
    end if;
  end loop;
  foreach t in array array[
    'public.finance_record_transfer(uuid, jsonb)',
    'public.finance_void_transfer(uuid, uuid)',
    'public.finance_import_statement(uuid, uuid, text, jsonb)'
  ] loop
    if has_function_privilege('service_role', t, 'execute') then fails := fails || format('service_role can execute %s', t); end if;
  end loop;
  if has_table_privilege('service_role', 'public.finance_transactions', 'insert')
     or has_table_privilege('service_role', 'public.finance_transactions', 'update')
     or has_table_privilege('service_role', 'public.finance_transactions', 'delete') then
    fails := array_append(fails, 'service_role can write finance_transactions: with no signed-in user it would pass every approval');
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname = 'finance_transfer_pair_check' and p.prosecdef
     and p.proconfig::text ilike '%search_path=%';
  if n <> 1 then fails := array_append(fails, 'the pair check does not run as its owner with a fixed search_path'); end if;
  -- The two functions that write a closed column (a payment's number, the counters) run as their owner, with
  -- a fixed search_path, and can be called by the owner and the authenticated role only.
  foreach t in array array['finance_record_transfer', 'finance_next_number'] loop
    select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = t and p.prosecdef and 'search_path=""' = any(p.proconfig);
    if n <> 1 then fails := fails || format('%s does not run as its owner with a fixed, empty search_path', t); end if;
    select string_agg(case when a.grantee = p.proowner then 'owner' when a.grantee = 0 then 'public' else a.grantee::regrole::text end
                      || '=' || a.privilege_type, ',' order by (a.grantee = p.proowner) desc, a.grantee::regrole::text)
      into ctx
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace, lateral aclexplode(p.proacl) a
     where s.nspname = 'public' and p.proname = t;
    if ctx is distinct from 'owner=EXECUTE,authenticated=EXECUTE' then
      fails := fails || format('%s can be executed by: %s', t, coalesce(ctx, 'everyone (no ACL)'));
    end if;
  end loop;
  -- The two that write no closed column still run as the caller: row-level security decides for them.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('finance_void_transfer', 'finance_import_statement')
     and not p.prosecdef and 'search_path=""' = any(p.proconfig);
  if n <> 2 then fails := array_append(fails, 'finance_void_transfer and finance_import_statement do not both run as the caller with a fixed search_path'); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_transactions'::regclass and contype = 'c'
     and conname in ('finance_transactions_amount_number_check', 'finance_transactions_transfer_number_check');
  if t is distinct from 'finance_transactions_amount_number_check,finance_transactions_transfer_number_check' then
    fails := fails || format('the two new check constraints on finance_transactions are: %s', t);
  end if;
  -- The triggers on payments: the cash book's two, the write guards' sign-off, the one that holds a payment still once
  -- it has left draft (20261117090000), the five banking adds, the two that keep money off an archived account
  -- (20261116110000), and the ledger's stamp of when a payment was voided (20261111090000).
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_transactions'::regclass;
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,finance_transaction_still,'
       || 'finance_transaction_unmatch,finance_transfer_id_guard,finance_transfer_pair_delete,finance_transfer_pair_insert,'
       || 'finance_transfer_pair_update,finance_use_account_insert,finance_use_account_update,finance_void_stamp' then
    fails := fails || format('triggers on finance_transactions are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_allocations'::regclass;
  -- finance_allocation_less_contra: 20261119100000 (contra entries).
  if t is distinct from 'finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    fails := fails || format('triggers on finance_allocations are: %s', t);
  end if;
  select count(*) into n from pg_trigger
   where not tgisinternal
     and ((tgrelid = 'public.finance_statement_lines'::regclass and tgname = 'finance_statement_line_guard')
       or (tgrelid = 'public.finance_statement_imports'::regclass and tgname = 'finance_statement_import_guard'));
  if n <> 2 then fails := fails || format('expected 2 statement guards, found %s', n); end if;
  select string_agg(indexname, ',' order by indexname) into t from pg_indexes
   where schemaname = 'public' and tablename = 'finance_transactions' and indexdef ilike 'create unique index%';
  if t is distinct from 'finance_transactions_number_key,finance_transactions_org_id_id_key,finance_transactions_pkey,'
       || 'finance_transactions_transfer_key,finance_transactions_transfer_number_key' then
    fails := fails || format('unique indexes on finance_transactions are: %s', t);
  end if;
  select indexdef into t from pg_indexes where schemaname = 'public' and indexname = 'finance_transactions_number_key';
  if t is null or t not ilike '%(org_id, number)%' or t not ilike '%transfer_id is null%' then
    fails := fails || format('the number of a payment that is no transfer is unique by: %s', t);
  end if;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@banking-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, editor_id, viewer_id, outsider, mover_id]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Banking Check Sdn Bhd'), (other_org, 'Banking Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'),
         (other_org, outsider, 'owner'),
         -- A member here who also writes in the other workspace.
         (org, mover_id, 'member'), (other_org, mover_id, 'member');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into their_bank from public.finance_accounts where org_id = other_org and kind = 'bank' order by created_at limit 1;
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' and name = 'Utilities';
  select id into sales from public.finance_categories where org_id = org and kind = 'income' and name = 'Sales';
  if bank is null or till is null or their_bank is null or utilities is null or sales is null then
    raise exception 'BENDAHARA_BANKING_CHECK cannot run: the new workspace has no accounts or categories';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  editor_claims := json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  mover_claims := json_build_object('sub', mover_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  -- A posted receipt in the other workspace, to try to match against later.
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  their_txn := public.finance_save_cash_receipt(other_org,
    jsonb_build_object('account_id', their_bank, 'method', 'fpx', 'amount', 132.50, 'party_name', 'Theirs',
      'category_id', (select id from public.finance_categories where org_id = other_org and kind = 'income' and name = 'Sales')), '[]');
  perform public.finance_post_cash_receipt(other_org, their_txn);
  reset role;

  -- ==== as the owner: accounts, and the money banking stands beside ===========
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  -- Accounts are plain rows: a writer adds and edits them.
  insert into public.finance_accounts (org_id, name, kind, bank_name, account_no)
  values (org, 'Savings', 'bank', 'Check Bank', '1234') returning id into savings;
  insert into public.finance_accounts (org_id, name, kind, active)
  values (org, 'Closed account', 'bank', false) returning id into closed;
  update public.finance_accounts set opening_balance = 1000, opening_date = current_date - 30 where id = bank;
  -- An account number is not on Banking, and not readable through the table: a writer asks for it by name.
  fails := fails || public.bendahara_banking_try('the owner reads account_no through the table', '42501',
    format('select account_no from public.finance_accounts where org_id = %L', org));
  fails := fails || public.bendahara_banking_try('the owner reads account_no through the view', '42703',
    format('select account_no from public.finance_account_balances where org_id = %L', org));
  select string_agg(account_no, ',') into t from public.finance_account_numbers(org) where account_id = savings;
  if t is distinct from '1234' then fails := fails || format('finance_account_numbers gives the owner: %s', t); end if;

  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;
  -- An invoice of RM 132.50, paid into the bank; two bills of RM 132.50, one paid from the bank.
  inv := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv);
  p_in := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 132.50)));
  bill := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill);
  bill2 := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill2);
  p_out := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 132.50)));

  -- ==== a transfer by the owner ================================================
  t1 := public.finance_record_transfer(org, jsonb_build_object(
    'from_account_id', bank, 'to_account_id', savings, 'amount', 500, 'txn_date', current_date, 'reference', 'To savings'));
  select string_agg(format('%s/%s/%s/%s/%s/%s', direction, status, number, amount, method, coalesce(approved_by::text, '-')), ' ' order by direction)
    into t from public.finance_transactions where org_id = org and transfer_id = t1;
  if t is distinct from format('in/posted/TR-0001/500.00/bank_transfer/- out/posted/TR-0001/500.00/bank_transfer/%s', owner_id) then
    fails := fails || format('a transfer by the owner reads: %s', t);
  end if;
  if (select count(*) from public.finance_transactions
       where org_id = org and transfer_id = t1
         and ((direction = 'out' and account_id = bank) or (direction = 'in' and account_id = savings))) <> 2 then
    fails := array_append(fails, 'the transfer did not leave the bank and reach savings');
  end if;
  -- Between a bank account and cash, it is recorded as cash; the number moves on.
  t2 := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 200));
  select string_agg(distinct number || '/' || method, ',') into t from public.finance_transactions where org_id = org and transfer_id = t2;
  if t is distinct from 'TR-0002/cash' then fails := fails || format('a transfer to cash reads: %s', t); end if;

  -- Neither side of a transfer is a receipt or a voucher; both are on Banking, each on its own account.
  select (select count(*) from public.finance_cash_receipts c join public.finance_transactions x on x.id = c.transaction_id where x.transfer_id is not null and c.org_id = org)
       + (select count(*) from public.finance_payment_vouchers v join public.finance_transactions x on x.id = v.transaction_id where x.transfer_id is not null and v.org_id = org) into n;
  if n <> 0 then fails := fails || format('%s sides of a transfer show in the cash book', n); end if;
  select string_agg(format('%s:%s:%s>%s', kind, direction, account_name, other_account_name), ' ' order by direction)
    into t from public.finance_bank_transactions where org_id = org and transfer_id = t1;
  if t is distinct from 'transfer:in:Savings>Main Bank transfer:out:Main Bank>Savings' then
    fails := fails || format('a transfer on Banking reads: %s', t);
  end if;

  -- Balances: opening, plus posted money in, less posted money out. A transfer moves the total nowhere.
  select string_agg(format('%s=%s', name, balance), ' ' order by name) into t from public.finance_account_balances where org_id = org;
  if t is distinct from 'Cash in hand=200.00 Closed account=0.00 Main Bank=300.00 Savings=500.00' then
    fails := fails || format('balances after two transfers: %s', t);
  end if;
  select sum(balance) into m from public.finance_account_balances where org_id = org;
  if m <> 1000.00 then fails := fails || format('the accounts add up to %s, not the 1000.00 the workspace has', m); end if;

  -- ---- what recording a transfer refuses -------------------------------------
  fails := fails || public.bendahara_banking_try('a transfer to the same account', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', bank, 'amount', 10)));
  fails := fails || public.bendahara_banking_try('a transfer of nothing', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 0)));
  fails := fails || public.bendahara_banking_try('a transfer with no amount', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings)));
  fails := fails || public.bendahara_banking_try('a transfer of NaN', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 'NaN')));
  fails := fails || public.bendahara_banking_try('a payment of NaN, by any way in', '23514',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id)
            values (%L, ''in'', %L, ''NaN'', ''cash'', %L)', org, bank, sales));
  fails := fails || public.bendahara_banking_try('a receipt of NaN through the function that was live', '23514',
    format('select public.finance_save_cash_receipt(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 'NaN', 'party_name', 'n', 'category_id', sales)));
  fails := fails || public.bendahara_banking_try('a transfer to another workspace''s account', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', their_bank, 'amount', 10)));
  fails := fails || public.bendahara_banking_try('a transfer to an archived account', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', closed, 'amount', 10)));
  select count(*) into n from public.finance_sequences where org_id = org and doc_type = 'transfer' and next_number = 3;
  if n <> 1 then fails := array_append(fails, 'a refused transfer used up a TR- number'); end if;

  -- ==== an admin may, an editor may not =======================================
  perform set_config('request.jwt.claims', admin_claims, true);
  t3 := public.finance_record_transfer(org, jsonb_build_object('from_account_id', savings, 'to_account_id', bank, 'amount', 50));
  select count(*) into n from public.finance_transactions
   where org_id = org and transfer_id = t3 and status = 'posted' and number = 'TR-0003'
     and (direction = 'in' or approved_by = admin_id);
  if n <> 2 then fails := array_append(fails, 'an admin''s transfer was not posted with the admin as approver of the money out'); end if;

  perform set_config('request.jwt.claims', editor_claims, true);
  -- The editor may write in the workspace, so the function hears them out: FIN16 for what is wrong with the
  -- transfer first, as before, then FIN14 for who they are.
  fails := fails || public.bendahara_banking_try('an editor records a transfer', 'FIN14',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 10)));
  -- The guard on payments would answer FIN14 too, one statement later, in its own words. The message is
  -- compared as well as the code, so the function's own refusal, said before it writes anything, is what is proved.
  begin
    perform public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 10));
    fails := array_append(fails, 'an editor recorded a transfer');
  exception when others then
    if sqlstate <> 'FIN14' or sqlerrm <> 'moving money between accounts needs an owner or admin' then
      fails := fails || format('an editor''s transfer is refused with %s (%s), not by the function''s own FIN14', sqlstate, sqlerrm);
    end if;
  end;
  fails := fails || public.bendahara_banking_try('an editor records a transfer to the same account', 'FIN16',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', bank, 'amount', 10)));
  select count(*) into n from public.finance_transactions where org_id = org and created_by = editor_id;
  if n <> 0 then fails := array_append(fails, 'an editor''s refused transfer left rows behind'); end if;
  -- The editor reads the balances, and reads an account number where a writer does.
  select count(*) into n from public.finance_account_balances where org_id = org;
  if n <> 4 then fails := fails || format('an editor reads %s account balances, not 4', n); end if;
  select string_agg(account_no, ',') into t from public.finance_account_numbers(org) where account_id = savings;
  if t is distinct from '1234' then fails := fails || format('finance_account_numbers gives an editor: %s', t); end if;
  -- By hand: two draft sides are only drafts. Posting them takes a number, and a payment's number is not a
  -- column anyone signed in writes (the write guards): 42501, before any trigger is asked.
  fails := fails || public.bendahara_banking_try('an editor inserts two draft sides', 'ok',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id)
            values (%L, ''out'', %L, 40, ''bank_transfer'', %L), (%L, ''in'', %L, 40, ''bank_transfer'', %L)',
      org, bank, hand, org, savings, hand));
  select count(*) into n from public.finance_transactions where org_id = org and transfer_id = hand and created_by = editor_id;
  if n <> 2 then fails := array_append(fails, 'two sides drafted by an editor are not recorded as made by them'); end if;
  fails := fails || public.bendahara_banking_try('an editor posts both sides by hand', '42501',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9001'' where org_id = %L and transfer_id = %L', org, hand));
  -- Half a transfer: a lone side can be drafted, never posted.
  fails := fails || public.bendahara_banking_try('an editor drafts a lone side', 'ok',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id)
            values (%L, ''in'', %L, 999, ''bank_transfer'', %L)', org, bank, lone));
  fails := fails || public.bendahara_banking_try('an editor posts a lone side', '42501',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9002'' where org_id = %L and transfer_id = %L', org, lone));
  -- A draft side does not carry a number: it would sit, unseen, on the number the next transfer needs.
  -- From a signed-in person the column itself is closed; the table's own rule is tried by the database owner below.
  fails := fails || public.bendahara_banking_try('a draft side is given the next TR- number', '42501',
    format('update public.finance_transactions set number = ''TR-0004'' where org_id = %L and transfer_id = %L', org, lone));
  fails := fails || public.bendahara_banking_try('a draft side is inserted with a number', '42501',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id, number)
            values (%L, ''out'', %L, 1, ''bank_transfer'', %L, ''TR-0004'')', org, bank, gen_random_uuid()));
  -- A payment does not join or leave a transfer.
  fails := fails || public.bendahara_banking_try('a draft side leaves its transfer', 'FIN16',
    format('update public.finance_transactions set transfer_id = null where org_id = %L and transfer_id = %L', org, lone));
  fails := fails || public.bendahara_banking_try('a draft side moves to another transfer', 'FIN16',
    format('update public.finance_transactions set transfer_id = %L where org_id = %L and transfer_id = %L', gen_random_uuid(), org, lone));
  fails := fails || public.bendahara_banking_try('a posted payment joins a transfer', 'FIN09',
    format('update public.finance_transactions set transfer_id = %L where id = %L', lone, p_in));
  -- A posted transfer is changed by nobody, one side or both. Voiding is a sign-off, so an editor is refused
  -- for who they are (FIN14), by the function and by hand, before the pair is looked at.
  fails := fails || public.bendahara_banking_try('an editor voids a transfer', 'FIN14',
    format('select public.finance_void_transfer(%L, %L)', org, t1));
  fails := fails || public.bendahara_banking_try('an editor voids both sides by hand', 'FIN14',
    format('update public.finance_transactions set status = ''void'' where org_id = %L and transfer_id = %L', org, t1));
  fails := fails || public.bendahara_banking_try('an editor voids one side alone', 'FIN14',
    format('update public.finance_transactions set status = ''void'' where org_id = %L and transfer_id = %L and direction = ''in''', org, t1));
  -- What is wrong with the request is still answered first, as for an owner.
  fails := fails || public.bendahara_banking_try('an editor voids a transfer that is not there', 'FIN11',
    format('select public.finance_void_transfer(%L, %L)', org, gen_random_uuid()));
  fails := fails || public.bendahara_banking_try('the amount of a posted transfer is changed', 'FIN09',
    format('update public.finance_transactions set amount = 1 where org_id = %L and transfer_id = %L', org, t1));
  fails := fails || public.bendahara_banking_try('a side of a posted transfer is deleted', 'FIN09',
    format('delete from public.finance_transactions where org_id = %L and transfer_id = %L and direction = ''in''', org, t1));
  select count(*) into n from public.finance_transactions where org_id = org and transfer_id = t1 and status = 'posted' and amount = 500;
  if n <> 2 then fails := array_append(fails, 'a refused change to a transfer left a mark'); end if;

  -- ==== as the owner: half a transfer is not voided, and nothing is posted by hand =
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_banking_try('one side of a posted transfer is voided alone', 'FIN16',
    format('update public.finance_transactions set status = ''void'' where org_id = %L and transfer_id = %L and direction = ''in''', org, t1));
  fails := fails || public.bendahara_banking_try('the other side is voided alone', 'FIN16',
    format('update public.finance_transactions set status = ''void'' where org_id = %L and transfer_id = %L and direction = ''out''', org, t1));
  select count(*) into n from public.finance_transactions where org_id = org and transfer_id = t1 and status = 'posted';
  if n <> 2 then fails := array_append(fails, 'half a void of a transfer left a mark'); end if;
  -- Even the owner: a number is the database's to write, and a payment is not posted without one.
  fails := fails || public.bendahara_banking_try('the owner posts a well-made pair by hand', '42501',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9001'' where org_id = %L and transfer_id = %L', org, hand));
  fails := fails || public.bendahara_banking_try('the owner posts a well-made pair with no number', '23514',
    format('update public.finance_transactions set status = ''posted'' where org_id = %L and transfer_id = %L', org, hand));
  -- The one function that posts money in for a person takes a payment's id and writes its number as the
  -- owner of the table. Pointed at a side of a transfer it is stopped by the pair check and by nothing else,
  -- and the RC- number it took is given back with the refusal.
  select coalesce(max(next_number), 0) into counter from public.finance_sequences where org_id = org and doc_type = 'receipt';
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id, category_id)
  values (org, 'in', bank, 77, 'bank_transfer', gen_random_uuid(), sales) returning id into side;
  fails := fails || public.bendahara_banking_try('the owner posts a lone side of a transfer as a receipt', 'FIN16',
    format('select public.finance_post_cash_receipt(%L, %L)', org, side));
  delete from public.finance_transactions where id = side;
  select id into side from public.finance_transactions where org_id = org and transfer_id = hand and direction = 'in';
  update public.finance_transactions set category_id = sales where id = side;
  fails := fails || public.bendahara_banking_try('the owner posts the money-in side of a drafted pair as a receipt', 'FIN16',
    format('select public.finance_post_cash_receipt(%L, %L)', org, side));
  update public.finance_transactions set category_id = null where id = side;
  select count(*) into n from public.finance_transactions
   where org_id = org and transfer_id is not null and status = 'draft' and number is null and category_id is null;
  if n <> 3 then fails := fails || format('after a side was refused as a receipt, %s draft sides are as they were, not 3', n); end if;
  select coalesce(max(next_number), 0) - counter into n from public.finance_sequences where org_id = org and doc_type = 'receipt';
  if n <> 0 then fails := fails || format('a side of a transfer refused as a receipt used up %s RC- numbers', n); end if;

  -- ==== by the database owner: a pair made by hand must match to be posted =====
  -- The role that runs this script owns the tables, so the column grants do not
  -- bind it. The workspace's owner is still the person in the claims, so the
  -- guards and the sign-off trigger answer as they would for them.
  reset role;
  -- The table's own rules about a number on a side of a transfer.
  fails := fails || public.bendahara_banking_try('a draft side is given the next TR- number, by the database owner', '23514',
    format('update public.finance_transactions set number = ''TR-0004'' where org_id = %L and transfer_id = %L', org, lone));
  fails := fails || public.bendahara_banking_try('a side is inserted with a number, by the database owner', 'FIN09',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id, number)
            values (%L, ''out'', %L, 1, ''bank_transfer'', %L, ''TR-0004'')', org, bank, gen_random_uuid()));
  fails := fails || public.bendahara_banking_try('only the money in is posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9001''
             where org_id = %L and transfer_id = %L and direction = ''in''', org, hand));
  fails := fails || public.bendahara_banking_try('a well-made pair is posted by hand', 'ok',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9001'' where org_id = %L and transfer_id = %L', org, hand));
  select count(*) into n from public.finance_transactions where org_id = org and transfer_id = hand and status = 'posted';
  if n <> 2 then fails := array_append(fails, 'a well-made pair was not posted'); end if;
  select string_agg(format('%s/%s', direction, coalesce(approved_by::text, '-')), ' ' order by direction)
    into t from public.finance_transactions where org_id = org and transfer_id = hand;
  if t is distinct from format('in/- out/%s', owner_id) then
    fails := fails || format('a pair posted by hand with the owner in the claims is approved by: %s', t);
  end if;
  fails := fails || public.bendahara_banking_try('a lone side is posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9002'' where org_id = %L and transfer_id = %L', org, lone));
  delete from public.finance_transactions where org_id = org and transfer_id = lone;
  -- Two sides that do not match: different amounts.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id)
  values (org, 'out', bank, 30, 'bank_transfer', bad), (org, 'in', savings, 31, 'bank_transfer', bad);
  fails := fails || public.bendahara_banking_try('two sides of different amounts are posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  update public.finance_transactions set amount = 30 where org_id = org and transfer_id = bad and direction = 'in';
  -- The same account at both ends.
  update public.finance_transactions set account_id = bank where org_id = org and transfer_id = bad and direction = 'in';
  fails := fails || public.bendahara_banking_try('two sides on one account are posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  update public.finance_transactions set account_id = savings where org_id = org and transfer_id = bad and direction = 'in';
  -- Different dates.
  update public.finance_transactions set txn_date = current_date - 1 where org_id = org and transfer_id = bad and direction = 'in';
  fails := fails || public.bendahara_banking_try('two sides on different dates are posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  update public.finance_transactions set txn_date = current_date where org_id = org and transfer_id = bad and direction = 'in';
  -- A side that names a payee, or a category.
  update public.finance_transactions set party_name = 'Somebody' where org_id = org and transfer_id = bad and direction = 'out';
  fails := fails || public.bendahara_banking_try('a transfer that names a payee is posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  update public.finance_transactions set party_name = null, contact_id = sup where org_id = org and transfer_id = bad and direction = 'out';
  fails := fails || public.bendahara_banking_try('a transfer that names a contact is posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  update public.finance_transactions set contact_id = null, category_id = utilities where org_id = org and transfer_id = bad and direction = 'out';
  fails := fails || public.bendahara_banking_try('a transfer that carries a category is posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  update public.finance_transactions set category_id = null where org_id = org and transfer_id = bad and direction = 'out';
  -- A side that is split against a bill: it would be a payment to a supplier and a transfer at once.
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount)
  select org, id, bill2, 30 from public.finance_transactions where org_id = org and transfer_id = bad and direction = 'out';
  fails := fails || public.bendahara_banking_try('a transfer that pays a bill is posted', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  delete from public.finance_allocations where org_id = org and bill_id = bill2;
  -- Two numbers.
  fails := fails || public.bendahara_banking_try('two sides are posted under two numbers', 'FIN16',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' || direction where org_id = %L and transfer_id = %L', org, bad));
  -- Scheduled is not a state a transfer has.
  fails := fails || public.bendahara_banking_try('a transfer is scheduled', 'FIN16',
    format('update public.finance_transactions set status = ''scheduled'' where org_id = %L and transfer_id = %L', org, bad));
  -- Put right, it posts.
  fails := fails || public.bendahara_banking_try('the pair, put right, is posted', 'ok',
    format('update public.finance_transactions set status = ''posted'', number = ''TR-9003'' where org_id = %L and transfer_id = %L', org, bad));
  -- A number is still unique among payments that are no transfer, and a third side cannot join.
  fails := fails || public.bendahara_banking_try('a third side joins a transfer', '23505',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id)
            values (%L, ''in'', %L, 30, ''bank_transfer'', %L)', org, till, bad));
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id)
  values (org, 'in', bank, 5, 'cash', sales) returning id into stray;
  select number into no from public.finance_transactions where id = p_in;
  fails := fails || public.bendahara_banking_try('a receipt takes a number another receipt has', '23505',
    format('update public.finance_transactions set status = ''posted'', number = %L where id = %L', no, stray));
  delete from public.finance_transactions where id = stray;

  -- ==== voiding a transfer: the owner, signed in again ==========================
  set local role authenticated;
  fails := fails || public.bendahara_banking_try('a transfer that is not there is voided', 'FIN11',
    format('select public.finance_void_transfer(%L, %L)', org, gen_random_uuid()));
  fails := fails || public.bendahara_banking_try('another workspace''s transfer is voided', 'FIN11',
    format('select public.finance_void_transfer(%L, %L)', other_org, t1));
  perform public.finance_void_transfer(org, hand);
  perform public.finance_void_transfer(org, bad);
  fails := fails || public.bendahara_banking_try('a voided transfer is voided again', 'FIN09',
    format('select public.finance_void_transfer(%L, %L)', org, hand));
  select string_agg(format('%s=%s', name, balance), ' ' order by name) into t from public.finance_account_balances where org_id = org;
  if t is distinct from 'Cash in hand=200.00 Closed account=0.00 Main Bank=350.00 Savings=450.00' then
    fails := fails || format('balances after voiding the hand-made transfers: %s', t);
  end if;

  -- ==== a statement is imported ================================================
  imp := public.finance_import_statement(org, bank, 'check.csv', jsonb_build_array(
    jsonb_build_object('line_date', current_date, 'description', 'IBG CHECK CUSTOMER', 'money_in', 132.50),
    jsonb_build_object('line_date', current_date + 1, 'description', 'FPX CHECK SUPPLIER', 'money_out', 132.50),
    jsonb_build_object('line_date', current_date, 'description', 'TRF TO SAVINGS', 'money_out', 500),
    jsonb_build_object('line_date', current_date, 'description', 'SERVICE CHARGE', 'money_out', 25, 'money_in', 0),
    jsonb_build_object('line_date', current_date, 'description', 'PROFIT PAID', 'money_in', 1.10),
    jsonb_build_object('line_date', current_date, 'description', 'IBG CHECK CUSTOMER AGAIN', 'money_in', 132.50),
    jsonb_build_object('line_date', current_date, 'description', 'CASH DEPOSIT', 'money_in', 200)));
  select id into l_in from public.finance_statement_lines where import_id = imp and position = 1;
  select id into l_out from public.finance_statement_lines where import_id = imp and position = 2;
  select id into l_transfer from public.finance_statement_lines where import_id = imp and position = 3;
  select id into l_charge from public.finance_statement_lines where import_id = imp and position = 4;
  select id into l_interest from public.finance_statement_lines where import_id = imp and position = 5;
  select id into l_again from public.finance_statement_lines where import_id = imp and position = 6;
  select id into l_cash from public.finance_statement_lines where import_id = imp and position = 7;
  select count(*) into n from public.finance_statement_lines
   where org_id = org and import_id = imp and transaction_id is null and account_id = bank;
  if n <> 7 or l_cash is null then fails := fails || format('an import of seven lines stored %s unmatched lines', n); end if;
  select created_by::text || '/' || file_name into t from public.finance_statement_imports where id = imp;
  if t is distinct from owner_id::text || '/check.csv' then fails := fails || format('the import reads: %s', t); end if;
  select format('%s/%s', unmatched_lines, last_import_at is not null) into t from public.finance_account_balances where id = bank;
  if t is distinct from '7/t' then fails := fails || format('the bank account after an import reads: %s', t); end if;
  select format('%s/%s', unmatched_lines, last_import_at is not null) into t from public.finance_account_balances where id = savings;
  if t is distinct from '0/f' then fails := fails || format('an account with no import reads: %s', t); end if;

  -- ---- what an import refuses -------------------------------------------------
  fails := fails || public.bendahara_banking_try('an import with no lines', 'FIN17',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', ''[]'')', org, bank));
  fails := fails || public.bendahara_banking_try('an import of 1,001 lines', 'FIN17',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      (select jsonb_agg(jsonb_build_object('line_date', current_date, 'description', 'x', 'money_in', 1)) from generate_series(1, 1001))));
  fails := fails || public.bendahara_banking_try('a line with money in and money out', '23514',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'money_in', 5, 'money_out', 5))));
  fails := fails || public.bendahara_banking_try('a line with neither', '23514',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'description', 'x'))));
  fails := fails || public.bendahara_banking_try('a line of NaN', 'FIN17',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'money_in', 'NaN'))));
  fails := fails || public.bendahara_banking_try('a line of NaN put in by hand', '23514',
    format('insert into public.finance_statement_lines (org_id, import_id, account_id, position, line_date, money_in)
            values (%L, %L, %L, 98, current_date, ''NaN'')', org, imp, bank));
  fails := fails || public.bendahara_banking_try('a line with no date', '23502',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('description', 'x', 'money_in', 5))));
  fails := fails || public.bendahara_banking_try('a statement for another workspace''s account', '23503',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, their_bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'money_in', 5))));
  fails := fails || public.bendahara_banking_try('a line put in already matched', 'FIN17',
    format('insert into public.finance_statement_lines (org_id, import_id, account_id, position, line_date, money_in, transaction_id)
            values (%L, %L, %L, 99, current_date, 132.50, %L)', org, imp, bank, p_in));
  fails := fails || public.bendahara_banking_try('a line put on another account than its import', '23503',
    format('insert into public.finance_statement_lines (org_id, import_id, account_id, position, line_date, money_in)
            values (%L, %L, %L, 99, current_date, 5)', org, imp, savings));
  select count(*) into n from public.finance_statement_imports where org_id = org;
  if n <> 1 then fails := fails || format('refused imports left %s import rows, not 1', n); end if;

  -- ==== matching: an editor may, and what the guard holds a match to ==========
  perform set_config('request.jwt.claims', editor_claims, true);
  update public.finance_statement_lines set transaction_id = p_in where id = l_in;
  select format('%s/%s', reconciled, statement_line_id = l_in) into t from public.finance_bank_transactions where transaction_id = p_in;
  if t is distinct from 't/t' then fails := fails || format('a matched payment in reads: %s', t); end if;
  select count(*) into n from public.finance_bank_transactions where org_id = org and reconciled;
  if n <> 1 then fails := fails || format('%s movements read as reconciled, not 1', n); end if;
  fails := fails || public.bendahara_banking_try('money out on the statement is matched to money in', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', p_in, l_out));
  fails := fails || public.bendahara_banking_try('a line is matched to a payment of another amount', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', p_out, l_charge));
  -- RM 200 did come in, but into the cash account: this line is the bank's.
  fails := fails || public.bendahara_banking_try('a line is matched to a payment on another account', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = (select id from public.finance_transactions
             where org_id = %L and transfer_id = %L and direction = ''in'') where id = %L', org, t2, l_cash));
  fails := fails || public.bendahara_banking_try('a line is matched to another workspace''s payment', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', their_txn, l_in));
  fails := fails || public.bendahara_banking_try('a second line is matched to a payment that has one', '23505',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', p_in, l_again));
  fails := fails || public.bendahara_banking_try('a line''s amount is changed', 'FIN17',
    format('update public.finance_statement_lines set money_in = 1 where id = %L', l_in));
  fails := fails || public.bendahara_banking_try('a line''s date is changed', 'FIN17',
    format('update public.finance_statement_lines set line_date = current_date - 9 where id = %L', l_out));
  fails := fails || public.bendahara_banking_try('a line moves to another workspace', 'FIN17',
    format('update public.finance_statement_lines set org_id = %L where id = %L', other_org, l_out));
  fails := fails || public.bendahara_banking_try('an import moves to another account', 'FIN17',
    format('update public.finance_statement_imports set account_id = %L where id = %L', savings, imp));
  fails := fails || public.bendahara_banking_try('a matched line is deleted', 'FIN17',
    format('delete from public.finance_statement_lines where id = %L', l_in));
  fails := fails || public.bendahara_banking_try('an import with a matched line is deleted', 'FIN17',
    format('delete from public.finance_statement_imports where id = %L', imp));
  -- A day apart is still a match: how far apart is for whoever proposes it.
  fails := fails || public.bendahara_banking_try('a line is matched to the payment out a day before it', 'ok',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', p_out, l_out));
  -- The side of a transfer that left this account.
  fails := fails || public.bendahara_banking_try('a line is matched to the side of a transfer on its account', 'ok',
    format('update public.finance_statement_lines set transaction_id = (select id from public.finance_transactions
             where org_id = %L and transfer_id = %L and direction = ''out'') where id = %L', org, t1, l_transfer));
  -- Unmatching is a plain update too.
  update public.finance_statement_lines set transaction_id = null where id = l_in;
  update public.finance_statement_lines set transaction_id = p_in where id = l_in;
  select count(*) into n from public.finance_bank_transactions where org_id = org and reconciled;
  if n <> 3 then fails := fails || format('%s movements read as reconciled, not 3', n); end if;

  -- ==== an import with no lines stays where it is ==============================
  -- Nothing but the guard holds an import that has no lines yet.
  perform set_config('request.jwt.claims', mover_claims, true);
  insert into public.finance_statement_imports (org_id, account_id, file_name) values (org, bank, 'empty.csv') returning id into empty_import;
  fails := fails || public.bendahara_banking_try('an import with no lines moves to another workspace', 'FIN17',
    format('update public.finance_statement_imports set org_id = %L, account_id = %L where id = %L', other_org, their_bank, empty_import));
  delete from public.finance_statement_imports where id = empty_import;
  perform set_config('request.jwt.claims', editor_claims, true);

  -- ==== a void takes the match with it =========================================
  -- Voiding is a sign-off: the editor who matched the lines cannot, and their try unmatches nothing.
  fails := fails || public.bendahara_banking_try('an editor voids a matched transfer', 'FIN14',
    format('select public.finance_void_transfer(%L, %L)', org, t1));
  fails := fails || public.bendahara_banking_try('an editor voids a matched payment out', 'FIN14',
    format('update public.finance_transactions set status = ''void'', updated_at = now() where org_id = %L and id = %L', org, p_out));
  select count(*) into n from public.finance_statement_lines where id in (l_transfer, l_out) and transaction_id is not null;
  if n <> 2 then fails := array_append(fails, 'a refused void unmatched a statement line'); end if;
  perform set_config('request.jwt.claims', admin_claims, true);
  perform public.finance_void_transfer(org, t1);
  select count(*) into n from public.finance_statement_lines where id = l_transfer and transaction_id is null;
  if n <> 1 then fails := array_append(fails, 'voiding a transfer left its statement line matched'); end if;
  update public.finance_transactions set status = 'void', updated_at = now() where org_id = org and id = p_out;
  select count(*) into n from public.finance_statement_lines where id = l_out and transaction_id is null;
  if n <> 1 then fails := array_append(fails, 'voiding a payment out left its statement line matched'); end if;
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_banking_try('a line is matched to a voided payment', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', p_out, l_out));
  select string_agg(format('%s=%s', name, balance), ' ' order by name) into t from public.finance_account_balances where org_id = org;
  if t is distinct from 'Cash in hand=200.00 Closed account=0.00 Main Bank=982.50 Savings=-50.00' then
    fails := fails || format('balances after the voids: %s', t);
  end if;

  -- ==== a bank charge and interest: no way round approval =====================
  -- The bank took RM 25. Recorded by an editor it is money out that settles no
  -- document, so it waits for an owner or admin like any other, and a line
  -- cannot be matched to it until it is paid.
  charge := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer', 'amount', 25, 'party_name', 'Check Bank', 'category_id', utilities), '[]');
  select status into t from public.finance_transactions where id = charge;
  if t is distinct from 'pending_approval' then fails := fails || format('an editor''s bank charge is %s, not waiting for approval', t); end if;
  fails := fails || public.bendahara_banking_try('a line is matched to a charge that is waiting for approval', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', charge, l_charge));
  fails := fails || public.bendahara_banking_try('an editor approves their own bank charge', 'FIN14',
    format('update public.finance_transactions set status = ''scheduled'', updated_at = now() where id = %L', charge));
  -- Paying it by hand takes a number, which nobody signed in writes.
  fails := fails || public.bendahara_banking_try('an editor pays their own bank charge by hand', '42501',
    format('update public.finance_transactions set status = ''posted'', number = ''PV-9001'' where id = %L', charge));
  perform set_config('request.jwt.claims', admin_claims, true);
  update public.finance_transactions set status = 'scheduled', updated_at = now() where id = charge;
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_banking_try('a line is matched to a charge that is still to be paid', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', charge, l_charge));
  -- Paying is a sign-off: the admin who approved it pays it, and the editor matches the line.
  fails := fails || public.bendahara_banking_try('an editor marks the approved charge paid', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, charge));
  perform set_config('request.jwt.claims', admin_claims, true);
  perform public.finance_mark_payment_paid(org, charge, current_date);
  perform set_config('request.jwt.claims', editor_claims, true);
  update public.finance_statement_lines set transaction_id = charge where id = l_charge;
  -- Interest is money in for an income category: an editor records it as a draft, and posting it is a sign-off.
  interest := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer', 'amount', 1.10, 'party_name', 'Check Bank', 'category_id', sales), '[]');
  fails := fails || public.bendahara_banking_try('an editor posts the interest they recorded', 'FIN14',
    format('select public.finance_post_cash_receipt(%L, %L)', org, interest));
  fails := fails || public.bendahara_banking_try('a line is matched to interest that is still a draft', 'FIN17',
    format('update public.finance_statement_lines set transaction_id = %L where id = %L', interest, l_interest));
  perform set_config('request.jwt.claims', admin_claims, true);
  perform public.finance_post_cash_receipt(org, interest);
  perform set_config('request.jwt.claims', editor_claims, true);
  update public.finance_statement_lines set transaction_id = interest where id = l_interest;
  select format('%s/%s', unmatched_lines, balance) into t from public.finance_account_balances where id = bank;
  if t is distinct from '4/958.60' then fails := fails || format('the bank account after the charge and the interest reads: %s', t); end if;
  select string_agg(format('%s:%s', kind, reconciled), ' ' order by kind) into t
    from public.finance_bank_transactions where transaction_id in (charge, interest, p_in, p_out);
  if t is distinct from 'bill:f income:t invoice:t other:t' then
    fails := fails || format('what each movement is and whether it is reconciled: %s', t);
  end if;

  -- ==== every movement of money is on Banking once ============================
  select (select count(*) from public.finance_bank_transactions where org_id = org)
       - (select count(*) from public.finance_transactions where org_id = org),
         (select count(*) - count(distinct transaction_id) from public.finance_bank_transactions where org_id = org)
    into n, m;
  if (n, m) is distinct from (0, 0::numeric) then fails := fails || format('Banking is %s rows out and repeats %s', n, m); end if;
  select sum(case when direction = 'in' then amount else -amount end) into m
    from public.finance_bank_transactions where org_id = org and status = 'posted';
  if m + 1000 is distinct from (select sum(balance) from public.finance_account_balances where org_id = org) then
    fails := fails || format('posted movements on Banking come to %s, and the balances do not agree', m);
  end if;
  select string_agg(kind || '=' || c, ', ' order by kind) into t
    from (select kind, count(*) c from public.finance_bank_transactions where org_id = org group by 1) k;
  if t is distinct from 'bill=1, income=1, invoice=1, other=1, transfer=10' then fails := fails || format('movements by kind: %s', t); end if;

  -- ==== the viewer reads and changes nothing ==================================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select (select count(*) from public.finance_account_balances where org_id = org)
       + (select count(*) from public.finance_bank_transactions where org_id = org)
       + (select count(*) from public.finance_statement_lines where org_id = org) into n;
  if n <> 4 + 14 + 7 then fails := fails || format('a viewer reads %s banking rows, not 25', n); end if;
  select string_agg(format('%s=%s', name, balance), ' ' order by name) into t from public.finance_account_balances where org_id = org;
  if t is distinct from 'Cash in hand=200.00 Closed account=0.00 Main Bank=958.60 Savings=-50.00' then
    fails := fails || format('a viewer reads the balances: %s', t);
  end if;
  -- A viewer is not a writer: no account number, and the transfer function does not hear them out.
  select count(*) into n from public.finance_account_numbers(org);
  if n <> 0 then fails := fails || format('finance_account_numbers gives a viewer %s rows', n); end if;
  fails := fails || public.bendahara_banking_try('a viewer records a transfer', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 10)));
  fails := fails || public.bendahara_banking_try('a viewer records a transfer to the same account', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', bank, 'amount', 10)));
  fails := fails || public.bendahara_banking_try('a viewer imports a statement', '42501',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'money_in', 5))));
  fails := fails || public.bendahara_banking_try('a viewer inserts an import by hand', '42501',
    format('insert into public.finance_statement_imports (org_id, account_id, file_name) values (%L, %L, ''v.csv'')', org, bank));
  fails := fails || public.bendahara_banking_try('a viewer voids a transfer', 'FIN11',
    format('select public.finance_void_transfer(%L, %L)', org, t2));
  update public.finance_statement_lines set transaction_id = null where org_id = org;
  delete from public.finance_statement_lines where org_id = org;
  update public.finance_accounts set opening_balance = 5 where org_id = org;
  reset role;
  select (select count(*) from public.finance_statement_lines where org_id = org and transaction_id is not null)
       + (select count(*) from public.finance_accounts where org_id = org and opening_balance = 5)
       + (select count(*) from public.finance_transactions where org_id = org and transfer_id = t2 and status <> 'posted') into n;
  if n <> 3 then fails := fails || format('a viewer''s writes left %s marks, not the 3 matched lines alone', n); end if;

  -- ==== the outsider sees nothing =============================================
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select (select count(*) from public.finance_account_balances where org_id = org)
       + (select count(*) from public.finance_bank_transactions where org_id = org)
       + (select count(*) from public.finance_statement_imports where org_id = org)
       + (select count(*) from public.finance_statement_lines where org_id = org) into n;
  if n <> 0 then fails := fails || format('an outsider reads %s banking rows', n); end if;
  fails := fails || public.bendahara_banking_try('an outsider imports a statement into the workspace', '42501',
    format('select public.finance_import_statement(%L, %L, ''x.csv'', %L)', org, bank,
      jsonb_build_array(jsonb_build_object('line_date', current_date, 'money_in', 5))));
  -- The function runs as its owner and would find the accounts: its own test of the caller is what stops this.
  fails := fails || public.bendahara_banking_try('an outsider records a transfer in the workspace', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 10)));
  fails := fails || public.bendahara_banking_try('an outsider voids a transfer in the workspace', 'FIN11',
    format('select public.finance_void_transfer(%L, %L)', org, t2));
  reset role;

  -- ==== nobody signed in =======================================================
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select (select count(*) from public.finance_account_balances) + (select count(*) from public.finance_bank_transactions)
       + (select count(*) from public.finance_statement_lines) into n;
  if n <> 0 then fails := fails || format('a session that names no user reads %s banking rows', n); end if;
  -- "Nobody is signed in" passes the approval rule (it is how a migration writes), so the test of the caller
  -- that comes before it is what keeps such a session out.
  fails := fails || public.bendahara_banking_try('a session that names no user records a transfer', '42501',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', savings, 'amount', 10)));
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into n from public.finance_transactions where org_id = org and transfer_id is not null;
  if n <> 10 then fails := fails || format('refused transfers left %s sides of a transfer, not 10', n); end if;

  -- ==== a user is deleted by a role with no rights on public tables ============
  -- Supabase Auth deletes users as a role that can read and delete auth.users
  -- and nothing in public. The foreign keys clear created_by and approved_by
  -- as each table's owner, but the statement triggers on payments run at the
  -- end of the delete as that role. The admin recorded a transfer (t3).
  -- If the role cannot be made or used here, or the delete is stopped by
  -- something that is not finance's, the message says so.
  begin
    create role bendahara_banking_auth_role nologin;
    grant bendahara_banking_auth_role to current_user;
    grant usage on schema auth to bendahara_banking_auth_role;
    grant select, delete on auth.users to bendahara_banking_auth_role;
    set local role bendahara_banking_auth_role;
    delete from auth.users where id = admin_id;
    reset role;
    select count(*) into n from public.finance_transactions
     where org_id = org and transfer_id = t3 and status = 'posted' and created_by is null and approved_by is null;
    if n <> 2 then fails := array_append(fails, 'a user deleted by the auth role was not cleared from the transfer they recorded'); end if;
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    reset role;
    if sqlstate like 'FIN%' or ctx ilike '%finance_%' or sqlerrm ilike '%finance_%' then
      fails := fails || format('a user who recorded a transfer cannot be deleted by a role with no rights on public: %s %s', sqlstate, sqlerrm);
    else
      notes := array_append(notes, format('the delete by a role with no rights on public was not tried to the end (%s: %s)', sqlstate, sqlerrm));
    end if;
  end;

  -- ==== a user is deleted: the transfer they approved and the import they made stay
  -- If the delete is stopped by something outside finance, the clearing its
  -- foreign keys would have done is done by hand, and the message says so.
  begin
    delete from auth.users where id = owner_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so their name was cleared by hand', sqlstate, sqlerrm));
    update public.finance_transactions set created_by = null where created_by = owner_id;
    update public.finance_transactions set approved_by = null where approved_by = owner_id;
    update public.finance_invoices set created_by = null where created_by = owner_id;
    update public.finance_statement_imports set created_by = null where created_by = owner_id;
  end;
  select (select count(*) from public.finance_transactions where org_id = org and transfer_id = t2 and status = 'posted'
            and created_by is null and approved_by is null)
       + (select count(*) from public.finance_statement_imports where id = imp and created_by is null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear them from a transfer''s two sides and an import'); end if;

  -- ==== the workspace is deleted, with everything in it =======================
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_statement_lines where org_id = org)
       + (select count(*) from public.finance_statement_imports where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_accounts where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s banking rows', n); end if;
  delete from public.orgs where id = other_org;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_BANKING_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_BANKING_CHECK FAILED: %', array_to_string(fails, ' | ');
 exception when others then
  if sqlerrm like 'BENDAHARA_BANKING_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_BANKING_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
 end;
end $$;
