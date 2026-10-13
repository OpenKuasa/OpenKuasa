-- Bendahara: an expense's updated_at is the database's to write, who entered
-- an expense and when cannot be rewritten, and expense and income categories
-- are an owner's or admin's to change.
--
-- Written to be applied after 20261114100000_bendahara_expense_amounts and
-- 20261108090000_bendahara_ledger_accounts, and built on what they left.
-- Nothing that exists is replaced: no function, trigger or policy on main is
-- dropped or re-created. What is new:
--
--   1. private.finance_expense_stamp and the trigger finance_expense_stamp on
--      finance_expenses. On every insert, and on every update that changes
--      anything, made by a signed-in person, updated_at is set to the
--      database's clock, whatever the caller sent. Until now nothing moved
--      updated_at on a direct update, so a person who may write could change
--      a pending expense and leave updated_at still, or set it by hand; an
--      owner approving "the expense as shown" leaned on a value the editor
--      controlled. The app compares every shown field as well, and goes on
--      doing so.
--   2. On finance_expenses, created_by and created_at are no longer writable
--      by the authenticated role: insert and update are granted column by
--      column, without those two. Every other column is granted as before.
--      (approved_by and approved_at stay granted: the expense's own guard
--      refuses a hand-written value with FIN14 or FIN01, and those answers
--      are relied on.)
--   3. Three restrictive policies on finance_categories: adding, changing and
--      deleting a category needs an owner or admin
--      (private.finance_may_sign_off, the one place that says who signs off).
--      The four policies it had are untouched; a restrictive policy is asked
--      as well as them. Reading is unchanged: every member reads.
--   4. A category's name is 1 to 80 characters with no space at either end
--      (finance_categories_name_check). An empty name was accepted, and
--      "Rent" and "Rent " were two categories.
--
-- How this fits what is there.
--   * finance_expense_guard is not replaced. BEFORE triggers on one table
--     run in name order and each is handed the row the one before returned:
--     finance_expense_stamp sorts after finance_expense_guard, so the guard
--     has compared the row as the caller sent it before the stamp writes
--     updated_at. An update that changes nothing is left exactly as it was,
--     so the guard's "nothing changed" answer is still true of it. The same
--     arrangement as finance_void_stamp on the four document tables.
--   * finance_save_expense and finance_receipt_to_expense run as the caller
--     and write neither created_by nor created_at, so both go on working:
--     created_by takes its default (auth.uid()) and created_at its default.
--     The demo seed and the foreign keys' own clears run as the table's
--     owner, which column grants do not bind.
--   * The stamp steps aside when nobody is signed in (a migration, the SQL
--     editor, the demo seed) and one trigger down (pg_trigger_depth() > 1):
--     that is the foreign key clearing a deleted user from created_by or
--     approved_by, which is not a change anyone made to the expense.
--   * Categories are seeded for a new workspace by
--     private.finance_seed_categories and private.finance_ledger_seed, which
--     run as the owner (security definer): row-level security is not asked
--     of them, so signing up is unchanged, as is a category's ledger
--     account, which the ledger's own triggers make, rename and archive.
--   * No deployed code writes finance_categories: the screens only read it.
--
-- What changes for a write the deployed code can make: nothing is refused
-- that was allowed. An approval or rejection sends updated_at with the
-- status; the value stored is now the database's clock and not the app
-- server's. For a write by hand:
--   * a person who may write but is not an owner or admin can no longer add
--     a category (42501), and their update or delete of one touches no row;
--   * an update or insert that names created_by or created_at on
--     finance_expenses is refused (42501), whatever value it carries.
--
-- No new error code. Nothing here is granted to service_role, which has no
-- rights on these tables.
--
-- ORDER: apply before the code that goes with it deploys. This file must be
-- sent as ONE call, in one transaction: "set local" lasts only as long as
-- the transaction it is in, and outside one it sets nothing.
--
-- Locks: SHARE ROW EXCLUSIVE on finance_expenses (the trigger: readers go on,
-- a write waits until this file has ended) and ACCESS EXCLUSIVE on
-- finance_categories (the policies and the constraint, which is checked
-- against every row; the table is small, and readers wait too).

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- 1. updated_at is the database's ---------------------------------------------
create function private.finance_expense_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Nobody is signed in: a migration, the SQL editor or the demo seed, run by
  -- the database owner. One trigger down: a foreign key clearing a deleted user.
  if (select auth.uid()) is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    -- Nothing changed, so nothing is stamped: the row stays byte for byte what it was.
    return new;
  end if;
  -- clock_timestamp, not now(): two changes inside one transaction still get two values.
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke all on function private.finance_expense_stamp() from public, anon, authenticated, service_role;

-- The name sorts after finance_expense_guard, so the guard answers first.
create trigger finance_expense_stamp
  before insert or update on public.finance_expenses
  for each row execute function private.finance_expense_stamp();

-- ---- 2. who entered an expense, and when ------------------------------------------
-- Was: insert and update of every column. Now: every column but created_by
-- and created_at. Select and delete stay as they were. The row-level policies
-- and the second-factor policy are untouched.
revoke insert, update on public.finance_expenses from authenticated;
grant insert (id, org_id, expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes, status,
              approved_by, approved_at, updated_at)
  on public.finance_expenses to authenticated;
grant update (id, org_id, expense_date, category_id, vendor_id, vendor_name, amount, sst_amount, notes, status,
              approved_by, approved_at, updated_at)
  on public.finance_expenses to authenticated;

-- ---- 3. categories are an owner's or admin's to change ------------------------------
create policy finance_categories_sign_off_insert on public.finance_categories
  as restrictive for insert to authenticated
  with check (private.finance_may_sign_off(org_id));
create policy finance_categories_sign_off_update on public.finance_categories
  as restrictive for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
create policy finance_categories_sign_off_delete on public.finance_categories
  as restrictive for delete to authenticated
  using (private.finance_may_sign_off(org_id));

-- ---- 4. a category has a name ---------------------------------------------------------
-- Validated against every row there is: the apply stops here if one fails it.
alter table public.finance_categories
  add constraint finance_categories_name_check
  check (name = btrim(name) and char_length(name) between 1 and 80);
