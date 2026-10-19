-- Bendahara foreign payments-out check (stage 4b). Run it after
-- 20261121111000_bendahara_fx_payments_out.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way:
-- the block always ends with RAISE, so every row and the helper functions
-- below are rolled back. Read the message:
--   BENDAHARA_FX_PAYMENTS_OUT_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member and viewer the way the app does (the
-- authenticated role with that person's id in request.jwt.claims). Every rate
-- is typed by hand with its source, so no BNM row is needed, and every bill is
-- dated 1999-01-10. The worked examples are the plan's
-- (.superpowers/sdd/2026-10-19-bendahara-fx-purchases.md, "Worked examples"
-- B4, B4.1, B4.2, C4, E4), to the sen, through the real functions. Cases are
-- numbered as in the plan's Task 4b.2.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  viewer_claims text;
  sup uuid;
  bank uuid;
  rent uuid;
  b4 uuid;
  b41 uuid;
  x uuid[];
  b_two uuid[];
  b_idr uuid;
  b_jpy uuid;
  b_usd uuid;
  b_sgd uuid;
  b_myr uuid;
  b_hand uuid;
  b_lo uuid;
  b_hi uuid;
  p1 uuid;
  p2 uuid;
  p3 uuid;
  tx uuid;
  ex uuid;
  v_exp uuid;
  v_cat uuid;
  n integer;
  n0 integer;
  t text;
  r record;
  fails text[] := '{}';
  usd_a4 jsonb := '[{"description":"Machine","quantity":1,"unit_price":1000,"sst_rate":8}]';
  usd_b41 jsonb := '[{"description":"Part A","quantity":1,"unit_price":33.33,"sst_rate":0},
                     {"description":"Part B","quantity":1,"unit_price":33.33,"sst_rate":0},
                     {"description":"Part C","quantity":1,"unit_price":33.33,"sst_rate":0}]';
  hundred jsonb := '[{"description":"Support","quantity":1,"unit_price":100,"sst_rate":0}]';
  three_hundred jsonb := '[{"description":"Support","quantity":1,"unit_price":300,"sst_rate":0}]';
  idr_lines jsonb := '[{"description":"Batik","quantity":1,"unit_price":1000015,"sst_rate":0},
                       {"description":"Songket","quantity":1,"unit_price":1000015,"sst_rate":0}]';
  jpy_line jsonb := '[{"description":"Tools","quantity":1,"unit_price":100000,"sst_rate":0}]';
  myr_line jsonb := '[{"description":"Stock","quantity":10,"unit_price":12.50,"sst_rate":6}]';
  dated jsonb := '{"bill_date":"1999-01-10","due_date":"1999-02-10"}';
  typed jsonb := '{"fx_rate_source":"manual","fx_rate_provider":"reuters"}';
  paid_now jsonb;
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
  -- A payment out through the real function, as the caller: its id, or why it was refused (so a refusal is named
  -- among the failures instead of stopping the check).
  execute $f$
    create function public.bendahara_check_pay(target_org uuid, payment jsonb, allocations jsonb, out id uuid, out err text)
    language plpgsql security invoker set search_path = '' as $g$
    begin
      id := public.finance_record_payment_out(target_org, payment, allocations);
    exception when others then
      err := sqlstate || ' ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_pay(uuid, jsonb, jsonb) to authenticated';
  -- One payment's ledger entry (or, with ':void', its reversal), by account: bank, payable, realised.
  execute $f$
    create function public.bendahara_check_entry(target uuid, suffix text default '')
    returns table (bank_dr numeric, bank_cr numeric, pay_dr numeric, pay_cr numeric, fx_dr numeric, fx_cr numeric,
                   dr numeric, cr numeric, lines bigint)
    language sql security invoker set search_path = '' as $g$
      select
        coalesce(sum(l.debit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'payable'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'payable'), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0), count(*)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.source_id = target and l.entry_key = l.source || ':' || target || suffix
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_entry(uuid, text) to authenticated';
  -- Accounts Payable for some documents and payments: credits less debits (what is still owed on them).
  execute $f$
    create function public.bendahara_check_payable(target_org uuid, ids uuid[]) returns numeric
    language sql security invoker set search_path = '' as $g$
      select coalesce(sum(l.credit - l.debit), 0)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = target_org and a.system_key = 'payable' and l.source_id = any(ids)
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_payable(uuid, uuid[]) to authenticated';
  -- 18: the workspace's trial balance balances (debits = credits, every entry and in all).
  execute $f$
    create function public.bendahara_check_tb(target_org uuid, label text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare d numeric; c numeric; bad integer;
    begin
      select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into d, c from public.finance_ledger_lines where org_id = target_org;
      select count(*) into bad from (
        select entry_key from public.finance_ledger_lines where org_id = target_org
        group by entry_key having sum(debit) <> sum(credit)) e;
      if d = c and bad = 0 then return null; end if;
      return format('18 (%s): the trial balance is Dr %s, Cr %s, %s entries unbalanced', label, d, c, bad);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_tb(uuid, text) to authenticated';

  -- ---- workspace, people ----------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@fxpout.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'FX Payments Out Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;
  select id into rent from public.finance_categories where org_id = org and kind = 'expense' order by name limit 1;
  paid_now := jsonb_build_object('account_id', bank, 'method', 'bank_transfer', 'txn_date', '1999-01-20');

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Overseas Supplier Ltd', true) returning id into sup;

  -- ==== 1, 2: worked example B4: USD 1,080.00 at 4.2 (Cr Payable 4,536.00), paid in two parts =====
  b4 := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_a4);
  perform public.finance_post_bill(org, b4);
  -- Payment 1: USD 400.00 settled, RM 1,700.00 paid out. carried round(400 x 4.2) = 1,680.00; realised -20.00.
  fails := fails || public.bendahara_check_try('1: B4 USD 400.00 paid with RM 1,700.00', 'ok',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      paid_now || jsonb_build_object('amount_myr', '1700', 'notes', 'B4 payment 1'),
      jsonb_build_array(jsonb_build_object('bill_id', b4, 'amount', 400))));
  select id into p1 from public.finance_transactions where org_id = org and notes = 'B4 payment 1';
  if p1 is null then
    -- Nothing below can run without it.
    fails := array_remove(fails, null);
    raise exception 'BENDAHARA_FX_PAYMENTS_OUT_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  select t.amount, t.status, t.number, t.approved_at, a.amount as part, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = p1;
  if r.amount is distinct from 1700.00 or r.status is distinct from 'posted' or r.number is null or r.part is distinct from 400.00
     or r.amount_myr is distinct from 1700.00 or r.carried_myr is distinct from 1680.00 then
    fails := fails || format('1: B4 payment 1 is RM %s (%s, %s), USD %s, amount_myr %s, carried %s',
      r.amount, r.status, r.number, r.part, r.amount_myr, r.carried_myr);
  end if;
  -- Paid with what the bill carried less: not money out that settles no document, so nobody is stamped as approving it.
  if r.approved_at is not null then fails := fails || '1: B4 payment 1 was stamped as approved'::text; end if;
  select * into r from public.bendahara_check_entry(p1);
  if r.pay_dr is distinct from 1680.00 or r.fx_dr is distinct from 20.00 or r.fx_cr is distinct from 0 or r.bank_cr is distinct from 1700.00
     or r.dr is distinct from r.cr or r.lines is distinct from 3 then
    fails := fails || format('1: B4 payment 1 posts Dr Payable %s, Dr realised %s, Cr realised %s, Cr Bank %s (Dr %s, Cr %s, %s lines)',
      r.pay_dr, r.fx_dr, r.fx_cr, r.bank_cr, r.dr, r.cr, r.lines);
  end if;
  select balance, balance_myr into r from public.supplier_bill_totals where id = b4;
  if r.balance is distinct from 680.00 or r.balance_myr is distinct from 2856.00 then
    fails := fails || format('1: after payment 1 the bill owes %s / RM %s, not 680.00 / RM 2,856.00', r.balance, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B4 payment 1');
  -- Payment 2: USD 680.00 settled, RM 2,800.00 paid out. It clears the bill: carried the RM 2,856.00 still open; realised +56.00.
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '2800'),
    jsonb_build_array(jsonb_build_object('bill_id', b4, 'amount', 680)));
  p2 := r.id;
  if r.err is not null then fails := fails || format('2: B4 payment 2 refused: %s', r.err); end if;
  select a.amount_myr, a.carried_myr into r from public.finance_allocations a where a.transaction_id = p2;
  if r.amount_myr is distinct from 2800.00 or r.carried_myr is distinct from 2856.00 then
    fails := fails || format('2: B4 payment 2 amount_myr %s, carried %s (not 2,800.00, 2,856.00)', r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_entry(p2);
  if r.pay_dr is distinct from 2856.00 or r.fx_dr is distinct from 0 or r.fx_cr is distinct from 56.00 or r.bank_cr is distinct from 2800.00
     or r.dr is distinct from r.cr or r.lines is distinct from 3 then
    fails := fails || format('2: B4 payment 2 posts Dr Payable %s, Dr realised %s, Cr realised %s, Cr Bank %s (Dr %s, Cr %s, %s lines)',
      r.pay_dr, r.fx_dr, r.fx_cr, r.bank_cr, r.dr, r.cr, r.lines);
  end if;
  if public.bendahara_check_payable(org, array[b4, p1, p2]) is distinct from 0.00 then
    fails := fails || format('2: B4 leaves %s on Payable', public.bendahara_check_payable(org, array[b4, p1, p2]));
  end if;
  select paid, paid_myr, balance, balance_myr, display_status into r from public.supplier_bill_totals where id = b4;
  if r.paid is distinct from 1080.00 or r.paid_myr is distinct from 4536.00 or r.balance is distinct from 0.00
     or r.balance_myr is distinct from 0.00 or r.display_status is distinct from 'paid' then
    fails := fails || format('2: the bill reads paid %s / RM %s, balance %s / RM %s, %s', r.paid, r.paid_myr, r.balance, r.balance_myr, r.display_status);
  end if;
  select string_agg(amount || ' ' || amount_myr || ' ' || carried_myr || ' ' || realised_myr || ' ' || currency, '; ' order by amount) into t
    from public.finance_payments_out where bill_id = b4;
  if t is distinct from '400.00 1700.00 1680.00 -20.00 USD; 680.00 2800.00 2856.00 56.00 USD' then
    fails := fails || format('2: finance_payments_out reads %s', t);
  end if;
  -- Realised across the two: a net credit of 36.00 (a gain).
  select coalesce(sum(l.credit - l.debit), 0)::text into t from public.finance_ledger_lines l
    join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.org_id = org and a.system_key = 'fx_realised' and l.source_id in (p1, p2);
  if t is distinct from '36.00' then fails := fails || format('2: B4 realised a net credit of %s, not 36.00', t); end if;
  fails := fails || public.bendahara_check_tb(org, 'B4 payment 2');

  -- ==== 14: void B4 payment 2 ===========================================================
  fails := fails || public.bendahara_check_try('14: B4 payment 2 is voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', p2));
  select * into r from public.bendahara_check_entry(p2, ':void');
  if r.bank_dr is distinct from 2800.00 or r.fx_dr is distinct from 56.00 or r.pay_cr is distinct from 2856.00
     or r.dr is distinct from r.cr or r.lines is distinct from 3 then
    fails := fails || format('14: the reversal is Dr Bank %s, Dr realised %s, Cr Payable %s (Dr %s, Cr %s, %s lines)',
      r.bank_dr, r.fx_dr, r.pay_cr, r.dr, r.cr, r.lines);
  end if;
  select balance, balance_myr into r from public.supplier_bill_totals where id = b4;
  if r.balance is distinct from 680.00 or r.balance_myr is distinct from 2856.00 then
    fails := fails || format('14: after the void the bill owes %s / RM %s, not 680.00 / RM 2,856.00', r.balance, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B4 void');

  -- ==== 3, 15: worked example B4.1: three lines of USD 33.33 at 4.2555 (RM 425.52) ==========
  b41 := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2555'), usd_b41);
  perform public.finance_post_bill(org, b41);
  select total_myr into r from public.supplier_bill_totals where id = b41;
  if r.total_myr is distinct from 425.52 then fails := fails || format('3: B4.1 is RM %s, not 425.52', r.total_myr); end if;
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '214'),
    jsonb_build_array(jsonb_build_object('bill_id', b41, 'amount', 50)));
  p1 := r.id;
  if r.err is not null then fails := fails || format('3: B4.1 payment 1 refused: %s', r.err); end if;
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '212'),
    jsonb_build_array(jsonb_build_object('bill_id', b41, 'amount', 49.99)));
  p2 := r.id;
  if r.err is not null then fails := fails || format('3: B4.1 payment 2 refused: %s', r.err); end if;
  select string_agg(a.carried_myr || ' ' || (a.carried_myr - a.amount_myr), '; ' order by a.amount desc) into t
    from public.finance_allocations a where a.bill_id = b41;
  if t is distinct from '212.78 -1.22; 212.74 0.74' then
    fails := fails || format('3: B4.1 carried and realised %s, not 212.78 -1.22; 212.74 0.74', t);
  end if;
  if public.bendahara_check_payable(org, array[b41, p1, p2]) is distinct from 0.00 then
    fails := fails || format('3: B4.1 leaves %s on Payable', public.bendahara_check_payable(org, array[b41, p1, p2]));
  end if;
  -- 15: void payment 1 after payment 2: USD 50.00 / RM 212.78 open again; paid again with RM 213.00, it takes the closing 212.78.
  update public.finance_transactions set status = 'void', updated_at = now() where id = p1;
  select balance, balance_myr into r from public.supplier_bill_totals where id = b41;
  if r.balance is distinct from 50.00 or r.balance_myr is distinct from 212.78 then
    fails := fails || format('15: after the void B4.1 owes %s / RM %s, not 50.00 / RM 212.78', r.balance, r.balance_myr);
  end if;
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '213'),
    jsonb_build_array(jsonb_build_object('bill_id', b41, 'amount', 50)));
  p3 := r.id;
  if r.err is not null then fails := fails || format('15: B4.1 paid again refused: %s', r.err); end if;
  select a.carried_myr, a.carried_myr - a.amount_myr as realised into r from public.finance_allocations a where a.transaction_id = p3;
  if r.carried_myr is distinct from 212.78 or r.realised is distinct from -0.22 then
    fails := fails || format('15: paid again it carried %s, realised %s (not 212.78, -0.22)', r.carried_myr, r.realised);
  end if;
  if public.bendahara_check_payable(org, array[b41, p1, p2, p3]) is distinct from 0.00 then
    fails := fails || format('15: B4.1 leaves %s on Payable', public.bendahara_check_payable(org, array[b41, p1, p2, p3]));
  end if;
  fails := fails || public.bendahara_check_tb(org, 'B4.1');

  -- ==== 4: worked example B4.2: RM 1,000.00 over three USD 100.00 bills ====================
  -- X1 < X2 < X3 by id, at 3.30, 3.35, 3.32 (RM 330.00, 335.00, 332.00). The rates are given once the ids are known.
  for n in 1..3 loop
    x := x || public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '3'), hundred);
  end loop;
  select array_agg(i order by i) into x from unnest(x) i;
  update public.supplier_bills set fx_rate = 3.30 where id = x[1];
  update public.supplier_bills set fx_rate = 3.35 where id = x[2];
  update public.supplier_bills set fx_rate = 3.32 where id = x[3];
  for n in 1..3 loop perform public.finance_post_bill(org, x[n]); end loop;
  -- Given in the order X3, X1, X2, so the remainder is not the first row by luck of the order sent.
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '1000'),
    jsonb_build_array(jsonb_build_object('bill_id', x[3], 'amount', 100), jsonb_build_object('bill_id', x[1], 'amount', 100),
                      jsonb_build_object('bill_id', x[2], 'amount', 100)));
  p1 := r.id;
  if r.err is not null then fails := fails || format('4: B4.2 refused: %s', r.err); end if;
  select string_agg(a.amount_myr || '/' || a.carried_myr || '/' || (a.carried_myr - a.amount_myr), ' '
                    order by array_position(x, a.bill_id)) into t
    from public.finance_allocations a where a.transaction_id = p1;
  if t is distinct from '333.34/330.00/-3.34 333.33/335.00/1.67 333.33/332.00/-1.33' then
    fails := fails || format('4: B4.2 X1 X2 X3 share/carried/realised %s', t);
  end if;
  select * into r from public.bendahara_check_entry(p1);
  if r.pay_dr is distinct from 997.00 or r.fx_dr is distinct from 3.00 or r.fx_cr is distinct from 0 or r.bank_cr is distinct from 1000.00
     or r.dr is distinct from r.cr then
    fails := fails || format('4: B4.2 posts Dr Payable %s, Dr realised %s, Cr realised %s, Cr Bank %s (Dr %s, Cr %s)',
      r.pay_dr, r.fx_dr, r.fx_cr, r.bank_cr, r.dr, r.cr);
  end if;
  if public.bendahara_check_payable(org, x || p1) is distinct from 0.00 then
    fails := fails || format('4: B4.2 leaves %s on Payable', public.bendahara_check_payable(org, x || p1));
  end if;
  -- 4b: the share is in proportion to the foreign amounts: USD 100.00 and USD 300.00 at 4.0, RM 1,000.00 paid out:
  -- 250.00 and 750.00 (the largest takes the remainder).
  b_lo := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4'), hundred);
  b_hi := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4'), three_hundred);
  perform public.finance_post_bill(org, b_lo);
  perform public.finance_post_bill(org, b_hi);
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '1000'),
    jsonb_build_array(jsonb_build_object('bill_id', b_lo, 'amount', 100), jsonb_build_object('bill_id', b_hi, 'amount', 300)));
  p1 := r.id;
  if r.err is not null then fails := fails || format('4b: refused: %s', r.err); end if;
  select string_agg(a.amount_myr::text, ' ' order by a.amount) into t from public.finance_allocations a where a.transaction_id = p1;
  if t is distinct from '250.00 750.00' then fails := fails || format('4b: RM 1,000.00 over USD 100.00 and 300.00 is shared %s', t); end if;
  fails := fails || public.bendahara_check_tb(org, 'B4.2');

  -- ==== 13: worked example C4: the cap. IDR 2,000,030.00 at 0.00028 is RM 560.00 (each line rounds down) =====
  b_idr := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'IDR', 'fx_rate', '0.00028'), idr_lines);
  perform public.finance_post_bill(org, b_idr);
  select * into r from public.bendahara_check_pay(org, paid_now || jsonb_build_object('amount_myr', '561'),
    jsonb_build_array(jsonb_build_object('bill_id', b_idr, 'amount', 2000029)));
  p1 := r.id;
  if r.err is not null then fails := fails || format('13: C4 payment 1 refused: %s', r.err); end if;
  select a.carried_myr, a.carried_myr - a.amount_myr as realised into r from public.finance_allocations a where a.transaction_id = p1;
  if r.carried_myr is distinct from 560.00 or r.realised is distinct from -1.00 then
    fails := fails || format('13: C4 payment 1 carried %s, realised %s (not 560.00, -1.00)', r.carried_myr, r.realised);
  end if;
  select balance, balance_myr into r from public.supplier_bill_totals where id = b_idr;
  if r.balance is distinct from 1.00 or r.balance_myr is distinct from 0.00 then
    fails := fails || format('13: C4 then owes IDR %s / RM %s, not 1.00 / 0.00', r.balance, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_try('13: C4 IDR 1.00 paid with RM 0.01', 'ok',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      paid_now || jsonb_build_object('amount_myr', '0.01', 'notes', 'C4 payment 2'),
      jsonb_build_array(jsonb_build_object('bill_id', b_idr, 'amount', 1))));
  select id into p2 from public.finance_transactions where org_id = org and notes = 'C4 payment 2';
  select a.carried_myr, a.carried_myr - a.amount_myr as realised into r from public.finance_allocations a where a.transaction_id = p2;
  if r.carried_myr is distinct from 0.00 or r.realised is distinct from -0.01 then
    fails := fails || format('13: C4 payment 2 carried %s, realised %s (not 0.00, -0.01)', r.carried_myr, r.realised);
  end if;
  if public.bendahara_check_payable(org, array[b_idr, p1, p2]) is distinct from 0.00 then
    fails := fails || format('13: C4 leaves %s on Payable', public.bendahara_check_payable(org, array[b_idr, p1, p2]));
  end if;
  fails := fails || public.bendahara_check_tb(org, 'C4');

  -- ==== 19: JPY 100,000.00 at 0.029, paid in full with RM 2,900.00: not measured against the ringgit (FIN03) ====
  b_jpy := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'JPY', 'fx_rate', '0.029'), jpy_line);
  perform public.finance_post_bill(org, b_jpy);
  fails := fails || public.bendahara_check_try('19: JPY 100,000 paid with RM 2,900.00', 'ok',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      paid_now || jsonb_build_object('amount_myr', '2900', 'notes', 'JPY in full'),
      jsonb_build_array(jsonb_build_object('bill_id', b_jpy, 'amount', 100000))));
  select a.carried_myr, a.carried_myr - a.amount_myr as realised into r
    from public.finance_allocations a join public.finance_transactions t on t.id = a.transaction_id
   where t.org_id = org and t.notes = 'JPY in full';
  if r.carried_myr is distinct from 2900.00 or r.realised is distinct from 0.00 then
    fails := fails || format('19: the JPY payment carried %s, realised %s (not 2,900.00, 0.00)', r.carried_myr, r.realised);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'JPY');

  -- ==== 5: one payment, one currency, asked before anything is written ======================
  b_usd := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_a4);
  perform public.finance_post_bill(org, b_usd);
  b_sgd := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'SGD', 'fx_rate', '3.3'), usd_a4);
  perform public.finance_post_bill(org, b_sgd);
  -- A ringgit bill whose id sorts before a USD bill's (so it is the first row written).
  b_myr := public.finance_save_bill(org, jsonb_build_object('supplier_id', sup, 'bill_date', '1999-01-10', 'due_date', '1999-02-10'), myr_line);
  perform public.finance_post_bill(org, b_myr);
  for n in 1..40 loop
    exit when b_myr < b_usd;
    b_usd := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), usd_a4);
    perform public.finance_post_bill(org, b_usd);
  end loop;
  if not (b_myr < b_usd) then fails := fails || '5: no USD bill sorts after the ringgit bill'::text; end if;
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('5: a USD bill and an SGD bill on one payment', 'FIN44',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', '500'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10), jsonb_build_object('bill_id', b_sgd, 'amount', 10))));
  -- RM 100.00 of the ringgit bill is more than the RM 50.00 paid out: without the test up front, FIN03 on its row.
  fails := fails || public.bendahara_check_try('5: a ringgit bill (first by id) and a USD bill on one payment', 'FIN44',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', '50'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10), jsonb_build_object('bill_id', b_myr, 'amount', 100))));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('5: refused payments left %s transactions', n); end if;
  -- 5b: a draft written by hand, a ringgit bill row then a USD bill row; and the other way round.
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 1000, 'bank_transfer', sup) returning id into tx;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, tx, b_myr, 5);
  fails := fails || public.bendahara_check_try('5b: a ringgit bill row, then a USD bill row', 'FIN44',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 5)', org, tx, b_usd));
  delete from public.finance_transactions where id = tx;
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id)
  values (org, 'out', bank, 1000, 'bank_transfer', sup) returning id into tx;
  insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (org, tx, b_usd, 5);
  fails := fails || public.bendahara_check_try('5b: a USD bill row, then a ringgit bill row', 'FIN44',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 5)', org, tx, b_myr));
  delete from public.finance_transactions where id = tx;

  -- ==== 6, 7, 8: paid now, with the ringgit paid out, by an owner or admin =================
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('6: a USD bill''s payment asked as scheduled (owner)', 'FIN47',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      paid_now || jsonb_build_object('amount_myr', '42', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('7: with no ringgit paid out', 'FIN46',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now,
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('7: with RM 0 paid out', 'FIN46',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', '0'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('7: with NaN paid out', 'FIN46',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', 'NaN'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('6: a USD bill''s payment asked as scheduled (member)', 'FIN47',
    format('select public.finance_record_payment_out(%L, %L, %L)', org,
      paid_now || jsonb_build_object('amount_myr', '42', 'status', 'scheduled'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('8: a member pays a USD bill now', 'FIN14',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', '42'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('a viewer pays a USD bill now', '42501',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', '42'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  perform set_config('request.jwt.claims', owner_claims, true);
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('6-8: refused payments left %s transactions', n); end if;
  select count(*) into n from public.finance_allocations where org_id = org and bill_id = b_usd;
  if n <> 0 then fails := fails || format('6-8: refused payments left %s allocations on the USD bill', n); end if;

  -- ==== 9, 10, 10b, 11: a draft written by hand with a USD bill row leaves draft only settled =====
  b_hand := public.finance_save_bill(org, dated || typed || jsonb_build_object('supplier_id', sup, 'currency', 'USD', 'fx_rate', '4.2'), hundred);
  perform public.finance_post_bill(org, b_hand);
  insert into public.finance_transactions (org_id, direction, account_id, amount, method, contact_id, txn_date)
  values (org, 'out', bank, 420, 'bank_transfer', sup, '1999-01-20') returning id into tx;
  fails := fails || public.bendahara_check_try('9: a USD bill row on a draft written by hand', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, bill_id, amount) values (%L, %L, %L, 100)', org, tx, b_hand));
  fails := fails || public.bendahara_check_try('9: the draft is posted by an update', 'FIN46',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'posted', tx));
  fails := fails || public.bendahara_check_try('10: the draft is scheduled by an update', 'FIN46',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'scheduled', tx));
  fails := fails || public.bendahara_check_try('11: the signed-in write the ringgit of the split', '42501',
    format('update public.finance_allocations set amount_myr = 420, carried_myr = 420 where transaction_id = %L', tx));
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('10b: a member posts the draft by an update', 'FIN14',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'posted', tx));
  perform set_config('request.jwt.claims', owner_claims, true);
  select status into t from public.finance_transactions where id = tx;
  if t is distinct from 'draft' then fails := fails || format('9-10b: the draft written by hand is now %s', t); end if;
  delete from public.finance_transactions where id = tx;

  -- ==== 12: a payment voucher never names a USD bill =======================================
  select count(*) into n0 from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('12: a voucher draft naming the USD bill', 'FIN47',
    format('select public.finance_save_voucher(%L, %L, %L)', org, paid_now,
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('12: a voucher sent for approval naming the USD bill', 'FIN47',
    format('select public.finance_save_voucher(%L, %L, %L)', org, paid_now || jsonb_build_object('status', 'pending_approval'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  select count(*) - n0 into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('12: refused vouchers left %s transactions', n); end if;
  fails := fails || public.bendahara_check_try('12: a voucher for the ringgit bill', 'ok',
    format('select public.finance_save_voucher(%L, %L, %L)', org, paid_now || jsonb_build_object('notes', 'E4 ringgit voucher'),
      jsonb_build_array(jsonb_build_object('bill_id', b_myr, 'amount', 10))));
  -- Editing that draft to name the USD bill, alone or beside the ringgit bill: FIN47 too, and its split stays as it was.
  select id into tx from public.finance_transactions where org_id = org and notes = 'E4 ringgit voucher';
  fails := fails || public.bendahara_check_try('12: a draft voucher edited to name only the USD bill', 'FIN47',
    format('select public.finance_save_voucher(%L, %L, %L)', org, paid_now || jsonb_build_object('id', tx, 'notes', 'E4 ringgit voucher'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  fails := fails || public.bendahara_check_try('12: a draft voucher edited to name the ringgit bill and the USD bill', 'FIN47',
    format('select public.finance_save_voucher(%L, %L, %L)', org, paid_now || jsonb_build_object('id', tx, 'notes', 'E4 ringgit voucher'),
      jsonb_build_array(jsonb_build_object('bill_id', b_myr, 'amount', 10), jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  select string_agg(a.bill_id::text || ' ' || a.amount, '; ') into t from public.finance_allocations a where a.transaction_id = tx;
  if tx is null or t is distinct from b_myr::text || ' 10.00' then
    fails := fails || format('12: after the refused edits the draft voucher''s split is %s, not the ringgit bill at 10.00', t);
  end if;

  -- ==== 16: worked example E4: ringgit payments out post what they did =====================
  -- A ringgit bill paid by a ringgit payment: Dr Payable 50.00, Cr Bank 50.00, no realised line, no figures on the split.
  p1 := public.finance_record_payment_out(org, paid_now, jsonb_build_array(jsonb_build_object('bill_id', b_myr, 'amount', 50)));
  select t.amount, t.approved_at, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = p1;
  if r.amount is distinct from 50.00 or r.approved_at is not null or r.amount_myr is not null or r.carried_myr is not null then
    fails := fails || format('16: the ringgit payment is %s (approved %s), split figures %s / %s', r.amount, r.approved_at, r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_entry(p1);
  if r.pay_dr is distinct from 50.00 or r.bank_cr is distinct from 50.00 or r.fx_dr <> 0 or r.fx_cr <> 0 or r.lines is distinct from 2 then
    fails := fails || format('16: the ringgit payment posts Dr Payable %s, Cr Bank %s, realised %s / %s, %s lines',
      r.pay_dr, r.bank_cr, r.fx_dr, r.fx_cr, r.lines);
  end if;
  select currency, amount_myr, carried_myr, realised_myr into r from public.finance_payments_out where transaction_id = p1;
  if r.currency is distinct from 'MYR' or r.amount_myr is distinct from 50.00 or r.carried_myr is distinct from 50.00
     or r.realised_myr is distinct from 0.00 then
    fails := fails || format('16: the ringgit payment reads %s %s / %s / %s', r.currency, r.amount_myr, r.carried_myr, r.realised_myr);
  end if;
  -- An expense voucher: Dr Accrued Expenses 40.00.
  ex := public.finance_save_expense(org, jsonb_build_object('expense_date', '1999-01-10', 'category_id', rent,
    'vendor_name', 'Check Landlord', 'amount', 40, 'sst_amount', 0));
  -- An owner's expense may already be approved when saved; otherwise the owner approves it.
  update public.finance_expenses set status = 'approved', updated_at = now() where id = ex and status <> 'approved';
  v_exp := public.finance_record_voucher(org, paid_now, jsonb_build_array(jsonb_build_object('expense_id', ex, 'amount', 40)));
  select coalesce(sum(l.debit) filter (where a.system_key = 'accrued_expenses'), 0) as acc_dr,
         coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0) as bank_cr,
         count(*) filter (where a.system_key in ('fx_realised', 'payable')) as other, count(*) as n
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.source_id = v_exp;
  if r.acc_dr is distinct from 40.00 or r.bank_cr is distinct from 40.00 or r.other <> 0 or r.n <> 2 then
    fails := fails || format('16: the expense voucher posts Dr Accrued %s, Cr Bank %s, %s other lines, %s lines', r.acc_dr, r.bank_cr, r.other, r.n);
  end if;
  -- A category voucher: Dr the category 30.00.
  v_cat := public.finance_record_voucher(org, paid_now || jsonb_build_object('category_id', rent, 'amount', 30, 'party_name', 'Kedai'), '[]');
  select coalesce(sum(l.debit) filter (where a.category_id = rent), 0) as cat_dr,
         coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0) as bank_cr,
         count(*) filter (where a.system_key in ('fx_realised', 'payable')) as other, count(*) as n
    into r
    from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
   where l.source_id = v_cat;
  if r.cat_dr is distinct from 30.00 or r.bank_cr is distinct from 30.00 or r.other <> 0 or r.n <> 2 then
    fails := fails || format('16: the category voucher posts Dr category %s, Cr Bank %s, %s other lines, %s lines', r.cat_dr, r.bank_cr, r.other, r.n);
  end if;
  fails := fails || public.bendahara_check_tb(org, 'E4');

  -- ==== nobody calls the settlement or the closing rule directly ===============================
  fails := fails || public.bendahara_check_try('the signed-in call the bill closing rule', '42501',
    format('select private.finance_fx_carried_bill(%L, %L, 1)', org, b_usd));
  fails := fails || public.bendahara_check_try('the signed-in settle a payment', '42501',
    format('select private.finance_fx_settle(%L, %L)', org, p1));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  fails := fails || public.bendahara_check_try('anon records a payment out', '42501',
    format('select public.finance_record_payment_out(%L, %L, %L)', org, paid_now || jsonb_build_object('amount_myr', '42'),
      jsonb_build_array(jsonb_build_object('bill_id', b_usd, 'amount', 10))));
  reset role;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_PAYMENTS_OUT_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_PAYMENTS_OUT_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
