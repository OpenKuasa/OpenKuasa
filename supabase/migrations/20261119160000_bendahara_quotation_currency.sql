-- Bendahara multi-currency, stage 2: a currency on quotations, and a default
-- currency on contacts (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- "On each document" and "Contacts"). Quotations post nothing to the ledger,
-- so no book moves. Additive and safe to apply while the previous code is
-- still deployed: every existing quotation becomes MYR at rate 1, its ringgit
-- figures equal its figures, and the deployed code neither reads nor writes
-- a new column (its save function call sends no currency, which leaves a
-- draft's currency as it is and makes a new one MYR).
--
--   * public.finance_currency: a domain holding the ISO 4217 codes a document
--     may carry (none with three decimals). src/lib/finance/currencies.ts has
--     the same list; tests/finance-currencies.test.ts holds them equal.
--   * finance_quotations gains currency (MYR), fx_rate (ringgit per one unit:
--     1 for MYR; null only on a foreign draft whose rate is not known yet),
--     fx_rate_source ('bnm' or 'manual'; null for MYR and while there is no
--     rate) and fx_rate_date (the BNM rate_date of a 'bnm' rate). The guard
--     finance_quotation_guard already compares the whole row once a quotation
--     is sent, so the new columns are locked with the rest (re-read for this
--     file; not changed).
--   * finance_quotation_lines gains fx_rate, a copy of its quotation's, set by
--     the trigger finance_quotation_line_rate and carried to the lines by
--     finance_quotation_rate_to_lines when the quotation's rate changes, and
--     amount_myr and sst_amount_myr, generated: the line's amount and SST at
--     that rate, rounded to the sen. Postgres does not let one generated
--     column read another, so each repeats amount's (and sst_amount's)
--     expression from 20261118100000 inside its round(… * fx_rate, 2).
--   * finance_quotation_rate_guard: a quotation in another currency is not
--     marked as sent without a rate (FIN38), and a rate marked as Bank
--     Negara's must be the one BNM published for that currency and date in
--     finance_fx_rates (FIN39).
--   * finance_quotation_totals gains, at the end, currency, fx_rate,
--     fx_rate_source, fx_rate_date, subtotal_myr, sst_myr and total_myr
--     (null while a foreign draft has no rate). Its other columns are as they
--     were (20261022100000).
--   * finance_save_quotation (20261118100000) also writes the four columns,
--     when the caller sends `currency`; a caller that sends none leaves them.
--   * finance_convert_quotation (20261118100000) refuses a quotation that is
--     not in MYR (FIN40): invoices carry no currency until stage 3.
--   * finance_contacts gains default_currency (null or a code): it only fills
--     a new quotation's currency in the form.
--
-- Error codes taken: FIN38, FIN39, FIN40 (grep of every migration on main:
-- the highest in use is FIN37; FIN29 and FIN31-FIN36 are left to the contra
-- plan).
--
-- Nothing here is granted to service_role: every write is made by a signed-in
-- person through the authenticated role.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- the currencies a document may carry ----------------------------------------
create domain public.finance_currency as text
  constraint finance_currency_check check (value in (
    'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BIF',
    'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
    'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD',
    'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR',
    'ILS', 'INR', 'IRR', 'ISK', 'JMD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KYD', 'KZT',
    'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR',
    'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK',
    'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK',
    'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TOP',
    'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF',
    'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG'
  ));

-- ---- quotations ----------------------------------------------------------------------
-- NaN is above every number in Postgres, so "above 0" names it.
alter table public.finance_quotations
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) default 1,
  add column fx_rate_source text,
  add column fx_rate_date date,
  add constraint finance_quotations_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  -- MYR is rate 1 with no source. Another currency has no rate yet (no source,
  -- no date), or BNM's rate (with its date), or a typed one (with none).
  add constraint finance_quotations_fx_check check (
    case
      when currency = 'MYR' then fx_rate is not null and fx_rate = 1 and fx_rate_source is null and fx_rate_date is null
      when fx_rate is null then fx_rate_source is null and fx_rate_date is null
      when fx_rate_source = 'bnm' then fx_rate_date is not null
      when fx_rate_source = 'manual' then fx_rate_date is null
      else false
    end
  ),
  -- Behind finance_quotation_rate_guard, which answers FIN38 first.
  add constraint finance_quotations_sent_rate_check check (status = 'draft' or fx_rate is not null);

-- ---- quotation lines -----------------------------------------------------------------
alter table public.finance_quotation_lines
  add column fx_rate numeric(20,10) default 1,
  add constraint finance_quotation_lines_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN');

alter table public.finance_quotation_lines
  add column amount_myr numeric(14,2) generated always as (
    round(
      round(
        case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end, 2) * fx_rate, 2)
  ) stored,
  add column sst_amount_myr numeric(14,2) generated always as (
    round(
      round(
        (case
          when discount_pct is not null then quantity * unit_price * (1 - discount_pct / 100)
          when discount_amount is not null then greatest(quantity * unit_price - discount_amount, 0)
          else quantity * unit_price
        end) * sst_rate / 100, 2) * fx_rate, 2)
  ) stored;

-- A line's rate is its quotation's, whatever the caller sent. It fires after
-- finance_quotation_line_guard (triggers fire by name), so a line of a sent
-- quotation is refused first with FIN01, as before.
create function private.finance_quotation_line_rate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r numeric;
begin
  select fx_rate into r from public.finance_quotations where org_id = new.org_id and id = new.quotation_id;
  -- No quotation: the foreign key refuses the line next.
  if found then
    new.fx_rate := r;
  end if;
  return new;
end $$;

create trigger finance_quotation_line_rate
  before insert or update on public.finance_quotation_lines
  for each row execute function private.finance_quotation_line_rate();

-- A draft's rate changed: its lines take it, and their ringgit figures follow.
-- Only a draft's rate can change (finance_quotation_guard), so the line guard
-- lets these updates through. Not reached from a user's or a workspace's
-- deletion: neither changes fx_rate.
create function private.finance_quotation_rate_to_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.finance_quotation_lines
     set fx_rate = new.fx_rate
   where org_id = new.org_id and quotation_id = new.id;
  return null;
end $$;

create trigger finance_quotation_rate_to_lines
  after update of fx_rate on public.finance_quotations
  for each row when (new.fx_rate is distinct from old.fx_rate)
  execute function private.finance_quotation_rate_to_lines();

-- Fires after finance_quotation_guard (by name), so a sent quotation is still
-- refused with FIN01 first, and then returns at once: only a draft, or a
-- draft being marked as sent, is looked at here.
create function private.finance_quotation_rate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  if new.status <> 'draft' and new.fx_rate is null then
    raise exception 'a quotation in another currency needs its exchange rate before it is sent' using errcode = 'FIN38';
  end if;
  if new.fx_rate_source = 'bnm' and not exists (
    select 1 from public.finance_fx_rates r
    where r.source = 'bnm' and r.session = '1700' and r.currency = new.currency
      and r.rate_date = new.fx_rate_date and r.rate = new.fx_rate
  ) then
    raise exception 'a rate marked as Bank Negara''s is not the one it published for that day' using errcode = 'FIN39';
  end if;
  return new;
end $$;

create trigger finance_quotation_rate_guard
  before insert or update of currency, fx_rate, fx_rate_source, fx_rate_date, status on public.finance_quotations
  for each row execute function private.finance_quotation_rate_guard();

revoke all on function private.finance_quotation_line_rate() from public, anon, authenticated, service_role;
revoke all on function private.finance_quotation_rate_to_lines() from public, anon, authenticated, service_role;
revoke all on function private.finance_quotation_rate_guard() from public, anon, authenticated, service_role;

-- ---- contacts ----------------------------------------------------------------------------
alter table public.finance_contacts
  add column default_currency public.finance_currency;

-- ---- the totals view: the same columns, and the ringgit ones at the end ---------------------
-- Replaced from 20261022100000 (the only definition): every column before
-- invoice_no is as it was, in its place. create or replace view resets the
-- view's options, so security_invoker is said again; its grants are kept and
-- said again too.
create or replace view public.finance_quotation_totals with (security_invoker = true) as
select
  q.id,
  q.org_id,
  q.customer_id,
  c.name as customer_name,
  q.quotation_no,
  q.quote_date,
  q.valid_until,
  q.notes,
  q.status,
  q.sent_at,
  q.accepted_at,
  q.created_by,
  q.created_at,
  q.updated_at,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  case
    when q.status = 'sent' and q.valid_until < current_date then 'expired'
    else q.status
  end as display_status,
  x.id as invoice_id,
  x.invoice_no,
  q.currency,
  q.fx_rate,
  q.fx_rate_source,
  q.fx_rate_date,
  (case when q.fx_rate is null then null else coalesce(l.subtotal_myr, 0) end)::numeric(14,2) as subtotal_myr,
  (case when q.fx_rate is null then null else coalesce(l.sst_myr, 0) end)::numeric(14,2) as sst_myr,
  (case when q.fx_rate is null then null else coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) end)::numeric(14,2) as total_myr
from public.finance_quotations q
join public.finance_contacts c on c.org_id = q.org_id and c.id = q.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst, sum(amount_myr) as subtotal_myr, sum(sst_amount_myr) as sst_myr
  from public.finance_quotation_lines
  where org_id = q.org_id and quotation_id = q.id
) l on true
left join public.finance_invoices x
  on x.org_id = q.org_id and x.quotation_id = q.id and x.status <> 'void';
revoke all on public.finance_quotation_totals from anon, authenticated;
grant select on public.finance_quotation_totals to authenticated;

-- ---- saving a quotation: the currency, when the caller sends one ---------------------------
-- Replaced from 20261118100000: security invoker, search_path '', returns uuid,
-- its grants (revoke from public, anon; execute to authenticated) kept by
-- create or replace. Everything it did before it still does, in the same
-- order. New: when `quotation` has the key "currency", the four currency
-- columns are written from it (MYR: rate 1, no source, no date; another
-- currency: the rate sent or none, its source, and the BNM date only for a
-- BNM rate); without the key they are left as they are, and a new quotation
-- is MYR.
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
  q_currency text := coalesce(nullif(quotation->>'currency', ''), 'MYR');
  q_rate numeric;
  q_source text;
  q_rate_date date;
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

  if qid is null then
    insert into public.finance_quotations
      (org_id, customer_id, quote_date, valid_until, notes, status, currency, fx_rate, fx_rate_source, fx_rate_date)
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
      q_rate_date
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

-- ---- converting: not for a quotation in another currency, yet ------------------------------
-- Replaced from 20261118100000: security invoker, search_path '', returns
-- uuid, the same three arguments (one function: bendahara_followons_check.sql
-- counts them), its grants kept by create or replace. Everything it did
-- before it still does, in the same order; a quotation not in MYR is refused
-- after the status test, before anything is written.
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
begin
  select status, customer_id, notes, currency into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'accepted' then
    raise exception 'only an accepted quotation becomes an invoice' using errcode = 'FIN04';
  end if;
  if q.currency <> 'MYR' then
    raise exception 'an invoice in another currency is not possible yet' using errcode = 'FIN40';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = target_org and quotation_id = target_quotation and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;

  select payment_terms_days into terms from public.finance_contacts
  where org_id = target_org and id = q.customer_id;

  insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status, quotation_id)
  values (
    target_org,
    q.customer_id,
    coalesce(invoice_date, current_date),
    coalesce(invoice_date, current_date) + coalesce(terms, 30),
    q.notes,
    'draft',
    target_quotation
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

-- ---- nothing was left out --------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
begin
  -- The BEFORE triggers on each table, in the order they fire: the guard first, then the new one.
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_quotations'::regclass and not tgisinternal and (tgtype & 2) = 2;
  if coalesce(t, '') !~ '(^|,)finance_quotation_guard,(.*,)?finance_quotation_rate_guard(,|$)' then
    raise exception 'the BEFORE triggers on finance_quotations are not in the order this file needs: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_trigger
   where tgrelid = 'public.finance_quotation_lines'::regclass and not tgisinternal and (tgtype & 2) = 2;
  if coalesce(t, '') !~ '(^|,)finance_quotation_line_guard,(.*,)?finance_quotation_line_rate(,|$)' then
    raise exception 'the BEFORE triggers on finance_quotation_lines are not in the order this file needs: %', t;
  end if;
  -- Every quotation reads as it did: MYR, rate 1, its ringgit total its total.
  select count(*) into n from public.finance_quotation_totals
   where currency <> 'MYR' or fx_rate <> 1 or total_myr is distinct from total
      or subtotal_myr is distinct from subtotal or sst_myr is distinct from sst;
  if n <> 0 then
    raise exception '% quotations do not read as they did', n;
  end if;
  -- The functions keep who may call them.
  foreach t in array array['public.finance_save_quotation(uuid, jsonb, jsonb)', 'public.finance_convert_quotation(uuid, uuid, date)'] loop
    if has_function_privilege('anon', t, 'execute') or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  foreach t in array array['private.finance_quotation_line_rate()', 'private.finance_quotation_rate_to_lines()', 'private.finance_quotation_rate_guard()'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception 'a trigger function can be called directly: %', t;
    end if;
  end loop;
  if not exists (select 1 from pg_class where oid = 'public.finance_quotation_totals'::regclass
                  and reloptions @> array['security_invoker=true']) then
    raise exception 'finance_quotation_totals no longer reads as its caller';
  end if;
end $$;
