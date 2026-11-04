-- Bendahara RFQ split check (#236, 20261202090000_bendahara_rfq_split.sql; case 12 needs 20261202090300 too). Run
-- it after that migration, in the same transaction for a dry run, or by itself
-- once applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper functions below are rolled back. Read the
-- message:
--   BENDAHARA_RFQ_SPLIT_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner, viewer and an outsider the way the app does
-- (the authenticated role with that person's id in request.jwt.claims), and,
-- for the one case that is about the trigger alone, as nobody signed in.
-- Cases are numbered; each group of RFQs is the fixture of the cases under it.
do $$
declare
  org uuid := gen_random_uuid();
  other_org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  owner_claims text;
  viewer_claims text;
  outsider_claims text;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid;
  prod uuid;
  -- Group A: three suppliers quote the same three items; the third also quotes one more; a fourth was asked and
  -- has not answered (and a price was typed on its RFQ, which is not a quote).
  ra1 uuid; ra2 uuid; ra3 uuid; ra4 uuid;
  -- Group C: two lines for one item. T: a tie. S: one quote alone. E: ringgit and dollars, one dollar quote with no rate.
  -- F: two dollar quotes. P: matched by product.
  rc1 uuid; rc2 uuid; rt1 uuid; rt2 uuid; rs1 uuid;
  rn1 uuid; rn2 uuid; rn3 uuid; rn4 uuid;
  re1 uuid; re2 uuid; re3 uuid; rf1 uuid; rf2 uuid; rp1 uuid; rp2 uuid;
  -- W: a copy asks for one more row. U: a dollar quote with no rate, and a ringgit quote for another row.
  rw1 uuid; rw2 uuid; ru1 uuid; ru2 uuid;
  made uuid[];
  po uuid;
  n integer;
  t text;
  aw jsonb;
  fails text[] := '{}';
begin
  begin
  -- A quoted RFQ in one call: saved (lines by position), sent, then quoted with prices[position].
  execute $f$
    create function public.bendahara_split_rfq(o uuid, s uuid, cur text, rate text, src uuid, lines jsonb, prices numeric[], quote boolean default true)
    returns uuid language plpgsql security invoker set search_path = '' as $g$
    declare rid uuid;
    begin
      rid := public.finance_save_rfq(o, jsonb_build_object('supplier_id', s, 'rfq_date', current_date, 'source_rfq_id', src,
        'currency', cur, 'fx_rate', rate, 'fx_rate_source', case when rate is null then null else 'manual' end), lines);
      perform public.finance_send_rfq(o, rid);
      if quote then
        perform public.finance_quote_rfq(o, rid,
          (select jsonb_agg(jsonb_build_object('line_id', l.id, 'unit_price', prices[l.position]) order by l.position)
             from public.finance_rfq_lines l where l.rfq_id = rid), null);
      end if;
      return rid;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_split_rfq(uuid, uuid, text, text, uuid, jsonb, numeric[], boolean) to authenticated';
  -- One award: the RFQ, the positions of its lines to order, a reason.
  execute $f$
    create function public.bendahara_split_aw(rid uuid, pos integer[], why text default null) returns jsonb
    language sql stable security invoker set search_path = '' as $g$
      select jsonb_build_object('rfq_id', rid, 'reason', why,
        'line_ids', (select coalesce(jsonb_agg(l.id order by l.position), '[]'::jsonb)
                       from public.finance_rfq_lines l where l.rfq_id = rid and l.position = any (pos)))
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_split_aw(uuid, integer[], text) to authenticated';
  -- The line of an RFQ at a position.
  execute $f$
    create function public.bendahara_split_line(rid uuid, pos integer) returns uuid
    language sql stable security invoker set search_path = '' as $g$
      select l.id from public.finance_rfq_lines l where l.rfq_id = rid and l.position = pos
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_split_line(uuid, integer) to authenticated';
  -- Runs q; answers null when it ended as `want` says ('ok', a SQLSTATE, or 'error' for any refusal), else what happened.
  execute $f$
    create function public.bendahara_split_try(label text, want text, q text) returns text
    language plpgsql security invoker set search_path = '' as $g$
    declare got text := 'ok';
    begin
      begin
        execute q;
      exception when others then
        got := sqlstate;
      end;
      if got = want or (want = 'error' and got <> 'ok') then return null; end if;
      return format('%s: expected %s, got %s', label, want, got);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_split_try(text, text, text) to authenticated';
  -- Live orders of an RFQ (a cancelled one does not count).
  execute $f$
    create function public.bendahara_split_orders(rid uuid) returns integer
    language sql stable security invoker set search_path = '' as $g$
      select count(*)::integer from public.finance_purchase_orders p where p.rfq_id = rid and p.status <> 'cancelled'
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_split_orders(uuid) to authenticated';
  -- Cancels every draft order of the workspace, so the next case starts with every RFQ free.
  execute $f$
    create function public.bendahara_split_clear(o uuid) returns void
    language sql security invoker set search_path = '' as $g$
      update public.finance_purchase_orders set status = 'cancelled' where org_id = o and status = 'draft'
    $g$
  $f$;
  execute 'grant execute on function public.bendahara_split_clear(uuid) to authenticated';

  -- ---- structure ------------------------------------------------------------
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_purchase_orders'::regclass and not tgisinternal;
  if t is distinct from 'finance_purchase_order_guard,finance_purchase_order_log,finance_purchase_order_reason_lock,finance_purchase_order_to_ringgit' then
    fails := fails || format('triggers on finance_purchase_orders are: %s', t);
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'finance_convert_rfq';
  if n <> 1 then fails := fails || format('there are %s finance_convert_rfq functions', n); end if;
  select a.attname into t from pg_attribute a
   where a.attrelid = 'public.finance_purchase_order_totals'::regclass and a.attnum > 0 and not a.attisdropped
   order by a.attnum desc limit 1;
  if t is distinct from 'award_reason' then fails := fails || format('finance_purchase_order_totals ends with: %s', t); end if;

  -- ---- workspaces, people ---------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    u.id || '@rfq-split.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false
  from unnest(array[owner_id, viewer_id, outsider]) as u(id);
  insert into public.orgs (id, name) values (org, 'RFQ Split Check Sdn Bhd'), (other_org, 'RFQ Split Other Sdn Bhd');
  insert into public.org_members (org_id, user_id, role)
  values (org, owner_id, 'owner'), (org, viewer_id, 'viewer'), (other_org, outsider, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  viewer_claims := json_build_object('sub', viewer_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  outsider_claims := json_build_object('sub', outsider, 'role', 'authenticated', 'aal', 'aal2')::text;

  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Seri Packaging', true) returning id into s1;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Maju Supplies', true) returning id into s2;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Teguh Trading', true) returning id into s3;
  insert into public.finance_contacts (org_id, name, is_supplier) values (org, 'Overseas Ltd', true) returning id into s4;
  insert into public.finance_products (org_id, name, price, sst_rate) values (org, 'Widget', 10, 0) returning id into prod;

  -- ==== fixture A =========================================================================
  -- Row 1 Bolts: 3.00, 3.00 (a tie), 3.50.   Row 2 Press: 700 (no SST), 650 + 8% = 702, 800: the lowest headline price is
  -- not the lowest once SST is paid.   Row 3 Valve: 50, 60, 55.   Extra: R3 alone.
  ra1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null, '[
    {"description":"Bolts","quantity":10,"uom":"pcs","sst_rate":0},
    {"description":"Press","quantity":1,"sst_rate":0},
    {"description":"Valve","quantity":2,"sst_rate":0}]', array[3.00, 700, 50]);
  -- Worded differently: spaces and capitals do not make another item.
  ra2 := public.bendahara_split_rfq(org, s2, 'MYR', null, ra1, '[
    {"description":"  BOLTS ","quantity":10,"uom":"PCS ","sst_rate":0},
    {"description":"press","quantity":1,"sst_rate":8},
    {"description":"Valve   ","quantity":2,"sst_rate":0}]', array[3.00, 650, 60]);
  ra3 := public.bendahara_split_rfq(org, s3, 'MYR', null, ra1, '[
    {"description":"Bolts","quantity":10,"uom":"pcs","sst_rate":0},
    {"description":"Press","quantity":1,"sst_rate":0},
    {"description":"Valve","quantity":2,"sst_rate":0},
    {"description":"Extra","quantity":1,"sst_rate":0}]', array[3.50, 800, 55, 9.00]);
  -- Sent, not answered, in dollars, with a price the buyer typed: none of it is a quote.
  ra4 := public.bendahara_split_rfq(org, s4, 'USD', '4.0000', ra1, '[
    {"description":"Bolts","quantity":10,"uom":"pcs","unit_price":0.01,"sst_rate":0}]', null, false);

  -- ==== 1: a split makes one draft order per supplier, with only the chosen lines =========
  -- Press and Valve to R1 (lowest), Bolts to R2 (a tie at the lowest needs no reason), Extra to R3 (nobody else quoted it).
  select public.finance_award_rfq_lines(org, jsonb_build_array(
    public.bendahara_split_aw(ra1, array[2, 3]), public.bendahara_split_aw(ra2, array[1]), public.bendahara_split_aw(ra3, array[4])))
    into made;
  if cardinality(made) <> 3 then fails := fails || format('1: the split made %s orders', cardinality(made)); end if;
  select count(*) into n from public.finance_purchase_orders where org_id = org and status = 'draft';
  if n <> 3 then fails := fails || format('1: %s draft orders', n); end if;
  select string_agg(format('%s:%s:%s:%s', l.position, l.description, l.quantity, l.unit_price), ',' order by l.position) into t
    from public.finance_purchase_order_lines l where l.purchase_order_id = made[1];
  if t is distinct from '2:Press:1.000:700.0000,3:Valve:2.000:50.0000' then fails := fails || format('1: the first order has %s', t); end if;
  select string_agg(format('%s:%s:%s:%s', l.position, l.description, l.quantity, l.unit_price), ',' order by l.position) into t
    from public.finance_purchase_order_lines l where l.purchase_order_id = made[2];
  if t is distinct from '1:  BOLTS :10.000:3.0000' then fails := fails || format('1: the second order has %s', t); end if;
  select string_agg(format('%s:%s:%s:%s', l.position, l.description, l.quantity, l.unit_price), ',' order by l.position) into t
    from public.finance_purchase_order_lines l where l.purchase_order_id = made[3];
  if t is distinct from '4:Extra:1.000:9.0000' then fails := fails || format('1: the third order has %s', t); end if;
  select string_agg(p.supplier_id::text || '/' || p.rfq_id::text || '/' || p.status || '/' || coalesce(p.award_reason, '-'), ','
                    order by array_position(made, p.id)) into t
    from public.finance_purchase_orders p where p.id = any (made);
  if t is distinct from format('%s/%s/draft/-,%s/%s/draft/-,%s/%s/draft/-', s1, ra1, s2, ra2, s3, ra3) then
    fails := fails || format('1: the orders are %s', t);
  end if;
  perform public.bendahara_split_clear(org);

  -- ==== 2: when a reason is needed on a line ==============================================
  fails := fails || public.bendahara_split_try('2: R3 takes Bolts, which R1 and R2 quoted for less', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra3, array[1]))));
  fails := fails || public.bendahara_split_try('2: R2 takes Press, lowest by headline but not once SST is paid', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra2, array[2]))));
  fails := fails || public.bendahara_split_try('2: a blank reason is none', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra3, array[1], '   '))));
  fails := fails || public.bendahara_split_try('2: R1 takes Press, lowest once SST is paid', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[2]))));
  perform public.bendahara_split_clear(org);
  -- R4 was never quoted: its typed 0.01 for Bolts is nobody's price, so R1 is not above anything but a tie.
  fails := fails || public.bendahara_split_try('2: a price typed on an RFQ nobody answered is no rival', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[1]))));
  perform public.bendahara_split_clear(org);
  -- With a reason it goes through, stored without the spaces around it, and the view shows it.
  select public.finance_award_rfq_lines(org, jsonb_build_array(public.bendahara_split_aw(ra3, array[1], '  faster delivery '))) into made;
  select award_reason into t from public.finance_purchase_order_totals where id = made[1];
  if t is distinct from 'faster delivery' then fails := fails || format('2: the reason reads %L', t); end if;
  perform public.bendahara_split_clear(org);

  -- ==== 3: an award that is not valid ======================================================
  fails := fails || public.bendahara_split_try('3: an empty list', 'FIN76', format('select public.finance_award_rfq_lines(%L, %L)', org, '[]'::jsonb));
  fails := fails || public.bendahara_split_try('3: not a list', 'FIN76', format('select public.finance_award_rfq_lines(%L, %L)', org, '{}'::jsonb));
  fails := fails || public.bendahara_split_try('3: an award with no lines', 'FIN76',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[]::integer[]))));
  fails := fails || public.bendahara_split_try('3: an RFQ named twice', 'FIN76',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[2]), public.bendahara_split_aw(ra1, array[3]))));
  fails := fails || public.bendahara_split_try('3: a line that is on another RFQ', 'FIN76',
    format('select public.finance_award_rfq_lines(%L, %L)', org,
      jsonb_build_array(jsonb_build_object('rfq_id', ra1, 'line_ids', jsonb_build_array(public.bendahara_split_line(ra2, 2))))));
  fails := fails || public.bendahara_split_try('3: an RFQ that is not there', 'FIN11',
    format('select public.finance_award_rfq_lines(%L, %L)', org,
      jsonb_build_array(jsonb_build_object('rfq_id', gen_random_uuid(), 'line_ids', jsonb_build_array(gen_random_uuid())))));
  fails := fails || public.bendahara_split_try('3: an RFQ nobody answered', 'FIN01',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra4, array[1]))));
  -- Bolts to two suppliers: one line goes to one supplier. Both are tied at the lowest, so no reason is in the way.
  fails := fails || public.bendahara_split_try('3: one line given to two suppliers', 'FIN76',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[1]), public.bendahara_split_aw(ra2, array[1]))));
  if public.bendahara_split_orders(ra1) + public.bendahara_split_orders(ra2) <> 0 then fails := fails || '3: a refused award left an order'::text; end if;

  -- ==== 4: all or none ======================================================================
  fails := fails || public.bendahara_split_try('4: the second award needs a reason', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[2]), public.bendahara_split_aw(ra3, array[1]))));
  if public.bendahara_split_orders(ra1) <> 0 then fails := fails || '4: the first order stayed after the second was refused'::text; end if;
  -- R1 has an order; the award that names it and R2 makes none.
  perform public.finance_award_rfq_lines(org, jsonb_build_array(public.bendahara_split_aw(ra1, array[2])));
  fails := fails || public.bendahara_split_try('4: an RFQ that already has an order', 'FIN22',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra2, array[1]), public.bendahara_split_aw(ra1, array[3]))));
  if public.bendahara_split_orders(ra2) <> 0 then fails := fails || '4: R2 has an order after the award was refused'::text; end if;
  fails := fails || public.bendahara_split_try('4: Make purchase order on an RFQ that has an order', 'FIN22',
    format('select public.finance_convert_rfq(%L, %L)', org, ra1));
  -- A cancelled order frees the RFQ.
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('4: a cancelled order frees the RFQ', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[2]))));
  perform public.bendahara_split_clear(org);

  -- ==== 5: Make purchase order, whole RFQ ====================================================
  -- Totals: R1 830.00, R2 852.00 (702 for the press), R3 954.00. R3 asks for a fourth row, so it is compared with the
  -- others on the three rows they share: 945.00 against R1's 830.00.
  fails := fails || public.bendahara_split_try('5: R2 costs more than R1 for the same rows', 'FIN75',
    format('select public.finance_convert_rfq(%L, %L)', org, ra2));
  if public.bendahara_split_orders(ra2) <> 0 then fails := fails || '5: a refused Make purchase order left an order'::text; end if;
  fails := fails || public.bendahara_split_try('5: a blank reason is none', 'FIN75',
    format('select public.finance_convert_rfq(%L, %L, %L)', org, ra2, '  '));
  fails := fails || public.bendahara_split_try('5: R2 with a reason', 'ok',
    format('select public.finance_convert_rfq(%L, %L, %L)', org, ra2, ' its delivery is next day '));
  select award_reason into t from public.finance_purchase_orders where rfq_id = ra2 and status = 'draft';
  if t is distinct from 'its delivery is next day' then fails := fails || format('5: the order reads %L', t); end if;
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('5: R3 asks for one more row, and costs more on the rows it shares', 'FIN75',
    format('select public.finance_convert_rfq(%L, %L)', org, ra3));
  fails := fails || public.bendahara_split_try('5: R3 with a reason', 'ok',
    format('select public.finance_convert_rfq(%L, %L, %L)', org, ra3, 'one order for all four'));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('5: R1 is the lowest, called with two arguments', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, ra1));
  perform public.bendahara_split_clear(org);

  -- ==== 5a: same rows, other quantities; whitespace only JavaScript sees ======================
  -- The first asks for 100, the copy was edited to 10: its total is lower, but it is not the same order.
  rn1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null, '[{"description": "Quantity item", "quantity": 100, "sst_rate": 0}]'::jsonb, array[1.00]);
  rn2 := public.bendahara_split_rfq(org, s2, 'MYR', null, rn1, '[{"description": "Quantity item", "quantity": 10, "sst_rate": 0}]'::jsonb, array[5.00]);
  fails := fails || public.bendahara_split_try('5a: a smaller quantity is not a lower total', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, rn1));
  perform public.bendahara_split_clear(org);
  -- The description is the same item with a U+FEFF, which JavaScript's \s has and Postgres's does not, so the dearer quote needs a reason.
  rn3 := public.bendahara_split_rfq(org, s1, 'MYR', null, null, jsonb_build_array(jsonb_build_object('description', 'Copy paper', 'quantity', 5, 'sst_rate', 0)), array[1.00]);
  rn4 := public.bendahara_split_rfq(org, s2, 'MYR', null, rn3, jsonb_build_array(jsonb_build_object('description', U&'Copy\FEFFpaper', 'quantity', 5, 'sst_rate', 0)), array[2.00]);
  fails := fails || public.bendahara_split_try('5a: a U+FEFF is whitespace, as on the screen', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rn4, array[1]))));
  fails := fails || public.bendahara_split_try('5: and by name', 'ok',
    format('select public.finance_convert_rfq(target_org => %L, target_rfq => %L)', org, ra1));
  select count(*) into n from public.finance_purchase_order_lines l join public.finance_purchase_orders p on p.id = l.purchase_order_id
   where p.rfq_id = ra1 and p.status = 'draft';
  if n <> 3 then fails := fails || format('5: the whole-RFQ order has %s lines', n); end if;
  perform public.bendahara_split_clear(org);

  -- ==== 5b: one more row does not hide a lower price (fixture W) ==============================
  -- W1 asks for Nails and Screws at 10.00 each; its copy W2 asks for both and Glue too, at 5.00 each.
  rw1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null,
    '[{"description":"Nails","quantity":1,"sst_rate":0},{"description":"Screws","quantity":1,"sst_rate":0}]', array[10.00, 10.00]);
  rw2 := public.bendahara_split_rfq(org, s2, 'MYR', null, rw1,
    '[{"description":"Nails","quantity":1,"sst_rate":0},{"description":"Screws","quantity":1,"sst_rate":0},{"description":"Glue","quantity":1,"sst_rate":0}]',
    array[5.00, 5.00, 5.00]);
  fails := fails || public.bendahara_split_try('5b: W1 as a whole costs more on the rows W2 also quoted', 'FIN75',
    format('select public.finance_convert_rfq(%L, %L)', org, rw1));
  fails := fails || public.bendahara_split_try('5b: the same two lines of W1, awarded', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rw1, array[1, 2]))));
  fails := fails || public.bendahara_split_try('5b: W2 as a whole is lower on the rows they share', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, rw2));
  perform public.bendahara_split_clear(org);

  -- ==== 6: two lines for one item (fixture C) ===============================================
  -- Gasket x1 and Gasket x2 on each RFQ; matched in the order entered. R1: 5.00, 4.00; R2: 6.00, 3.00. Totals 13.00 and 12.00.
  rc1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null,
    '[{"description":"Gasket","quantity":1,"sst_rate":0},{"description":"Gasket","quantity":2,"sst_rate":0}]', array[5.00, 4.00]);
  rc2 := public.bendahara_split_rfq(org, s2, 'MYR', null, rc1,
    '[{"description":"gasket","quantity":1,"sst_rate":0},{"description":"GASKET","quantity":2,"sst_rate":0}]', array[6.00, 3.00]);
  fails := fails || public.bendahara_split_try('6: the first Gasket of R1 is the lowest', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rc1, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('6: the second Gasket of R1 is not', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rc1, array[2]))));
  fails := fails || public.bendahara_split_try('6: each Gasket to its lowest', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rc1, array[1]), public.bendahara_split_aw(rc2, array[2]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('6: the same Gasket to both', 'FIN76',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rc1, array[1]), public.bendahara_split_aw(rc2, array[1]))));
  fails := fails || public.bendahara_split_try('6: R1 costs more as a whole', 'FIN75', format('select public.finance_convert_rfq(%L, %L)', org, rc1));
  fails := fails || public.bendahara_split_try('6: R2 costs less as a whole', 'ok', format('select public.finance_convert_rfq(%L, %L)', org, rc2));
  perform public.bendahara_split_clear(org);

  -- ==== 7: a tie, and a quote alone =========================================================
  rt1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null, '[{"description":"Tape","quantity":3,"sst_rate":6}]', array[10.00]);
  rt2 := public.bendahara_split_rfq(org, s2, 'MYR', null, rt1, '[{"description":"Tape","quantity":3,"sst_rate":6}]', array[10.00]);
  rs1 := public.bendahara_split_rfq(org, s3, 'MYR', null, null, '[{"description":"Cable","quantity":1,"sst_rate":0}]', array[99.00]);
  fails := fails || public.bendahara_split_try('7: a tie, as a line', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rt1, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('7: a tie, as a total, R1', 'ok', format('select public.finance_convert_rfq(%L, %L)', org, rt1));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('7: a tie, as a total, R2', 'ok', format('select public.finance_convert_rfq(%L, %L)', org, rt2));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('7: a quote alone, as a line', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rs1, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('7: a quote alone, as a total', 'ok', format('select public.finance_convert_rfq(%L, %L)', org, rs1));
  perform public.bendahara_split_clear(org);

  -- ==== 8: ringgit and dollars (fixture E) ====================================================
  -- Pump: RM 100 (R1), USD 30 at 4.00 = RM 120 (R2), USD 10 with no rate (R3: no ringgit to compare it by).
  re1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null, '[{"description":"Pump","quantity":1,"sst_rate":0}]', array[100.00]);
  re2 := public.bendahara_split_rfq(org, s2, 'USD', '4.0000', re1, '[{"description":"Pump","quantity":1,"sst_rate":0}]', array[30.00]);
  re3 := public.bendahara_split_rfq(org, s4, 'USD', null, re1, '[{"description":"Pump","quantity":1,"sst_rate":0}]', array[10.00]);
  fails := fails || public.bendahara_split_try('8: the ringgit quote is the lowest in ringgit; a quote with no rate is no rival', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(re1, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('8: the dollar quote costs RM 120', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(re2, array[1]))));
  fails := fails || public.bendahara_split_try('8: the quote with no rate cannot be judged, though its number is smallest', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(re3, array[1]))));
  fails := fails || public.bendahara_split_try('8: ... and with a reason it can be chosen', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(re3, array[1], 'only one with stock'))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('8: whole RFQ, the lowest ringgit total', 'ok', format('select public.finance_convert_rfq(%L, %L)', org, re1));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('8: whole RFQ, RM 120 against RM 100', 'FIN75', format('select public.finance_convert_rfq(%L, %L)', org, re2));
  fails := fails || public.bendahara_split_try('8: whole RFQ, no ringgit total', 'FIN75', format('select public.finance_convert_rfq(%L, %L)', org, re3));
  fails := fails || public.bendahara_split_try('8: whole RFQ, no ringgit total, with a reason', 'ok', format('select public.finance_convert_rfq(%L, %L, %L)', org, re3, 'why'));
  perform public.bendahara_split_clear(org);
  -- A group in a single currency other than ringgit: compared as quoted, whatever the rates.
  rf1 := public.bendahara_split_rfq(org, s1, 'USD', '4.0000', null, '[{"description":"Fan","quantity":1,"sst_rate":0}]', array[10.00]);
  rf2 := public.bendahara_split_rfq(org, s2, 'USD', '1.0000', rf1, '[{"description":"Fan","quantity":1,"sst_rate":0}]', array[11.00]);
  fails := fails || public.bendahara_split_try('8: one currency, the lower dollar price', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rf1, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('8: one currency, the higher dollar price', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rf2, array[1]))));
  fails := fails || public.bendahara_split_try('8: one currency, whole RFQ, higher', 'FIN75', format('select public.finance_convert_rfq(%L, %L)', org, rf2));
  fails := fails || public.bendahara_split_try('8: one currency, whole RFQ, lower', 'ok', format('select public.finance_convert_rfq(%L, %L)', org, rf1));
  perform public.bendahara_split_clear(org);

  -- ==== 8b: no rate, but nobody else quoted the row (fixture U) ================================
  -- U1 in dollars with no rate asks for Drill; U2 in ringgit asks for Saw. The group is in two currencies, but nobody
  -- else quoted Drill, so there is nothing to be lower than.
  ru1 := public.bendahara_split_rfq(org, s4, 'USD', null, null, '[{"description":"Drill","quantity":1,"sst_rate":0}]', array[50.00]);
  ru2 := public.bendahara_split_rfq(org, s1, 'MYR', null, ru1, '[{"description":"Saw","quantity":1,"sst_rate":0}]', array[500.00]);
  fails := fails || public.bendahara_split_try('8b: a line with no rate that nobody else quoted', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ru1, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('8b: a whole RFQ with no rate that shares no row', 'ok',
    format('select public.finance_convert_rfq(%L, %L)', org, ru1));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('8b: each to its own supplier', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ru1, array[1]), public.bendahara_split_aw(ru2, array[1]))));
  perform public.bendahara_split_clear(org);

  -- ==== 9: the same product worded differently (fixture P) ====================================
  rp1 := public.bendahara_split_rfq(org, s1, 'MYR', null, null,
    jsonb_build_array(jsonb_build_object('product_id', prod, 'description', 'Widget A', 'quantity', 1, 'sst_rate', 0)), array[10.00]);
  rp2 := public.bendahara_split_rfq(org, s2, 'MYR', null, rp1,
    jsonb_build_array(jsonb_build_object('product_id', prod, 'description', 'Entirely other words', 'quantity', 1, 'sst_rate', 0)), array[9.00]);
  fails := fails || public.bendahara_split_try('9: the dearer quote for one product', 'FIN75',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rp1, array[1]))));
  fails := fails || public.bendahara_split_try('9: the cheaper quote for it', 'ok',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(rp2, array[1]))));
  perform public.bendahara_split_clear(org);
  fails := fails || public.bendahara_split_try('9: RFQs of two requests', 'FIN76',
    format('select public.finance_award_rfq_lines(%L, %L)', org, jsonb_build_array(public.bendahara_split_aw(ra1, array[2]), public.bendahara_split_aw(rp2, array[1]))));

  -- ==== 10: the reason on the order =============================================================
  made := public.finance_award_rfq_lines(org, jsonb_build_array(public.bendahara_split_aw(ra3, array[1], 'first reason')));
  po := made[1];
  update public.finance_purchase_orders set award_reason = 'second reason' where id = po;
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'second reason' then fails := fails || format('10: a draft reason was not changed (%L)', t); end if;
  fails := fails || public.bendahara_split_try('10: a draft reason emptied', 'FIN75', format('update public.finance_purchase_orders set award_reason = null where id = %L', po));
  fails := fails || public.bendahara_split_try('10: a draft reason made blank', '23514', format('update public.finance_purchase_orders set award_reason = %L where id = %L', '   ', po));
  fails := fails || public.bendahara_split_try('10: a blank reason on a new order', '23514',
    format('insert into public.finance_purchase_orders (org_id, supplier_id, award_reason) values (%L, %L, %L)', org, s1, ' '));
  -- An order made without one may be given one while it is a draft.
  perform public.bendahara_split_clear(org);
  perform public.finance_convert_rfq(org, ra1);
  select p.id into po from public.finance_purchase_orders p where p.rfq_id = ra1 and p.status = 'draft';
  fails := fails || public.bendahara_split_try('10: a reason added to a draft', 'ok', format('update public.finance_purchase_orders set award_reason = %L where id = %L', 'added', po));
  perform public.finance_submit_purchase_order(org, po);
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'added' then fails := fails || format('10: submitting left the reason as %L', t); end if;
  fails := fails || public.bendahara_split_try('10: a submitted order''s reason changed', 'FIN01', format('update public.finance_purchase_orders set award_reason = %L where id = %L', 'late', po));
  fails := fails || public.bendahara_split_try('10: a submitted order''s reason emptied', 'FIN01', format('update public.finance_purchase_orders set award_reason = null where id = %L', po));
  -- Where the guard stands aside (nobody signed in), the lock still holds.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  begin
    update public.finance_purchase_orders set award_reason = 'sneaked in' where id = po;
    fails := fails || '10: with nobody signed in, a submitted order''s reason changed'::text;
  exception when sqlstate 'FIN01' then null;
  end;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  -- Rejected: back to draft with the reason it had, which may be changed again; a reason offered with the next submit is ignored.
  perform public.finance_decide_purchase_order(org, po, false, 'wrong supplier');
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'added' then fails := fails || format('10: rejecting left the reason as %L', t); end if;
  fails := fails || public.bendahara_split_try('10: a rejected order''s reason may change', 'ok', format('update public.finance_purchase_orders set award_reason = %L where id = %L', 'reconsidered', po));
  select po_no into t from public.finance_purchase_orders where id = po;
  update public.finance_purchase_orders set status = 'pending_approval', po_no = t, award_reason = 'sneaky' where id = po;
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'reconsidered' then fails := fails || format('10: a reason rode along with a submit: %L', t); end if;
  perform public.finance_decide_purchase_order(org, po, true, null);
  fails := fails || public.bendahara_split_try('10: an approved order''s reason changed', 'FIN01', format('update public.finance_purchase_orders set award_reason = %L where id = %L', 'late', po));
  select award_reason into t from public.finance_purchase_order_totals where id = po;
  if t is distinct from 'reconsidered' then fails := fails || format('10: the view reads %L', t); end if;

  -- ==== 11: who may ============================================================================
  -- The award is built as the owner (a person who cannot read the lines would name none), then offered by others.
  aw := jsonb_build_array(public.bendahara_split_aw(rc2, array[2]));
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_split_try('11: a viewer awards', 'error', format('select public.finance_award_rfq_lines(%L, %L)', org, aw));
  fails := fails || public.bendahara_split_try('11: a viewer makes a purchase order', 'error', format('select public.finance_convert_rfq(%L, %L)', org, rc2));
  perform set_config('request.jwt.claims', outsider_claims, true);
  fails := fails || public.bendahara_split_try('11: an outsider awards', 'error', format('select public.finance_award_rfq_lines(%L, %L)', org, aw));
  fails := fails || public.bendahara_split_try('11: an outsider makes a purchase order', 'error', format('select public.finance_convert_rfq(%L, %L)', org, rc2));
  select count(*) into n from public.finance_purchase_order_totals where org_id = org;
  if n <> 0 then fails := fails || format('11: an outsider reads %s orders', n); end if;
  perform set_config('request.jwt.claims', owner_claims, true);
  if public.bendahara_split_orders(rc2) <> 0 then fails := fails || '11: a refused caller made an order'::text; end if;
  -- anon may call none of it.
  foreach t in array array['public.finance_award_rfq_lines(uuid, jsonb)', 'public.finance_convert_rfq(uuid, uuid, text)'] loop
    if has_function_privilege('anon', t, 'execute') then fails := fails || format('11: anon can call %s', t); end if;
  end loop;

  -- ==== 12: a draft saved with its reason (20261202090300) =======================================
  po := public.finance_save_purchase_order_with_reason(org, jsonb_build_object('supplier_id', s1, 'po_date', current_date),
    '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0}]', 'new reason');
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'new reason' then fails := fails || format('12: a new draft''s reason is %L', t); end if;
  -- A refused reason undoes the save: the second line is not there afterwards.
  fails := fails || public.bendahara_split_try('12: a blank reason with new lines', '23514',
    format('select public.finance_save_purchase_order_with_reason(%L, %L, %L, %L)', org,
      jsonb_build_object('id', po, 'supplier_id', s1, 'po_date', current_date),
      '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0},{"description":"B","quantity":1,"unit_price":50,"sst_rate":0}]', '   '));
  select count(*) into n from public.finance_purchase_order_lines where purchase_order_id = po;
  if n <> 1 then fails := fails || format('12: a refused reason left %s lines saved', n); end if;
  -- No reason sent: the lines are saved and the stored reason stays.
  perform public.finance_save_purchase_order_with_reason(org, jsonb_build_object('id', po, 'supplier_id', s1, 'po_date', current_date),
    '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0},{"description":"B","quantity":1,"unit_price":50,"sst_rate":0}]', null);
  select count(*) into n from public.finance_purchase_order_lines where purchase_order_id = po;
  select award_reason into t from public.finance_purchase_orders where id = po;
  if n <> 2 or t is distinct from 'new reason' then fails := fails || format('12: a save with no reason left %s lines and %L', n, t); end if;
  perform public.finance_save_purchase_order_with_reason(org, jsonb_build_object('id', po, 'supplier_id', s1, 'po_date', current_date),
    '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0}]', 'changed reason');
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'changed reason' then fails := fails || format('12: a changed reason is %L', t); end if;
  perform set_config('request.jwt.claims', viewer_claims, true);
  fails := fails || public.bendahara_split_try('12: a viewer saves with a reason', 'error',
    format('select public.finance_save_purchase_order_with_reason(%L, %L, %L, %L)', org,
      jsonb_build_object('id', po, 'supplier_id', s1, 'po_date', current_date), '[{"description":"A","quantity":1,"unit_price":1,"sst_rate":0}]', 'viewer'));
  perform set_config('request.jwt.claims', owner_claims, true);
  perform public.finance_submit_purchase_order(org, po);
  fails := fails || public.bendahara_split_try('12: a submitted order saved with a reason', 'error',
    format('select public.finance_save_purchase_order_with_reason(%L, %L, %L, %L)', org,
      jsonb_build_object('id', po, 'supplier_id', s1, 'po_date', current_date), '[{"description":"A","quantity":1,"unit_price":100,"sst_rate":0}]', 'late'));
  select award_reason into t from public.finance_purchase_orders where id = po;
  if t is distinct from 'changed reason' then fails := fails || format('12: a submitted order''s reason became %L', t); end if;
  if has_function_privilege('anon', 'public.finance_save_purchase_order_with_reason(uuid, jsonb, jsonb, text)', 'execute') then
    fails := fails || '12: anon can call finance_save_purchase_order_with_reason'::text;
  end if;

  exception when others then
    -- Only an error that stopped the block reaches here: a case failure above is recorded and the rest still run.
    if sqlerrm like 'BENDAHARA_RFQ_SPLIT_CHECK%' then
      raise;
    end if;
    fails := fails || format('stopped at: %s (%s)', sqlerrm, sqlstate);
  end;

  -- ---- the workspace goes, and takes everything with it ---------------------------------
  reset role;
  delete from public.orgs where id in (org, other_org);
  select count(*) into n from public.finance_purchase_orders where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s orders', n); end if;
  select count(*) into n from public.finance_rfqs where org_id = org;
  if n <> 0 then fails := fails || format('deleting the workspace left %s RFQs', n); end if;

  fails := array_remove(fails, null);
  if array_length(fails, 1) is null then
    raise exception 'BENDAHARA_RFQ_SPLIT_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_RFQ_SPLIT_CHECK FAILED: %', array_to_string(fails, ' | ');
end $$;
