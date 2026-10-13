-- Bendahara: an RFQ copied to another supplier remembers the RFQ it came
-- from, so the quotes for the same request can be compared side by side.
--
--   1. finance_rfqs.source_rfq_id names the first RFQ of the group. A copy of
--      a copy names the first one too, so a group is one RFQ and every RFQ
--      that names it, with no chain to walk. It is tied to the workspace, and
--      deleting the first RFQ clears the link on its copies rather than
--      blocking or deleting them.
--   2. The guard sets it once, when the copy is first saved: it follows a
--      copy of a copy back to the first RFQ, and refuses an RFQ that is not
--      there to copy (FIN11), another workspace's included, since it cannot be
--      seen. A new RFQ cannot name itself, as it does not exist yet. After that
--      the link never changes (FIN01), so it cannot be pointed at the RFQ
--      itself either. The only change allowed is the one the foreign key makes
--      when the first RFQ is deleted.
--   3. finance_save_rfq writes it when it creates a draft. Saving a draft
--      again leaves it as it is.
--   4. finance_rfq_totals carries it, as its last column.

set local lock_timeout = '5s';

-- ---- 1. the link ----------------------------------------------------------------
alter table public.finance_rfqs
  add column source_rfq_id uuid,
  add constraint finance_rfqs_source_fkey
    foreign key (org_id, source_rfq_id) references public.finance_rfqs(org_id, id)
    on delete set null (source_rfq_id);
create index finance_rfqs_source_idx on public.finance_rfqs (org_id, source_rfq_id);

-- ---- 2. the guard -----------------------------------------------------------------
-- The body of 20261103091500 with two additions, marked "source": the
-- insert branch sets source_rfq_id, and the update branch refuses a change to
-- it. Still security invoker (the default) with search_path ''; the grants
-- are restated below as they were.
create or replace function private.finance_rfq_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  kept text;
  first_rfq uuid;
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
    -- source: a copy names the first RFQ of its group, even when it was made from another copy.
    if new.source_rfq_id is not null then
      select coalesce(r.source_rfq_id, r.id) into first_rfq
        from public.finance_rfqs r
       where r.org_id = new.org_id and r.id = new.source_rfq_id;
      if first_rfq is null then
        raise exception 'the RFQ this is copied from no longer exists' using errcode = 'FIN11';
      end if;
      new.source_rfq_id := first_rfq;
    end if;
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

  -- source: fixed once set. The foreign key clears it when the first RFQ is
  -- deleted, whatever this RFQ's status; that change, and only that, goes through.
  if new.source_rfq_id is distinct from old.source_rfq_id then
    if new.source_rfq_id is null and not exists (
      select 1 from public.finance_rfqs where org_id = old.org_id and id = old.source_rfq_id
    ) then
      new := old;
      new.source_rfq_id := null;
      return new;
    end if;
    raise exception 'which RFQ this was copied from does not change' using errcode = 'FIN01';
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

revoke all on function private.finance_rfq_guard() from public, anon, authenticated;

-- ---- 3. saving ---------------------------------------------------------------------
-- The body of 20261103093000. One change: the insert takes source_rfq_id from
-- the RFQ (the two lines marked "source"); the update does not touch it.
-- Still security invoker with search_path '', and the grants are unchanged:
-- create or replace keeps them, and they are restated below as they were.
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
    insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status, source_rfq_id) -- source
    values (
      target_org,
      (rfq->>'supplier_id')::uuid,
      (rfq->>'rfq_date')::date,
      nullif(rfq->>'reply_by', '')::date,
      nullif(rfq->>'notes', ''),
      'draft',
      nullif(rfq->>'source_rfq_id', '')::uuid -- source
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

revoke all on function public.finance_save_rfq(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.finance_save_rfq(uuid, jsonb, jsonb) to authenticated;

-- ---- 4. the totals view --------------------------------------------------------------
-- The view of 20261103091500 with source_rfq_id added last. Its `r.*` was
-- fixed to finance_rfqs' columns when the view was made, and would now take in
-- the new column mid-list, so those columns are named here in the same order.
create or replace view public.finance_rfq_totals with (security_invoker = true) as
select
  r.id, r.org_id, r.supplier_id, r.rfq_no, r.rfq_date, r.reply_by, r.supplier_ref, r.notes,
  r.status, r.sent_at, r.quoted_at, r.created_by, r.created_at, r.updated_at,
  c.name as supplier_name,
  coalesce(l.line_count, 0)::integer as line_count,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst_total,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  (coalesce(l.line_count, 0) > 0 and coalesce(l.unpriced, 0) = 0) as fully_priced,
  po.id as purchase_order_id,
  po.po_no as purchase_order_no,
  r.source_rfq_id
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
