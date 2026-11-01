-- Bendahara: a document dated inside a return marked filed cannot be posted or
-- issued (#222, 20261129090000_bendahara_post_into_filed_period.sql). Run it
-- after that migration, in the same transaction for a dry run, or by itself once
-- applied. It leaves nothing behind either way: the block always ends with
-- RAISE, so every row and every helper function below are rolled back. Read the
-- message:
--   BENDAHARA_POST_INTO_FILED_CHECK PASSED ...   or   ... FAILED: <what went wrong>
-- It acts as a workspace's owner the way the app does (the authenticated role
-- with that person's id in request.jwt.claims, at aal2). The workspace has no
-- SST settings row: each guard reads the mark's own period, never the settings.
do $$
declare
  org uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  owner_claims text;
  cust uuid;
  inv uuid;
  note uuid;
  got text;
  fails text[] := '{}';
  sep text := 'This invoice is dated in the 1 Sep – 31 Oct 2026 service tax return, which is marked filed. Date it in the current period, or take the filed mark off the return and file an amended return (Pindaan).';
  nsep text := 'This credit note is dated in the 1 Sep – 31 Oct 2026 service tax return, which is marked filed. Date it in the current period: a note for tax declared in an earlier return is deducted in the period it is issued.';
begin
  -- fails stays outside the block that runs the cases, so an error raised part way
  -- through is reported beside the case failures already found. PL/pgSQL resets the
  -- variables declared in the block that catches an exception, so a guard that goes
  -- missing would otherwise answer with the error it caused instead of "1: the post
  -- answered ok".
  begin
  -- Saves a draft invoice of one or more lines (rate, tax type) on a date.
  execute $f$
    create function public.bendahara_filed_draft(o uuid, c uuid, d date, lines jsonb) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    begin
      return public.finance_save_invoice(o, jsonb_build_object('customer_id', c, 'invoice_date', d, 'due_date', d + 30), lines);
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_filed_draft(uuid, uuid, date, jsonb) to authenticated';
  -- Posts it and answers 'ok', or the refusal as 'CODE: message'.
  execute $f$
    create function public.bendahara_filed_post(t uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      perform public.finance_post_invoice((select org_id from public.finance_invoices where id = t), t);
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_filed_post(uuid) to authenticated';
  -- A draft credit note against an invoice, dated, for an amount.
  execute $f$
    create function public.bendahara_filed_note(o uuid, i uuid, d date, amt numeric) returns uuid
    language plpgsql security invoker set search_path = '' as $g$
    begin
      return public.finance_save_credit_note(o, jsonb_build_object('invoice_id', i, 'credit_date', d, 'amount', amt, 'reason', 'returns'));
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_filed_note(uuid, uuid, date, numeric) to authenticated';
  execute $f$
    create function public.bendahara_filed_issue(o uuid, n uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      perform public.finance_issue_credit_note(o, n);
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_filed_issue(uuid, uuid) to authenticated';
  execute $f$
    create function public.bendahara_filed_void(t uuid) returns text
    language plpgsql security invoker set search_path = '' as $g$
    begin
      update public.finance_invoices set status = 'void' where id = t;
      return 'ok';
    exception when others then
      return sqlstate || ': ' || sqlerrm;
    end $g$
  $f$;
  execute 'grant execute on function public.bendahara_filed_void(uuid) to authenticated';

  -- ---- structure ------------------------------------------------------------
  if not exists (select 1 from pg_trigger where tgrelid = 'public.finance_invoices'::regclass and tgname = 'finance_invoice_post_filed_guard') then
    raise exception 'BENDAHARA_POST_INTO_FILED_CHECK FAILED: the trigger finance_invoice_post_filed_guard is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.finance_credit_notes'::regclass and tgname = 'finance_credit_note_issue_filed_guard') then
    raise exception 'BENDAHARA_POST_INTO_FILED_CHECK FAILED: the trigger finance_credit_note_issue_filed_guard is missing';
  end if;

  -- ---- a workspace and its owner ----------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_anonymous)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    owner_id || '@post-filed.check.openkuasa-test.dev', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false);
  insert into public.orgs (id, name) values (org, 'Post Into Filed Check Sdn Bhd');
  insert into public.org_members (org_id, user_id, role) values (org, owner_id, 'owner');
  owner_claims := json_build_object('sub', owner_id, 'role', 'authenticated', 'aal', 'aal2')::text;
  perform set_config('request.jwt.claims', owner_claims, true);
  set local role authenticated;
  insert into public.finance_contacts (org_id, name, is_customer) values (org, 'Filed Check Ltd', true) returning id into cust;

  -- ---- 1: an invoice dated in the period posts while the return is unmarked, then
  --         the mark goes on and the same kind of invoice cannot be posted ==========
  inv := public.bendahara_filed_draft(org, cust, '2026-09-10', '[{"description":"Earlier sale","quantity":1,"unit_price":5000,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('1: before the mark the post answered %s', got); end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-20');

  inv := public.bendahara_filed_draft(org, cust, '2026-10-02', '[{"description":"Late sale","quantity":1,"unit_price":1000,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_filed_post(inv);
  if got is distinct from 'FIN72: ' || sep then fails := fails || format('1: the post answered %s', got); end if;
  select status into got from public.finance_invoices where id = inv;
  if got <> 'draft' then fails := fails || format('1: the invoice is %s after a refused post', got); end if;

  -- ---- 2: dated in the current period instead, it posts (the way out) =============
  -- Only a draft can be re-dated; if the guard let the post above through, the
  -- invoice is already posted and the re-date below is left out so the rest of the
  -- file still runs and reports.
  if (select status from public.finance_invoices where id = inv) = 'draft' then
    perform public.finance_save_invoice(org, jsonb_build_object('id', inv, 'customer_id', cust, 'invoice_date', '2026-11-02', 'due_date', '2026-12-02'),
      '[{"description":"Late sale","quantity":1,"unit_price":1000,"sst_rate":6,"tax_type":"service"}]');
  end if;
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('2: re-dated to 2 Nov the post answered %s', got); end if;

  -- ---- 3: the mark taken off, the post goes through, and the mark goes back on ====
  inv := public.bendahara_filed_draft(org, cust, '2026-10-03', '[{"description":"Amendment","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"}]');
  delete from public.finance_sst_returns where org_id = org and tax_type = 'service' and period_start = '2026-09-01';
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('3: with the mark off the post answered %s', got); end if;
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-09-01', '2026-11-21');

  -- ---- 4: the last day of the period is held, the day after is not ================
  inv := public.bendahara_filed_draft(org, cust, '2026-10-31', '[{"description":"Late","quantity":1,"unit_price":100,"sst_rate":8,"tax_type":"service"}]');
  got := public.bendahara_filed_post(inv);
  if got not like 'FIN72:%' then fails := fails || format('4: an invoice of 31 Oct answered %s', got); end if;
  inv := public.bendahara_filed_draft(org, cust, '2026-11-01', '[{"description":"Next","quantity":1,"unit_price":100,"sst_rate":8,"tax_type":"service"}]');
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('4: an invoice of 1 Nov answered %s', got); end if;

  -- ---- 5: a line at a rate the form has no item for was never on the return =======
  inv := public.bendahara_filed_draft(org, cust, '2026-10-04', '[{"description":"Odd rate","quantity":1,"unit_price":100,"sst_rate":7,"tax_type":"service"}]');
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('5: a 7%% service line answered %s', got); end if;

  -- ---- 6: only the tax the invoice carries: a sales line on a filed service return =
  inv := public.bendahara_filed_draft(org, cust, '2026-10-05', '[{"description":"Goods","quantity":1,"unit_price":100,"sst_rate":10,"tax_type":"sales"}]');
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('6: a sales line answered %s', got); end if;

  -- ---- 7: no SST at all ============================================================
  inv := public.bendahara_filed_draft(org, cust, '2026-10-06', '[{"description":"Exempt","quantity":1,"unit_price":100,"sst_rate":0}]');
  got := public.bendahara_filed_post(inv);
  if got <> 'ok' then fails := fails || format('7: an untaxed invoice answered %s', got); end if;

  -- ---- 8: no tax type on the line: the rate decides, as taxTypeForRate does ========
  inv := public.bendahara_filed_draft(org, cust, '2026-10-07', '[{"description":"Untyped","quantity":1,"unit_price":100,"sst_rate":6}]');
  got := public.bendahara_filed_post(inv);
  if got not like 'FIN72:%' then fails := fails || format('8: an untyped 6%% line answered %s', got); end if;

  -- ---- 9: on both filed returns, the sentence says SST =============================
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'sales', '2026-09-01', '2026-11-20');
  inv := public.bendahara_filed_draft(org, cust, '2026-10-08',
    '[{"description":"Both A","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"},{"description":"Both B","quantity":1,"unit_price":100,"sst_rate":10,"tax_type":"sales"}]');
  got := public.bendahara_filed_post(inv);
  if got is distinct from 'FIN72: ' || replace(sep, 'service tax return', 'SST return') then fails := fails || format('9: the post answered %s', got); end if;

  -- ---- 10: across a year end ========================================================
  insert into public.finance_sst_returns (org_id, tax_type, period_start, filed_on) values (org, 'service', '2026-12-01', '2027-02-20');
  inv := public.bendahara_filed_draft(org, cust, '2027-01-05', '[{"description":"New year","quantity":1,"unit_price":100,"sst_rate":6,"tax_type":"service"}]');
  got := public.bendahara_filed_post(inv);
  if got not like 'FIN72: This invoice is dated in the 1 Dec 2026 – 31 Jan 2027 service tax return,%' then
    fails := fails || format('10: across the year end the post answered %s', got);
  end if;

  -- ---- 11: a credit note dated in the filed period cannot be issued ================
  note := public.bendahara_filed_note(org, (select id from public.finance_invoices where org_id = org and invoice_date = '2026-09-10'), '2026-10-15', 500);
  got := public.bendahara_filed_issue(org, note);
  if got is distinct from 'FIN73: ' || nsep then fails := fails || format('11: the issue answered %s', got); end if;
  select status into got from public.finance_credit_notes where id = note;
  if got <> 'draft' then fails := fails || format('11: the credit note is %s after a refused issue', got); end if;

  -- ---- 12: dated in the current period instead, it issues ==========================
  update public.finance_credit_notes set credit_date = '2026-11-03' where id = note;
  got := public.bendahara_filed_issue(org, note);
  if got <> 'ok' then fails := fails || format('12: re-dated to 3 Nov the issue answered %s', got); end if;

  -- ---- 13: a credit note against an untaxed invoice changes no return ==============
  inv := public.bendahara_filed_draft(org, cust, '2026-10-09', '[{"description":"Exempt","quantity":1,"unit_price":100,"sst_rate":0}]');
  perform public.bendahara_filed_post(inv);
  note := public.bendahara_filed_note(org, inv, '2026-10-16', 10);
  got := public.bendahara_filed_issue(org, note);
  if got <> 'ok' then fails := fails || format('13: an untaxed invoice''s note answered %s', got); end if;

  -- ---- 14: the void guard from #425 is unchanged ===================================
  got := public.bendahara_filed_void((select id from public.finance_invoices where org_id = org and invoice_date = '2026-10-03'));
  if got not like 'FIN71: This invoice is on the 1 Sep – 31 Oct 2026 service tax return,%' then
    fails := fails || format('14: the void guard answered %s', got);
  end if;

  exception when others then
    -- Only an error that stopped the block reaches here: a case failure below is
    -- recorded and the rest still run. Keep the failures already found.
    if sqlerrm like 'BENDAHARA_POST_INTO_FILED_CHECK%' then
      raise;
    end if;
    fails := fails || format('stopped at: %s (%s)', sqlerrm, sqlstate);
  end;

  if array_length(fails, 1) > 0 then
    raise exception 'BENDAHARA_POST_INTO_FILED_CHECK FAILED: %', array_to_string(fails, ' | ');
  end if;
  raise exception 'BENDAHARA_POST_INTO_FILED_CHECK PASSED (everything rolled back)';
end $$;
