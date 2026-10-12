-- Bendahara: RFQ steps. Each runs as the caller, so RLS and the guards apply.

set local lock_timeout = '5s';

-- Creates a draft RFQ, or replaces a draft. Returns its id.
create or replace function public.finance_save_rfq(target_org uuid, rfq jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rid uuid := nullif(rfq->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an RFQ needs at least one line' using errcode = 'FIN10';
  end if;

  if rid is null then
    insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status)
    values (
      target_org,
      (rfq->>'supplier_id')::uuid,
      (rfq->>'rfq_date')::date,
      nullif(rfq->>'reply_by', '')::date,
      nullif(rfq->>'notes', ''),
      'draft'
    )
    returning id into rid;
  else
    update public.finance_rfqs
       set supplier_id = (rfq->>'supplier_id')::uuid,
           rfq_date = (rfq->>'rfq_date')::date,
           reply_by = nullif(rfq->>'reply_by', '')::date,
           notes = nullif(rfq->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = rid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_rfq_lines where org_id = target_org and rfq_id = rid;
  end if;

  insert into public.finance_rfq_lines
    (org_id, rfq_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, rid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    nullif(l.line->>'unit_price', '')::numeric,
    coalesce(nullif(l.line->>'sst_rate', '')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return rid;
end $$;

-- Marks a draft RFQ as sent and returns its number. Nothing is emailed:
-- "sent" records that the supplier has been given it.
create or replace function public.finance_send_rfq(target_org uuid, target_rfq uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  no text;
begin
  select status into r from public.finance_rfqs
  where org_id = target_org and id = target_rfq for update;
  if not found then
    raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
  end if;
  if r.status <> 'draft' then
    raise exception 'the RFQ has already been sent' using errcode = 'FIN01';
  end if;
  if not exists (
    select 1 from public.finance_rfq_lines where org_id = target_org and rfq_id = target_rfq
  ) then
    raise exception 'an RFQ needs at least one line' using errcode = 'FIN10';
  end if;

  no := public.finance_next_number(target_org, 'rfq');
  update public.finance_rfqs
     set status = 'sent', rfq_no = no
   where org_id = target_org and id = target_rfq;
  return no;
end $$;

-- Records the supplier's answer: a price for each line, and their own
-- reference if they gave one. Every line must end up priced.
create or replace function public.finance_quote_rfq(
  target_org uuid, target_rfq uuid, prices jsonb, supplier_reference text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
begin
  select status into r from public.finance_rfqs
  where org_id = target_org and id = target_rfq for update;
  if not found then
    raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
  end if;
  if r.status <> 'sent' then
    raise exception 'prices are recorded on an RFQ that has been sent' using errcode = 'FIN01';
  end if;
  if jsonb_typeof(prices) is distinct from 'array' then
    raise exception 'every line needs a price before the RFQ is marked as quoted' using errcode = 'FIN19';
  end if;

  update public.finance_rfq_lines l
     set unit_price = (p->>'unit_price')::numeric,
         sst_rate = coalesce(nullif(p->>'sst_rate', '')::numeric, l.sst_rate),
         updated_at = now()
    from jsonb_array_elements(prices) as p
   where l.org_id = target_org and l.rfq_id = target_rfq and l.id = (p->>'line_id')::uuid;

  update public.finance_rfqs
     set status = 'quoted', supplier_ref = nullif(btrim(coalesce(supplier_reference, '')), '')
   where org_id = target_org and id = target_rfq;
end $$;

-- Turns a quoted RFQ into a draft purchase order with the same supplier and
-- lines, and returns the order's id. One order per RFQ; a cancelled order
-- frees it to be converted again.
create or replace function public.finance_convert_rfq(target_org uuid, target_rfq uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  pid uuid;
begin
  select status, supplier_id, notes into r from public.finance_rfqs
  where org_id = target_org and id = target_rfq for update;
  if not found then
    raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
  end if;
  if r.status <> 'quoted' then
    raise exception 'only a quoted RFQ becomes a purchase order' using errcode = 'FIN01';
  end if;
  if exists (
    select 1 from public.finance_purchase_orders
    where org_id = target_org and rfq_id = target_rfq and status <> 'cancelled'
  ) then
    raise exception 'the RFQ has a purchase order' using errcode = 'FIN22';
  end if;

  insert into public.finance_purchase_orders (org_id, supplier_id, rfq_id, po_date, notes, status)
  values (target_org, r.supplier_id, target_rfq, current_date, r.notes, 'draft')
  returning id into pid;

  insert into public.finance_purchase_order_lines
    (org_id, purchase_order_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, pid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_rfq_lines l
  where l.org_id = target_org and l.rfq_id = target_rfq
  order by l.position, l.id;

  return pid;
end $$;

-- The supplier declined, or the RFQ was not taken up.
create or replace function public.finance_close_rfq(target_org uuid, target_rfq uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  update public.finance_rfqs set status = 'closed'
   where org_id = target_org and id = target_rfq;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'the RFQ no longer exists' using errcode = 'FIN11';
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_rfq(uuid, jsonb, jsonb)',
    'public.finance_send_rfq(uuid, uuid)',
    'public.finance_quote_rfq(uuid, uuid, jsonb, text)',
    'public.finance_convert_rfq(uuid, uuid)',
    'public.finance_close_rfq(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
