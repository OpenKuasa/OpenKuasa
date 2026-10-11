-- Bendahara sales core, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * finance_invoices + finance_invoice_lines: sales invoices.
--   * finance_allocations can now point at an invoice instead of a bill.
--   * Views: finance_invoice_totals (balance and display status) and
--     finance_payments_in (one row per invoice a payment in pays).
--   * Guards: a posted invoice is locked and can only be voided; a bill takes
--     only money out, an invoice only money in; a payment that is split
--     cannot be made smaller than its split or change direction.
--   * Functions that save, post and receive payment in one transaction.
--
-- The code deployed while this is applied only ever inserts allocations with
-- bill_id set, so swapping "bill_id is not null" for "exactly one of bill_id
-- and invoice_id" refuses nothing that code does.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- invoices ---------------------------------------------------------------
-- status is what a person sets; Sent, Paid and Overdue are derived from
-- payments and due_date in finance_invoice_totals.
create table public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  customer_id uuid not null,
  -- INV-0001; given when the invoice is posted.
  invoice_no text,
  invoice_date date not null default current_date,
  due_date date not null,
  notes text,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  posted_at timestamptz,
  -- What a person has recorded about the e-Invois at LHDN. Nothing is submitted from here.
  einvoice_status text not null default 'none' check (einvoice_status in ('none','pending','validated','rejected')),
  einvoice_uuid text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, invoice_no),
  constraint finance_invoices_dates_check check (due_date >= invoice_date),
  -- A draft has no number; a posted or void invoice has one, and a posted
  -- invoice says when it was posted.
  constraint finance_invoices_number_check
    check ((status = 'draft') = (invoice_no is null) and (status <> 'posted' or posted_at is not null)),
  -- A draft has not gone anywhere, so it has no e-Invois yet.
  constraint finance_invoices_draft_einvoice_check
    check (status <> 'draft' or (einvoice_status = 'none' and einvoice_uuid is null)),
  foreign key (org_id, customer_id) references public.finance_contacts(org_id, id)
);
create index finance_invoices_customer_idx on public.finance_invoices (org_id, customer_id);
create index finance_invoices_date_idx on public.finance_invoices (org_id, invoice_date);

-- Same shape as supplier_bill_lines, plus position: the lines of one save all
-- share created_at, so the order they were entered in has to be stored.
create table public.finance_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null,
  position integer not null default 0,
  product_id uuid,
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  uom text,
  pack_size text,
  unit_price numeric(14,4) not null check (unit_price >= 0),
  sst_rate numeric(5,2) not null default 0 check (sst_rate between 0 and 100),
  amount numeric(14,2) generated always as (round(quantity * unit_price, 2)) stored,
  sst_amount numeric(14,2) generated always as (round(quantity * unit_price * sst_rate / 100, 2)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.finance_products(org_id, id)
);
create index finance_invoice_lines_invoice_idx on public.finance_invoice_lines (org_id, invoice_id);
create index finance_invoice_lines_product_idx on public.finance_invoice_lines (org_id, product_id);

do $$
declare t text;
begin
  foreach t in array array['finance_invoices','finance_invoice_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_org_writer(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_org_writer(org_id))', t || '_delete', t);
    execute format(
      'create policy mfa_required on public.%I as restrictive for all to authenticated '
      || 'using ((select private.mfa_ok())) with check ((select private.mfa_ok()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---- allocations: a bill or an invoice --------------------------------------
alter table public.finance_allocations add column invoice_id uuid;

-- The old rule was an unnamed check, so it is found by what it says. If it is
-- not found the migration stops: with it left in place no invoice could ever
-- be paid.
do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.finance_allocations'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%bill_id is not null%'
  loop
    execute format('alter table public.finance_allocations drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped <> 1 then
    raise exception 'expected one "bill_id is not null" check on finance_allocations, found %', dropped;
  end if;
end $$;

alter table public.finance_allocations
  add constraint finance_allocations_one_document_check check (num_nonnulls(bill_id, invoice_id) = 1),
  add constraint finance_allocations_transaction_invoice_key unique (transaction_id, invoice_id),
  add constraint finance_allocations_invoice_fkey
    foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id);
create index finance_allocations_invoice_idx on public.finance_allocations (org_id, invoice_id);

-- ---- views ------------------------------------------------------------------
-- Columns are listed one by one, so a later stage can add to the end with
-- "create or replace view". The balance is worked out in one place (v):
-- stage 4 changes that line to take off issued credit notes and add back
-- refunds, and nothing else here.
-- Overdue uses the database's current_date (UTC), as supplier_bill_totals does.
create view public.finance_invoice_totals with (security_invoker = true) as
select
  i.id,
  i.org_id,
  i.customer_id,
  c.name as customer_name,
  i.invoice_no,
  i.invoice_date,
  i.due_date,
  i.notes,
  i.status,
  i.posted_at,
  i.einvoice_status,
  i.einvoice_uuid,
  i.created_by,
  i.created_at,
  i.updated_at,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst,
  v.total::numeric(14,2) as total,
  v.paid::numeric(14,2) as paid,
  v.balance::numeric(14,2) as balance,
  case
    when i.status in ('draft','void') then i.status
    when v.total > 0 and v.balance <= 0 then 'paid'
    when i.due_date < current_date then 'overdue'
    else 'sent'
  end as display_status
from public.finance_invoices i
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst
  from public.finance_invoice_lines
  where org_id = i.org_id and invoice_id = i.id
) l on true
left join lateral (
  -- Only posted money in counts as paid.
  select sum(a.amount) as paid
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'in' and t.status = 'posted'
) p on true
cross join lateral (
  select
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) as total,
    coalesce(p.paid, 0) as paid,
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) - coalesce(p.paid, 0) as balance
) v;
revoke all on public.finance_invoice_totals from anon, authenticated;
grant select on public.finance_invoice_totals to authenticated;

-- One row per invoice a payment in pays. Same columns as finance_payments_out,
-- with the invoice and the customer where that view has the bill and the supplier.
create view public.finance_payments_in with (security_invoker = true) as
select
  a.id as allocation_id,
  t.id as transaction_id,
  t.org_id,
  t.number,
  t.txn_date,
  t.method,
  a.amount,
  t.amount as transaction_amount,
  t.status,
  t.reference,
  t.account_id,
  acc.name as account_name,
  i.id as invoice_id,
  i.invoice_no,
  c.name as customer_name,
  t.created_at
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'in';
revoke all on public.finance_payments_in from anon, authenticated;
grant select on public.finance_payments_in to authenticated;

-- ---- guards -----------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted: by the time a
-- cascade reaches these rows the orgs row is already gone.

create or replace function private.finance_invoice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'an invoice starts as a draft' using errcode = 'FIN01';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted invoice cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  -- A deleted user is cleared from created_by by its foreign key, whatever
  -- the invoice's status. Nothing else may change with it.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
     and (new.created_by is null or new.created_by = old.created_by) then
    return new;
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft','posted') then
      raise exception 'a draft invoice is deleted, not voided' using errcode = 'FIN01';
    end if;
    if new.status = 'posted' and coalesce((
      select sum(amount + sst_amount) from public.finance_invoice_lines
      where org_id = new.org_id and invoice_id = new.id
    ), 0) <= 0 then
      raise exception 'an invoice needs an amount before it is posted' using errcode = 'FIN10';
    end if;
    return new;
  end if;

  -- A person records the e-Invois status after posting; nothing else moves.
  if old.status = 'posted' and new.status = 'posted' then
    if (to_jsonb(new) - 'einvoice_status' - 'einvoice_uuid' - 'updated_at')
       is distinct from (to_jsonb(old) - 'einvoice_status' - 'einvoice_uuid' - 'updated_at') then
      raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;

  if old.status = 'posted' and new.status = 'void' then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
    if exists (
      select 1
      from public.finance_allocations a
      join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
      where a.org_id = old.org_id and a.invoice_id = old.id
        and t.status in ('draft','pending_approval','scheduled','posted')
    ) then
      raise exception 'the invoice has payments' using errcode = 'FIN02';
    end if;
    return new;
  end if;

  raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
end $$;

create trigger finance_invoice_guard
  before insert or update or delete on public.finance_invoices
  for each row execute function private.finance_invoice_guard();

create or replace function private.finance_invoice_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  -- The workspace is being deleted: its invoices and their lines all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_invoices where org_id = old.org_id and id = old.invoice_id for share;
    -- No parent row: the invoice itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_invoices where org_id = new.org_id and id = new.invoice_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a posted invoice cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_invoice_line_guard
  before insert or update or delete on public.finance_invoice_lines
  for each row execute function private.finance_invoice_line_guard();

-- Replaces the guard that knew only bills. The bill path is the same checks in
-- the same order as before, so the same refusal comes first: posted payment
-- (FIN09), wrong direction (FIN04), split above the payment (FIN03), document
-- not posted (FIN04, under a row lock), more than is owed (FIN05). The invoice
-- path is its mirror, with money in where a bill has money out.
create or replace function private.finance_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  t record;
  has_txn boolean;
  doc_status text;
  doc_total numeric;
  taken numeric;
begin
  -- The workspace is being deleted: its payments and their splits all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into t from public.finance_transactions where org_id = old.org_id and id = old.transaction_id;
    -- No parent row: the payment itself is being deleted.
    if found and t.status in ('posted','void') then
      raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;

  select amount, status, direction into t from public.finance_transactions where org_id = new.org_id and id = new.transaction_id;
  has_txn := found;
  if has_txn and t.status in ('posted','void') then
    raise exception 'the split of a posted payment cannot be changed' using errcode = 'FIN09';
  end if;

  -- An invoice takes money in; everything else is a bill and takes money out.
  -- (A row naming both, or neither, is refused by the table's check
  -- constraint, which runs after this trigger.)
  if new.bill_id is null and new.invoice_id is not null then
    if has_txn and t.direction <> 'in' then
      raise exception 'only money in pays an invoice' using errcode = 'FIN04';
    end if;
  else
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out pays a bill' using errcode = 'FIN04';
    end if;
  end if;

  select coalesce(sum(amount), 0) into taken
  from public.finance_allocations
  where org_id = new.org_id and transaction_id = new.transaction_id and id <> new.id;
  if taken + new.amount > t.amount then
    raise exception 'the split is more than the payment' using errcode = 'FIN03';
  end if;

  if new.bill_id is null and new.invoice_id is not null then
    -- Lock the invoice, so two payments at the same moment are checked one after the other.
    select status into doc_status from public.finance_invoices
    where org_id = new.org_id and id = new.invoice_id for update;
    if doc_status is distinct from 'posted' then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;

    select coalesce(sum(amount + sst_amount), 0) into doc_total
    from public.finance_invoice_lines where org_id = new.org_id and invoice_id = new.invoice_id;
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.invoice_id = new.invoice_id and a.id <> new.id
      and x.status in ('draft','pending_approval','scheduled','posted');
    if taken + new.amount > doc_total then
      raise exception 'more than is still owed on the invoice' using errcode = 'FIN05';
    end if;
    return new;
  end if;

  -- Lock the bill, so two payments at the same moment are checked one after the other.
  select status into doc_status from public.supplier_bills
  where org_id = new.org_id and id = new.bill_id for update;
  if doc_status is distinct from 'posted' then
    raise exception 'a payment can only go against a posted bill' using errcode = 'FIN04';
  end if;

  select coalesce(sum(amount + sst_amount), 0) into doc_total
  from public.supplier_bill_lines where org_id = new.org_id and bill_id = new.bill_id;
  select coalesce(sum(a.amount), 0) into taken
  from public.finance_allocations a
  join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
  where a.org_id = new.org_id and a.bill_id = new.bill_id and a.id <> new.id
    and x.status in ('draft','pending_approval','scheduled','posted');
  if taken + new.amount > doc_total then
    raise exception 'more than is still owed on the bill' using errcode = 'FIN05';
  end if;
  return new;
end $$;

create or replace function private.finance_contact_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_supplier and not new.is_supplier
     and exists (select 1 from public.supplier_bills where org_id = old.org_id and supplier_id = old.id) then
    raise exception 'the contact has bills' using errcode = 'FIN07';
  end if;
  if old.is_customer and not new.is_customer
     and exists (select 1 from public.finance_invoices where org_id = old.org_id and customer_id = old.id) then
    raise exception 'the contact has invoices' using errcode = 'FIN08';
  end if;
  return new;
end $$;

-- Replaces the guard on payments. Everything it refused before it refuses the
-- same way, in the same order, and it still never asks which way the money
-- goes: money in is drafted, posted and voided under the rules money out
-- already has. One rule is new, for bills as much as for invoices. A payment
-- that is not yet posted could be split across documents and then changed
-- underneath its split: made smaller than the split, or turned from money in
-- into money out, and then posted. Once it has a split it can no longer change
-- direction (FIN04, the wrong kind of money for the document) or be less than
-- its split (FIN03, the split is more than the payment). The functions never
-- do either: they insert the full amount, split it, and then change only
-- status, number, txn_date and updated_at.
create or replace function private.finance_transaction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allocated numeric;
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted','void') and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted payment cannot be deleted' using errcode = 'FIN09';
    end if;
    return old;
  end if;

  -- A deleted user is cleared from these two columns by their foreign keys.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by' - 'approved_by') = (to_jsonb(old) - 'created_by' - 'approved_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.approved_by is null or new.approved_by = old.approved_by) then
    return new;
  end if;

  if old.status = 'posted' and new.status = 'void'
     and (to_jsonb(new) - 'status' - 'updated_at') is not distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  if old.status in ('posted','void') then
    raise exception 'a posted payment cannot be changed' using errcode = 'FIN09';
  end if;
  if new.status = 'void' then
    raise exception 'only a paid payment is voided; delete this one' using errcode = 'FIN09';
  end if;

  -- Not posted yet, so it may still be edited, but not out from under its split.
  if new.direction is distinct from old.direction or new.amount < old.amount then
    select coalesce(sum(a.amount), 0) into allocated
    from public.finance_allocations a
    where a.org_id = old.org_id and a.transaction_id = old.id;
    if allocated > 0 then
      if new.direction is distinct from old.direction then
        raise exception 'a payment that is split cannot change direction' using errcode = 'FIN04';
      end if;
      if new.amount < allocated then
        raise exception 'the split is more than the payment' using errcode = 'FIN03';
      end if;
    end if;
  end if;
  return new;
end $$;

revoke all on function private.finance_transaction_guard() from public, anon, authenticated;
revoke all on function private.finance_invoice_guard() from public, anon, authenticated;
revoke all on function private.finance_invoice_line_guard() from public, anon, authenticated;
revoke all on function private.finance_allocation_guard() from public, anon, authenticated;
revoke all on function private.finance_contact_guard() from public, anon, authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Creates a draft invoice, or replaces a draft's header and lines. Returns its id.
create or replace function public.finance_save_invoice(target_org uuid, invoice jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iid uuid := nullif(invoice->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'an invoice needs at least one line' using errcode = 'FIN10';
  end if;

  if iid is null then
    insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status)
    values (
      target_org,
      (invoice->>'customer_id')::uuid,
      (invoice->>'invoice_date')::date,
      (invoice->>'due_date')::date,
      nullif(invoice->>'notes', ''),
      'draft'
    )
    returning id into iid;
  else
    update public.finance_invoices
       set customer_id = (invoice->>'customer_id')::uuid,
           invoice_date = (invoice->>'invoice_date')::date,
           due_date = (invoice->>'due_date')::date,
           notes = nullif(invoice->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = iid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the invoice no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_invoice_lines where org_id = target_org and invoice_id = iid;
  end if;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, iid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return iid;
end $$;

-- Posts a draft invoice and returns its number. The number is taken here, so
-- a failed post does not use one up.
create or replace function public.finance_post_invoice(target_org uuid, target_invoice uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  i record;
  total numeric;
  no text;
begin
  select status, invoice_no into i from public.finance_invoices
  where org_id = target_org and id = target_invoice for update;
  if not found then
    raise exception 'the invoice no longer exists' using errcode = 'FIN11';
  end if;
  if i.status <> 'draft' then
    raise exception 'the invoice is already posted' using errcode = 'FIN01';
  end if;
  select coalesce(sum(amount + sst_amount), 0) into total
  from public.finance_invoice_lines where org_id = target_org and invoice_id = target_invoice;
  if total <= 0 then
    raise exception 'an invoice needs an amount before it is posted' using errcode = 'FIN10';
  end if;

  no := coalesce(i.invoice_no, public.finance_next_number(target_org, 'invoice'));
  update public.finance_invoices
     set status = 'posted', invoice_no = no, posted_at = now(), updated_at = now()
   where org_id = target_org and id = target_invoice;
  return no;
end $$;

-- Records one payment in, split across one customer's posted invoices. Money
-- received is posted at once with an RC- number: it is never scheduled and
-- needs no approval. Returns its id.
create or replace function public.finance_record_payment_in(target_org uuid, payment jsonb, allocations jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid;
  total numeric;
  customers uuid[];
  no text;
begin
  if jsonb_typeof(allocations) is distinct from 'array' or jsonb_array_length(allocations) = 0 then
    raise exception 'no invoice was chosen' using errcode = 'FIN06';
  end if;

  -- Each amount is rounded to the sen before it is added, as each allocation
  -- is when it is stored, so the payment is exactly the sum of its split.
  select coalesce(sum(round((a->>'amount')::numeric, 2)), 0) into total from jsonb_array_elements(allocations) as a;
  select array_agg(distinct i.customer_id) into customers
  from jsonb_array_elements(allocations) as a
  join public.finance_invoices i on i.org_id = target_org and i.id = (a->>'invoice_id')::uuid;
  if customers is null or array_length(customers, 1) <> 1 then
    raise exception 'one payment is from one customer' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'in',
    (payment->>'account_id')::uuid,
    coalesce((payment->>'txn_date')::date, current_date),
    total,
    payment->>'method',
    nullif(payment->>'reference', ''),
    customers[1],
    nullif(payment->>'notes', ''),
    'draft'
  )
  returning id into tid;

  -- In id order, so two payments that share invoices lock them in the same order.
  insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
  select target_org, tid, (a->>'invoice_id')::uuid, (a->>'amount')::numeric
  from jsonb_array_elements(allocations) as a
  order by (a->>'invoice_id')::uuid;

  no := public.finance_next_number(target_org, 'receipt');
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_invoice(uuid, jsonb, jsonb)',
    'public.finance_post_invoice(uuid, uuid)',
    'public.finance_record_payment_in(uuid, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
