-- Bendahara "held still" check. Run it after
-- 20261117090000_bendahara_payment_held_still.sql, in the same transaction for
-- a dry run, or by itself once the migration is applied. It needs every
-- finance migration before that one too. It goes through every change a
-- signed-in person can ask of a payment that has left draft and of its split,
-- as an owner, an admin, a member, a viewer and an outsider, what the older
-- guards still answer first, and everything that must go on working: each
-- function that records, pays, approves, voids or deletes a payment, a draft
-- and its split, a user and a workspace being deleted. It leaves nothing
-- behind either way: the block always ends with RAISE, so every row and the
-- helper function below are rolled back. Read the message:
--   BENDAHARA_PAYMENT_HELD_STILL_CHECK PASSED ...   or   BENDAHARA_PAYMENT_HELD_STILL_CHECK FAILED: <what went wrong>
-- It makes its own workspace and acts as each person the way the app does:
-- the authenticated role with that person's id in request.jwt.claims.
-- What it cannot show is two sessions at once: that a change of a split waits
-- for a payment being scheduled, and is then refused, was run by hand on a
-- local database (see the plan).
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  member_claims text;
  viewer_claims text;
  outsider_claims text;
  bank uuid;
  till uuid;
  sales uuid;
  utilities uuid;
  sup uuid;
  sup2 uuid;
  cust uuid;
  b1 uuid;
  b2 uuid;
  b3 uuid;
  inv uuid;
  inv2 uuid;
  inv3 uuid;
  cn uuid;
  ex uuid;
  s_bill uuid;
  s_bill_split uuid;
  s_refund uuid;
  s_exp uuid;
  v_pend uuid;
  v_pend2 uuid;
  v_appr uuid;
  paid uuid;
  d_out uuid;
  d_out_split uuid;
  s_in uuid;
  s_in_split uuid;
  d_in uuid;
  d_in_split uuid;
  s_in0 uuid;
  rc_draft uuid;
  tr uuid;
  n integer;
  t text;
  ctx text;
  r record;
  who text;
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  fails text[] := '{}';
  asides text[] := '{}';
begin
 begin
  -- Runs one statement as whoever is acting and answers null when it ended
  -- the expected way, or a sentence for the report. 'ok': it ran and wrote (or
  -- was a function call). 'none': it ran and found no row to write. Otherwise
  -- the SQLSTATE it must be refused with.
  execute $f$
    create function public.bendahara_held_still_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok'; rows bigint;
    begin
      begin
        execute q;
        get diagnostics rows = row_count;
        if rows = 0 then got := 'none'; end if;
      exception when others then
        got := sqlstate;
      end;
      if got = want then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_held_still_try(text, text, text) to authenticated, anon';

  -- ---- structure ------------------------------------------------------------
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname in ('finance_transaction_still_guard', 'finance_allocation_still_guard')
     and p.prosecdef and 'search_path=""' = any(p.proconfig)
     and p.proowner = (select relowner from pg_class where oid = 'public.finance_transactions'::regclass);
  if n <> 2 then fails := array_append(fails, 'the two guards do not both run as the owner of finance_transactions with a fixed search_path'); end if;
  foreach who in array array['public', 'authenticated', 'anon', 'service_role'] loop
    if has_function_privilege(who, 'private.finance_transaction_still_guard()', 'execute')
       or has_function_privilege(who, 'private.finance_allocation_still_guard()', 'execute') then
      fails := fails || format('%s can call a guard directly', who);
    end if;
  end loop;
  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p where p.prosrc like '%FIN28%';
  if t is distinct from 'finance_allocation_still_guard,finance_transaction_still_guard' then fails := fails || format('FIN28 is raised by: %s', t); end if;
  select count(*) into n from pg_proc where proname = 'finance_allocation_still_guard' and (regexp_count(prosrc, 'for\s+share', 1, 'i')) = 2;
  if n <> 1 then fails := array_append(fails, 'the split guard does not lock the payment row for share, before and after'); end if;
  -- Read as text, because no case below can show it: when a workspace is deleted, this database deletes its
  -- payments before their splits, so the split guard finds no payment and never reaches its test of the workspace.
  -- With the cascades in the other order that test is what lets the rows go (run by hand; see the plan).
  select count(*) into n from pg_proc where proname = 'finance_allocation_still_guard'
     and prosrc ~ 'tg_op = ''DELETE'' and not exists \(select 1 from public\.orgs o where o\.id = old\.org_id\) then\s+return old;';
  if n <> 1 then fails := array_append(fails, 'the split guard does not let the rows of a workspace that is being deleted go'); end if;
  -- Every trigger on payments, in name order, which is the order BEFORE ROW triggers fire in.
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_transactions'::regclass and tgenabled = 'O';
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,finance_transaction_still,'
       || 'finance_transaction_to_currency,finance_transaction_to_ringgit,finance_transaction_unmatch,finance_transfer_id_guard,finance_transfer_pair_delete,finance_transfer_pair_insert,'
       || 'finance_transfer_pair_update,finance_use_account_insert,finance_use_account_update,finance_void_stamp' then
    fails := fails || format('triggers on finance_transactions are: %s', t);
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where not tgisinternal and tgrelid = 'public.finance_allocations'::regclass and tgenabled = 'O';
  -- finance_allocation_less_contra: 20261119100000 (contra entries).
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then fails := fails || format('triggers on finance_allocations are: %s', t); end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and tgname = 'finance_transaction_still';
  if t is distinct from 'CREATE TRIGGER finance_transaction_still BEFORE UPDATE ON public.finance_transactions FOR EACH ROW '
       || 'WHEN (((old.status <> ''draft''::text) AND ((new.status IS DISTINCT FROM old.status) OR (new.direction IS DISTINCT FROM old.direction) '
       || 'OR (new.account_id IS DISTINCT FROM old.account_id) OR (new.txn_date IS DISTINCT FROM old.txn_date) '
       || 'OR (new.amount IS DISTINCT FROM old.amount) OR (new.method IS DISTINCT FROM old.method) '
       || 'OR (new.reference IS DISTINCT FROM old.reference) OR (new.contact_id IS DISTINCT FROM old.contact_id) '
       || 'OR (new.party_name IS DISTINCT FROM old.party_name) OR (new.category_id IS DISTINCT FROM old.category_id) '
       || 'OR (new.notes IS DISTINCT FROM old.notes)))) EXECUTE FUNCTION private.finance_transaction_still_guard()' then
    fails := fails || format('finance_transaction_still is: %s', t);
  end if;
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and tgname = 'finance_allocation_still';
  if t is distinct from 'CREATE TRIGGER finance_allocation_still BEFORE INSERT OR DELETE OR UPDATE ON public.finance_allocations '
       || 'FOR EACH ROW EXECUTE FUNCTION private.finance_allocation_still_guard()' then
    fails := fails || format('finance_allocation_still is: %s', t);
  end if;
  -- Every column of a payment a signed-in person may write is held by the
  -- function, or is one of the three it leaves alone (status is what it
  -- watches, transfer_id has its own guard, updated_at is anyone's).
  select string_agg(a.attname, ',' order by a.attname) into t
    from pg_attribute a
   where a.attrelid = 'public.finance_transactions'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')
     and a.attname not in ('updated_at', 'transfer_id', 'status')
     and not exists (select 1 from pg_proc p where p.proname = 'finance_transaction_still_guard'
                      and p.prosrc like '%new.' || a.attname || '%' and p.prosrc like '%old.' || a.attname || '%');
  if t is not null then fails := fails || format('columns a person may write that the payment guard does not hold: %s', t); end if;

  -- ---- a workspace and its people --------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@heldstill.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'Held Still Check Sdn Bhd'), (other_org, 'Held Still Check Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into sales from public.finance_categories where org_id = org and kind = 'income' order by name limit 1;
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  if bank is null or till is null or sales is null or utilities is null then
    raise exception 'BENDAHARA_PAYMENT_HELD_STILL_CHECK FAILED: a new workspace was not seeded with a bank account, cash and categories';
  end if;

  -- ---- documents, as the owner; payments, as the member ------------------------
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Check Supplier', false, true) returning id into sup;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Check Other Supplier', false, true) returning id into sup2;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Check Customer', true, false) returning id into cust;
  -- Three bills and three invoices of RM 132.50.
  b1 := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b1);
  b2 := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b2);
  b3 := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup2, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, b3);
  inv := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv);
  inv2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv2);
  inv3 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv3);
  -- The first invoice is paid in full and then credited RM 30, so the customer is in credit.
  fails := fails || public.bendahara_held_still_try('the owner records a payment in', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 132.5))));
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv, 'credit_date', current_date, 'reason', 'returns', 'amount', 30));
  perform public.finance_issue_credit_note(org, cn);
  paid := public.finance_record_payment_out(org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', b2, 'amount', 10)));

  perform set_config('request.jwt.claims', member_claims, true);
  ex := public.finance_save_expense(org, jsonb_build_object(
    'expense_date', current_date, 'category_id', utilities, 'vendor_name', 'Check Vendor', 'amount', 40));
  perform set_config('request.jwt.claims', owner_claims, true);
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex;

  -- What a member may leave "To be paid" with nobody approving it: a payment
  -- for a supplier's bill, a pending refund, a voucher for an approved expense.
  perform set_config('request.jwt.claims', member_claims, true);
  s_bill := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled', 'reference', 'REF-1'),
    jsonb_build_array(jsonb_build_object('bill_id', b1, 'amount', 100)));
  select id into s_bill_split from public.finance_allocations where transaction_id = s_bill;
  s_refund := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'bank_transfer', 'reason', 'damaged_goods', 'amount', 20, 'status', 'scheduled'));
  s_exp := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('expense_id', ex, 'amount', 40)));
  -- Vouchers for a category wait for an owner or admin.
  v_pend := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 6, 'party_name', 'Asked', 'category_id', utilities), '[]');
  v_pend2 := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 7, 'party_name', 'Asked again', 'category_id', utilities), '[]');
  v_appr := public.finance_record_voucher(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 8, 'party_name', 'Approved', 'category_id', utilities), '[]');
  -- A draft with a split, written by hand as a direct caller would.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 5, 'fpx', sup) returning id into d_out;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, d_out, b2, 5) returning id into d_out_split;
  -- Money in that is scheduled: nothing in the app makes one, a direct caller can.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'in', bank, 5, 'cash', cust) returning id into s_in;
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (org, s_in, inv2, 1) returning id into s_in_split;
  update public.finance_transactions set status = 'scheduled' where id = s_in;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'in', bank, 5, 'cash', cust) returning id into d_in;
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (org, d_in, inv3, 1) returning id into d_in_split;
  -- Scheduled money in with no split: the older guard lets an owner turn it into money out and approves it.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'in', bank, 5, 'cash', cust) returning id into s_in0;
  update public.finance_transactions set status = 'scheduled' where id = s_in0;

  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_held_still_try('the owner approves a waiting voucher', 'ok',
    format('update public.finance_transactions set status = ''scheduled'', updated_at = now() where id = %L', v_appr));
  select count(*) into n from public.finance_transactions
   where org_id = org and ((id in (s_bill, s_refund, s_exp, s_in) and status = 'scheduled' and approved_at is null)
     or (id in (v_pend, v_pend2) and status = 'pending_approval')
     or (id = v_appr and status = 'scheduled' and approved_at is not null and approved_by = owner_id)
     or (id = paid and status = 'posted') or (id = d_out and status = 'draft'));
  if n <> 9 then fails := fails || format('the fixtures are not four scheduled, two waiting, one approved, one paid and one draft payment (%s of 9)', n); end if;

  -- ==== a member: the payment for a bill that is to be paid ====================
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_held_still_try('a member sends a scheduled payment back to draft', 'FIN28',
    format('update public.finance_transactions set status = ''draft'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member moves a scheduled payment to another account', 'FIN28',
    format('update public.finance_transactions set account_id = %L where id = %L', till, s_bill));
  fails := fails || public.bendahara_held_still_try('a member changes the date of a scheduled payment', 'FIN28',
    format('update public.finance_transactions set txn_date = current_date + 9 where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member changes the reference of a scheduled payment', 'FIN28',
    format('update public.finance_transactions set reference = ''OTHER'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member clears the reference of a scheduled payment', 'FIN28',
    format('update public.finance_transactions set reference = null where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member changes the notes of a scheduled payment', 'FIN28',
    format('update public.finance_transactions set notes = ''x'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member changes the method of a scheduled payment', 'FIN28',
    format('update public.finance_transactions set method = ''cash'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member gives a scheduled payment a category', 'FIN28',
    format('update public.finance_transactions set category_id = %L where id = %L', utilities, s_bill));
  fails := fails || public.bendahara_held_still_try('a member changes the payee of a scheduled payment', 'FIN28',
    format('update public.finance_transactions set contact_id = %L where id = %L', sup2, s_bill));
  fails := fails || public.bendahara_held_still_try('a member names another payee on a scheduled payment', 'FIN28',
    format('update public.finance_transactions set contact_id = null, party_name = ''Someone'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member points the split of a scheduled payment at another bill', 'FIN28',
    format('update public.finance_allocations set bill_id = %L where id = %L', b2, s_bill_split));
  fails := fails || public.bendahara_held_still_try('a member points the split of a scheduled payment at another supplier''s bill', 'FIN28',
    format('update public.finance_allocations set bill_id = %L where id = %L', b3, s_bill_split));
  fails := fails || public.bendahara_held_still_try('a member gives the split of a scheduled payment a reason', 'FIN28',
    format('update public.finance_allocations set reason = ''other'' where id = %L', s_bill_split));
  fails := fails || public.bendahara_held_still_try('a member moves the split of a scheduled payment onto a draft', 'FIN14',
    format('update public.finance_allocations set transaction_id = %L where id = %L', d_out, s_bill_split));
  -- A change of nothing but the time is let through, on the payment and on its split.
  fails := fails || public.bendahara_held_still_try('a member touches updated_at of a scheduled payment', 'ok',
    format('update public.finance_transactions set updated_at = now() + interval ''1 second'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member touches updated_at of the split of a scheduled payment', 'ok',
    format('update public.finance_allocations set updated_at = now() + interval ''1 second'' where id = %L', s_bill_split));
  -- What the older guards refuse they still refuse first, with the code they had.
  fails := fails || public.bendahara_held_still_try('a member lowers a scheduled payment under its split', 'FIN03',
    format('update public.finance_transactions set amount = 60 where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member raises a scheduled payment above its split', 'FIN14',
    format('update public.finance_transactions set amount = 120 where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member lowers the split of a scheduled payment', 'FIN14',
    format('update public.finance_allocations set amount = 60 where id = %L', s_bill_split));
  fails := fails || public.bendahara_held_still_try('a member raises the split of a scheduled payment', 'FIN03',
    format('update public.finance_allocations set amount = 120 where id = %L', s_bill_split));
  fails := fails || public.bendahara_held_still_try('a member takes the split of a scheduled payment away', 'FIN14',
    format('delete from public.finance_allocations where id = %L', s_bill_split));
  fails := fails || public.bendahara_held_still_try('a member adds to the split of a scheduled payment', 'FIN03',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 5)', org, s_bill, b2));
  fails := fails || public.bendahara_held_still_try('a member marks a scheduled payment paid', 'FIN14',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, s_bill));
  fails := fails || public.bendahara_held_still_try('a member voids a scheduled payment', 'FIN09',
    format('update public.finance_transactions set status = ''void'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a member sends a scheduled payment for approval', 'FIN14',
    format('update public.finance_transactions set status = ''pending_approval'' where id = %L', s_bill));
  -- The other two kinds a member schedules.
  fails := fails || public.bendahara_held_still_try('a member moves a pending refund to another account', 'FIN28',
    format('update public.finance_transactions set account_id = %L where id = %L', till, s_refund));
  fails := fails || public.bendahara_held_still_try('a member sends a pending refund back to draft', 'FIN28',
    format('update public.finance_transactions set status = ''draft'' where id = %L', s_refund));
  fails := fails || public.bendahara_held_still_try('a member changes the reason of a pending refund', 'FIN28',
    format('update public.finance_allocations set reason = ''overpayment'' where transaction_id = %L', s_refund));
  fails := fails || public.bendahara_held_still_try('a member changes the notes of a scheduled voucher for an expense', 'FIN28',
    format('update public.finance_transactions set notes = ''x'' where id = %L', s_exp));
  fails := fails || public.bendahara_held_still_try('a member sends a scheduled voucher for an expense back to draft', 'FIN28',
    format('update public.finance_transactions set status = ''draft'' where id = %L', s_exp));
  -- Money in that was scheduled by hand: the older guard does not measure its split, this one holds it.
  fails := fails || public.bendahara_held_still_try('a member adds to the split of scheduled money in', 'FIN28',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 1)', org, s_in, inv3));
  fails := fails || public.bendahara_held_still_try('a member moves the split of scheduled money in onto a draft', 'FIN28',
    format('update public.finance_allocations set transaction_id = %L where id = %L', d_in, s_in_split));
  fails := fails || public.bendahara_held_still_try('a member takes the split of scheduled money in away', 'FIN28',
    format('delete from public.finance_allocations where id = %L', s_in_split));
  fails := fails || public.bendahara_held_still_try('a member raises scheduled money in', 'FIN28',
    format('update public.finance_transactions set amount = 50 where id = %L', s_in));
  fails := fails || public.bendahara_held_still_try('a member moves the split of a draft onto scheduled money in', 'FIN28',
    format('update public.finance_allocations set transaction_id = %L where id = %L', s_in, d_in_split));
  fails := fails || public.bendahara_held_still_try('a member gives the split of scheduled money in another id', 'FIN28',
    format('update public.finance_allocations set id = gen_random_uuid() where id = %L', s_in_split));
  fails := fails || public.bendahara_held_still_try('a member changes when the split of a scheduled payment was made', 'FIN28',
    format('update public.finance_allocations set created_at = now() - interval ''1 day'' where id = %L', s_bill_split));
  -- Waiting, approved and paid payments were held already, and answer as they did.
  fails := fails || public.bendahara_held_still_try('a member changes the notes of a waiting voucher', 'FIN14',
    format('update public.finance_transactions set notes = ''x'' where id = %L', v_pend));
  fails := fails || public.bendahara_held_still_try('a member sends a waiting voucher back to draft', 'FIN14',
    format('update public.finance_transactions set status = ''draft'' where id = %L', v_pend));
  fails := fails || public.bendahara_held_still_try('a member changes the notes of an approved voucher', 'FIN14',
    format('update public.finance_transactions set notes = ''x'' where id = %L', v_appr));
  fails := fails || public.bendahara_held_still_try('a member changes the notes of a paid payment', 'FIN09',
    format('update public.finance_transactions set notes = ''x'' where id = %L', paid));
  fails := fails || public.bendahara_held_still_try('a member changes the split of a paid payment', 'FIN09',
    format('update public.finance_allocations set bill_id = %L where transaction_id = %L', b1, paid));
  -- A draft is not held: its amount, its split and its account are the member's to change.
  fails := fails || public.bendahara_held_still_try('a member edits a draft', 'ok',
    format('update public.finance_transactions set notes = ''first'', txn_date = current_date + 1, account_id = %L where id = %L', till, d_out));
  fails := fails || public.bendahara_held_still_try('a member points the split of a draft at another bill', 'ok',
    format('update public.finance_allocations set bill_id = %L where id = %L', b1, d_out_split));
  select count(*) into n from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id
   where t.id = s_bill and t.status = 'scheduled' and t.account_id = bank and t.amount = 100 and t.reference = 'REF-1'
     and t.notes is null and t.method = 'fpx' and t.category_id is null and t.contact_id = sup and t.txn_date = current_date
     and a.bill_id = b1 and a.amount = 100 and a.reason is null;
  if n <> 1 then fails := array_append(fails, 'the scheduled payment is not as the member scheduled it after the member''s attempts'); end if;

  -- ==== an owner and an admin: held as a member is, the way back to draft included ===
  foreach who in array array['owner', 'admin'] loop
    perform set_config('request.jwt.claims', case who when 'owner' then owner_claims else admin_claims end, true);
    fails := fails || public.bendahara_held_still_try(format('an %s moves a scheduled payment to another account', who), 'FIN28',
      format('update public.finance_transactions set account_id = %L where id = %L', till, s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s raises a scheduled payment above its split', who), 'FIN28',
      format('update public.finance_transactions set amount = 120 where id = %L', s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s raises a scheduled payment by one sen', who), 'FIN28',
      format('update public.finance_transactions set amount = 100.01 where id = %L', s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s turns scheduled money in with no split into money out', who), 'FIN28',
      format('update public.finance_transactions set direction = ''out'' where id = %L', s_in0));
    fails := fails || public.bendahara_held_still_try(format('an %s changes the payee of a scheduled payment', who), 'FIN28',
      format('update public.finance_transactions set contact_id = %L where id = %L', sup2, s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s changes the notes of a scheduled payment', who), 'FIN28',
      format('update public.finance_transactions set notes = ''x'' where id = %L', s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s points the split of a scheduled payment at another supplier''s bill', who), 'FIN28',
      format('update public.finance_allocations set bill_id = %L where id = %L', b3, s_bill_split));
    fails := fails || public.bendahara_held_still_try(format('an %s sends a scheduled payment back to draft', who), 'FIN28',
      format('update public.finance_transactions set status = ''draft'', updated_at = now() where id = %L', s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s sends a pending refund back to draft', who), 'FIN28',
      format('update public.finance_transactions set status = ''draft'' where id = %L', s_refund));
    fails := fails || public.bendahara_held_still_try(format('an %s sends scheduled money in back to draft', who), 'FIN28',
      format('update public.finance_transactions set status = ''draft'' where id = %L', s_in));
    fails := fails || public.bendahara_held_still_try(format('an %s sends a scheduled payment back to draft and edits it at once', who), 'FIN28',
      format('update public.finance_transactions set status = ''draft'', reference = ''OTHER'' where id = %L', s_bill));
    fails := fails || public.bendahara_held_still_try(format('an %s changes the notes of an approved voucher', who), 'FIN14',
      format('update public.finance_transactions set notes = ''x'' where id = %L', v_appr));
    fails := fails || public.bendahara_held_still_try(format('an %s sends an approved voucher back to draft', who), 'FIN14',
      format('update public.finance_transactions set status = ''draft'' where id = %L', v_appr));
    fails := fails || public.bendahara_held_still_try(format('an %s approves a waiting voucher and edits it at once', who), 'FIN14',
      format('update public.finance_transactions set status = ''scheduled'', notes = ''x'' where id = %L', v_pend));
    fails := fails || public.bendahara_held_still_try(format('an %s changes the notes of a paid payment', who), 'FIN09',
      format('update public.finance_transactions set notes = ''x'' where id = %L', paid));
  end loop;

  -- ==== a viewer, an outsider, nobody signed in, the service role ================
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_held_still_try('a viewer changes the notes of a scheduled payment', 'none',
    format('update public.finance_transactions set notes = ''x'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a viewer sends a scheduled payment back to draft', 'none',
    format('update public.finance_transactions set status = ''draft'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('a viewer points the split of a scheduled payment at another bill', 'none',
    format('update public.finance_allocations set bill_id = %L where id = %L', b2, s_bill_split));
  -- An INSERT reaches the BEFORE triggers before the row policy. The older guard runs as the viewer, cannot write
  -- the invoice it would lock, and answers first, as it did before this rule.
  fails := fails || public.bendahara_held_still_try('a viewer adds to the split of scheduled money in', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 1)', org, s_in, inv3));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_held_still_try('an outsider changes the notes of a scheduled payment', 'none',
    format('update public.finance_transactions set notes = ''x'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('an outsider sends a scheduled payment back to draft', 'none',
    format('update public.finance_transactions set status = ''draft'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('an outsider points the split of a scheduled payment at another bill', 'none',
    format('update public.finance_allocations set bill_id = %L where id = %L', b2, s_bill_split));
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  fails := fails || public.bendahara_held_still_try('nobody signed in, through the API, changes a scheduled payment', '42501',
    format('update public.finance_transactions set notes = ''x'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('nobody signed in, through the API, changes a split', '42501',
    format('update public.finance_allocations set bill_id = %L where id = %L', b2, s_bill_split));
  reset role;
  if has_table_privilege('service_role', 'public.finance_transactions', 'update')
     or has_table_privilege('service_role', 'public.finance_allocations', 'insert, update, delete') then
    fails := array_append(fails, 'service_role can write payments or splits');
  end if;
  -- The database owner with nobody signed in (a migration, the SQL editor): the rule steps aside.
  fails := fails || public.bendahara_held_still_try('the database owner, nobody signed in, edits a scheduled payment', 'ok',
    format('update public.finance_transactions set notes = ''by hand'' where id = %L', s_bill));
  fails := fails || public.bendahara_held_still_try('the database owner, nobody signed in, changes a split', 'ok',
    format('update public.finance_allocations set bill_id = %L where id = %L', b2, s_bill_split));
  update public.finance_allocations set bill_id = b1 where id = s_bill_split;
  update public.finance_transactions set notes = null where id = s_bill;

  -- ==== what goes on working ====================================================
  -- A draft that is scheduled is held from that moment, and nobody sends it back.
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  fails := fails || public.bendahara_held_still_try('a member schedules a draft that is exactly its split', 'ok',
    format('update public.finance_transactions set status = ''scheduled'' where id = %L', d_out));
  fails := fails || public.bendahara_held_still_try('a member edits the draft they have just scheduled', 'FIN28',
    format('update public.finance_transactions set notes = ''second'' where id = %L', d_out));
  fails := fails || public.bendahara_held_still_try('a member sends the draft they have just scheduled back to draft', 'FIN28',
    format('update public.finance_transactions set status = ''draft'' where id = %L', d_out));
  fails := fails || public.bendahara_held_still_try('a member changes the split of the draft they have just scheduled', 'FIN28',
    format('update public.finance_allocations set bill_id = %L where id = %L', b2, d_out_split));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_held_still_try('the owner sends a payment a member has just scheduled back to draft', 'FIN28',
    format('update public.finance_transactions set status = ''draft'' where id = %L', d_out));
  select status || '/' || coalesce(notes, 'none') || '/' || account_id into t from public.finance_transactions where id = d_out;
  if t is distinct from 'scheduled/first/' || till then fails := fails || format('the draft that was scheduled reads %s', t); end if;

  -- Deleting what is not paid, by a member: the split goes with the payment.
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_held_still_try('a member deletes a pending refund', 'ok',
    format('delete from public.finance_transactions where id = %L', s_refund));
  fails := fails || public.bendahara_held_still_try('a member deletes scheduled money in', 'ok',
    format('delete from public.finance_transactions where id = %L', s_in));
  fails := fails || public.bendahara_held_still_try('a member deletes the payment they scheduled from a draft', 'ok',
    format('delete from public.finance_transactions where id = %L', d_out));
  select count(*) into n from public.finance_allocations where transaction_id in (s_refund, s_in, d_out);
  if n <> 0 then fails := fails || format('deleting three payments left %s rows of their splits', n); end if;
  -- A member records what a member may record, through each function.
  fails := fails || public.bendahara_held_still_try('a member schedules a refund', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn, 'account_id', bank, 'method', 'bank_transfer', 'reason', 'damaged_goods', 'amount', 20, 'status', 'scheduled')));
  select t2.id into s_refund from public.finance_transactions t2 join public.finance_allocations a on a.transaction_id = t2.id
   where t2.org_id = org and a.credit_note_id = cn;
  fails := fails || public.bendahara_held_still_try('a member schedules a payment for a bill', 'ok',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', b3, 'amount', 12))));
  fails := fails || public.bendahara_held_still_try('a member saves a draft receipt for an invoice', 'ok',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'cash'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 10))));
  select t2.id into rc_draft from public.finance_transactions t2 join public.finance_allocations a on a.transaction_id = t2.id
   where t2.org_id = org and t2.direction = 'in' and t2.status = 'draft' and a.invoice_id = inv2;
  -- Saving a draft again takes its old split away and writes the new one.
  fails := fails || public.bendahara_held_still_try('a member saves the draft receipt again with another split', 'ok',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org, jsonb_build_object('id', rc_draft, 'account_id', till, 'method', 'cash'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 25))));
  select t2.amount || '/' || a.amount || '/' || t2.account_id into t from public.finance_transactions t2
    join public.finance_allocations a on a.transaction_id = t2.id where t2.id = rc_draft;
  if t is distinct from '25.00/25.00/' || till then fails := fails || format('the draft receipt saved again reads %s', t); end if;

  -- The owner: pays, approves, rejects, posts, voids, moves money between accounts.
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_held_still_try('the owner marks a scheduled payment paid, on another day', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date + 3)', org, s_bill));
  select status || '/' || amount || '/' || (txn_date - current_date) || '/' || (number like 'PV-%') || '/' || account_id || '/' || reference
    into t from public.finance_transactions where id = s_bill;
  if t is distinct from 'posted/100.00/3/true/' || bank || '/REF-1' then fails := fails || format('the scheduled payment marked paid reads %s', t); end if;
  fails := fails || public.bendahara_held_still_try('the owner pays a pending refund out', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, null)', org, s_refund));
  fails := fails || public.bendahara_held_still_try('the owner marks a scheduled voucher for an expense paid', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date)', org, s_exp));
  fails := fails || public.bendahara_held_still_try('the owner marks an approved voucher paid', 'ok',
    format('select public.finance_mark_payment_paid(%L, %L, current_date + 1)', org, v_appr));
  fails := fails || public.bendahara_held_still_try('the owner approves a waiting voucher, as the app does', 'ok',
    format('update public.finance_transactions set status = ''scheduled'', updated_at = now() where id = %L', v_pend));
  fails := fails || public.bendahara_held_still_try('the owner rejects a waiting voucher, as the app does', 'ok',
    format('update public.finance_transactions set status = ''rejected'', updated_at = now() where id = %L', v_pend2));
  fails := fails || public.bendahara_held_still_try('the owner changes the notes of a rejected voucher', 'FIN14',
    format('update public.finance_transactions set notes = ''x'' where id = %L', v_pend2));
  fails := fails || public.bendahara_held_still_try('the owner sends a rejected voucher back to draft', 'FIN14',
    format('update public.finance_transactions set status = ''draft'' where id = %L', v_pend2));
  fails := fails || public.bendahara_held_still_try('the owner deletes a rejected voucher', 'ok',
    format('delete from public.finance_transactions where id = %L', v_pend2));
  fails := fails || public.bendahara_held_still_try('the owner voids a paid payment, as the app does', 'ok',
    format('update public.finance_transactions set status = ''void'', updated_at = now() where id = %L', paid));
  select count(*) into n from public.finance_transactions where id = paid and status = 'void' and voided_at is not null;
  if n <> 1 then fails := array_append(fails, 'a voided payment is not void with the time it was voided'); end if;
  fails := fails || public.bendahara_held_still_try('the owner changes the notes of a void payment', 'FIN09',
    format('update public.finance_transactions set notes = ''x'' where id = %L', paid));
  fails := fails || public.bendahara_held_still_try('the owner posts a draft receipt', 'ok',
    format('select public.finance_post_cash_receipt(%L, %L)', org, rc_draft));
  fails := fails || public.bendahara_held_still_try('the owner saves a posted receipt again', 'FIN09',
    format('select public.finance_save_cash_receipt(%L, %L, %L)', org, jsonb_build_object('id', rc_draft, 'account_id', till, 'method', 'cash'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 20))));
  fails := fails || public.bendahara_held_still_try('the owner voids a posted receipt, as the app does', 'ok',
    format('update public.finance_transactions set status = ''void'', updated_at = now() where id = %L', rc_draft));
  fails := fails || public.bendahara_held_still_try('the owner records a voucher for a category, to be paid', 'ok',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 9, 'party_name', 'Later', 'category_id', utilities, 'status', 'scheduled')));
  fails := fails || public.bendahara_held_still_try('the owner records a voucher for a category, paid now', 'ok',
    format('select public.finance_record_voucher(%L, %L, ''[]'')', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount', 9, 'party_name', 'Now', 'category_id', utilities)));
  fails := fails || public.bendahara_held_still_try('the owner records a payment for a bill, paid now', 'ok',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('bill_id', b3, 'amount', 7))));
  tr := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 3));
  fails := fails || public.bendahara_held_still_try('the owner changes one side of a transfer', 'FIN09',
    format('update public.finance_transactions set notes = ''x'' where transfer_id = %L and direction = ''out''', tr));
  fails := fails || public.bendahara_held_still_try('the owner voids a transfer', 'ok',
    format('select public.finance_void_transfer(%L, %L)', org, tr));
  select count(*) into n from public.finance_transactions where org_id = org and transfer_id = tr and status = 'void';
  if n <> 2 then fails := array_append(fails, 'a voided transfer is not void on both sides'); end if;
  reset role;

  -- ==== a user is deleted by a role with no rights on public ====================
  -- The member made payments that are still to be paid. The foreign key clears
  -- created_by with an UPDATE that the WHEN clause passes by.
  select count(*) into n from public.finance_transactions where org_id = org and created_by = member_id and status = 'scheduled';
  if n < 1 then fails := array_append(fails, 'the member has no scheduled payment left to be cleared from'); end if;
  begin
    create role bendahara_held_still_auth_role nologin;
    grant bendahara_held_still_auth_role to current_user;
    grant usage on schema auth to bendahara_held_still_auth_role;
    grant select, delete on auth.users to bendahara_held_still_auth_role;
    perform set_config('request.jwt.claims', owner_claims, true);
    set local role bendahara_held_still_auth_role;
    delete from auth.users where id = member_id;
    reset role;
    select count(*) into n from public.finance_transactions where org_id = org and created_by = member_id;
    if n <> 0 then fails := array_append(fails, 'a user deleted by the auth role was not cleared from the payments they made'); end if;
  exception when others then
    get stacked diagnostics ctx = pg_exception_context;
    reset role;
    if sqlstate like 'FIN%' or ctx ilike '%finance_%' or sqlerrm ilike '%finance_%' then
      fails := fails || format('a user with a scheduled payment cannot be deleted by a role with no rights on public: %s %s', sqlstate, sqlerrm);
    else
      asides := array_append(asides, format('the delete by a role with no rights on public was not tried to the end (%s: %s)', sqlstate, sqlerrm));
    end if;
  end;

  -- ==== the workspace is deleted, with everything in it, by someone signed in ====
  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) into n from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id
   where t.org_id = org and t.status <> 'draft';
  if n < 1 then fails := array_append(fails, 'no payment that has left draft still has a split when the workspace is deleted'); end if;
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s payments and rows of their splits', n); end if;
  delete from public.orgs where id = other_org;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_PAYMENT_HELD_STILL_CHECK PASSED (everything rolled back)%',
      case when array_length(asides, 1) is null then '' else ' NOTE: ' || array_to_string(asides, ' | ') end;
  end if;
  raise exception 'BENDAHARA_PAYMENT_HELD_STILL_CHECK FAILED: %', array_to_string(fails, ' | ');
 exception when others then
  if sqlerrm like 'BENDAHARA_PAYMENT_HELD_STILL_CHECK%' then raise; end if;
  raise exception 'BENDAHARA_PAYMENT_HELD_STILL_CHECK FAILED: stopped on % (%) after: %',
    sqlstate, sqlerrm, coalesce(nullif(array_to_string(array_remove(fails, null), ' | '), ''), 'nothing had failed yet');
 end;
end $$;
