-- Bendahara: what a purchase order carries, what has arrived in money, and a
-- record of each decision.
--
--   1. An order carries its own payment terms and an optional delivery
--      address. The terms start from the supplier's and can be changed per
--      order (cash on delivery for a new supplier, say); a bill raised from
--      the order takes its due date from them.
--   2. finance_purchase_order_totals also says what has arrived, valued at the
--      order's prices, so a bill can be compared with what was delivered and
--      not only with what was ordered.
--   3. finance_bill_purchase_orders names the order each linked bill belongs
--      to, for the bills list.
--   4. Submitting, approving, rejecting, withdrawing, closing and cancelling
--      an order are written to the activity log. A rejected order goes back
--      to draft and its reason is cleared when it is submitted again; the
--      log keeps it.

set local lock_timeout = '5s';

-- ---- 1. terms and address ----------------------------------------------------
alter table public.finance_purchase_orders
  add column payment_terms_days integer check (payment_terms_days >= 0),
  add column delivery_address text check (char_length(delivery_address) <= 500);

-- Orders that already exist take their supplier's terms. Nobody is signed in
-- here, so the guard steps aside.
update public.finance_purchase_orders p
   set payment_terms_days = c.payment_terms_days
  from public.finance_contacts c
 where c.org_id = p.org_id and c.id = p.supplier_id and p.payment_terms_days is null;

-- The body of 20261103094500 with the two new fields. A new order with no
-- terms given takes the supplier's. Changing a draft keeps its terms and
-- address unless the caller sends them.
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
    insert into public.finance_purchase_orders
      (org_id, supplier_id, po_date, expected_date, notes, status, payment_terms_days, delivery_address)
    values (
      target_org,
      (purchase_order->>'supplier_id')::uuid,
      (purchase_order->>'po_date')::date,
      nullif(purchase_order->>'expected_date', '')::date,
      nullif(purchase_order->>'notes', ''),
      'draft',
      coalesce(
        nullif(purchase_order->>'payment_terms_days', '')::integer,
        (select c.payment_terms_days from public.finance_contacts c
          where c.org_id = target_org and c.id = (purchase_order->>'supplier_id')::uuid)
      ),
      nullif(btrim(coalesce(purchase_order->>'delivery_address', '')), '')
    )
    returning id into pid;
  else
    update public.finance_purchase_orders
       set supplier_id = (purchase_order->>'supplier_id')::uuid,
           po_date = (purchase_order->>'po_date')::date,
           expected_date = nullif(purchase_order->>'expected_date', '')::date,
           notes = nullif(purchase_order->>'notes', ''),
           payment_terms_days = case
             when purchase_order ? 'payment_terms_days'
               then nullif(purchase_order->>'payment_terms_days', '')::integer
             else payment_terms_days
           end,
           delivery_address = case
             when purchase_order ? 'delivery_address'
               then nullif(btrim(coalesce(purchase_order->>'delivery_address', '')), '')
             else delivery_address
           end,
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

-- The body of 20261103093000; the order it makes now starts with the
-- supplier's payment terms.
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

  insert into public.finance_purchase_orders
    (org_id, supplier_id, rfq_id, po_date, notes, status, payment_terms_days)
  values (
    target_org, r.supplier_id, target_rfq, current_date, r.notes, 'draft',
    (select c.payment_terms_days from public.finance_contacts c
      where c.org_id = target_org and c.id = r.supplier_id)
  )
  returning id into pid;

  insert into public.finance_purchase_order_lines
    (org_id, purchase_order_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, pid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_rfq_lines l
  where l.org_id = target_org and l.rfq_id = target_rfq
  order by l.position, l.id;

  return pid;
end $$;

-- ---- 2. totals, with what has arrived -----------------------------------------
-- A view's "p.*" is fixed when the view is made, so it is made again to carry
-- the two new columns. No other view or function is built on this one.
drop view public.finance_purchase_order_totals;

create view public.finance_purchase_order_totals with (security_invoker = true) as
select
  p.*,
  c.name as supplier_name,
  r.rfq_no,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst_total,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  case
    when coalesce(l.started, 0) = 0 then 'pending'
    when coalesce(l.outstanding, 0) = 0 then 'delivered'
    else 'partial'
  end as delivery,
  -- What has arrived, at the order's prices and SST rates.
  coalesce(l.received, 0)::numeric(14,2) as received_total,
  coalesce(b.billed, 0)::numeric(14,2) as billed_total,
  (coalesce(b.billed, 0) > coalesce(l.subtotal, 0) + coalesce(l.sst, 0)) as over_billed,
  -- Billed for more than has arrived: the usual thing to catch before paying.
  (coalesce(b.billed, 0) > coalesce(l.received, 0)) as billed_over_received
from public.finance_purchase_orders p
join public.finance_contacts c on c.org_id = p.org_id and c.id = p.supplier_id
left join public.finance_rfqs r on r.org_id = p.org_id and r.id = p.rfq_id
left join lateral (
  select
    sum(amount) as subtotal,
    sum(sst_amount) as sst,
    count(*) filter (where received_quantity > 0) as started,
    count(*) filter (where received_quantity < quantity) as outstanding,
    sum(round(received_quantity * unit_price, 2) + round(received_quantity * unit_price * sst_rate / 100, 2)) as received
  from public.finance_purchase_order_lines
  where org_id = p.org_id and purchase_order_id = p.id
) l on true
left join lateral (
  -- Every bill raised against the order that has not been voided, drafts included.
  select sum(bl.amount + bl.sst_amount) as billed
  from public.supplier_bills sb
  join public.supplier_bill_lines bl on bl.org_id = sb.org_id and bl.bill_id = sb.id
  where sb.org_id = p.org_id and sb.purchase_order_id = p.id and sb.status <> 'void'
) b on true;

revoke all on public.finance_purchase_order_totals from anon, authenticated;
grant select on public.finance_purchase_order_totals to authenticated;

-- ---- 3. the order behind each linked bill --------------------------------------
create view public.finance_bill_purchase_orders with (security_invoker = true) as
select
  sb.org_id,
  sb.id as bill_id,
  p.id as purchase_order_id,
  p.po_no,
  p.status as purchase_order_status
from public.supplier_bills sb
join public.finance_purchase_orders p on p.org_id = sb.org_id and p.id = sb.purchase_order_id;

revoke all on public.finance_bill_purchase_orders from anon, authenticated;
grant select on public.finance_bill_purchase_orders to authenticated;

-- ---- 4. each decision, in the activity log --------------------------------------
-- Runs after the guard has allowed the change, as the table's owner: the
-- activity log is closed to the authenticated role. The person is whoever is
-- signed in; with nobody signed in (a migration) nothing is written.
create or replace function private.finance_purchase_order_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  what text;
  about text := coalesce(new.po_no, 'a draft');
begin
  if me is null or new.status is not distinct from old.status then
    return null;
  end if;
  -- A draft that was never submitted has no number and nobody else saw it.
  if new.status = 'cancelled' and old.po_no is null then
    return null;
  end if;

  if old.status = 'draft' and new.status = 'pending_approval' then
    what := 'Submitted a purchase order for approval';
  elsif old.status = 'pending_approval' and new.status = 'approved' then
    what := 'Approved a purchase order';
  elsif old.status = 'pending_approval' and new.status = 'draft' and new.rejected_at is distinct from old.rejected_at then
    what := 'Rejected a purchase order';
    about := about || ': ' || coalesce(new.rejection_reason, '');
  elsif old.status = 'pending_approval' and new.status = 'draft' then
    what := 'Withdrew a purchase order from approval';
  elsif new.status = 'closed' then
    what := 'Closed a purchase order';
  elsif new.status = 'cancelled' then
    what := 'Cancelled a purchase order';
  else
    return null;
  end if;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (new.org_id, me, private.display_name(me), what, left(about, 200), 'data', 'members');
  return null;
end $$;
revoke all on function private.finance_purchase_order_log() from public, anon, authenticated;

create trigger finance_purchase_order_log
  after update on public.finance_purchase_orders
  for each row execute function private.finance_purchase_order_log();
