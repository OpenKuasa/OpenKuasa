-- Bendahara document discount check (#272). Run it after
-- 20261125110000_bendahara_document_discount.sql and
-- 20261125110100_bendahara_document_discount_saves.sql, in the same transaction for a
-- dry run, or by itself once applied. It leaves nothing behind either way: the
-- block always ends with RAISE, so every row and the helper function below are
-- rolled back. Read the message:
--   BENDAHARA_DOCUMENT_DISCOUNT_CHECK PASSED ...   or   ... FAILED: <what went wrong>
--
-- Case 1 (every existing line's figures unchanged) compares against a snapshot
-- taken before the migration in the same transaction:
--   begin;
--   create temp table disc_lines_before as
--     select 'invoice' as kind, id, amount, sst_amount, amount_myr, sst_amount_myr from public.finance_invoice_lines
--     union all
--     select 'quotation', id, amount, sst_amount, amount_myr, sst_amount_myr from public.finance_quotation_lines;
--   \i supabase/migrations/20261125110000_bendahara_document_discount.sql
--   \i supabase/tests/bendahara_document_discount_check.sql
--   rollback;
-- Without the snapshot (run after the apply) it checks instead that every line
-- with no share carries exactly the figures of the expressions before it.
--
-- It acts as a workspace's owner the way the app does (the authenticated role
-- with that person's id in request.jwt.claims, at aal2). FIN62 is deferred to
-- commit, which this block never reaches, so it is observed with
-- "set constraints all immediate" inside the try.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  owner_claims text;
  cust uuid;
  i2 uuid; q2 uuid; q6 uuid; q7 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid; i7 uuid; i8 uuid; i9 uuid; q9 uuid; ie uuid;
  i11 uuid; q12 uuid; i12 uuid; i13 uuid;
  n integer;
  t text;
  t2 text;
  r record;
  fails text[] := '{}';
  three_lines jsonb := '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":8},
                         {"description":"B","quantity":1,"unit_price":50,"sst_rate":6},
                         {"description":"C","quantity":1,"unit_price":0.01,"sst_rate":0}]';
  tens jsonb := '[{"description":"A","quantity":1,"unit_price":10,"sst_rate":0},
                  {"description":"B","quantity":1,"unit_price":10,"sst_rate":0},
                  {"description":"C","quantity":1,"unit_price":10,"sst_rate":0}]';
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

  -- ==== 1: every existing line's figures are unchanged =================================
  if to_regclass('pg_temp.disc_lines_before') is not null then
    select count(*) into n from (
      (select * from pg_temp.disc_lines_before
       except
       select 'invoice', id, amount, sst_amount, amount_myr, sst_amount_myr from public.finance_invoice_lines
       except
       select 'quotation', id, amount, sst_amount, amount_myr, sst_amount_myr from public.finance_quotation_lines)
      union all
      (select 'invoice', id, amount, sst_amount, amount_myr, sst_amount_myr from public.finance_invoice_lines
       union all
       select 'quotation', id, amount, sst_amount, amount_myr, sst_amount_myr from public.finance_quotation_lines
       except
       select * from pg_temp.disc_lines_before)
    ) x;
    if n <> 0 then fails := fails || format('1: %s lines differ from the snapshot taken before the migration', n); end if;
    select count(*) into n from pg_temp.disc_lines_before;
    raise notice '1: % lines compared with the snapshot', n;
  else
    raise notice '1: no snapshot; comparing lines with no share against the expressions before the migration';
  end if;
  -- Either way: a line with no share carries the figures of 20261118100000 / 20261119160000 / 20261120100000.
  select count(*) into n from (
    select amount, sst_amount, amount_myr, sst_amount_myr, quantity, unit_price, discount_pct, discount_amount, sst_rate, fx_rate
      from public.finance_invoice_lines where doc_discount_share = 0
    union all
    select amount, sst_amount, amount_myr, sst_amount_myr, quantity, unit_price, discount_pct, discount_amount, sst_rate, fx_rate
      from public.finance_quotation_lines where doc_discount_share = 0
  ) l
  cross join lateral (
    select case
      when l.discount_pct is not null then l.quantity * l.unit_price * (1 - l.discount_pct / 100)
      when l.discount_amount is not null then greatest(l.quantity * l.unit_price - l.discount_amount, 0)
      else l.quantity * l.unit_price
    end as v
  ) e
  where l.amount is distinct from round(e.v, 2)
     or l.sst_amount is distinct from round(e.v * l.sst_rate / 100, 2)
     or l.amount_myr is distinct from round(round(e.v, 2) * l.fx_rate, 2)
     or l.sst_amount_myr is distinct from round(round(e.v * l.sst_rate / 100, 2) * l.fx_rate, 2);
  if n <> 0 then fails := fails || format('1: %s lines with no share differ from the earlier expressions', n); end if;

  -- ---- a workspace and its owner ----------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    owner_id || '@disc.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (org, 'Document Discount Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Discount Ltd', true) returning id into cust;

  -- ==== 2: the split, on an invoice and on a quotation ==================================
  i2 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 2'), three_lines);
  update public.finance_invoices set doc_discount_pct = 10 where id = i2;
  select string_agg(doc_discount_share || ':' || amount || ':' || sst_amount, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i2;
  if t is distinct from '10.00:90.00:7.20 / 5.00:45.00:2.70 / 0.00:0.01:0.00' then
    fails := fails || format('2: the invoice lines read %s', t);
  end if;
  q2 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30, 'notes', 'case 2'), three_lines);
  update public.finance_quotations set doc_discount_pct = 10 where id = q2;
  select string_agg(doc_discount_share || ':' || amount || ':' || sst_amount, ' / ' order by position) into t
    from public.finance_quotation_lines where quotation_id = q2;
  if t is distinct from '10.00:90.00:7.20 / 5.00:45.00:2.70 / 0.00:0.01:0.00' then
    fails := fails || format('2: the quotation lines read %s', t);
  end if;
  select subtotal, sst into r from public.finance_invoice_totals where id = i2;
  if r.subtotal is distinct from 135.01 or r.sst is distinct from 9.90 then
    fails := fails || format('2: the invoice totals read %s + %s, not 135.01 + 9.90', r.subtotal, r.sst);
  end if;

  -- ==== 3: the sen left over go to the lowest position ===================================
  i3 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 3'), tens);
  update public.finance_invoices set doc_discount_amount = 0.10 where id = i3;
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i3;
  if t is distinct from '0.04 / 0.03 / 0.03' then fails := fails || format('3: the shares read %s', t); end if;

  -- ==== 4: after a line's own discount ====================================================
  i4 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 4'),
    '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":8,"discount_pct":5}]');
  update public.finance_invoices set doc_discount_pct = 10 where id = i4;
  select doc_discount_share || ':' || amount || ':' || sst_amount into t
    from public.finance_invoice_lines where invoice_id = i4;
  if t is distinct from '9.50:85.50:6.84' then fails := fails || format('4: the line reads %s, not 9.50:85.50:6.84', t); end if;

  -- ==== 5: a USD invoice at 4.2 ==============================================================
  i5 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 5', 'currency', 'USD', 'fx_rate', '4.2',
    'fx_rate_source', 'manual', 'fx_rate_provider', 'reuters'),
    '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":8}]');
  update public.finance_invoices set doc_discount_pct = 10 where id = i5;
  select amount || ':' || sst_amount || ':' || amount_myr || ':' || sst_amount_myr into t
    from public.finance_invoice_lines where invoice_id = i5;
  if t is distinct from '90.00:7.20:378.00:30.24' then
    fails := fails || format('5: the USD line reads %s, not 90.00:7.20:378.00:30.24', t);
  end if;

  -- ==== 6: the lines deleted and inserted again, as a save does ==============================
  i6 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 6'), three_lines);
  update public.finance_invoices set doc_discount_amount = 15 where id = i6;
  fails := fails || public.bendahara_check_try('6: the lines deleted and inserted again', 'ok',
    format($q$
      delete from public.finance_invoice_lines where invoice_id = %1$L;
      insert into public.finance_invoice_lines (org_id, invoice_id, position, description, quantity, unit_price, sst_rate)
      values (%2$L, %1$L, 1, 'A', 1, 10, 0), (%2$L, %1$L, 2, 'B', 1, 10, 0), (%2$L, %1$L, 3, 'C', 1, 10, 0)
    $q$, i6, org));
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i6;
  if t is distinct from '5.00 / 5.00 / 5.00' then fails := fails || format('6: the shares read %s after the save', t); end if;
  q6 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30, 'notes', 'case 6'), three_lines);
  update public.finance_quotations set doc_discount_amount = 15 where id = q6;
  fails := fails || public.bendahara_check_try('6: a quotation''s lines deleted and inserted again', 'ok',
    format($q$
      delete from public.finance_quotation_lines where quotation_id = %1$L;
      insert into public.finance_quotation_lines (org_id, quotation_id, position, description, quantity, unit_price, sst_rate)
      values (%2$L, %1$L, 1, 'A', 1, 10, 0), (%2$L, %1$L, 2, 'B', 1, 10, 0), (%2$L, %1$L, 3, 'C', 1, 10, 0)
    $q$, q6, org));
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_quotation_lines where quotation_id = q6;
  if t is distinct from '5.00 / 5.00 / 5.00' then fails := fails || format('6: the quotation shares read %s after the save', t); end if;

  -- ==== 7: a share a caller sends is ignored =================================================
  i7 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 7'), tens);
  update public.finance_invoices set doc_discount_amount = 3 where id = i7;
  insert into public.finance_invoice_lines (org_id, invoice_id, position, description, quantity, unit_price, sst_rate, doc_discount_share)
  values (org, i7, 4, 'D', 1, 10, 0, 99);
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i7;
  if t is distinct from '0.75 / 0.75 / 0.75 / 0.75' then fails := fails || format('7: after a sent share of 99 the shares read %s', t); end if;
  update public.finance_invoice_lines set doc_discount_share = 5 where invoice_id = i7 and position = 1;
  update public.finance_invoice_lines set doc_discount_share = 5, quantity = 2 where invoice_id = i7 and position = 2;
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i7;
  -- 3.00 over nets 10 / 20 / 10 / 10.
  if t is distinct from '0.60 / 1.20 / 0.60 / 0.60' then fails := fails || format('7: after a share written by hand the shares read %s', t); end if;
  -- The split's flag set by a caller does not let a share through: the caller is not inside a trigger.
  perform set_config('openkuasa.doc_discount_split', '1', true);
  update public.finance_invoice_lines set doc_discount_share = 5 where invoice_id = i7 and position = 1;
  perform set_config('openkuasa.doc_discount_split', '', true);
  select doc_discount_share::text into t from public.finance_invoice_lines where invoice_id = i7 and position = 1;
  if t is distinct from '0.60' then fails := fails || format('7: with the flag forged a share was written: %s', t); end if;
  q7 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30, 'notes', 'case 7'), tens);
  update public.finance_quotations set doc_discount_amount = 3 where id = q7;
  insert into public.finance_quotation_lines (org_id, quotation_id, position, description, quantity, unit_price, sst_rate, doc_discount_share)
  values (org, q7, 4, 'D', 1, 10, 0, 99);
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_quotation_lines where quotation_id = q7;
  if t is distinct from '0.75 / 0.75 / 0.75 / 0.75' then fails := fails || format('7: a quotation after a sent share of 99 reads %s', t); end if;
  update public.finance_quotation_lines set doc_discount_share = 5 where quotation_id = q7 and position = 1;
  update public.finance_quotation_lines set doc_discount_share = 5, quantity = 2 where quotation_id = q7 and position = 2;
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_quotation_lines where quotation_id = q7;
  if t is distinct from '0.60 / 1.20 / 0.60 / 0.60' then fails := fails || format('7: a quotation after a share written by hand reads %s', t); end if;

  -- ==== the half-sen line: its whole net as its share leaves 0.00, not -0.01 ======================
  ie := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'half sen'),
    '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":8},{"description":"B","quantity":0.5,"unit_price":0.01,"sst_rate":8}]');
  update public.finance_invoices set doc_discount_amount = 60 where id = ie;
  select string_agg(doc_discount_share || ':' || amount || ':' || sst_amount, ' / ' order by position), sum(amount) into r
    from public.finance_invoice_lines where invoice_id = ie;
  if r.string_agg is distinct from '59.99:40.01:3.20 / 0.01:0.00:0.00' or r.sum is distinct from 40.01 then
    fails := fails || format('half sen: the lines read %s (sum %s, not 40.01)', r.string_agg, r.sum);
  end if;

  -- ==== 9: a posted invoice and a sent quotation are frozen ========================================
  i9 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 9'), three_lines);
  fails := fails || public.bendahara_check_try('9: a draft posted while its discount changes', 'FIN01',
    format('update public.finance_invoices set doc_discount_pct = 10, status = %L, invoice_no = %L, posted_at = now() where id = %L',
      'posted', 'DISC-CHECK-9', i9));
  update public.finance_invoices set doc_discount_pct = 10 where id = i9;
  perform public.finance_post_invoice(org, i9);
  select status into t from public.finance_invoices where id = i9;
  if t <> 'posted' then fails := fails || format('9: the invoice is %s, not posted', t); end if;
  fails := fails || public.bendahara_check_try('9: a posted invoice''s discount', 'FIN01',
    format('update public.finance_invoices set doc_discount_pct = 20 where id = %L', i9));
  fails := fails || public.bendahara_check_try('9: clearing a posted invoice''s discount', 'FIN01',
    format('update public.finance_invoices set doc_discount_pct = null where id = %L', i9));
  fails := fails || public.bendahara_check_try('9: a posted invoice''s line', 'FIN01',
    format('update public.finance_invoice_lines set quantity = 2 where invoice_id = %L', i9));
  fails := fails || public.bendahara_check_try('9: a line added to a posted invoice', 'FIN01',
    format('insert into public.finance_invoice_lines (org_id, invoice_id, position, description, quantity, unit_price) values (%L, %L, 9, %L, 1, 1)',
      org, i9, 'X'));
  fails := fails || public.bendahara_check_try('9: a posted invoice''s share', 'FIN01',
    format('update public.finance_invoice_lines set doc_discount_share = 0 where invoice_id = %L', i9));
  select string_agg(doc_discount_share::text, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i9;
  if t is distinct from '10.00 / 5.00 / 0.00' then fails := fails || format('9: the posted shares read %s', t); end if;
  q9 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30, 'notes', 'case 9'), three_lines);
  update public.finance_quotations set doc_discount_amount = 1 where id = q9;
  perform public.finance_send_quotation(org, q9);
  fails := fails || public.bendahara_check_try('9: a sent quotation''s discount', 'FIN01',
    format('update public.finance_quotations set doc_discount_amount = 2 where id = %L', q9));
  fails := fails || public.bendahara_check_try('9: a sent quotation''s line', 'FIN01',
    format('update public.finance_quotation_lines set unit_price = 1 where quotation_id = %L', q9));

  -- ==== 10: the discount cleared ============================================================
  update public.finance_invoices set doc_discount_pct = null where id = i2;
  update public.finance_quotations set doc_discount_pct = null where id = q2;
  select count(*) into n from (
    select doc_discount_share from public.finance_invoice_lines where invoice_id = i2
    union all
    select doc_discount_share from public.finance_quotation_lines where quotation_id = q2
  ) x where doc_discount_share <> 0;
  if n <> 0 then fails := fails || format('10: %s shares are left after the discount was cleared', n); end if;
  select string_agg(amount || ':' || sst_amount, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i2;
  if t is distinct from '100.00:8.00 / 50.00:3.00 / 0.01:0.00' then fails := fails || format('10: the cleared lines read %s', t); end if;

  -- ==== 11: the save functions carry the discount (20261125110100) ==============================
  i11 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 11', 'doc_discount_pct', 10), three_lines);
  select string_agg(doc_discount_share || ':' || amount || ':' || sst_amount, ' / ' order by position) into t
    from public.finance_invoice_lines where invoice_id = i11;
  if t is distinct from '10.00:90.00:7.20 / 5.00:45.00:2.70 / 0.00:0.01:0.00' then
    fails := fails || format('11: saved with 10%%, the invoice lines read %s', t);
  end if;
  -- Saved again without the keys and with other lines: the discount is kept and split over them.
  perform public.finance_save_invoice(org, jsonb_build_object('id', i11, 'customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 11 again'), tens);
  select i.doc_discount_pct || ':' || coalesce(i.doc_discount_amount::text, '-') || ' ' ||
         string_agg(l.doc_discount_share::text, ' / ' order by l.position) into t
    from public.finance_invoices i join public.finance_invoice_lines l on l.invoice_id = i.id
   where i.id = i11 group by i.doc_discount_pct, i.doc_discount_amount;
  if t is distinct from '10.00:- 1.00 / 1.00 / 1.00' then
    fails := fails || format('11: saved without the keys, the invoice reads %s', t);
  end if;
  -- Only the fixed amount sent: the percentage is cleared with it.
  perform public.finance_save_invoice(org, jsonb_build_object('id', i11, 'customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 11', 'doc_discount_amount', 15), three_lines);
  select coalesce(i.doc_discount_pct::text, '-') || ':' || i.doc_discount_amount || ' ' ||
         string_agg(l.doc_discount_share::text, ' / ' order by l.position) into t
    from public.finance_invoices i join public.finance_invoice_lines l on l.invoice_id = i.id
   where i.id = i11 group by i.doc_discount_pct, i.doc_discount_amount;
  if t is distinct from '-:15.00 10.00 / 5.00 / 0.00' then
    fails := fails || format('11: saved with a fixed amount only, the invoice reads %s', t);
  end if;
  -- FIN62 from the function itself, not at commit (no "set constraints all immediate" here).
  fails := fails || public.bendahara_check_try('11: a new invoice whose fixed discount equals its lines', 'FIN62',
    format('select public.finance_save_invoice(%L, %L::jsonb, %L::jsonb)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30,
        'notes', 'case 11 fin62', 'doc_discount_amount', 150.01), three_lines));
  fails := fails || public.bendahara_check_try('11: a new invoice at 100%', 'FIN62',
    format('select public.finance_save_invoice(%L, %L::jsonb, %L::jsonb)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30,
        'notes', 'case 11 fin62', 'doc_discount_pct', 100), three_lines));
  fails := fails || public.bendahara_check_try('11: a draft''s kept discount over its new lines', 'FIN62',
    format('select public.finance_save_invoice(%L, %L::jsonb, %L::jsonb)', org,
      jsonb_build_object('id', i11, 'customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30,
        'notes', 'case 11 fin62'),
      '[{"description":"A","quantity":1,"unit_price":20,"sst_rate":0,"discount_amount":5.5}]'));
  fails := fails || public.bendahara_check_try('11: a new quotation whose fixed discount is over its lines', 'FIN62',
    format('select public.finance_save_quotation(%L, %L::jsonb, %L::jsonb)', org,
      jsonb_build_object('customer_id', cust, 'quote_date', current_date, 'valid_until', current_date + 30,
        'notes', 'case 11 fin62', 'doc_discount_amount', 200), three_lines));
  select count(*) into n from public.finance_invoices where org_id = org and notes = 'case 11 fin62';
  if n <> 0 then fails := fails || format('11: %s invoices were written by refused saves', n); end if;
  select doc_discount_amount into r from public.finance_invoices where id = i11;
  if r.doc_discount_amount is distinct from 15.00 then
    fails := fails || format('11: after a refused save the discount reads %s, not 15.00', r.doc_discount_amount);
  end if;
  -- Explicit nulls clear it.
  perform public.finance_save_invoice(org, jsonb_build_object('id', i11, 'customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 11', 'doc_discount_pct', null, 'doc_discount_amount', null), three_lines);
  select num_nonnulls(i.doc_discount_pct, i.doc_discount_amount) || ' ' ||
         string_agg(l.doc_discount_share || ':' || l.amount || ':' || l.sst_amount, ' / ' order by l.position) into t
    from public.finance_invoices i join public.finance_invoice_lines l on l.invoice_id = i.id
   where i.id = i11 group by i.doc_discount_pct, i.doc_discount_amount;
  if t is distinct from '0 0.00:100.00:8.00 / 0.00:50.00:3.00 / 0.00:0.01:0.00' then
    fails := fails || format('11: saved with explicit nulls, the invoice reads %s', t);
  end if;

  -- ==== 12: a quotation saved with 10%, kept, sent, accepted and converted ==========================
  q12 := public.finance_save_quotation(org, jsonb_build_object('customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30, 'notes', 'case 12', 'doc_discount_pct', 10), three_lines);
  perform public.finance_save_quotation(org, jsonb_build_object('id', q12, 'customer_id', cust, 'quote_date', current_date,
    'valid_until', current_date + 30, 'notes', 'case 12'), three_lines);
  select string_agg(doc_discount_share || ':' || amount || ':' || sst_amount || ':' || amount_myr || ':' || sst_amount_myr,
    ' / ' order by position) into t
    from public.finance_quotation_lines where quotation_id = q12;
  if t is distinct from '10.00:90.00:7.20:90.00:7.20 / 5.00:45.00:2.70:45.00:2.70 / 0.00:0.01:0.00:0.01:0.00' then
    fails := fails || format('12: the quotation lines read %s', t);
  end if;
  perform public.finance_send_quotation(org, q12);
  update public.finance_quotations set status = 'accepted', accepted_at = now() where id = q12;
  i12 := public.finance_convert_quotation(org, q12, current_date);
  select coalesce(doc_discount_pct::text, '-') || ':' || coalesce(doc_discount_amount::text, '-') into t2
    from public.finance_invoices where id = i12;
  if t2 is distinct from '10.00:-' then fails := fails || format('12: the converted invoice''s discount reads %s', t2); end if;
  select string_agg(doc_discount_share || ':' || amount || ':' || sst_amount || ':' || amount_myr || ':' || sst_amount_myr,
    ' / ' order by position) into t2
    from public.finance_invoice_lines where invoice_id = i12;
  if t2 is distinct from t then fails := fails || format('12: the converted invoice''s lines read %s, the quotation''s %s', t2, t); end if;
  select subtotal, sst into r from public.finance_invoice_totals where id = i12;
  if r.subtotal is distinct from 135.01 or r.sst is distinct from 9.90 then
    fails := fails || format('12: the converted invoice''s totals read %s + %s, not 135.01 + 9.90', r.subtotal, r.sst);
  end if;

  -- ==== 13: the early check reads the json at the columns' scales ================================
  -- A line discount of 9.995 is stored as 10.00 (numeric(14,2)), so the line nets 20 - 10.00 = 10.00,
  -- not round(20 - 9.995, 2) = 10.01. A fixed discount of 10.00 takes all of it: FIN62 from the function
  -- (no "set constraints all immediate"). 9.99 leaves 0.01, and the stored figures agree.
  fails := fails || public.bendahara_check_try('13: a fixed discount equal to a net worked out at the stored scale', 'FIN62',
    format('select public.finance_save_invoice(%L, %L::jsonb, %L::jsonb)', org,
      jsonb_build_object('customer_id', cust, 'invoice_date', current_date, 'due_date', current_date + 30,
        'notes', 'case 13', 'doc_discount_amount', 10),
      '[{"description":"A","quantity":1,"unit_price":20,"sst_rate":0,"discount_amount":9.995}]'));
  i13 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 13', 'doc_discount_amount', 9.99),
    '[{"description":"A","quantity":1,"unit_price":20,"sst_rate":0,"discount_amount":9.995}]');
  select discount_amount || ':' || doc_discount_share || ':' || amount into t
    from public.finance_invoice_lines where invoice_id = i13;
  if t is distinct from '10.00:9.99:0.01' then
    fails := fails || format('13: the line reads %s, not 10.00:9.99:0.01', t);
  end if;

  -- ---- both at once, and out of range -----------------------------------------------------------
  fails := fails || public.bendahara_check_try('a percentage and a fixed amount together', '23514',
    format('update public.finance_invoices set doc_discount_pct = 5, doc_discount_amount = 1 where id = %L', i3));
  fails := fails || public.bendahara_check_try('a percentage of 0', '23514',
    format('update public.finance_invoices set doc_discount_amount = null, doc_discount_pct = 0 where id = %L', i3));
  fails := fails || public.bendahara_check_try('a percentage over 100', '23514',
    format('update public.finance_invoices set doc_discount_amount = null, doc_discount_pct = 100.01 where id = %L', i3));
  fails := fails || public.bendahara_check_try('a fixed amount of 0', '23514',
    format('update public.finance_invoices set doc_discount_amount = 0 where id = %L', i3));

  -- ==== 8: FIN62 at commit ====================================================================
  -- Everything so far is judged first, and must pass.
  fails := fails || public.bendahara_check_try('8: everything before case 8, at commit', 'ok', 'set constraints all immediate');
  set constraints all deferred;
  i8 := public.finance_save_invoice(org, jsonb_build_object('customer_id', cust, 'invoice_date', current_date,
    'due_date', current_date + 30, 'notes', 'case 8'), three_lines);
  fails := fails || public.bendahara_check_try('8: a fixed discount equal to the lines', 'FIN62',
    format('update public.finance_invoices set doc_discount_amount = 150.01 where id = %L; set constraints all immediate', i8));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: a fixed discount over the lines', 'FIN62',
    format('update public.finance_invoices set doc_discount_amount = 200 where id = %L; set constraints all immediate', i8));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: 100%', 'FIN62',
    format('update public.finance_invoices set doc_discount_pct = 100 where id = %L; set constraints all immediate', i8));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: a quotation at 100%', 'FIN62',
    format('update public.finance_quotations set doc_discount_pct = 100 where id = %L; set constraints all immediate', q2));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: lines cut below a fixed discount', 'FIN62',
    format('update public.finance_invoice_lines set unit_price = 1 where invoice_id = %L; set constraints all immediate', i6));
  set constraints all deferred;
  -- A save that re-inserts fewer lines, leaving D >= the net: the deletes queue the check (inserts queue none).
  fails := fails || public.bendahara_check_try('8: a save that re-inserts fewer lines under a discount', 'FIN62',
    format($q$
      delete from public.finance_invoice_lines where invoice_id = %1$L;
      insert into public.finance_invoice_lines (org_id, invoice_id, position, description, quantity, unit_price, sst_rate)
      values (%2$L, %1$L, 1, 'A', 1, 10, 0);
      set constraints all immediate
    $q$, i6, org));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: a quotation save that re-inserts fewer lines under a discount', 'FIN62',
    format($q$
      delete from public.finance_quotation_lines where quotation_id = %1$L;
      insert into public.finance_quotation_lines (org_id, quotation_id, position, description, quantity, unit_price, sst_rate)
      values (%2$L, %1$L, 1, 'A', 1, 10, 0);
      set constraints all immediate
    $q$, q6, org));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: lines moved out from under a discount', 'FIN62',
    format('update public.finance_invoice_lines set invoice_id = %L where invoice_id = %L; set constraints all immediate', i8, i6));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: lines deleted under a discount', 'FIN62',
    format('delete from public.finance_invoice_lines where invoice_id = %L; set constraints all immediate', i6));
  set constraints all deferred;
  fails := fails || public.bendahara_check_try('8: any discount on lines that net to 0', 'FIN62',
    format('update public.finance_invoice_lines set unit_price = 0 where invoice_id = %L; update public.finance_invoices set doc_discount_pct = 1 where id = %L; set constraints all immediate', i8, i8));
  set constraints all deferred;
  -- Inside the try the split took all of the lines (D at most their sum) and raised nothing until commit.
  fails := fails || public.bendahara_check_try('8: a discount that leaves something', 'ok',
    format('update public.finance_invoices set doc_discount_amount = 150 where id = %L; set constraints all immediate', i8));
  set constraints all deferred;
  select sum(amount), sum(doc_discount_share) into r from public.finance_invoice_lines where invoice_id = i8;
  if r.sum is distinct from 0.01 then fails := fails || format('8: 150 off 150.01 leaves %s', r.sum); end if;

  -- ---- the shares always add up to D --------------------------------------------------------------
  select count(*) into n from public.finance_invoices i
   cross join lateral (
     select coalesce(sum(round(case
         when l.discount_pct is not null then l.quantity * l.unit_price * (1 - l.discount_pct / 100)
         when l.discount_amount is not null then greatest(l.quantity * l.unit_price - l.discount_amount, 0)
         else l.quantity * l.unit_price end, 2)), 0) as s,
       coalesce(sum(l.doc_discount_share), 0) as shares
     from public.finance_invoice_lines l where l.invoice_id = i.id
   ) x
   where i.org_id = org
     and x.shares <> least(coalesce(round(x.s * i.doc_discount_pct / 100, 2), i.doc_discount_amount, 0), x.s);
  if n <> 0 then fails := fails || format('%s invoices have shares that do not add up to their discount', n); end if;

  -- ==== deleting a discounted draft, then the workspace ===============================================
  fails := fails || public.bendahara_check_try('a discounted draft deleted', 'ok',
    format('delete from public.finance_invoices where id = %L; set constraints all immediate', i7));
  set constraints all deferred;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  fails := fails || public.bendahara_check_try('the workspace deleted', 'ok',
    format('delete from public.orgs where id = %L; set constraints all immediate', org));
  set constraints all deferred;
  select count(*) into n from public.finance_invoice_lines where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s invoice lines', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_DOCUMENT_DISCOUNT_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_DOCUMENT_DISCOUNT_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
