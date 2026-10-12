-- Bendahara: purchase order steps. Each runs as the caller; who may take a
-- step is decided by private.finance_purchase_order_guard.

set local lock_timeout = '5s';

-- Creates a draft order, or replaces a draft. Returns its id.
create or replace function public.finance_save_purchase_order(target_org uuid, purchase_order jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  pid uuid := nullif(purchase_order->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a purchase order needs at least one line' using errcode = 'FIN10';
  end if;

  if pid is null then
    insert into public.finance_purchase_orders (org_id, supplier_id, po_date, expected_date, notes, status)
    values (
      target_org,
      (purchase_order->>'supplier_id')::uuid,
      (purchase_order->>'po_date')::date,
      nullif(purchase_order->>'expected_date', '')::date,
      nullif(purchase_order->>'notes', ''),
      'draft'
    )
    returning id into pid;
  else
    update public.finance_purchase_orders
       set supplier_id = (purchase_order->>'supplier_id')::uuid,
           po_date = (purchase_order->>'po_date')::date,
           expected_date = nullif(purchase_order->>'expected_date', '')::date,
           notes = nullif(purchase_order->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = pid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_purchase_order_lines where org_id = target_org and purchase_order_id = pid;
  end if;

  insert into public.finance_purchase_order_lines
    (org_id, purchase_order_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, pid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce(nullif(l.line->>'sst_rate', '')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return pid;
end $$;

-- Sends a draft for approval and returns its number. The number is taken the
-- first time; an order that was rejected and is submitted again keeps it.
create or replace function public.finance_submit_purchase_order(target_org uuid, target_po uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  p record;
  total numeric;
  no text;
begin
  select status, po_no into p from public.finance_purchase_orders
  where org_id = target_org and id = target_po for update;
  if not found then
    raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
  end if;
  if p.status <> 'draft' then
    raise exception 'the purchase order has already been submitted' using errcode = 'FIN01';
  end if;
  select coalesce(sum(amount + sst_amount), 0) into total
  from public.finance_purchase_order_lines where org_id = target_org and purchase_order_id = target_po;
  if total <= 0 then
    raise exception 'a purchase order needs an amount before it is submitted' using errcode = 'FIN10';
  end if;

  no := coalesce(p.po_no, public.finance_next_number(target_org, 'purchase_order'));
  update public.finance_purchase_orders
     set status = 'pending_approval', po_no = no
   where org_id = target_org and id = target_po;
  return no;
end $$;

-- Approves, or rejects with a reason. A rejected order returns to draft.
create or replace function public.finance_decide_purchase_order(
  target_org uuid, target_po uuid, approve boolean, reason text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  p record;
  why text := nullif(btrim(coalesce(reason, '')), '');
begin
  select status into p from public.finance_purchase_orders
  where org_id = target_org and id = target_po for update;
  if not found then
    raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
  end if;
  if p.status <> 'pending_approval' then
    raise exception 'only a purchase order waiting for approval is approved or rejected' using errcode = 'FIN01';
  end if;

  if approve then
    update public.finance_purchase_orders set status = 'approved'
     where org_id = target_org and id = target_po;
  else
    if why is null then
      raise exception 'a rejection needs a reason' using errcode = 'FIN10';
    end if;
    update public.finance_purchase_orders set status = 'draft', rejection_reason = why
     where org_id = target_org and id = target_po;
  end if;
end $$;

-- Takes an order back from approval so it can be corrected.
create or replace function public.finance_withdraw_purchase_order(target_org uuid, target_po uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  p record;
begin
  select status into p from public.finance_purchase_orders
  where org_id = target_org and id = target_po for update;
  if not found then
    raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
  end if;
  if p.status <> 'pending_approval' then
    raise exception 'only a purchase order waiting for approval is withdrawn' using errcode = 'FIN01';
  end if;
  update public.finance_purchase_orders set status = 'draft', rejection_reason = null
   where org_id = target_org and id = target_po;
end $$;

-- Records what has arrived. Each entry is the total received so far for one
-- line, not the amount of this delivery.
create or replace function public.finance_receive_purchase_order(target_org uuid, target_po uuid, receipts jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  p record;
  n integer;
begin
  select status into p from public.finance_purchase_orders
  where org_id = target_org and id = target_po for share;
  if not found then
    raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
  end if;
  if p.status <> 'approved' then
    raise exception 'deliveries are recorded once the purchase order is approved' using errcode = 'FIN01';
  end if;
  if jsonb_typeof(receipts) is distinct from 'array' or jsonb_array_length(receipts) = 0 then
    raise exception 'nothing was recorded' using errcode = 'FIN10';
  end if;

  update public.finance_purchase_order_lines l
     set received_quantity = (r->>'received_quantity')::numeric, updated_at = now()
    from jsonb_array_elements(receipts) as r
   where l.org_id = target_org and l.purchase_order_id = target_po and l.id = (r->>'line_id')::uuid;
  get diagnostics n = row_count;
  if n <> jsonb_array_length(receipts) then
    raise exception 'a line of the purchase order no longer exists' using errcode = 'FIN11';
  end if;
end $$;

-- No more deliveries or bills are expected.
create or replace function public.finance_close_purchase_order(target_org uuid, target_po uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  update public.finance_purchase_orders set status = 'closed'
   where org_id = target_org and id = target_po;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
  end if;
end $$;

create or replace function public.finance_cancel_purchase_order(target_org uuid, target_po uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  update public.finance_purchase_orders set status = 'cancelled'
   where org_id = target_org and id = target_po;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'the purchase order no longer exists' using errcode = 'FIN11';
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_purchase_order(uuid, jsonb, jsonb)',
    'public.finance_submit_purchase_order(uuid, uuid)',
    'public.finance_decide_purchase_order(uuid, uuid, boolean, text)',
    'public.finance_withdraw_purchase_order(uuid, uuid)',
    'public.finance_receive_purchase_order(uuid, uuid, jsonb)',
    'public.finance_close_purchase_order(uuid, uuid)',
    'public.finance_cancel_purchase_order(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
