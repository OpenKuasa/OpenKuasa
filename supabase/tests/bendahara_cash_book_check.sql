-- Brought up to date with 20261030123000_finance_write_guards, which it now
-- needs. A statement that writes a payment's `number`, `approved_by`,
-- `approved_at` or `created_by` straight to finance_transactions as a
-- signed-in person is expected to answer 42501 (the column is not writable);
-- where the rule it proved was a guard's, the same statement without the
-- closed column is tried too and still expects the guard's code. What the
-- editor (role `member`) posts, pays or voids, a cash receipt and a voucher
-- for approved expenses included, is expected to answer FIN14, and an admin
-- then does it, so the numbers and totals further down are what they were.
-- Bendahara cash book check. Run it after
-- 20261028100000_bendahara_cash_book.sql, in the same transaction for a dry
-- run, or by itself once the migration is applied. It goes through expenses,
-- payment vouchers, cash receipts and the approval rules as an owner, an
-- admin, an editor, a viewer, an outsider and an editor who owns another
-- workspace, and checks that the two cash book views
-- list every movement of money once. The invoice, bill, quotation, credit
-- note and refund flows are the business of bendahara_followons_check.sql and
-- bendahara_invoices_check.sql, which must still pass beside this one. It
-- leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_CASH_BOOK_CHECK PASSED ...   or   BENDAHARA_CASH_BOOK_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
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
  their_bank uuid;
  their_rent uuid;
  owner_claims text;
  admin_claims text;
  editor_claims text;
  ex5 uuid := gen_random_uuid();
  ex6 uuid;
  v6 uuid;
  v7 uuid;
  bank uuid;
  till uuid;
  rent uuid;
  utilities uuid;
  sales uuid;
  cust uuid;
  cust2 uuid;
  sup uuid;
  inv uuid;
  inv2 uuid;
  inv3 uuid;
  bill1 uuid;
  bill2 uuid;
  cn uuid;
  ex1 uuid;
  ex2 uuid;
  ex3 uuid;
  ex4 uuid;
  theirs uuid;
  p1 uuid;
  p2 uuid;
  v1 uuid;
  v2 uuid;
  v3 uuid;
  v4 uuid;
  v5 uuid;
  r1 uuid;
  r2 uuid;
  r3 uuid;
  cn2 uuid;
  pay uuid;
  rf uuid;
  stray uuid;
  no text;
  n integer;
  m integer;
  t text;
  r record;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  notes text[] := '{}';
begin
  -- ---- a helper, rolled back with everything else -------------------------
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way ('ok' or a SQLSTATE), or a sentence for the report.
  execute $f$
    create function public.bendahara_check_try(label text, want text, q text) returns text
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'finance_expenses';
  if n <> 5 then fails := fails || format('expected 5 policies on finance_expenses, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'finance_expenses' and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 1 then fails := array_append(fails, 'finance_expenses has no restrictive mfa_required policy'); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'finance_expenses' and c.relrowsecurity;
  if n <> 1 then fails := array_append(fails, 'row-level security is not enabled on finance_expenses'); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('finance_cash_receipts','finance_payment_vouchers','finance_expense_totals',
                       'finance_invoice_totals','finance_payments_in','finance_payments_out','supplier_bill_totals',
                       'finance_quotation_totals','finance_credit_note_totals','finance_refunds')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 10 then fails := fails || format('expected 10 security_invoker views, found %s', n); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and contype = 'c';
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_one_document_check,finance_allocations_reason_check' then
    fails := fails || format('check constraints on finance_allocations are: %s', t);
  end if;
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and conname = 'finance_allocations_one_document_check';
  if t is null or t not ilike '%bill_id, invoice_id, credit_note_id, expense_id%' then
    fails := fails || format('an allocation names one document of: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_cash_receipts'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,account_name,'
       || 'account_kind,contact_id,party_name,kind,category_id,category_name,documents,created_by,created_at' then
    fails := fails || format('finance_cash_receipts has the columns: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_payment_vouchers'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'transaction_id,org_id,number,txn_date,method,amount,status,reference,notes,account_id,account_name,'
       || 'account_kind,contact_id,party_name,kind,category_id,category_name,documents,approved_at,created_by,created_at' then
    fails := fails || format('finance_payment_vouchers has the columns: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_expense_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,expense_date,category_id,category_name,vendor_id,vendor_name,amount,sst_amount,notes,status,'
       || 'approved_by,approved_at,created_by,created_at,updated_at,paid,held,display_status,method,paid_on' then
    fails := fails || format('finance_expense_totals has the columns: %s', t);
  end if;
  foreach t in array array[
    'public.finance_mark_payment_paid(uuid, uuid, date)',
    'public.finance_save_cash_receipt(uuid, jsonb, jsonb)',
    'public.finance_post_cash_receipt(uuid, uuid)',
    'public.finance_record_voucher(uuid, jsonb, jsonb)',
    'public.finance_save_expense(uuid, jsonb)',
    'public.finance_record_payment_out(uuid, jsonb, jsonb)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)',
    'public.finance_record_refund(uuid, jsonb)',
    'private.finance_may_decide(uuid)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array[
    'private.finance_expense_guard()', 'private.finance_transaction_insert_guard()',
    'private.finance_transaction_guard()', 'private.finance_allocation_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      fails := fails || format('a guard can be called directly: %s', t);
    end if;
  end loop;
  foreach t in array array['finance_expenses','finance_cash_receipts','finance_payment_vouchers','finance_expense_totals'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then fails := fails || format('authenticated cannot read %s', t); end if;
    if has_table_privilege('service_role', 'public.' || t, 'select') then fails := fails || format('service_role was granted %s', t); end if;
  end loop;
  if has_table_privilege('service_role', 'public.finance_expenses', 'insert')
     or has_table_privilege('service_role', 'public.finance_expenses', 'update')
     or has_table_privilege('service_role', 'public.finance_expenses', 'delete') then
    fails := array_append(fails, 'service_role can write finance_expenses');
  end if;
  select count(*) into n from pg_trigger
   where not tgisinternal
     and ((tgrelid = 'public.finance_expenses'::regclass and tgname = 'finance_expense_guard')
       or (tgrelid = 'public.finance_transactions'::regclass and tgname in ('finance_transaction_guard','finance_transaction_insert_guard'))
       or (tgrelid = 'public.finance_allocations'::regclass and tgname = 'finance_allocation_guard'));
  if n <> 4 then fails := fails || format('expected 4 guard triggers, found %s', n); end if;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@cash-book-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, editor_id, viewer_id, outsider, mover_id]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Cash Book Check Sdn Bhd'), (other_org, 'Cash Book Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'),
         (other_org, outsider, 'owner'),
         -- An editor here who owns the other workspace: what they may decide there, they may not decide here.
         (other_org, mover_id, 'owner'), (org, mover_id, 'member');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' and name = 'Rent';
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' and name = 'Utilities';
  select id into sales from public.finance_categories where org_id = org and kind = 'income' and name = 'Sales';
  if bank is null or till is null or rent is null or utilities is null or sales is null then
    raise exception 'BENDAHARA_CASH_BOOK_CHECK cannot run: the new workspace has no accounts or categories';
  end if;
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  editor_claims := json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  mover_claims := json_build_object('sub', mover_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into their_bank from public.finance_accounts where org_id = other_org and kind = 'bank' order by created_at limit 1;
  select id into their_rent from public.finance_categories where org_id = other_org and kind = 'expense' and name = 'Rent';

  -- ==== as the owner: what the cash book stands beside =========================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;

  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Two', true) returning id into cust2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;
  -- Three invoices of RM 132.50, two for the first customer.
  inv := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv);
  inv2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv2);
  inv3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv3);
  -- Two bills of RM 132.50.
  bill1 := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill1);
  bill2 := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill2);

  -- ==== expenses, as the editor ================================================
  perform set_config('request.jwt.claims', editor_claims, true);

  ex1 := public.finance_save_expense(org, jsonb_build_object(
    'expense_date', current_date, 'category_id', rent, 'vendor_name', 'Check Landlord', 'amount', 100, 'sst_amount', 6));
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.status, r.display_status, r.category_name, r.vendor_name, r.amount, r.sst_amount, r.paid, r.held, r.created_by)
     is distinct from ('pending', 'pending', 'Rent', 'Check Landlord', 100.00, 6.00, 0.00, 0.00, editor_id)
     or r.approved_at is not null or r.approved_by is not null or r.method is not null then
    fails := fails || format('an expense saved by an editor reads as %s', row_to_json(r));
  end if;

  -- ---- what saving an expense refuses ----------------------------------------
  fails := fails || public.bendahara_check_try('an expense is given an income category', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', sales, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense has no category', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense names a contact and a typed vendor', '23514',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', rent, 'vendor_id', sup, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense has no vendor', '23514',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('category_id', rent, 'amount', 10)));
  fails := fails || public.bendahara_check_try('an expense has more SST than its amount', '23514',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10, 'sst_amount', 10.01)));
  fails := fails || public.bendahara_check_try('an expense of nothing', '23514',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 0)));
  fails := fails || public.bendahara_check_try('an expense is created already approved', 'FIN01',
    format('insert into public.finance_expenses (org_id, category_id, vendor_name, amount, status, approved_at) values (%L, %L, %L, 10, %L, now())',
      org, rent, 'X', 'approved'));
  -- A pending expense that arrives with an approver and a time: both are
  -- cleared by the guard, so it is stored as nobody's decision.
  fails := fails || public.bendahara_check_try('an expense is created pending with an approver written in', 'ok',
    format('insert into public.finance_expenses (id, org_id, category_id, vendor_name, amount, approved_by, approved_at) values (%L, %L, %L, %L, 10, %L, now())',
      ex5, org, rent, 'X', owner_id));
  select count(*) into n from public.finance_expenses
   where id = ex5 and status = 'pending' and approved_by is null and approved_at is null;
  if n <> 1 then fails := array_append(fails, 'an expense created with an approver written in did not have it cleared'); end if;
  delete from public.finance_expenses where id = ex5;
  fails := fails || public.bendahara_check_try('an expense that is not there is changed', 'FIN11',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('id', gen_random_uuid(), 'category_id', rent, 'vendor_name', 'X', 'amount', 10)));

  -- ---- a pending expense is edited; an editor cannot decide it -----------------
  if public.finance_save_expense(org, jsonb_build_object(
       'id', ex1, 'expense_date', current_date, 'category_id', rent, 'vendor_id', sup, 'amount', 120, 'sst_amount', 6, 'notes', 'October'))
     is distinct from ex1 then
    fails := array_append(fails, 'saving an expense again did not keep its id');
  end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.status, r.vendor_name, r.amount, r.notes) is distinct from ('pending', 'Check Supplier', 120.00, 'October') then
    fails := fails || format('an edited pending expense reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an editor approves an expense', 'FIN14',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex1));
  fails := fails || public.bendahara_check_try('an editor rejects an expense', 'FIN14',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex1));
  fails := fails || public.bendahara_check_try('an editor approves an expense in someone else''s name', 'FIN14',
    format('update public.finance_expenses set status = %L, approved_by = %L, approved_at = now() where id = %L', 'approved', owner_id, ex1));
  -- Nor by writing who approved it without touching the status.
  fails := fails || public.bendahara_check_try('an editor writes an approver and a time on a pending expense', 'FIN14',
    format('update public.finance_expenses set approved_by = %L, approved_at = now() where id = %L', owner_id, ex1));
  fails := fails || public.bendahara_check_try('an editor writes an approver on a pending expense', 'FIN14',
    format('update public.finance_expenses set approved_by = %L where id = %L', owner_id, ex1));
  fails := fails || public.bendahara_check_try('a pending expense is paid', 'FIN04',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Supplier'),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 10))));
  -- A second pending expense, deleted again: anyone who may write can.
  ex3 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Typo', 'amount', 5));
  fails := fails || public.bendahara_check_try('a pending expense is deleted', 'ok',
    format('delete from public.finance_expenses where id = %L', ex3));

  -- ==== expenses, as the owner =================================================
  perform set_config('request.jwt.claims', owner_claims, true);

  fails := fails || public.bendahara_check_try('an expense is approved and changed in one update', 'FIN01',
    format('update public.finance_expenses set status = %L, amount = 999 where id = %L', 'approved', ex1));
  fails := fails || public.bendahara_check_try('an owner approves an expense', 'ok',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex1));
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.status, r.display_status, r.approved_by, r.created_by) is distinct from ('approved', 'approved', owner_id, editor_id)
     or r.approved_at is null then
    fails := fails || format('an approved expense reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an approved expense is edited', 'FIN01',
    format('update public.finance_expenses set amount = 1 where id = %L', ex1));
  fails := fails || public.bendahara_check_try('an approved expense is saved again', 'FIN01',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('id', ex1, 'category_id', rent, 'vendor_id', sup, 'amount', 1)));
  fails := fails || public.bendahara_check_try('an approved expense is deleted', 'FIN01',
    format('delete from public.finance_expenses where id = %L', ex1));
  fails := fails || public.bendahara_check_try('an approved expense is approved in another name', 'FIN01',
    format('update public.finance_expenses set approved_by = %L where id = %L', editor_id, ex1));
  -- Saved by an owner, an expense is approved in the same call.
  ex2 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Check Utility', 'amount', 40));
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_expenses where id = ex2;
  if t is distinct from 'approved/' || owner_id then fails := fails || format('an expense saved by an owner reads %s', t); end if;

  -- ==== an admin decides as an owner does, and nobody writes who decided ========
  perform set_config('request.jwt.claims', editor_claims, true);
  ex6 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Check Courier', 'amount', 15));
  fails := fails || public.bendahara_check_try('an editor approves the expense an admin is about to', 'FIN14',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex6));
  perform set_config('request.jwt.claims', admin_claims, true);
  -- Not even someone who may approve gives the approval a time or a name of their choosing.
  fails := fails || public.bendahara_check_try('an admin approves an expense and writes the time by hand', 'FIN14',
    format('update public.finance_expenses set status = %L, approved_at = now() - interval %L where id = %L', 'approved', '3 days', ex6));
  fails := fails || public.bendahara_check_try('an admin approves an expense in the owner''s name', 'FIN14',
    format('update public.finance_expenses set status = %L, approved_by = %L where id = %L', 'approved', owner_id, ex6));
  fails := fails || public.bendahara_check_try('an admin approves an expense', 'ok',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex6));
  select status || '/' || coalesce(approved_by::text, 'nobody') || '/' || (approved_at is not null) into t
    from public.finance_expenses where id = ex6;
  if t is distinct from 'approved/' || admin_id || '/true' then fails := fails || format('an expense approved by an admin reads %s', t); end if;
  -- Who approved it, and who entered it, cannot be blanked by hand: only a deleted user's foreign key clears them.
  fails := fails || public.bendahara_check_try('an admin blanks who approved an expense', 'FIN01',
    format('update public.finance_expenses set approved_by = null where id = %L', ex6));
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_check_try('an editor blanks who approved an expense', 'FIN01',
    format('update public.finance_expenses set approved_by = null where id = %L', ex6));
  fails := fails || public.bendahara_check_try('an editor blanks who entered an approved expense', 'FIN01',
    format('update public.finance_expenses set created_by = null where id = %L', ex6));
  select count(*) into n from public.finance_expenses where id = ex6 and approved_by = admin_id and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'who approved or entered an approved expense was blanked by hand'); end if;
  fails := fails || public.bendahara_check_try('an editor rejects the expense an admin approved', 'FIN14',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex6));
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_check_try('an admin rejects an expense', 'ok',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex6));
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_expenses where id = ex6;
  if t is distinct from 'rejected/' || admin_id then fails := fails || format('an expense rejected by an admin reads %s', t); end if;
  fails := fails || public.bendahara_check_try('a rejected expense is deleted', 'ok',
    format('delete from public.finance_expenses where id = %L', ex6));

  -- ==== paying an approved expense: scheduled by the editor, paid by an admin ===
  -- No second approval: the expense was approved. Paying is a sign-off.
  perform set_config('request.jwt.claims', editor_claims, true);

  p1 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'contact_id', sup, 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 50)));
  select * into r from public.finance_transactions where id = p1;
  if (r.direction, r.status, r.amount, r.number, r.contact_id, r.category_id)
     is distinct from ('out', 'scheduled', 50.00, null::text, sup, null::uuid) or r.approved_at is not null then
    fails := fails || format('a scheduled payment of an expense reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status) is distinct from (0.00, 50.00, 'approved') then
    fails := fails || format('with RM 50 scheduled the expense reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an expense is paid a sen more than is left', 'FIN05',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'contact_id', sup),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 70.01))));
  fails := fails || public.bendahara_check_try('an editor pays an approved expense now', 'FIN14',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', till, 'method', 'cash', 'contact_id', sup),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 70))));
  perform set_config('request.jwt.claims', admin_claims, true);
  p2 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', till, 'method', 'cash', 'contact_id', sup),
    jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 70)));
  perform set_config('request.jwt.claims', editor_claims, true);
  select status || '/' || number into t from public.finance_transactions where id = p2;
  if t is distinct from 'posted/PV-0001' then fails := fails || format('the first voucher reads %s', t); end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status, r.method) is distinct from (70.00, 50.00, 'approved', 'cash') then
    fails := fails || format('with RM 70 paid and RM 50 scheduled the expense reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an editor marks the scheduled payment of an expense paid', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, p1));
  perform set_config('request.jwt.claims', admin_claims, true);
  no := public.finance_mark_payment_paid(org, p1, current_date);
  perform set_config('request.jwt.claims', editor_claims, true);
  if no is distinct from 'PV-0002' then fails := fails || format('the scheduled payment was numbered %s', no); end if;
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status) is distinct from (120.00, 0.00, 'paid') then
    fails := fails || format('paid in full the expense reads %s', row_to_json(r));
  end if;
  select * into r from public.finance_payment_vouchers where transaction_id = p2;
  if (r.kind, r.category_name, r.party_name, r.account_kind, r.documents)
     is distinct from ('expense', 'Rent', 'Check Supplier', 'cash', null::text) then
    fails := fails || format('a payment of an expense shows on Payment Vouchers as %s', row_to_json(r));
  end if;

  -- ---- what a voucher for expenses refuses ------------------------------------
  fails := fails || public.bendahara_check_try('a voucher names expenses and a category', 'FIN15',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'category_id', rent),
      jsonb_build_array(jsonb_build_object('expense_id', ex2, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a voucher names an expense that is not there', 'FIN06',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('expense_id', gen_random_uuid(), 'amount', 10))));
  fails := fails || public.bendahara_check_try('a voucher is asked for a status that is not one', '22023',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'void'),
      jsonb_build_array(jsonb_build_object('expense_id', ex2, 'amount', 10))));
  -- Money in never pays an expense.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against an expense', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (%L, %L, %L, 10)', org, stray, ex2));
  delete from public.finance_transactions where id = stray;
  -- One payment, one kind of document.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (org, stray, ex2, 10);
  fails := fails || public.bendahara_check_try('a payment of an expense is also put against a bill', 'FIN06',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill1));
  fails := fails || public.bendahara_check_try('one allocation names an expense and a bill', '23514',
    format('update public.finance_allocations set bill_id = %L where transaction_id = %L', bill1, stray));
  delete from public.finance_transactions where id = stray;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, stray, bill1, 10);
  fails := fails || public.bendahara_check_try('a payment of a bill is also put against an expense', 'FIN06',
    format('insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (%L, %L, %L, 10)', org, stray, ex2));
  delete from public.finance_transactions where id = stray;

  -- ==== an approved expense is rejected only once nothing stands against it ====
  perform set_config('request.jwt.claims', owner_claims, true);

  fails := fails || public.bendahara_check_try('an approved expense with payments is rejected', 'FIN02',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex1));
  update public.finance_transactions set status = 'void', updated_at = now() where id in (p1, p2);
  select * into r from public.finance_expense_totals where id = ex1;
  if (r.paid, r.held, r.display_status) is distinct from (0.00, 0.00, 'approved') or r.method is not null then
    fails := fails || format('with its payments voided the expense reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an approved expense with no payment is rejected', 'ok',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', ex1));
  fails := fails || public.bendahara_check_try('a rejected expense is approved without being edited', 'FIN01',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', ex1));
  fails := fails || public.bendahara_check_try('a rejected expense is edited and stays rejected', 'FIN01',
    format('update public.finance_expenses set amount = 1 where id = %L', ex1));
  fails := fails || public.bendahara_check_try('a rejected expense is paid', 'FIN04',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'contact_id', sup),
      jsonb_build_array(jsonb_build_object('expense_id', ex1, 'amount', 10))));
  -- Edited by the editor, it is pending again and nobody has decided it.
  perform set_config('request.jwt.claims', editor_claims, true);
  perform public.finance_save_expense(org, jsonb_build_object('id', ex1, 'category_id', rent, 'vendor_id', sup, 'amount', 110));
  select status || '/' || amount || '/' || coalesce(approved_by::text, 'nobody') || '/' || coalesce(approved_at::text, 'never')
    into t from public.finance_expenses where id = ex1;
  if t is distinct from 'pending/110.00/nobody/never' then fails := fails || format('a rejected expense edited reads %s', t); end if;
  -- Its voided payments still name it, so it stays as a record.
  fails := fails || public.bendahara_check_try('an expense with voided payments is deleted', '23503',
    format('delete from public.finance_expenses where id = %L', ex1));

  -- ==== vouchers that settle no document, as the editor ========================
  v1 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'party_name', 'Check Water Board',
                       'category_id', utilities, 'amount', 300, 'reference', 'ACC 1', 'status', 'posted'), null);
  select * into r from public.finance_transactions where id = v1;
  if (r.direction, r.status, r.amount, r.number, r.party_name, r.category_id, r.created_by)
     is distinct from ('out', 'pending_approval', 300.00, null::text, 'Check Water Board', utilities, editor_id)
     or r.approved_at is not null or r.approved_by is not null then
    fails := fails || format('a voucher recorded by an editor reads as %s', row_to_json(r));
  end if;
  select * into r from public.finance_payment_vouchers where transaction_id = v1;
  if (r.kind, r.category_name, r.party_name, r.status, r.documents)
     is distinct from ('other', 'Utilities', 'Check Water Board', 'pending_approval', null::text) then
    fails := fails || format('a voucher waiting for approval shows as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a voucher is given an income category', 'FIN15',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'category_id', sales, 'amount', 10), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('a voucher names no expense and no category', 'FIN15',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'amount', 10), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('a voucher names a contact and a typed payee', '23514',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'contact_id', sup, 'party_name', 'X', 'category_id', rent, 'amount', 10), null::jsonb));

  -- ---- what an editor cannot do to a voucher that is waiting -------------------
  fails := fails || public.bendahara_check_try('an editor approves a voucher', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', v1));
  fails := fails || public.bendahara_check_try('an editor rejects a voucher', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'rejected', v1));
  fails := fails || public.bendahara_check_try('an editor pays a voucher that is waiting', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', v1));
  fails := fails || public.bendahara_check_try('an editor pays a voucher that is waiting, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is marked paid', 'FIN09',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is changed', 'FIN14',
    format('update public.finance_transactions set amount = 3000 where id = %L', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting goes back to draft', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'draft', v1));
  fails := fails || public.bendahara_check_try('a voucher that is waiting is given a split', 'FIN09',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, v1, bill1));
  -- Behind the function: a payment starts as a draft, and money out that
  -- settles no document does not leave draft without an owner or admin.
  fails := fails || public.bendahara_check_try('a payment is created already scheduled', 'FIN09',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, status) values (%L, %L, %L, 10, %L, %L, %L)',
      org, 'out', bank, 'cash', rent, 'scheduled'));
  fails := fails || public.bendahara_check_try('a payment is created already posted', 'FIN09',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, status) values (%L, %L, %L, 10, %L, %L, %L)',
      org, 'out', bank, 'cash', rent, 'posted'));
  -- A number, an approver and a time are not columns a signed-in person writes at all.
  fails := fails || public.bendahara_check_try('a payment is created already posted, with a number', '42501',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, status, number) values (%L, %L, %L, 10, %L, %L, %L, %L)',
      org, 'out', bank, 'cash', rent, 'posted', 'PV-SNEAKY'));
  fails := fails || public.bendahara_check_try('a payment is created already approved', '42501',
    format('insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id, approved_by, approved_at) values (%L, %L, %L, 500, %L, %L, %L, now())',
      org, 'out', bank, 'cash', rent, owner_id));
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id)
  values (org, 'out', bank, 500, 'cash', rent) returning id into stray;
  select count(*) into n from public.finance_transactions where id = stray and approved_by is null and approved_at is null and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'a new draft payment is approved, or is not recorded as its maker''s'); end if;
  -- Nor is it approved afterwards by writing who approved it and when: with
  -- those two filled in, the draft would pass for one an owner had approved,
  -- and its maker could pay it. (On a draft of its own, so that a failure
  -- here is reported and does not stop the rest.)
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id)
  values (org, 'out', bank, 700, 'cash', rent) returning id into v6;
  fails := fails || public.bendahara_check_try('an editor writes an approver and a time on their own draft', '42501',
    format('update public.finance_transactions set approved_at = now(), approved_by = %L where id = %L', owner_id, v6));
  fails := fails || public.bendahara_check_try('an editor writes a time of approval on their own draft', '42501',
    format('update public.finance_transactions set approved_at = now() where id = %L', v6));
  fails := fails || public.bendahara_check_try('an editor writes an approver on their own draft', '42501',
    format('update public.finance_transactions set approved_by = %L where id = %L', owner_id, v6));
  select count(*) into n from public.finance_transactions where id = v6 and approved_by is null and approved_at is null;
  if n <> 1 then fails := array_append(fails, 'a draft has an approver or a time after an editor tried to write them'); end if;
  fails := fails || public.bendahara_check_try('an editor pays the draft they tried to mark as approved', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', v6));
  fails := fails || public.bendahara_check_try('an editor pays the draft they tried to mark as approved, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', v6));
  delete from public.finance_transactions where id = v6 and status = 'draft';
  fails := fails || public.bendahara_check_try('an editor schedules money out that settles no document', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'scheduled', stray));
  fails := fails || public.bendahara_check_try('an editor pays money out that settles no document', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', stray));
  fails := fails || public.bendahara_check_try('an editor pays money out that settles no document, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  -- A sen against a bill does not make the other RM 499.99 a payment to a supplier.
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, stray, bill1, 0.01);
  fails := fails || public.bendahara_check_try('an editor pays money out that is mostly not for its bill', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', stray));
  fails := fails || public.bendahara_check_try('an editor pays money out that is mostly not for its bill, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a draft is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', stray));
  -- Nor by scheduling a payment to a supplier, which needs nobody, and then
  -- raising it or taking its bill away (further down, on this one).
  stray := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill1, 'amount', 1)));
  -- Nor by raising it and writing a time of approval in the same update,
  -- which would have it paid "as it was approved". (On a payment of its own.)
  v7 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill1, 'amount', 2)));
  fails := fails || public.bendahara_check_try('an editor raises a scheduled payment and writes a time of approval on it', '42501',
    format('update public.finance_transactions set amount = 50000, approved_at = now() where id = %L', v7));
  select count(*) into n from public.finance_transactions where id = v7 and amount = 2 and approved_by is null and approved_at is null;
  if n <> 1 then fails := array_append(fails, 'a scheduled payment was raised or marked approved by an editor'); end if;
  fails := fails || public.bendahara_check_try('an editor writes a time of approval on a scheduled payment', '42501',
    format('update public.finance_transactions set approved_at = now() where id = %L', v7));
  delete from public.finance_transactions where id = v7;
  -- Scheduled, it stays covered by its bill: it is not raised above it, and
  -- its split is not lowered or taken away, so no payment that settles
  -- nothing ever sits among those that are only waiting to be paid.
  fails := fails || public.bendahara_check_try('an editor raises a scheduled payment above its bill', 'FIN14',
    format('update public.finance_transactions set amount = 500 where id = %L', stray));
  fails := fails || public.bendahara_check_try('an editor lowers the split of a scheduled payment', 'FIN14',
    format('update public.finance_allocations set amount = 0.5 where transaction_id = %L', stray));
  fails := fails || public.bendahara_check_try('an editor takes the split of a scheduled payment away', 'FIN14',
    format('delete from public.finance_allocations where transaction_id = %L', stray));
  select t.amount::text || '/' || coalesce((select sum(a.amount) from public.finance_allocations a where a.transaction_id = t.id), 0) into t
    from public.finance_transactions t where t.id = stray;
  if t is distinct from '1.00/1.00' then fails := fails || format('a scheduled payment of RM 1 against a bill now reads %s', t); end if;
  -- Scheduling it needed nobody; paying it is a sign-off, and so is voiding it afterwards.
  fails := fails || public.bendahara_check_try('an editor marks paid a scheduled payment that is exactly its bill', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_check_try('an admin marks paid a scheduled payment that is exactly its bill', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_check_try('an editor voids the payment an admin marked paid', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', stray));
  perform set_config('request.jwt.claims', admin_claims, true);
  update public.finance_transactions set status = 'void', updated_at = now() where id = stray and status = 'posted';
  delete from public.finance_transactions where id = stray and status = 'scheduled';

  -- ==== the owner decides ======================================================
  perform set_config('request.jwt.claims', owner_claims, true);

  fails := fails || public.bendahara_check_try('a voucher is approved and changed in one update', 'FIN14',
    format('update public.finance_transactions set status = %L, amount = 3000 where id = %L', 'scheduled', v1));
  -- A number written by hand is refused for the column, whoever writes it.
  fails := fails || public.bendahara_check_try('a voucher that is waiting is paid without being approved', '42501',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', v1));
  -- Without a number the table's own check would refuse it (23514); the guard comes first.
  fails := fails || public.bendahara_check_try('a voucher that is waiting is paid in one step', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', v1));
  -- Who approved and when is the guard's to write: not even an owner fills them in.
  fails := fails || public.bendahara_check_try('an owner approves a voucher and writes the time by hand', '42501',
    format('update public.finance_transactions set status = %L, approved_at = now() - interval %L where id = %L', 'scheduled', '3 days', v1));
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, category_id)
  values (org, 'out', bank, 9, 'cash', rent) returning id into stray;
  fails := fails || public.bendahara_check_try('an owner writes a time of approval on a draft', '42501',
    format('update public.finance_transactions set approved_at = now() where id = %L', stray));
  delete from public.finance_transactions where id = stray;
  fails := fails || public.bendahara_check_try('an owner approves a voucher', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', v1));
  select * into r from public.finance_transactions where id = v1;
  if (r.status, r.number, r.approved_by, r.created_by) is distinct from ('scheduled', null::text, owner_id, editor_id)
     or r.approved_at is null then
    fails := fails || format('an approved voucher reads as %s', row_to_json(r));
  end if;
  -- Recorded by an owner, a voucher is as asked, and approved in the same call.
  v2 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', till, 'method', 'cash', 'party_name', 'Check Stationer', 'category_id', utilities, 'amount', 25.5), null);
  select * into r from public.finance_transactions where id = v2;
  if (r.status, r.number, r.approved_by) is distinct from ('posted', 'PV-0004', owner_id) or r.approved_at is null then
    fails := fails || format('a voucher paid by an owner reads as %s', row_to_json(r));
  end if;
  v3 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Insurer', 'category_id', utilities, 'amount', 80, 'status', 'scheduled'), null);
  select status || '/' || coalesce(number, 'no number') || '/' || coalesce(approved_by::text, 'nobody') into t
    from public.finance_transactions where id = v3;
  if t is distinct from 'scheduled/no number/' || owner_id then fails := fails || format('a voucher scheduled by an owner reads %s', t); end if;

  -- An owner who raises a scheduled payment above its bill is approving the rest, and is written down for it.
  stray := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill1, 'amount', 3)));
  fails := fails || public.bendahara_check_try('an owner raises a scheduled payment above its bill', 'ok',
    format('update public.finance_transactions set amount = 8 where id = %L', stray));
  select status || '/' || amount || '/' || coalesce(approved_by::text, 'nobody') || '/' || (approved_at is not null) into t
    from public.finance_transactions where id = stray;
  if t is distinct from 'scheduled/8.00/' || owner_id || '/true' then
    fails := fails || format('a scheduled payment raised by an owner reads %s', t);
  end if;
  delete from public.finance_transactions where id = stray;

  -- ==== an admin approves and rejects a voucher; an editor does neither =========
  perform set_config('request.jwt.claims', editor_claims, true);
  v6 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Printer', 'category_id', utilities, 'amount', 45), null);
  v7 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Florist', 'category_id', utilities, 'amount', 46), null);
  fails := fails || public.bendahara_check_try('an editor approves the voucher an admin is about to', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', v6));
  fails := fails || public.bendahara_check_try('an editor rejects the voucher an admin is about to', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'rejected', v7));
  perform set_config('request.jwt.claims', admin_claims, true);
  -- The decision is recorded in the name of whoever made it, never in a name they wrote.
  fails := fails || public.bendahara_check_try('an admin rejects a voucher in the owner''s name', '42501',
    format('update public.finance_transactions set status = %L, approved_by = %L where id = %L', 'rejected', owner_id, v7));
  fails := fails || public.bendahara_check_try('an admin approves a voucher', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', v6));
  fails := fails || public.bendahara_check_try('an admin rejects a voucher', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'rejected', v7));
  select string_agg(status || '/' || coalesce(approved_by::text, 'nobody') || '/' || (approved_at is not null), ' ' order by amount) into t
    from public.finance_transactions where id in (v6, v7);
  if t is distinct from 'scheduled/' || admin_id || '/true rejected/' || admin_id || '/true' then
    fails := fails || format('vouchers decided by an admin read %s', t);
  end if;
  delete from public.finance_transactions where id in (v6, v7);

  -- ==== an approved voucher is paid as it was approved, by an owner or admin ====
  perform set_config('request.jwt.claims', editor_claims, true);

  fails := fails || public.bendahara_check_try('an approved voucher is changed', 'FIN14',
    format('update public.finance_transactions set amount = 3000 where id = %L', v1));
  fails := fails || public.bendahara_check_try('an approved voucher is paid for another amount', 'FIN14',
    format('update public.finance_transactions set status = %L, amount = 3000 where id = %L', 'posted', v1));
  fails := fails || public.bendahara_check_try('an approved voucher is paid for another amount, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L, amount = 3000 where id = %L', 'posted', 'PV-SNEAKY', v1));
  fails := fails || public.bendahara_check_try('an approved voucher goes back to draft', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'draft', v1));
  fails := fails || public.bendahara_check_try('an approved voucher is given a split', 'FIN09',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, v1, bill1));
  -- Who approved it is cleared by the foreign key when that user is deleted, and by nobody's own update.
  fails := fails || public.bendahara_check_try('an editor blanks who approved a voucher', '42501',
    format('update public.finance_transactions set approved_by = null where id = %L', v1));
  -- Approved by the owner, it is paid by an admin: the editor who recorded it cannot, and the owner stays its approver.
  fails := fails || public.bendahara_check_try('an editor marks an approved voucher paid', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v1));
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_check_try('an admin pays an approved voucher for another amount', 'FIN14',
    format('update public.finance_transactions set status = %L, amount = 3000 where id = %L', 'posted', v1));
  no := public.finance_mark_payment_paid(org, v1, current_date - 1);
  perform set_config('request.jwt.claims', editor_claims, true);
  select * into r from public.finance_transactions where id = v1;
  if (no, r.status, r.number, r.txn_date, r.amount, r.approved_by)
     is distinct from ('PV-0005', 'posted', 'PV-0005', current_date - 1, 300.00, owner_id) then
    fails := fails || format('an approved voucher marked paid reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a paid voucher is changed', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', v1));
  fails := fails || public.bendahara_check_try('who approved a paid voucher is blanked by hand', '42501',
    format('update public.finance_transactions set approved_by = null where id = %L', v1));
  fails := fails || public.bendahara_check_try('who recorded a paid voucher is blanked by hand', '42501',
    format('update public.finance_transactions set created_by = null where id = %L', v1));
  select count(*) into n from public.finance_transactions where id = v1 and approved_by = owner_id and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'who approved or recorded a paid voucher was blanked by hand'); end if;
  fails := fails || public.bendahara_check_try('a paid voucher is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', v1));
  fails := fails || public.bendahara_check_try('a paid voucher is voided by the editor who recorded it', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', v1));
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_check_try('a paid voucher is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', v1));
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_check_try('an approved voucher that was never paid is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', v3));

  -- ==== a rejected voucher is final ============================================
  v4 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Caterer', 'category_id', utilities, 'amount', 60), null);
  v5 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Mistake', 'category_id', utilities, 'amount', 61), null);
  fails := fails || public.bendahara_check_try('a voucher that is waiting is deleted by the editor', 'ok',
    format('delete from public.finance_transactions where id = %L', v5));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('an owner rejects a voucher', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'rejected', v4));
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_transactions where id = v4;
  if t is distinct from 'rejected/' || owner_id then fails := fails || format('a rejected voucher reads %s', t); end if;
  foreach t in array array['scheduled','posted','draft','pending_approval'] loop
    fails := fails || public.bendahara_check_try(format('a rejected voucher becomes %s', t), 'FIN14',
      format('update public.finance_transactions set status = %L where id = %L', t, v4));
  end loop;
  fails := fails || public.bendahara_check_try('a rejected voucher becomes posted, with a number written by hand', '42501',
    format('update public.finance_transactions set status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', v4));
  fails := fails || public.bendahara_check_try('a rejected voucher is changed', 'FIN14',
    format('update public.finance_transactions set amount = 1 where id = %L', v4));
  fails := fails || public.bendahara_check_try('a rejected voucher is marked paid', 'FIN09',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v4));
  fails := fails || public.bendahara_check_try('a scheduled payment is rejected', 'FIN14',
    format('update public.finance_transactions set status = %L where id = %L', 'rejected',
      public.finance_record_voucher(org,
        jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Check Later', 'category_id', utilities, 'amount', 7, 'status', 'scheduled'), null)));
  fails := fails || public.bendahara_check_try('a rejected voucher is deleted', 'ok',
    format('delete from public.finance_transactions where id = %L', v4));

  -- ==== a payment, a split and an expense never change workspace ================
  -- Someone who is an editor here and owns another workspace. There they may
  -- approve anything; a row made there is not brought here with that approval.
  perform set_config('request.jwt.claims', mover_claims, true);
  -- A draft that settles nothing, moved here and paid in the same update.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (other_org, 'out', their_bank, 50000, 'cash') returning id into v6;
  -- org_id is not a column a signed-in person updates either (20261030123000): 42501, with or without a number.
  -- The guard's own rule (FIN09: a payment never changes workspace) is now behind that and is not reached.
  fails := fails || public.bendahara_check_try('an editor who owns another workspace moves a draft from it and pays it here in one update', '42501',
    format('update public.finance_transactions set org_id = %L, account_id = %L, status = %L, number = %L where id = %L',
      org, bank, 'posted', 'PV-SNEAKY', v6));
  fails := fails || public.bendahara_check_try('an editor who owns another workspace moves a draft from it here', '42501',
    format('update public.finance_transactions set org_id = %L, account_id = %L where id = %L', org, bank, v6));
  -- Scheduled money in, which nobody is asked about, moved here as money out, and then marked paid.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (other_org, 'in', their_bank, 40000, 'cash') returning id into v7;
  update public.finance_transactions set status = 'scheduled' where id = v7;
  fails := fails || public.bendahara_check_try('an editor who owns another workspace moves scheduled money in from it here as money out', '42501',
    format('update public.finance_transactions set org_id = %L, account_id = %L, direction = %L where id = %L', org, bank, 'out', v7));
  fails := fails || public.bendahara_check_try('the payment that was not moved here is marked paid here', 'FIN11',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, v7));
  -- A pending expense entered there is not moved here.
  insert into public.finance_expenses (id, org_id, category_id, vendor_name, amount) values (ex5, other_org, their_rent, 'Theirs', 10);
  fails := fails || public.bendahara_check_try('a pending expense is moved to another workspace', 'FIN01',
    format('update public.finance_expenses set org_id = %L, category_id = %L where id = %L', org, rent, ex5));
  -- Nor is a split, re-pointed at a payment and an approved expense here.
  theirs := public.finance_save_expense(other_org, jsonb_build_object('category_id', their_rent, 'vendor_name', 'Theirs', 'amount', 20));
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (other_org, 'out', their_bank, 20, 'cash') returning id into stray;
  insert into public.finance_allocations (org_id, transaction_id, expense_id, amount) values (other_org, stray, theirs, 5);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into pay;
  fails := fails || public.bendahara_check_try('the split of a payment is moved to another workspace', 'FIN09',
    format('update public.finance_allocations set org_id = %L, transaction_id = %L, expense_id = %L where transaction_id = %L', org, pay, ex2, stray));
  select (select count(*) from public.finance_transactions where org_id = org and id in (v6, v7))
       + (select count(*) from public.finance_expenses where org_id = org and id = ex5)
       + (select count(*) from public.finance_allocations where org_id = org and transaction_id = pay) into n;
  if n <> 0 then fails := fails || format('%s rows were moved here from another workspace', n); end if;
  delete from public.finance_transactions where id in (v6, v7, stray, pay) and status in ('draft','scheduled');
  delete from public.finance_expenses where id = ex5 and status = 'pending';

  -- ==== cash receipts, as the editor ===========================================
  perform set_config('request.jwt.claims', editor_claims, true);

  -- ---- income that settles no invoice ----------------------------------------
  r1 := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', till, 'txn_date', current_date, 'method', 'cash', 'party_name', 'Walk-in',
                       'category_id', sales, 'amount', 80), null);
  select * into r from public.finance_cash_receipts where transaction_id = r1;
  if (r.kind, r.status, r.number, r.amount, r.party_name, r.category_name, r.account_kind, r.documents)
     is distinct from ('income', 'draft', null::text, 80.00, 'Walk-in', 'Sales', 'cash', null::text) then
    fails := fails || format('a draft receipt reads as %s', row_to_json(r));
  end if;
  if public.finance_save_cash_receipt(org,
       jsonb_build_object('id', r1, 'account_id', bank, 'method', 'duitnow', 'contact_id', cust, 'category_id', sales, 'amount', 85.555), '[]'::jsonb)
     is distinct from r1 then
    fails := array_append(fails, 'saving a draft receipt again did not keep its id');
  end if;
  select * into r from public.finance_cash_receipts where transaction_id = r1;
  if (r.amount, r.party_name, r.contact_id, r.method, r.account_kind) is distinct from (85.56, 'Check Customer', cust, 'duitnow', 'bank') then
    fails := fails || format('an edited draft receipt reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a receipt is given an expense category', 'FIN15',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', rent, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a receipt names no invoice and no category', 'FIN15',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'party_name', 'X', 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a receipt names invoices and a category', 'FIN15',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'category_id', sales),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a receipt names a contact and a typed payer', '23514',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'contact_id', cust, 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a receipt that is not there is changed', 'FIN11',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', gen_random_uuid(), 'account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a voucher is changed as if it were a receipt', 'FIN11',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', v2, 'account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a voucher is posted as if it were a receipt', 'FIN11',
    format('select public.finance_post_cash_receipt(%L, %L)', org, v2));
  -- Money in needs nobody's approval, and posting it is a sign-off: the editor's draft is posted by an admin.
  fails := fails || public.bendahara_check_try('an editor posts their own draft receipt', 'FIN14',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r1));
  if (select next_number from public.finance_sequences where org_id = org and doc_type = 'receipt') is distinct from null then
    fails := array_append(fails, 'a refused post of a receipt used up an RC- number');
  end if;
  perform set_config('request.jwt.claims', admin_claims, true);
  no := public.finance_post_cash_receipt(org, r1);
  perform set_config('request.jwt.claims', editor_claims, true);
  select * into r from public.finance_transactions where id = r1;
  if (no, r.status, r.number, r.direction) is distinct from ('RC-0001', 'posted', 'RC-0001', 'in') or r.approved_at is not null then
    fails := fails || format('a posted receipt reads as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a posted receipt is saved again', 'FIN09',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', r1, 'account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a posted receipt is posted again', 'FIN09',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r1));
  fails := fails || public.bendahara_check_try('a posted receipt is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', r1));
  fails := fails || public.bendahara_check_try('a posted receipt is voided by the editor who saved it', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', r1));
  perform set_config('request.jwt.claims', admin_claims, true);
  fails := fails || public.bendahara_check_try('a posted receipt is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', r1));
  perform set_config('request.jwt.claims', editor_claims, true);
  -- A draft that names neither invoices nor a category, written straight to the table, is not posted.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('a receipt for nothing is posted', 'FIN15',
    format('select public.finance_post_cash_receipt(%L, %L)', org, stray));
  -- Money in is never scheduled, and is never given a voucher number.
  update public.finance_transactions set status = 'scheduled', category_id = sales where id = stray;
  fails := fails || public.bendahara_check_try('scheduled money in is marked paid', 'FIN09',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  -- Nor does it become money out where it stands: that would be a payment that settles nothing, already scheduled.
  fails := fails || public.bendahara_check_try('scheduled money in is turned into money out by an editor', 'FIN14',
    format('update public.finance_transactions set direction = %L, category_id = %L where id = %L', 'out', rent, stray));
  delete from public.finance_transactions where id = stray;

  -- ---- a receipt for invoices: a draft holds what it is split across ---------
  r2 := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'Ignored', 'reference', 'CHK 9'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100), jsonb_build_object('invoice_id', inv2, 'amount', 32.5)));
  select * into r from public.finance_cash_receipts where transaction_id = r2;
  if (r.kind, r.status, r.amount, r.party_name, r.contact_id, r.category_id, r.documents)
     is distinct from ('invoice', 'draft', 132.50, 'Check Customer', cust, null::uuid, 'INV-0001, INV-0002') then
    fails := fails || format('a draft receipt for two invoices reads as %s', row_to_json(r));
  end if;
  select paid || '/' || balance into t from public.finance_invoice_totals where id = inv;
  if t is distinct from '0.00/132.50' then fails := fails || format('with a draft receipt the invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('an invoice is paid in full while a draft receipt holds part of it', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.51))));
  fails := fails || public.bendahara_check_try('an editor records a payment in for what the draft receipt leaves', 'FIN14',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.5))));
  perform set_config('request.jwt.claims', admin_claims, true);
  pay := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.5)));
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_check_try('a receipt is for two customers', 'FIN06',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 1), jsonb_build_object('invoice_id', inv3, 'amount', 1))));
  fails := fails || public.bendahara_check_try('a draft receipt is saved for more than its invoice owes', 'FIN05',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('id', r2, 'account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100.01))));
  -- The refused save changed nothing: the draft still has its two invoices.
  select count(*) into n from public.finance_allocations where transaction_id = r2;
  if n <> 2 then fails := fails || format('a refused save left the draft receipt with %s invoices', n); end if;
  -- Saved again for less, against one invoice: the old split goes and the amount follows.
  perform public.finance_save_cash_receipt(org,
    jsonb_build_object('id', r2, 'account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 50)));
  select amount::text || '/' || (select count(*) from public.finance_allocations where transaction_id = r2) into t
    from public.finance_transactions where id = r2;
  if t is distinct from '50.00/1' then fails := fails || format('a draft receipt saved for less reads %s', t); end if;
  perform set_config('request.jwt.claims', admin_claims, true);
  no := public.finance_post_cash_receipt(org, r2);
  perform set_config('request.jwt.claims', editor_claims, true);
  if no is distinct from 'RC-0003' then fails := fails || format('the receipt for an invoice was numbered %s', no); end if;
  select paid || '/' || balance || '/' || display_status into t from public.finance_invoice_totals where id = inv;
  if t is distinct from '82.50/50.00/sent' then fails := fails || format('after the receipt was posted the invoice reads %s', t); end if;
  -- The same money on Payments In, one row per invoice, and on Cash Receipts, one row.
  select count(*) into n from public.finance_payments_in where transaction_id = r2;
  select count(*) into m from public.finance_cash_receipts where transaction_id = r2;
  if (n, m) is distinct from (1, 1) then fails := fails || format('a receipt for an invoice shows %s times on Payments In and %s on Cash Receipts', n, m); end if;

  -- ==== every movement of money shows once =====================================
  perform set_config('request.jwt.claims', owner_claims, true);

  -- One payment to a supplier across two bills: two rows on Payments Out, one voucher.
  pay := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill1, 'amount', 100), jsonb_build_object('bill_id', bill2, 'amount', 32.5)));
  select count(*) into n from public.finance_payments_out where transaction_id = pay;
  select * into r from public.finance_payment_vouchers where transaction_id = pay;
  if (n, r.kind, r.documents, r.party_name, r.amount, r.category_name)
     is distinct from (2, 'bill', 'BILL-0001, BILL-0002', 'Check Supplier', 132.50, null::text) then
    fails := fails || format('a payment across two bills shows %s times on Payments Out and on Payment Vouchers as %s', n, row_to_json(r));
  end if;
  if (select approved_at from public.finance_transactions where id = pay) is not null then
    fails := array_append(fails, 'a payment to a supplier was marked as approved');
  end if;
  -- A refund: the third invoice paid in full, credited RM 30, RM 30 paid back.
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv3, 'amount', 132.5)));
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv3, 'reason', 'returns', 'amount', 30));
  perform public.finance_issue_credit_note(org, cn);
  rf := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'fpx', 'reason', 'other', 'amount', 30));
  select count(*) into n from public.finance_refunds where transaction_id = rf;
  select * into r from public.finance_payment_vouchers where transaction_id = rf;
  if (n, r.kind, r.documents, r.party_name, r.status) is distinct from (1, 'refund', 'CN-0001', 'Check Customer Two', 'posted') then
    fails := fails || format('a refund shows %s times on Refunds and on Payment Vouchers as %s', n, row_to_json(r));
  end if;
  -- A refund is not a payment to a supplier and an expense voucher is neither.
  select (select count(*) from public.finance_payments_out where transaction_id in (rf, p2, v2))
       + (select count(*) from public.finance_refunds where transaction_id in (pay, p2, v2))
       + (select count(*) from public.finance_payments_in where transaction_id in (rf, pay, p2, v2)) into n;
  if n <> 0 then fails := fails || format('%s rows of a voucher show on a screen that is not its own', n); end if;
  -- An editor's payment to a supplier is not held for approval: they schedule it, and nobody is written down as
  -- approving it. Paying it now, or marking it paid, is a sign-off: an admin's here.
  perform set_config('request.jwt.claims', editor_claims, true);
  fails := fails || public.bendahara_check_try('an editor pays a supplier now', 'FIN14',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('bill_id', bill2, 'amount', 10))));
  stray := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'), jsonb_build_array(jsonb_build_object('bill_id', bill2, 'amount', 10)));
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_transactions where id = stray;
  if t is distinct from 'scheduled/nobody' then fails := fails || format('a payment to a supplier scheduled by an editor is %s', t); end if;
  perform set_config('request.jwt.claims', admin_claims, true);
  perform public.finance_mark_payment_paid(org, stray, current_date);
  select status || '/' || coalesce(approved_by::text, 'nobody') into t from public.finance_transactions where id = stray;
  if t is distinct from 'posted/nobody' then fails := fails || format('a payment to a supplier scheduled by an editor and paid by an admin is %s', t); end if;
  perform set_config('request.jwt.claims', owner_claims, true);
  -- Each view has exactly one row per movement of its direction, and their totals are the table's.
  select (select count(*) from public.finance_payment_vouchers where org_id = org)
       - (select count(*) from public.finance_transactions where org_id = org and direction = 'out') into n;
  select (select count(*) from public.finance_cash_receipts where org_id = org)
       - (select count(*) from public.finance_transactions where org_id = org and direction = 'in') into m;
  if (n, m) is distinct from (0, 0) then fails := fails || format('Payment Vouchers is %s rows out and Cash Receipts %s rows out', n, m); end if;
  select (select coalesce(sum(amount), 0) from public.finance_payment_vouchers where org_id = org and status = 'posted')
       - (select coalesce(sum(amount), 0) from public.finance_transactions where org_id = org and direction = 'out' and status = 'posted') into n;
  if n <> 0 then fails := fails || format('posted money out on Payment Vouchers is out by %s', n); end if;
  select string_agg(kind || '=' || c, ', ' order by kind) into t
    from (select kind, count(*) c from public.finance_payment_vouchers where org_id = org group by 1) k;
  if t is distinct from 'bill=3, expense=2, other=3, refund=1' then fails := fails || format('vouchers by kind: %s', t); end if;
  select string_agg(kind || '=' || c, ', ' order by kind) into t
    from (select kind, count(*) c from public.finance_cash_receipts where org_id = org group by 1) k;
  if t is distinct from 'income=1, invoice=3' then fails := fails || format('receipts by kind: %s', t); end if;
  -- The two sides of a transfer between accounts are not receipts or vouchers.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, transfer_id)
  values (org, 'out', bank, 5, 'cash', gen_random_uuid()) returning id into stray;
  if exists (select 1 from public.finance_payment_vouchers where transaction_id = stray) then
    fails := array_append(fails, 'one side of a transfer shows on Payment Vouchers');
  end if;
  delete from public.finance_transactions where id = stray;

  -- ==== a draft receipt is not looked at again when it is posted ===============
  -- A draft holds RM 100 of the second invoice. A credit note is capped by the
  -- invoice's total, not by what is owed or held, so the whole invoice can
  -- still be credited. Posting the draft then leaves the customer RM 100 in
  -- credit: the position paying first and crediting afterwards gives.
  r3 := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 100)));
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv2, 'reason', 'goodwill', 'amount', 132.5));
  perform public.finance_issue_credit_note(org, cn2);
  select * into r from public.finance_invoice_totals where id = inv2;
  if (r.paid, r.credited, r.balance, r.display_status) is distinct from (0.00, 132.50, 0.00, 'paid') then
    fails := fails || format('credited in full under a draft receipt, the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a draft receipt is posted after its invoice was credited in full', 'ok',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r3));
  select * into r from public.finance_invoice_totals where id = inv2;
  if (r.paid, r.credited, r.balance, r.display_status) is distinct from (100.00, 132.50, -100.00, 'paid') then
    fails := fails || format('with that draft posted, the invoice reads %s', row_to_json(r));
  end if;
  -- That credit can be refunded, and no more than it.
  fails := fails || public.bendahara_check_try('more than that credit is refunded', 'FIN05',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', inv2, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 100.01)));
  fails := fails || public.bendahara_check_try('that credit is refunded', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', inv2, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 100)));

  -- ==== a viewer reads and cannot write ========================================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select (select count(*) from public.finance_expense_totals where org_id = org)
       + (select count(*) from public.finance_payment_vouchers where org_id = org)
       + (select count(*) from public.finance_cash_receipts where org_id = org) into n;
  if n <> 17 then fails := fails || format('a viewer reads %s rows of the three views, not 17', n); end if;
  fails := fails || public.bendahara_check_try('a viewer saves an expense', '42501',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a viewer records a voucher', '42501',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'party_name', 'X', 'category_id', rent, 'amount', 10), null::jsonb));
  fails := fails || public.bendahara_check_try('a viewer saves a receipt', '42501',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'party_name', 'X', 'category_id', sales, 'amount', 10), null::jsonb));
  -- An update a viewer sends reaches no row.
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex1;
  update public.finance_transactions set status = 'void', updated_at = now() where id = v2;
  reset role;
  select (select count(*) from public.finance_expenses where id = ex1 and status = 'pending')
       + (select count(*) from public.finance_transactions where id = v2 and status = 'posted') into n;
  if n <> 2 then fails := array_append(fails, 'a viewer changed an expense or a voucher'); end if;

  -- ==== another workspace ======================================================
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select (select count(*) from public.finance_expense_totals where org_id = org)
       + (select count(*) from public.finance_payment_vouchers where org_id = org)
       + (select count(*) from public.finance_cash_receipts where org_id = org) into n;
  if n <> 0 then fails := fails || format('another workspace reads %s rows of the three views', n); end if;
  fails := fails || public.bendahara_check_try('another workspace saves an expense here', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', org, jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10)));
  -- The two functions below run as their owner since 20261030123000 and begin by asking whether the caller may write here.
  fails := fails || public.bendahara_check_try('another workspace pays an expense here', '42501',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('expense_id', ex2, 'amount', 10))));
  fails := fails || public.bendahara_check_try('another workspace posts a receipt here', '42501',
    format('select public.finance_post_cash_receipt(%L, %L)', org, r2));
  -- Its own expense cannot be paid from here, nor carry a category from here.
  select id into t from public.finance_categories where org_id = other_org and kind = 'expense' and name = 'Rent';
  theirs := public.finance_save_expense(other_org, jsonb_build_object('category_id', t, 'vendor_name', 'Theirs', 'amount', 10));
  fails := fails || public.bendahara_check_try('an expense is given another workspace''s category', 'FIN15',
    format('select public.finance_save_expense(%L, %L)', other_org, jsonb_build_object('category_id', rent, 'vendor_name', 'X', 'amount', 10)));
  reset role;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('an expense of another workspace is paid from here', 'FIN06',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('expense_id', theirs, 'amount', 10))));
  reset role;

  -- ==== nobody signed in =======================================================
  -- A signed-in session that names no user reaches no row, so it decides nothing.
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex1;
  reset role;
  if (select status from public.finance_expenses where id = ex1) is distinct from 'pending' then
    fails := array_append(fails, 'a session with no user approved an expense');
  end if;
  -- A migration has no user and is not asked for a role: it is how the demo seed approves its rows.
  perform set_config('request.jwt.claims', '{}', true);
  ex4 := gen_random_uuid();
  insert into public.finance_expenses (id, org_id, category_id, vendor_name, amount) values (ex4, org, rent, 'Seeded', 10);
  update public.finance_expenses set status = 'approved', approved_at = now() - interval '3 days' where id = ex4;
  select status || '/' || coalesce(approved_by::text, 'nobody') || '/' || (approved_at < now() - interval '2 days') into t
    from public.finance_expenses where id = ex4;
  if t is distinct from 'approved/nobody/true' then fails := fails || format('an expense approved by a migration reads %s', t); end if;

  -- ==== a scheduled payment is measured again when it is paid ==================
  -- No signed-in person can leave a scheduled payment out above its split any
  -- more, so one is made the way a migration could: with no user, its split is
  -- taken away. It is then money out that settles nothing and that nobody
  -- approved, and an editor cannot pay it.
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  stray := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill2, 'amount', 1)));
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  fails := fails || public.bendahara_check_try('a session with no user takes the split of a scheduled payment away', 'ok',
    format('delete from public.finance_allocations where transaction_id = %L', stray));
  perform set_config('request.jwt.claims', editor_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('an editor marks paid a scheduled payment that has lost its split', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, stray));
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  delete from public.finance_transactions where id = stray and status = 'scheduled';

  -- ==== a user is deleted: who made it and who decided it are cleared ==========
  -- If the delete is stopped by something outside finance, the clearing its
  -- foreign keys would have done is done by hand, and the message says so.
  begin
    delete from auth.users where id = editor_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so created_by was cleared by hand', sqlstate, sqlerrm));
    update public.finance_expenses set created_by = null where created_by = editor_id;
    update public.finance_transactions set created_by = null where created_by = editor_id;
    update public.finance_invoices set created_by = null where created_by = editor_id;
  end;
  select (select count(*) from public.finance_transactions where id = v1 and status = 'void' and created_by is null and approved_by = owner_id)
       + (select count(*) from public.finance_transactions where id = r2 and status = 'posted' and created_by is null)
       + (select count(*) from public.finance_expenses where id = ex1 and status = 'pending' and created_by is null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear created_by on their voucher, receipt and expense'); end if;
  begin
    delete from auth.users where id = owner_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    update public.finance_expenses set created_by = null where created_by = owner_id;
    update public.finance_expenses set approved_by = null where approved_by = owner_id;
    update public.finance_transactions set created_by = null where created_by = owner_id;
    update public.finance_transactions set approved_by = null where approved_by = owner_id;
    update public.finance_invoices set created_by = null where created_by = owner_id;
    update public.finance_credit_notes set created_by = null where created_by = owner_id;
  end;
  select (select count(*) from public.finance_transactions where id = v1 and status = 'void' and approved_by is null and approved_at is not null)
       + (select count(*) from public.finance_transactions where id = v2 and status = 'posted' and approved_by is null and created_by is null)
       + (select count(*) from public.finance_expenses where id = ex2 and status = 'approved' and approved_by is null and approved_at is not null) into n;
  if n <> 3 then fails := array_append(fails, 'deleting a user did not clear approved_by on what they approved'); end if;

  -- ==== the workspace is deleted, with everything in it =======================
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_expenses where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_invoices where org_id = org)
       + (select count(*) from public.supplier_bills where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_CASH_BOOK_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_CASH_BOOK_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
