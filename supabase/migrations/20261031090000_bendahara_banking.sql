-- Bendahara banking, database half (additive; safe to apply while the
-- previous code is still deployed).
--   * A transfer between two accounts: two finance_transactions rows, money
--     out of one account and money in to the other, paired by transfer_id and
--     numbered TR- from a counter of their own.
--   * finance_statement_imports and finance_statement_lines: what a bank
--     statement said, one row per line. A line matched to a posted movement
--     of money makes that movement reconciled.
--   * Views: finance_account_balances (one row per account, with its balance)
--     and finance_bank_transactions (every movement of money, one row each,
--     transfers included, with what it is and whether it is reconciled).
--   * Functions that record and void a transfer and import a statement.
--
-- No guard that was live is replaced. private.finance_transaction_guard and
-- private.finance_allocation_guard run as they did, first, and answer every
-- write the deployed code makes exactly as before. What this migration adds
-- to tables the deployed code writes:
--   1. finance_next_number is replaced: one more document type, 'transfer'
--      (TR-). Every other line of it is the text that was live.
--   2. The unique index on a payment's number is rebuilt as two. A row with no
--      transfer_id keeps the rule it had: its number is unique in the
--      workspace. The two sides of one transfer carry the same number, so for
--      rows with a transfer_id it is unique per direction.
--   3. Five triggers on finance_transactions, none of which does anything for
--      a row with no transfer_id that is not being voided:
--        finance_transfer_id_guard     before update, row, only when
--                                      transfer_id changes: refused (FIN16).
--        finance_transfer_pair_insert, finance_transfer_pair_update,
--        finance_transfer_pair_delete  after the statement: every transfer the
--                                      statement touched is still two
--                                      matching sides, or gone (FIN16).
--        finance_transaction_unmatch   after update, row, only when a payment
--                                      becomes void: a statement line matched
--                                      to it is unmatched.
--      No deployed code sets transfer_id and no statement line exists, so for
--      every deployed write the first is not called, the next three find
--      nothing to check, and the last updates no row.
--   4. Two check constraints on finance_transactions. An amount that is not a
--      number ('NaN') is refused (23514). This one changes an answer for the
--      deployed code: a NaN amount was accepted before, by a direct call to
--      any function that records a payment, and then stood in every sum. No
--      form sends one. And a payment with a transfer_id carries a number only
--      once it is posted or void (23514), so a hidden draft cannot sit on the
--      next TR- number; no deployed write sets transfer_id.
--
-- The whole migration runs with finance_transactions and finance_sequences
-- locked, both taken at once and without waiting. The app's functions take
-- the two in both orders (a payment is locked and then numbered; a credit
-- note is numbered and then reads the payments), so no order of waiting is
-- free of a deadlock. If anything holds either table the migration stops at
-- once with nothing applied, and is run again.
--
-- A transfer and approval. The guard on payments (20261028100000) asks for
-- an owner or admin when money out is scheduled or posted for more than its
-- split. The side of a transfer that leaves an account is money out with no
-- split, so that rule already holds it: only an owner or admin can post a
-- transfer, and the guard writes them down as approving it. Nothing here
-- loosens that. A bank charge is money out for an expense category and is
-- recorded by finance_record_voucher under the same rule; interest received
-- is money in for an income category and needs no approval. A statement line
-- is something a person imported, so a match to one approves nothing.
--
-- What a direct write can no longer do, where it could (nothing deployed did):
--   a. Set, change or clear transfer_id on an existing payment (FIN16).
--   b. Post, schedule or void a payment with a transfer_id unless it ends as
--      one of two matching sides: both of the workspace, one in and one out,
--      different accounts, the same amount, date, status and number, no
--      contact, typed name or category, no split, and both posted or both
--      void (FIN16). So half a transfer cannot be posted or voided by
--      itself. Sides that are all still drafts are not looked at: a draft
--      moves no money.
--   c. Give two payments that share a transfer_id the same direction (23505).
--   d. Store NaN as a payment's amount, or give a draft side of a transfer a
--      number (23514, both from item 4 above).
-- And one thing a direct write can now do where it could not: a row of type
-- 'transfer' in finance_sequences (it was 23514), as for every other type.
--
-- Nothing here is granted to service_role: every write is made by a signed-in
-- person through the authenticated role, and no worker touches these tables.
-- Execute on every function here is revoked from service_role by name, since
-- a hosted project's default privileges may have granted it.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';
-- Both at once, or not at all: see the header.
lock table public.finance_transactions, public.finance_sequences in access exclusive mode nowait;

-- ---- numbering: a transfer takes a TR- number -------------------------------
alter table public.finance_sequences
  drop constraint finance_sequences_doc_type_check,
  add constraint finance_sequences_doc_type_check
    check (doc_type in ('invoice','quotation','credit_note','bill','receipt','voucher','transfer'));

-- The text that was live (20261012170000), with one line added: 'transfer'.
create or replace function public.finance_next_number(target_org uuid, doc text)
returns text
language plpgsql
security invoker
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

-- A payment's number is unique in its workspace, as it was. The two sides of
-- a transfer share one number, so among them it is unique per direction.
drop index public.finance_transactions_number_key;
create unique index finance_transactions_number_key
  on public.finance_transactions (org_id, number)
  where number is not null and transfer_id is null;
create unique index finance_transactions_transfer_number_key
  on public.finance_transactions (org_id, number, direction)
  where number is not null and transfer_id is not null;
-- A transfer has at most one side in each direction.
create unique index finance_transactions_transfer_key
  on public.finance_transactions (org_id, transfer_id, direction)
  where transfer_id is not null;

-- In Postgres NaN is a numeric, is greater than every number and fits
-- numeric(14,2), so "amount > 0" lets it through, and one such row turns
-- every balance it is added into to NaN. The table is small and already
-- locked, so the constraint is added and validated in one step.
alter table public.finance_transactions
  add constraint finance_transactions_amount_number_check check (amount <> 'NaN'),
  -- A side of a transfer takes its number when it is posted, not before.
  add constraint finance_transactions_transfer_number_check
    check (transfer_id is null or number is null or status in ('posted','void'));

-- ---- bank statements --------------------------------------------------------
-- One row per file a person imported for one account.
create table public.finance_statement_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  account_id uuid not null,
  file_name text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, id, account_id),
  foreign key (org_id, account_id) references public.finance_accounts(org_id, id)
);
create index finance_statement_imports_account_idx on public.finance_statement_imports (org_id, account_id, created_at);

-- One row per line of a statement: what the bank said. Money in or money out,
-- never both. transaction_id is the movement of money a person matched it
-- to; a movement is matched by at most one line. A line belongs to its
-- import's account.
create table public.finance_statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  import_id uuid not null,
  account_id uuid not null,
  -- The line's place in the file, from 1.
  position integer not null check (position >= 1),
  line_date date not null,
  description text not null default '',
  money_in numeric(14,2) not null default 0 check (money_in >= 0),
  money_out numeric(14,2) not null default 0 check (money_out >= 0),
  transaction_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (import_id, position),
  constraint finance_statement_lines_one_side_check check ((money_in > 0) <> (money_out > 0)),
  constraint finance_statement_lines_number_check check (money_in <> 'NaN' and money_out <> 'NaN'),
  foreign key (org_id, import_id, account_id)
    references public.finance_statement_imports(org_id, id, account_id) on delete cascade,
  foreign key (org_id, transaction_id) references public.finance_transactions(org_id, id)
);
create unique index finance_statement_lines_transaction_key
  on public.finance_statement_lines (org_id, transaction_id) where transaction_id is not null;
create index finance_statement_lines_account_idx on public.finance_statement_lines (org_id, account_id, line_date);

do $$
declare t text;
begin
  foreach t in array array['finance_statement_imports','finance_statement_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_org_writer(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_org_writer(org_id))', t || '_delete', t);
    execute format(
      'create policy mfa_required on public.%I as restrictive for all to authenticated '
      || 'using ((select private.mfa_ok())) with check ((select private.mfa_ok()))', t);
    execute format('revoke all on public.%I from anon, authenticated, service_role', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---- guards -----------------------------------------------------------------
-- Each steps aside when its workspace is being deleted: by the time a cascade
-- reaches these rows the orgs row is already gone.

-- transfer_id is given when a payment is inserted and never changes after.
-- The trigger has a WHEN clause, so this runs only for an update that
-- changes it. It sorts after finance_transaction_guard, so a write that guard
-- refuses is still refused first, with the code it had.
create or replace function private.finance_transfer_id_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a payment does not join or leave a transfer' using errcode = 'FIN16';
end $$;

create trigger finance_transfer_id_guard
  before update on public.finance_transactions
  for each row
  when (new.transfer_id is distinct from old.transfer_id)
  execute function private.finance_transfer_id_guard();

-- After any statement on payments: every transfer it touched is two matching
-- sides, or is still all draft, or has no row left. A draft moves no money,
-- so the rule starts when a side is posted. Checked after the statement, not
-- row by row, so the two sides are posted or voided by one UPDATE; a
-- statement that posts, voids or changes only one of them is refused, and so
-- is deleting a draft side from under a posted one. `changed` is
-- the rows the statement inserted, the new version of those it updated, or
-- those it deleted.
--
-- Runs as its owner (security definer), not as the caller. When a user is
-- deleted, the foreign keys on created_by and approved_by clear them with an
-- UPDATE of payments, and Postgres runs the AFTER triggers of that UPDATE at
-- the end of the outer DELETE, as whoever issued it. Supabase Auth deletes
-- users as a role with no rights on public tables, which could not read
-- orgs, payments or allocations here, and the delete would be refused. It
-- takes no argument, reads only by the (org_id, transfer_id) of rows the
-- statement itself touched, returns nothing and raises one fixed message,
-- and nobody can call it directly.
create or replace function private.finance_transfer_pair_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  sides integer;
  drafts integer;
  matching boolean;
begin
  for c in
    select distinct ch.org_id, ch.transfer_id from changed ch where ch.transfer_id is not null
  loop
    -- The workspace is being deleted: its payments all go.
    continue when not exists (select 1 from public.orgs where id = c.org_id);

    select
      count(*),
      count(*) filter (where t.status = 'draft'),
      count(*) filter (where t.direction = 'in') = 1
        and count(*) filter (where t.direction = 'out') = 1
        and count(distinct t.account_id) = 2
        and count(distinct t.amount) = 1
        and count(distinct t.txn_date) = 1
        and count(distinct t.status) = 1
        and count(distinct coalesce(t.number, '')) = 1
        and bool_and(t.status in ('draft','posted','void'))
        and bool_and(t.contact_id is null and t.party_name is null and t.category_id is null)
        and not exists (
          select 1 from public.finance_allocations a
          where a.org_id = c.org_id
            and a.transaction_id in (
              select x.id from public.finance_transactions x
              where x.org_id = c.org_id and x.transfer_id = c.transfer_id
            )
        )
    into sides, drafts, matching
    from public.finance_transactions t
    where t.org_id = c.org_id and t.transfer_id = c.transfer_id;

    -- Nothing left of it, or nothing of it posted yet: a draft moves no money.
    if sides > drafts and not coalesce(matching, false) then
      raise exception 'a transfer is two matching sides: money out of one account and the same money in to another'
        using errcode = 'FIN16';
    end if;
  end loop;
  return null;
end $$;

create trigger finance_transfer_pair_insert
  after insert on public.finance_transactions
  referencing new table as changed
  for each statement execute function private.finance_transfer_pair_check();
create trigger finance_transfer_pair_update
  after update on public.finance_transactions
  referencing new table as changed
  for each statement execute function private.finance_transfer_pair_check();
create trigger finance_transfer_pair_delete
  after delete on public.finance_transactions
  referencing old table as changed
  for each statement execute function private.finance_transfer_pair_check();

-- A voided payment is no longer what a statement line said happened: the
-- line goes back to unmatched. Runs as the person voiding, who may write
-- statement lines if they may void.
create or replace function private.finance_transaction_unmatch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.finance_statement_lines
     set transaction_id = null, updated_at = now()
   where org_id = new.org_id and transaction_id = new.id;
  return null;
end $$;

create trigger finance_transaction_unmatch
  after update on public.finance_transactions
  for each row
  when (new.status = 'void' and old.status is distinct from 'void')
  execute function private.finance_transaction_unmatch();

-- A statement line is what the bank said, so once it is in, only its match
-- changes. It starts unmatched. It is matched to one posted movement of money
-- on its own account, in its own direction, for its own amount: how far apart
-- the two dates may be is for whoever proposes the match, not for this guard.
-- A matched line is unmatched before it is deleted. The payment's row is
-- locked while the match is made, so it cannot be voided at the same moment
-- and leave a line matched to a void payment.
create or replace function private.finance_statement_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  t record;
begin
  if tg_op = 'DELETE' then
    if old.transaction_id is not null and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a matched statement line is unmatched before it is deleted' using errcode = 'FIN17';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.transaction_id is not null then
      raise exception 'a statement line starts unmatched' using errcode = 'FIN17';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - 'transaction_id' - 'updated_at') is distinct from (to_jsonb(old) - 'transaction_id' - 'updated_at') then
    raise exception 'a statement line is what the bank said; only its match changes' using errcode = 'FIN17';
  end if;
  if new.transaction_id is null or new.transaction_id is not distinct from old.transaction_id then
    return new;
  end if;

  select status, account_id, direction, amount into t from public.finance_transactions
  where org_id = new.org_id and id = new.transaction_id for share;
  if not found
     or t.status <> 'posted'
     or t.account_id <> new.account_id
     or t.direction <> (case when new.money_in > 0 then 'in' else 'out' end)
     or t.amount <> greatest(new.money_in, new.money_out) then
    raise exception 'a statement line is matched to a posted payment of its account, its direction and its amount'
      using errcode = 'FIN17';
  end if;
  return new;
end $$;

create trigger finance_statement_line_guard
  before insert or update or delete on public.finance_statement_lines
  for each row execute function private.finance_statement_line_guard();

-- An import stays with its account and its workspace.
create or replace function private.finance_statement_import_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id or new.account_id is distinct from old.account_id then
    raise exception 'a statement import stays with its account' using errcode = 'FIN17';
  end if;
  return new;
end $$;

create trigger finance_statement_import_guard
  before update on public.finance_statement_imports
  for each row execute function private.finance_statement_import_guard();

-- The other four run as the caller, and none of them is reached that way.
-- finance_transfer_id_guard and finance_transaction_unmatch have WHEN clauses
-- a foreign key's SET NULL never meets (it changes neither transfer_id nor
-- status), and a cascade is a DELETE, which neither is on.
-- finance_statement_line_guard and finance_statement_import_guard are BEFORE
-- ROW triggers, which run inside the foreign key's own statement, as the
-- table's owner, as the guards that were live do.
revoke all on function private.finance_transfer_id_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_transfer_pair_check() from public, anon, authenticated, service_role;
revoke all on function private.finance_transaction_unmatch() from public, anon, authenticated, service_role;
revoke all on function private.finance_statement_line_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_statement_import_guard() from public, anon, authenticated, service_role;

-- ---- views ------------------------------------------------------------------
-- One row per account, archived ones included. balance is the opening
-- balance, plus every posted movement in, less every posted movement out,
-- whatever its date: opening_date says when the opening balance was true and
-- takes no part in the sum. to_be_paid is scheduled money out. A transfer
-- counts on both of its accounts.
create view public.finance_account_balances with (security_invoker = true) as
select
  a.id,
  a.org_id,
  a.name,
  a.kind,
  a.bank_name,
  a.account_no,
  a.opening_balance,
  a.opening_date,
  a.active,
  coalesce(m.money_in, 0)::numeric(14,2) as money_in,
  coalesce(m.money_out, 0)::numeric(14,2) as money_out,
  (a.opening_balance + coalesce(m.money_in, 0) - coalesce(m.money_out, 0))::numeric(14,2) as balance,
  coalesce(m.to_be_paid, 0)::numeric(14,2) as to_be_paid,
  s.last_import_at,
  coalesce(u.unmatched_lines, 0)::integer as unmatched_lines,
  a.created_at
from public.finance_accounts a
left join lateral (
  select
    sum(t.amount) filter (where t.direction = 'in' and t.status = 'posted') as money_in,
    sum(t.amount) filter (where t.direction = 'out' and t.status = 'posted') as money_out,
    sum(t.amount) filter (where t.direction = 'out' and t.status = 'scheduled') as to_be_paid
  from public.finance_transactions t
  where t.org_id = a.org_id and t.account_id = a.id
) m on true
left join lateral (
  select max(i.created_at) as last_import_at
  from public.finance_statement_imports i
  where i.org_id = a.org_id and i.account_id = a.id
) s on true
left join lateral (
  select count(*) as unmatched_lines
  from public.finance_statement_lines l
  where l.org_id = a.org_id and l.account_id = a.id and l.transaction_id is null
) u on true;
revoke all on public.finance_account_balances from anon, authenticated, service_role;
grant select on public.finance_account_balances to authenticated;

-- One row per movement of money, either direction, whatever its status, the
-- two sides of a transfer included (one row on each account). kind is what
-- the two cash book views call it, or 'transfer'. other_account_name is the
-- account at the other end of a transfer. reconciled says a statement line
-- is matched to it.
create view public.finance_bank_transactions with (security_invoker = true) as
select
  t.id as transaction_id,
  t.org_id,
  t.account_id,
  acc.name as account_name,
  acc.kind as account_kind,
  t.direction,
  t.txn_date,
  t.amount,
  t.status,
  t.number,
  t.method,
  t.reference,
  t.notes,
  coalesce(c.name, t.party_name) as party_name,
  case
    when t.transfer_id is not null then 'transfer'
    when t.direction = 'in' then case when d.invoices > 0 then 'invoice' else 'income' end
    when d.bills > 0 then 'bill'
    when d.invoices + d.credit_notes > 0 then 'refund'
    when d.expenses > 0 then 'expense'
    else 'other'
  end as kind,
  case when d.expenses > 0 then d.expense_category else cat.name end as category_name,
  d.documents,
  t.transfer_id,
  oacc.name as other_account_name,
  sl.id as statement_line_id,
  (sl.id is not null) as reconciled,
  t.created_at
from public.finance_transactions t
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
left join public.finance_contacts c on c.org_id = t.org_id and c.id = t.contact_id
left join public.finance_categories cat on cat.org_id = t.org_id and cat.id = t.category_id
left join public.finance_transactions o
  on o.org_id = t.org_id and o.transfer_id = t.transfer_id and o.id <> t.id
left join public.finance_accounts oacc on oacc.org_id = o.org_id and oacc.id = o.account_id
left join public.finance_statement_lines sl on sl.org_id = t.org_id and sl.transaction_id = t.id
cross join lateral (
  select
    count(a.bill_id) as bills,
    count(a.invoice_id) as invoices,
    count(a.credit_note_id) as credit_notes,
    count(a.expense_id) as expenses,
    case when count(distinct ec.id) = 1 then min(ec.name) end as expense_category,
    string_agg(coalesce(b.bill_no, i.invoice_no, n.credit_note_no), ', '
               order by coalesce(b.bill_no, i.invoice_no, n.credit_note_no)) as documents
  from public.finance_allocations a
  left join public.supplier_bills b on b.org_id = a.org_id and b.id = a.bill_id
  left join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
  left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
  left join public.finance_expenses e on e.org_id = a.org_id and e.id = a.expense_id
  left join public.finance_categories ec on ec.org_id = e.org_id and ec.id = e.category_id
  where a.org_id = t.org_id and a.transaction_id = t.id
) d;
revoke all on public.finance_bank_transactions from anon, authenticated, service_role;
grant select on public.finance_bank_transactions to authenticated;

-- ---- functions --------------------------------------------------------------
-- All run as the caller, so RLS decides who may write and to which workspace.

-- Moves money between two of the workspace's active accounts and returns the
-- transfer's id. transfer has from_account_id, to_account_id, amount,
-- txn_date, reference and notes. Both sides are posted at once with one TR-
-- number, taken here, so a refused transfer does not use one up. Only an
-- owner or admin may: the guard on payments holds money out that settles no
-- document to that, and this function says so before it writes anything.
create or replace function public.finance_record_transfer(target_org uuid, transfer jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tid uuid := gen_random_uuid();
  src uuid := nullif(transfer->>'from_account_id', '')::uuid;
  dst uuid := nullif(transfer->>'to_account_id', '')::uuid;
  amt numeric := round((transfer->>'amount')::numeric, 2);
  on_date date := coalesce((transfer->>'txn_date')::date, current_date);
  found_accounts integer;
  cash_accounts integer;
  no text;
begin
  if src is null or dst is null or src = dst then
    raise exception 'a transfer is between two different accounts' using errcode = 'FIN16';
  end if;
  -- NaN is greater than every number, so it is asked for by name.
  if amt is null or amt = 'NaN' or amt <= 0 then
    raise exception 'a transfer needs an amount' using errcode = 'FIN16';
  end if;
  select count(*), count(*) filter (where kind = 'cash') into found_accounts, cash_accounts
  from public.finance_accounts
  where org_id = target_org and id in (src, dst) and active;
  if found_accounts <> 2 then
    raise exception 'a transfer is between two active accounts of the workspace' using errcode = 'FIN16';
  end if;
  if not private.finance_may_decide(target_org) then
    raise exception 'moving money between accounts needs an owner or admin' using errcode = 'FIN14';
  end if;

  -- One INSERT for both sides: the pair is checked after the statement.
  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, notes, transfer_id, status)
  select
    target_org, v.direction, v.account_id, on_date, amt,
    case when cash_accounts > 0 then 'cash' else 'bank_transfer' end,
    nullif(transfer->>'reference', ''),
    nullif(transfer->>'notes', ''),
    tid, 'draft'
  from (values ('out', src), ('in', dst)) as v(direction, account_id);

  no := public.finance_next_number(target_org, 'transfer');
  -- One UPDATE for both sides, for the same reason.
  update public.finance_transactions
     set status = 'posted', number = no, updated_at = now()
   where org_id = target_org and transfer_id = tid;
  return tid;
end $$;

-- Voids both sides of a posted transfer. Like every posted payment, it is
-- voided by anyone who may write.
create or replace function public.finance_void_transfer(target_org uuid, target_transfer uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sides integer;
  posted integer;
begin
  select count(*), count(*) filter (where s.status = 'posted') into sides, posted
  from (
    select status from public.finance_transactions
    where org_id = target_org and transfer_id = target_transfer
    order by id
    for update
  ) s;
  if sides = 0 then
    raise exception 'the transfer no longer exists' using errcode = 'FIN11';
  end if;
  if posted <> sides then
    raise exception 'only a posted transfer is voided' using errcode = 'FIN09';
  end if;
  update public.finance_transactions
     set status = 'void', updated_at = now()
   where org_id = target_org and transfer_id = target_transfer;
end $$;

-- Stores one imported statement for one account and returns the import's id.
-- lines is a list of { line_date, description, money_in, money_out } in the
-- order of the file; each line has money in or money out, not both. At most
-- 1,000 lines. Every line starts unmatched.
create or replace function public.finance_import_statement(target_org uuid, target_account uuid, file_name text, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  iid uuid;
begin
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'a statement needs at least one line' using errcode = 'FIN17';
  end if;
  if jsonb_array_length(lines) > 1000 then
    raise exception 'one import takes at most 1,000 lines' using errcode = 'FIN17';
  end if;
  if exists (
    select 1 from jsonb_array_elements(lines) as l(line)
    where (l.line->>'money_in')::numeric = 'NaN' or (l.line->>'money_out')::numeric = 'NaN'
  ) then
    raise exception 'a statement line needs an amount that is a number' using errcode = 'FIN17';
  end if;

  insert into public.finance_statement_imports (org_id, account_id, file_name)
  values (target_org, target_account, nullif(left(file_name, 200), ''))
  returning id into iid;

  insert into public.finance_statement_lines
    (org_id, import_id, account_id, position, line_date, description, money_in, money_out)
  select
    target_org, iid, target_account, l.position,
    (l.line->>'line_date')::date,
    left(coalesce(l.line->>'description', ''), 500),
    coalesce(round((l.line->>'money_in')::numeric, 2), 0),
    coalesce(round((l.line->>'money_out')::numeric, 2), 0)
  from jsonb_array_elements(lines) with ordinality as l(line, position);
  return iid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_record_transfer(uuid, jsonb)',
    'public.finance_void_transfer(uuid, uuid)',
    'public.finance_import_statement(uuid, uuid, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
