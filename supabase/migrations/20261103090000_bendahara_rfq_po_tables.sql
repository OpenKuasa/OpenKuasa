-- Bendahara: RFQs and purchase orders, tables.
--
-- The steps before a supplier bill: asking a supplier for a price (RFQ) and
-- committing to an order (purchase order) that a second person approves.
-- Rules live in the guards of the next migration; this file is the tables,
-- who may read and write them, and the two new document numbers.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

create table public.finance_rfqs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  supplier_id uuid not null,
  rfq_no text,
  rfq_date date not null default current_date,
  reply_by date,
  supplier_ref text,
  notes text,
  status text not null default 'draft' check (status in ('draft','sent','quoted','closed')),
  sent_at timestamptz,
  quoted_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, rfq_no),
  constraint finance_rfqs_dates_check check (reply_by is null or reply_by >= rfq_date),
  constraint finance_rfqs_number_check check ((status = 'draft') = (rfq_no is null)),
  foreign key (org_id, supplier_id) references public.finance_contacts(org_id, id)
);
create index finance_rfqs_supplier_idx on public.finance_rfqs (org_id, supplier_id);

-- unit_price is empty until the supplier answers, so there are no stored
-- amounts here; finance_rfq_totals works them out for the priced lines.
create table public.finance_rfq_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  rfq_id uuid not null,
  position integer not null default 0,
  product_id uuid,
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  uom text,
  pack_size text,
  unit_price numeric(14,4) check (unit_price >= 0),
  sst_rate numeric(5,2) not null default 0 check (sst_rate between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, rfq_id) references public.finance_rfqs(org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.finance_products(org_id, id)
);
create index finance_rfq_lines_rfq_idx on public.finance_rfq_lines (org_id, rfq_id);
create index finance_rfq_lines_product_idx on public.finance_rfq_lines (org_id, product_id);

-- created_by is the person who raised the order and submitted_by the person
-- who last sent it for approval: neither can approve it unless they own the
-- workspace. A rejected order returns to draft and keeps its number and the
-- reason until it is submitted again.
create table public.finance_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  supplier_id uuid not null,
  rfq_id uuid,
  po_no text,
  po_date date not null default current_date,
  expected_date date,
  notes text,
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','closed','cancelled')),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  rejection_reason text,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, po_no),
  constraint finance_purchase_orders_dates_check check (expected_date is null or expected_date >= po_date),
  -- A draft that was never submitted has no number, and can be cancelled without one.
  constraint finance_purchase_orders_number_check check (status in ('draft','cancelled') or po_no is not null),
  constraint finance_purchase_orders_approved_check
    check (status not in ('approved','closed') or approved_at is not null),
  foreign key (org_id, supplier_id) references public.finance_contacts(org_id, id),
  foreign key (org_id, rfq_id) references public.finance_rfqs(org_id, id)
);
create index finance_purchase_orders_supplier_idx on public.finance_purchase_orders (org_id, supplier_id);
-- One order per RFQ; a cancelled order frees the RFQ for another.
create unique index finance_purchase_orders_rfq_key
  on public.finance_purchase_orders (org_id, rfq_id)
  where rfq_id is not null and status <> 'cancelled';

-- received_quantity is the total that has arrived so far. More than was
-- ordered is allowed: suppliers over-deliver, and the screen flags it.
create table public.finance_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  purchase_order_id uuid not null,
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
  received_quantity numeric(14,3) not null default 0 check (received_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, purchase_order_id)
    references public.finance_purchase_orders(org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.finance_products(org_id, id)
);
create index finance_purchase_order_lines_po_idx
  on public.finance_purchase_order_lines (org_id, purchase_order_id);
create index finance_purchase_order_lines_product_idx
  on public.finance_purchase_order_lines (org_id, product_id);

do $$
declare t text;
begin
  foreach t in array array[
    'finance_rfqs','finance_rfq_lines','finance_purchase_orders','finance_purchase_order_lines'
  ] loop
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

-- ---- a bill may belong to a purchase order -----------------------------------
-- Optional: many small businesses pay bills without an order. The rule for
-- which order a bill may point at is in 20261103100000.
alter table public.supplier_bills
  add column purchase_order_id uuid,
  add constraint supplier_bills_purchase_order_fkey
    foreign key (org_id, purchase_order_id) references public.finance_purchase_orders(org_id, id);
create index supplier_bills_purchase_order_idx on public.supplier_bills (org_id, purchase_order_id);

-- ---- two more document numbers -----------------------------------------------
alter table public.finance_sequences
  drop constraint finance_sequences_doc_type_check,
  add constraint finance_sequences_doc_type_check
    check (doc_type in ('invoice','quotation','credit_note','bill','receipt','voucher','transfer','rfq','purchase_order'));

-- The body of 20261031090200 with the two new types. It stays "security
-- definer": finance_sequences is closed to the authenticated role, so this
-- function is its only writer.
create or replace function public.finance_next_number(target_org uuid, doc text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_prefix text;
  p text;
  n integer;
  w integer;
begin
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  default_prefix := case doc
    when 'invoice' then 'INV-'
    when 'quotation' then 'QT-'
    when 'credit_note' then 'CN-'
    when 'bill' then 'BILL-'
    when 'receipt' then 'RC-'
    when 'voucher' then 'PV-'
    when 'transfer' then 'TR-'
    when 'rfq' then 'RFQ-'
    when 'purchase_order' then 'PO-'
  end;
  if default_prefix is null then
    raise exception 'unknown document type %', doc using errcode = '22023';
  end if;

  insert into public.finance_sequences (org_id, doc_type, prefix)
  values (target_org, doc, default_prefix)
  on conflict (org_id, doc_type) do nothing;

  update public.finance_sequences
     set next_number = next_number + 1, updated_at = now()
   where org_id = target_org and doc_type = doc
  returning prefix, next_number - 1, pad into p, n, w;

  -- lpad cuts a string longer than the target, so never pad to less than the number's own length.
  return p || lpad(n::text, greatest(w, length(n::text)), '0');
end $$;

revoke all on function public.finance_next_number(uuid, text) from public, anon, service_role;
grant execute on function public.finance_next_number(uuid, text) to authenticated;
