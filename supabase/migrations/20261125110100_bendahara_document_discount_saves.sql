-- Bendahara: saving and converting carry a whole-document discount (#272).
-- 20261125110000_bendahara_document_discount added the header columns
-- (doc_discount_pct, doc_discount_amount), the line shares and the triggers
-- that split the discount; this file has the three writers carry the header.
--
--   * finance_save_invoice and finance_save_quotation: when the header json has
--     either key "doc_discount_pct" or "doc_discount_amount", both columns are
--     written from it (an absent one of the pair, an empty one or a json null
--     is null, so an explicit null clears the discount). Without either key the
--     stored discount is kept, as the currency keys are: a Tuah edit or an
--     older caller never wipes it. The line triggers split it over the new
--     lines.
--   * Before anything is written, they refuse FIN62 when the discount that
--     will apply (the one sent, else the one stored on the draft) takes all of
--     the lines' net, worked out from the `lines` json exactly as the database
--     does: each line's value after its own discount, rounded to the sen, with
--     every json value cast to its column's scale first (quantity
--     numeric(14,3), unit_price numeric(14,4), discount_pct numeric(5,2),
--     discount_amount numeric(14,2)). The deferred check of 20261125110000
--     still judges it again at commit. A discount out of range is not judged
--     here: both set, a percentage of 0 or over 100, or a fixed amount of 0 is
--     refused by the table's own checks (23514), and a value too large for its
--     column (a percentage of 1000 or more, say) by the cast itself (22003,
--     numeric overflow) before anything is written.
--   * finance_convert_quotation copies both columns to the new invoice. The
--     shares follow from the lines inserted after it (the line trigger), over
--     the same nets and positions, so each line's figures in the document's
--     currency are the quotation's.
--
-- Each function is restated from its newest text on main and keeps its
-- signature, security invoker, search_path '' and grants (create or replace).

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ============================================================================
-- 1. Saving an invoice
-- ============================================================================
-- Replaced from 20261120100000_bendahara_invoice_currency.sql (lines 917 to
-- 1003). Everything it did before it still does, in the same order.
create or replace function public.finance_save_invoice(target_org uuid, invoice jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iid uuid := nullif(invoice->>'id', '')::uuid;
  n integer;
  sets_currency boolean := invoice ? 'currency';
  sets_supply boolean := invoice ? 'supply_date';
  sets_discount boolean := invoice ? 'doc_discount_pct' or invoice ? 'doc_discount_amount';
  i_currency text := coalesce(nullif(invoice->>'currency', ''), 'MYR');
  i_rate numeric;
  i_source text;
  i_rate_date date;
  i_provider text;
  i_reference text;
  i_supply date := nullif(invoice->>'supply_date', '')::date;
  i_disc_pct numeric(5,2) := nullif(invoice->>'doc_discount_pct', '')::numeric(5,2);
  i_disc_amount numeric(14,2) := nullif(invoice->>'doc_discount_amount', '')::numeric(14,2);
  -- The discount that will apply once saved, and the lines' net total.
  e_pct numeric;
  e_amount numeric;
  s numeric;
  d numeric;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an invoice needs at least one line' using errcode = 'FIN10';
  end if;

  i_rate := case when i_currency = 'MYR' then 1 else nullif(invoice->>'fx_rate', '')::numeric end;
  i_source := case
    when i_currency = 'MYR' or i_rate is null then null
    when invoice->>'fx_rate_source' = 'bnm' then 'bnm'
    else 'manual'
  end;
  i_rate_date := case when i_source = 'bnm' then nullif(invoice->>'fx_rate_date', '')::date end;
  i_provider := case when i_source = 'manual' then nullif(invoice->>'fx_rate_provider', '') end;
  i_reference := case when i_source = 'manual' then nullif(btrim(coalesce(invoice->>'fx_rate_reference', '')), '') end;

  -- FIN62 before anything is written. Only a new invoice or a draft: any
  -- other is refused by its guard (FIN01), and a missing one by FIN11 below.
  if sets_discount then
    e_pct := i_disc_pct;
    e_amount := i_disc_amount;
    if iid is not null and not exists (
      select 1 from public.finance_invoices where org_id = target_org and id = iid and status = 'draft'
    ) then
      e_pct := null;
      e_amount := null;
    end if;
  elsif iid is not null then
    select doc_discount_pct, doc_discount_amount into e_pct, e_amount
      from public.finance_invoices where org_id = target_org and id = iid and status = 'draft';
  end if;
  if num_nonnulls(e_pct, e_amount) = 1 and (e_pct is null or (e_pct > 0 and e_pct <= 100)) and (e_amount is null or e_amount > 0) then
    select coalesce(sum(round(
      case
        when nullif(l->>'discount_pct', '') is not null
          then (l->>'quantity')::numeric(14,3) * (l->>'unit_price')::numeric(14,4) * (1 - nullif(l->>'discount_pct', '')::numeric(5,2) / 100)
        when nullif(l->>'discount_amount', '') is not null
          then greatest((l->>'quantity')::numeric(14,3) * (l->>'unit_price')::numeric(14,4) - nullif(l->>'discount_amount', '')::numeric(14,2), 0)
        else (l->>'quantity')::numeric(14,3) * (l->>'unit_price')::numeric(14,4)
      end, 2)), 0) into s
      from jsonb_array_elements(lines) as l;
    d := coalesce(round(s * e_pct / 100, 2), e_amount);
    if d >= s then
      raise exception 'A discount on the whole document must leave something to pay.' using errcode = 'FIN62';
    end if;
  end if;

  if iid is null then
    insert into public.finance_invoices
      (org_id, customer_id, invoice_date, due_date, notes, status,
       currency, fx_rate, fx_rate_source, fx_rate_date, fx_rate_provider, fx_rate_reference, supply_date,
       doc_discount_pct, doc_discount_amount)
    values (
      target_org,
      (invoice->>'customer_id')::uuid,
      (invoice->>'invoice_date')::date,
      (invoice->>'due_date')::date,
      nullif(invoice->>'notes', ''),
      'draft',
      i_currency, i_rate, i_source, i_rate_date, i_provider, i_reference, i_supply,
      i_disc_pct, i_disc_amount
    )
    returning id into iid;
  else
    update public.finance_invoices
       set customer_id = (invoice->>'customer_id')::uuid,
           invoice_date = (invoice->>'invoice_date')::date,
           due_date = (invoice->>'due_date')::date,
           notes = nullif(invoice->>'notes', ''),
           currency = case when sets_currency then i_currency else currency end,
           fx_rate = case when sets_currency then i_rate else fx_rate end,
           fx_rate_source = case when sets_currency then i_source else fx_rate_source end,
           fx_rate_date = case when sets_currency then i_rate_date else fx_rate_date end,
           fx_rate_provider = case when sets_currency then i_provider else fx_rate_provider end,
           fx_rate_reference = case when sets_currency then i_reference else fx_rate_reference end,
           supply_date = case when sets_supply then i_supply else supply_date end,
           doc_discount_pct = case when sets_discount then i_disc_pct else doc_discount_pct end,
           doc_discount_amount = case when sets_discount then i_disc_amount else doc_discount_amount end,
           updated_at = now()
     where org_id = target_org and id = iid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the invoice no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_invoice_lines where org_id = target_org and invoice_id = iid;
  end if;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate, discount_pct, discount_amount)
  select
    target_org, iid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0),
    nullif(l.line->>'discount_pct', '')::numeric,
    nullif(l.line->>'discount_amount', '')::numeric
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return iid;
end $$;

-- ============================================================================
-- 2. Saving a quotation
-- ============================================================================
-- Replaced from 20261119160000_bendahara_quotation_currency.sql (lines 254 to
-- 333). Everything it did before it still does, in the same order.
create or replace function public.finance_save_quotation(target_org uuid, quotation jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  qid uuid := nullif(quotation->>'id', '')::uuid;
  n integer;
  sets_currency boolean := quotation ? 'currency';
  sets_discount boolean := quotation ? 'doc_discount_pct' or quotation ? 'doc_discount_amount';
  q_currency text := coalesce(nullif(quotation->>'currency', ''), 'MYR');
  q_rate numeric;
  q_source text;
  q_rate_date date;
  q_disc_pct numeric(5,2) := nullif(quotation->>'doc_discount_pct', '')::numeric(5,2);
  q_disc_amount numeric(14,2) := nullif(quotation->>'doc_discount_amount', '')::numeric(14,2);
  -- The discount that will apply once saved, and the lines' net total.
  e_pct numeric;
  e_amount numeric;
  s numeric;
  d numeric;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a quotation needs at least one line' using errcode = 'FIN10';
  end if;

  q_rate := case when q_currency = 'MYR' then 1 else nullif(quotation->>'fx_rate', '')::numeric end;
  q_source := case
    when q_currency = 'MYR' or q_rate is null then null
    when quotation->>'fx_rate_source' = 'bnm' then 'bnm'
    else 'manual'
  end;
  q_rate_date := case when q_source = 'bnm' then nullif(quotation->>'fx_rate_date', '')::date end;

  -- FIN62 before anything is written. Only a new quotation or a draft: any
  -- other is refused by its guard (FIN01), and a missing one by FIN11 below.
  if sets_discount then
    e_pct := q_disc_pct;
    e_amount := q_disc_amount;
    if qid is not null and not exists (
      select 1 from public.finance_quotations where org_id = target_org and id = qid and status = 'draft'
    ) then
      e_pct := null;
      e_amount := null;
    end if;
  elsif qid is not null then
    select doc_discount_pct, doc_discount_amount into e_pct, e_amount
      from public.finance_quotations where org_id = target_org and id = qid and status = 'draft';
  end if;
  if num_nonnulls(e_pct, e_amount) = 1 and (e_pct is null or (e_pct > 0 and e_pct <= 100)) and (e_amount is null or e_amount > 0) then
    select coalesce(sum(round(
      case
        when nullif(l->>'discount_pct', '') is not null
          then (l->>'quantity')::numeric(14,3) * (l->>'unit_price')::numeric(14,4) * (1 - nullif(l->>'discount_pct', '')::numeric(5,2) / 100)
        when nullif(l->>'discount_amount', '') is not null
          then greatest((l->>'quantity')::numeric(14,3) * (l->>'unit_price')::numeric(14,4) - nullif(l->>'discount_amount', '')::numeric(14,2), 0)
        else (l->>'quantity')::numeric(14,3) * (l->>'unit_price')::numeric(14,4)
      end, 2)), 0) into s
      from jsonb_array_elements(lines) as l;
    d := coalesce(round(s * e_pct / 100, 2), e_amount);
    if d >= s then
      raise exception 'A discount on the whole document must leave something to pay.' using errcode = 'FIN62';
    end if;
  end if;

  if qid is null then
    insert into public.finance_quotations
      (org_id, customer_id, quote_date, valid_until, notes, status, currency, fx_rate, fx_rate_source, fx_rate_date,
       doc_discount_pct, doc_discount_amount)
    values (
      target_org,
      (quotation->>'customer_id')::uuid,
      (quotation->>'quote_date')::date,
      (quotation->>'valid_until')::date,
      nullif(quotation->>'notes', ''),
      'draft',
      q_currency,
      q_rate,
      q_source,
      q_rate_date,
      q_disc_pct,
      q_disc_amount
    )
    returning id into qid;
  else
    update public.finance_quotations
       set customer_id = (quotation->>'customer_id')::uuid,
           quote_date = (quotation->>'quote_date')::date,
           valid_until = (quotation->>'valid_until')::date,
           notes = nullif(quotation->>'notes', ''),
           currency = case when sets_currency then q_currency else currency end,
           fx_rate = case when sets_currency then q_rate else fx_rate end,
           fx_rate_source = case when sets_currency then q_source else fx_rate_source end,
           fx_rate_date = case when sets_currency then q_rate_date else fx_rate_date end,
           doc_discount_pct = case when sets_discount then q_disc_pct else doc_discount_pct end,
           doc_discount_amount = case when sets_discount then q_disc_amount else doc_discount_amount end,
           updated_at = now()
     where org_id = target_org and id = qid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the quotation no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_quotation_lines where org_id = target_org and quotation_id = qid;
  end if;

  insert into public.finance_quotation_lines
    (org_id, quotation_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate, discount_pct, discount_amount)
  select
    target_org, qid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0),
    nullif(l.line->>'discount_pct', '')::numeric,
    nullif(l.line->>'discount_amount', '')::numeric
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return qid;
end $$;

-- ============================================================================
-- 3. Converting a quotation: its discount comes too
-- ============================================================================
-- Replaced from 20261120100000_bendahara_invoice_currency.sql (lines 1019 to
-- 1087), the same three arguments (one function of that name:
-- bendahara_followons_check.sql counts them). Everything it did before it
-- still does, in the same order.
create or replace function public.finance_convert_quotation(
  target_org uuid,
  target_quotation uuid,
  invoice_date date default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  q record;
  terms integer;
  iid uuid;
  d date := coalesce(invoice_date, current_date);
  -- Scalars, null until set: a record that is never assigned cannot be read (55000) on the ringgit path.
  r_rate numeric;
  r_rate_date date;
begin
  select status, customer_id, notes, currency, doc_discount_pct, doc_discount_amount into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'accepted' then
    raise exception 'only an accepted quotation becomes an invoice' using errcode = 'FIN04';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = target_org and quotation_id = target_quotation and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;

  select payment_terms_days into terms from public.finance_contacts
  where org_id = target_org and id = q.customer_id;

  if q.currency <> 'MYR' then
    select s.rate, s.rate_date into r_rate, r_rate_date from private.finance_sst_fx_rate(q.currency, d) s;
  end if;

  insert into public.finance_invoices
    (org_id, customer_id, invoice_date, due_date, notes, status, quotation_id,
     currency, fx_rate, fx_rate_source, fx_rate_date, doc_discount_pct, doc_discount_amount)
  values (
    target_org,
    q.customer_id,
    d,
    d + coalesce(terms, 30),
    q.notes,
    'draft',
    target_quotation,
    q.currency,
    case when q.currency = 'MYR' then 1 else r_rate end,
    case when q.currency <> 'MYR' and r_rate is not null then 'bnm' end,
    case when q.currency <> 'MYR' then r_rate_date end,
    q.doc_discount_pct,
    q.doc_discount_amount
  )
  returning id into iid;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate, discount_pct, discount_amount)
  select target_org, iid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate,
         l.discount_pct, l.discount_amount
  from public.finance_quotation_lines l
  where l.org_id = target_org and l.quotation_id = target_quotation
  order by l.position, l.id;

  return iid;
end $$;

-- "create or replace" keeps the grants; said again so this file can be read alone.
revoke all on function public.finance_save_invoice(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.finance_save_invoice(uuid, jsonb, jsonb) to authenticated;
revoke all on function public.finance_save_quotation(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.finance_save_quotation(uuid, jsonb, jsonb) to authenticated;
revoke all on function public.finance_convert_quotation(uuid, uuid, date) from public, anon;
grant execute on function public.finance_convert_quotation(uuid, uuid, date) to authenticated;

-- ---- self-check ---------------------------------------------------------------------------
do $$
declare
  n integer;
  fn text;
begin
  foreach fn in array array['finance_save_invoice', 'finance_save_quotation', 'finance_convert_quotation'] loop
    select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = fn;
    if n <> 1 then raise exception '% has % definitions', fn, n; end if;
    select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = fn
       and not p.prosecdef
       and p.proconfig @> array['search_path=""']
       and pg_get_functiondef(p.oid) like '%doc_discount_pct%'
       and pg_get_functiondef(p.oid) like '%doc_discount_amount%';
    if n <> 1 then raise exception '% does not carry the document discount as an invoker with an empty search_path', fn; end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.finance_save_invoice(uuid, jsonb, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_save_quotation(uuid, jsonb, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_convert_quotation(uuid, uuid, date)', 'execute') then
    raise exception 'authenticated cannot call the save and convert functions';
  end if;
  if has_function_privilege('anon', 'public.finance_save_invoice(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.finance_save_quotation(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.finance_convert_quotation(uuid, uuid, date)', 'execute') then
    raise exception 'anon can call the save and convert functions';
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('finance_save_invoice', 'finance_save_quotation')
     and pg_get_functiondef(p.oid) like '%FIN62%';
  if n <> 2 then raise exception 'the save functions do not refuse FIN62 early (%)', n; end if;
end $$;
