-- Bendahara banking, fitted to the finance write guards (additive; safe to
-- apply while the previous code is still deployed: no deployed code reads or
-- calls anything changed here).
--
-- 20261031090000_bendahara_banking was written before
-- 20261030123000_finance_write_guards existed and applied after it. That file
-- closed columns to the authenticated role that two things here still used as
-- the caller:
--
--   1. The view finance_account_balances selected finance_accounts.account_no.
--      The view runs as whoever reads it (security_invoker), and nobody signed
--      in may read that column through the table any more, so every read of
--      the view was refused (42501), for an owner as for a viewer. The view is
--      dropped and made again without account_no; every other column, its
--      order, its options and its grants are as they were. A view's column
--      cannot be taken out by "create or replace", hence the drop; nothing
--      depends on the view, and the drop stops the migration if anything does.
--      Banking does not show an account number. A screen that needs one reads
--      it as the write guards meant: public.finance_account_numbers(target_org),
--      which answers only to someone who may write in the workspace.
--   2. finance_record_transfer ran as the caller and wrote
--      finance_transactions.number, which the authenticated role can no longer
--      write, so every transfer was refused (42501). It now runs as its owner,
--      as the six functions that number a payment do since 20261030123000, and
--      like them it begins by asking whether the caller may write in
--      target_org, which row-level security used to ask for it (the answer is
--      no for a session that still owes a second factor). The rest of the body
--      is the text that was live, in the order it had.
--
-- What changes for whom, in finance_record_transfer:
--   * An owner or admin: a transfer is recorded, where it was refused.
--   * Any other writer (role member): FIN14, as before, once the two accounts
--     and the amount are in order (FIN16 first, as before).
--   * A viewer, a session that still owes a second factor, and someone who is
--     not in the workspace: 42501, whatever else they sent. It was FIN14 for
--     a viewer and FIN16 for an outsider, who could not see the accounts.
--
-- Running as the owner, row-level security no longer filters what the function
-- reads, so every read and write in it names target_org: the two accounts are
-- looked up by (org_id, id) and must be active, both rows are inserted with
-- target_org and tied to their account by the foreign key on (org_id, id), and
-- the one UPDATE is by (org_id, transfer_id) with a transfer_id made here.
-- auth.uid() comes from the request, not from the role the function runs as,
-- so private.finance_may_decide, the guards and the sign-off trigger still see
-- the person signed in: the insert guard records them as created_by and the
-- guard on payments records them as approving the money out. finance_may_decide
-- also answers yes when nobody is signed in; that case never reaches it here,
-- because the writer test before it has already refused.
--
-- Not changed, and why:
--   * finance_void_transfer still runs as the caller. It writes status and
--     updated_at, which the authenticated role may write, and row-level
--     security still decides which rows it finds (FIN11 for a viewer or an
--     outsider). Who may void did change, by 20261030123000 alone: voiding is
--     a sign-off, so the UPDATE in it is refused with FIN14 unless the caller
--     is an owner or admin. The comment above that function in 20261031090000
--     ("voided by anyone who may write") is no longer true.
--   * finance_import_statement still runs as the caller. It writes only the
--     two statement tables, which 20261030123000 did not touch, and
--     row-level security still refuses a viewer and an outsider (42501).
--   * The view finance_bank_transactions reads name and kind of an account and
--     joins on org_id and id, all still readable.
--   * The triggers of 20261031090000: none reads or writes a closed column as
--     the caller. A member still matches and unmatches statement lines.
--   * finance_next_number: put back by 20261031090200.
--
-- What 20261030123000 changed for a write made by hand, with nothing to change
-- here: an UPDATE or INSERT by a signed-in person that names number is refused
-- with 42501 before any trigger runs, so two sides inserted by hand can no
-- longer be posted by hand at all, by anyone; finance_record_transfer is the
-- only way a transfer is posted. The pair check still holds every write that
-- reaches it (a void, a delete, a write by the database owner).
--
-- Nothing here is granted to service_role.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- account balances, without the account number ----------------------------
-- No "cascade": if anything had come to depend on the view, stop here.
drop view public.finance_account_balances;

-- One row per account, archived ones included. balance is the opening
-- balance, plus every posted movement in, less every posted movement out,
-- whatever its date: opening_date says when the opening balance was true and
-- takes no part in the sum. to_be_paid is scheduled money out. A transfer
-- counts on both of its accounts. Every column of finance_accounts named here
-- is one the authenticated role may read.
create view public.finance_account_balances with (security_invoker = true) as
select
  a.id,
  a.org_id,
  a.name,
  a.kind,
  a.bank_name,
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

-- ---- recording a transfer ------------------------------------------------------
-- Moves money between two of the workspace's active accounts and returns the
-- transfer's id. transfer has from_account_id, to_account_id, amount,
-- txn_date, reference and notes. Both sides are posted at once with one TR-
-- number, taken here, so a refused transfer does not use one up. Only an
-- owner or admin may: the guard on payments holds money out that settles no
-- document to that, and this function says so before it writes anything.
-- The body 20261031090000 gave it, with two changes: "security invoker" is
-- now "security definer", and it begins with the test of the caller.
create or replace function public.finance_record_transfer(target_org uuid, transfer jsonb)
returns uuid
language plpgsql
security definer
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
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

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

revoke all on function public.finance_record_transfer(uuid, jsonb) from public, anon, service_role;
grant execute on function public.finance_record_transfer(uuid, jsonb) to authenticated;
