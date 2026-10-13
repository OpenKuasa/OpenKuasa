-- Bendahara: RFQs and purchase orders, totals and rules.

set local lock_timeout = '5s';

-- ---- totals -------------------------------------------------------------------
create view public.finance_rfq_totals with (security_invoker = true) as
select
  r.*,
  c.name as supplier_name,
  coalesce(l.line_count, 0)::integer as line_count,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst_total,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  (coalesce(l.line_count, 0) > 0 and coalesce(l.unpriced, 0) = 0) as fully_priced,
  po.id as purchase_order_id,
  po.po_no as purchase_order_no
from public.finance_rfqs r
join public.finance_contacts c on c.org_id = r.org_id and c.id = r.supplier_id
left join lateral (
  select
    count(*) as line_count,
    count(*) filter (where unit_price is null) as unpriced,
    sum(round(quantity * unit_price, 2)) as subtotal,
    sum(round(quantity * unit_price * sst_rate / 100, 2)) as sst
  from public.finance_rfq_lines
  where org_id = r.org_id and rfq_id = r.id
) l on true
left join lateral (
  -- The order this RFQ became, if any. A cancelled one does not count.
  select p.id, p.po_no
  from public.finance_purchase_orders p
  where p.org_id = r.org_id and p.rfq_id = r.id and p.status <> 'cancelled'
  order by p.created_at
  limit 1
) po on true;

revoke all on public.finance_rfq_totals from anon, authenticated;
grant select on public.finance_rfq_totals to authenticated;

-- delivery and billed_total are worked out here, never stored.
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
  coalesce(b.billed, 0)::numeric(14,2) as billed_total,
  (coalesce(b.billed, 0) > coalesce(l.subtotal, 0) + coalesce(l.sst, 0)) as over_billed
from public.finance_purchase_orders p
join public.finance_contacts c on c.org_id = p.org_id and c.id = p.supplier_id
left join public.finance_rfqs r on r.org_id = p.org_id and r.id = p.rfq_id
left join lateral (
  select
    sum(amount) as subtotal,
    sum(sst_amount) as sst,
    count(*) filter (where received_quantity > 0) as started,
    count(*) filter (where received_quantity < quantity) as outstanding
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

-- ---- guards -------------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted, and when nobody
-- is signed in (a migration, or a deleted user being cleared from a row).

create or replace function private.finance_rfq_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  kept text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'an RFQ starts as a draft' using errcode = 'FIN01';
    end if;
    if me is not null then
      new.created_by := me;
    end if;
    new.rfq_no := null;
    new.sent_at := null;
    new.quoted_at := null;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'an RFQ that has been sent cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if me is null or to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  if new.created_by is distinct from old.created_by or new.org_id <> old.org_id then
    raise exception 'who raised an RFQ does not change' using errcode = 'FIN01';
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    new.rfq_no := null;
    new.sent_at := null;
    new.quoted_at := null;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'sent' then
    if new.rfq_no is null then
      raise exception 'an RFQ is given its number when it is sent' using errcode = 'FIN01';
    end if;
    if not exists (
      select 1 from public.finance_rfq_lines where org_id = old.org_id and rfq_id = old.id
    ) then
      raise exception 'an RFQ needs at least one line' using errcode = 'FIN10';
    end if;
    kept := new.rfq_no;
    new := old;
    new.status := 'sent';
    new.rfq_no := kept;
    new.sent_at := now();
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'sent' and new.status = 'quoted' then
    if exists (
      select 1 from public.finance_rfq_lines
      where org_id = old.org_id and rfq_id = old.id and unit_price is null
    ) then
      raise exception 'every line needs a price before the RFQ is marked as quoted' using errcode = 'FIN19';
    end if;
    kept := new.supplier_ref;
    new := old;
    new.status := 'quoted';
    new.supplier_ref := kept;
    new.quoted_at := now();
    new.updated_at := now();
    return new;
  end if;

  if old.status in ('sent','quoted') and new.status = 'closed' then
    new := old;
    new.status := 'closed';
    new.updated_at := now();
    return new;
  end if;

  raise exception 'an RFQ that has been sent cannot be changed' using errcode = 'FIN01';
end $$;

create trigger finance_rfq_guard
  before insert or update or delete on public.finance_rfqs
  for each row execute function private.finance_rfq_guard();

-- Lines are free while the RFQ is a draft. Once it is sent, only the price
-- and SST rate change (the supplier's answer). After that, nothing.
create or replace function private.finance_rfq_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    select status into s from public.finance_rfqs where org_id = old.org_id and id = old.rfq_id for share;
    if s = 'sent' then
      if (to_jsonb(new) - 'unit_price' - 'sst_rate' - 'updated_at')
         is distinct from (to_jsonb(old) - 'unit_price' - 'sst_rate' - 'updated_at') then
        raise exception 'only prices change on an RFQ that has been sent' using errcode = 'FIN01';
      end if;
      return new;
    end if;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_rfqs where org_id = old.org_id and id = old.rfq_id for share;
    -- No parent row: the RFQ itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of an RFQ that has been sent cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_rfqs where org_id = new.org_id and id = new.rfq_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of an RFQ that has been sent cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_rfq_line_guard
  before insert or update or delete on public.finance_rfq_lines
  for each row execute function private.finance_rfq_line_guard();

-- Purchase orders.
--   draft             -> pending_approval   any writer; needs an amount and a number
--   draft             -> cancelled          the raiser, or an owner or admin
--   pending_approval  -> approved           an owner or admin; not the person who raised it or the person
--                                           who submitted it, unless they own the workspace
--   pending_approval  -> draft              with a reason: rejected, by an owner or admin
--                                           without: withdrawn, by the raiser, or an owner or admin
--   pending_approval  -> cancelled          the raiser, or an owner or admin
--   approved          -> closed             an owner or admin
--   approved          -> cancelled          an owner or admin, and no bill is raised against it
-- On every step past draft the guard copies the old row and sets only that
-- step's columns, so nothing else can ride along with a change of status.
create or replace function private.finance_purchase_order_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  may_sign boolean;
  is_raiser boolean;
  kept text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a purchase order starts as a draft' using errcode = 'FIN01';
    end if;
    if me is not null then
      new.created_by := me;
    end if;
    new.po_no := null;
    new.submitted_by := null;
    new.submitted_at := null;
    new.approved_by := null;
    new.approved_at := null;
    new.rejected_by := null;
    new.rejected_at := null;
    new.rejection_reason := null;
    new.closed_at := null;
    new.cancelled_at := null;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if (old.status <> 'draft' or old.po_no is not null)
       and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a purchase order with a number is cancelled, not deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if me is null or to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  if new.created_by is distinct from old.created_by or new.org_id <> old.org_id then
    raise exception 'who raised a purchase order does not change' using errcode = 'FIN01';
  end if;

  may_sign := private.finance_may_sign_off(old.org_id);
  is_raiser := coalesce(old.created_by = me, false);

  if old.status = 'draft' and new.status = 'draft' then
    new.po_no := old.po_no;
    new.submitted_by := old.submitted_by;
    new.submitted_at := old.submitted_at;
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
    new.rejected_by := old.rejected_by;
    new.rejected_at := old.rejected_at;
    new.rejection_reason := old.rejection_reason;
    new.closed_at := old.closed_at;
    new.cancelled_at := old.cancelled_at;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'pending_approval' then
    if new.po_no is null or (old.po_no is not null and new.po_no <> old.po_no) then
      raise exception 'a purchase order takes its number once, when it is first submitted' using errcode = 'FIN01';
    end if;
    if coalesce((
      select sum(amount + sst_amount) from public.finance_purchase_order_lines
      where org_id = old.org_id and purchase_order_id = old.id
    ), 0) <= 0 then
      raise exception 'a purchase order needs an amount before it is submitted' using errcode = 'FIN10';
    end if;
    kept := new.po_no;
    new := old;
    new.status := 'pending_approval';
    new.po_no := kept;
    new.submitted_by := me;
    new.submitted_at := now();
    new.rejected_by := null;
    new.rejected_at := null;
    new.rejection_reason := null;
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'pending_approval' and new.status = 'approved' then
    if not may_sign then
      raise exception 'approving a purchase order needs an owner or admin' using errcode = 'FIN14';
    end if;
    -- Whoever sent it for approval answers for what it says, even when
    -- someone else started the draft.
    if (is_raiser or coalesce(old.submitted_by = me, false)) and not private.is_org_owner(old.org_id) then
      raise exception 'a purchase order is approved by someone other than the person who raised or submitted it'
        using errcode = 'FIN18';
    end if;
    new := old;
    new.status := 'approved';
    new.approved_by := me;
    new.approved_at := now();
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'pending_approval' and new.status = 'draft' then
    kept := nullif(btrim(coalesce(new.rejection_reason, '')), '');
    if kept is not null then
      if not may_sign then
        raise exception 'rejecting a purchase order needs an owner or admin' using errcode = 'FIN14';
      end if;
      new := old;
      new.status := 'draft';
      new.rejected_by := me;
      new.rejected_at := now();
      new.rejection_reason := kept;
    else
      if not (is_raiser or may_sign) then
        raise exception 'a purchase order is withdrawn by the person who raised it, or an owner or admin'
          using errcode = 'FIN14';
      end if;
      new := old;
      new.status := 'draft';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if old.status in ('draft','pending_approval') and new.status = 'cancelled' then
    if not (is_raiser or may_sign) then
      raise exception 'a purchase order is cancelled by the person who raised it, or an owner or admin'
        using errcode = 'FIN14';
    end if;
    new := old;
    new.status := 'cancelled';
    new.cancelled_at := now();
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'approved' and new.status in ('closed','cancelled') then
    if not may_sign then
      raise exception 'closing or cancelling an approved purchase order needs an owner or admin'
        using errcode = 'FIN14';
    end if;
    if new.status = 'cancelled' and exists (
      select 1 from public.supplier_bills
      where org_id = old.org_id and purchase_order_id = old.id and status <> 'void'
    ) then
      raise exception 'the purchase order has bills' using errcode = 'FIN20';
    end if;
    kept := new.status;
    new := old;
    new.status := kept;
    if kept = 'closed' then
      new.closed_at := now();
    else
      new.cancelled_at := now();
    end if;
    new.updated_at := now();
    return new;
  end if;

  raise exception 'a purchase order that has been submitted cannot be changed' using errcode = 'FIN01';
end $$;

create trigger finance_purchase_order_guard
  before insert or update or delete on public.finance_purchase_orders
  for each row execute function private.finance_purchase_order_guard();

-- Lines are free while the order is a draft. On an approved order only what
-- has arrived changes. amount and sst_amount are generated and are not yet
-- worked out when a "before" trigger runs, so they are left out of the
-- comparison; they follow from quantity, unit_price and sst_rate, which are in it.
create or replace function private.finance_purchase_order_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.received_quantity := 0;
  end if;
  if tg_op = 'UPDATE' then
    select status into s from public.finance_purchase_orders
    where org_id = old.org_id and id = old.purchase_order_id for share;
    if s = 'approved' then
      if (to_jsonb(new) - 'received_quantity' - 'updated_at' - 'amount' - 'sst_amount')
         is distinct from (to_jsonb(old) - 'received_quantity' - 'updated_at' - 'amount' - 'sst_amount') then
        raise exception 'only what has arrived changes on an approved purchase order' using errcode = 'FIN01';
      end if;
      return new;
    end if;
    if s = 'draft' and new.received_quantity <> old.received_quantity then
      raise exception 'deliveries are recorded once the purchase order is approved' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_purchase_orders
    where org_id = old.org_id and id = old.purchase_order_id for share;
    -- No parent row: the order itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a submitted purchase order cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_purchase_orders
    where org_id = new.org_id and id = new.purchase_order_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a submitted purchase order cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_purchase_order_line_guard
  before insert or update or delete on public.finance_purchase_order_lines
  for each row execute function private.finance_purchase_order_line_guard();

revoke all on function private.finance_rfq_guard() from public, anon, authenticated;
revoke all on function private.finance_rfq_line_guard() from public, anon, authenticated;
revoke all on function private.finance_purchase_order_guard() from public, anon, authenticated;
revoke all on function private.finance_purchase_order_line_guard() from public, anon, authenticated;
