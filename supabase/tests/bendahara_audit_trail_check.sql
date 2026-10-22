-- Bendahara audit trail check. Run it after 20261125120000_bendahara_audit_trail.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way: the block always ends with RAISE, so
-- every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_AUDIT_TRAIL_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
--   begin;
--   \i supabase/migrations/20261125120000_bendahara_audit_trail.sql
--   \i supabase/tests/bendahara_audit_trail_check.sql
--   rollback;
--
-- It acts as a workspace's owner the way the app does (the authenticated role with that person's id in
-- request.jwt.claims, at aal2), goes through every event of the audit trail once, and then compares what the
-- activity log holds for the workspace with what it expects, both ways: every event once, nothing else. It then
-- checks what must log nothing (a refused change, a change row-level security filters out, nobody signed in, an
-- update that changes nothing), that a member still reads the older rows, and that a workspace holding drafts is
-- deleted cleanly with a person signed in (the table owner, with the owner's id in the claims) and through
-- delete_test_org.
--
-- Every invoice, bill and payment is in ringgit and dated today, except the one USD invoice the FX revaluation
-- needs (1999, a typed rate).
do $$
declare
  org uuid := gen_random_uuid();
  del_a uuid := gen_random_uuid();
  del_b uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  viewer_claims text;
  cust uuid; sup uuid; both_c uuid; usd_c uuid;
  bank uuid; till uuid; rent uuid; equity uuid; utilities uuid;
  i1 uuid; i2 uuid; i3 uuid; ic uuid; iusd uuid;
  q1 uuid; q2 uuid;
  cn1 uuid; cn2 uuid;
  b1 uuid; b2 uuid; b3 uuid; bc uuid;
  sc1 uuid; sc2 uuid;
  p_in uuid; p_out uuid; v1 uuid; v2 uuid; v3 uuid; tr uuid; tr_out uuid;
  e1 uuid; e2 uuid; e3 uuid;
  k1 uuid; k2 uuid;
  j1 uuid; j2 uuid; j3 uuid;
  po1 uuid; po2 uuid;
  fx uuid;
  no text; no2 text; po1_no text; po2_no text; fx_no text;
  x jsonb;
  expected jsonb := '[]';
  n integer;
  n0 integer;
  t text;
  r record;
  fails text[] := '{}';
  one_line jsonb := '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0}]';
  sep_oct text := 'Service tax, Sep' || chr(8211) || 'Oct 2026';
begin
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated, service_role';

  -- ==== the shape: three columns, two checks, an index and the helper ===========================================
  select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) into t
    from information_schema.columns
   where table_schema = 'public' and table_name = 'activity_log' and column_name in ('entity_type', 'entity_id', 'details');
  if t is distinct from 'details:jsonb:YES,entity_id:uuid:YES,entity_type:text:YES' then
    raise exception 'BENDAHARA_AUDIT_TRAIL_CHECK FAILED: activity_log''s new columns are: %', coalesce(t, 'missing');
  end if;
  select count(*) into n from pg_constraint
   where conrelid = 'public.activity_log'::regclass and contype = 'c'
     and (pg_get_constraintdef(oid) like '%entity_type ~ %^[a-z_]+$%'
          or (pg_get_constraintdef(oid) like '%details IS NOT NULL%' and pg_get_constraintdef(oid) like '%details ? ''event''%'));
  if n <> 2 then fails := fails || format('activity_log has %s of the two new checks', n); end if;
  select count(*) into n from pg_indexes
   where schemaname = 'public' and tablename = 'activity_log' and indexname = 'activity_log_org_entity_created_idx'
     and indexdef like '%(org_id, entity_type, created_at DESC) WHERE (entity_type IS NOT NULL)%';
  if n <> 1 then fails := fails || 'the index activity_log_org_entity_created_idx is missing or different'::text; end if;
  if to_regprocedure('private.finance_log(uuid, text, uuid, text, text, jsonb)') is null then
    fails := fails || 'private.finance_log is missing'::text;
  else
    select count(*) into n from pg_proc p
     where p.oid = 'private.finance_log(uuid, text, uuid, text, text, jsonb)'::regprocedure
       and p.prosecdef and p.proconfig @> array['search_path=""'];
    if n <> 1 then fails := fails || 'private.finance_log is not security definer with an empty search_path'::text; end if;
    if has_function_privilege('anon', 'private.finance_log(uuid, text, uuid, text, text, jsonb)', 'execute')
       or has_function_privilege('authenticated', 'private.finance_log(uuid, text, uuid, text, text, jsonb)', 'execute')
       or has_function_privilege('service_role', 'private.finance_log(uuid, text, uuid, text, text, jsonb)', 'execute') then
      fails := fails || 'anon, authenticated or service_role may call private.finance_log'::text;
    end if;
  end if;
  -- Clients still only read the log.
  if has_table_privilege('authenticated', 'public.activity_log', 'insert')
     or has_table_privilege('authenticated', 'public.activity_log', 'update')
     or has_table_privilege('authenticated', 'public.activity_log', 'delete') then
    fails := fails || 'the authenticated role may write the activity log'::text;
  end if;
  select string_agg(polname || ':' || polcmd::text, ',' order by polname) into t from pg_policy where polrelid = 'public.activity_log'::regclass;
  if t is distinct from 'activity_log_select:r,mfa_required:*' then
    fails := fails || format('the activity log''s policies are: %s', t);
  end if;

  -- ---- people and workspaces: a test address, so delete_test_org may delete them -------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'qa-' || substr(md5(u.id::text), 1, 12) || '-1@example.com', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id]) as u(id);
  insert into public.orgs (id, name) values
    (org, 'Audit Trail Check Sdn Bhd'), (del_a, 'Audit Trail Delete A'), (del_b, 'Audit Trail Delete B');
  insert into public.org_members (org_id, user_id, role) values
    (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'),
    (del_a, owner_id, 'owner'), (del_b, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  -- A row from before the migration: no entity, no details.
  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (org, owner_id, 'Owner', 'Updated company details', 'Audit Trail Check Sdn Bhd', 'data', 'members');

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Pelanggan Sdn Bhd', true) returning id into cust;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Pembekal Sdn Bhd', true) returning id into sup;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Dua Hala Sdn Bhd', true, true) returning id into both_c;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Abroad Inc', true) returning id into usd_c;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into till from public.finance_accounts where org_id = org and kind = 'cash' order by created_at limit 1;
  select id into rent from public.finance_ledger_accounts where org_id = org and code = '6000';
  select id into equity from public.finance_ledger_accounts where org_id = org and code = '3000';
  select id into utilities from public.finance_categories where org_id = org and kind = 'expense' and name = 'Utilities';

  -- ==== invoices: posted, voided, a draft deleted ===============================================================
  i1 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30), one_line);
  no := public.finance_post_invoice(org, i1);
  expected := expected || jsonb_build_object('t', 'finance_invoice', 'id', i1, 'e', 'posted', 'a', 'Posted an invoice', 'g', no);
  update public.finance_invoices set status = 'void', updated_at = now() where id = i1;
  expected := expected || jsonb_build_object('t', 'finance_invoice', 'id', i1, 'e', 'voided', 'a', 'Voided an invoice', 'g', no);
  i2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30), one_line);
  delete from public.finance_invoices where id = i2;
  expected := expected || jsonb_build_object('t', 'finance_invoice', 'id', i2, 'e', 'deleted', 'a', 'Deleted a draft invoice', 'g', 'Pelanggan Sdn Bhd');
  i3 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30), one_line);
  no := public.finance_post_invoice(org, i3);
  expected := expected || jsonb_build_object('t', 'finance_invoice', 'id', i3, 'e', 'posted', 'a', 'Posted an invoice', 'g', no);

  -- ==== quotations: sent, accepted, declined, a draft deleted ===================================================
  q1 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30), one_line);
  no := public.finance_send_quotation(org, q1);
  expected := expected || jsonb_build_object('t', 'finance_quotation', 'id', q1, 'e', 'sent', 'a', 'Sent a quotation', 'g', no);
  update public.finance_quotations set status = 'accepted', accepted_at = now(), updated_at = now() where id = q1;
  expected := expected || jsonb_build_object('t', 'finance_quotation', 'id', q1, 'e', 'accepted', 'a', 'Accepted a quotation', 'g', no);
  update public.finance_quotations set status = 'declined', accepted_at = null, updated_at = now() where id = q1;
  expected := expected || jsonb_build_object('t', 'finance_quotation', 'id', q1, 'e', 'declined', 'a', 'Marked a quotation declined', 'g', no);
  q2 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30), one_line);
  delete from public.finance_quotations where id = q2;
  expected := expected || jsonb_build_object('t', 'finance_quotation', 'id', q2, 'e', 'deleted', 'a', 'Deleted a draft quotation', 'g', 'Pelanggan Sdn Bhd');

  -- ==== credit notes: issued, voided, a draft deleted ===========================================================
  cn1 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i3, 'reason', 'returns', 'amount', 10));
  no := public.finance_issue_credit_note(org, cn1);
  expected := expected || jsonb_build_object('t', 'finance_credit_note', 'id', cn1, 'e', 'issued', 'a', 'Issued a credit note', 'g', no);
  update public.finance_credit_notes set status = 'void', updated_at = now() where id = cn1;
  expected := expected || jsonb_build_object('t', 'finance_credit_note', 'id', cn1, 'e', 'voided', 'a', 'Voided a credit note', 'g', no);
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i3, 'reason', 'returns', 'amount', 5));
  delete from public.finance_credit_notes where id = cn2;
  expected := expected || jsonb_build_object('t', 'finance_credit_note', 'id', cn2, 'e', 'deleted', 'a', 'Deleted a draft credit note', 'g', 'a draft');

  -- ==== supplier bills: posted, voided, a draft deleted =========================================================
  b1 := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  no := public.finance_post_bill(org, b1);
  expected := expected || jsonb_build_object('t', 'finance_supplier_bill', 'id', b1, 'e', 'posted', 'a', 'Posted a supplier bill', 'g', no);
  update public.supplier_bills set status = 'void', updated_at = now() where id = b1;
  expected := expected || jsonb_build_object('t', 'finance_supplier_bill', 'id', b1, 'e', 'voided', 'a', 'Voided a supplier bill', 'g', no);
  b2 := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  delete from public.supplier_bills where id = b2;
  expected := expected || jsonb_build_object('t', 'finance_supplier_bill', 'id', b2, 'e', 'deleted', 'a', 'Deleted a draft supplier bill', 'g', 'Pembekal Sdn Bhd');
  b3 := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  no := public.finance_post_bill(org, b3);
  expected := expected || jsonb_build_object('t', 'finance_supplier_bill', 'id', b3, 'e', 'posted', 'a', 'Posted a supplier bill', 'g', no);

  -- ==== supplier credit notes: issued, voided, a draft deleted ==================================================
  sc1 := public.finance_save_supplier_credit_note(org, jsonb_build_object('bill_id', b3, 'amount', 10));
  no := public.finance_issue_supplier_credit_note(org, sc1);
  expected := expected || jsonb_build_object('t', 'finance_supplier_credit_note', 'id', sc1, 'e', 'issued', 'a', 'Issued a supplier credit note', 'g', no);
  update public.finance_supplier_credit_notes set status = 'void', updated_at = now() where id = sc1;
  expected := expected || jsonb_build_object('t', 'finance_supplier_credit_note', 'id', sc1, 'e', 'voided', 'a', 'Voided a supplier credit note', 'g', no);
  sc2 := public.finance_save_supplier_credit_note(org, jsonb_build_object('bill_id', b3, 'amount', 5));
  delete from public.finance_supplier_credit_notes where id = sc2;
  expected := expected || jsonb_build_object('t', 'finance_supplier_credit_note', 'id', sc2, 'e', 'deleted', 'a', 'Deleted a draft supplier credit note', 'g', 'a draft');

  -- ==== payments ================================================================================================
  -- posted insert: Payments In (a draft made posted inside the RPC) logs one "Recorded money in".
  p_in := public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', i3, 'amount', 10)));
  select number into no from public.finance_transactions where id = p_in;
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', p_in, 'e', 'recorded', 'a', 'Recorded money in', 'g', no);
  update public.finance_transactions set status = 'void', updated_at = now() where id = p_in;
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', p_in, 'e', 'voided', 'a', 'Voided money in', 'g', no);
  -- Payments Out: one "Recorded money out".
  p_out := public.finance_record_payment_out(org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('bill_id', b3, 'amount', 20)));
  select number, status into r from public.finance_transactions where id = p_out;
  if r.status = 'posted' then
    expected := expected || jsonb_build_object('t', 'finance_payment', 'id', p_out, 'e', 'recorded', 'a', 'Recorded money out', 'g', r.number);
  else
    fails := fails || format('setup: a payment out is %s, not posted', r.status);
  end if;
  -- A voucher: sent for approval as it is made, approved, marked paid.
  v1 := public.finance_save_voucher(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7,
    'party_name', 'Kedai Runcit', 'category_id', utilities, 'status', 'pending_approval'), '[]');
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v1, 'e', 'submitted', 'a', 'Submitted a payment for approval', 'g', 'Kedai Runcit');
  update public.finance_transactions set status = 'scheduled', updated_at = now() where id = v1;
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v1, 'e', 'approved', 'a', 'Approved a payment', 'g', 'Kedai Runcit');
  no := public.finance_mark_payment_paid(org, v1, current_date);
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v1, 'e', 'paid', 'a', 'Marked a payment paid', 'g', no);
  -- A draft sent for approval later, rejected, then deleted.
  v2 := public.finance_save_voucher(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 8,
    'party_name', 'Kedai Dua', 'category_id', utilities), '[]');
  perform public.finance_save_voucher(org, jsonb_build_object('id', v2, 'account_id', bank, 'method', 'cash', 'amount', 8,
    'party_name', 'Kedai Dua', 'category_id', utilities, 'status', 'pending_approval'), '[]');
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v2, 'e', 'submitted', 'a', 'Submitted a payment for approval', 'g', 'Kedai Dua');
  update public.finance_transactions set status = 'rejected', updated_at = now() where id = v2;
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v2, 'e', 'rejected', 'a', 'Rejected a payment', 'g', 'Kedai Dua');
  delete from public.finance_transactions where id = v2;
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v2, 'e', 'deleted', 'a', 'Deleted a payment that was not posted', 'g', 'Kedai Dua');
  -- A draft deleted.
  v3 := public.finance_save_voucher(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 9,
    'contact_id', sup, 'category_id', utilities), '[]');
  delete from public.finance_transactions where id = v3;
  expected := expected || jsonb_build_object('t', 'finance_payment', 'id', v3, 'e', 'deleted', 'a', 'Deleted a payment that was not posted', 'g', 'Pembekal Sdn Bhd');
  -- Every payment is written as a draft (finance_transaction_insert_guard, FIN09, whoever writes it): the RPCs
  -- above write it and post it in the same call, which is the "posted insert" case. The guard still refuses one
  -- written posted, and nothing is logged for it.
  reset role;
  fails := fails || public.bendahara_check_try('posted insert: a payment written posted', 'FIN09',
    format('insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, party_name, status, number) values (%L, %L, %L, current_date, 3, %L, %L, %L, %L)',
      org, 'in', bank, 'cash', 'Walk-in', 'posted', 'RAW-1'));
  set local role authenticated;

  -- ==== transfer once: recorded and voided, one row each ========================================================
  tr := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 50));
  select id, number into tr_out, no from public.finance_transactions where transfer_id = tr and direction = 'out';
  expected := expected || jsonb_build_object('t', 'finance_transfer', 'id', tr_out, 'e', 'recorded', 'a', 'Recorded a transfer', 'g', no);
  perform public.finance_void_transfer(org, tr);
  expected := expected || jsonb_build_object('t', 'finance_transfer', 'id', tr_out, 'e', 'voided', 'a', 'Voided a transfer', 'g', no);

  -- ==== expenses: approved, rejected, a claim deleted ===========================================================
  -- A member's claims wait for approval (saving one logs nothing); the owner decides them.
  perform set_config('request.jwt.claims', member_claims, true);
  e1 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'TNB', 'amount', 30));
  e2 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Syabas', 'amount', 20));
  e3 := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Indah Water', 'amount', 10));
  perform set_config('request.jwt.claims', owner_claims, true);
  update public.finance_expenses set status = 'approved', updated_at = now() where id = e1;
  expected := expected || jsonb_build_object('t', 'finance_expense', 'id', e1, 'e', 'approved', 'a', 'Approved an expense', 'g', 'TNB');
  update public.finance_expenses set status = 'rejected', updated_at = now() where id = e2;
  expected := expected || jsonb_build_object('t', 'finance_expense', 'id', e2, 'e', 'rejected', 'a', 'Rejected an expense', 'g', 'Syabas');
  delete from public.finance_expenses where id = e3;
  expected := expected || jsonb_build_object('t', 'finance_expense', 'id', e3, 'e', 'deleted', 'a', 'Deleted an expense claim', 'g', 'Indah Water');

  -- ==== contra entries: posted, voided, a draft deleted =========================================================
  ic := public.finance_save_invoice(org, jsonb_build_object('customer_id', both_c, 'invoice_date', current_date,
    'due_date', current_date + 30), one_line);
  no := public.finance_post_invoice(org, ic);
  expected := expected || jsonb_build_object('t', 'finance_invoice', 'id', ic, 'e', 'posted', 'a', 'Posted an invoice', 'g', no);
  bc := public.finance_save_bill(org, jsonb_build_object('supplier_id', both_c, 'bill_date', current_date, 'due_date', current_date + 30), one_line);
  no := public.finance_post_bill(org, bc);
  expected := expected || jsonb_build_object('t', 'finance_supplier_bill', 'id', bc, 'e', 'posted', 'a', 'Posted a supplier bill', 'g', no);
  k1 := public.finance_save_contra(org, jsonb_build_object('contact_id', both_c, 'amount', 25),
    jsonb_build_array(jsonb_build_object('invoice_id', ic, 'amount', 25), jsonb_build_object('bill_id', bc, 'amount', 25)));
  no := public.finance_post_contra(org, k1);
  expected := expected || jsonb_build_object('t', 'finance_contra', 'id', k1, 'e', 'posted', 'a', 'Posted a contra entry', 'g', no);
  perform public.finance_void_contra(org, k1);
  expected := expected || jsonb_build_object('t', 'finance_contra', 'id', k1, 'e', 'voided', 'a', 'Voided a contra entry', 'g', no);
  k2 := public.finance_save_contra(org, jsonb_build_object('contact_id', both_c, 'amount', 5),
    jsonb_build_array(jsonb_build_object('invoice_id', ic, 'amount', 5), jsonb_build_object('bill_id', bc, 'amount', 5)));
  delete from public.finance_contras where id = k2;
  expected := expected || jsonb_build_object('t', 'finance_contra', 'id', k2, 'e', 'deleted', 'a', 'Deleted a draft contra entry', 'g', 'a draft');

  -- ==== journals: posted, reversed, a draft deleted =============================================================
  j1 := public.finance_save_journal(org, jsonb_build_object('journal_date', current_date, 'description', 'Rent paid by the owner'),
    jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 40), jsonb_build_object('account_id', equity, 'credit', 40)));
  no := public.finance_post_journal(org, j1);
  expected := expected || jsonb_build_object('t', 'finance_journal', 'id', j1, 'e', 'posted', 'a', 'Posted a journal', 'g', no);
  j2 := public.finance_reverse_journal(org, j1, current_date);
  select journal_no, status into r from public.finance_journals where id = j2;
  if r.status <> 'posted' then
    no2 := public.finance_post_journal(org, j2);
  else
    no2 := r.journal_no;
  end if;
  expected := expected || jsonb_build_object('t', 'finance_journal', 'id', j2, 'e', 'reversed', 'a', 'Reversed a journal', 'g', no || ', with ' || no2);
  j3 := public.finance_save_journal(org, jsonb_build_object('journal_date', current_date, 'description', 'A draft'),
    jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 1), jsonb_build_object('account_id', equity, 'credit', 1)));
  delete from public.finance_journals where id = j3;
  expected := expected || jsonb_build_object('t', 'finance_journal', 'id', j3, 'e', 'deleted', 'a', 'Deleted a draft journal', 'g', 'a draft');

  -- ==== purchase orders: the six sentences ======================================================================
  po1 := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'expected_date', current_date + 7), one_line);
  po1_no := public.finance_submit_purchase_order(org, po1);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po1, 'e', 'submitted', 'a', 'Submitted a purchase order for approval', 'g', po1_no);
  perform public.finance_decide_purchase_order(org, po1, true, null);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po1, 'e', 'approved', 'a', 'Approved a purchase order', 'g', po1_no);
  perform public.finance_close_purchase_order(org, po1);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po1, 'e', 'closed', 'a', 'Closed a purchase order', 'g', po1_no);
  po2 := public.finance_save_purchase_order(org, jsonb_build_object('supplier_id', sup, 'po_date', current_date,
    'expected_date', current_date + 7), one_line);
  po2_no := public.finance_submit_purchase_order(org, po2);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po2, 'e', 'submitted', 'a', 'Submitted a purchase order for approval', 'g', po2_no);
  perform public.finance_decide_purchase_order(org, po2, false, 'Too dear');
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po2, 'e', 'rejected', 'a', 'Rejected a purchase order', 'g', po2_no || ': Too dear');
  perform public.finance_submit_purchase_order(org, po2);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po2, 'e', 'submitted', 'a', 'Submitted a purchase order for approval', 'g', po2_no);
  perform public.finance_withdraw_purchase_order(org, po2);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po2, 'e', 'withdrew', 'a', 'Withdrew a purchase order from approval', 'g', po2_no);
  perform public.finance_cancel_purchase_order(org, po2);
  expected := expected || jsonb_build_object('t', 'finance_purchase_order', 'id', po2, 'e', 'cancelled', 'a', 'Cancelled a purchase order', 'g', po2_no);

  -- ==== an FX revaluation =======================================================================================
  iusd := public.finance_save_invoice(org, jsonb_build_object('customer_id', usd_c, 'invoice_date', '1999-01-05',
    'due_date', '1999-02-05', 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'),
    '[{"description":"A","quantity":1,"unit_price":1000,"sst_rate":0}]');
  no := public.finance_post_invoice(org, iusd);
  expected := expected || jsonb_build_object('t', 'finance_invoice', 'id', iusd, 'e', 'posted', 'a', 'Posted an invoice', 'g', no);
  select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
    from public.finance_fx_revaluation_preview(org, date '1999-01-31', '{"USD":{"rate":"4.48","source":"manual"}}') p;
  select f.id, f.revaluation_no into fx, fx_no from public.finance_post_fx_revaluation(org, jsonb_build_object('period_end', '1999-01-31',
    'rates', '{"USD":{"rate":"4.48","source":"manual"}}'::jsonb, 'expected', x)) f;
  expected := expected || jsonb_build_object('t', 'finance_fx_revaluation', 'id', fx, 'e', 'posted', 'a', 'Posted an FX revaluation', 'g', fx_no || ' for 1999-01-31');

  -- ==== SST: figures saved (a no-op update logs nothing), a return marked filed and unmarked ====================
  insert into public.finance_sst_return_figures (org_id, tax_type, period_start, cards_11e, deduction_13c, bad_debt_13d)
  values (org, 'service', '2026-09-01', 3, 12.50, 4.25);
  expected := expected || jsonb_build_object('t', 'finance_sst_return', 'id', null, 'e', 'saved', 'a', 'Saved SST return figures', 'g', sep_oct);
  update public.finance_sst_return_figures set cards_11e = 3, updated_at = now() where org_id = org;
  update public.finance_sst_return_figures set cards_11e = 5 where org_id = org;
  expected := expected || jsonb_build_object('t', 'finance_sst_return', 'id', null, 'e', 'saved', 'a', 'Saved SST return figures', 'g', sep_oct);
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-10-20');
  expected := expected || jsonb_build_object('t', 'finance_sst_return', 'id', null, 'e', 'filed', 'a', 'Marked an SST return filed', 'g', sep_oct);
  delete from public.finance_sst_returns where org_id = org;
  expected := expected || jsonb_build_object('t', 'finance_sst_return', 'id', null, 'e', 'unfiled', 'a', 'Unmarked an SST return', 'g', sep_oct);

  -- ==== SST settings: changed twice; a no-op update logs nothing ================================================
  insert into public.finance_sst_settings (org_id, period_start_month, service_tax_no) values (org, 1, 'W10-1808-32000001');
  expected := expected || jsonb_build_object('t', 'finance_settings', 'id', null, 'e', 'changed', 'a', 'Changed the SST settings', 'g', 'SST settings');
  update public.finance_sst_settings set period_start_month = 1, service_tax_no = 'W10-1808-32000001' where org_id = org;
  update public.finance_sst_settings set service_tax_basis = 'invoice' where org_id = org;
  expected := expected || jsonb_build_object('t', 'finance_settings', 'id', null, 'e', 'changed', 'a', 'Changed the SST settings', 'g', 'SST settings');

  -- ==== every event once, and nothing else ======================================================================
  reset role;
  for r in
    select 'expected, not logged' as side, w as row_text from (
      select format('%s|%s|%s|%s|%s', e->>'t', coalesce(e->>'id', '-'), e->>'e', e->>'a', e->>'g') as w
        from jsonb_array_elements(expected) e
      except all
      select format('%s|%s|%s|%s|%s', a.entity_type, coalesce(a.entity_id::text, '-'), a.details->>'event', a.action, a.target)
        from public.activity_log a where a.org_id = org and a.entity_type is not null) d
    union all
    select 'logged, not expected', w from (
      select format('%s|%s|%s|%s|%s', a.entity_type, coalesce(a.entity_id::text, '-'), a.details->>'event', a.action, a.target) as w
        from public.activity_log a where a.org_id = org and a.entity_type is not null
      except all
      select format('%s|%s|%s|%s|%s', e->>'t', coalesce(e->>'id', '-'), e->>'e', e->>'a', e->>'g')
        from jsonb_array_elements(expected) e) d
  loop
    fails := fails || format('%s: %s', r.side, r.row_text);
  end loop;
  -- Who, how and for whom, on every new row.
  select count(*) into n from public.activity_log a
   where a.org_id = org and a.entity_type is not null
     and (a.actor_id is distinct from owner_id or a.actor_name is null or a.category <> 'data' or a.audience <> 'members'
          or a.entity_type !~ '^finance_[a-z_]+$' or not (a.details ? 'event'));
  if n <> 0 then fails := fails || format('%s new rows have the wrong actor, category, audience or details', n); end if;
  -- The details: an invoice's amounts, a payment's party and direction, a transfer's figures, a deleted draft's.
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = i3 and a.details->>'event' = 'posted';
  if x->>'number' is null or x->>'party' is distinct from 'Pelanggan Sdn Bhd' or x->>'date' is distinct from current_date::text
     or (x->>'amount')::numeric is distinct from 100 or x->>'currency' is distinct from 'MYR' or (x->>'amount_myr')::numeric is distinct from 100 then
    fails := fails || format('a posted invoice''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = i2;
  if x->>'party' is distinct from 'Pelanggan Sdn Bhd' or x ? 'amount_myr' then
    fails := fails || format('a deleted draft invoice''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = iusd;
  if x->>'currency' is distinct from 'USD' or (x->>'amount')::numeric is distinct from 1000 or (x->>'amount_myr')::numeric is distinct from 4200 then
    fails := fails || format('a posted USD invoice''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = p_in and a.details->>'event' = 'recorded';
  if x->>'party' is distinct from 'Pelanggan Sdn Bhd' or x->>'direction' is distinct from 'in' or (x->>'amount')::numeric is distinct from 10
     or x->>'currency' is distinct from 'MYR' or (x->>'amount_myr')::numeric is distinct from 10 or x->>'date' is null then
    fails := fails || format('a payment in''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = tr_out and a.details->>'event' = 'recorded';
  if (x->>'amount')::numeric is distinct from 50 or x->>'currency' is distinct from 'MYR' or x->>'number' is null then
    fails := fails || format('a transfer''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = cn1 and a.details->>'event' = 'issued';
  if (x->>'amount')::numeric is distinct from 10 or (x->>'amount_myr')::numeric is distinct from 10 or x->>'date' is null then
    fails := fails || format('an issued credit note''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = e1;
  if x->>'party' is distinct from 'TNB' or (x->>'amount')::numeric is distinct from 30 then
    fails := fails || format('an approved expense''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = po1 and a.details->>'event' = 'approved';
  if x->>'number' is distinct from po1_no or x->>'party' is distinct from 'Pembekal Sdn Bhd' then
    fails := fails || format('an approved purchase order''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a where a.org_id = org and a.entity_id = fx;
  if x->>'number' is distinct from fx_no or x->>'date' is distinct from '1999-01-31' then
    fails := fails || format('an FX revaluation''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a
   where a.org_id = org and a.entity_type = 'finance_sst_return' and a.details->>'event' = 'filed';
  if x->>'tax_type' is distinct from 'service' or x->>'period' is distinct from '2026-09-01' or x->>'filed_on' is distinct from '2026-10-20' then
    fails := fails || format('a filed return''s details are %s', x);
  end if;
  select a.details into x from public.activity_log a
   where a.org_id = org and a.entity_type = 'finance_settings' and a.details->'changed' ? 'period_start_month';
  if x->'changed' is distinct from '{"period_start_month":{"from":null,"to":1},"service_tax_no":{"from":null,"to":"W10-1808-32000001"},"service_tax_basis":{"from":null,"to":"payment"}}'::jsonb then
    fails := fails || format('the first settings change reads %s', x);
  end if;
  select count(*) into n from public.activity_log a
   where a.org_id = org and a.entity_type = 'finance_settings'
     and a.details->'changed' = '{"service_tax_basis":{"from":"payment","to":"invoice"}}'::jsonb;
  if n <> 1 then fails := fails || format('the basis change is logged %s times with only what changed', n); end if;

  -- ==== refused change: a guard refuses, a filter leaves nothing, nobody is signed in ===========================
  select count(*) into n0 from public.activity_log where org_id = org;
  set local role authenticated;
  fails := fails || public.bendahara_check_try('refused change: a posted invoice edited', 'FIN01',
    format('update public.finance_invoices set notes = %L where id = %L', 'changed', i3));
  fails := fails || public.bendahara_check_try('refused change: a posted invoice deleted', 'FIN01',
    format('delete from public.finance_invoices where id = %L', i3));
  fails := fails || public.bendahara_check_try('refused change: a posted journal deleted', 'FIN01',
    format('delete from public.finance_journals where id = %L', j1));
  -- A viewer may not write: row-level security matches no row, nothing is raised, nothing is logged.
  perform set_config('request.jwt.claims', viewer_claims, true);
  update public.finance_invoices set status = 'void', updated_at = now() where id = i3;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || format('a viewer voided %s invoices', n); end if;
  delete from public.finance_quotations where id = q1;
  -- Nobody signed in (a seed, the agent worker): the table owner deletes a draft and voids an invoice.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  i2 := null;
  insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, status, currency, fx_rate)
  values (org, cust, current_date, current_date + 30, 'draft', 'MYR', 1) returning id into i2;
  delete from public.finance_invoices where id = i2;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'sales', '2026-09-01', '2026-10-20');
  delete from public.finance_sst_returns where org_id = org;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
  insert into public.finance_sst_settings (org_id, period_start_month) values (org, 2)
    on conflict (org_id) do update set period_start_month = 2;
  select count(*) into n from public.activity_log where org_id = org;
  if n <> n0 then fails := fails || format('refused, filtered or unsigned changes logged %s rows', n - n0); end if;

  -- ==== a member still reads the older rows and the new ones ====================================================
  perform set_config('request.jwt.claims', member_claims, true);
  set local role authenticated;
  select count(*) into n from public.activity_log where org_id = org and entity_type is null and action = 'Updated company details';
  if n <> 1 then fails := fails || format('a member reads %s older rows, not 1', n); end if;
  select count(*) into n from public.activity_log where org_id = org and entity_type is not null;
  if n <> jsonb_array_length(expected) then fails := fails || format('a member reads %s new rows, not %s', n, jsonb_array_length(expected)); end if;
  fails := fails || public.bendahara_check_try('a member writes the activity log', '42501',
    format('insert into public.activity_log (org_id, actor_name, action, category, entity_type, details) values (%L, %L, %L, %L, %L, %L)',
      org, 'x', 'x', 'data', 'finance_invoice', '{"event":"posted"}'));
  reset role;
  -- The checks: an entity_type is lower case; a typed row carries an event.
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_check_try('an entity_type with capitals', '23514',
    format('insert into public.activity_log (org_id, actor_name, action, category, entity_type, details) values (%L, %L, %L, %L, %L, %L)',
      org, 'x', 'x', 'data', 'Finance', '{"event":"posted"}'));
  fails := fails || public.bendahara_check_try('a typed row with no event', '23514',
    format('insert into public.activity_log (org_id, actor_name, action, category, entity_type, details) values (%L, %L, %L, %L, %L, %L)',
      org, 'x', 'x', 'data', 'finance_invoice', '{"number":"INV-1"}'));
  fails := fails || public.bendahara_check_try('a typed row with no details', '23514',
    format('insert into public.activity_log (org_id, actor_name, action, category, entity_type) values (%L, %L, %L, %L, %L)',
      org, 'x', 'x', 'data', 'finance_invoice'));

  -- ==== org delete: a workspace holding drafts goes, with its owner signed in ===================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  for r in select unnest(array[del_a, del_b]) as o loop
    insert into public.finance_contacts (org_id, name, is_customer) values (r.o, 'Draft Customer', true) returning id into cust;
    perform public.finance_save_invoice(r.o, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
      'due_date', current_date + 30), one_line);
    perform public.finance_save_quotation(r.o, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
      'valid_until', current_date + 30), one_line);
    select id into bank from public.finance_accounts where org_id = r.o and kind = 'bank' order by created_at limit 1;
    select id into utilities from public.finance_categories where org_id = r.o and kind = 'expense' and name = 'Utilities';
    perform public.finance_save_voucher(r.o, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7,
      'party_name', 'Draft Payee', 'category_id', utilities), '[]');
    perform public.finance_save_voucher(r.o, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 6,
      'party_name', 'Waiting Payee', 'category_id', utilities, 'status', 'pending_approval'), '[]');
    perform public.finance_save_expense(r.o, jsonb_build_object('category_id', utilities, 'vendor_name', 'Pending', 'amount', 5));
    select id into rent from public.finance_ledger_accounts where org_id = r.o and code = '6000';
    select id into equity from public.finance_ledger_accounts where org_id = r.o and code = '3000';
    perform public.finance_save_journal(r.o, jsonb_build_object('journal_date', current_date, 'description', 'Draft'),
      jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 1), jsonb_build_object('account_id', equity, 'credit', 1)));
    insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (r.o, 'service', '2026-09-01', '2026-10-20');
  end loop;
  select count(*) into n from public.activity_log where org_id in (del_a, del_b) and entity_type is not null;
  select string_agg(details->>'event', ',' order by details->>'event') into t
    from public.activity_log where org_id in (del_a, del_b) and entity_type is not null;
  if t is distinct from 'approved,approved,filed,filed,submitted,submitted' then
    fails := fails || format('setup: the two workspaces to delete logged %s', t);
  end if;
  reset role;
  -- As the table owner, the owner's id still in the claims: every cascade deletes a draft with someone signed in.
  begin
    delete from public.orgs where id = del_a;
    get diagnostics n = row_count;
    if n <> 1 then fails := fails || format('org delete: %s workspaces deleted, not 1', n); end if;
    select (select count(*) from public.activity_log where org_id = del_a)
         + (select count(*) from public.finance_invoices where org_id = del_a)
         + (select count(*) from public.finance_quotations where org_id = del_a)
         + (select count(*) from public.finance_transactions where org_id = del_a)
         + (select count(*) from public.finance_journals where org_id = del_a)
         + (select count(*) from public.finance_expenses where org_id = del_a)
         + (select count(*) from public.finance_sst_returns where org_id = del_a) into n;
    if n <> 0 then fails := fails || format('org delete: %s rows outlive the deleted workspace', n); end if;
  exception when others then
    fails := fails || format('org delete: deleting the workspace with its owner signed in: %s %s', sqlstate, sqlerrm);
  end;
  -- delete_test_org, as the live tests' cleanup calls it (service_role), the owner's id still in the claims.
  begin
    set local role service_role;
    if not public.delete_test_org(del_b) then fails := fails || 'org delete: delete_test_org did not delete the workspace'::text; end if;
    reset role;
    select count(*) into n from public.activity_log where org_id = del_b;
    if n <> 0 then fails := fails || format('org delete: %s log rows outlive the workspace delete_test_org deleted', n); end if;
  exception when others then
    reset role;
    fails := fails || format('org delete: delete_test_org: %s %s', sqlstate, sqlerrm);
  end;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_AUDIT_TRAIL_CHECK PASSED (everything rolled back; % events checked)', jsonb_array_length(expected);
  end if;
  raise exception 'BENDAHARA_AUDIT_TRAIL_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
