-- The Bendahara agent worker may read the finance columns its scan reads.
--
-- The worker builds its snapshot (src/lib/finance/agent/) with the service-role
-- client. In this project service_role holds no table grants unless one is written
-- (see 20261015100000_agent_service_role_grants.sql), so without these grants every
-- run fails with permission denied.
--
-- Read only. Two kinds of grant:
--   1. The columns the scan selects, filters on and sorts by (the first block).
--   2. finance_invoice_totals and supplier_bill_totals run as their reader
--      (security_invoker), so reading them needs select on every base column the
--      view's own text uses, whether or not the scan asks for it (the second
--      block). These were listed from pg_depend for both views; nothing else.
-- The worker never reads a note's body or label, a contact's details beyond its
-- name, an expense's description, or a statement line's text.
set local lock_timeout = '5s';

-- ---- 1. what the scan reads ----------------------------------------------------
grant select (org_id, id, invoice_no, customer_id, invoice_date, due_date, display_status, balance_myr, currency)
  on public.finance_invoice_totals to service_role;
grant select (org_id, id, bill_no, supplier_id, bill_date, due_date, display_status, balance_myr, currency)
  on public.supplier_bill_totals to service_role;
grant select (org_id, id, status, customer_id, invoice_date, updated_at)
  on public.finance_invoices to service_role;
grant select (org_id, id, status, supplier_id, bill_date, updated_at)
  on public.supplier_bills to service_role;
grant select (org_id, id, status, amount, vendor_id, vendor_name, expense_date, created_at)
  on public.finance_expenses to service_role;
grant select (org_id, id, quotation_no, customer_id, status, valid_until)
  on public.finance_quotations to service_role;
grant select (org_id, id, account_id, line_date, money_in, money_out, transaction_id)
  on public.finance_statement_lines to service_role;
grant select (org_id, id, name, active, currency)
  on public.finance_accounts to service_role;
grant select (org_id, id, name)
  on public.finance_contacts to service_role;
grant select (org_id, period_start_month, service_tax_no, sales_tax_no)
  on public.finance_sst_settings to service_role;
grant select (org_id, tax_type, period_start)
  on public.finance_sst_returns to service_role;
grant select (org_id, entity_type, entity_id, agent_proposal_id, created_at)
  on public.finance_agent_notes to service_role;

-- ---- 2. what the two totals views read underneath --------------------------------
grant select (org_id, id, invoice_no, customer_id, invoice_date, supply_date, due_date, status, currency,
              fx_rate, fx_rate_date, fx_rate_provider, fx_rate_reference, fx_rate_source,
              einvoice_status, einvoice_uuid, notes, posted_at, created_by, created_at, updated_at)
  on public.finance_invoices to service_role;
grant select (org_id, id, bill_no, supplier_id, supplier_ref, bill_date, due_date, status, currency,
              fx_rate, fx_rate_date, fx_rate_provider, fx_rate_reference, fx_rate_source,
              notes, posted_at, created_at, updated_at)
  on public.supplier_bills to service_role;
grant select (org_id, invoice_id, amount, amount_myr, sst_amount, sst_amount_myr)
  on public.finance_invoice_lines to service_role;
grant select (org_id, bill_id, amount, amount_myr, sst_amount, sst_amount_myr)
  on public.supplier_bill_lines to service_role;
grant select (org_id, id, direction, status)
  on public.finance_transactions to service_role;
grant select (org_id, transaction_id, invoice_id, bill_id, credit_note_id, amount, carried_myr)
  on public.finance_allocations to service_role;
grant select (org_id, id, invoice_id, amount, amount_myr, status)
  on public.finance_credit_notes to service_role;
grant select (org_id, id, status)
  on public.finance_contras to service_role;
grant select (org_id, contra_id, invoice_id, bill_id, amount)
  on public.finance_contra_lines to service_role;
grant select (org_id, bill_id, amount)
  on public.finance_supplier_credit_applications to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: every column granted above is readable, and the two views can be
-- read as service_role (which proves the base columns are enough).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  missing text;
begin
  for r in
    select * from (values
      ('finance_invoice_totals', 'org_id,id,invoice_no,customer_id,invoice_date,due_date,display_status,balance_myr,currency'),
      ('supplier_bill_totals', 'org_id,id,bill_no,supplier_id,bill_date,due_date,display_status,balance_myr,currency'),
      ('finance_invoices', 'org_id,id,status,customer_id,invoice_date,updated_at'),
      ('supplier_bills', 'org_id,id,status,supplier_id,bill_date,updated_at'),
      ('finance_expenses', 'org_id,id,status,amount,vendor_id,vendor_name,expense_date,created_at'),
      ('finance_quotations', 'org_id,id,quotation_no,customer_id,status,valid_until'),
      ('finance_statement_lines', 'org_id,id,account_id,line_date,money_in,money_out,transaction_id'),
      ('finance_accounts', 'org_id,id,name,active,currency'),
      ('finance_contacts', 'org_id,id,name'),
      ('finance_sst_settings', 'org_id,period_start_month,service_tax_no,sales_tax_no'),
      ('finance_sst_returns', 'org_id,tax_type,period_start'),
      ('finance_agent_notes', 'org_id,entity_type,entity_id,agent_proposal_id,created_at')
    ) v(tbl, cols)
  loop
    select string_agg(c, ',') into missing from unnest(string_to_array(r.cols, ',')) c
     where not has_column_privilege('service_role', ('public.' || r.tbl)::regclass, c, 'select');
    if missing is not null then
      raise exception 'service_role may not read %.%', r.tbl, missing;
    end if;
  end loop;
  if has_column_privilege('service_role', 'public.finance_agent_notes', 'body', 'select')
     or has_column_privilege('service_role', 'public.finance_agent_notes', 'entity_label', 'select') then
    raise exception 'service_role may read a note''s body or label';
  end if;

  set local role service_role;
  perform org_id, id, invoice_no, customer_id, invoice_date, due_date, display_status, balance_myr, currency
     from public.finance_invoice_totals limit 1;
  perform org_id, id, bill_no, supplier_id, bill_date, due_date, display_status, balance_myr, currency
     from public.supplier_bill_totals limit 1;
  reset role;
end $$;
