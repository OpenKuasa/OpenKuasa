-- Bendahara sales follow-ons, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * finance_quotations + finance_quotation_lines: quotations, numbered QT-.
--   * finance_invoices.quotation_id: the quotation an invoice was made from.
--   * finance_credit_notes: a credit against one posted invoice, numbered CN-.
--   * finance_allocations can now point at a credit note, and carries the
--     reason of a refund.
--   * A refund is money out allocated to an invoice or to a credit note.
--   * Views: finance_invoice_totals now takes issued credit notes off the
--     balance and adds posted refunds back; finance_quotation_totals,
--     finance_credit_note_totals and finance_refunds are new.
--   * Guards: the ones on invoices, allocations, payments and contacts are
--     replaced; quotations and credit notes get their own.
--   * Functions that save, send, convert, issue and refund in one transaction.
--
-- The code deployed while this is applied writes no quotation, no credit note
-- and no money out against an invoice. For everything it does write, every
-- guard below answers as it did before: same checks, same order, same codes.
-- One answer differs, for a write only a direct call can make: money out
-- against an invoice with a split larger than the payment is now FIN03 (the
-- split is checked before the invoice is read) where it was FIN04.
-- With no credit note and no refund in the database, finance_invoice_totals
-- reads the same, row for row.
--
-- Nothing here is granted to service_role: every write is made by a signed-in
-- person through the authenticated role, and no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- quotations -------------------------------------------------------------
-- status is what a person sets. Expired is derived from valid_until in
-- finance_quotation_totals, as Overdue is for an invoice.
create table public.finance_quotations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  customer_id uuid not null,
  -- QT-0001; given when the quotation is sent.
  quotation_no text,
  quote_date date not null default current_date,
  valid_until date not null,
  notes text,
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined')),
  sent_at timestamptz,
  accepted_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, quotation_no),
  constraint finance_quotations_dates_check check (valid_until >= quote_date),
  -- A draft has no number; a quotation that has been sent has one and says when.
  constraint finance_quotations_number_check
    check ((status = 'draft') = (quotation_no is null) and (status = 'draft' or sent_at is not null)),
  -- An accepted quotation says when; no other status carries that date.
  constraint finance_quotations_accepted_check check ((status = 'accepted') = (accepted_at is not null)),
  foreign key (org_id, customer_id) references public.finance_contacts(org_id, id)
);
create index finance_quotations_customer_idx on public.finance_quotations (org_id, customer_id);
create index finance_quotations_date_idx on public.finance_quotations (org_id, quote_date);

-- Same shape as finance_invoice_lines, position included.
create table public.finance_quotation_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  quotation_id uuid not null,
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
  foreign key (org_id, quotation_id) references public.finance_quotations(org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.finance_products(org_id, id)
);
create index finance_quotation_lines_quotation_idx on public.finance_quotation_lines (org_id, quotation_id);
create index finance_quotation_lines_product_idx on public.finance_quotation_lines (org_id, product_id);

-- ---- invoices: the quotation an invoice came from ---------------------------
alter table public.finance_invoices
  add column quotation_id uuid,
  add constraint finance_invoices_quotation_fkey
    foreign key (org_id, quotation_id) references public.finance_quotations(org_id, id);
-- One invoice per quotation. A void invoice does not count, so a quotation
-- whose invoice was voided (or whose draft invoice was deleted) can be
-- converted again.
create unique index finance_invoices_quotation_key
  on public.finance_invoices (org_id, quotation_id)
  where quotation_id is not null and status <> 'void';

-- ---- credit notes -----------------------------------------------------------
-- One amount against one invoice, as the design has it: no lines. The customer
-- is the invoice's customer.
create table public.finance_credit_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null,
  -- CN-0001; given when the credit note is issued.
  credit_note_no text,
  credit_date date not null default current_date,
  reason text not null default 'other'
    check (reason in ('returns','pricing_adjustment','overbilling','goodwill','other')),
  amount numeric(14,2) not null check (amount > 0),
  notes text,
  status text not null default 'draft' check (status in ('draft','issued','void')),
  issued_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, credit_note_no),
  -- A draft has no number; an issued or void credit note has one, and an
  -- issued one says when it was issued.
  constraint finance_credit_notes_number_check
    check ((status = 'draft') = (credit_note_no is null) and (status <> 'issued' or issued_at is not null)),
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id)
);
create index finance_credit_notes_invoice_idx on public.finance_credit_notes (org_id, invoice_id);
create index finance_credit_notes_date_idx on public.finance_credit_notes (org_id, credit_date);

do $$
declare t text;
begin
  foreach t in array array['finance_quotations','finance_quotation_lines','finance_credit_notes'] loop
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

-- ---- allocations: a bill, an invoice or a credit note -----------------------
-- reason is what a refund is for. It was a free column nothing wrote; it now
-- takes one of five words, or nothing.
alter table public.finance_allocations add column credit_note_id uuid;
alter table public.finance_allocations
  drop constraint finance_allocations_one_document_check,
  add constraint finance_allocations_one_document_check
    check (num_nonnulls(bill_id, invoice_id, credit_note_id) = 1),
  add constraint finance_allocations_reason_check
    check (reason is null or reason in ('order_cancelled','damaged_goods','wrong_item','overpayment','other')),
  add constraint finance_allocations_transaction_credit_note_key unique (transaction_id, credit_note_id),
  add constraint finance_allocations_credit_note_fkey
    foreign key (org_id, credit_note_id) references public.finance_credit_notes(org_id, id);
create index finance_allocations_credit_note_idx on public.finance_allocations (org_id, credit_note_id);

-- ---- views ------------------------------------------------------------------
-- The same columns in the same order as before, with credited and refunded
-- added at the end. The balance is the design's: total, less posted money in,
-- less issued credit notes, plus posted refunds. A refund counts whether it
-- was put against the invoice itself or against one of its credit notes.
-- A balance below zero is the customer in credit; the invoice then reads
-- 'paid', as it does at zero. The guards below read their figures from this
-- view, so there is one definition of what an invoice owes.
create or replace view public.finance_invoice_totals with (security_invoker = true) as
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
  end as display_status,
  v.credited::numeric(14,2) as credited,
  v.refunded::numeric(14,2) as refunded
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
left join lateral (
  -- Only issued credit notes reduce what is owed.
  select sum(n.amount) as credited
  from public.finance_credit_notes n
  where n.org_id = i.org_id and n.invoice_id = i.id and n.status = 'issued'
) k on true
left join lateral (
  -- Posted money out against the invoice itself.
  select sum(a.amount) as refunded
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) ri on true
left join lateral (
  -- Posted money out against one of the invoice's credit notes.
  select sum(a.amount) as refunded
  from public.finance_credit_notes n
  join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where n.org_id = i.org_id and n.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) rn on true
cross join lateral (
  select
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) as total,
    coalesce(p.paid, 0) as paid,
    coalesce(k.credited, 0) as credited,
    coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0) as refunded,
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) - coalesce(p.paid, 0) - coalesce(k.credited, 0)
      + coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0) as balance
) v;
revoke all on public.finance_invoice_totals from anon, authenticated;
grant select on public.finance_invoice_totals to authenticated;

-- Expired uses the database's current_date (UTC), as Overdue does. invoice_id
-- and invoice_no are the invoice made from the quotation, if one stands (a
-- void invoice does not count); invoice_no is null while that invoice is a draft.
create view public.finance_quotation_totals with (security_invoker = true) as
select
  q.id,
  q.org_id,
  q.customer_id,
  c.name as customer_name,
  q.quotation_no,
  q.quote_date,
  q.valid_until,
  q.notes,
  q.status,
  q.sent_at,
  q.accepted_at,
  q.created_by,
  q.created_at,
  q.updated_at,
  coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
  coalesce(l.sst, 0)::numeric(14,2) as sst,
  (coalesce(l.subtotal, 0) + coalesce(l.sst, 0))::numeric(14,2) as total,
  case
    when q.status = 'sent' and q.valid_until < current_date then 'expired'
    else q.status
  end as display_status,
  x.id as invoice_id,
  x.invoice_no
from public.finance_quotations q
join public.finance_contacts c on c.org_id = q.org_id and c.id = q.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst
  from public.finance_quotation_lines
  where org_id = q.org_id and quotation_id = q.id
) l on true
left join public.finance_invoices x
  on x.org_id = q.org_id and x.quotation_id = q.id and x.status <> 'void';
revoke all on public.finance_quotation_totals from anon, authenticated;
grant select on public.finance_quotation_totals to authenticated;

-- A credit note with its invoice, its customer and what has been refunded
-- against the note itself (posted money out).
create view public.finance_credit_note_totals with (security_invoker = true) as
select
  n.id,
  n.org_id,
  n.invoice_id,
  i.invoice_no,
  i.customer_id,
  c.name as customer_name,
  n.credit_note_no,
  n.credit_date,
  n.reason,
  n.amount,
  n.notes,
  n.status,
  n.issued_at,
  n.created_by,
  n.created_at,
  n.updated_at,
  coalesce(r.refunded, 0)::numeric(14,2) as refunded
from public.finance_credit_notes n
join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(a.amount) as refunded
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = n.org_id and a.credit_note_id = n.id and t.direction = 'out' and t.status = 'posted'
) r on true;
revoke all on public.finance_credit_note_totals from anon, authenticated;
grant select on public.finance_credit_note_totals to authenticated;

-- One row per refund: money out against an invoice or against a credit note.
-- invoice_id is the invoice either way. Money out against a bill is not here
-- (it is in finance_payments_out, which joins bills and so never shows a
-- refund), and money in is not here.
create view public.finance_refunds with (security_invoker = true) as
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
  coalesce(a.reason, 'other') as reason,
  t.notes,
  t.account_id,
  acc.name as account_name,
  i.id as invoice_id,
  i.invoice_no,
  n.id as credit_note_id,
  n.credit_note_no,
  i.customer_id,
  c.name as customer_name,
  t.created_at
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = coalesce(a.invoice_id, n.invoice_id)
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'out';
revoke all on public.finance_refunds from anon, authenticated;
grant select on public.finance_refunds to authenticated;

-- ---- guards -----------------------------------------------------------------
-- Each guard steps aside when its workspace is being deleted: by the time a
-- cascade reaches these rows the orgs row is already gone.

-- Refunds not yet paid out (draft, waiting for approval or scheduled) that are
-- held against an invoice, directly or through one of its credit notes. skip
-- leaves one allocation out: the row a guard is checking. Runs as the caller,
-- from inside the guards; the private schema is not reachable through the API.
create or replace function private.finance_refunds_held(target_org uuid, target_invoice uuid, skip uuid)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((
      select sum(a.amount)
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = target_org and a.invoice_id = target_invoice
        and (skip is null or a.id <> skip)
        and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
    ), 0)
    + coalesce((
      select sum(a.amount)
      from public.finance_credit_notes n
      join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where n.org_id = target_org and n.invoice_id = target_invoice
        and (skip is null or a.id <> skip)
        and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
    ), 0);
$$;
revoke all on function private.finance_refunds_held(uuid, uuid, uuid) from public, anon;
grant execute on function private.finance_refunds_held(uuid, uuid, uuid) to authenticated;

create or replace function private.finance_quotation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a quotation starts as a draft' using errcode = 'FIN01';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a quotation that has been sent cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  -- A deleted user is cleared from created_by by its foreign key, whatever
  -- the quotation's status. Nothing else may change with it.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
     and (new.created_by is null or new.created_by = old.created_by) then
    return new;
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft','sent') then
      raise exception 'a quotation is sent before it is accepted or declined' using errcode = 'FIN01';
    end if;
    if new.status = 'sent' and coalesce((
      select sum(amount + sst_amount) from public.finance_quotation_lines
      where org_id = new.org_id and quotation_id = new.id
    ), 0) <= 0 then
      raise exception 'a quotation needs an amount before it is sent' using errcode = 'FIN10';
    end if;
    return new;
  end if;

  -- Sent, accepted or declined: what the customer was given is locked. Only
  -- their answer is recorded, and it can be corrected from one to the other.
  if (to_jsonb(new) - 'status' - 'accepted_at' - 'updated_at')
     is distinct from (to_jsonb(old) - 'status' - 'accepted_at' - 'updated_at') then
    raise exception 'a quotation that has been sent cannot be changed' using errcode = 'FIN01';
  end if;
  if new.status = old.status or new.status not in ('accepted','declined') then
    raise exception 'a quotation that has been sent cannot be changed' using errcode = 'FIN01';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = old.org_id and quotation_id = old.id and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;
  return new;
end $$;

create trigger finance_quotation_guard
  before insert or update or delete on public.finance_quotations
  for each row execute function private.finance_quotation_guard();

create or replace function private.finance_quotation_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  -- The workspace is being deleted: its quotations and their lines all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_quotations where org_id = old.org_id and id = old.quotation_id for share;
    -- No parent row: the quotation itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a quotation that has been sent cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_quotations where org_id = new.org_id and id = new.quotation_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a quotation that has been sent cannot be changed' using errcode = 'FIN01';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_quotation_line_guard
  before insert or update or delete on public.finance_quotation_lines
  for each row execute function private.finance_quotation_line_guard();

-- A credit note is written against a posted invoice, and all the issued
-- credit notes of an invoice together never exceed the invoice's total: more
-- cannot be credited than was billed. What was paid does not limit it; a
-- credit note on a paid invoice leaves the customer in credit, and a refund
-- pays that out.
create or replace function private.finance_credit_note_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  doc_status text;
  pos record;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'an issued credit note cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a credit note starts as a draft' using errcode = 'FIN01';
    end if;
  else
    -- A deleted user is cleared from created_by by its foreign key, whatever
    -- the credit note's status. Nothing else may change with it.
    if new.status = old.status
       and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
       and (new.created_by is null or new.created_by = old.created_by) then
      return new;
    end if;

    if old.status = 'issued' and new.status = 'void' then
      if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
        raise exception 'an issued credit note cannot be changed' using errcode = 'FIN01';
      end if;
      if exists (
        select 1
        from public.finance_allocations a
        join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
        where a.org_id = old.org_id and a.credit_note_id = old.id
          and t.status in ('draft','pending_approval','scheduled','posted')
      ) then
        raise exception 'the credit note has refunds' using errcode = 'FIN02';
      end if;
      -- Lock the invoice, so a refund against it at the same moment is checked after this.
      perform 1 from public.finance_invoices where org_id = old.org_id and id = old.invoice_id for update;
      select total, paid, credited, refunded into pos
      from public.finance_invoice_totals where org_id = old.org_id and id = old.invoice_id;
      -- No figures, no answer: without them the test below would let anything through.
      if not found then
        raise exception 'a credit note can only go against a posted invoice' using errcode = 'FIN04';
      end if;
      -- Refunds against the invoice itself lean on this credit too: without
      -- the note, they must still fit in what the customer is in credit.
      if pos.refunded + private.finance_refunds_held(old.org_id, old.invoice_id, null)
         > greatest(pos.paid + pos.credited - old.amount - pos.total, 0) then
        raise exception 'refunds on the invoice depend on this credit note' using errcode = 'FIN02';
      end if;
      return new;
    end if;

    if old.status <> 'draft' then
      raise exception 'an issued credit note cannot be changed' using errcode = 'FIN01';
    end if;
    if new.status = 'void' then
      raise exception 'a draft credit note is deleted, not voided' using errcode = 'FIN01';
    end if;
  end if;

  -- A draft being written, or a draft being issued. Lock the invoice, so two
  -- credit notes at the same moment are checked one after the other.
  select status into doc_status from public.finance_invoices
  where org_id = new.org_id and id = new.invoice_id for update;
  if not found then
    -- Not there, or not this caller's to change: the foreign key or row-level
    -- security refuses the write and says which.
    return new;
  end if;
  if doc_status <> 'posted' then
    raise exception 'a credit note can only go against a posted invoice' using errcode = 'FIN04';
  end if;
  select total, credited into pos
  from public.finance_invoice_totals where org_id = new.org_id and id = new.invoice_id;
  -- No figures, no answer: without them the cap below would let anything through.
  if not found then
    raise exception 'a credit note can only go against a posted invoice' using errcode = 'FIN04';
  end if;
  if new.amount > pos.total - pos.credited then
    raise exception 'more than the invoice has left to credit' using errcode = 'FIN05';
  end if;
  return new;
end $$;

create trigger finance_credit_note_guard
  before insert or update or delete on public.finance_credit_notes
  for each row execute function private.finance_credit_note_guard();

-- Replaces the guard on invoices. Everything it refused before it refuses the
-- same way, in the same order. Two rules are new, and neither can be met by a
-- row that exists today: quotation_id may only name an accepted quotation of
-- the same customer (FIN04), and an invoice with a credit note that is a draft
-- or issued cannot be voided (FIN12). And one thing it now does by itself: a
-- draft made from a quotation is untied from it when its customer changes, so
-- one customer's quotation never shows another customer's invoice. The invoice
-- becomes an ordinary draft and the quotation can be converted again.
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
    if new.quotation_id is not null and not exists (
      select 1 from public.finance_quotations q
      where q.org_id = new.org_id and q.id = new.quotation_id
        and q.status = 'accepted' and q.customer_id = new.customer_id
    ) then
      raise exception 'an invoice is made from an accepted quotation of the same customer' using errcode = 'FIN04';
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
    -- The customer changed and the tie was left as it was (finance_save_invoice
    -- writes the customer and never the tie): the quotation is the old
    -- customer's, so the invoice lets go of it.
    if new.customer_id is distinct from old.customer_id
       and new.quotation_id is not null
       and new.quotation_id is not distinct from old.quotation_id then
      new.quotation_id := null;
    end if;
    -- A draft may be tied to a quotation, or untied; it is checked when the tie is made.
    if new.quotation_id is not null and new.quotation_id is distinct from old.quotation_id and not exists (
      select 1 from public.finance_quotations q
      where q.org_id = new.org_id and q.id = new.quotation_id
        and q.status = 'accepted' and q.customer_id = new.customer_id
    ) then
      raise exception 'an invoice is made from an accepted quotation of the same customer' using errcode = 'FIN04';
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
    -- Money in or a refund, against the invoice itself.
    if exists (
      select 1
      from public.finance_allocations a
      join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
      where a.org_id = old.org_id and a.invoice_id = old.id
        and t.status in ('draft','pending_approval','scheduled','posted')
    ) then
      raise exception 'the invoice has payments' using errcode = 'FIN02';
    end if;
    if exists (
      select 1 from public.finance_credit_notes
      where org_id = old.org_id and invoice_id = old.id and status in ('draft','issued')
    ) then
      raise exception 'the invoice has credit notes' using errcode = 'FIN12';
    end if;
    return new;
  end if;

  raise exception 'a posted invoice cannot be changed' using errcode = 'FIN01';
end $$;

-- Replaces the guard on allocations. A bill is handled by the same checks in
-- the same order as before: posted payment (FIN09), wrong direction (FIN04),
-- split above the payment (FIN03), bill not posted (FIN04, under a row lock),
-- more than is owed (FIN05). Money in against an invoice is refused for the
-- same reasons as before; what it may take is now read from
-- finance_invoice_totals, so the guard and the screens cannot disagree.
--
-- New: money out against an invoice or a credit note is a refund. It needs
-- the customer to be in credit on that invoice (FIN04 when they are not, as
-- money out against an invoice always was), and it can be no more than that
-- credit, counting refunds that are waiting to be paid out (FIN05).
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
  note record;
  target_invoice uuid;
  pos record;
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

  -- A credit note takes only money out. An invoice takes money in (a
  -- payment) or money out (a refund). Everything else is a bill and takes
  -- money out. (A row naming two documents, or none, is refused by the
  -- table's check constraint, which runs after this trigger.)
  if new.bill_id is null and new.credit_note_id is not null then
    if has_txn and t.direction <> 'out' then
      raise exception 'only money out refunds a credit note' using errcode = 'FIN04';
    end if;
  elsif new.bill_id is null and new.invoice_id is not null then
    null;
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

  if new.bill_id is null and (new.invoice_id is not null or new.credit_note_id is not null) then
    target_invoice := new.invoice_id;
    if new.credit_note_id is not null then
      -- Lock the credit note, so it cannot be voided while this is checked.
      select invoice_id, status, amount into note from public.finance_credit_notes
      where org_id = new.org_id and id = new.credit_note_id for update;
      if not found or note.status <> 'issued' then
        raise exception 'a refund can only go against an issued credit note' using errcode = 'FIN04';
      end if;
      target_invoice := note.invoice_id;
    end if;

    -- Lock the invoice, so two payments or refunds at the same moment are checked one after the other.
    select status into doc_status from public.finance_invoices
    where org_id = new.org_id and id = target_invoice for update;
    if doc_status is distinct from 'posted' then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;
    -- total, less posted money in, less issued credit notes, plus posted refunds.
    select balance into pos from public.finance_invoice_totals
    where org_id = new.org_id and id = target_invoice;
    -- No figures, no answer: without them the caps below would let anything through.
    if not found then
      raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
    end if;

    if has_txn and t.direction = 'out' then
      if pos.balance >= 0 then
        raise exception 'only money in pays an invoice; a refund needs the customer to be in credit' using errcode = 'FIN04';
      end if;
      if private.finance_refunds_held(new.org_id, target_invoice, new.id) + new.amount > -pos.balance then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
      if new.credit_note_id is not null then
        -- Never more than the credit note itself, counting every refund against it that stands.
        select coalesce(sum(a.amount), 0) into taken
        from public.finance_allocations a
        join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
        where a.org_id = new.org_id and a.credit_note_id = new.credit_note_id and a.id <> new.id
          and x.status in ('draft','pending_approval','scheduled','posted');
        if taken + new.amount > note.amount then
          raise exception 'more than the credit note' using errcode = 'FIN05';
        end if;
      end if;
      return new;
    end if;

    -- Money in. Payments that are not posted yet hold their part of the balance.
    select coalesce(sum(a.amount), 0) into taken
    from public.finance_allocations a
    join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
    where a.org_id = new.org_id and a.invoice_id = target_invoice and a.id <> new.id
      and x.direction = 'in' and x.status in ('draft','pending_approval','scheduled');
    if taken + new.amount > pos.balance then
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

-- Replaces the guard on payments. Everything it refused before it refuses the
-- same way, in the same order. One rule is new and concerns only money out
-- that is split across invoices or credit notes, which is to say a refund: at
-- the moment it is paid out it is checked in full again, as it was when it
-- was recorded. Each credit note it names must still be issued (FIN04) and
-- must cover it together with the other refunds standing against that note
-- (FIN05); and on each invoice it names, this refund plus the refunds of
-- other payments that are waiting must still fit in what the customer is in
-- credit there (FIN05). The refund's own amount is counted whatever status it
-- is coming from: a scheduled refund holds its part of the credit, a rejected
-- one holds nothing, and another refund may have taken the credit meanwhile.
-- The credit can also simply have gone, because the payment it refunds was
-- voided in between. Every credit note the refund names is locked first, then
-- every invoice, and what the refund itself amounts to is read after each
-- lock. For a refund with one allocation, which is every refund the app
-- records, that is the order the guard on allocations locks in (the credit
-- note, then its invoice). A payment split by hand across several credit
-- notes is locked here as all notes, then all invoices, while the guard on
-- allocations goes note, invoice, row by row; two such direct writes can
-- deadlock, and Postgres ends one of them. A payment out against bills has
-- no such rows, so for it the loops do nothing and no lock is taken.
create or replace function private.finance_transaction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allocated numeric;
  r record;
  owing numeric;
  note record;
  others numeric;
  mine numeric;
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

  -- A refund being paid out: look again at each credit note and each invoice
  -- it refunds. What this payment itself refunds is added by hand (mine),
  -- and every other sum leaves this payment out, so the answer does not
  -- depend on the status it is coming from. mine is read after the row it is
  -- measured against is locked, never carried over from the loop's query.
  if new.status = 'posted' and new.direction = 'out' then
    for r in
      select a.credit_note_id
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id and a.credit_note_id is not null
      group by 1
      order by 1
    loop
      -- Lock the credit note, so it cannot be voided while this is checked.
      select status, amount into note from public.finance_credit_notes
      where org_id = old.org_id and id = r.credit_note_id for update;
      if not found or note.status <> 'issued' then
        raise exception 'a refund can only go against an issued credit note' using errcode = 'FIN04';
      end if;
      -- What this payment refunds against the note, read now that the note is locked.
      select coalesce(sum(a.amount), 0) into mine
      from public.finance_allocations a
      where a.org_id = old.org_id and a.transaction_id = old.id and a.credit_note_id = r.credit_note_id;
      -- Never more than the credit note itself, counting every other refund against it that stands.
      select coalesce(sum(a.amount), 0) into others
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = old.org_id and a.credit_note_id = r.credit_note_id and a.transaction_id <> old.id
        and x.status in ('draft','pending_approval','scheduled','posted');
      if others + mine > note.amount then
        raise exception 'more than the credit note' using errcode = 'FIN05';
      end if;
    end loop;

    for r in
      select coalesce(a.invoice_id, n.invoice_id) as invoice_id
      from public.finance_allocations a
      left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
      where a.org_id = old.org_id and a.transaction_id = old.id and a.bill_id is null
      group by 1
      order by 1
    loop
      -- Lock the invoice, so two refunds paid out at the same moment are checked one after the other.
      perform 1 from public.finance_invoices where org_id = old.org_id and id = r.invoice_id for update;
      -- The balance already has every posted refund in it.
      select balance into owing from public.finance_invoice_totals
      where org_id = old.org_id and id = r.invoice_id;
      -- No figures, no answer: without them the cap below would let anything through.
      if not found then
        raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
      end if;
      -- Refunds of other payments that are waiting to be paid out, against the
      -- invoice itself or against one of its credit notes.
      select
        coalesce((
          select sum(a.amount)
          from public.finance_allocations a
          join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
          where a.org_id = old.org_id and a.invoice_id = r.invoice_id and a.transaction_id <> old.id
            and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
        ), 0)
        + coalesce((
          select sum(a.amount)
          from public.finance_credit_notes n
          join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
          join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
          where n.org_id = old.org_id and n.invoice_id = r.invoice_id and a.transaction_id <> old.id
            and x.direction = 'out' and x.status in ('draft','pending_approval','scheduled')
        ), 0)
      into others;
      -- What this payment refunds on the invoice, against the invoice itself or
      -- against one of its credit notes, read now that the invoice is locked.
      -- The figure the loop started from was read before the lock, and a split
      -- added to this payment in between would be in neither sum.
      select
        coalesce((
          select sum(a.amount)
          from public.finance_allocations a
          where a.org_id = old.org_id and a.transaction_id = old.id and a.invoice_id = r.invoice_id
        ), 0)
        + coalesce((
          select sum(a.amount)
          from public.finance_credit_notes n
          join public.finance_allocations a on a.org_id = n.org_id and a.credit_note_id = n.id
          where n.org_id = old.org_id and n.invoice_id = r.invoice_id and a.transaction_id = old.id
        ), 0)
      into mine;
      if others + mine > greatest(-owing, 0) then
        raise exception 'more than the customer is in credit' using errcode = 'FIN05';
      end if;
    end loop;
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
     and (exists (select 1 from public.finance_invoices where org_id = old.org_id and customer_id = old.id)
       or exists (select 1 from public.finance_quotations where org_id = old.org_id and customer_id = old.id)) then
    raise exception 'the contact has invoices or quotations' using errcode = 'FIN08';
  end if;
  return new;
end $$;

revoke all on function private.finance_quotation_guard() from public, anon, authenticated;
revoke all on function private.finance_quotation_line_guard() from public, anon, authenticated;
revoke all on function private.finance_credit_note_guard() from public, anon, authenticated;
revoke all on function private.finance_invoice_guard() from public, anon, authenticated;
revoke all on function private.finance_allocation_guard() from public, anon, authenticated;
revoke all on function private.finance_transaction_guard() from public, anon, authenticated;
revoke all on function private.finance_contact_guard() from public, anon, authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Creates a draft quotation, or replaces a draft's header and lines. Returns its id.
create or replace function public.finance_save_quotation(target_org uuid, quotation jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  qid uuid := nullif(quotation->>'id', '')::uuid;
  n integer;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a quotation needs at least one line' using errcode = 'FIN10';
  end if;

  if qid is null then
    insert into public.finance_quotations (org_id, customer_id, quote_date, valid_until, notes, status)
    values (
      target_org,
      (quotation->>'customer_id')::uuid,
      (quotation->>'quote_date')::date,
      (quotation->>'valid_until')::date,
      nullif(quotation->>'notes', ''),
      'draft'
    )
    returning id into qid;
  else
    update public.finance_quotations
       set customer_id = (quotation->>'customer_id')::uuid,
           quote_date = (quotation->>'quote_date')::date,
           valid_until = (quotation->>'valid_until')::date,
           notes = nullif(quotation->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = qid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the quotation no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_quotation_lines where org_id = target_org and quotation_id = qid;
  end if;

  insert into public.finance_quotation_lines
    (org_id, quotation_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select
    target_org, qid,
    l.ord::integer,
    nullif(l.line->>'product_id', '')::uuid,
    l.line->>'description',
    (l.line->>'quantity')::numeric,
    nullif(l.line->>'uom', ''),
    nullif(l.line->>'pack_size', ''),
    (l.line->>'unit_price')::numeric,
    coalesce((l.line->>'sst_rate')::numeric, 0)
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return qid;
end $$;

-- Marks a draft quotation as sent and returns its number. Nothing is emailed:
-- "sent" records that the customer has been given it. The number is taken
-- here, so a failed send does not use one up.
create or replace function public.finance_send_quotation(target_org uuid, target_quotation uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  q record;
  total numeric;
  no text;
begin
  select status, quotation_no into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'draft' then
    raise exception 'the quotation has already been sent' using errcode = 'FIN01';
  end if;
  select coalesce(sum(amount + sst_amount), 0) into total
  from public.finance_quotation_lines where org_id = target_org and quotation_id = target_quotation;
  if total <= 0 then
    raise exception 'a quotation needs an amount before it is sent' using errcode = 'FIN10';
  end if;

  no := coalesce(q.quotation_no, public.finance_next_number(target_org, 'quotation'));
  update public.finance_quotations
     set status = 'sent', quotation_no = no, sent_at = now(), updated_at = now()
   where org_id = target_org and id = target_quotation;
  return no;
end $$;

-- Makes a draft invoice from an accepted quotation: the same customer, notes
-- and lines, dated today and due after the customer's payment terms. Returns
-- the invoice's id. A quotation has one invoice at a time; once that invoice
-- is voided, or deleted while still a draft, the quotation can be converted again.
create or replace function public.finance_convert_quotation(target_org uuid, target_quotation uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  q record;
  terms integer;
  iid uuid;
begin
  select status, customer_id, notes into q from public.finance_quotations
  where org_id = target_org and id = target_quotation for update;
  if not found then
    raise exception 'the quotation no longer exists' using errcode = 'FIN11';
  end if;
  if q.status <> 'accepted' then
    raise exception 'only an accepted quotation becomes an invoice' using errcode = 'FIN04';
  end if;
  if exists (
    select 1 from public.finance_invoices
    where org_id = target_org and quotation_id = target_quotation and status <> 'void'
  ) then
    raise exception 'the quotation has an invoice' using errcode = 'FIN13';
  end if;

  select payment_terms_days into terms from public.finance_contacts
  where org_id = target_org and id = q.customer_id;

  insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, notes, status, quotation_id)
  values (target_org, q.customer_id, current_date, current_date + coalesce(terms, 30), q.notes, 'draft', target_quotation)
  returning id into iid;

  insert into public.finance_invoice_lines
    (org_id, invoice_id, position, product_id, description, quantity, uom, pack_size, unit_price, sst_rate)
  select target_org, iid, l.position, l.product_id, l.description, l.quantity, l.uom, l.pack_size, l.unit_price, l.sst_rate
  from public.finance_quotation_lines l
  where l.org_id = target_org and l.quotation_id = target_quotation
  order by l.position, l.id;

  return iid;
end $$;

-- Creates a draft credit note, or replaces a draft. Returns its id.
create or replace function public.finance_save_credit_note(target_org uuid, note jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  nid uuid := nullif(note->>'id', '')::uuid;
  n integer;
begin
  if nid is null then
    insert into public.finance_credit_notes (org_id, invoice_id, credit_date, reason, amount, notes, status)
    values (
      target_org,
      (note->>'invoice_id')::uuid,
      coalesce((note->>'credit_date')::date, current_date),
      coalesce(nullif(note->>'reason', ''), 'other'),
      (note->>'amount')::numeric,
      nullif(note->>'notes', ''),
      'draft'
    )
    returning id into nid;
  else
    update public.finance_credit_notes
       set invoice_id = (note->>'invoice_id')::uuid,
           credit_date = coalesce((note->>'credit_date')::date, current_date),
           reason = coalesce(nullif(note->>'reason', ''), 'other'),
           amount = (note->>'amount')::numeric,
           notes = nullif(note->>'notes', ''),
           updated_at = now()
     where org_id = target_org and id = nid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the credit note no longer exists' using errcode = 'FIN11';
    end if;
  end if;
  return nid;
end $$;

-- Issues a draft credit note and returns its number. From this moment it
-- reduces what the invoice owes. The number is taken here, so a failed issue
-- does not use one up.
create or replace function public.finance_issue_credit_note(target_org uuid, target_note uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c record;
  no text;
begin
  select status, credit_note_no into c from public.finance_credit_notes
  where org_id = target_org and id = target_note for update;
  if not found then
    raise exception 'the credit note no longer exists' using errcode = 'FIN11';
  end if;
  if c.status <> 'draft' then
    raise exception 'the credit note is already issued' using errcode = 'FIN01';
  end if;

  no := coalesce(c.credit_note_no, public.finance_next_number(target_org, 'credit_note'));
  update public.finance_credit_notes
     set status = 'issued', credit_note_no = no, issued_at = now(), updated_at = now()
   where org_id = target_org and id = target_note;
  return no;
end $$;

-- Records one refund: money out to a customer against one invoice, or against
-- one credit note. status is 'posted' (paid out now, numbered PV-) or
-- 'scheduled' (pending: not yet money out). Returns its id. A pending refund
-- is paid out by finance_mark_payment_paid, as a scheduled payment to a
-- supplier is.
create or replace function public.finance_record_refund(target_org uuid, refund jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid;
  inv uuid := nullif(refund->>'invoice_id', '')::uuid;
  note uuid := nullif(refund->>'credit_note_id', '')::uuid;
  customer uuid;
  -- Rounded to the sen first, as the allocation is when it is stored, so the
  -- payment is exactly its split.
  amt numeric := round((refund->>'amount')::numeric, 2);
  want text := coalesce(refund->>'status', 'posted');
  no text;
begin
  if want not in ('posted','scheduled') then
    raise exception 'unknown refund status %', want using errcode = '22023';
  end if;
  if num_nonnulls(inv, note) <> 1 then
    raise exception 'a refund is against one invoice or one credit note' using errcode = 'FIN06';
  end if;
  if note is not null then
    select i.customer_id into customer
    from public.finance_credit_notes n
    join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
    where n.org_id = target_org and n.id = note;
  else
    select customer_id into customer from public.finance_invoices where org_id = target_org and id = inv;
  end if;
  if customer is null then
    raise exception 'no invoice or credit note was found' using errcode = 'FIN06';
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'out',
    (refund->>'account_id')::uuid,
    coalesce((refund->>'txn_date')::date, current_date),
    amt,
    refund->>'method',
    nullif(refund->>'reference', ''),
    customer,
    nullif(refund->>'notes', ''),
    'draft'
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
  values (target_org, tid, inv, note, amt, coalesce(nullif(refund->>'reason', ''), 'other'));

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_quotation(uuid, jsonb, jsonb)',
    'public.finance_send_quotation(uuid, uuid)',
    'public.finance_convert_quotation(uuid, uuid)',
    'public.finance_save_credit_note(uuid, jsonb)',
    'public.finance_issue_credit_note(uuid, uuid)',
    'public.finance_record_refund(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
