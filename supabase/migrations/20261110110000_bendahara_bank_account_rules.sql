-- Bendahara banking: the rules of a bank or cash account (additive; safe to
-- apply while the previous code is still deployed: nothing deployed writes
-- finance_accounts or finance_statement_imports with a column closed here).
--
-- Until now finance_accounts had the row-level policies every finance table
-- has and nothing else: anyone who may write in a workspace (any role but
-- viewer) could add an account with any opening balance, change an opening
-- balance afterwards, turn a bank account into a cash account, and delete an
-- unused account whatever it held. An opening balance is part of every
-- balance the workspace reads (finance_account_balances) and an entry in its
-- books (finance_ledger_lines), so a member could move the cash total with no
-- payment recorded and no approval. The account form of this stage is the
-- first screen that writes the table, so the rules go in with it.
--
--   1. An opening balance is an owner's or admin's. A new account may be
--      given one, an existing account's opening balance or opening date may
--      be changed, and an account that has one may be deleted, only by
--      someone who signs off (private.finance_may_sign_off, the write guards'
--      tier): FIN14 for any other writer. A member still adds an account
--      with no opening balance, renames it, edits its bank details, and
--      archives and restores it.
--   2. An account is not archived while a payment on it, in either direction
--      (money out or money in), is still to be paid or waits for approval (a
--      payment with status scheduled or pending_approval): FIN30. Those are
--      promises to pay or to be paid on this account; settle, reject or
--      delete them first. (The screen's archive question warns about money
--      out that is to be paid; the refusal covers the rest.) Drafts do not hold it: a
--      draft promises nothing, and the forms keep a draft's own account in
--      its picker when that account is archived.
--   3. An opening balance is a number: 'NaN' is a numeric, passes every
--      comparison a form makes and turns every sum it is added to into NaN
--      (23514, a check constraint).
--   4. What nobody signed in writes on an account: its id, its workspace
--      (org_id, once inserted), its kind (bank or cash, once inserted) and
--      created_at. Insert and update are granted column by column without
--      them (42501). The kind was the last thing an account was made with
--      that could change under what was built on it: its ledger account took
--      its code from the kind (private.finance_ledger_link_bank), and a
--      statement can be imported for it. A category's kind is already fixed
--      for the same reason (FIN25, 20261108090000).
--   5. On finance_statement_imports, created_by, id and created_at are the
--      database's to write: insert is granted for org_id, account_id and
--      file_name; update for those three and updated_at (42501 for anything
--      else). Before this a writer could record an import as made by
--      somebody else, or move "last import" by rewriting created_at.
--      finance_import_statement names only the three open columns and still
--      runs as the caller. org_id and account_id stay writable so that the
--      guard that is live (private.finance_statement_import_guard) goes on
--      answering a moved import with FIN17, as it does today.
--
-- New error code: FIN30, "an account with payments still to be paid or
-- waiting for approval is not archived". FIN14 keeps its meaning (this needs
-- an owner or admin) and gains one place it is raised from.
--
-- What is not here, on purpose:
--   * No trigger on finance_transactions. That a payment is not recorded
--     against an archived account is still only what the forms offer (their
--     account pickers list active accounts); finance_record_transfer is the
--     one function that asks. See Known limits in docs/bendahara-backend.md.
--   * Nothing live is replaced: one new trigger function, one new trigger,
--     one new constraint, and grants.
--
-- The guard steps aside when nobody is signed in (auth.uid() is null): that
-- is a migration or the SQL editor, run by the database owner, and it is how
-- the demo seeds write opening balances. On a delete it also steps aside when
-- the workspace itself is being deleted (by the time the cascade reaches an
-- account its orgs row is gone). It is a BEFORE ROW trigger, so inside a
-- cascade it runs within the foreign key's own statement, as the table's
-- owner; finance_accounts has no foreign key to auth.users, so deleting a
-- user never reaches it.
--
-- Nothing here is granted to service_role: no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';
-- Taken first and at once, or not at all: everything below needs it.
lock table public.finance_accounts in access exclusive mode nowait;

-- ---- an opening balance is a number -------------------------------------------
-- The table is small and already locked, so the constraint is added and
-- validated in one step. If a workspace already holds NaN the migration
-- stops here; the dry run shows it.
alter table public.finance_accounts
  add constraint finance_accounts_opening_balance_number_check check (opening_balance <> 'NaN');

-- ---- the guard ------------------------------------------------------------------
-- Runs as the caller. It reads orgs (a member reads their own workspace's
-- row) and, for the archive rule, the payments of the account being changed,
-- which every member of the workspace reads.
create function private.finance_bank_account_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Nobody is signed in: a migration or the SQL editor, run by the database owner.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- The workspace is being deleted: its accounts all go.
    if not exists (select 1 from public.orgs where id = old.org_id) then
      return old;
    end if;
    if old.opening_balance <> 0 and not private.finance_may_sign_off(old.org_id) then
      raise exception 'an account with an opening balance is deleted by an owner or admin' using errcode = 'FIN14';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Sign-up relies on this: create_org_for_current_user inserts the workspace
    -- before the membership, so while finance_seed_accounts runs the new user
    -- is signed in and is not yet an owner. The seeded accounts pass only
    -- because they are given no opening balance. A seed that gave one would
    -- be refused here (FIN14) and sign-up would fail.
    if new.opening_balance <> 0 and not private.finance_may_sign_off(new.org_id) then
      raise exception 'an opening balance is set by an owner or admin' using errcode = 'FIN14';
    end if;
    return new;
  end if;

  if (new.opening_balance is distinct from old.opening_balance or new.opening_date is distinct from old.opening_date)
     and not private.finance_may_sign_off(new.org_id) then
    raise exception 'an opening balance is changed by an owner or admin' using errcode = 'FIN14';
  end if;
  if old.active and not new.active and exists (
    select 1 from public.finance_transactions t
    where t.org_id = new.org_id and t.account_id = new.id and t.status in ('scheduled','pending_approval')
  ) then
    raise exception 'an account with payments still to be paid or waiting for approval is not archived'
      using errcode = 'FIN30';
  end if;
  return new;
end $$;
revoke all on function private.finance_bank_account_guard() from public, anon, authenticated, service_role;

create trigger finance_bank_account_guard
  before insert or update or delete on public.finance_accounts
  for each row execute function private.finance_bank_account_guard();

-- ---- accounts: the columns the authenticated role may write ---------------------
-- Was: insert and update of every column. Select stays as 20261030123000 left
-- it (every column but account_no) and delete stays granted: an account with
-- no payment, no statement and no journal line can be deleted, and the
-- foreign keys refuse any other (23503). The row-level policies and the
-- second-factor policy are untouched.
revoke insert, update on public.finance_accounts from authenticated;
grant insert (org_id, name, kind, bank_name, account_no, opening_balance, opening_date, active)
  on public.finance_accounts to authenticated;
grant update (name, bank_name, account_no, opening_balance, opening_date, active, updated_at)
  on public.finance_accounts to authenticated;

-- ---- statement imports: who made one is the database's to say --------------------
-- created_by keeps its default, auth.uid(), which fills it on every insert
-- that does not name it; nobody signed in can name it any more.
revoke insert, update on public.finance_statement_imports from authenticated;
grant insert (org_id, account_id, file_name) on public.finance_statement_imports to authenticated;
grant update (org_id, account_id, file_name, updated_at) on public.finance_statement_imports to authenticated;
