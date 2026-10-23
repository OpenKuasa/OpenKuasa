-- Bendahara accounting settings check. Run it after 20261125140000_bendahara_accounting_settings.sql, in the same
-- transaction for a dry run, or by itself once applied. It leaves nothing behind either way: the block always ends
-- with RAISE, so every row and the helper function below are rolled back. Read the message:
--   BENDAHARA_ACCOUNTING_SETTINGS_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
--   begin;
--   \i supabase/migrations/20261125140000_bendahara_accounting_settings.sql
--   \i supabase/tests/bendahara_accounting_settings_check.sql
--   rollback;
--
-- It acts as a workspace's owner the way the app does (the authenticated role with that person's id in
-- request.jwt.claims, at aal2), and as an admin, a member and a viewer. It checks:
--   * the shape: orgs.tin, finance_settings (policies, grants, triggers), the two numbering functions, and a
--     finance_period_lock trigger on each table that holds a ledger effect;
--   * the company TIN: an admin saves it, a member cannot, a bad one is refused;
--   * the settings row: members read it, only an owner or admin writes it, a lock in the future is refused (FIN64),
--     every changed field is logged once and a save that changes nothing logs nothing;
--   * numbering: who may change it, an unknown document, a bad prefix (FIN66), a number going back (FIN65), a prefix
--     change keeps the counter and the next number uses it, each change logged; the list has all 13 documents;
--   * the books lock, through the real RPCs: with books locked to 31 Dec 1999, every posting path refuses a 1999 date
--     (FIN63) and takes today; drafts dated 1999 are still saved and edited; a posted 1999 document is not voided; a
--     document dated after the lock is; with the lock at today a void (dated today) is refused even for a later
--     document; with no lock everything is as before;
--   * a workspace with a lock and posted rows is deleted (as its owner and through delete_test_org), and a person who
--     posted an FX revaluation inside the locked period can still be deleted.
--
-- Locked dates are in 1999 (1999-11-15, the FX revaluation at 1999-11-30); the open ones are today in Malaysia (and
-- the FX revaluation at 2000-01-31). Every amount is in ringgit except the USD invoice the revaluation needs.
do $$
declare
  org uuid := gen_random_uuid();
  del_a uuid := gen_random_uuid();
  del_b uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  admin_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  owner_claims text;
  admin_claims text;
  member_claims text;
  viewer_claims text;
  kl date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  old_d date := date '1999-11-15';
  lock1 date := date '1999-12-31';
  cust uuid; sup uuid; both_c uuid; usd_c uuid;
  bank uuid; till uuid; rent uuid; equity uuid; utilities uuid; acc_old uuid; acc_sgd uuid; acc_del uuid;
  inv_old_v uuid; inv_old_cn uuid; inv_v_ok uuid; inv_d uuid; inv_ok uuid; inv_r uuid; inv_future uuid; inv_seq uuid;
  iusd uuid; ic_old uuid; bc_old uuid;
  bill_old_v uuid; bill_old_scn uuid; b_d uuid; b_ok uuid;
  cn_old_v uuid; cn_d uuid; cn_ok uuid; cn_r uuid;
  scn_old_v uuid; scn_d uuid; scn_ok uuid;
  p_old uuid; sched uuid; tr_old uuid; tr_ok uuid;
  e_d uuid; e_ok uuid;
  k_old uuid; k_d uuid; k_ok uuid;
  j_today uuid; j_d uuid; j_ok uuid; j_rev uuid;
  no text;
  x jsonb;
  expected jsonb;
  t text;
  n integer;
  n0 integer;
  ts timestamptz;
  r record;
  fails text[] := '{}';
  one_line jsonb := '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0}]';
  locked_msg text := 'This date is in a closed period: the books are locked to 31 Dec 1999.';
  rates_1999 jsonb := '{"USD":{"rate":"4.48","source":"manual"}}';
  rates_2000 jsonb := '{"USD":{"rate":"4.60","source":"manual"}}';
begin
  if to_regclass('public.finance_settings') is null then
    raise exception 'BENDAHARA_ACCOUNTING_SETTINGS_CHECK FAILED: public.finance_settings is missing';
  end if;

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

  -- ==== the shape ===============================================================================================
  select data_type || ':' || is_nullable into t from information_schema.columns
   where table_schema = 'public' and table_name = 'orgs' and column_name = 'tin';
  if t is distinct from 'text:YES' then fails := fails || format('orgs.tin is %s', coalesce(t, 'missing')); end if;
  if not has_column_privilege('authenticated', 'public.orgs', 'tin', 'update')
     or has_column_privilege('anon', 'public.orgs', 'tin', 'update')
     or has_column_privilege('authenticated', 'public.orgs', 'slug', 'update') then
    fails := fails || 'the update grants on orgs are not name..postcode plus tin for the authenticated role'::text;
  end if;
  select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' order by column_name) into t
    from information_schema.columns where table_schema = 'public' and table_name = 'finance_settings';
  if t is distinct from 'lock_date:date:YES:-,org_id:uuid:NO:-,updated_at:timestamp with time zone:NO:now(),updated_by:uuid:YES:-,year_end_month:smallint:NO:12' then
    fails := fails || format('finance_settings columns are %s', t);
  end if;
  select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text, ',' order by polname) into t
    from pg_policy where polrelid = 'public.finance_settings'::regclass;
  if t is distinct from 'finance_settings_insert:a:true,finance_settings_select:r:true,finance_settings_update:w:true,mfa_required:*:false' then
    fails := fails || format('finance_settings policies are %s', t);
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.finance_settings'::regclass) then
    fails := fails || 'finance_settings has no row-level security'::text;
  end if;
  if not has_table_privilege('authenticated', 'public.finance_settings', 'select')
     or not has_table_privilege('authenticated', 'public.finance_settings', 'insert')
     or not has_table_privilege('authenticated', 'public.finance_settings', 'update')
     or has_table_privilege('authenticated', 'public.finance_settings', 'delete')
     or has_table_privilege('authenticated', 'public.finance_settings', 'truncate')
     or has_table_privilege('anon', 'public.finance_settings', 'select') then
    fails := fails || 'finance_settings grants are not select, insert, update for the authenticated role only'::text;
  end if;
  select string_agg(g.tgname || ':' || g.tgtype, ',' order by g.tgname collate "C") into t
    from pg_trigger g where g.tgrelid = 'public.finance_settings'::regclass and not g.tgisinternal and g.tgenabled = 'O';
  -- tgtype: 1 row + 2 before + 4 insert + 16 update = 23; an AFTER one is 21.
  if t is distinct from 'finance_settings_audit:21,finance_settings_guard:23,finance_settings_stamp:23' then
    fails := fails || format('finance_settings triggers are %s', t);
  end if;
  for r in
    select * from (values
      ('public.finance_invoices', 'invoice_date', 'posted,void'),
      ('public.finance_credit_notes', 'credit_date', 'issued,void'),
      ('public.supplier_bills', 'bill_date', 'posted,void'),
      ('public.finance_supplier_credit_notes', 'credit_date', 'issued,void'),
      ('public.finance_transactions', 'txn_date', 'posted,void'),
      ('public.finance_expenses', 'expense_date', 'approved'),
      ('public.finance_contras', 'contra_date', 'posted,void'),
      ('public.finance_journals', 'journal_date', 'posted'),
      ('public.finance_fx_revaluations', 'period_end', '*')
    ) as v(tbl, col, statuses)
  loop
    select count(*) into n from pg_trigger g
     where g.tgrelid = r.tbl::regclass and g.tgname = 'finance_period_lock' and not g.tgisinternal and g.tgenabled = 'O'
       and g.tgtype = 23 and g.tgfoid = 'private.finance_period_lock()'::regprocedure and g.tgattr = ''::int2vector
       and g.tgnargs = 2
       and encode(g.tgargs, 'escape') = r.col || '\000' || r.statuses || '\000';
    if n <> 1 then fails := fails || format('finance_period_lock on %s is missing or not (%s, %s)', r.tbl, r.col, r.statuses); end if;
  end loop;
  select string_agg(a.attname, ',' order by a.attname) into t
    from pg_trigger g join pg_attribute a on a.attrelid = g.tgrelid and a.attnum = any(g.tgattr)
   where g.tgrelid = 'public.finance_accounts'::regclass and g.tgname = 'finance_period_lock' and g.tgtype = 31
     and g.tgenabled = 'O' and g.tgfoid = 'private.finance_period_lock()'::regprocedure;
  -- tgtype 31: row, before, insert, delete, update (of these columns).
  if t is distinct from 'opening_balance,opening_date,opening_rate' then
    fails := fails || format('finance_period_lock on finance_accounts fires on %s', coalesce(t, 'nothing'));
  end if;
  for r in
    select * from (values ('public.finance_set_sequence(uuid, text, text, integer)'), ('public.finance_sequence_list(uuid)')) v(f)
  loop
    select count(*) into n from pg_proc p
     where p.oid = r.f::regprocedure and p.prosecdef and p.proconfig @> array['search_path=""'];
    if n <> 1 then fails := fails || format('%s is not security definer with an empty search_path', r.f); end if;
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute')
       or has_function_privilege('service_role', r.f, 'execute') then
      fails := fails || format('%s is not executable by the authenticated role alone', r.f);
    end if;
  end loop;
  select count(*) into n from pg_proc p
   where p.oid = 'private.finance_period_lock()'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=""'];
  if n <> 1 then fails := fails || 'private.finance_period_lock is not security definer with an empty search_path'::text; end if;
  if has_function_privilege('authenticated', 'private.finance_period_lock()', 'execute') then
    fails := fails || 'the authenticated role may call private.finance_period_lock'::text;
  end if;

  -- ---- people and workspaces: a test address, so delete_test_org may delete them -------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'qa-' || substr(md5(u.id::text), 1, 12) || '-1@example.com', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, admin_id, member_id, viewer_id]) as u(id);
  insert into public.orgs (id, name) values
    (org, 'Settings Check Sdn Bhd'), (del_a, 'Settings Delete A'), (del_b, 'Settings Delete B');
  insert into public.org_members (org_id, user_id, role) values
    (org, owner_id, 'owner'), (org, admin_id, 'admin'), (org, member_id, 'member'), (org, viewer_id, 'viewer'),
    (del_a, owner_id, 'owner'), (del_b, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  admin_claims := json_build_object('sub', admin_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;

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

  -- ==== company TIN =============================================================================================
  update public.orgs set tin = 'C2584563200' where id = org;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || format('tin: the owner saved %s rows, not 1', n); end if;
  fails := fails || public.bendahara_check_try('tin: lower case', '23514', format('update public.orgs set tin = %L where id = %L', 'c2584563200', org));
  fails := fails || public.bendahara_check_try('tin: a space', '23514', format('update public.orgs set tin = %L where id = %L', 'C 2584', org));
  fails := fails || public.bendahara_check_try('tin: empty', '23514', format('update public.orgs set tin = %L where id = %L', '', org));
  fails := fails || public.bendahara_check_try('tin: 21 characters', '23514', format('update public.orgs set tin = %L where id = %L', repeat('A', 21), org));
  perform set_config('request.jwt.claims', admin_claims, true);
  update public.orgs set tin = 'IG1234567890' where id = org;
  get diagnostics n = row_count;
  if n <> 1 then fails := fails || format('tin: an admin saved %s rows, not 1', n); end if;
  perform set_config('request.jwt.claims', member_claims, true);
  update public.orgs set tin = 'C1' where id = org;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || format('tin: a member saved %s rows', n); end if;
  select tin into t from public.orgs where id = org;
  if t is distinct from 'IG1234567890' then fails := fails || format('tin: a member reads %s', t); end if;
  perform set_config('request.jwt.claims', owner_claims, true);
  update public.orgs set tin = null where id = org;

  -- ==== the settings row ========================================================================================
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('settings: a member creates them', '42501',
    format('insert into public.finance_settings (org_id, lock_date) values (%L, %L)', org, '1999-01-31'));
  perform set_config('request.jwt.claims', owner_claims, true);
  -- A first save of the defaults (December, open books) changes nothing, so it logs nothing.
  insert into public.finance_settings (org_id, year_end_month, lock_date, updated_by, updated_at)
  values (org, 12, null, member_id, '2000-01-01');
  select updated_by, updated_at into r from public.finance_settings where org_id = org;
  if r.updated_by is distinct from owner_id or r.updated_at < now() - interval '1 minute' then
    fails := fails || format('settings: stamped %s at %s, not the owner now', r.updated_by, r.updated_at);
  end if;
  fails := fails || public.bendahara_check_try('settings: month 13', '23514',
    format('update public.finance_settings set year_end_month = 13 where org_id = %L', org));
  fails := fails || public.bendahara_check_try('settings: month 0', '23514',
    format('update public.finance_settings set year_end_month = 0 where org_id = %L', org));
  fails := fails || public.bendahara_check_try('settings: a lock tomorrow in Malaysia', 'FIN64',
    format('update public.finance_settings set lock_date = %L where org_id = %L', kl + 1, org));
  fails := fails || public.bendahara_check_try('settings: a first save with a lock in the future', 'FIN64',
    format('insert into public.finance_settings (org_id, lock_date) values (%L, %L)', del_a, kl + 30));
  begin
    update public.finance_settings set lock_date = kl + 1 where org_id = org;
  exception when others then
    if sqlerrm <> 'The books can''t be locked to a date in the future.' then
      fails := fails || format('settings: FIN64 reads %s', sqlerrm);
    end if;
  end;
  fails := fails || public.bendahara_check_try('settings: an owner deletes them', '42501',
    format('delete from public.finance_settings where org_id = %L', org));
  update public.finance_settings set year_end_month = 6 where org_id = org;
  update public.finance_settings set year_end_month = 6 where org_id = org;
  perform set_config('request.jwt.claims', member_claims, true);
  select count(*) into n from public.finance_settings where org_id = org and year_end_month = 6;
  if n <> 1 then fails := fails || format('settings: a member reads %s rows', n); end if;
  update public.finance_settings set year_end_month = 1 where org_id = org;
  get diagnostics n = row_count;
  if n <> 0 then fails := fails || format('settings: a member saved %s rows', n); end if;
  perform set_config('request.jwt.claims', viewer_claims, true);
  select count(*) into n from public.finance_settings where org_id = org;
  if n <> 1 then fails := fails || format('settings: a viewer reads %s rows', n); end if;
  perform set_config('request.jwt.claims', owner_claims, true);

  -- ==== numbering ===============================================================================================
  perform set_config('request.jwt.claims', viewer_claims, true);
  select count(*), count(*) filter (where s.next_number = 1 and s.pad = 4),
         string_agg(s.doc_type || '=' || s.prefix, ',' order by s.doc_type)
    into n, n0, t
    from public.finance_sequence_list(org) s;
  if n <> 13 or n0 <> 13
     or t is distinct from 'bill=BILL-,contra=CT-,credit_note=CN-,fx_revaluation=FX-,invoice=INV-,journal=JV-,purchase_order=PO-,quotation=QT-,receipt=RC-,rfq=RFQ-,supplier_credit_note=SCN-,transfer=TR-,voucher=PV-' then
    fails := fails || format('numbering: a viewer lists %s rows (%s at 1/4): %s', n, n0, t);
  end if;
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('numbering: a member changes it', '42501',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', 'INV-', 5));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('numbering: another workspace', '42501',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', gen_random_uuid(), 'invoice', 'INV-', 5));
  fails := fails || public.bendahara_check_try('numbering: another workspace''s list', '42501',
    format('select * from public.finance_sequence_list(%L)', gen_random_uuid()));
  fails := fails || public.bendahara_check_try('numbering: an unknown document', '22023',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'payslip', 'PS-', 5));
  fails := fails || public.bendahara_check_try('numbering: a prefix with a space', 'FIN66',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', 'IN V', 5));
  fails := fails || public.bendahara_check_try('numbering: an 11-character prefix', 'FIN66',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', 'ABCDEFGHIJK', 5));
  fails := fails || public.bendahara_check_try('numbering: an empty prefix', 'FIN66',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', '', 5));
  fails := fails || public.bendahara_check_try('numbering: no prefix', 'FIN66',
    format('select public.finance_set_sequence(%L, %L, null, %s)', org, 'invoice', 5));
  fails := fails || public.bendahara_check_try('numbering: an underscore', 'FIN66',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', 'INV_', 5));
  begin
    perform public.finance_set_sequence(org, 'invoice', 'IN V', 5);
  exception when others then
    if sqlerrm <> 'A prefix is 1 to 10 letters, numbers, dashes or slashes.' then
      fails := fails || format('numbering: FIN66 reads %s', sqlerrm);
    end if;
  end;
  -- A prefix change on a document never numbered: the row is made, the prefix stored in capitals, the counter kept.
  perform public.finance_set_sequence(org, 'invoice', 'si/', 1);
  select prefix || '|' || next_number || '|' || pad into t from public.finance_sequence_list(org) where doc_type = 'invoice';
  if t is distinct from 'SI/|1|4' then fails := fails || format('numbering: the invoice sequence is %s, not SI/|1|4', t); end if;
  perform public.finance_set_sequence(org, 'invoice', 'SI/', 50);
  fails := fails || public.bendahara_check_try('numbering: going back', 'FIN65',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', 'SI/', 49));
  fails := fails || public.bendahara_check_try('numbering: no next number', 'FIN65',
    format('select public.finance_set_sequence(%L, %L, %L, null)', org, 'invoice', 'SI/'));
  begin
    perform public.finance_set_sequence(org, 'invoice', 'SI/', 49);
  exception when others then
    if sqlerrm <> 'The next number can''t go back: it must be 50 or more.' then
      fails := fails || format('numbering: FIN65 reads %s', sqlerrm);
    end if;
  end;
  -- Nothing changed: nothing written, nothing logged.
  reset role;
  select updated_at into ts from public.finance_sequences where org_id = org and doc_type = 'invoice';
  set local role authenticated;
  perform public.finance_set_sequence(org, 'invoice', 'si/', 50);
  reset role;
  if (select updated_at from public.finance_sequences where org_id = org and doc_type = 'invoice') is distinct from ts then
    fails := fails || 'numbering: a save that changes nothing touched the row'::text;
  end if;
  set local role authenticated;
  inv_seq := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl, 'due_date', kl + 30), one_line);
  no := public.finance_post_invoice(org, inv_seq);
  if no is distinct from 'SI/0050' then fails := fails || format('numbering: the next invoice is %s, not SI/0050', no); end if;
  fails := fails || public.bendahara_check_try('numbering: back to a number given', 'FIN65',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'invoice', 'SI/', 50));
  -- A prefix change keeps the counter: no number given under any prefix is reached again.
  perform public.finance_set_sequence(org, 'invoice', 'INV-', 51);
  if public.finance_next_number(org, 'invoice') is distinct from 'INV-0051' then
    fails := fails || 'numbering: after a prefix change the next number is not INV-0051'::text;
  end if;
  perform public.finance_set_sequence(org, 'journal', 'GJ-', 1);
  -- A prefix another document uses now (receipts and vouchers share one number column): the voucher's default, a
  -- prefix set on another document, in any case. Nothing is written or logged.
  fails := fails || public.bendahara_check_try('numbering: a receipt takes the vouchers'' prefix', 'FIN67',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'receipt', 'PV-', 1));
  fails := fails || public.bendahara_check_try('numbering: a quotation takes the journals'' new prefix', 'FIN67',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'quotation', 'gj-', 1));
  fails := fails || public.bendahara_check_try('numbering: a bill takes the journals'' old prefix, now free', 'ok',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'bill', 'JV-', 1));
  fails := fails || public.bendahara_check_try('numbering: the journal keeps its own prefix and moves on', 'ok',
    format('select public.finance_set_sequence(%L, %L, %L, %s)', org, 'journal', 'GJ-', 5));
  begin
    perform public.finance_set_sequence(org, 'receipt', 'PV-', 1);
  exception when others then
    if sqlerrm <> 'Another document already uses this prefix.' then
      fails := fails || format('numbering: FIN67 reads %s', sqlerrm);
    end if;
  end;
  select prefix into t from public.finance_sequence_list(org) where doc_type = 'receipt';
  if t is distinct from 'RC-' then fails := fails || format('numbering: the receipt prefix is %s after a refusal', t); end if;

  -- ==== the books lock: what was posted before it ===============================================================
  -- With books open: documents dated 1999 posted, ready to be voided (or paid against) once locked.
  inv_old_v := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', old_d, 'due_date', old_d + 30), one_line);
  perform public.finance_post_invoice(org, inv_old_v);
  inv_old_cn := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', old_d, 'due_date', old_d + 30), one_line);
  perform public.finance_post_invoice(org, inv_old_cn);
  cn_old_v := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv_old_cn, 'reason', 'returns', 'amount', 10, 'credit_date', old_d));
  perform public.finance_issue_credit_note(org, cn_old_v);
  bill_old_v := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', old_d, 'due_date', old_d + 30), one_line);
  perform public.finance_post_bill(org, bill_old_v);
  bill_old_scn := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', old_d, 'due_date', old_d + 30), one_line);
  perform public.finance_post_bill(org, bill_old_scn);
  scn_old_v := public.finance_save_supplier_credit_note(org, jsonb_build_object('bill_id', bill_old_scn, 'amount', 10, 'credit_date', old_d));
  perform public.finance_issue_supplier_credit_note(org, scn_old_v);
  p_old := public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', old_d),
    jsonb_build_array(jsonb_build_object('invoice_id', inv_old_cn, 'amount', 10)));
  tr_old := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 50, 'txn_date', old_d));
  ic_old := public.finance_save_invoice(org, jsonb_build_object('customer_id', both_c, 'invoice_date', old_d, 'due_date', old_d + 30), one_line);
  perform public.finance_post_invoice(org, ic_old);
  bc_old := public.finance_save_bill(org, jsonb_build_object('supplier_id', both_c, 'bill_date', old_d, 'due_date', old_d + 30), one_line);
  perform public.finance_post_bill(org, bc_old);
  k_old := public.finance_save_contra(org, jsonb_build_object('contact_id', both_c, 'amount', 25, 'contra_date', old_d),
    jsonb_build_array(jsonb_build_object('invoice_id', ic_old, 'amount', 25), jsonb_build_object('bill_id', bc_old, 'amount', 25)));
  perform public.finance_post_contra(org, k_old);
  insert into public.finance_accounts (org_id, name, kind, bank_name, opening_balance, opening_date)
  values (org, 'Old Bank', 'bank', 'Maybank', 100, old_d) returning id into acc_old;
  -- Dated today: a bill with a payment out scheduled against it, a refund ready, a journal to reverse.
  b_ok := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', kl, 'due_date', kl + 30), one_line);
  perform public.finance_post_bill(org, b_ok);
  sched := public.finance_record_payment_out(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'status', 'scheduled', 'txn_date', kl),
    jsonb_build_array(jsonb_build_object('bill_id', b_ok, 'amount', 15)));
  inv_r := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl, 'due_date', kl + 30), one_line);
  perform public.finance_post_invoice(org, inv_r);
  perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', kl),
    jsonb_build_array(jsonb_build_object('invoice_id', inv_r, 'amount', 100)));
  cn_r := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv_r, 'reason', 'returns', 'amount', 20, 'credit_date', kl));
  perform public.finance_issue_credit_note(org, cn_r);
  j_today := public.finance_save_journal(org, jsonb_build_object('journal_date', kl, 'description', 'Rent paid by the owner'),
    jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 40), jsonb_build_object('account_id', equity, 'credit', 40)));
  perform public.finance_post_journal(org, j_today);
  inv_v_ok := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl, 'due_date', kl + 30), one_line);
  perform public.finance_post_invoice(org, inv_v_ok);
  -- The USD invoice an FX revaluation revalues (a typed rate).
  iusd := public.finance_save_invoice(org, jsonb_build_object('customer_id', usd_c, 'invoice_date', '1999-11-05',
    'due_date', '2000-03-05', 'currency', 'USD', 'fx_rate', '4.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'),
    '[{"description":"A","quantity":1,"unit_price":1000,"sst_rate":0}]');
  perform public.finance_post_invoice(org, iusd);

  -- ==== lock the books to 31 Dec 1999 ===========================================================================
  update public.finance_settings set lock_date = lock1 where org_id = org;

  -- Drafts dated in the locked period are saved and edited.
  begin
    t := 'an invoice draft';
    inv_d := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', old_d, 'due_date', old_d + 30), one_line);
    t := 'the invoice draft edited';
    perform public.finance_save_invoice(org, jsonb_build_object('id', inv_d, 'customer_id', cust, 'invoice_date', old_d - 1,
      'due_date', old_d + 30, 'notes', 'edited'), one_line);
    t := 'a bill draft';
    b_d := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', old_d, 'due_date', old_d + 30), one_line);
    t := 'a credit note draft';
    cn_d := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv_old_cn, 'reason', 'returns', 'amount', 5, 'credit_date', old_d));
    t := 'a supplier credit note draft';
    scn_d := public.finance_save_supplier_credit_note(org, jsonb_build_object('bill_id', bill_old_scn, 'amount', 5, 'credit_date', old_d));
    -- A member's claim waits for approval (an owner's own is approved as it is saved).
    t := 'a member''s expense claim';
    perform set_config('request.jwt.claims', member_claims, true);
    e_d := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'TNB', 'amount', 30, 'expense_date', old_d));
    e_ok := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Syabas', 'amount', 20, 'expense_date', kl));
    perform set_config('request.jwt.claims', owner_claims, true);
    t := 'a contra draft';
    k_d := public.finance_save_contra(org, jsonb_build_object('contact_id', both_c, 'amount', 5, 'contra_date', old_d),
      jsonb_build_array(jsonb_build_object('invoice_id', ic_old, 'amount', 5), jsonb_build_object('bill_id', bc_old, 'amount', 5)));
    t := 'a journal draft';
    j_d := public.finance_save_journal(org, jsonb_build_object('journal_date', old_d, 'description', 'Accrual'),
      jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 9), jsonb_build_object('account_id', equity, 'credit', 9)));
    t := 'the journal draft edited';
    perform public.finance_save_journal(org, jsonb_build_object('id', j_d, 'journal_date', old_d, 'description', 'Accrual, edited'),
      jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 9), jsonb_build_object('account_id', equity, 'credit', 9)));
    t := 'a voucher draft';
    perform public.finance_save_voucher(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7,
      'party_name', 'Kedai Runcit', 'category_id', utilities, 'txn_date', old_d), '[]');
  exception when others then
    fails := fails || format('drafts dated in the locked period: %s: %s %s', t, sqlstate, sqlerrm);
  end;

  -- Every posting path refuses a locked date ...
  begin
    perform public.finance_post_invoice(org, inv_d);
    fails := fails || 'invoice post: a draft dated in the locked period was posted'::text;
  exception when others then
    if sqlstate <> 'FIN63' or sqlerrm <> locked_msg then
      fails := fails || format('invoice post: %s %s, not FIN63 "%s"', sqlstate, sqlerrm, locked_msg);
    end if;
  end;
  fails := fails || public.bendahara_check_try('credit note issue', 'FIN63', format('select public.finance_issue_credit_note(%L, %L)', org, cn_d));
  fails := fails || public.bendahara_check_try('bill post', 'FIN63', format('select public.finance_post_bill(%L, %L)', org, b_d));
  fails := fails || public.bendahara_check_try('supplier credit note issue', 'FIN63', format('select public.finance_issue_supplier_credit_note(%L, %L)', org, scn_d));
  fails := fails || public.bendahara_check_try('payment in', 'FIN63',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', old_d),
      jsonb_build_array(jsonb_build_object('invoice_id', inv_v_ok, 'amount', 10))));
  fails := fails || public.bendahara_check_try('payment out', 'FIN63',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', old_d),
      jsonb_build_array(jsonb_build_object('bill_id', b_ok, 'amount', 10))));
  fails := fails || public.bendahara_check_try('payment out marked paid', 'FIN63',
    format('select public.finance_mark_payment_paid(%L, %L, %L)', org, sched, old_d));
  fails := fails || public.bendahara_check_try('refund', 'FIN63',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_r, 'account_id', bank, 'amount', 5, 'method', 'fpx', 'txn_date', old_d)));
  fails := fails || public.bendahara_check_try('transfer', 'FIN63',
    format('select public.finance_record_transfer(%L, %L)', org,
      jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 5, 'txn_date', old_d)));
  fails := fails || public.bendahara_check_try('voucher', 'FIN63',
    format('select public.finance_record_voucher(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7, 'party_name', 'Kedai Runcit', 'category_id', utilities, 'txn_date', old_d), '[]'));
  fails := fails || public.bendahara_check_try('expense approve', 'FIN63',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'approved', e_d));
  fails := fails || public.bendahara_check_try('expense saved by an owner (approved as saved)', 'FIN63',
    format('select public.finance_save_expense(%L, %L)', org,
      jsonb_build_object('category_id', utilities, 'vendor_name', 'TNB', 'amount', 30, 'expense_date', old_d)));
  fails := fails || public.bendahara_check_try('contra post', 'FIN63', format('select public.finance_post_contra(%L, %L)', org, k_d));
  fails := fails || public.bendahara_check_try('journal post', 'FIN63', format('select public.finance_post_journal(%L, %L)', org, j_d));
  -- A reversal is made as a draft; posting it on a locked date is refused.
  j_rev := public.finance_reverse_journal(org, j_today, old_d);
  fails := fails || public.bendahara_check_try('journal reverse', 'FIN63', format('select public.finance_post_journal(%L, %L)', org, j_rev));
  delete from public.finance_journals where id = j_rev and status = 'draft';
  select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
    from public.finance_fx_revaluation_preview(org, date '1999-11-30', rates_1999) p;
  fails := fails || public.bendahara_check_try('FX revaluation post', 'FIN63',
    format('select * from public.finance_post_fx_revaluation(%L, %L)', org,
      jsonb_build_object('period_end', '1999-11-30', 'rates', rates_1999, 'expected', x)));
  fails := fails || public.bendahara_check_try('opening balance on a new account', 'FIN63',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date) values (%L, %L, %L, 100, %L)',
      org, 'New Locked', 'bank', old_d));
  fails := fails || public.bendahara_check_try('opening balance changed', 'FIN63',
    format('update public.finance_accounts set opening_balance = 200 where id = %L', acc_old));
  fails := fails || public.bendahara_check_try('opening balance taken out', 'FIN63',
    format('update public.finance_accounts set opening_balance = 0 where id = %L', acc_old));
  fails := fails || public.bendahara_check_try('opening date moved into the open period', 'FIN63',
    format('update public.finance_accounts set opening_date = %L where id = %L', kl, acc_old));

  -- ... and voiding a posted document dated in the locked period is refused.
  fails := fails || public.bendahara_check_try('void: invoice', 'FIN63',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', inv_old_v));
  fails := fails || public.bendahara_check_try('void: credit note', 'FIN63',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cn_old_v));
  fails := fails || public.bendahara_check_try('void: bill', 'FIN63',
    format('update public.supplier_bills set status = %L, updated_at = now() where id = %L', 'void', bill_old_v));
  fails := fails || public.bendahara_check_try('void: supplier credit note', 'FIN63',
    format('update public.finance_supplier_credit_notes set status = %L, updated_at = now() where id = %L', 'void', scn_old_v));
  fails := fails || public.bendahara_check_try('void: payment in', 'FIN63',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', p_old));
  fails := fails || public.bendahara_check_try('void: transfer', 'FIN63', format('select public.finance_void_transfer(%L, %L)', org, tr_old));
  fails := fails || public.bendahara_check_try('void: contra', 'FIN63', format('select public.finance_void_contra(%L, %L)', org, k_old));

  -- A change that is not a ledger effect on a posted document in the locked period still goes through.
  fails := fails || public.bendahara_check_try('a locked invoice''s e-invoice status', 'ok',
    format('update public.finance_invoices set einvoice_status = %L where id = %L', 'pending', inv_old_v));
  fails := fails || public.bendahara_check_try('a locked account renamed', 'ok',
    format('update public.finance_accounts set name = %L where id = %L', 'Old Bank, renamed', acc_old));
  fails := fails || public.bendahara_check_try('a locked account given the same opening balance', 'ok',
    format('update public.finance_accounts set opening_balance = 100, opening_date = %L where id = %L', old_d, acc_old));
  fails := fails || public.bendahara_check_try('an account with no opening balance dated in the locked period', 'ok',
    format('insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date) values (%L, %L, %L, 0, %L)',
      org, 'Empty Old', 'cash', old_d));

  -- The same paths take a date after the lock.
  begin
    inv_ok := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl, 'due_date', kl + 30), one_line);
    perform public.finance_post_invoice(org, inv_ok);
    cn_ok := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', inv_old_cn, 'reason', 'returns', 'amount', 5, 'credit_date', kl));
    perform public.finance_issue_credit_note(org, cn_ok);
    b_d := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', kl, 'due_date', kl + 30), one_line);
    perform public.finance_post_bill(org, b_d);
    scn_ok := public.finance_save_supplier_credit_note(org, jsonb_build_object('bill_id', bill_old_scn, 'amount', 5, 'credit_date', kl));
    perform public.finance_issue_supplier_credit_note(org, scn_ok);
    perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', kl),
      jsonb_build_array(jsonb_build_object('invoice_id', inv_ok, 'amount', 10)));
    perform public.finance_record_payment_out(org, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', kl),
      jsonb_build_array(jsonb_build_object('bill_id', b_ok, 'amount', 10)));
    perform public.finance_mark_payment_paid(org, sched, kl);
    perform public.finance_record_refund(org, jsonb_build_object('credit_note_id', cn_r, 'account_id', bank, 'amount', 5, 'method', 'fpx', 'txn_date', kl));
    tr_ok := public.finance_record_transfer(org, jsonb_build_object('from_account_id', bank, 'to_account_id', till, 'amount', 5, 'txn_date', kl));
    perform public.finance_record_voucher(org, jsonb_build_object('account_id', bank, 'method', 'cash', 'amount', 7,
      'party_name', 'Kedai Runcit', 'category_id', utilities, 'txn_date', kl), '[]');
    update public.finance_expenses set status = 'approved', updated_at = now() where id = e_ok;
    perform public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Indah Water', 'amount', 10, 'expense_date', kl));
    k_ok := public.finance_save_contra(org, jsonb_build_object('contact_id', both_c, 'amount', 5, 'contra_date', kl),
      jsonb_build_array(jsonb_build_object('invoice_id', ic_old, 'amount', 5), jsonb_build_object('bill_id', bc_old, 'amount', 5)));
    perform public.finance_post_contra(org, k_ok);
    j_ok := public.finance_save_journal(org, jsonb_build_object('journal_date', kl, 'description', 'Accrual'),
      jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 9), jsonb_build_object('account_id', equity, 'credit', 9)));
    perform public.finance_post_journal(org, j_ok);
    j_rev := public.finance_reverse_journal(org, j_today, kl);
    if (select status from public.finance_journals where id = j_rev) <> 'posted' then
      perform public.finance_post_journal(org, j_rev);
    end if;
    insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date) values (org, 'New Open', 'bank', 100, kl);
    -- Voids of documents dated after the lock.
    update public.finance_invoices set status = 'void', updated_at = now() where id = inv_v_ok;
    perform public.finance_void_transfer(org, tr_ok);
    perform public.finance_void_contra(org, k_ok);
  exception when others then
    fails := fails || format('a date after the lock: %s %s', sqlstate, sqlerrm);
  end;
  -- The FX revaluation after the lock, posted by the admin (who is deleted below).
  perform set_config('request.jwt.claims', admin_claims, true);
  begin
    select jsonb_build_object('lines', count(*), 'net_gain', coalesce(sum(p.gain), 0)::text, 'digest', max(p.digest)) into x
      from public.finance_fx_revaluation_preview(org, date '2000-01-31', rates_2000) p;
    perform * from public.finance_post_fx_revaluation(org, jsonb_build_object('period_end', '2000-01-31', 'rates', rates_2000, 'expected', x));
  exception when others then
    fails := fails || format('FX revaluation after the lock: %s %s', sqlstate, sqlerrm);
  end;
  perform set_config('request.jwt.claims', owner_claims, true);

  -- ==== the lock at today: a void is dated today, so even a later document is not voided ==========================
  inv_future := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl + 5, 'due_date', kl + 35), one_line);
  perform public.finance_post_invoice(org, inv_future);
  update public.finance_settings set lock_date = kl where org_id = org;
  fails := fails || public.bendahara_check_try('lock at today: void of a later invoice', 'FIN63',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', inv_future));
  inv_ok := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl, 'due_date', kl + 30), one_line);
  fails := fails || public.bendahara_check_try('lock at today: an invoice dated today', 'FIN63',
    format('select public.finance_post_invoice(%L, %L)', org, inv_ok));
  inv_ok := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', kl + 1, 'due_date', kl + 30), one_line);
  fails := fails || public.bendahara_check_try('lock at today: an invoice dated tomorrow', 'ok',
    format('select public.finance_post_invoice(%L, %L)', org, inv_ok));

  -- ==== reopened: no lock, everything as before ==================================================================
  update public.finance_settings set lock_date = null where org_id = org;
  begin
    t := 'reopened: post, void, approve, opening balance';
    perform public.finance_post_invoice(org, inv_d);
    update public.finance_invoices set status = 'void', updated_at = now() where id = inv_old_v;
    perform public.finance_post_journal(org, j_d);
    update public.finance_expenses set status = 'approved', updated_at = now() where id = e_d;
    perform public.finance_void_transfer(org, tr_old);
    update public.finance_accounts set opening_balance = 200 where id = acc_old;
    -- An approved expense dated in the old period is rejected; two more are approved for the lock below.
    t := 'reopened: a member''s claims';
    perform set_config('request.jwt.claims', member_claims, true);
    e_d := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Air', 'amount', 11, 'expense_date', old_d));
    e_ok := public.finance_save_expense(org, jsonb_build_object('category_id', utilities, 'vendor_name', 'Api', 'amount', 12, 'expense_date', old_d));
    perform set_config('request.jwt.claims', owner_claims, true);
    t := 'reopened: approve and reject';
    update public.finance_expenses set status = 'approved', updated_at = now() where id in (e_d, e_ok);
    update public.finance_expenses set status = 'rejected', updated_at = now() where id = e_d;
    -- An opening balance in Singapore dollars dated in the old period: its rate changed; an account with an opening
    -- balance in the old period deleted.
    t := 'reopened: opening rate';
    insert into public.finance_accounts (org_id, name, kind, currency, opening_balance, opening_date, opening_rate, opening_rate_source)
    values (org, 'SGD Old', 'bank', 'SGD', 100, old_d, 4.2, 'manual') returning id into acc_sgd;
    update public.finance_accounts set opening_rate = 3.25 where id = acc_sgd;
    t := 'reopened: account deleted';
    insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date) values (org, 'Gone Old', 'cash', 10, old_d)
      returning id into acc_del;
    delete from public.finance_accounts where id = acc_del;
  exception when others then
    fails := fails || format('reopened (%s): %s %s', t, sqlstate, sqlerrm);
  end;
  -- Both fields in one save: two rows.
  update public.finance_settings set lock_date = lock1, year_end_month = 3 where org_id = org;
  -- A save that changes nothing logs nothing.
  update public.finance_settings set lock_date = lock1, year_end_month = 3 where org_id = org;

  -- ==== locked again to 31 Dec 1999: leaving the ledger, opening rates, deleting accounts ===========================
  -- An approved expense dated in the locked period is not rejected (its entry would leave the closed period).
  fails := fails || public.bendahara_check_try('an approved expense dated in the locked period rejected', 'FIN63',
    format('update public.finance_expenses set status = %L, updated_at = now() where id = %L', 'rejected', e_ok));
  -- The rate of an opening balance dated in the locked period: changed is refused; the same rate marked as Bank
  -- Negara's for a day (the source and its date, not the rate) is not a ledger change.
  reset role;
  insert into public.finance_fx_rates (currency, rate_date, session, unit, selling_rate, middle_rate, rate)
  values ('SGD', '1999-11-12', '1700', 1, 3.25, 3.2, 3.2);
  set local role authenticated;
  fails := fails || public.bendahara_check_try('an opening rate changed', 'FIN63',
    format('update public.finance_accounts set opening_rate = 3.3 where id = %L', acc_sgd));
  fails := fails || public.bendahara_check_try('an opening rate''s source and date, same rate', 'ok',
    format('update public.finance_accounts set opening_rate = 3.25, opening_rate_source = %L, opening_rate_date = %L where id = %L',
      'bnm', '1999-11-12', acc_sgd));
  -- An account holding an opening balance dated in the locked period is not deleted; one without is.
  fails := fails || public.bendahara_check_try('an account with a locked opening balance deleted', 'FIN63',
    format('delete from public.finance_accounts where id = %L', acc_old));
  fails := fails || public.bendahara_check_try('an account with no opening balance deleted', 'ok',
    format('delete from public.finance_accounts where org_id = %L and name = %L', org, 'Empty Old'));

  -- ==== what the settings logged: every change once, and nothing else ===========================================
  reset role;
  expected := jsonb_build_array(
    jsonb_build_array('Changed the financial year end', 'Financial year end', '{"event":"changed","changed":{"year_end_month":{"from":12,"to":6}}}'::jsonb),
    jsonb_build_array('Changed document numbering', 'Invoice numbering', '{"event":"changed","doc":"invoice","changed":{"prefix":{"from":"INV-","to":"SI/"}}}'::jsonb),
    jsonb_build_array('Changed document numbering', 'Invoice numbering', '{"event":"changed","doc":"invoice","changed":{"next_number":{"from":1,"to":50}}}'::jsonb),
    jsonb_build_array('Changed document numbering', 'Invoice numbering', '{"event":"changed","doc":"invoice","changed":{"prefix":{"from":"SI/","to":"INV-"}}}'::jsonb),
    jsonb_build_array('Changed document numbering', 'Journal numbering', '{"event":"changed","doc":"journal","changed":{"prefix":{"from":"JV-","to":"GJ-"}}}'::jsonb),
    jsonb_build_array('Changed document numbering', 'Supplier bill numbering', '{"event":"changed","doc":"bill","changed":{"prefix":{"from":"BILL-","to":"JV-"}}}'::jsonb),
    jsonb_build_array('Changed document numbering', 'Journal numbering', '{"event":"changed","doc":"journal","changed":{"next_number":{"from":1,"to":5}}}'::jsonb),
    jsonb_build_array('Changed the books lock date', 'Books lock date',
      jsonb_build_object('event', 'changed', 'changed', jsonb_build_object('lock_date', jsonb_build_object('from', null, 'to', lock1)))),
    jsonb_build_array('Changed the books lock date', 'Books lock date',
      jsonb_build_object('event', 'changed', 'changed', jsonb_build_object('lock_date', jsonb_build_object('from', lock1, 'to', kl)))),
    jsonb_build_array('Changed the books lock date', 'Books lock date',
      jsonb_build_object('event', 'changed', 'changed', jsonb_build_object('lock_date', jsonb_build_object('from', kl, 'to', null)))),
    jsonb_build_array('Changed the books lock date', 'Books lock date',
      jsonb_build_object('event', 'changed', 'changed', jsonb_build_object('lock_date', jsonb_build_object('from', null, 'to', lock1)))),
    jsonb_build_array('Changed the financial year end', 'Financial year end', '{"event":"changed","changed":{"year_end_month":{"from":6,"to":3}}}'::jsonb));
  for r in
    select 'expected, not logged' as side, w from (
      select format('%s|%s|%s', e->>0, e->>1, e->2) as w from jsonb_array_elements(expected) e
      except all
      select format('%s|%s|%s', a.action, a.target, a.details) from public.activity_log a
       where a.org_id = org and a.entity_type = 'finance_settings') d
    union all
    select 'logged, not expected', w from (
      select format('%s|%s|%s', a.action, a.target, a.details) as w from public.activity_log a
       where a.org_id = org and a.entity_type = 'finance_settings'
      except all
      select format('%s|%s|%s', e->>0, e->>1, e->2) from jsonb_array_elements(expected) e) d
  loop
    fails := fails || format('settings log: %s: %s', r.side, r.w);
  end loop;
  select count(*) into n from public.activity_log a
   where a.org_id = org and a.entity_type = 'finance_settings'
     and (a.actor_id is distinct from owner_id or a.category <> 'data' or a.audience <> 'members' or a.entity_id is not null);
  if n <> 0 then fails := fails || format('settings log: %s rows with the wrong actor, category, audience or id', n); end if;

  -- ==== the lock at today's UTC date: the ledger dates a void's reversal by UTC ===================================
  -- (After the log comparison: this change of lock date is logged but not in the list above.)
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  -- The lock date in the message has no leading zero: 5 Dec 1999.
  update public.finance_settings set lock_date = '1999-12-05' where org_id = org;
  inv_d := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', '1999-12-01', 'due_date', '1999-12-31'), one_line);
  begin
    perform public.finance_post_invoice(org, inv_d);
    fails := fails || 'a single-digit lock date: the invoice was posted'::text;
  exception when others then
    if sqlstate <> 'FIN63' or sqlerrm <> 'This date is in a closed period: the books are locked to 5 Dec 1999.' then
      fails := fails || format('a single-digit lock date: %s %s', sqlstate, sqlerrm);
    end if;
  end;
  update public.finance_settings set lock_date = (now() at time zone 'UTC')::date where org_id = org;
  fails := fails || public.bendahara_check_try('lock at today (UTC): void of a later invoice', 'FIN63',
    format('update public.finance_invoices set status = %L, updated_at = now() where id = %L', 'void', inv_future));
  reset role;

  -- ==== a person who posted inside the locked period is deleted ==================================================
  -- The admin posted the revaluation at 2000-01-31; lock the books past it, then delete the admin: the foreign keys
  -- clear posted_by (an update of a row in the locked period that is not a ledger effect).
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  update public.finance_settings set lock_date = '2000-01-31' where org_id = org;
  reset role;
  begin
    delete from auth.users where id = admin_id;
    if exists (select 1 from public.finance_fx_revaluations where org_id = org and posted_by is not null and period_end = '2000-01-31') then
      fails := fails || 'user delete: the revaluation still names the deleted admin'::text;
    end if;
  exception when others then
    fails := fails || format('user delete: deleting a person who posted in the locked period: %s %s', sqlstate, sqlerrm);
  end;

  -- ==== org delete: a workspace with a lock and posted rows goes ================================================
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  for r in select unnest(array[del_a, del_b]) as o loop
    insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (r.o, 'Both Ways', true, true) returning id into cust;
    inv_d := public.finance_save_invoice(r.o, jsonb_build_object('customer_id', cust, 'invoice_date', old_d, 'due_date', old_d + 30), one_line);
    perform public.finance_post_invoice(r.o, inv_d);
    b_d := public.finance_save_bill(r.o, jsonb_build_object('supplier_id', cust, 'bill_date', old_d, 'due_date', old_d + 30), one_line);
    perform public.finance_post_bill(r.o, b_d);
    select id into bank from public.finance_accounts where org_id = r.o and kind = 'bank' order by created_at limit 1;
    perform public.finance_record_payment_in(r.o, jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', old_d),
      jsonb_build_array(jsonb_build_object('invoice_id', inv_d, 'amount', 10)));
    insert into public.finance_accounts (org_id, name, kind, opening_balance, opening_date) values (r.o, 'Old', 'bank', 50, old_d);
    select id into rent from public.finance_ledger_accounts where org_id = r.o and code = '6000';
    select id into equity from public.finance_ledger_accounts where org_id = r.o and code = '3000';
    j_d := public.finance_save_journal(r.o, jsonb_build_object('journal_date', old_d, 'description', 'Posted'),
      jsonb_build_array(jsonb_build_object('account_id', rent, 'debit', 1), jsonb_build_object('account_id', equity, 'credit', 1)));
    perform public.finance_post_journal(r.o, j_d);
    insert into public.finance_settings (org_id, lock_date) values (r.o, lock1);
  end loop;
  reset role;
  begin
    delete from public.orgs where id = del_a;
    get diagnostics n = row_count;
    if n <> 1 then fails := fails || format('org delete: %s workspaces deleted, not 1', n); end if;
    select (select count(*) from public.finance_settings where org_id = del_a)
         + (select count(*) from public.finance_invoices where org_id = del_a)
         + (select count(*) from public.supplier_bills where org_id = del_a)
         + (select count(*) from public.finance_transactions where org_id = del_a)
         + (select count(*) from public.finance_journals where org_id = del_a)
         + (select count(*) from public.finance_accounts where org_id = del_a) into n;
    if n <> 0 then fails := fails || format('org delete: %s rows outlive the deleted workspace', n); end if;
  exception when others then
    fails := fails || format('org delete: deleting a locked workspace with its owner signed in: %s %s', sqlstate, sqlerrm);
  end;
  begin
    set local role service_role;
    if not public.delete_test_org(del_b) then fails := fails || 'org delete: delete_test_org did not delete the workspace'::text; end if;
    reset role;
    if exists (select 1 from public.finance_settings where org_id = del_b) then
      fails := fails || 'org delete: the settings outlive the workspace delete_test_org deleted'::text;
    end if;
  exception when others then
    reset role;
    fails := fails || format('org delete: delete_test_org: %s %s', sqlstate, sqlerrm);
  end;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_ACCOUNTING_SETTINGS_CHECK PASSED (everything rolled back; % settings log rows checked)', jsonb_array_length(expected);
  end if;
  raise exception 'BENDAHARA_ACCOUNTING_SETTINGS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
