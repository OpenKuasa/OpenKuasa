-- Bendahara RFQ comparison, split between suppliers (#236), the database half.
-- Additive, and safe to apply while the previous code is still deployed, but for the Deploy window below.
--
-- A request's quotes can be awarded whole (Make purchase order from one
-- supplier's column) or line by line (each line to the supplier that quoted it
-- lowest, one draft order per chosen supplier). Either way, an order that does
-- not go to the lowest quote needs a reason, and the database holds that rule,
-- so Tuah and any other caller meet it too.
--
--   * finance_purchase_orders.award_reason: why this supplier was chosen. Null
--     or not blank. It may be edited while the order is a draft and, once set,
--     not emptied; once the order leaves draft it is locked. It is the order's
--     own field: rejection_reason belongs to the approver and is cleared on
--     submit. It is last on finance_purchase_order_totals.
--   * private.finance_rfq_comparison: the screen's comparison (rfq-compare.ts),
--     in SQL, so the database and Compare quotes agree on what is lowest:
--       - the group is the first RFQ and its copies (coalesce(source_rfq_id, id)),
--         and only an RFQ whose answer was recorded (quoted_at) has prices;
--       - a row is the product, else the description trimmed, whitespace
--         collapsed and lowercased, in the same unit and pack size, and the
--         n-th time an RFQ asks for it (lines in position, then id, order);
--       - a whole RFQ's quotes compare only for the same rows at the same quantities;
--       - a line costs unit price x (100 + SST rate); when the quotes are in
--         more than one currency also x the RFQ's rate (ringgit is 1), and a
--         foreign RFQ with no rate has no cost (it cannot be compared).
--   * The rule for a line: a reason is needed when another RFQ's comparable
--     price for the same row is strictly lower (a tie needs none; a line nobody
--     else quoted needs none), or, in a group quoted in several currencies,
--     when the line has no cost and another RFQ quoted the same row. The rule
--     for a whole RFQ (Make purchase order): another quoted RFQ is strictly
--     lower, to the sen, on the rows both ask for at the same quantities: in
--     total when it asks for exactly the same rows (ringgit when the quotes
--     are in several currencies), else summed over the rows they share; or, in
--     a group quoted in several currencies, this RFQ has no ringgit total and
--     another RFQ quoted one of its rows. So a quote that asks for one more
--     row cannot hide a lower price on the rows both quoted.
--   * private.finance_make_rfq_order: what Make purchase order always did,
--     taking the lines to copy (all when null) and the reason. Both callers use it.
--   * public.finance_award_rfq_lines(org, awards): the split. awards is
--     [{rfq_id, line_ids: [...], reason}]; one draft order per award, from that
--     RFQ and holding only those lines at the quoted quantity and price, all in
--     one call: a refusal anywhere leaves no order behind.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   public.finance_convert_rfq            20261121120000_bendahara_purchase_order_currency.sql lines 553-613: the body moves
--                                         to private.finance_make_rfq_order; a third argument, reason, is added
--                                         (default null, so a call with the two named arguments still works), and the old
--                                         two-argument function is dropped so there is no overload
--   public.finance_purchase_order_totals  20261123110000_bendahara_supplier_credit_notes.sql lines 591-651:
--                                         award_reason appended as the last column
-- NEW: the column and its check; trigger finance_purchase_order_reason_lock;
-- private.finance_rfq_words, finance_rfq_comparison, finance_rfq_total_needs_reason,
-- finance_rfq_awards, finance_make_rfq_order; public.finance_award_rfq_lines.
-- finance_save_purchase_order is not restated: the reason is a plain table
-- update on a draft.
--
-- Error codes: FIN75 (a reason is needed) and FIN76 (the award is not valid:
-- nothing to order, an RFQ named twice, RFQs of different requests, a line that
-- is not on its RFQ, one line given to two suppliers) are new. FIN11 (the RFQ
-- is not there), FIN01 (it is not quoted) and FIN22 (it already has an order)
-- mean here what they mean for Make purchase order.
--
-- Deploy window: from this file until the matching app is deployed, the old app
-- has no place to type a reason, so a Make purchase order that needs one is
-- refused (FIN75) and the old app shows its general message. The old call with
-- two arguments otherwise works as it did.
--
-- Known limits:
--   * A direct insert into finance_purchase_orders can still attach an order to
--     an RFQ with no reason: the rule is held by the two functions, as the
--     sign-off checks of 20261103094500 are. The table's grants are unchanged.
--   * The matching exists twice, in src/lib/finance/rfq-compare.ts and here;
--     tests/bendahara-rfq-split.test.ts holds them together.
--   * Lower case follows the database's locale for characters beyond ASCII; the
--     screen follows the browser's.
--   * One row given to two suppliers is refused within one call. Calls made one
--     after another are not compared: orders do not record which RFQ line they came from.
--
-- Nothing here is granted to service_role.

set local lock_timeout = '5s';

-- ============================================================================
-- 1. The reason on the order
-- ============================================================================
alter table public.finance_purchase_orders
  add column award_reason text,
  add constraint finance_purchase_orders_award_reason_check check (award_reason is null or btrim(award_reason) <> '');

-- Draft: edited freely, never emptied once set (FIN75). Any other status: locked (FIN01). The name sorts after
-- finance_purchase_order_guard, which on every step out of a draft has already put the old row back, so a
-- reason cannot ride along with a submit or a rejection; this also holds where the guard stands aside (no signed-in person).
create function private.finance_purchase_order_reason_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.award_reason is not distinct from old.award_reason then
    return new;
  end if;
  if old.status <> 'draft' then
    raise exception 'the reason for choosing the supplier cannot be changed once the order is submitted' using errcode = 'FIN01';
  end if;
  if new.award_reason is null then
    raise exception 'the reason for choosing the supplier cannot be taken away; change it instead' using errcode = 'FIN75';
  end if;
  return new;
end $$;
revoke all on function private.finance_purchase_order_reason_lock() from public, anon, authenticated, service_role;

create trigger finance_purchase_order_reason_lock
  before update of award_reason on public.finance_purchase_orders
  for each row execute function private.finance_purchase_order_reason_lock();

-- finance_purchase_order_totals (create or replace): 20261123110000's body, with award_reason appended as the
-- last column, so the view and its grants stay as they are.
create or replace view public.finance_purchase_order_totals with (security_invoker = true) as
select
  p.id, p.org_id, p.supplier_id, p.rfq_id, p.po_no, p.po_date, p.expected_date, p.notes, p.status, p.created_by,
  p.submitted_by, p.submitted_at, p.approved_by, p.approved_at, p.rejected_by, p.rejected_at, p.rejection_reason,
  p.closed_at, p.cancelled_at, p.created_at, p.updated_at, p.payment_terms_days, p.delivery_address,
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
  -- 20261123110000: issued supplier credit notes on the order's bills come off the billed figure.
  (coalesce(b.billed, 0) - coalesce(cn.credited, 0))::numeric(14,2) as billed_total,
  (coalesce(b.billed, 0) - coalesce(cn.credited, 0) > coalesce(l.subtotal, 0) + coalesce(l.sst, 0)) as over_billed,
  -- Billed for more than has arrived: the usual thing to catch before paying.
  (coalesce(b.billed, 0) - coalesce(cn.credited, 0) > coalesce(l.received, 0)) as billed_over_received,
  -- 20261121120000: the currency, and the total in ringgit at the order's rate.
  p.currency,
  p.fx_rate,
  p.fx_rate_source,
  p.fx_rate_date,
  (case when p.fx_rate is null then null else coalesce(l.total_myr, 0) end)::numeric(14,2) as total_myr,
  -- 20261202090000: why this supplier was chosen.
  p.award_reason
from public.finance_purchase_orders p
join public.finance_contacts c on c.org_id = p.org_id and c.id = p.supplier_id
left join public.finance_rfqs r on r.org_id = p.org_id and r.id = p.rfq_id
left join lateral (
  select
    sum(amount) as subtotal,
    sum(sst_amount) as sst,
    count(*) filter (where received_quantity > 0) as started,
    count(*) filter (where received_quantity < quantity) as outstanding,
    sum(round(received_quantity * unit_price, 2) + round(received_quantity * unit_price * sst_rate / 100, 2)) as received,
    -- 20261121120000: each line and its SST in ringgit, rounded to the sen, then added.
    sum(round(amount * p.fx_rate, 2) + round(sst_amount * p.fx_rate, 2)) as total_myr
  from public.finance_purchase_order_lines
  where org_id = p.org_id and purchase_order_id = p.id
) l on true
left join lateral (
  -- Every bill raised against the order that has not been voided, drafts included.
  select sum(bl.amount + bl.sst_amount) as billed
  from public.supplier_bills sb
  join public.supplier_bill_lines bl on bl.org_id = sb.org_id and bl.bill_id = sb.id
  where sb.org_id = p.org_id and sb.purchase_order_id = p.id and sb.status <> 'void'
) b on true
left join lateral (
  -- What the supplier has credited on those bills: issued notes only.
  select sum(n.amount) as credited
  from public.supplier_bills sb
  join public.finance_supplier_credit_notes n on n.org_id = sb.org_id and n.bill_id = sb.id
  where sb.org_id = p.org_id and sb.purchase_order_id = p.id and sb.status <> 'void' and n.status = 'issued'
) cn on true;

-- "create or replace" keeps the grants; said again, service_role named too.
revoke all on public.finance_purchase_order_totals from anon, authenticated, service_role;
grant select on public.finance_purchase_order_totals to authenticated;

-- ============================================================================
-- 2. The comparison, in SQL (rfq-compare.ts)
-- ============================================================================
-- rfq-compare.ts's `words`: trimmed, whitespace collapsed, lower case. The class names what JavaScript's \s has and
-- Postgres's may not (a U+FEFF pasted into a description is still the same item).
create function private.finance_rfq_words(t text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select lower(btrim(regexp_replace(coalesce(t, ''), '[\s\u00A0\uFEFF\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+', ' ', 'g')));
$$;
revoke all on function private.finance_rfq_words(text) from public, anon, service_role;
grant execute on function private.finance_rfq_words(text) to authenticated;

-- Every line of every quoted RFQ in one request group: its RFQ, its id, its row, what one unit costs once SST is
-- paid (in ringgit when the quotes are in more than one currency; null when its RFQ has no rate then), and whether
-- the quotes are in more than one currency (the same on every row). Nothing is returned for an RFQ not yet quoted:
-- a price typed on it is the buyer's, not the supplier's.
create function private.finance_rfq_comparison(target_org uuid, target_group uuid)
returns table (rfq_id uuid, line_id uuid, row_key text, quantity numeric, cost numeric, mixed boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  with g as (
    select r.id, r.currency, case when r.currency = 'MYR' then 1::numeric else r.fx_rate end as rate
    from public.finance_rfqs r
    where r.org_id = target_org and coalesce(r.source_rfq_id, r.id) = target_group and r.quoted_at is not null
  ),
  m as (select count(distinct g.currency) > 1 as mixed from g)
  select x.rfq_id, x.id,
         x.base || '#' || (row_number() over (partition by x.rfq_id, x.base order by x.position, x.id) - 1),
         x.quantity,
         case when m.mixed then x.unit_price * (100 + x.sst_rate) * x.rate else x.unit_price * (100 + x.sst_rate) end,
         m.mixed
  from (
    select g.id as rfq_id, l.id, l.position, l.quantity, l.unit_price, l.sst_rate, g.rate,
           coalesce(l.product_id::text, private.finance_rfq_words(l.description))
             || '|' || private.finance_rfq_words(l.uom) || '|' || private.finance_rfq_words(l.pack_size) as base
    from g
    join public.finance_rfq_lines l on l.org_id = target_org and l.rfq_id = g.id
  ) x
  cross join m;
$$;
revoke all on function private.finance_rfq_comparison(uuid, uuid) from public, anon, service_role;
grant execute on function private.finance_rfq_comparison(uuid, uuid) to authenticated;

-- Make purchase order from this RFQ: does it need a reason? Another quoted RFQ of the group is strictly lower on the
-- rows both ask for at the same quantities: in total when it asks for exactly the same rows, else summed over the
-- rows they share (each line's cost x quantity, rounded to the sen; a line with no cost is left out on both sides).
-- Or the quotes are in several currencies, this one has no ringgit total, and another RFQ quoted one of its rows.
-- A quote that shares no row at the same quantity is not compared.
create function private.finance_rfq_total_needs_reason(target_org uuid, target_rfq uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  with c as materialized (
    select * from private.finance_rfq_comparison(
      target_org,
      (select coalesce(r.source_rfq_id, r.id) from public.finance_rfqs r where r.org_id = target_org and r.id = target_rfq)
    )
  ),
  sets as (
    select c.rfq_id, array_agg(c.row_key || '@' || c.quantity::text order by c.row_key) as keys, bool_or(c.mixed) as mixed
    from c
    group by c.rfq_id
  ),
  figs as (
    select s.rfq_id, s.keys, s.mixed,
           -- quoteTotals: ringgit for a ringgit RFQ, else its ringgit total, null with no rate.
           case when not s.mixed then t.total
                when t.currency = 'MYR' then coalesce(t.total_myr, t.total)
                else t.total_myr end as fig
    from sets s
    join public.finance_rfq_totals t on t.org_id = target_org and t.id = s.rfq_id
  ),
  -- Each other RFQ against this one, over the rows both ask for at the same quantities and both priced.
  shared as (
    select o.rfq_id,
           round(sum(o.quantity * o.cost) / 100, 2) as theirs,
           round(sum(f.quantity * f.cost) / 100, 2) as ours
    from c f
    join c o on o.row_key = f.row_key and o.quantity = f.quantity and o.rfq_id <> f.rfq_id
    where f.rfq_id = target_rfq and f.cost is not null and o.cost is not null
    group by o.rfq_id
  )
  select coalesce((
    select (f.mixed and f.fig is null
            and exists (select 1 from c x join c y on y.row_key = x.row_key and y.rfq_id <> x.rfq_id where x.rfq_id = f.rfq_id))
           or exists (select 1 from figs o where o.rfq_id <> f.rfq_id and o.keys = f.keys and o.fig < f.fig)
           or exists (select 1 from figs o join shared sh on sh.rfq_id = o.rfq_id
                      where o.rfq_id <> f.rfq_id and o.keys <> f.keys and sh.theirs < sh.ours)
    from figs f
    where f.rfq_id = target_rfq
  ), false);
$$;
revoke all on function private.finance_rfq_total_needs_reason(uuid, uuid) from public, anon, service_role;
grant execute on function private.finance_rfq_total_needs_reason(uuid, uuid) to authenticated;

-- ============================================================================
-- 3. Making an order from an RFQ (shared)
-- ============================================================================
-- What finance_convert_rfq did (20261121120000 lines 553 to 613), unchanged, with two additions: only_lines names
-- the lines to copy (null: all of them), and the reason is stored. The reason rule is not here: the callers apply it.
create function private.finance_make_rfq_order(target_org uuid, target_rfq uuid, only_lines uuid[], why text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  pid uuid;
  -- Scalars, null until set: a record that is never assigned cannot be read (55000) on the ringgit path.
  r_rate numeric;
  r_rate_date date;
begin
  select status, supplier_id, notes, currency into r from public.finance_rfqs
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

  -- The order keeps the RFQ's currency; its rate is the one rule's for the order's own date (the RFQ's was
  -- indicative), marked 'bnm'; none when the rule has none (the form asks; FIN38 at submit).
  if r.currency <> 'MYR' then
    select s.rate, s.rate_date into r_rate, r_rate_date from private.finance_sst_fx_rate(r.currency, current_date) s;
  end if;

  insert into public.finance_purchase_orders
    (org_id, supplier_id, rfq_id, po_date, notes, status, payment_terms_days,
     currency, fx_rate, fx_rate_source, fx_rate_date, award_reason)
  values (
    target_org, r.supplier_id, target_rfq, current_date, r.notes, 'draft',
    (select c.payment_terms_days from public.finance_contacts c
      where c.org_id = target_org and c.id = r.supplier_id),
    r.currency,
    case when r.currency = 'MYR' then 1 else r_rate end,
    case when r.currency <> 'MYR' and r_rate is not null then 'bnm' end,
    case when r.currency <> 'MYR' then r_rate_date end,
    nullif(btrim(why), '')
  )
  returning id into pid;

  insert into public.finance_purchase_order_lines
    (org_id, purchase_order_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, pid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_rfq_lines l
  where l.org_id = target_org and l.rfq_id = target_rfq and (only_lines is null or l.id = any (only_lines))
  order by l.position, l.id;

  return pid;
end $$;
revoke all on function private.finance_make_rfq_order(uuid, uuid, uuid[], text) from public, anon, service_role;
grant execute on function private.finance_make_rfq_order(uuid, uuid, uuid[], text) to authenticated;

-- ============================================================================
-- 4. Make purchase order (REPLACED): the whole RFQ, with a reason when it is not the lowest
-- ============================================================================
drop function public.finance_convert_rfq(uuid, uuid);

-- The order is made first, so that the RFQ not being there, not quoted or already ordered (FIN11, FIN01, FIN22)
-- answer as they always did; a refusal for the reason (FIN75) then undoes it.
create function public.finance_convert_rfq(target_org uuid, target_rfq uuid, reason text default null)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  why text := nullif(btrim(reason), '');
  pid uuid;
begin
  pid := private.finance_make_rfq_order(target_org, target_rfq, null, why);
  if why is null and private.finance_rfq_total_needs_reason(target_org, target_rfq) then
    raise exception 'another supplier quoted this request for less, or this quote has no exchange rate to compare: say why this supplier was chosen'
      using errcode = 'FIN75';
  end if;
  return pid;
end $$;

revoke all on function public.finance_convert_rfq(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.finance_convert_rfq(uuid, uuid, text) to authenticated;

-- ============================================================================
-- 5. The split: some lines of each RFQ, one order per supplier, all or none
-- ============================================================================
-- awards: [{"rfq_id": ..., "line_ids": [...], "reason": "..."}], one per RFQ. Returns the new orders' ids, in the
-- order given.
create function private.finance_rfq_awards(awards jsonb)
returns table (n integer, rfq_id uuid, line_ids uuid[], reason text)
language sql
immutable
security invoker
set search_path = ''
as $$
  select t.n::integer,
         (t.e ->> 'rfq_id')::uuid,
         array(select jsonb_array_elements_text(t.e -> 'line_ids')::uuid),
         nullif(btrim(t.e ->> 'reason'), '')
  from jsonb_array_elements(awards) with ordinality as t(e, n);
$$;
revoke all on function private.finance_rfq_awards(jsonb) from public, anon, service_role;
grant execute on function private.finance_rfq_awards(jsonb) to authenticated;

create function public.finance_award_rfq_lines(target_org uuid, awards jsonb)
returns uuid[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a record;
  locked integer;
  groups uuid[];
  ids uuid[] := '{}';
begin
  if jsonb_typeof(awards) is distinct from 'array' or jsonb_array_length(awards) = 0 then
    raise exception 'there is nothing to order' using errcode = 'FIN76';
  end if;
  if exists (select 1 from private.finance_rfq_awards(awards) p where p.rfq_id is null or cardinality(p.line_ids) = 0) then
    raise exception 'each order needs an RFQ and at least one of its lines' using errcode = 'FIN76';
  end if;
  if exists (select 1 from private.finance_rfq_awards(awards) p group by p.rfq_id having count(*) > 1) then
    raise exception 'an RFQ can be named only once' using errcode = 'FIN76';
  end if;

  -- The RFQs are locked in id order, whatever order they were given in, so two splits of one request cannot deadlock.
  select count(*), array_agg(distinct s.grp) into locked, groups from (
    select coalesce(r.source_rfq_id, r.id) as grp
    from public.finance_rfqs r
    where r.org_id = target_org and r.id in (select p.rfq_id from private.finance_rfq_awards(awards) p)
    order by r.id
    for update
  ) s;
  if locked <> jsonb_array_length(awards) then
    raise exception 'an RFQ no longer exists' using errcode = 'FIN11';
  end if;
  if cardinality(groups) <> 1 then
    raise exception 'the RFQs are not quotes for the same request' using errcode = 'FIN76';
  end if;
  if exists (
    select 1
    from private.finance_rfq_awards(awards) p
    cross join lateral unnest(p.line_ids) as l(id)
    where not exists (
      select 1 from public.finance_rfq_lines x where x.org_id = target_org and x.rfq_id = p.rfq_id and x.id = l.id
    )
  ) then
    raise exception 'a line is not on the RFQ it was given for' using errcode = 'FIN76';
  end if;

  -- The orders come first, so that an RFQ that is not quoted or already ordered (FIN01, FIN22) answers as it does for
  -- Make purchase order. The two refusals below then undo every order: a split is all or none.
  for a in select p.rfq_id, p.line_ids, p.reason from private.finance_rfq_awards(awards) p order by p.n loop
    ids := ids || private.finance_make_rfq_order(target_org, a.rfq_id, a.line_ids, a.reason);
  end loop;

  -- A whole line goes to one supplier.
  if exists (
    select 1
    from private.finance_rfq_awards(awards) p
    cross join lateral unnest(p.line_ids) as l(id)
    join private.finance_rfq_comparison(target_org, groups[1]) c on c.line_id = l.id
    group by c.row_key
    having count(distinct p.rfq_id) > 1
  ) then
    raise exception 'a line can go to only one supplier' using errcode = 'FIN76';
  end if;

  -- An order needs its reason when a line of it is not comparable (the quotes are in several currencies, its RFQ has
  -- no rate, and another RFQ quoted the same row), or another supplier's price for the same row is strictly lower.
  if exists (
    with cmp as materialized (select * from private.finance_rfq_comparison(target_org, groups[1]))
    select 1
    from private.finance_rfq_awards(awards) p
    where p.reason is null
      and exists (
        select 1 from cmp c
        where c.rfq_id = p.rfq_id and c.line_id = any (p.line_ids)
          and ((c.mixed and c.cost is null
                and exists (select 1 from cmp o where o.row_key = c.row_key and o.rfq_id <> c.rfq_id))
               or exists (select 1 from cmp o where o.row_key = c.row_key and o.rfq_id <> c.rfq_id and o.cost < c.cost))
      )
  ) then
    raise exception 'a line goes to a supplier that did not quote the lowest price, or has no exchange rate to compare: say why it was chosen'
      using errcode = 'FIN75';
  end if;

  return ids;
end $$;

revoke all on function public.finance_award_rfq_lines(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_award_rfq_lines(uuid, jsonb) to authenticated;

-- ---- self-check ------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.finance_purchase_orders'::regclass and tgname = 'finance_purchase_order_reason_lock' and not tgisinternal
  ) then
    raise exception 'finance_purchase_order_reason_lock trigger is missing';
  end if;
  if (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'public' and p.proname = 'finance_convert_rfq') <> 1 then
    raise exception 'finance_convert_rfq has more than one signature';
  end if;

  -- Who may call what, and as whom they run.
  foreach t in array array[
    'public.finance_convert_rfq(uuid, uuid, text)', 'public.finance_award_rfq_lines(uuid, jsonb)',
    'private.finance_rfq_words(text)', 'private.finance_rfq_comparison(uuid, uuid)',
    'private.finance_rfq_total_needs_reason(uuid, uuid)', 'private.finance_rfq_awards(jsonb)',
    'private.finance_make_rfq_order(uuid, uuid, uuid[], text)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('service_role', t, 'execute')
       or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = t::regprocedure
                    and not p.prosecdef and 'search_path=""' = any(p.proconfig)) then
      raise exception '% is not security invoker with an empty search_path', t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'private.finance_purchase_order_reason_lock()', 'execute')
     or has_function_privilege('anon', 'private.finance_purchase_order_reason_lock()', 'execute') then
    raise exception 'finance_purchase_order_reason_lock can be called directly';
  end if;

  -- The view gained one column, at the end, and still reads as its caller.
  select a.attname into t from pg_catalog.pg_attribute a
   where a.attrelid = 'public.finance_purchase_order_totals'::regclass and a.attnum > 0 and not a.attisdropped
   order by a.attnum desc limit 1;
  if t is distinct from 'award_reason' then
    raise exception 'finance_purchase_order_totals ends with %', t;
  end if;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.finance_purchase_order_totals'::regclass
                  and reloptions @> array['security_invoker=true']) then
    raise exception 'finance_purchase_order_totals no longer reads as its caller';
  end if;
  if has_table_privilege('anon', 'public.finance_purchase_order_totals', 'select')
     or not has_table_privilege('authenticated', 'public.finance_purchase_order_totals', 'select') then
    raise exception 'finance_purchase_order_totals is not readable by exactly the signed-in';
  end if;
end $$;
