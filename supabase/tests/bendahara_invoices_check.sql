-- Brought up to date with 20261030123000_finance_write_guards, which it now
-- needs: a statement that writes a payment's `number` straight to
-- finance_transactions as a signed-in person is expected to answer 42501 (the
-- column is not writable), and what the editor (role `member`) posts or pays
-- is expected to answer FIN14, with the owner then doing it.
-- Bendahara invoices check. Run it after 20261014100000_bendahara_invoices.sql,
-- in the same transaction for a dry run, or by itself once the migration is
-- applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper function below are rolled back. Read the
-- message:
--   BENDAHARA_INVOICES_CHECK PASSED ...   or   BENDAHARA_INVOICES_CHECK FAILED: <what went wrong>
-- It makes its own workspace, with an owner, an editor, a viewer and an
-- outsider, and acts as each of them the way the app does: the authenticated
-- role with that person's id in request.jwt.claims.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  bank uuid;
  cust uuid;
  cust2 uuid;
  sup uuid;
  inv uuid;
  inv2 uuid;
  inv3 uuid;
  theirs uuid;
  draft uuid;
  bill uuid;
  rc1 uuid;
  rc2 uuid;
  rc3 uuid;
  pv1 uuid;
  pv2 uuid;
  stray uuid;
  no text;
  n integer;
  t text;
  r record;
  -- 10 x 12.50 = 125.00, plus 6% SST 7.50: RM 132.50.
  one_line jsonb := '[{"description":"Check","quantity":10,"unit_price":12.5,"sst_rate":6}]';
  two_lines jsonb := '[{"description":"Second typed first","quantity":1,"unit_price":5},{"description":"First typed second","quantity":1,"unit_price":5}]';
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
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_invoices','finance_invoice_lines');
  if n <> 10 then fails := fails || format('expected 10 policies on the two new tables, found %s', n); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('finance_invoices','finance_invoice_lines')
     and policyname = 'mfa_required' and permissive = 'RESTRICTIVE';
  if n <> 2 then fails := fails || format('expected 2 restrictive mfa_required policies, found %s', n); end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('finance_invoice_totals','finance_payments_in')
     and c.reloptions::text ilike '%security_invoker=true%';
  if n <> 2 then fails := fails || format('expected 2 security_invoker views, found %s', n); end if;
  select string_agg(conname, ',' order by conname) into t from pg_constraint
   where conrelid = 'public.finance_allocations'::regclass and contype = 'c';
  -- The sales follow-ons migration adds the third, so this check needs that migration applied.
  -- 20261120110000 (3b) adds the three on amount_myr and carried_myr.
  if t is distinct from 'finance_allocations_amount_check,finance_allocations_amount_myr_check,finance_allocations_carried_myr_check,'
       || 'finance_allocations_myr_pair_check,finance_allocations_one_document_check,finance_allocations_reason_check' then
    fails := fails || format('check constraints on finance_allocations are: %s', t);
  end if;
  foreach t in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_post_invoice(uuid, uuid)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)'
  ] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('anon can execute %s', t); end if;
    if not has_function_privilege('authenticated', t, 'execute') then fails := fails || format('authenticated cannot execute %s', t); end if;
  end loop;
  foreach t in array array['finance_invoices','finance_invoice_lines','finance_invoice_totals','finance_payments_in'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then fails := fails || format('anon can read %s', t); end if;
  end loop;

  -- ---- people and two workspaces -------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@invoices-check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, editor_id, viewer_id, outsider]) as u(id);

  -- The trigger on orgs gives each workspace its accounts and categories.
  insert into public.orgs (id, name) values (org, 'Invoices Check Sdn Bhd'), (other_org, 'Invoices Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, editor_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  if bank is null then raise exception 'BENDAHARA_INVOICES_CHECK cannot run: the new workspace has no bank account'; end if;

  -- ==== as the owner =========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;

  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Check Customer Two', true) returning id into cust2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Check Supplier', true) returning id into sup;

  -- ---- save: a draft has no number, and its lines keep the order typed ------
  inv := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), two_lines);
  select string_agg(description, '|' order by position, id) into t
    from public.finance_invoice_lines where invoice_id = inv;
  if t is distinct from 'Second typed first|First typed second' then fails := fails || format('line order: %s', t); end if;
  if public.finance_save_invoice(org,
       jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30, 'notes', 'Changed'),
       one_line) is distinct from inv then
    fails := array_append(fails, 'saving a draft again did not keep its id');
  end if;
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.invoice_no, r.subtotal, r.sst, r.total, r.paid, r.balance, r.display_status, r.customer_name, r.notes)
     is distinct from (null::text, 125.00, 7.50, 132.50, 0.00, 132.50, 'draft', 'Check Customer', 'Changed') then
    fails := fails || format('a draft reads as %s', row_to_json(r));
  end if;

  -- ---- what a draft refuses -------------------------------------------------
  fails := fails || public.bendahara_check_try('an invoice with no line is saved', 'FIN10',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), '[]'::jsonb));
  fails := fails || public.bendahara_check_try('an invoice is created already posted', 'FIN01',
    format('insert into public.finance_invoices (org_id, customer_id, invoice_no, due_date, status) values (%L, %L, %L, current_date, %L)',
      org, cust, 'INV-SNEAKY', 'posted'));
  fails := fails || public.bendahara_check_try('a draft is voided', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('a draft carries an e-Invois status', '23514',
    format('update public.finance_invoices set einvoice_status = %L where id = %L', 'validated', inv));
  fails := fails || public.bendahara_check_try('a draft is given a number', '23514',
    format('update public.finance_invoices set invoice_no = %L where id = %L', 'INV-SNEAKY', inv));
  fails := fails || public.bendahara_check_try('an invoice is created as a draft with a number', '23514',
    format('insert into public.finance_invoices (org_id, customer_id, invoice_no, due_date) values (%L, %L, %L, current_date)',
      org, cust, 'INV-SNEAKY'));
  fails := fails || public.bendahara_check_try('a payment goes against a draft invoice', 'FIN04',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 10))));
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date),
    '[{"description":"Free sample","quantity":1,"unit_price":0}]');
  fails := fails || public.bendahara_check_try('an invoice of nothing is posted', 'FIN10',
    format('select public.finance_post_invoice(%L, %L)', org, draft));
  fails := fails || public.bendahara_check_try('an invoice of nothing is posted behind the function', 'FIN10',
    format('update public.finance_invoices set status = %L, invoice_no = %L where id = %L', 'posted', 'INV-SNEAKY', draft));
  fails := fails || public.bendahara_check_try('a draft is deleted', 'ok',
    format('delete from public.finance_invoices where id = %L', draft));
  if exists (select 1 from public.finance_invoice_lines where invoice_id = draft) then
    fails := array_append(fails, 'deleting a draft left its lines');
  end if;

  -- ---- post -----------------------------------------------------------------
  no := public.finance_post_invoice(org, inv);
  if no is distinct from 'INV-0001' then fails := fails || format('the first invoice was numbered %s', no); end if;
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.invoice_no, r.display_status, r.status) is distinct from ('INV-0001', 'sent', 'posted') or r.posted_at is null then
    fails := fails || format('a posted invoice reads as %s', row_to_json(r));
  end if;

  -- ---- what a posted invoice refuses, and the one thing it allows -----------
  fails := fails || public.bendahara_check_try('a posted invoice is edited', 'FIN01',
    format('update public.finance_invoices set notes = %L where id = %L', 'Sneaky', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is saved again', 'FIN01',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30, 'notes', 'Changed'), one_line));
  fails := fails || public.bendahara_check_try('a posted invoice is given a line', 'FIN01',
    format('insert into public.finance_invoice_lines (org_id, invoice_id, description, quantity, unit_price) values (%L, %L, %L, 1, 1)', org, inv, 'Extra'));
  fails := fails || public.bendahara_check_try('a line of a posted invoice is changed', 'FIN01',
    format('update public.finance_invoice_lines set unit_price = 1 where invoice_id = %L', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is deleted', 'FIN01',
    format('delete from public.finance_invoices where id = %L', inv));
  fails := fails || public.bendahara_check_try('a posted invoice is posted again', 'FIN01',
    format('select public.finance_post_invoice(%L, %L)', org, inv));
  fails := fails || public.bendahara_check_try('a posted invoice goes back to draft', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'draft', inv));
  fails := fails || public.bendahara_check_try('the e-Invois status of a posted invoice is set', 'ok',
    format('update public.finance_invoices set einvoice_status = %L, einvoice_uuid = %L, updated_at = now() where id = %L', 'validated', 'LHDN-CHECK-1', inv));
  fails := fails || public.bendahara_check_try('the e-Invois status is set together with something else', 'FIN01',
    format('update public.finance_invoices set einvoice_status = %L, due_date = current_date + 90 where id = %L', 'rejected', inv));
  select einvoice_status || '/' || einvoice_uuid into t from public.finance_invoices where id = inv;
  if t is distinct from 'validated/LHDN-CHECK-1' then fails := fails || format('e-Invois reads %s', t); end if;

  -- ---- pay in part, then the rest -------------------------------------------
  rc1 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'txn_date', current_date, 'method', 'fpx', 'reference', 'CHK 1'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 100)));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (100.00, 32.50, 'sent') then
    fails := fails || format('after a part payment the invoice reads %s', row_to_json(r));
  end if;
  select * into r from public.finance_transactions where id = rc1;
  if (r.direction, r.status, r.number, r.amount, r.contact_id, r.created_by)
     is distinct from ('in', 'posted', 'RC-0001', 100.00, cust, owner_id) then
    fails := fails || format('a payment in is stored as %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('a payment in of a sen too much', 'FIN05',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.51))));
  rc2 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'cash'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount', 32.5)));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (132.50, 0.00, 'paid') then
    fails := fails || format('after the rest is paid the invoice reads %s', row_to_json(r));
  end if;
  select count(*) as row_count, sum(amount) as total, min(invoice_no) as invoice_no, min(customer_name) as customer_name,
         min(account_name) as account_name, count(distinct transaction_id) as payments, min(number) as first_number
    into r from public.finance_payments_in where invoice_id = inv;
  if (r.row_count, r.total, r.invoice_no, r.customer_name, r.account_name, r.payments, r.first_number)
     is distinct from (2::bigint, 132.50, 'INV-0001', 'Check Customer', 'Main Bank', 2::bigint, 'RC-0001') then
    fails := fails || format('finance_payments_in reads %s', row_to_json(r));
  end if;

  -- ---- a payment in is locked; an invoice with money on it cannot be voided --
  fails := fails || public.bendahara_check_try('a payment in is edited', 'FIN09',
    format('update public.finance_transactions set amount = 1 where id = %L', rc1));
  fails := fails || public.bendahara_check_try('a payment in is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', rc1));
  fails := fails || public.bendahara_check_try('the split of a payment in is changed', 'FIN09',
    format('update public.finance_allocations set amount = 1 where transaction_id = %L', rc1));
  fails := fails || public.bendahara_check_try('a paid invoice is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('a payment in is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rc2));
  select * into r from public.finance_invoice_totals where id = inv;
  if (r.paid, r.balance, r.display_status) is distinct from (100.00, 32.50, 'sent') then
    fails := fails || format('after voiding a payment the invoice reads %s', row_to_json(r));
  end if;
  fails := fails || public.bendahara_check_try('an invoice with one payment left is voided', 'FIN02',
    format('update public.finance_invoices set status = %L where id = %L', 'void', inv));
  fails := fails || public.bendahara_check_try('the other payment in is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rc1));
  fails := fails || public.bendahara_check_try('an invoice with no money on it is voided', 'ok',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', inv));
  select display_status into t from public.finance_invoice_totals where id = inv;
  if t is distinct from 'void' then fails := fails || format('a void invoice reads %s', t); end if;
  fails := fails || public.bendahara_check_try('a void invoice is changed', 'FIN01',
    format('update public.finance_invoices set status = %L where id = %L', 'posted', inv));

  -- ---- one payment, two invoices; one customer only -------------------------
  inv2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date - 40, 'due_date', current_date - 10), one_line);
  perform public.finance_post_invoice(org, inv2);
  inv3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, inv3);
  theirs := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_invoice(org, theirs);
  select display_status into t from public.finance_invoice_totals where id = inv2;
  if t is distinct from 'overdue' then fails := fails || format('an invoice past its due date reads %s', t); end if;

  fails := fails || public.bendahara_check_try('one payment for two customers', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', inv2, 'amount', 10), jsonb_build_object('invoice_id', theirs, 'amount', 10))));
  fails := fails || public.bendahara_check_try('a payment with no invoice', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', org, jsonb_build_object('account_id', bank, 'method', 'fpx'), '[]'::jsonb));
  rc3 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'bank_transfer'),
    jsonb_build_array(jsonb_build_object('invoice_id', inv3, 'amount', 32.5), jsonb_build_object('invoice_id', inv2, 'amount', 132.5)));
  select amount into r from public.finance_transactions where id = rc3;
  if r.amount is distinct from 165.00 then fails := fails || format('a split payment in totals %s', r.amount); end if;
  select string_agg(display_status || ' ' || balance, ', ' order by invoice_no) into t
    from public.finance_invoice_totals where id in (inv2, inv3);
  if t is distinct from 'paid 0.00, sent 100.00' then fails := fails || format('after a split payment: %s', t); end if;

  -- ---- a bill takes only money out, an invoice only money in ----------------
  bill := public.finance_save_bill(org,
    jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  perform public.finance_post_bill(org, bill);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money out is put against an invoice', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 10)', org, stray, theirs));
  fails := fails || public.bendahara_check_try('one allocation names a bill and an invoice', '23514',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, invoice_id, amount) values (%L, %L, %L, %L, 10)', org, stray, bill, theirs));
  fails := fails || public.bendahara_check_try('an allocation names no document', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, amount) values (%L, %L, 10)', org, stray));
  fails := fails || public.bendahara_check_try('the split is more than the payment', 'FIN03',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 20.01)', org, stray, bill));
  -- A draft payment out that is split across a bill cannot be changed
  -- underneath its split. Before it is split it may be changed freely.
  fails := fails || public.bendahara_check_try('an unsplit draft payment out is made smaller', 'ok',
    format('update public.finance_transactions set amount = 15, updated_at = now() where id = %L', stray));
  fails := fails || public.bendahara_check_try('an unsplit draft payment out is made larger again', 'ok',
    format('update public.finance_transactions set amount = 20, updated_at = now() where id = %L', stray));
  fails := fails || public.bendahara_check_try('a draft payment out is split across a bill', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('a split draft payment out is made smaller than its split', 'FIN03',
    format('update public.finance_transactions set amount = 9.99 where id = %L', stray));
  -- Naming `number` is refused before the guard is asked (42501); without it the guard still answers.
  fails := fails || public.bendahara_check_try('a split draft payment out is shrunk and posted at once, without a number', 'FIN03',
    format('update public.finance_transactions set amount = 1, status = %L where id = %L', 'posted', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is shrunk and posted at once', '42501',
    format('update public.finance_transactions set amount = 1, status = %L, number = %L where id = %L', 'posted', 'PV-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is turned into money in', 'FIN04',
    format('update public.finance_transactions set direction = %L where id = %L', 'in', stray));
  fails := fails || public.bendahara_check_try('a split draft payment out is brought down to its split', 'ok',
    format('update public.finance_transactions set amount = 10, updated_at = now() where id = %L', stray));
  select amount || ' ' || direction || ' ' || status into t from public.finance_transactions where id = stray;
  if t is distinct from '10.00 out draft' then fails := fails || format('a split draft payment out reads %s', t); end if;
  -- Deleting the draft takes its split with it, so the bill flow below starts clean.
  delete from public.finance_transactions where id = stray;
  select count(*) into n from public.finance_allocations where org_id = org and bill_id = bill;
  if n <> 0 then fails := fails || format('deleting a draft payment out left %s rows of its split', n); end if;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'in', bank, 20, 'cash') returning id into stray;
  fails := fails || public.bendahara_check_try('money in is put against a bill', 'FIN04',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 10)', org, stray, bill));
  fails := fails || public.bendahara_check_try('an unposted payment in is voided', 'FIN09',
    format('update public.finance_transactions set status = %L where id = %L', 'void', stray));
  -- The same for money in: split it across a posted invoice, then try to
  -- shrink it or turn it round before posting.
  fails := fails || public.bendahara_check_try('a draft payment in is split across an invoice', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 20)', org, stray, theirs));
  fails := fails || public.bendahara_check_try('a split draft payment in is made smaller than its split', 'FIN03',
    format('update public.finance_transactions set amount = 1 where id = %L', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is shrunk and posted at once, without a number', 'FIN03',
    format('update public.finance_transactions set amount = 1, status = %L where id = %L', 'posted', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is shrunk and posted at once', '42501',
    format('update public.finance_transactions set amount = 1, status = %L, number = %L where id = %L', 'posted', 'RC-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned into money out', 'FIN04',
    format('update public.finance_transactions set direction = %L where id = %L', 'out', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned round and posted at once, without a number', 'FIN04',
    format('update public.finance_transactions set direction = %L, status = %L where id = %L', 'out', 'posted', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is turned round and posted at once', '42501',
    format('update public.finance_transactions set direction = %L, status = %L, number = %L where id = %L', 'out', 'posted', 'RC-SNEAKY', stray));
  fails := fails || public.bendahara_check_try('a split draft payment in is made larger', 'ok',
    format('update public.finance_transactions set amount = 25, updated_at = now() where id = %L', stray));
  select amount || ' ' || direction || ' ' || status into t from public.finance_transactions where id = stray;
  if t is distinct from '25.00 in draft' then fails := fails || format('a split draft payment in reads %s', t); end if;
  -- A draft payment is not money received: the invoice owes what it owed.
  select display_status || ' ' || balance into t from public.finance_invoice_totals where id = theirs;
  if t is distinct from 'sent 132.50' then fails := fails || format('an invoice with only a draft payment on it reads %s', t); end if;
  delete from public.finance_transactions where id = stray;
  select count(*) into n from public.finance_allocations where org_id = org and invoice_id = theirs;
  if n <> 0 then fails := fails || format('deleting a draft payment in left %s rows of its split', n); end if;

  -- ---- the bill flow, through the rewritten allocation guard ----------------
  pv1 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 100)));
  fails := fails || public.bendahara_check_try('a bill is paid beyond what scheduled payments leave', 'FIN05',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 32.51))));
  pv2 := public.finance_record_payment_out(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', bill, 'amount', 32.5)));
  select * into r from public.supplier_bill_totals where id = bill;
  if (r.paid, r.balance, r.display_status) is distinct from (32.50, 100.00, 'pending') then
    fails := fails || format('a part-paid bill reads %s', row_to_json(r));
  end if;
  no := public.finance_mark_payment_paid(org, pv1, current_date);
  select * into r from public.supplier_bill_totals where id = bill;
  if (r.paid, r.balance, r.display_status) is distinct from (132.50, 0.00, 'paid') or no not like 'PV-%' then
    fails := fails || format('a paid bill reads %s (voucher %s)', row_to_json(r), no);
  end if;
  select count(*) into n from public.finance_payments_out where bill_id = bill;
  if n <> 2 then fails := fails || format('finance_payments_out has %s rows for the bill', n); end if;
  select count(*) into n from public.finance_payments_out where org_id = org;
  if n <> 2 then fails := fails || format('finance_payments_out shows %s rows; payments in must not appear there', n); end if;
  fails := fails || public.bendahara_check_try('a paid bill is voided', 'FIN02',
    format('update public.supplier_bills set status = %L where id = %L', 'void', bill));
  fails := fails || public.bendahara_check_try('a paid payment out is deleted', 'FIN09',
    format('delete from public.finance_transactions where id = %L', pv2));
  update public.finance_transactions set status = 'void', updated_at = now() where id in (pv1, pv2);
  fails := fails || public.bendahara_check_try('a bill with no money on it is voided', 'ok',
    format('update public.supplier_bills set status = %L, updated_at = now() where id = %L', 'void', bill));

  -- ---- contacts -------------------------------------------------------------
  fails := fails || public.bendahara_check_try('Customer is unticked on a contact with invoices', 'FIN08',
    format('update public.finance_contacts set is_customer = false, is_supplier = true where id = %L', cust));
  fails := fails || public.bendahara_check_try('Supplier is unticked on a contact with bills', 'FIN07',
    format('update public.finance_contacts set is_supplier = false, is_customer = true where id = %L', sup));
  fails := fails || public.bendahara_check_try('a customer with invoices is deleted', '23503',
    format('delete from public.finance_contacts where id = %L', cust));
  reset role;

  -- ==== as the editor: writes, and leaves their name on what they make =======
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  draft := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust2, 'invoice_date', current_date, 'due_date', current_date + 30), one_line);
  -- Posting and recording money received are sign-offs: an owner's or admin's (20261030123000).
  fails := fails || public.bendahara_check_try('an editor posts their own draft invoice', 'FIN14',
    format('select public.finance_post_invoice(%L, %L)', org, draft));
  fails := fails || public.bendahara_check_try('an editor records a payment in', 'FIN14',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'duitnow'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  -- A draft payment is still anyone's to write, and is recorded as theirs.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method)
  values (org, 'out', bank, 7, 'cash') returning id into rc1;
  reset role;
  select count(*) into n from public.finance_invoices where id = draft and created_by = editor_id and status = 'draft';
  if n <> 1 then fails := array_append(fails, 'an invoice does not record who made it, or a refused post left a mark'); end if;
  select count(*) into n from public.finance_transactions where id = rc1 and created_by = editor_id;
  if n <> 1 then fails := array_append(fails, 'a draft payment does not record who made it'); end if;
  -- The owner posts the editor's draft and records the money for it.
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  perform public.finance_post_invoice(org, draft);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'duitnow'),
    jsonb_build_array(jsonb_build_object('invoice_id', draft, 'amount', 50)));
  reset role;

  -- ==== as the viewer: reads everything, changes nothing =====================
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select count(*) into n from public.finance_invoice_totals where org_id = org;
  if n <> 5 then fails := fails || format('a viewer reads %s of 5 invoices', n); end if;
  select count(*) into n from public.finance_payments_in where org_id = org;
  if n <> 5 then fails := fails || format('a viewer reads %s of 5 payment-in rows', n); end if;
  fails := fails || public.bendahara_check_try('a viewer saves an invoice', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), one_line));
  fails := fails || public.bendahara_check_try('a viewer records a payment in', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  -- The function locks the invoice for update, which a viewer may not do, so to them it is not there.
  fails := fails || public.bendahara_check_try('a viewer posts an invoice', 'FIN11',
    format('select public.finance_post_invoice(%L, %L)', org, theirs));
  update public.finance_invoices set status = 'void' where id = theirs;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer voided an invoice'); end if;
  delete from public.finance_invoice_lines where invoice_id = theirs;
  get diagnostics n = row_count;
  if n <> 0 then fails := array_append(fails, 'a viewer deleted invoice lines'); end if;
  reset role;

  -- ==== as the owner of another workspace: sees and touches nothing ==========
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  foreach t in array array['finance_invoices','finance_invoice_lines','finance_invoice_totals','finance_payments_in'] loop
    execute format('select count(*) from public.%I where org_id = %L', t, org) into n;
    if n <> 0 then fails := fails || format('another workspace reads %s rows of %s', n, t); end if;
  end loop;
  fails := fails || public.bendahara_check_try('another workspace saves an invoice here', '42501',
    format('select public.finance_save_invoice(%L, %L, %L)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date), one_line));
  fails := fails || public.bendahara_check_try('another workspace posts an invoice here', 'FIN11',
    format('select public.finance_post_invoice(%L, %L)', org, theirs));
  fails := fails || public.bendahara_check_try('another workspace is paid for an invoice here', 'FIN06',
    format('select public.finance_record_payment_in(%L, %L, %L)', other_org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'), jsonb_build_array(jsonb_build_object('invoice_id', theirs, 'amount', 1))));
  reset role;

  -- ==== a user is deleted: created_by is cleared on posted and void rows =====
  -- If the delete is stopped by something outside finance, the clearing its
  -- foreign keys would have done is done by hand, and the message says so.
  begin
    delete from auth.users where id = editor_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    notes := array_append(notes, format('deleting a user was stopped outside finance (%s: %s), so created_by was cleared by hand', sqlstate, sqlerrm));
    update public.finance_invoices set created_by = null where created_by = editor_id;
    update public.finance_transactions set created_by = null where created_by = editor_id;
  end;
  select count(*) into n from public.finance_invoices where id = draft and status = 'posted' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their posted invoice'); end if;
  select count(*) into n from public.finance_transactions where id = rc1 and status = 'draft' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their draft payment'); end if;
  begin
    delete from auth.users where id = owner_id;
  exception when others then
    if sqlstate like 'FIN%' then raise; end if;
    update public.finance_invoices set created_by = null where created_by = owner_id;
    update public.finance_transactions set created_by = null where created_by = owner_id;
  end;
  select count(*) into n from public.finance_invoices where id = inv and status = 'void' and created_by is null;
  if n <> 1 then fails := array_append(fails, 'deleting a user did not clear created_by on their void invoice'); end if;

  -- ==== the workspace is deleted, posted invoices, payments and all ==========
  delete from public.orgs where id = org;
  select (select count(*) from public.finance_invoices where org_id = org)
       + (select count(*) from public.finance_invoice_lines where org_id = org)
       + (select count(*) from public.finance_allocations where org_id = org)
       + (select count(*) from public.finance_transactions where org_id = org)
       + (select count(*) from public.supplier_bills where org_id = org) into n;
  if n <> 0 then fails := fails || format('deleting the workspace left %s finance rows', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_INVOICES_CHECK PASSED (everything rolled back)%',
      case when array_length(notes, 1) is null then '' else ' NOTE: ' || array_to_string(notes, ' | ') end;
  end if;
  raise exception 'BENDAHARA_INVOICES_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
