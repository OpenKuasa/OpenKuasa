-- Bendahara: a supplier bill may be raised against a purchase order.

set local lock_timeout = '5s';

-- A bill points only at an approved order from the same supplier. The check
-- runs when the link or the supplier changes, so a bill already linked is not
-- disturbed when its order is later closed.
create or replace function private.finance_bill_po_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.purchase_order_id is not distinct from old.purchase_order_id
     and new.supplier_id = old.supplier_id then
    return new;
  end if;
  if new.purchase_order_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.finance_purchase_orders p
    where p.org_id = new.org_id and p.id = new.purchase_order_id
      and p.status = 'approved' and p.supplier_id = new.supplier_id
  ) then
    raise exception 'a bill is raised against an approved purchase order from the same supplier'
      using errcode = 'FIN21';
  end if;
  return new;
end $$;
revoke all on function private.finance_bill_po_link_guard() from public, anon, authenticated;

create trigger finance_bill_po_link
  before insert or update on public.supplier_bills
  for each row execute function private.finance_bill_po_link_guard();

-- The body of 20261013100000 with purchase_order_id. On an update the link is
-- only touched when the caller sends the key, so a form that does not know
-- about purchase orders leaves it alone.
create or replace function public.finance_save_bill(target_org uuid, bill jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bid uuid := nullif(bill->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a bill needs at least one line' using errcode = 'FIN10';
  end if;

  if bid is null then
    insert into public.supplier_bills
      (org_id, supplier_id, supplier_ref, bill_date, due_date, notes, status, purchase_order_id)
    values (
      target_org,
      (bill->>'supplier_id')::uuid,
      nullif(bill->>'supplier_ref', ''),
      (bill->>'bill_date')::date,
      (bill->>'due_date')::date,
      nullif(bill->>'notes', ''),
      'draft',
      nullif(bill->>'purchase_order_id', '')::uuid
    )
    returning id into bid;
  else
    update public.supplier_bills
       set supplier_id = (bill->>'supplier_id')::uuid,
           supplier_ref = nullif(bill->>'supplier_ref', ''),
           bill_date = (bill->>'bill_date')::date,
           due_date = (bill->>'due_date')::date,
           notes = nullif(bill->>'notes', ''),
           purchase_order_id = case
             when bill ? 'purchase_order_id' then nullif(bill->>'purchase_order_id', '')::uuid
             else purchase_order_id
           end,
           updated_at = now()
     where org_id = target_org and id = bid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the bill no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.supplier_bill_lines where org_id = target_org and bill_id = bid;
  end if;

  insert into public.supplier_bill_lines
    (org_id, bill_id, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, bid,
    nullif(l->>'product_id', '')::uuid,
    l->>'description',
    (l->>'quantity')::numeric,
    nullif(l->>'uom', ''),
    nullif(l->>'pack_size', ''),
    (l->>'unit_price')::numeric,
    coalesce((l->>'sst_rate')::numeric, 0)
  from jsonb_array_elements(lines) as l;

  return bid;
end $$;
