-- Bendahara foreign credit notes and refunds check (stage 3c). Run it after
-- 20261120120000_bendahara_fx_credit_notes_refunds.sql, in the same
-- transaction for a dry run, or by itself once applied. It leaves nothing
-- behind either way: the block always ends with RAISE, so every row and the
-- helper functions below are rolled back. Read the message:
--   BENDAHARA_FX_CREDIT_NOTES_REFUNDS_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, member and viewer the way the app does (the
-- authenticated role with that person's id in request.jwt.claims). Every rate
-- is typed by hand with its source, so no BNM row is needed. The worked
-- examples are the plan's (.superpowers/sdd/2026-10-16-bendahara-fx-sales.md,
-- "Worked examples" C1, C2, D), to the sen, and three of the migration's own
-- rulings: a credit note past zero (on a paid invoice, and for more than is
-- still owed), and the cap on a part that does not clear an invoice whose
-- lines each rounded down (IDR), where the part that does clear it takes
-- RM 0.00.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  owner_claims text;
  member_claims text;
  viewer_claims text;
  cust uuid;
  bank uuid;
  i_c1 uuid;
  i_c2 uuid;
  i_d uuid;
  i_x uuid;
  i_idr uuid;
  i_m uuid;
  i_myr uuid;
  cn uuid;
  cn_d uuid;
  cn_x uuid;
  cn_myr uuid;
  pay uuid;
  rf uuid;
  rf_x uuid;
  rf_myr uuid;
  draft_out uuid;
  i_s2 uuid;
  i_sst uuid;
  i_idr2 uuid;
  i_myr2 uuid;
  i_r2 uuid;
  i_r3 uuid;
  rf3 uuid;
  pay3 uuid;
  cn3 uuid;
  pay2 uuid;
  cn2 uuid;
  rf2 uuid;
  n integer;
  t text;
  r record;
  fails text[] := '{}';
  usd_line jsonb := '[{"description":"Consulting","quantity":1,"unit_price":1000,"sst_rate":8}]';
  hundred jsonb := '[{"description":"Support","quantity":1,"unit_price":100,"sst_rate":0}]';
  myr_line jsonb := '[{"description":"Parts","quantity":10,"unit_price":12.50,"sst_rate":6}]';
  three_lines jsonb := '[{"description":"a","quantity":1,"unit_price":33.33,"sst_rate":0},
                         {"description":"b","quantity":1,"unit_price":33.33,"sst_rate":0},
                         {"description":"c","quantity":1,"unit_price":33.33,"sst_rate":0}]';
  usd_at_4_2 jsonb := '{"currency":"USD","fx_rate":"4.2","fx_rate_source":"manual","fx_rate_provider":"reuters"}';
  usd_at_4_2555 jsonb := '{"currency":"USD","fx_rate":"4.2555","fx_rate_source":"manual","fx_rate_provider":"oanda"}';
  dates jsonb := '{"invoice_date":"1999-01-10","due_date":"1999-02-10"}';
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
  -- One document's ledger entry (not its reversal unless suffix is ':void'), by account.
  execute $f$
    create function public.bendahara_check_entry(target uuid, suffix text default '')
    returns table (bank_dr numeric, bank_cr numeric, rec_dr numeric, rec_cr numeric, fx_dr numeric, fx_cr numeric,
                   sst_dr numeric, sales_dr numeric, dr numeric, cr numeric)
    language sql security invoker set search_path = '' as $g$
      select
        coalesce(sum(l.debit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.credit) filter (where a.bank_account_id is not null), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'receivable'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'receivable'), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.credit) filter (where a.system_key = 'fx_realised'), 0),
        coalesce(sum(l.debit) filter (where a.system_key = 'sst_payable'), 0),
        coalesce(sum(l.debit) filter (where a.default_for = 'sales'), 0),
        coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
      from public.finance_ledger_lines l
      join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.source_id = target and l.entry_key = l.source || ':' || target || suffix
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_entry(uuid, text) to authenticated';
  -- Receivable over an invoice and everything that settled it (payments, credit notes, refunds), and what
  -- it still carries in ringgit.
  execute $f$
    create function public.bendahara_check_receivable(target uuid)
    returns table (rec numeric, fx numeric, open_foreign numeric, open_myr numeric)
    language sql security invoker set search_path = '' as $g$
      select
        (select coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'receivable'), 0)
           from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
          where l.source_id = target
             or l.source_id in (select n.id from public.finance_credit_notes n where n.invoice_id = target)
             or l.source_id in (select x.transaction_id from public.finance_allocations x
                                 left join public.finance_credit_notes n on n.id = x.credit_note_id
                                 where coalesce(x.invoice_id, n.invoice_id) = target)),
        (select coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'fx_realised'), 0)
           from public.finance_ledger_lines l join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
          where l.source_id in (select x.transaction_id from public.finance_allocations x
                                 left join public.finance_credit_notes n on n.id = x.credit_note_id
                                 where coalesce(x.invoice_id, n.invoice_id) = target)),
        (select balance from public.finance_invoice_totals where id = target),
        (select balance_myr from public.finance_invoice_totals where id = target)
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_check_receivable(uuid) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_credit_notes'::regclass and not tgisinternal and tgenabled = 'O';
  if t is distinct from 'finance_credit_note_guard,finance_credit_note_sign_off,finance_credit_note_to_ringgit,finance_void_stamp' then
    fails := fails || format('triggers on finance_credit_notes are: %s', t);
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_attribute
   where attrelid = 'public.finance_credit_notes'::regclass and attnum > 0 and not attisdropped
     and attname in ('currency', 'fx_rate', 'amount_myr');
  if t is distinct from 'currency,fx_rate,amount_myr' then
    fails := fails || format('finance_credit_notes has the new columns %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private' and p.proname = 'finance_split_in_payment_terms' and not p.prosecdef;
  if n <> 1 then fails := fails || 'private.finance_split_in_payment_terms is missing or runs as its owner'::text; end if;

  -- ---- workspace, people ----------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@fxcn.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, member_id, viewer_id]) as u(id);
  insert into public.orgs (id, name) values (org, 'FX Credit Notes Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, member_id, 'member'), (org, viewer_id, 'viewer');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  member_claims := json_build_object('sub', member_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  select id into bank from public.finance_accounts where org_id = org and kind = 'bank' order by created_at limit 1;

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer, is_supplier) values (org, 'Overseas Ltd', true, true) returning id into cust;

  -- ==== C1: a partial credit note, USD 108.00 on USD 1,080.00 at 4.2 ================
  i_c1 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2, usd_line);
  perform public.finance_post_invoice(org, i_c1);
  fails := fails || public.bendahara_check_try('C1: a draft credit note of USD 108.00', 'ok',
    format('select public.finance_save_credit_note(%L, %L)', org,
      jsonb_build_object('invoice_id', i_c1, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 108, 'notes', 'C1')));
  select id into cn from public.finance_credit_notes where org_id = org and notes = 'C1';
  if cn is null then
    fails := array_remove(fails, null);
    raise exception 'BENDAHARA_FX_CREDIT_NOTES_REFUNDS_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  select currency, fx_rate, amount_myr into r from public.finance_credit_note_totals where id = cn;
  if r.currency <> 'USD' or r.fx_rate <> 4.2 or r.amount_myr is not null then
    fails := fails || format('C1 draft reads %s at %s, RM %s (not USD at 4.2, no ringgit yet)', r.currency, r.fx_rate, r.amount_myr);
  end if;
  fails := fails || public.bendahara_check_try('C1: issued', 'ok', format('select public.finance_issue_credit_note(%L, %L)', org, cn));
  select status, currency, amount, amount_myr into r from public.finance_credit_note_totals where id = cn;
  if r.status <> 'issued' or r.amount <> 108.00 or r.amount_myr is distinct from 453.60 then
    fails := fails || format('C1 issued reads %s, USD %s, RM %s (not 453.60)', r.status, r.amount, r.amount_myr);
  end if;
  select * into r from public.bendahara_check_entry(cn);
  if r.sales_dr <> 420.00 or r.sst_dr <> 33.60 or r.rec_cr <> 453.60 or r.fx_dr <> 0 or r.fx_cr <> 0 or r.dr <> r.cr then
    fails := fails || format('C1 posts Dr Sales %s, Dr SST %s, Cr Receivable %s, Realised %s/%s', r.sales_dr, r.sst_dr, r.rec_cr, r.fx_dr, r.fx_cr);
  end if;
  select credited, balance, balance_myr into r from public.finance_invoice_totals where id = i_c1;
  if r.credited <> 108.00 or r.balance <> 972.00 or r.balance_myr <> 4082.40 then
    fails := fails || format('after C1 the invoice reads credited %s, USD %s / RM %s open', r.credited, r.balance, r.balance_myr);
  end if;
  -- Its currency and its ringgit are the database's, and locked once issued.
  fails := fails || public.bendahara_check_try('C1: an issued credit note''s ringgit is changed', 'FIN01',
    format('update public.finance_credit_notes set amount_myr = 1 where id = %L', cn));
  -- Voided: the ringgit it took is open again, and the reversal is the same numbers.
  fails := fails || public.bendahara_check_try('C1: voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cn));
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_c1;
  if r.balance <> 1080.00 or r.balance_myr <> 4536.00 then
    fails := fails || format('after C1 is voided the invoice reads USD %s / RM %s open, not 1080.00 / 4536.00', r.balance, r.balance_myr);
  end if;
  select * into r from public.bendahara_check_entry(cn, ':void');
  if r.rec_dr <> 453.60 or r.dr <> 453.60 or r.cr <> 453.60 then
    fails := fails || format('the void of C1 posts Dr Receivable %s (Dr %s, Cr %s)', r.rec_dr, r.dr, r.cr);
  end if;
  select amount_myr into r from public.finance_credit_notes where id = cn;
  if r.amount_myr is distinct from 453.60 then fails := fails || format('C1 void keeps RM %s, not 453.60', r.amount_myr); end if;

  -- What a caller sends for the three columns is overwritten: the invoice's currency and rate, no ringgit on a draft.
  fails := fails || public.bendahara_check_try('a draft written by hand with another currency', 'ok',
    format('insert into public.finance_credit_notes (org_id, invoice_id, amount, currency, fx_rate, amount_myr, notes) values (%L, %L, 5, %L, 9, 1, %L)',
      org, i_c1, 'SGD', 'by hand'));
  select currency, fx_rate, amount_myr into r from public.finance_credit_notes where org_id = org and notes = 'by hand';
  if r.currency <> 'USD' or r.fx_rate <> 4.2 or r.amount_myr is not null then
    fails := fails || format('a draft written by hand reads %s at %s, RM %s', r.currency, r.fx_rate, r.amount_myr);
  end if;
  delete from public.finance_credit_notes where org_id = org and notes = 'by hand';

  -- ==== C2: a credit note that clears the three-line invoice takes 425.52 =========
  i_c2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2555, three_lines);
  perform public.finance_post_invoice(org, i_c2);
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_c2, 'credit_date', '1999-01-15', 'reason', 'overbilling', 'amount', 99.99));
  perform public.finance_issue_credit_note(org, cn);
  select amount_myr into r from public.finance_credit_notes where id = cn;
  if r.amount_myr is distinct from 425.52 then fails := fails || format('C2 takes RM %s, not 425.52', r.amount_myr); end if;
  select * into r from public.bendahara_check_receivable(i_c2);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 then
    fails := fails || format('C2 leaves Receivable at %s, the invoice USD %s / RM %s open', r.rec, r.open_foreign, r.open_myr);
  end if;
  -- Voided, its ringgit is not worked out again (it would be round(99.99 x 4.2555) = 425.51 against the
  -- invoice as it stands then), and the reversal is the issue's numbers.
  fails := fails || public.bendahara_check_try('C2: voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cn));
  select amount_myr into r from public.finance_credit_notes where id = cn;
  if r.amount_myr is distinct from 425.52 then fails := fails || format('C2 voided keeps RM %s, not 425.52', r.amount_myr); end if;
  select * into r from public.bendahara_check_entry(cn, ':void');
  if r.rec_dr <> 425.52 or r.dr <> r.cr then
    fails := fails || format('the void of C2 posts Dr Receivable %s (Dr %s, Cr %s)', r.rec_dr, r.dr, r.cr);
  end if;

  -- ==== D: paid in full, credited USD 108.00, refunded RM 445.00: gain 8.60 ======
  i_d := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2, usd_line);
  perform public.finance_post_invoice(org, i_d);
  pay := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '4536'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_d, 'amount', 1080)));
  cn_d := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_d, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 108));
  fails := fails || public.bendahara_check_try('D: a credit note on the paid invoice is issued', 'ok',
    format('select public.finance_issue_credit_note(%L, %L)', org, cn_d));
  -- Past zero: the invoice owed nothing, so the part at the rate (3b's cap alone would give 0.00).
  select amount_myr into r from public.finance_credit_notes where id = cn_d;
  if r.amount_myr is distinct from 453.60 then
    fails := fails || format('D: the credit note on a paid invoice takes RM %s, not 453.60', r.amount_myr);
  end if;
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_d;
  if r.balance <> -108.00 or r.balance_myr <> -453.60 then
    fails := fails || format('D: the customer is in credit USD %s / RM %s, not -108.00 / -453.60', r.balance, r.balance_myr);
  end if;
  -- FIN47: the owner asks for the refund to be scheduled; nothing is written.
  select count(*) into n from public.finance_transactions where org_id = org;
  fails := fails || public.bendahara_check_try('FIN47: a foreign refund asked as scheduled', 'FIN47',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'reason', 'damaged_goods',
                         'amount', 108, 'amount_myr', '445', 'status', 'scheduled')));
  fails := fails || public.bendahara_check_try('FIN46: a foreign refund with no ringgit paid out', 'FIN46',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'reason', 'damaged_goods', 'amount', 108)));
  fails := fails || public.bendahara_check_try('FIN46: a foreign refund of RM 0.00', 'FIN46',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'amount', 108, 'amount_myr', '0.004')));
  fails := fails || public.bendahara_check_try('FIN46: a foreign refund of RM NaN', 'FIN46',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'amount', 108, 'amount_myr', 'NaN')));
  -- A member: posting a refund is a sign-off (FIN14); scheduling a foreign one is FIN47. A viewer: not allowed.
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('a member records a foreign refund', 'FIN14',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'amount', 108, 'amount_myr', '445')));
  fails := fails || public.bendahara_check_try('a member asks for a foreign refund to be scheduled', 'FIN47',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'amount', 108, 'amount_myr', '445',
                         'status', 'scheduled')));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('a viewer records a foreign refund', '42501',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'amount', 108, 'amount_myr', '445')));
  perform set_config('request.jwt.claims', owner_claims, true);
  select n - count(*) into n from public.finance_transactions where org_id = org;
  if n <> 0 then fails := fails || format('refused refunds left %s transactions', -n); end if;
  -- The refund: USD 108.00 against the credit note, RM 445.00 out. Closing: carried |balance_myr| 453.60.
  fails := fails || public.bendahara_check_try('D: USD 108.00 refunded as RM 445.00', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-20',
                         'reason', 'damaged_goods', 'amount', 108, 'amount_myr', '445', 'notes', 'D refund')));
  select id into rf from public.finance_transactions where org_id = org and notes = 'D refund';
  select t.amount, t.status, t.approved_at, t.approved_by, a.amount as part, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = rf;
  if r.amount is distinct from 445.00 or r.status is distinct from 'posted' or r.part is distinct from 108.00
     or r.amount_myr is distinct from 445.00 or r.carried_myr is distinct from 453.60 then
    fails := fails || format('D refund is RM %s (%s), USD %s, amount_myr %s, carried %s', r.amount, r.status, r.part, r.amount_myr, r.carried_myr);
  end if;
  -- Not money out that settles no document: nobody is written down as approving it.
  if r.approved_at is not null or r.approved_by is not null then
    fails := fails || format('the approval stamp was written on a ringgit refund of a USD credit note (approved_at %s)', r.approved_at);
  end if;
  select * into r from public.bendahara_check_entry(rf);
  if r.rec_dr <> 453.60 or r.bank_cr <> 445.00 or r.fx_cr <> 8.60 or r.fx_dr <> 0 or r.dr <> r.cr then
    fails := fails || format('D refund posts Dr Receivable %s, Cr Bank %s, Cr Realised %s (Dr %s, Cr %s)', r.rec_dr, r.bank_cr, r.fx_cr, r.dr, r.cr);
  end if;
  select currency, amount, transaction_amount, amount_myr, carried_myr, realised_myr into r from public.finance_refunds where transaction_id = rf;
  if r.currency <> 'USD' or r.amount <> 108.00 or r.transaction_amount <> 445.00 or r.amount_myr <> 445.00
     or r.carried_myr <> 453.60 or r.realised_myr <> 8.60 then
    fails := fails || format('Refunds reads D as %s %s, RM %s / %s carried %s realised %s', r.currency, r.amount, r.transaction_amount,
      r.amount_myr, r.carried_myr, r.realised_myr);
  end if;
  select refunded into r from public.finance_credit_note_totals where id = cn_d;
  if r.refunded <> 108.00 then fails := fails || format('the credit note reads USD %s refunded', r.refunded); end if;
  select * into r from public.bendahara_check_receivable(i_d);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 or r.fx <> 8.60 then
    fails := fails || format('D leaves Receivable at %s, the invoice USD %s / RM %s, Realised %s', r.rec, r.open_foreign, r.open_myr, r.fx);
  end if;
  -- A credit note with a refund is not voided (FIN02, foreign as ringgit).
  fails := fails || public.bendahara_check_try('the refunded credit note is voided', 'FIN02',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cn_d));
  -- The refund voided: its realised line reverses, the customer is in credit again.
  fails := fails || public.bendahara_check_try('D refund voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rf));
  select * into r from public.bendahara_check_entry(rf, ':void');
  if r.rec_cr <> 453.60 or r.bank_dr <> 445.00 or r.fx_dr <> 8.60 or r.dr <> r.cr then
    fails := fails || format('the void of D refund posts Cr Receivable %s, Dr Bank %s, Dr Realised %s', r.rec_cr, r.bank_dr, r.fx_dr);
  end if;
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_d;
  if r.balance <> -108.00 or r.balance_myr <> -453.60 then
    fails := fails || format('after the refund is voided the invoice reads USD %s / RM %s, not -108.00 / -453.60', r.balance, r.balance_myr);
  end if;

  -- ==== a credit note for more than is still owed: what is open, and the rest at the rate ===
  -- The three-line invoice (RM 425.52), USD 50.00 paid as RM 212.00 (carried 212.78): USD 49.99 / RM 212.74 open.
  -- A credit note of USD 60.00 clears the 212.74 and takes the USD 10.01 past zero at the rate:
  -- round(10.01 x 4.2555 = 42.597555) = 42.60, so RM 255.34 (round(60 x 4.2555) alone would be 255.33).
  i_x := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2555, three_lines);
  perform public.finance_post_invoice(org, i_x);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '212'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_x, 'amount', 50)));
  cn_x := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_x, 'credit_date', '1999-01-15', 'reason', 'goodwill', 'amount', 60));
  perform public.finance_issue_credit_note(org, cn_x);
  select amount_myr into r from public.finance_credit_notes where id = cn_x;
  if r.amount_myr is distinct from 255.34 then
    fails := fails || format('a credit note past zero takes RM %s, not 255.34', r.amount_myr);
  end if;
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_x;
  if r.balance <> -10.01 or r.balance_myr <> -42.60 then
    fails := fails || format('past zero the invoice reads USD %s / RM %s, not -10.01 / -42.60', r.balance, r.balance_myr);
  end if;
  -- Refunded against the invoice itself, RM 42.00 out: closing, carried 42.60, gain 0.60. Receivable 0.00.
  fails := fails || public.bendahara_check_try('past zero: USD 10.01 refunded as RM 42.00', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', i_x, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-21', 'reason', 'overpayment',
                         'amount', 10.01, 'amount_myr', '42', 'notes', 'past zero')));
  select id into rf_x from public.finance_transactions where org_id = org and notes = 'past zero';
  select a.amount_myr, a.carried_myr into r from public.finance_allocations a where a.transaction_id = rf_x;
  if r.amount_myr is distinct from 42.00 or r.carried_myr is distinct from 42.60 then
    fails := fails || format('the refund past zero is RM %s carried %s, not 42.00 / 42.60', r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_receivable(i_x);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 then
    fails := fails || format('past zero then refunded leaves Receivable at %s, the invoice USD %s / RM %s', r.rec, r.open_foreign, r.open_myr);
  end if;

  -- ==== the cap, for credit notes: IDR lines that each round down ===================
  -- Two lines of IDR 1,000,015.00 at 0.00028 are RM 280.00 each (RM 560.00; the total at the rate is 560.0084).
  -- A credit note of IDR 2,000,029.00 does not clear it: round(560.00812) = 560.01 is more than the 560.00 open,
  -- so it takes 560.00. The last IDR 1.00 clears it and takes the RM 0.00 left. Receivable 0.00.
  i_idr := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'currency', 'IDR', 'fx_rate', '0.00028', 'fx_rate_source', 'manual',
                       'fx_rate_provider', 'oanda') || dates,
    '[{"description":"a","quantity":1,"unit_price":1000015,"sst_rate":0},
      {"description":"b","quantity":1,"unit_price":1000015,"sst_rate":0}]'::jsonb);
  perform public.finance_post_invoice(org, i_idr);
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_idr, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 2000029));
  perform public.finance_issue_credit_note(org, cn);
  fails := fails || public.bendahara_check_try('IDR: the last IDR 1.00 is credited', 'ok',
    format('select public.finance_issue_credit_note(%L, public.finance_save_credit_note(%L, %L))', org, org,
      jsonb_build_object('invoice_id', i_idr, 'credit_date', '1999-01-16', 'reason', 'returns', 'amount', 1)));
  select string_agg(amount_myr::text, ' ' order by credit_date) into t from public.finance_credit_notes where invoice_id = i_idr;
  if t is distinct from '560.00 0.00' then
    fails := fails || format('IDR credit notes take %s, not 560.00 0.00', t);
  end if;
  select * into r from public.bendahara_check_receivable(i_idr);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 then
    fails := fails || format('IDR credit notes leave Receivable at %s, the invoice IDR %s / RM %s', r.rec, r.open_foreign, r.open_myr);
  end if;

  -- ==== a member: a draft credit note yes, issuing it is a sign-off =================
  i_m := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2, hundred);
  perform public.finance_post_invoice(org, i_m);
  perform set_config('request.jwt.claims', member_claims, true);
  fails := fails || public.bendahara_check_try('a member saves a draft credit note on a USD invoice', 'ok',
    format('select public.finance_save_credit_note(%L, %L)', org,
      jsonb_build_object('invoice_id', i_m, 'reason', 'returns', 'amount', 10, 'notes', 'member draft')));
  select id into cn from public.finance_credit_notes where org_id = org and notes = 'member draft';
  fails := fails || public.bendahara_check_try('a member issues it', 'FIN14',
    format('select public.finance_issue_credit_note(%L, %L)', org, cn));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_check_try('a viewer saves a credit note on a USD invoice', '42501',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', i_m, 'reason', 'returns', 'amount', 10)));
  perform set_config('request.jwt.claims', owner_claims, true);
  fails := fails || public.bendahara_check_try('a USD credit note for more than is left to credit', 'FIN05',
    format('select public.finance_save_credit_note(%L, %L)', org, jsonb_build_object('invoice_id', i_m, 'reason', 'returns', 'amount', 100.01)));
  delete from public.finance_credit_notes where id = cn;

  -- ==== a refund draft written by hand: no longer FIN41, and not posted unsettled ====
  insert into public.finance_transactions (org_id, direction, account_id, txn_date, amount, method, contact_id, status)
  values (org, 'out', bank, '1999-01-22', 40, 'fpx', cust, 'draft') returning id into draft_out;
  fails := fails || public.bendahara_check_try('a USD credit note on a refund draft written by hand', 'ok',
    format('insert into public.finance_allocations (org_id, transaction_id, credit_note_id, amount) values (%L, %L, %L, 10)', org, draft_out, cn_d));
  fails := fails || public.bendahara_check_try('FIN46: a USD refund posted by hand', 'FIN46',
    format('update public.finance_transactions set status = %L where id = %L', 'posted', draft_out));
  fails := fails || public.bendahara_check_try('FIN46: a USD refund scheduled by hand', 'FIN46',
    format('update public.finance_transactions set status = %L where id = %L', 'scheduled', draft_out));
  -- In the payment's own terms: lowering the ringgit of a USD split is not FIN03 any more (the split is not ringgit).
  fails := fails || public.bendahara_check_try('the ringgit of a USD refund draft lowered', 'ok',
    format('update public.finance_transactions set amount = 5 where id = %L', draft_out));
  delete from public.finance_transactions where id = draft_out;

  -- ==== a refund that does not clear the credit: at the rate, never more than is in credit ===
  -- D again (in credit USD 108.00 / RM 453.60 since its refund was voided). USD 50.00 refunded as RM 205.00:
  -- carried round(50 x 4.2) = 210.00, gain 5.00. Then the USD 58.00 left as RM 240.00: closing, carried the
  -- 243.60 still in credit, gain 3.60. Receivable 0.00.
  -- Through the try, so a refusal is reported by name.
  fails := fails || public.bendahara_check_try('a partial USD refund: USD 50.00 as RM 205.00', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-23',
                         'reason', 'damaged_goods', 'amount', 50, 'amount_myr', '205', 'notes', 'partial 1')));
  select id into rf2 from public.finance_transactions where org_id = org and notes = 'partial 1';
  select a.amount_myr, a.carried_myr into r from public.finance_allocations a where a.transaction_id = rf2;
  if r.amount_myr is distinct from 205.00 or r.carried_myr is distinct from 210.00 then
    fails := fails || format('a partial USD refund is RM %s carried %s, not 205.00 / 210.00', r.amount_myr, r.carried_myr);
  end if;
  select * into r from public.bendahara_check_entry(rf2);
  if r.rec_dr <> 210.00 or r.bank_cr <> 205.00 or r.fx_cr <> 5.00 or r.dr <> r.cr then
    fails := fails || format('a partial USD refund posts Dr Receivable %s, Cr Bank %s, Cr Realised %s', r.rec_dr, r.bank_cr, r.fx_cr);
  end if;
  rf2 := null;
  fails := fails || public.bendahara_check_try('the rest of the USD credit: USD 58.00 as RM 240.00', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('credit_note_id', cn_d, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-24',
                         'reason', 'damaged_goods', 'amount', 58, 'amount_myr', '240', 'notes', 'partial 2')));
  select id into rf2 from public.finance_transactions where org_id = org and notes = 'partial 2';
  select a.carried_myr, a.amount_myr into r from public.finance_allocations a where a.transaction_id = rf2;
  if r.carried_myr is distinct from 243.60 or r.amount_myr is distinct from 240.00 then
    fails := fails || format('the rest of the USD credit refunded carries %s (RM %s), not 243.60 / 240.00', r.carried_myr, r.amount_myr);
  end if;
  select * into r from public.bendahara_check_receivable(i_d);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 then
    fails := fails || format('D refunded in two parts leaves Receivable at %s, the invoice USD %s / RM %s', r.rec, r.open_foreign, r.open_myr);
  end if;

  -- ==== the cap, for refunds: IDR credits whose ringgit each rounded down ==================
  -- IDR 2,000,030.00 at 0.00028 (RM 560.00) paid in full as RM 560.00, then two credit notes of IDR 1,000,015.00
  -- on the paid invoice, each round(280.0042) = 280.00: in credit IDR 2,000,030.00 / RM 560.00. A refund of
  -- IDR 2,000,029.00 does not clear it: round(560.00812) = 560.01 at the rate, more than the 560.00 in credit,
  -- so it carries 560.00. The last IDR 1.00 carries the 0.00 left. Receivable 0.00.
  i_idr2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'currency', 'IDR', 'fx_rate', '0.00028', 'fx_rate_source', 'manual',
                       'fx_rate_provider', 'oanda') || dates,
    '[{"description":"a","quantity":1,"unit_price":1000015,"sst_rate":0},
      {"description":"b","quantity":1,"unit_price":1000015,"sst_rate":0}]'::jsonb);
  perform public.finance_post_invoice(org, i_idr2);
  fails := fails || public.bendahara_check_try('IDR: paid in full as RM 560.00', 'ok',
    format('select public.finance_record_payment_in(%L, %L, %L)', org,
      jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '560'),
      jsonb_build_array(jsonb_build_object('invoice_id', i_idr2, 'amount', 2000030))));
  perform public.finance_issue_credit_note(org, public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', i_idr2, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 1000015)));
  perform public.finance_issue_credit_note(org, public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', i_idr2, 'credit_date', '1999-01-16', 'reason', 'returns', 'amount', 1000015)));
  select balance, balance_myr into r from public.finance_invoice_totals where id = i_idr2;
  if r.balance <> -2000030 or r.balance_myr <> -560.00 then
    fails := fails || format('IDR credits read IDR %s / RM %s, not -2000030 / -560.00', r.balance, r.balance_myr);
  end if;
  fails := fails || public.bendahara_check_try('IDR: IDR 2,000,029.00 refunded as RM 560.00', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', i_idr2, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-20',
                         'reason', 'overpayment', 'amount', 2000029, 'amount_myr', '560')));
  fails := fails || public.bendahara_check_try('IDR: the last IDR 1.00 refunded as RM 0.01', 'ok',
    format('select public.finance_record_refund(%L, %L)', org,
      jsonb_build_object('invoice_id', i_idr2, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-21',
                         'reason', 'overpayment', 'amount', 1, 'amount_myr', '0.01')));
  select string_agg(a.carried_myr::text, ' ' order by t.txn_date) into t
    from public.finance_allocations a join public.finance_transactions t on t.id = a.transaction_id
   where a.invoice_id = i_idr2 and t.direction = 'out';
  if t is distinct from '560.00 0.00' then
    fails := fails || format('IDR refunds carry %s, not 560.00 0.00', t);
  end if;
  select * into r from public.bendahara_check_receivable(i_idr2);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 then
    fails := fails || format('IDR refunds leave Receivable at %s, the invoice IDR %s / RM %s', r.rec, r.open_foreign, r.open_myr);
  end if;

  -- ==== the SST share from the ringgit lines =============================================
  -- Ten lines of 1 x USD 0.07 at 8% SST, rate 4.2555: each SST round(0.0056) = 0.01, amount_myr
  -- round(0.297885) = 0.30, sst_amount_myr round(0.042555) = 0.04. USD 0.80 with SST 0.10; RM 3.40 with SST
  -- 0.40. A credit note of USD 0.80 clears it (RM 3.40); its SST share is round(3.40 x 0.40 / 3.40) = 0.40
  -- (from the USD lines it would be round(3.40 x 0.10 / 0.80) = 0.43).
  i_sst := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2555,
    (select jsonb_agg(jsonb_build_object('description', 'Bolt ' || g, 'quantity', 1, 'unit_price', 0.07, 'sst_rate', 8))
       from generate_series(1, 10) g));
  perform public.finance_post_invoice(org, i_sst);
  select total, sst, total_myr, sst_myr into r from public.finance_invoice_totals where id = i_sst;
  if r.total <> 0.80 or r.sst <> 0.10 or r.total_myr <> 3.40 or r.sst_myr <> 0.40 then
    fails := fails || format('the ten-line invoice is USD %s (SST %s), RM %s (SST %s)', r.total, r.sst, r.total_myr, r.sst_myr);
  end if;
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_sst, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 0.80));
  perform public.finance_issue_credit_note(org, cn);
  select * into r from public.bendahara_check_entry(cn);
  if r.rec_cr <> 3.40 or r.sst_dr <> 0.40 or r.sales_dr <> 3.00 then
    fails := fails || format('the ten-line credit note posts Cr Receivable %s, Dr SST %s, Dr Sales %s (not 3.40 / 0.40 / 3.00)',
      r.rec_cr, r.sst_dr, r.sales_dr);
  end if;

  -- ==== FIN48: a payment a later credit note leans on is not voided =======================
  -- The three-line invoice (RM 425.52) paid in full, USD 99.99 as RM 430.00 (closing: carried 425.52). A credit
  -- note of USD 99.99 on the paid invoice takes round(99.99 x 4.2555) = 425.51. Voiding the payment then would
  -- leave RM 0.01 on Receivable for ever, so it is refused. The way through: void the credit note, void the
  -- payment, issue the credit note again (it clears the invoice: 425.52). Receivable 0.00.
  i_s2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2555, three_lines);
  perform public.finance_post_invoice(org, i_s2);
  pay2 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '430'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_s2, 'amount', 99.99)));
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_s2, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 99.99));
  perform public.finance_issue_credit_note(org, cn2);
  select amount_myr into r from public.finance_credit_notes where id = cn2;
  if r.amount_myr is distinct from 425.51 then fails := fails || format('FIN48 case: the credit note takes RM %s, not 425.51', r.amount_myr); end if;
  fails := fails || public.bendahara_check_try('FIN48: the payment is voided under a later credit note', 'FIN48',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', pay2));
  fails := fails || public.bendahara_check_try('FIN48 way through: the credit note voided', 'ok',
    format('update public.finance_credit_notes set status = %L, updated_at = now() where id = %L', 'void', cn2));
  fails := fails || public.bendahara_check_try('FIN48 way through: the payment voided', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', pay2));
  cn2 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_s2, 'credit_date', '1999-01-16', 'reason', 'returns', 'amount', 99.99));
  perform public.finance_issue_credit_note(org, cn2);
  select amount_myr into r from public.finance_credit_notes where id = cn2;
  if r.amount_myr is distinct from 425.52 then fails := fails || format('FIN48 way through: the credit note again takes RM %s, not 425.52', r.amount_myr); end if;
  select * into r from public.bendahara_check_receivable(i_s2);
  if r.rec <> 0 or r.open_foreign <> 0 or r.open_myr <> 0 then
    fails := fails || format('FIN48 way through leaves Receivable at %s, the invoice USD %s / RM %s', r.rec, r.open_foreign, r.open_myr);
  end if;
  -- A ringgit payment with a later credit note is voided as before.
  i_myr2 := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), myr_line);
  perform public.finance_post_invoice(org, i_myr2);
  pay2 := public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_myr2, 'amount', 132.50)));
  perform public.finance_issue_credit_note(org, public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', i_myr2, 'credit_date', current_date + 1, 'reason', 'returns', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a ringgit payment voided under a later credit note', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', pay2));
  -- FIN48 is about money in only: a foreign REFUND voided under a credit note issued after it is voided as
  -- before. USD 100.00 at 4.2 paid in full, credited USD 20.00 (on the paid invoice: RM 84.00), USD 10.00 refunded
  -- against the invoice as RM 40.00, then another credit note of USD 10.00 issued: the refund is still voided.
  i_r2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2, hundred);
  perform public.finance_post_invoice(org, i_r2);
  perform public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-12', 'amount_myr', '420'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_r2, 'amount', 100)));
  perform public.finance_issue_credit_note(org, public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', i_r2, 'credit_date', '1999-01-13', 'reason', 'returns', 'amount', 20)));
  rf3 := public.finance_record_refund(org,
    jsonb_build_object('invoice_id', i_r2, 'account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-14',
                       'reason', 'overpayment', 'amount', 10, 'amount_myr', '40'));
  perform public.finance_issue_credit_note(org, public.finance_save_credit_note(org,
    jsonb_build_object('invoice_id', i_r2, 'credit_date', '1999-01-15', 'reason', 'returns', 'amount', 10)));
  fails := fails || public.bendahara_check_try('a foreign refund voided under a later credit note', 'ok',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', rf3));
  -- The date arm: a credit note issued BEFORE the payment (issued_at a day earlier) but DATED after it still
  -- refuses the payment's void (FIN48). USD 100.00 at 4.2, credit note USD 10.00 dated 1999-02-01 and issued
  -- yesterday while the invoice was unpaid, then USD 90.00 paid on 1999-01-20 as RM 378.00.
  i_r3 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust) || dates || usd_at_4_2, hundred);
  perform public.finance_post_invoice(org, i_r3);
  cn3 := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_r3, 'credit_date', '1999-02-01', 'reason', 'returns', 'amount', 10));
  fails := fails || public.bendahara_check_try('the date arm: a credit note issued yesterday', 'ok',
    format('update public.finance_credit_notes set status = %L, credit_note_no = %L, issued_at = now() - interval %L, updated_at = now() where id = %L',
      'issued', 'CN-FX3C-DATE', '1 day', cn3));
  select status, amount_myr into r from public.finance_credit_notes where id = cn3;
  if r.status is distinct from 'issued' or r.amount_myr is distinct from 42.00 then
    fails := fails || format('the date-arm credit note is %s with RM %s, not issued with 42.00', r.status, r.amount_myr);
  end if;
  pay3 := public.finance_record_payment_in(org,
    jsonb_build_object('account_id', bank, 'method', 'fpx', 'txn_date', '1999-01-20', 'amount_myr', '378'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_r3, 'amount', 90)));
  fails := fails || public.bendahara_check_try('FIN48: a payment voided under a credit note issued before it but dated after', 'FIN48',
    format('update public.finance_transactions set status = %L, updated_at = now() where id = %L', 'void', pay3));

  -- ==== ringgit: a credit note and a refund are what they always were ==============
  i_myr := public.finance_save_invoice(org,
    jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30), myr_line);
  perform public.finance_post_invoice(org, i_myr);
  perform public.finance_record_payment_in(org, jsonb_build_object('account_id', bank, 'method', 'fpx'),
    jsonb_build_array(jsonb_build_object('invoice_id', i_myr, 'amount', 132.50)));
  cn_myr := public.finance_save_credit_note(org, jsonb_build_object('invoice_id', i_myr, 'reason', 'returns', 'amount', 53));
  perform public.finance_issue_credit_note(org, cn_myr);
  select currency, fx_rate, amount_myr into r from public.finance_credit_notes where id = cn_myr;
  if r.currency <> 'MYR' or r.fx_rate <> 1 or r.amount_myr is not null then
    fails := fails || format('a ringgit credit note is %s at %s with RM %s', r.currency, r.fx_rate, r.amount_myr);
  end if;
  select * into r from public.bendahara_check_entry(cn_myr);
  -- 53.00 x 7.50 / 132.50 = 3.00 SST.
  if r.sales_dr <> 50.00 or r.sst_dr <> 3.00 or r.rec_cr <> 53.00 then
    fails := fails || format('a ringgit credit note posts Dr Sales %s, Dr SST %s, Cr Receivable %s', r.sales_dr, r.sst_dr, r.rec_cr);
  end if;
  select amount_myr into r from public.finance_credit_note_totals where id = cn_myr;
  if r.amount_myr is distinct from 53.00 then fails := fails || format('Credit Notes reads the ringgit one as RM %s', r.amount_myr); end if;
  -- A ringgit refund: amount_myr sent is ignored, the payment is its split; and it may still be scheduled.
  rf_myr := public.finance_record_refund(org,
    jsonb_build_object('credit_note_id', cn_myr, 'account_id', bank, 'method', 'fpx', 'amount', 20, 'amount_myr', '999',
                       'status', 'scheduled'));
  select t.amount, t.status, a.amount_myr, a.carried_myr into r
    from public.finance_transactions t join public.finance_allocations a on a.transaction_id = t.id where t.id = rf_myr;
  if r.amount <> 20.00 or r.status <> 'scheduled' or r.amount_myr is not null or r.carried_myr is not null then
    fails := fails || format('a ringgit refund is RM %s (%s) with ringgit figures %s / %s', r.amount, r.status, r.amount_myr, r.carried_myr);
  end if;
  select currency, amount_myr, carried_myr, realised_myr into r from public.finance_refunds where transaction_id = rf_myr;
  if r.currency <> 'MYR' or r.amount_myr <> 20.00 or r.carried_myr <> 20.00 or r.realised_myr <> 0 then
    fails := fails || format('Refunds reads the ringgit refund as %s RM %s / %s / %s', r.currency, r.amount_myr, r.carried_myr, r.realised_myr);
  end if;
  perform public.finance_mark_payment_paid(org, rf_myr, current_date);
  select * into r from public.bendahara_check_entry(rf_myr);
  if r.rec_dr <> 20.00 or r.bank_cr <> 20.00 or r.fx_dr <> 0 or r.fx_cr <> 0 then
    fails := fails || format('a ringgit refund posts Dr Receivable %s, Cr Bank %s, Realised %s/%s', r.rec_dr, r.bank_cr, r.fx_dr, r.fx_cr);
  end if;
  select balance, balance_myr, credited, refunded into r from public.finance_invoice_totals where id = i_myr;
  if r.balance <> -33.00 or r.balance_myr <> -33.00 or r.credited <> 53.00 or r.refunded <> 20.00 then
    fails := fails || format('the ringgit invoice reads %s / %s, credited %s, refunded %s', r.balance, r.balance_myr, r.credited, r.refunded);
  end if;

  -- The whole workspace balances, every line of it.
  select sum(debit) as dr, sum(credit) as cr into r from public.finance_ledger_lines where org_id = org;
  if r.dr <> r.cr then fails := fails || format('the workspace''s ledger does not balance: Dr %s, Cr %s', r.dr, r.cr); end if;

  -- ==== the workspace is deleted ======================================================
  reset role;
  perform set_config('request.jwt.claims', '', true);
  delete from public.orgs where id = org;
  select count(*) into n from public.finance_credit_notes where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s credit notes', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_FX_CREDIT_NOTES_REFUNDS_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_FX_CREDIT_NOTES_REFUNDS_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
