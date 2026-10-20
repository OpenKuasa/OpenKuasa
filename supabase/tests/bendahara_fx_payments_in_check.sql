-- Bendahara foreign payments-in check (stage 3b). Run it after
-- 20261120110000_bendahara_fx_payments_in.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper function
-- below are rolled back. Read the message:
--   BENDAHARA_FX_PAYMENTS_IN_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member, viewer and an outsider the way the
-- app does (the authenticated role with that person's id in
-- request.jwt.claims). Every rate is typed by hand with its source, so no BNM
-- row is needed. The worked examples are the plan's
-- (.superpowers/sdd/2026-10-16-bendahara-fx-sales.md, "Worked examples" B, B1,
-- B2), to the sen.
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
  cust uuid;
  bank uuid;
  i_a uuid;
  i_b uuid;
  i_jpy uuid;
  i_idr uuid;
  i_u uuid;
  i_s uuid;
  i_myr uuid;
  i1 uuid;
  i2 uuid;
  i3 uuid;
  ids uuid[];
  p1 uuid;
  p2 uuid;
  p3 uuid;
  draft_in uuid;
  rc uuid;
  new_org uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  usd_line jsonb := '[{"description":"Consulting","quantity":1,"unit_price":1000,"sst_rate":8}]';
  hundred jsonb := '[{"description":"Support","quantity":1,"unit_price":100,"sst_rate":0}]';
  myr_line jsonb := '[{"description":"Parts","quantity":10,"unit_price":12.50,"sst_rate":6}]';
  usd_at_4_2 jsonb := '{"currency":"USD","fx_rate":"4.2","fx_rate_source":"manual","fx_rate_provider":"reuters"}';
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
  execute 'grant execute on function public.bendahara_check_try(text, text, text) to authenticated, anon';
  -- One payment's ledger entry (not its reversal), by account: bank, receivable, realised.
  execute $f$
    create function public.bendahara_check_entry(target uuid, suffix text default '')
    returns table (bank_dr numeric, bank_cr numeric, rec_dr numeric, rec_cr numeric, fx_dr numeric, fx_cr numeric,
                   dr numeric, cr numeric)
    language sql security invoker set search_path = '' as $g$
      select
        coalesce(sum(l.debit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'receivable'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'receivable'), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.source_id = target and l.entry_key = l.source || ':' || target || suffix
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_entry(uuid, text) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal and tgenabled = 'O';
  if t !~ 'finance_transaction_still,finance_transaction_to_currency,finance_transaction_to_ringgit,finance_transaction_unmatch,finance_transfer_id_guard' then
    fails := fails || format('triggers on finance_transactions are: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname in ('finance_fx_carried', 'finance_fx_settle', 'finance_transaction_ringgit_guard')
     and not p.prosecdef;
  if n <> 3 then fails := fails || format('%s of the three new functions run as their caller', n); end if;

  -- ---- workspaces, people ------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@fxpin.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'FX Payments Check Sdn Bhd'), (other_org, 'FX Payments Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select count(*) into n from public.finance_ledger_accounts where org_id = org and system_key = 'fx_realised' and type = 'income';
  if n <> 1 then fails := fails || format('a new workspace has %s Realised Exchange Gain or Loss accounts', n); end if;

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Overseas Ltd', true, true) returning id into cust;

  -- ==== B: USD 1,080.00 at 4.2 (Dr Receivable 4,536.00), paid in two parts ========
  i_a := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10') || usd_at_4_2, usd_line);
  perform public.finance_post_invoice(org, i_a);
  -- Payment 1: USD 400.00 settled, RM 1,658.00 arrived. carried round(400 x 4.2) = 1,680.00; realised -22.00.
  fails := fails || public.bendahara_check_try('B1: USD 400.00 received as RM 1,658.00', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '1658', 'notes', 'B payment 1'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_a, 'amount', 400))));
  select id into p1 from public.finance_transactions where org_id = org and notes = 'B payment 1';
  if p1 is null then
    fails := array_remove(fails, null);
    raise exception 'BENDAHARA_FX_PAYMENTS_IN_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  select t.amount, t.status, a.amount as part, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = p1;
  if r.amount <> 1658.00 or r.status <> 'posted' or r.part <> 400.00 or r.amount_myr <> 1658.00 or r.carried_myr <> 1680.00 then
    fails := fails || format('B payment 1 is RM %s (%s), USD %s, amount_myr %s, carried %s', r.amount, r.status, r.part, r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_entry(p1);
  if r.bank_dr <> 1658.00 or r.fx_dr <> 22.00 or r.rec_cr <> 1680.00 or r.dr <> r.cr or r.fx_cr <> 0 or r.rec_dr <> 0 then
    fails := fails || format('B payment 1 posts Dr Bank %s, Dr Realised %s, Cr Receivable %s (Dr %s, Cr %s)', r.bank_dr, r.fx_dr, r.rec_cr, r.dr, r.cr);
  end if;
  select currency, amount, amount_myr, carried_myr, realised_myr, transaction_amount into r
    from public.finance_payments_in where transaction_id = p1;
  if r.currency <> 'USD' or r.amount <> 400.00 or r.amount_myr <> 1658.00 or r.carried_myr <> 1680.00
     or r.realised_myr <> -22.00 or r.transaction_amount <> 1658.00 then
    fails := fails || format('Payments In reads B payment 1 as %s %s, RM %s carried %s realised %s', r.currency, r.amount, r.amount_myr, r.carried_myr, r.realised_myr);
  end if;
  select balance, balance_myr, paid, paid_myr into r from public.finance_invoice_totals where id = i_a;
  if r.balance <> 680.00 or r.balance_myr <> 2856.00 or r.paid <> 400.00 or r.paid_myr <> 1680.00 then
    fails := fails || format('after payment 1 the invoice reads USD %s / RM %s open, paid %s / RM %s', r.balance, r.balance_myr, r.paid, r.paid_myr);
  end if;
  -- Payment 2: USD 680.00 settled, RM 2,883.50 arrived. Closing: carried = balance_myr 2,856.00; realised +27.50.
  fails := fails || public.bendahara_check_try('B2: USD 680.00 received as RM 2,883.50', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-20', 'amount_myr', '2883.50', 'notes', 'B payment 2'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_a, 'amount', 680))));
  select id into p2 from public.finance_transactions where org_id = org and notes = 'B payment 2';
  select * into r from public.bendahara_check_entry(p2);
  if r.bank_dr <> 2883.50 or r.rec_cr <> 2856.00 or r.fx_cr <> 27.50 or r.fx_dr <> 0 or r.dr <> r.cr then
    fails := fails || format('B payment 2 posts Dr Bank %s, Cr Receivable %s, Cr Realised %s (Dr %s, Cr %s)', r.bank_dr, r.rec_cr, r.fx_cr, r.dr, r.cr);
  end if;
  select currency, amount_myr, carried_myr, realised_myr into r from public.finance_cash_receipts where transaction_id = p2;
  if r.currency <> 'USD' or r.amount_myr <> 2883.50 or r.carried_myr <> 2856.00 or r.realised_myr <> 27.50 then
    fails := fails || format('Cash Receipts reads B payment 2 as %s, RM %s carried %s realised %s', r.currency, r.amount_myr, r.carried_myr, r.realised_myr);
  end if;
  select balance, balance_myr, paid_myr, display_status into r from public.finance_invoice_totals where id = i_a;
  if r.balance <> 0 or r.balance_myr <> 0 or r.paid_myr <> 4536.00 or r.display_status <> 'paid' then
    fails := fails || format('the paid invoice reads USD %s / RM %s open, paid RM %s, %s', r.balance, r.balance_myr, r.paid_myr, r.display_status);
  end if;
  -- Receivable over the invoice and both payments: 0.00. Realised: a net credit (gain) of 5.50.
  select coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'receivable'), 0) as rec,
         coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'fx_realised'), 0) as fx
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and l.source_id in (i_a, p1, p2);
  if r.rec <> 0 or r.fx <> 5.50 then
    fails := fails || format('example B leaves Receivable at %s and Realised at a net credit of %s', r.rec, r.fx);
  end if;

  -- ==== a member records a payment: the sign-off; a viewer: not allowed ===========
  i_u := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10') || usd_at_4_2, hundred);
  perform public.finance_post_invoice(org, i_u);
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('a member records a payment on a USD invoice', 'FIN14',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '400'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10))));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('a viewer records a payment on a USD invoice', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '400'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10))));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_check_try('an outsider records a payment on a USD invoice', '42501',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '400'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10))));
  select count(*) into n from public.finance_payments_in where invoice_id = i_u;
  if n <> 0 then fails := fails || format('an outsider reads %s payments of the workspace', n); end if;
  perform set_config('request.jwt.claims', owner_claims, true);

  -- ==== void payment 2: USD 680.00 / RM 2,856.00 open again ======================
  fails := fails || public.bendahara_check_try('payment 2 is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', p2));
  select * into r from public.bendahara_check_entry(p2, ':void');
  if r.rec_dr <> 2856.00 or r.fx_dr <> 27.50 or r.bank_cr <> 2883.50 or r.dr <> r.cr then
    fails := fails || format('the void of payment 2 posts Dr Receivable %s, Dr Realised %s, Cr Bank %s', r.rec_dr, r.fx_dr, r.bank_cr);
  end if;
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_a;
  if r.balance <> 680.00 or r.balance_myr <> 2856.00 then
    fails := fails || format('after the void the invoice reads USD %s / RM %s open, not 680.00 / 2856.00', r.balance, r.balance_myr);
  end if;

  -- ==== B1: three lines of USD 33.33 at 4.2555, RM 425.52; the closing sen ========
  i_b := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'USD', 'fx_rate', '4.2555', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'),
    '[{"description":"a","quantity":1,"unit_price":33.33,"sst_rate":0},
      {"description":"b","quantity":1,"unit_price":33.33,"sst_rate":0},
      {"description":"c","quantity":1,"unit_price":33.33,"sst_rate":0}]'::jsonb);
  perform public.finance_post_invoice(org, i_b);
  select total_myr into r from public.finance_invoice_totals where id = i_b;
  if r.total_myr <> 425.52 then fails := fails || format('B1: the invoice is RM %s, not 425.52', r.total_myr); end if;
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '212', 'notes', 'B1 payment 1'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_b, 'amount', 50)));
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-13', 'amount_myr', '213', 'notes', 'B1 payment 2'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_b, 'amount', 49.99)));
  select string_agg(a.carried_myr || '/' || (a.amount_myr - a.carried_myr), ' ' order by t.txn_date) into t
    from public.finance_allocations a join public.finance_transactions t on t.id = a.transaction_id where a.invoice_id = i_b;
  if t is distinct from '212.78/-0.78 212.74/0.26' then
    fails := fails || format('B1: carried/realised are %s, not 212.78/-0.78 212.74/0.26', t);
  end if;
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_b;
  if r.balance <> 0 or r.balance_myr <> 0 then
    fails := fails || format('B1: the paid invoice leaves USD %s / RM %s open', r.balance, r.balance_myr);
  end if;

  -- ==== B2: RM 1,000.00 for USD 100.00 on each of three invoices ===================
  i1 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10') || usd_at_4_2, hundred);
  i2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10') || usd_at_4_2, hundred);
  i3 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10') || usd_at_4_2, hundred);
  perform public.finance_post_invoice(org, i1);
  perform public.finance_post_invoice(org, i2);
  perform public.finance_post_invoice(org, i3);
  ids := array(select u from unnest(array[i1, i2, i3]) u order by u);
  p3 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-14', 'amount_myr', '1000', 'notes', 'B2'),
    jsonb_build_array(jsonb_build_object('invoice_id', i1, 'amount', 100), jsonb_build_object('invoice_id', i2, 'amount', 100),
                      jsonb_build_object('invoice_id', i3, 'amount', 100)));
  select string_agg(a.amount_myr || '/' || a.carried_myr, ' ' order by a.invoice_id), sum(a.amount_myr) into r
    from public.finance_allocations a where a.transaction_id = p3;
  if r.string_agg is distinct from '333.34/420.00 333.33/420.00 333.33/420.00' or r.sum <> 1000.00 then
    fails := fails || format('B2: the shares (lowest id first) are %s, adding to %s', r.string_agg, r.sum);
  end if;
  select * into r from public.bendahara_check_entry(p3);
  if r.bank_dr <> 1000.00 or r.fx_dr <> 260.00 or r.rec_cr <> 1260.00 or r.dr <> r.cr then
    fails := fails || format('B2 posts Dr Bank %s, Dr Realised %s, Cr Receivable %s', r.bank_dr, r.fx_dr, r.rec_cr);
  end if;

  -- ==== JPY 100,000 at 0.029 (RM 2,900.00) paid RM 2,880.00: not FIN03 ===========
  i_jpy := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'JPY', 'fx_rate', '0.029', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'),
    '[{"description":"Licence","quantity":1,"unit_price":100000,"sst_rate":0}]'::jsonb);
  perform public.finance_post_invoice(org, i_jpy);
  fails := fails || public.bendahara_check_try('JPY 100,000 received as RM 2,880.00 (split above the ringgit)', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '2880', 'notes', 'JPY'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_jpy, 'amount', 100000))));
  select a.amount_myr, a.carried_myr into r from public.finance_allocations a where a.invoice_id = i_jpy;
  if r.amount_myr is distinct from 2880.00 or r.carried_myr is distinct from 2900.00 then
    fails := fails || format('JPY: amount_myr %s, carried %s, not 2880.00 / 2900.00', r.amount_myr, r.carried_myr);
  end if;

  -- ==== the cap: lines that each round down; a part never carries more than is open ==
  -- IDR at 0.00028: two lines of IDR 1,000,015.00 are RM 280.0042 each, so RM 280.00 + 280.00 = 560.00 (the
  -- foreign total at the rate is 560.0084). IDR 2,000,029.00 (not closing) is round(560.00812) = 560.01 at the
  -- rate, more than the 560.00 open: it carries 560.00. The last IDR 1.00 closes and carries the 0.00 left.
  -- Without the cap: 560.01, then |-0.01| = 0.01, and Receivable is left at -0.02 for ever.
  i_idr := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'IDR', 'fx_rate', '0.00028', 'fx_rate_source', 'manual', 'fx_rate_provider', 'oanda'),
    '[{"description":"a","quantity":1,"unit_price":1000015,"sst_rate":0},
      {"description":"b","quantity":1,"unit_price":1000015,"sst_rate":0}]'::jsonb);
  perform public.finance_post_invoice(org, i_idr);
  select total_myr into r from public.finance_invoice_totals where id = i_idr;
  if r.total_myr <> 560.00 then fails := fails || format('IDR cap: the invoice is RM %s, not 560.00', r.total_myr); end if;
  -- Through the try, so a refusal is reported by name (the split is above the ringgit: FIN03 must not answer).
  fails := fails || public.bendahara_check_try('IDR cap: IDR 2,000,029.00 received as RM 560.00', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '560'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_idr, 'amount', 2000029))));
  fails := fails || public.bendahara_check_try('IDR cap: the last IDR 1.00 received as RM 0.01', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-13', 'amount_myr', '0.01'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_idr, 'amount', 1))));
  select string_agg(a.carried_myr::text, ' ' order by t.txn_date) into t
    from public.finance_allocations a join public.finance_transactions t on t.id = a.transaction_id where a.invoice_id = i_idr;
  if t is distinct from '560.00 0.00' then
    fails := fails || format('IDR cap: carried %s, not 560.00 0.00', t);
  end if;
  select (select coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'receivable'), 0)
            from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
           where l.org_id = org and (l.source_id = i_idr or l.source_id in (
             select x.transaction_id from public.finance_allocations x where x.invoice_id = i_idr))) as rec,
         (select balance_myr from public.finance_invoice_totals where id = i_idr) as open_myr
    into r;
  if r.rec <> 0 or r.open_myr <> 0 then
    fails := fails || format('IDR cap: Receivable ends at %s (balance_myr %s), not 0.00', r.rec, r.open_myr);
  end if;

  -- ==== refusals ====================================================================
  i_s := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', '1999-01-10', 'due_date', '1999-02-10',
      'currency', 'SGD', 'fx_rate', '3.2', 'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'), hundred);
  perform public.finance_post_invoice(org, i_s);
  select count(*) into n from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('FIN44: USD and SGD invoices on one payment', 'FIN44',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '500'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10), jsonb_build_object('invoice_id', i_s, 'amount', 10))));
  fails := fails || public.bendahara_check_try('FIN46: no ringgit received', 'FIN46',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10))));
  fails := fails || public.bendahara_check_try('FIN46: RM 0.00 received', 'FIN46',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '0.004'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10))));
  fails := fails || public.bendahara_check_try('FIN46: NaN received', 'FIN46',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', 'NaN'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10))));
  select n - count(*) into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('refused payments left %s transactions', -n); end if;
  -- 3c lifted FIN41: a refund on a USD invoice needs the ringgit paid out (FIN46), and a credit note on one is
  -- saved (deleted again here). bendahara_fx_credit_notes_refunds_check.sql has the rest.
  fails := fails || public.bendahara_check_try('a refund on a USD invoice, no ringgit paid out', 'FIN46',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', i_a, 'account_id', bank, 'method', 'fpx', 'reason', 'overpayment', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a credit note on a USD invoice', 'ok',
    format('select public.finance_save_credit_note(%L, %L)', org,
      jsonb_build_object('invoice_id', i_u, 'reason', 'returns', 'amount', 10)));
  delete from public.finance_credit_notes where invoice_id = i_u and status = 'draft';

  -- A draft written by hand with a USD split: not posted unsettled, its ringgit columns not writable.
  insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, contact_id, status)
  values (org, 'in', bank, '1999-01-15', 50, 'fpx', cust, 'draft') returning id into draft_in;
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (org, draft_in, i_u, 10);
  fails := fails || public.bendahara_check_try('FIN46: a USD split posted by hand', 'FIN46',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', draft_in));
  fails := fails || public.bendahara_check_try('FIN46: a USD split moved to scheduled by hand', 'FIN46',
    format('update public.finance_transactions set status = %L where id = %L', 'scheduled', draft_in));
  fails := fails || public.bendahara_check_try('a signed-in person writes amount_myr', '42501',
    format('update public.finance_allocations set amount_myr = 50, carried_myr = 42 where transaction_id = %L', draft_in));
  fails := fails || public.bendahara_check_try('a signed-in person inserts carried_myr', '42501',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount, amount_myr, carried_myr) values (%L, %L, %L, 1, 1, 1)',
      org, draft_in, i_s));
  fails := fails || public.bendahara_check_try('FIN44: an SGD row added to a USD draft by hand', 'FIN44',
    format('insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount) values (%L, %L, %L, 1)', org, draft_in, i_s));
  fails := fails || public.bendahara_check_try('a signed-in person still writes amount', 'ok',
    format('update public.finance_allocations set amount = 11 where transaction_id = %L', draft_in));
  delete from public.finance_transactions where id = draft_in;

  -- FIN45: a cash receipt naming a USD invoice is saved (a direct call) but not posted.
  rc := public.finance_save_cash_receipt(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-16'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_u, 'amount', 10)));
  fails := fails || public.bendahara_check_try('FIN45: a cash receipt for a USD invoice is posted', 'FIN45',
    format('select public.finance_post_cash_receipt(%L, %L)', org, rc));
  select currency, carried_myr, realised_myr into r from public.finance_cash_receipts where transaction_id = rc;
  if r.currency <> 'USD' or r.carried_myr is not null or r.realised_myr is not null then
    fails := fails || format('an unsettled USD draft receipt reads %s, carried %s, realised %s', r.currency, r.carried_myr, r.realised_myr);
  end if;
  delete from public.finance_transactions where id = rc;

  -- ==== a ringgit payment is what it always was ====================================
  i_myr := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), myr_line);
  perform public.finance_post_invoice(org, i_myr);
  -- amount_myr sent for a ringgit split is ignored: the payment is its split.
  p1 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'amount_myr', '999'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 132.50)));
  select t.amount, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = p1;
  if r.amount <> 132.50 or r.amount_myr is not null or r.carried_myr is not null then
    fails := fails || format('a ringgit payment is RM %s with ringgit figures %s / %s', r.amount, r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_entry(p1);
  if r.bank_dr <> 132.50 or r.rec_cr <> 132.50 or r.fx_dr <> 0 or r.fx_cr <> 0 or r.dr <> 132.50 or r.cr <> 132.50 then
    fails := fails || format('a ringgit payment posts Dr Bank %s, Cr Receivable %s, Realised %s/%s', r.bank_dr, r.rec_cr, r.fx_dr, r.fx_cr);
  end if;
  select count(*) into n from public.finance_ledger_lines where source_id = p1;
  if n <> 2 then fails := fails || format('a ringgit payment has %s ledger lines, not 2', n); end if;
  select balance, balance_myr, paid, paid_myr into r from public.finance_invoice_totals where id = i_myr;
  if r.balance <> 0 or r.balance_myr <> 0 or r.paid_myr <> r.paid then
    fails := fails || format('the paid ringgit invoice reads %s / %s, paid %s / %s', r.balance, r.balance_myr, r.paid, r.paid_myr);
  end if;
  select currency, amount_myr, carried_myr, realised_myr into r from public.finance_payments_in where transaction_id = p1;
  if r.currency <> 'MYR' or r.amount_myr <> 132.50 or r.carried_myr <> 132.50 or r.realised_myr <> 0 then
    fails := fails || format('Payments In reads the ringgit payment as %s RM %s / %s / %s', r.currency, r.amount_myr, r.carried_myr, r.realised_myr);
  end if;

  -- The whole workspace balances, every line of it.
  select sum(debit) as dr, sum(credit) as cr into r from public.finance_ledger_lines where org_id = org;
  if r.dr <> r.cr then fails := fails || format('the workspace''s ledger does not balance: Dr %s, Cr %s', r.dr, r.cr); end if;

  -- ==== a workspace made by a person gets the account ================================
  fails := fails || public.bendahara_check_try('the owner makes a workspace', 'ok',
    'select public.create_org_for_current_user(''FX New Workspace Check'')');
  select o.id into new_org from public.orgs o join public.org_members m on m.org_id = o.id
   where o.name = 'FX New Workspace Check' and m.user_id = owner_id;
  select count(*) into n from public.finance_ledger_accounts where org_id = new_org and system_key = 'fx_realised' and type = 'income';
  if n <> 1 then fails := fails || format('a workspace made by a person has %s Realised accounts', n); end if;

  -- ==== the workspaces are deleted ===================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  delete from public.orgs where id in (org, other_org, new_org);
  select count(*) into n from public.finance_allocations where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s allocations', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_PAYMENTS_IN_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_PAYMENTS_IN_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
