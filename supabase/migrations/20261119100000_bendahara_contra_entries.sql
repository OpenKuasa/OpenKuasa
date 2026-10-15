-- Bendahara: contra entries (issue #223). A contact who is both a customer
-- and a supplier owes us on invoices while we owe them on bills; a contra
-- entry sets the two off against each other with no money moving.
--
--   * finance_contras and finance_contra_lines: one contact, an amount, a
--     date, a reference and a note; one line per invoice or bill it sets off.
--     A draft, then posted (CT- number), then voided; never edited once
--     posted. Owner or admin only to write; every member reads.
--   * Posting reduces what each invoice and bill still owes, as a payment
--     would: finance_invoice_totals and supplier_bill_totals subtract posted
--     contra lines from balance, and say how much in a new last column,
--     set_off. paid stays money only.
--   * The ledger: a posted contra debits Accounts Payable and credits
--     Accounts Receivable by its amount; a voided one is reversed on the day
--     it was voided, as every other void (finance_ledger_lines).
--   * No row is written to finance_transactions or finance_allocations, so no
--     bank or cash balance, no Banking list and no line of the Cash Flow can
--     move.
--
-- Live objects REPLACED (their current text is quoted where each is made):
--   finance_invoice_totals, supplier_bill_totals, finance_ledger_lines
--   (create or replace view: same columns, same order, one appended to the
--   first two), finance_next_number (create or replace function: one line
--   added, still security definer), and the check constraint
--   finance_sequences_doc_type_check (dropped and added with 'contra').
-- Live guards NOT replaced; new triggers beside them:
--   finance_allocation_less_contra   a bill's payments and its posted
--                                    contras together are never more than
--                                    the bill (FIN05)
--   finance_invoice_void_contra,
--   finance_bill_void_contra         a document a posted contra names is not
--                                    voided (FIN32)
--   finance_void_stamp               on finance_contras, with the existing
--                                    function
--
-- New error codes:
--   FIN29  a contra entry's amounts do not add up: an amount above zero, at
--          least one invoice and one bill, each side adding up to the amount
--   FIN31  a contra entry is for one contact who is both a customer and a
--          supplier, and sets off that contact's own invoices and bills
--   FIN32  an invoice or bill that a posted contra entry sets off is not
--          voided; void the contra entry first
--   FIN33  refunds on an invoice depend on this contra entry; it is not
--          voided
-- FIN01, FIN04, FIN05, FIN11 and FIN14 mean what they mean everywhere else
-- in finance.
--
-- Nothing here is granted to service_role: no worker touches these tables.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- What the triggers and the constraint below need, at once or not at all.
-- finance_sequences is altered (its check constraint), the other three get a
-- trigger each. The app's functions lock invoices, bills and payments in more
-- than one order; taking all four in one statement, without waiting, means
-- this either has them all or stops with nothing applied and is run again.
lock table public.finance_sequences in access exclusive mode nowait;
lock table
  public.finance_allocations,
  public.finance_invoices,
  public.supplier_bills
  in share row exclusive mode nowait;

-- ============================================================================
-- 1. Tables
-- ============================================================================

-- status is draft, posted or void. A draft has no number and was not posted;
-- a posted or void one has both. voided_at is the database's (the stamp
-- trigger below), as on the other four tables that are voided.
create table public.finance_contras (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- CT-0001; given when the contra entry is posted.
  contra_no text,
  contra_date date not null default current_date,
  contact_id uuid not null,
  amount numeric(14,2) not null,
  -- The other party's agreement: their reference, and a note.
  reference text,
  notes text,
  status text not null default 'draft' check (status in ('draft','posted','void')),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, contra_no),
  -- NaN is a numeric, is greater than every number and fits numeric(14,2).
  constraint finance_contras_amount_check check (amount > 0 and amount <> 'NaN'),
  constraint finance_contras_number_check check ((status = 'draft') = (contra_no is null)),
  constraint finance_contras_posted_check check ((status = 'draft') = (posted_at is null)),
  constraint finance_contras_reference_check check (reference is null or char_length(reference) <= 100),
  constraint finance_contras_notes_check check (notes is null or char_length(notes) <= 1000),
  foreign key (org_id, contact_id) references public.finance_contacts(org_id, id)
);
create index finance_contras_date_idx on public.finance_contras (org_id, contra_date);
create index finance_contras_contact_idx on public.finance_contras (org_id, contact_id);

-- One line per invoice or bill the contra entry sets off. A line has no
-- update: the save function deletes a draft's lines and writes them again.
create table public.finance_contra_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  contra_id uuid not null,
  invoice_id uuid,
  bill_id uuid,
  amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  constraint finance_contra_lines_one_document_check check (num_nonnulls(invoice_id, bill_id) = 1),
  constraint finance_contra_lines_amount_check check (amount > 0 and amount <> 'NaN'),
  constraint finance_contra_lines_invoice_key unique (contra_id, invoice_id),
  constraint finance_contra_lines_bill_key unique (contra_id, bill_id),
  foreign key (org_id, contra_id) references public.finance_contras(org_id, id) on delete cascade,
  foreign key (org_id, invoice_id) references public.finance_invoices(org_id, id),
  foreign key (org_id, bill_id) references public.supplier_bills(org_id, id)
);
create index finance_contra_lines_contra_idx on public.finance_contra_lines (org_id, contra_id);
create index finance_contra_lines_invoice_idx on public.finance_contra_lines (org_id, invoice_id) where invoice_id is not null;
create index finance_contra_lines_bill_idx on public.finance_contra_lines (org_id, bill_id) where bill_id is not null;

-- ---- who reads and writes ------------------------------------------------------------
-- Every member reads every contra entry, drafts included (decision D1). Only
-- an owner or admin writes.
alter table public.finance_contras enable row level security;
create policy finance_contras_select on public.finance_contras
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_contras_insert on public.finance_contras
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_contras_update on public.finance_contras
  for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
create policy finance_contras_delete on public.finance_contras
  for delete to authenticated using (private.finance_may_sign_off(org_id));
create policy mfa_required on public.finance_contras as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

alter table public.finance_contra_lines enable row level security;
create policy finance_contra_lines_select on public.finance_contra_lines
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_contra_lines_insert on public.finance_contra_lines
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_contra_lines_delete on public.finance_contra_lines
  for delete to authenticated using (private.finance_may_sign_off(org_id));
create policy mfa_required on public.finance_contra_lines as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

-- Column by column. Not writable by anyone signed in: contra_no, created_by,
-- posted_by, posted_at, voided_at, created_at (the guard and the stamp write
-- them). status is insertable by nobody (a new row is a draft by default) and
-- updatable so that the post and void functions, which run as the caller,
-- can move it; the guard decides which move is allowed. A line is never
-- updated.
revoke all on public.finance_contras from anon, authenticated, service_role;
revoke all on public.finance_contra_lines from anon, authenticated, service_role;
grant select, delete on public.finance_contras to authenticated;
grant insert (org_id, contact_id, contra_date, amount, reference, notes) on public.finance_contras to authenticated;
grant update (contact_id, contra_date, amount, reference, notes, status, updated_at) on public.finance_contras to authenticated;
grant select, delete on public.finance_contra_lines to authenticated;
grant insert (org_id, contra_id, invoice_id, bill_id, amount) on public.finance_contra_lines to authenticated;

-- ============================================================================
-- 2. Numbering: a contra entry takes a CT- number (REPLACES finance_next_number)
-- ============================================================================
-- The constraint as 20261108093000_bendahara_journals.sql left it, with
-- 'contra' added. No later migration on main changes it.
alter table public.finance_sequences
  drop constraint finance_sequences_doc_type_check,
  add constraint finance_sequences_doc_type_check
    check (doc_type in ('invoice','quotation','credit_note','bill','receipt','voucher','transfer','rfq','purchase_order','journal','contra'));

-- The body of 20261108093000_bendahara_journals.sql (lines 150 to 192), the
-- newest definition on main, with one line added: 'contra' gives 'CT-'.
-- Everything else is kept: language plpgsql, security definer (this is the
-- only writer of finance_sequences, which is closed to the authenticated
-- role), set search_path = '', the writer check first, and the revoke and
-- grant that file ends with.
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
    when 'journal' then 'JV-'
    when 'contra' then 'CT-'
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

-- ============================================================================
-- 3. Guards
-- ============================================================================
-- In the manner of the journal guards (20261108093000): each steps aside
-- when the workspace is being deleted and when nobody is signed in (a
-- migration, the SQL editor, the deletion of a user by supabase_auth_admin,
-- which has no rights on public), and on each change of status the old row is
-- copied and only that step's columns are set, so nothing rides along.
-- All run as the caller: an owner or admin, the only one the policies let
-- write, may read every table they read.

-- Is target_contact a contact of the workspace who is both a customer and a
-- supplier? Not found answers false; the foreign key would say the same.
create function private.finance_contra_contact_ok(target_org uuid, target_contact uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.finance_contacts c
    where c.org_id = target_org and c.id = target_contact and c.is_customer and c.is_supplier
  );
$$;
revoke all on function private.finance_contra_contact_ok(uuid, uuid) from public, anon, service_role;
grant execute on function private.finance_contra_contact_ok(uuid, uuid) to authenticated;

--   new               a draft, with no number, made by the person signed in,
--                     for a contact who is a customer and a supplier (FIN31)
--   draft  -> draft   contact, date, amount, reference and notes change
--   draft  -> posted  every rule of section 4 below, then the number, who
--                     posted and when are written here
--   posted -> void    nothing depends on it (FIN33); only status and
--                     updated_at move (voided_at by the stamp, after this)
--   anything else     FIN01; a posted or void one is not deleted
create function private.finance_contra_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  kept text;
  n_invoices integer;
  n_bills integer;
  invoice_side numeric;
  bill_side numeric;
  l record;
  pos record;
  held numeric;
  doc_total numeric;
  taken numeric;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a contra entry starts as a draft' using errcode = 'FIN01';
    end if;
    if me is not null then
      new.created_by := me;
    end if;
    new.contra_no := null;
    new.posted_by := null;
    new.posted_at := null;
    if me is not null and not private.finance_contra_contact_ok(new.org_id, new.contact_id) then
      raise exception 'a contra entry is for a contact who is both a customer and a supplier' using errcode = 'FIN31';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted contra entry cannot be deleted; void it' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if me is null or to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  -- A deleted user is cleared from created_by and posted_by by their foreign
  -- keys, whatever the status. That update is made by the foreign key's own
  -- trigger, one level down; a person's own update is not let through here.
  if pg_trigger_depth() > 1
     and (to_jsonb(new) - 'created_by' - 'posted_by') = (to_jsonb(old) - 'created_by' - 'posted_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.posted_by is null or new.posted_by = old.posted_by) then
    return new;
  end if;
  if new.org_id <> old.org_id or new.created_by is distinct from old.created_by then
    raise exception 'who wrote a contra entry, and its workspace, do not change' using errcode = 'FIN01';
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    if new.contact_id is distinct from old.contact_id
       and not private.finance_contra_contact_ok(new.org_id, new.contact_id) then
      raise exception 'a contra entry is for a contact who is both a customer and a supplier' using errcode = 'FIN31';
    end if;
    new.contra_no := null;
    new.posted_by := null;
    new.posted_at := null;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'posted' then
    -- ---- 4. what posting asks ------------------------------------------------------
    -- Asked of the row as it stands (old), never of what the caller sent.
    if not private.finance_contra_contact_ok(old.org_id, old.contact_id) then
      raise exception 'a contra entry is for a contact who is both a customer and a supplier' using errcode = 'FIN31';
    end if;
    select
      count(*) filter (where cl.invoice_id is not null),
      count(*) filter (where cl.bill_id is not null),
      coalesce(sum(cl.amount) filter (where cl.invoice_id is not null), 0),
      coalesce(sum(cl.amount) filter (where cl.bill_id is not null), 0)
      into n_invoices, n_bills, invoice_side, bill_side
    from public.finance_contra_lines cl
    where cl.org_id = old.org_id and cl.contra_id = old.id;
    if n_invoices = 0 or n_bills = 0 then
      raise exception 'a contra entry sets off at least one invoice against at least one bill' using errcode = 'FIN29';
    end if;
    if invoice_side <> old.amount or bill_side <> old.amount then
      raise exception 'the invoices and the bills set off must each add up to the contra entry''s amount' using errcode = 'FIN29';
    end if;

    -- Lock every invoice, then every bill, each in id order: two contra
    -- entries posted at the same moment take them in the same order, and a
    -- payment against one of them waits (the allocation guard takes the same
    -- row "for update"). No payment locks an invoice and a bill together
    -- (FIN06), so there is no other order to meet.
    perform 1 from public.finance_invoices i
    where i.org_id = old.org_id
      and i.id in (select cl.invoice_id from public.finance_contra_lines cl
                   where cl.org_id = old.org_id and cl.contra_id = old.id and cl.invoice_id is not null)
    order by i.id
    for update;
    perform 1 from public.supplier_bills b
    where b.org_id = old.org_id
      and b.id in (select cl.bill_id from public.finance_contra_lines cl
                   where cl.org_id = old.org_id and cl.contra_id = old.id and cl.bill_id is not null)
    order by b.id
    for update;

    for l in
      select cl.invoice_id, cl.amount, i.status, i.customer_id, i.invoice_no
      from public.finance_contra_lines cl
      left join public.finance_invoices i on i.org_id = cl.org_id and i.id = cl.invoice_id
      where cl.org_id = old.org_id and cl.contra_id = old.id and cl.invoice_id is not null
      order by cl.invoice_id
    loop
      if l.customer_id is distinct from old.contact_id then
        raise exception 'a contra entry sets off its own contact''s invoices and bills' using errcode = 'FIN31';
      end if;
      if l.status is distinct from 'posted' then
        raise exception 'a contra entry sets off posted invoices and bills only' using errcode = 'FIN04';
      end if;
      -- What the invoice still owes, less money in that is recorded and not
      -- yet posted: the same "balance" and the same holding the allocation
      -- guard uses for money in (20261028100000, lines 954 to 962).
      select balance into pos from public.finance_invoice_totals
      where org_id = old.org_id and id = l.invoice_id;
      if not found then
        raise exception 'a contra entry sets off posted invoices and bills only' using errcode = 'FIN04';
      end if;
      select coalesce(sum(a.amount), 0) into held
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = old.org_id and a.invoice_id = l.invoice_id
        and x.direction = 'in' and x.status in ('draft','pending_approval','scheduled');
      if l.amount > pos.balance - held then
        raise exception 'more than is still owed on invoice %', l.invoice_no using errcode = 'FIN05';
      end if;
    end loop;

    for l in
      select cl.bill_id, cl.amount, b.status, b.supplier_id, b.bill_no
      from public.finance_contra_lines cl
      left join public.supplier_bills b on b.org_id = cl.org_id and b.id = cl.bill_id
      where cl.org_id = old.org_id and cl.contra_id = old.id and cl.bill_id is not null
      order by cl.bill_id
    loop
      if l.supplier_id is distinct from old.contact_id then
        raise exception 'a contra entry sets off its own contact''s invoices and bills' using errcode = 'FIN31';
      end if;
      if l.status is distinct from 'posted' then
        raise exception 'a contra entry sets off posted invoices and bills only' using errcode = 'FIN04';
      end if;
      -- What the bill still owes, as the allocation guard counts it (every
      -- payment that is not rejected or void holds its part), less every
      -- other posted contra entry on it.
      select coalesce(sum(bl.amount + bl.sst_amount), 0) into doc_total
      from public.supplier_bill_lines bl where bl.org_id = old.org_id and bl.bill_id = l.bill_id;
      select coalesce(sum(a.amount), 0) into taken
      from public.finance_allocations a
      join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
      where a.org_id = old.org_id and a.bill_id = l.bill_id
        and x.status in ('draft','pending_approval','scheduled','posted');
      select taken + coalesce(sum(cl.amount), 0) into taken
      from public.finance_contra_lines cl
      join public.finance_contras k on k.org_id = cl.org_id and k.id = cl.contra_id
      where cl.org_id = old.org_id and cl.bill_id = l.bill_id and k.status = 'posted';
      if taken + l.amount > doc_total then
        raise exception 'more than is still owed on bill %', l.bill_no using errcode = 'FIN05';
      end if;
    end loop;

    -- The number is taken last, in the same transaction: a refused post does
    -- not use one up.
    kept := public.finance_next_number(old.org_id, 'contra');
    new := old;
    new.status := 'posted';
    new.contra_no := kept;
    new.posted_by := me;
    new.posted_at := now();
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'posted' and new.status = 'void' then
    -- Lock the invoices, so no refund is recorded against one while this is
    -- asked. The test is the credit note guard's (20261022100000, lines 544
    -- to 547): refunds against the invoice, paid and waiting, must still fit
    -- in what the customer would be in credit without this contra entry.
    perform 1 from public.finance_invoices i
    where i.org_id = old.org_id
      and i.id in (select cl.invoice_id from public.finance_contra_lines cl
                   where cl.org_id = old.org_id and cl.contra_id = old.id and cl.invoice_id is not null)
    order by i.id
    for update;
    for l in
      select cl.invoice_id, cl.amount, t.total, t.paid, t.credited, t.refunded, t.set_off, t.invoice_no
      from public.finance_contra_lines cl
      join public.finance_invoice_totals t on t.org_id = cl.org_id and t.id = cl.invoice_id
      where cl.org_id = old.org_id and cl.contra_id = old.id and cl.invoice_id is not null
      order by cl.invoice_id
    loop
      if l.refunded + private.finance_refunds_held(old.org_id, l.invoice_id, null)
         > greatest(l.paid + l.credited + l.set_off - l.amount - l.total, 0) then
        raise exception 'refunds on invoice % depend on this contra entry', l.invoice_no using errcode = 'FIN33';
      end if;
    end loop;
    new := old;
    new.status := 'void';
    new.updated_at := now();
    return new;
  end if;

  raise exception 'a posted contra entry cannot be changed; void it' using errcode = 'FIN01';
end $$;
revoke all on function private.finance_contra_guard() from public, anon, authenticated, service_role;

create trigger finance_contra_guard
  before insert or update or delete on public.finance_contras
  for each row execute function private.finance_contra_guard();

-- The existing stamp (20261111090000), not replaced: a contra entry that
-- becomes void is stamped with now(); on every other write voided_at stays
-- what it was. "finance_v" sorts after "finance_c", so the guard has
-- compared the row before this writes it.
create trigger finance_void_stamp
  before insert or update on public.finance_contras
  for each row execute function private.finance_void_stamp();

-- Lines change only while their contra entry is a draft. The contra entry's
-- row is locked (for share) while a line is written, so it cannot be posted
-- at the same moment a line is slipped in or taken out. A line's document
-- must be the contra entry's contact's own (FIN31); that it is posted, and
-- what it still owes, are asked when the contra entry is posted.
create function private.finance_contra_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k record;
  owner_contact uuid;
begin
  -- The workspace is being deleted: its contra entries and their lines all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into k from public.finance_contras
    where org_id = old.org_id and id = old.contra_id for share;
    -- No parent row: the contra entry itself is being deleted, and its lines go with it.
    if found and k.status <> 'draft' then
      raise exception 'the lines of a posted contra entry cannot be changed' using errcode = 'FIN01';
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;
  end if;

  select status, contact_id into k from public.finance_contras
  where org_id = new.org_id and id = new.contra_id for share;
  if not found then
    -- Not there, or not this caller's: the foreign key or row-level security refuses and says which.
    return new;
  end if;
  if k.status <> 'draft' then
    raise exception 'the lines of a posted contra entry cannot be changed' using errcode = 'FIN01';
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  if new.invoice_id is not null then
    select customer_id into owner_contact from public.finance_invoices
    where org_id = new.org_id and id = new.invoice_id;
  else
    select supplier_id into owner_contact from public.supplier_bills
    where org_id = new.org_id and id = new.bill_id;
  end if;
  -- A document that cannot be found is left for the foreign key to refuse.
  if found and owner_contact is distinct from k.contact_id then
    raise exception 'a contra entry sets off its own contact''s invoices and bills' using errcode = 'FIN31';
  end if;
  return new;
end $$;
revoke all on function private.finance_contra_line_guard() from public, anon, authenticated, service_role;

create trigger finance_contra_line_guard
  before insert or update or delete on public.finance_contra_lines
  for each row execute function private.finance_contra_line_guard();

-- ---- a bill's cap counts its contra entries -------------------------------------
-- private.finance_allocation_guard (20261028100000, lines 985 to 1001) caps a
-- payment on a bill by the bill's lines less every payment that holds part of
-- it. It does not know contra entries, and is not replaced. This runs after
-- it on the same row, with the bill already locked "for update" by it in the
-- same statement, and asks the same question with posted contra entries
-- added. Same code, same sentence. Not asked of a money-in or invoice row
-- (the WHEN clause), whose cap reads finance_invoice_totals.balance, which
-- now counts contra entries itself.
create function private.finance_allocation_contra_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  doc_total numeric;
  taken numeric;
  contra_taken numeric;
begin
  select coalesce(sum(cl.amount), 0) into contra_taken
  from public.finance_contra_lines cl
  join public.finance_contras k on k.org_id = cl.org_id and k.id = cl.contra_id
  where cl.org_id = new.org_id and cl.bill_id = new.bill_id and k.status = 'posted';
  if contra_taken = 0 then
    return new;
  end if;
  select coalesce(sum(amount + sst_amount), 0) into doc_total
  from public.supplier_bill_lines where org_id = new.org_id and bill_id = new.bill_id;
  select coalesce(sum(a.amount), 0) into taken
  from public.finance_allocations a
  join public.finance_transactions x on x.org_id = a.org_id and x.id = a.transaction_id
  where a.org_id = new.org_id and a.bill_id = new.bill_id and a.id <> new.id
    and x.status in ('draft','pending_approval','scheduled','posted');
  if taken + contra_taken + new.amount > doc_total then
    raise exception 'more than is still owed on the bill' using errcode = 'FIN05';
  end if;
  return new;
end $$;
revoke all on function private.finance_allocation_contra_cap() from public, anon, authenticated, service_role;

-- Fires after finance_allocation_guard ("l" > "g") and before
-- finance_allocation_still ("l" < "s"). Do not rename.
create trigger finance_allocation_less_contra
  before insert or update on public.finance_allocations
  for each row when (new.bill_id is not null)
  execute function private.finance_allocation_contra_cap();

-- ---- a document a posted contra entry sets off is not voided ----------------------
-- One function for invoices and bills. The WHEN clause keeps it to the one
-- move it is about, so the deletion of a user (which clears created_by on an
-- invoice) never calls it.
create function private.finance_document_void_contra()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.finance_contra_lines cl
    join public.finance_contras k on k.org_id = cl.org_id and k.id = cl.contra_id
    where cl.org_id = old.org_id and k.status = 'posted'
      and ((tg_table_name = 'finance_invoices' and cl.invoice_id = old.id)
        or (tg_table_name = 'supplier_bills' and cl.bill_id = old.id))
  ) then
    raise exception 'a contra entry sets this off; void the contra entry first' using errcode = 'FIN32';
  end if;
  return new;
end $$;
revoke all on function private.finance_document_void_contra() from public, anon, authenticated, service_role;

-- Each sorts after the table's own guard and its sign-off trigger
-- ("finance_invoice_v" > "finance_invoice_s", "finance_bill_v" >
-- "finance_bill_s") and before finance_void_stamp ("finance_i…" and
-- "finance_b…" < "finance_v…"): FIN01, FIN02, FIN12 and FIN14 answer first,
-- and the stamp still runs last. Do not rename.
create trigger finance_invoice_void_contra
  before update on public.finance_invoices
  for each row when (old.status = 'posted' and new.status = 'void')
  execute function private.finance_document_void_contra();
create trigger finance_bill_void_contra
  before update on public.supplier_bills
  for each row when (old.status = 'posted' and new.status = 'void')
  execute function private.finance_document_void_contra();

-- ============================================================================
-- 5. Functions
-- ============================================================================
-- All run as the caller, so row-level security and the guards decide. Each
-- begins by asking for an owner or admin, so anyone else gets one plain
-- answer (FIN14) instead of whichever policy they met first.

-- Creates a draft contra entry, or replaces a draft's header and lines, and
-- returns its id. contra has id (to change one), contact_id, contra_date,
-- amount, reference and notes; each line has invoice_id or bill_id, and
-- amount. A draft may be saved unfinished (sides that do not add up yet);
-- posting is where that is asked. An amount that is not a number above zero
-- is refused here by name, before any row is written.
create function public.finance_save_contra(target_org uuid, contra jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cid uuid;
  amt numeric;
  n integer;
begin
  -- Asked before anything the caller sent is read, so a member gets FIN14
  -- whatever the payload.
  if not private.finance_may_sign_off(target_org) then
    raise exception 'a contra entry is written by an owner or admin' using errcode = 'FIN14';
  end if;
  cid := nullif(contra->>'id', '')::uuid;
  amt := round((contra->>'amount')::numeric, 2);
  if jsonb_typeof(lines) is distinct from 'array' then
    raise exception 'a contra entry needs its invoices and bills as a list' using errcode = 'FIN29';
  end if;
  if amt is null or amt = 'NaN' or amt <= 0 then
    raise exception 'a contra entry needs an amount above zero' using errcode = 'FIN29';
  end if;
  if exists (
    select 1 from jsonb_array_elements(lines) e
    where round((e->>'amount')::numeric, 2) is null
       or round((e->>'amount')::numeric, 2) = 'NaN'
       or round((e->>'amount')::numeric, 2) <= 0
  ) then
    raise exception 'every invoice and bill set off needs an amount above zero' using errcode = 'FIN29';
  end if;

  if cid is null then
    insert into public.finance_contras (org_id, contact_id, contra_date, amount, reference, notes)
    values (
      target_org,
      (contra->>'contact_id')::uuid,
      coalesce((contra->>'contra_date')::date, current_date),
      amt,
      nullif(btrim(coalesce(contra->>'reference', '')), ''),
      nullif(btrim(coalesce(contra->>'notes', '')), '')
    )
    returning id into cid;
  else
    update public.finance_contras
       set contact_id = (contra->>'contact_id')::uuid,
           contra_date = coalesce((contra->>'contra_date')::date, current_date),
           amount = amt,
           reference = nullif(btrim(coalesce(contra->>'reference', '')), ''),
           notes = nullif(btrim(coalesce(contra->>'notes', '')), ''),
           updated_at = now()
     where org_id = target_org and id = cid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the contra entry no longer exists' using errcode = 'FIN11';
    end if;
    -- On a posted one the guard has already answered FIN01 above.
    delete from public.finance_contra_lines where org_id = target_org and contra_id = cid;
  end if;

  insert into public.finance_contra_lines (org_id, contra_id, invoice_id, bill_id, amount)
  select
    target_org, cid,
    nullif(e->>'invoice_id', '')::uuid,
    nullif(e->>'bill_id', '')::uuid,
    round((e->>'amount')::numeric, 2)
  from jsonb_array_elements(lines) e;

  return cid;
end $$;

-- Posts a draft contra entry and returns its number. Every rule is the
-- guard's (section 4); the number is taken there, in this transaction.
create function public.finance_post_contra(target_org uuid, target_contra uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  k record;
  no text;
begin
  if not private.finance_may_sign_off(target_org) then
    raise exception 'a contra entry is posted by an owner or admin' using errcode = 'FIN14';
  end if;
  select status into k from public.finance_contras
  where org_id = target_org and id = target_contra for update;
  if not found then
    raise exception 'the contra entry no longer exists' using errcode = 'FIN11';
  end if;
  if k.status <> 'draft' then
    raise exception 'the contra entry is already posted' using errcode = 'FIN01';
  end if;
  update public.finance_contras
     set status = 'posted', updated_at = now()
   where org_id = target_org and id = target_contra
  returning contra_no into no;
  return no;
end $$;

-- Voids a posted contra entry. The ledger reverses it on the day it was
-- voided (finance_ledger_lines, below); its invoices and bills owe again
-- what it had set off.
create function public.finance_void_contra(target_org uuid, target_contra uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  k record;
begin
  if not private.finance_may_sign_off(target_org) then
    raise exception 'a contra entry is voided by an owner or admin' using errcode = 'FIN14';
  end if;
  select status into k from public.finance_contras
  where org_id = target_org and id = target_contra for update;
  if not found then
    raise exception 'the contra entry no longer exists' using errcode = 'FIN11';
  end if;
  if k.status <> 'posted' then
    raise exception 'only a posted contra entry is voided' using errcode = 'FIN01';
  end if;
  update public.finance_contras
     set status = 'void', updated_at = now()
   where org_id = target_org and id = target_contra;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_contra(uuid, jsonb, jsonb)',
    'public.finance_post_contra(uuid, uuid)',
    'public.finance_void_contra(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- 6. What a document still owes, and the ledger (three views REPLACED)
-- ============================================================================

-- ---- finance_invoice_totals (REPLACED) --------------------------------------------
-- The text of 20261022100000_bendahara_sales_followons.sql lines 167 to 240,
-- the newest definition on main, with four changes and nothing else:
--   a. a lateral "sc" sums posted contra lines on the invoice;
--   b. v gains set_off, and balance subtracts it (so display_status, which
--      reads v.balance, follows);
--   c. set_off is appended as the last column;
--   d. paid, credited and refunded are untouched: paid stays money in only.
-- The allocation guard reads balance from this view for money in and for
-- refunds, and the credit note guard reads total, paid, credited and
-- refunded; neither is replaced. Same columns in the same order before
-- set_off, so "create or replace" keeps the view, its grants and every
-- reader. Runs as whoever reads it, as before.
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
  v.refunded::numeric(14,2) as refunded,
  v.set_off::numeric(14,2) as set_off
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
left join lateral (
  -- Posted contra entries against the invoice: settled with no money moving.
  select sum(cl.amount) as set_off
  from public.finance_contra_lines cl
  join public.finance_contras ce on ce.org_id = cl.org_id and ce.id = cl.contra_id
  where cl.org_id = i.org_id and cl.invoice_id = i.id and ce.status = 'posted'
) sc on true
cross join lateral (
  select
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) as total,
    coalesce(p.paid, 0) as paid,
    coalesce(k.credited, 0) as credited,
    coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0) as refunded,
    coalesce(sc.set_off, 0) as set_off,
    coalesce(l.subtotal, 0) + coalesce(l.sst, 0) - coalesce(p.paid, 0) - coalesce(k.credited, 0)
      + coalesce(ri.refunded, 0) + coalesce(rn.refunded, 0)
      - coalesce(sc.set_off, 0) as balance
) v;
revoke all on public.finance_invoice_totals from anon, authenticated, service_role;
grant select on public.finance_invoice_totals to authenticated;

-- ---- supplier_bill_totals (REPLACED) ---------------------------------------------
-- The text of 20261013100000_bendahara_money.sql lines 149 to 176, with
-- three changes:
--   a. "b.*" is written out as the twelve columns it stood for when the view
--      was made (supplier_bills had no purchase_order_id, category_id or
--      voided_at then; 20261108091500 says the view does not carry
--      category_id). Same names, same order, same types. If this list were
--      wrong, "create or replace view" would stop the migration.
--   b. A lateral sums posted contra lines on the bill; balance and therefore
--      display_status subtract it. paid stays money out only.
--   c. set_off is appended as the last column.
-- Runs as whoever reads it (security_invoker), as before.
create or replace view public.supplier_bill_totals with (security_invoker = true) as
select
  b.id,
  b.org_id,
  b.bill_no,
  b.supplier_ref,
  b.supplier_id,
  b.bill_date,
  b.due_date,
  b.status,
  b.notes,
  b.created_at,
  b.updated_at,
  b.posted_at,
  c.name as supplier_name,
  coalesce(l.total, 0)::numeric(14,2) as total,
  coalesce(p.paid, 0)::numeric(14,2) as paid,
  (coalesce(l.total, 0) - coalesce(p.paid, 0) - coalesce(sc.set_off, 0))::numeric(14,2) as balance,
  case
    when b.status in ('draft','void') then b.status
    -- A posted bill with no lines yet has nothing to pay; it is not Paid.
    when coalesce(l.total, 0) > 0 and coalesce(l.total, 0) - coalesce(p.paid, 0) - coalesce(sc.set_off, 0) <= 0 then 'paid'
    when b.due_date < current_date then 'overdue'
    else 'pending'
  end as display_status,
  coalesce(sc.set_off, 0)::numeric(14,2) as set_off
from public.supplier_bills b
join public.finance_contacts c on c.org_id = b.org_id and c.id = b.supplier_id
left join lateral (
  select sum(amount + sst_amount) as total
  from public.supplier_bill_lines
  where org_id = b.org_id and bill_id = b.id
) l on true
left join lateral (
  -- Only posted money out counts as paid.
  select sum(a.amount) as paid
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = b.org_id and a.bill_id = b.id and t.direction = 'out' and t.status = 'posted'
) p on true
left join lateral (
  -- Posted contra entries against the bill: settled with no money moving.
  select sum(cl.amount) as set_off
  from public.finance_contra_lines cl
  join public.finance_contras ce on ce.org_id = cl.org_id and ce.id = cl.contra_id
  where cl.org_id = b.org_id and cl.bill_id = b.id and ce.status = 'posted'
) sc on true;
-- "create or replace" keeps the grants it had; said again so this file can
-- be read alone. service_role as 20261116110000 left it: nothing.
revoke all on public.supplier_bill_totals from anon, authenticated, service_role;
grant select on public.supplier_bill_totals to authenticated;

-- ---- finance_ledger_lines (REPLACED) -----------------------------------------------
-- The text of 20261111090000_bendahara_ledger_voids_and_accruals.sql lines
-- 438 to 780, the newest definition on main, with one branch added before
-- the manual journals: a contra entry (source 'contra'). Nothing else
-- changes. The same ten columns with the same types, so "create or replace"
-- keeps the view, its grants and finance_ledger_balances, which reads it.
-- Every comment of that text stands as it was, and is read with it.
create or replace view public.finance_ledger_lines with (security_invoker = true) as
select
  l.org_id,
  l.entry_key || case when r.reversal then ':void' else '' end as entry_key,
  case when r.reversal then l.voided_on else l.entry_date end as entry_date,
  l.source,
  l.source_id,
  l.source_no,
  case when r.reversal then 'Voided: ' || l.description else l.description end as description,
  coalesce(l.acct, s.id, b.id, c.id, d.id) as account_id,
  (case when r.reversal then l.credit else l.debit end)::numeric(14,2) as debit,
  (case when r.reversal then l.debit else l.credit end)::numeric(14,2) as credit
from (
  -- ---- invoice: posted, or voided after it was posted -------------------------------
  -- Mirrors finance_invoice_totals: subtotal is sum(amount), sst is
  -- sum(sst_amount), total is the two added. Every invoice credits the one
  -- account marked default_for = 'sales'.
  select
    i.org_id,
    'invoice:' || i.id::text as entry_key,
    i.invoice_date as entry_date,
    'invoice'::text as source,
    i.id as source_id,
    i.invoice_no as source_no,
    concat_ws(' ', 'Invoice', i.invoice_no, 'to ' || ct.name) as description,
    case when i.status = 'void' then (i.voided_at at time zone 'UTC')::date end as voided_on,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_invoices i
  left join public.finance_contacts ct on ct.org_id = i.org_id and ct.id = i.customer_id
  cross join lateral (
    select coalesce(sum(il.amount), 0) as subtotal, coalesce(sum(il.sst_amount), 0) as sst
    from public.finance_invoice_lines il
    where il.org_id = i.org_id and il.invoice_id = i.id
  ) t
  cross join lateral (values
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, (t.subtotal + t.sst)::numeric, 0::numeric),
    (null::uuid, null::text, null::uuid, null::uuid, 'sales'::text, 0::numeric, t.subtotal::numeric),
    (null::uuid, 'sst_payable'::text, null::uuid, null::uuid, null::text, 0::numeric, t.sst::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where i.status = 'posted' or (i.status = 'void' and i.voided_at is not null)

  union all

  -- ---- credit note: issued, or voided after it was issued ----------------------------
  -- Mirrors finance_invoice_totals, which takes only issued credit notes off
  -- what an invoice owes. A credit note is one amount, not lines, so its SST
  -- is the invoice's SST in proportion: amount * invoice SST / invoice total,
  -- rounded to the sen. The Sales line is the amount less that share, found
  -- by subtraction, so the two debits add back to the amount exactly whatever
  -- the rounding did. The share is never more than the amount (an invoice's
  -- SST is never more than its total); least() says so again. The invoice's
  -- lines are there, unchanged, whether the invoice is posted or has since
  -- been voided, so a voided credit note's two entries are the same numbers.
  select
    n.org_id,
    'credit_note:' || n.id::text,
    n.credit_date,
    'credit_note'::text,
    n.id,
    n.credit_note_no,
    concat_ws(' ', 'Credit note', n.credit_note_no, 'on ' || i.invoice_no),
    case when n.status = 'void' then (n.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_credit_notes n
  left join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
  cross join lateral (
    select
      coalesce(sum(il.amount), 0) + coalesce(sum(il.sst_amount), 0) as total,
      coalesce(sum(il.sst_amount), 0) as sst
    from public.finance_invoice_lines il
    where il.org_id = n.org_id and il.invoice_id = n.invoice_id
  ) t
  cross join lateral (
    select least(coalesce(round(n.amount * t.sst / nullif(t.total, 0), 2), 0), n.amount) as sst_share
  ) sh
  cross join lateral (values
    (null::uuid, null::text, null::uuid, null::uuid, 'sales'::text, (n.amount - sh.sst_share)::numeric, 0::numeric),
    (null::uuid, 'sst_payable'::text, null::uuid, null::uuid, null::text, sh.sst_share::numeric, 0::numeric),
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, n.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where n.status = 'issued' or (n.status = 'void' and n.voided_at is not null)

  union all

  -- ---- money in and money out: posted, or voided after it was posted; not a side of a transfer
  -- 'posted' is the one status that means the money has moved: it is what
  -- supplier_bill_totals, finance_invoice_totals, finance_expense_totals and
  -- finance_account_balances count. Drafts, payments waiting for approval,
  -- scheduled and rejected ones are out, and stay out when they are deleted.
  -- A void payment is in twice, once each way (see the top of this view).
  --
  -- What it is follows finance_cash_receipts and finance_payment_vouchers:
  --   money in                          source 'payment_in'
  --   money out against invoices or
  --     credit notes (finance_refunds)  source 'refund'
  --   every other money out             source 'payment_out'
  --
  -- The bank or cash account takes the whole amount on one side.
  --
  -- Money in, and a refund: the other side is at most two lines, as before.
  --   * to_category, on the payment's own category: the part of the payment
  --     that settles no document, when the payment has a category.
  --   * the rest, on Accounts Receivable.
  --
  -- Money out that is not a refund: the other side is at most three lines,
  -- by what the money settles.
  --   * to_category, as above: a payment voucher for a category has no split,
  --     so this is its whole amount.
  --   * to_expenses, on Accrued Expenses: what its split gives to expenses,
  --     which is what finance_expense_totals counts as paid.
  --   * the rest, on Accounts Payable: what its split gives to supplier
  --     bills, which is what supplier_bill_totals counts as paid, and any
  --     part that settles nothing on a payment with no category, as money
  --     paid on account, since there is no other account it could honestly
  --     go to.
  -- The three are to_category, to_expenses and the amount less both, so they
  -- add to the bank line by construction. to_expenses is held to no more
  -- than the amount less to_category, so the third is never below zero and
  -- never drops out as a line with no amount: the entry balances whatever
  -- the split is.
  --
  -- One payment pays one kind of document (FIN06 in
  -- private.finance_allocation_guard) and its split is never more than its
  -- amount (FIN03), so in practice a payment for expenses is one line on
  -- Accrued Expenses, a payment for bills one line on Accounts Payable, and
  -- to_expenses is exactly the sum of its expense allocations. The parts are
  -- still summed per kind from the split, not taken from "what kind is
  -- this", so a payment written by hand against both would post each part
  -- to its own account.
  --
  -- The functions the app records money with never make a payment that both
  -- settles documents and carries a category (FIN15 in
  -- finance_save_cash_receipt, finance_post_cash_receipt and
  -- finance_record_voucher), and they make its amount exactly its split. No
  -- table constraint says either, though: the guards only hold the split to
  -- no more than the amount, and call the part above it "money out that
  -- settles no document" (20261028100000, items 7 to 10). So a payment
  -- written by hand can be above its split, and its category then takes the
  -- part above the split, as that guard's wording has it.
  select
    t.org_id,
    p.source || ':' || t.id::text,
    t.txn_date,
    p.source,
    t.id,
    t.number,
    concat_ws(' ',
      case p.source when 'payment_in' then 'Receipt' when 'refund' then 'Refund' else 'Payment' end,
      t.number,
      case when t.direction = 'in' then 'from ' else 'to ' end || coalesce(ct.name, t.party_name)),
    case when t.status = 'void' then (t.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_transactions t
  left join public.finance_contacts ct on ct.org_id = t.org_id and ct.id = t.contact_id
  cross join lateral (
    select
      coalesce(sum(a.amount), 0) as allocated,
      coalesce(sum(a.amount) filter (where a.expense_id is not null), 0) as expenses,
      count(a.invoice_id) + count(a.credit_note_id) as sales_documents
    from public.finance_allocations a
    where a.org_id = t.org_id and a.transaction_id = t.id
  ) k
  cross join lateral (
    select
      case
        when t.direction = 'in' then 'payment_in'
        when k.sales_documents > 0 then 'refund'
        else 'payment_out'
      end as source,
      case when t.category_id is not null then greatest(t.amount - k.allocated, 0) else 0 end as to_category
  ) p
  cross join lateral (
    -- Only money out that is not a refund has a part for expenses.
    select
      case when p.source = 'payment_out' then least(k.expenses, t.amount - p.to_category) else 0 end as to_expenses
  ) q
  cross join lateral (values
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then t.amount else 0 end)::numeric,
      (case when t.direction = 'out' then t.amount else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out' then t.amount - p.to_category - q.to_expenses else 0 end)::numeric,
      (case when t.direction = 'in' then t.amount - p.to_category else 0 end)::numeric),
    (null::uuid, 'accrued_expenses'::text, null::uuid, null::uuid, null::text,
      q.to_expenses::numeric,
      0::numeric),
    (null::uuid, null::text, null::uuid, t.category_id, null::text,
      (case when t.direction = 'out' then p.to_category else 0 end)::numeric,
      (case when t.direction = 'in' then p.to_category else 0 end)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where t.transfer_id is null
    and (t.status = 'posted' or (t.status = 'void' and t.voided_at is not null and t.number is not null))

  union all

  -- ---- supplier bill: posted, or voided after it was posted --------------------------
  -- Mirrors supplier_bill_totals: total is sum(amount + sst_amount). SST on a
  -- purchase is part of the cost, so the whole total goes to the bill's
  -- category. category_id is read from the table: that view's columns were
  -- fixed before the column existed.
  select
    sb.org_id,
    'bill:' || sb.id::text,
    sb.bill_date,
    'bill'::text,
    sb.id,
    sb.bill_no,
    concat_ws(' ', 'Bill', sb.bill_no, 'from ' || ct.name),
    case when sb.status = 'void' then (sb.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.supplier_bills sb
  left join public.finance_contacts ct on ct.org_id = sb.org_id and ct.id = sb.supplier_id
  cross join lateral (
    select coalesce(sum(bl.amount + bl.sst_amount), 0) as total
    from public.supplier_bill_lines bl
    where bl.org_id = sb.org_id and bl.bill_id = sb.id
  ) t
  cross join lateral (values
    (null::uuid, null::text, null::uuid, sb.category_id, null::text, t.total::numeric, 0::numeric),
    (null::uuid, 'payable'::text, null::uuid, null::uuid, null::text, 0::numeric, t.total::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where sb.status = 'posted' or (sb.status = 'void' and sb.voided_at is not null)

  union all

  -- ---- expense: approved -------------------------------------------------------------
  -- Mirrors finance_expense_totals: an expense counts once approved (it then
  -- reads 'approved' or 'paid'); pending and rejected ones are out. amount is
  -- what is to be paid, SST included, and all of it is the cost. It is owed
  -- on Accrued Expenses, not Accounts Payable; paying it is a payment out
  -- against it, above, which takes it off Accrued Expenses. An expense has no
  -- void, so it is never reversed.
  select
    e.org_id,
    'expense:' || e.id::text,
    e.expense_date,
    'expense'::text,
    e.id,
    null::text,
    concat_ws(' ', 'Expense', 'to ' || coalesce(ct.name, e.vendor_name)),
    null::date,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_expenses e
  left join public.finance_contacts ct on ct.org_id = e.org_id and ct.id = e.vendor_id
  cross join lateral (values
    (null::uuid, null::text, null::uuid, e.category_id, null::text, e.amount::numeric, 0::numeric),
    (null::uuid, 'accrued_expenses'::text, null::uuid, null::uuid, null::text, 0::numeric, e.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where e.status = 'approved'

  union all

  -- ---- transfer between accounts: both sides posted, or both voided after that -----
  -- Two finance_transactions rows that share a transfer_id, money out of one
  -- account and money in to another (20261031090000;
  -- finance_bank_transactions calls both 'transfer'). One entry, read from
  -- the paying side: its date, its number and its amount on both lines, and,
  -- when the transfer has been voided, its voided_at, so a voided transfer
  -- is one reversal as it was one entry.
  -- private.finance_transfer_pair_check holds the two sides to the same
  -- amount, date, number and status, and one UPDATE voids both, so the
  -- receiving side would say the same; taking one amount for both lines is
  -- what makes this balance without leaning on that.
  select
    o.org_id,
    'transfer:' || o.transfer_id::text,
    o.txn_date,
    'transfer'::text,
    o.transfer_id,
    o.number,
    concat_ws(' ', 'Transfer', o.number, 'from ' || fa.name, 'to ' || ta.name),
    case when o.status = 'void' then (o.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_transactions o
  join public.finance_transactions i
    on i.org_id = o.org_id and i.transfer_id = o.transfer_id and i.direction = 'in'
  left join public.finance_accounts fa on fa.org_id = o.org_id and fa.id = o.account_id
  left join public.finance_accounts ta on ta.org_id = i.org_id and ta.id = i.account_id
  cross join lateral (values
    (null::uuid, null::text, i.account_id, null::uuid, null::text, o.amount::numeric, 0::numeric),
    (null::uuid, null::text, o.account_id, null::uuid, null::text, 0::numeric, o.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where o.transfer_id is not null and o.direction = 'out'
    and ((o.status = 'posted' and i.status = 'posted')
         or (o.status = 'void' and i.status = 'void' and o.voided_at is not null and o.number is not null))

  union all

  -- ---- opening balance of a bank or cash account: not zero ---------------------------
  -- Mirrors finance_account_balances, which adds opening_balance to every
  -- account's balance, archived ones included. A positive balance is money
  -- the business had: debit the account, credit Opening Balance Equity. A
  -- negative one (an overdraft) is the other way round.
  select
    a.org_id,
    'opening:' || a.id::text,
    a.opening_date,
    'opening'::text,
    a.id,
    null::text,
    'Opening balance of ' || a.name,
    null::date,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_accounts a
  cross join lateral (values
    (null::uuid, null::text, a.id, null::uuid, null::text,
      greatest(a.opening_balance, 0)::numeric, greatest(-a.opening_balance, 0)::numeric),
    (null::uuid, 'opening_equity'::text, null::uuid, null::uuid, null::text,
      greatest(-a.opening_balance, 0)::numeric, greatest(a.opening_balance, 0)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where a.opening_balance <> 0 and a.opening_balance <> 'NaN'

  union all

  -- ---- contra entry: posted, or voided after it was posted ---------------------------
  -- 20261119100000. A contra entry sets off what a contact owes on invoices
  -- against what is owed to them on bills, with no money moving: Accounts
  -- Payable goes down (debit) and Accounts Receivable goes down (credit) by
  -- the same amount. Mirrors finance_invoice_totals and supplier_bill_totals,
  -- which take posted contra lines off each document's balance; the guard on
  -- contra entries posts one only when its invoice lines and its bill lines
  -- each add up to its amount, so the entry's one amount is what both views
  -- took off. No line names a bank or cash account, so the Cash Flow and
  -- every bank balance are untouched. A voided one is reversed on the day it
  -- was voided by the outer query, as every other void.
  select
    k.org_id,
    'contra:' || k.id::text,
    k.contra_date,
    'contra'::text,
    k.id,
    k.contra_no,
    concat_ws(' ', 'Contra', k.contra_no, 'with ' || ct.name),
    case when k.status = 'void' then (k.voided_at at time zone 'UTC')::date end,
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_contras k
  left join public.finance_contacts ct on ct.org_id = k.org_id and ct.id = k.contact_id
  cross join lateral (values
    (null::uuid, 'payable'::text, null::uuid, null::uuid, null::text, k.amount::numeric, 0::numeric),
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, k.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where k.status = 'posted' or (k.status = 'void' and k.voided_at is not null)

  union all

  -- ---- manual journal: posted ---------------------------------------------------------
  -- As entered. The guard on journals refused to post it unless its debits
  -- equalled its credits, and a posted journal's lines cannot change. A
  -- journal has no void: it is reversed by a second journal, which is an
  -- entry of its own here.
  select
    jl.org_id,
    'journal:' || j.id::text,
    j.journal_date,
    'journal'::text,
    j.id,
    j.journal_no,
    j.description,
    null::date,
    jl.account_id, null::text, null::uuid, null::uuid, null::text, jl.debit::numeric, jl.credit::numeric
  from public.finance_journal_lines jl
  join public.finance_journals j on j.org_id = jl.org_id and j.id = jl.journal_id
  where j.status = 'posted'
) l(org_id, entry_key, entry_date, source, source_id, source_no, description, voided_on,
    acct, sys, bank, cat, dflt, debit, credit)
-- Each line once as it is, and once more, sides swapped, if its document was voided.
cross join lateral (values (false), (true)) as r(reversal)
left join public.finance_ledger_accounts s on s.org_id = l.org_id and s.system_key = l.sys
left join public.finance_ledger_accounts b on b.org_id = l.org_id and b.bank_account_id = l.bank
left join public.finance_ledger_accounts c on c.org_id = l.org_id and c.category_id = l.cat
left join public.finance_ledger_accounts d on d.org_id = l.org_id and d.default_for = l.dflt
where (not r.reversal or l.voided_on is not null)
  -- A line with no amount is left out: an invoice with no SST has no SST line.
  and (l.debit > 0 or l.credit > 0);

-- "create or replace" keeps the grants; said again so this file can be read alone.
revoke all on public.finance_ledger_lines from anon, authenticated, service_role;
grant select on public.finance_ledger_lines to authenticated;

-- ============================================================================
-- 7. Nothing is out of place
-- ============================================================================
-- Stops the migration, and everything rolls back, if a trigger is not where
-- the design needs it, numbering is no longer definer, a view lost or moved a
-- column, or service_role holds anything on the new relations.
do $$
declare
  t text;
begin
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and not tgisinternal;
  if t is distinct from 'finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    raise exception 'triggers on finance_allocations are: %', t;
  end if;

  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_invoices'::regclass and not tgisinternal;
  if t is distinct from 'finance_invoice_guard,finance_invoice_sign_off,finance_invoice_void_contra,finance_void_stamp' then
    raise exception 'triggers on finance_invoices are: %', t;
  end if;

  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.supplier_bills'::regclass and not tgisinternal;
  if t is distinct from 'finance_bill_category,finance_bill_guard,finance_bill_po_link,finance_bill_sign_off,finance_bill_void_contra,finance_void_stamp' then
    raise exception 'triggers on supplier_bills are: %', t;
  end if;

  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_contras'::regclass and not tgisinternal;
  if t is distinct from 'finance_contra_guard,finance_void_stamp' then
    raise exception 'triggers on finance_contras are: %', t;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = 'public.finance_next_number(uuid, text)'::regprocedure
      and p.prosecdef and 'search_path=""' = any(p.proconfig)
  ) then
    raise exception 'finance_next_number is no longer security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.finance_next_number(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.finance_next_number(uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_next_number(uuid, text)', 'execute') then
    raise exception 'finance_next_number grants changed';
  end if;

  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,'
       || 'display_status,credited,refunded,set_off' then
    raise exception 'finance_invoice_totals columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.supplier_bill_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,bill_no,supplier_ref,supplier_id,bill_date,due_date,status,notes,created_at,'
       || 'updated_at,posted_at,supplier_name,total,paid,balance,display_status,set_off' then
    raise exception 'supplier_bill_totals columns are: %', t;
  end if;

  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_contras', 'finance_contra_lines', 'finance_invoice_totals', 'supplier_bill_totals', 'finance_ledger_lines')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
end $$;
