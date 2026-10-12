-- Bendahara ledger, part 2 of 4: a category on every supplier bill (additive;
-- safe to apply while the previous code is still deployed).
--
-- A bill's cost has to land in an account. supplier_bills gains category_id,
-- an expense category, and the ledger debits that category's account. A bill
-- saved without one gets the workspace's "Purchases" category: the one whose
-- ledger account 20261108090000 marked default_for = 'purchases'.
--
-- The code deployed while this is applied saves bills through
-- finance_save_bill without a category_id, and gets Purchases on a new bill
-- and no change on an existing one. Nothing it reads changes:
-- supplier_bill_totals was created with "b.*", which froze its columns when
-- it was made, so it does not carry the new column and still answers as it
-- did.
--
-- Where the default lives: in a trigger on the table, not in the function.
-- Every way a bill comes to exist is an INSERT into supplier_bills
-- (finance_save_bill, which the app also uses for a bill made from a purchase
-- order, and an insert by hand), so every one of them gets it.
--
-- A posted bill's category cannot change. That is the rule already in
-- private.finance_bill_guard (20261013100000_bendahara_money.sql, lines 245
-- to 261), which this file does not touch: posted to void is allowed only
-- when to_jsonb(new) and to_jsonb(old) agree on everything but status and
-- updated_at, which takes in the new column; and every other update of a
-- posted or void bill is refused (FIN01) whatever it changes.
--
-- New error code: FIN26, "a bill's category must be an expense category".

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- A workspace made between the last migration and this one was seeded by the
-- new-workspace seed. This is for anything that still has no Purchases
-- account, so the update below leaves no bill without a category.
select private.finance_ledger_seed(o.id)
from public.orgs o
where not exists (
  select 1 from public.finance_ledger_accounts la where la.org_id = o.id and la.default_for = 'purchases'
);

alter table public.supplier_bills add column category_id uuid;

-- Existing bills, posted and void included, take Purchases. The guard on
-- bills refuses every update of a posted or void bill, with nobody signed in
-- as much as with somebody, so it is switched off for this one statement.
-- The table is locked against every other session from the ALTER above until
-- this transaction ends, so no other write can pass while it is off.
alter table public.supplier_bills disable trigger finance_bill_guard;
update public.supplier_bills b
   set category_id = la.category_id
  from public.finance_ledger_accounts la
 where la.org_id = b.org_id and la.default_for = 'purchases';
alter table public.supplier_bills enable trigger finance_bill_guard;

-- Stops here if any bill is still without one.
alter table public.supplier_bills
  alter column category_id set not null,
  add constraint supplier_bills_category_fkey
    foreign key (org_id, category_id) references public.finance_categories(org_id, id);
create index supplier_bills_category_idx on public.supplier_bills (org_id, category_id);

-- ---- the default, and the kind ------------------------------------------------------
-- A new trigger; private.finance_bill_guard is not replaced. Its name sorts
-- before finance_bill_guard, so the category is filled in before the guard
-- compares anything.
--   * No category given (on a new bill, or set to nothing on an existing
--     one): the workspace's Purchases category.
--   * A category given, new or changed: it must be an expense category of
--     the workspace (FIN26). One that cannot be found is left for the foreign
--     key, or row-level security, to refuse and say which.
-- Runs as the caller: anyone who may write a bill may read the workspace's
-- categories and ledger accounts.
create or replace function private.finance_bill_category()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k text;
begin
  if new.category_id is null then
    select la.category_id into new.category_id
    from public.finance_ledger_accounts la
    where la.org_id = new.org_id and la.default_for = 'purchases';
    return new;
  end if;
  if tg_op = 'UPDATE' and new.category_id = old.category_id and new.org_id = old.org_id then
    return new;
  end if;
  select kind into k from public.finance_categories
  where org_id = new.org_id and id = new.category_id;
  if found and k <> 'expense' then
    raise exception 'a bill''s category must be an expense category' using errcode = 'FIN26';
  end if;
  return new;
end $$;
revoke all on function private.finance_bill_category() from public, anon, authenticated, service_role;

create trigger finance_bill_category
  before insert or update on public.supplier_bills
  for each row execute function private.finance_bill_category();

-- ---- saving a bill ------------------------------------------------------------------
-- The body of 20261103100000_bendahara_bill_purchase_order_link.sql (security
-- invoker, search_path ''), with category_id:
--   * on a new bill it is bill->>'category_id', and when that is absent or
--     empty the trigger above gives Purchases;
--   * on an existing draft it changes only when the caller sends a category,
--     so a form that does not know about categories leaves it alone.
-- Nothing else is changed. "create or replace" keeps its grants.
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
      (org_id, supplier_id, supplier_ref, bill_date, due_date, notes, status, purchase_order_id, category_id)
    values (
      target_org,
      (bill->>'supplier_id')::uuid,
      nullif(bill->>'supplier_ref', ''),
      (bill->>'bill_date')::date,
      (bill->>'due_date')::date,
      nullif(bill->>'notes', ''),
      'draft',
      nullif(bill->>'purchase_order_id', '')::uuid,
      nullif(bill->>'category_id', '')::uuid
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
           category_id = coalesce(nullif(bill->>'category_id', '')::uuid, category_id),
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

-- The backfill above switched finance_bill_guard off for one statement. If it
-- were somehow still off, this stops the migration and everything rolls back.
do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.supplier_bills'::regclass
      and tgname = 'finance_bill_guard' and tgenabled <> 'O'
  ) then
    raise exception 'finance_bill_guard was left disabled';
  end if;
end $$;
