-- Bendahara: a credit note on a return marked filed cannot be voided (#222,
-- 20261128093000_bendahara_credit_note_void_on_filed_return.sql). Run it after
-- that migration, in the same transaction for a dry run, or by itself once
-- applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and the helper functions below are rolled back. Read:
--   BENDAHARA_CN_VOID_ON_FILED_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner the way the app does (the authenticated role
-- with that person's id in request.jwt.claims, at aal2). The workspace has no
-- SST settings row: the guard reads each mark's own period, never the settings.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  owner_claims text;
  cust uuid;
  cn uuid;
  got text;
  fails text[] := '{}';
  sep text := 'This credit note is on the 1 Sep – 31 Oct 2026 service tax return, which is marked filed. If the credit note should never have been issued, take the filed mark off the return, void the credit note, and file an amended return (Pindaan). A credit taken back in a later period is a debit note, which Bendahara does not issue yet.';
begin
  -- Voids a credit note and answers 'ok', or the refusal as 'CODE: message'.
  execute $f$
    create function public.bendahara_cn_void_try(target uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      update public.finance_credit_notes set status = 'void' where id = target;
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_cn_void_try(uuid) to authenticated';
  -- An issued credit note of RM10 dated d, against a posted invoice of one or more lines dated 1 Sep 2026.
  execute $f$
    create function public.bendahara_cn_issued(o uuid, c uuid, d date, lines jsonb) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    declare i uuid; n uuid;
    begin
      i := public.finance_save_invoice(o, jsonb_build_object('customer_id', c, 'invoice_date', date '2026-09-01', 'due_date', date '2026-10-01'), lines);
      -- finance_save_invoice leaves tax_type out; the line form sets it on the draft line, as here.
      update public.finance_invoice_lines l set tax_type = e->>'tax_type'
        from jsonb_array_elements(lines) e
       where l.invoice_id = i and l.description = e->>'description' and e ? 'tax_type';
      perform public.finance_post_invoice(o, i);
      n := public.finance_save_credit_note(o, jsonb_build_object('invoice_id', i, 'credit_date', d, 'amount', 10, 'reason', 'returns'));
      perform public.finance_issue_credit_note(o, n);
      return n;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_cn_issued(uuid, uuid, date, jsonb) to authenticated';

  -- ---- structure ------------------------------------------------------------
  if not exists (select 1 from pg_trigger where tgrelid = 'public.finance_credit_notes'::regclass and tgname = 'finance_credit_note_void_filed_guard') then
    raise exception 'BENDAHARA_CN_VOID_ON_FILED_CHECK FAILED: the trigger finance_credit_note_void_filed_guard is missing';
  end if;

  -- ---- a workspace and its owner ----------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    owner_id || '@cn-void-filed.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (org, 'Credit Note Void On Filed Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'CN Void Check Ltd', true) returning id into cust;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-20');

  -- ==== 1: a credit note on a service tax invoice, dated in a filed period: refused, in words ====
  cn := public.bendahara_cn_issued(org, cust, '2026-09-15', '[{"description":"Consulting","quantity":1,"unit_price":5000,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_cn_void_try(cn);
  if got is distinct from 'FIN74: ' || sep then fails := fails || format('1: the void answered %s', got); end if;
  select status into got from public.finance_credit_notes where id = cn;
  if got <> 'issued' then fails := fails || format('1: the credit note is %s after a refused void', got); end if;

  -- ==== 2: the mark taken off, the void goes through (the amendment route) =================
  delete from public.finance_sst_returns where org_id = org and tax_type = 'service' and period_start = '2026-09-01';
  got := public.bendahara_cn_void_try(cn);
  if got <> 'ok' then fails := fails || format('2: with the mark off the void answered %s', got); end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-21');

  -- ==== 3: the credit date decides, not the invoice date: 31 Oct is held, 1 Nov is not ==========
  cn := public.bendahara_cn_issued(org, cust, '2026-10-31', '[{"description":"Late","quantity":1,"unit_price":100,"sst_rate":8,"tax_type":"service"}]');
  got := public.bendahara_cn_void_try(cn);
  if got not like 'FIN74:%' then fails := fails || format('3: a credit note of 31 Oct answered %s', got); end if;
  cn := public.bendahara_cn_issued(org, cust, '2026-11-01', '[{"description":"Next","quantity":1,"unit_price":100,"sst_rate":8,"tax_type":"service"}]');
  got := public.bendahara_cn_void_try(cn);
  if got <> 'ok' then fails := fails || format('3: a credit note of 1 Nov on a September invoice answered %s', got); end if;

  -- ==== 4: a service line at a rate with no form item still gives 13(a) a share: held ===========
  cn := public.bendahara_cn_issued(org, cust, '2026-09-12', '[{"description":"Odd rate","quantity":1,"unit_price":100,"sst_rate":7,"tax_type":"service"}]');
  got := public.bendahara_cn_void_try(cn);
  if got not like 'FIN74:%' then fails := fails || format('4: a credit note on a 7%% service line answered %s', got); end if;

  -- ==== 5: only the tax the invoice carries: a sales invoice on a filed service return ===========
  cn := public.bendahara_cn_issued(org, cust, '2026-09-13', '[{"description":"Goods","quantity":1,"unit_price":100,"sst_rate":10,"tax_type":"sales"}]');
  got := public.bendahara_cn_void_try(cn);
  if got <> 'ok' then fails := fails || format('5: a credit note on a sales invoice answered %s', got); end if;

  -- ==== 6: no SST at all ===========================================================================
  cn := public.bendahara_cn_issued(org, cust, '2026-09-14', '[{"description":"Exempt","quantity":1,"unit_price":100,"sst_rate":0}]');
  got := public.bendahara_cn_void_try(cn);
  if got <> 'ok' then fails := fails || format('6: a credit note on an untaxed invoice answered %s', got); end if;

  -- ==== 7: no tax type on the line: the rate decides, as taxTypeForRate does ======================
  cn := public.bendahara_cn_issued(org, cust, '2026-09-15', '[{"description":"Untyped","quantity":1,"unit_price":100,"sst_rate":6}]');
  got := public.bendahara_cn_void_try(cn);
  if got not like 'FIN74:%' then fails := fails || format('7: a credit note on an untyped 6%% line answered %s', got); end if;

  -- ==== 8: on both filed returns, the sentence says SST ============================================
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'sales', '2026-09-01', '2026-11-20');
  cn := public.bendahara_cn_issued(org, cust, '2026-09-16',
    '[{"description":"Both A","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"},{"description":"Both B","quantity":1,"unit_price":100,"sst_rate":10,"tax_type":"sales"}]');
  got := public.bendahara_cn_void_try(cn);
  if got is distinct from 'FIN74: ' || replace(sep, 'service tax return', 'SST return') then fails := fails || format('8: the void answered %s', got); end if;

  -- ==== 9: across a year end ========================================================================
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-12-01', '2027-02-20');
  cn := public.bendahara_cn_issued(org, cust, '2027-01-05', '[{"description":"New year","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_cn_void_try(cn);
  if got not like 'FIN74: This credit note is on the 1 Dec 2026 – 31 Jan 2027 service tax return,%' then
    fails := fails || format('9: across the year end the void answered %s', got);
  end if;

  -- ==== 10: a draft credit note in a filed period is still deleted freely, never voided ===========
  cn := public.finance_save_credit_note(org, jsonb_build_object('invoice_id',
    (select invoice_id from public.finance_credit_notes where id = cn), 'credit_date', date '2027-01-06', 'amount', 1, 'reason', 'other'));
  delete from public.finance_credit_notes where id = cn;
  if exists (select 1 from public.finance_credit_notes where id = cn) then fails := fails || '10: a draft credit note could not be deleted'; end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);
  if cardinality(fails) = 0 then
    raise exception 'BENDAHARA_CN_VOID_ON_FILED_CHECK PASSED (everything rolled back)';
  end if;
  raise exception 'BENDAHARA_CN_VOID_ON_FILED_CHECK FAILED (%): %', cardinality(fails), array_to_string(fails, ' | ');
end $$;
