-- Bendahara: a payment that has left draft is held still (additive; safe to
-- apply while the previous code is still deployed: see "What changes for the
-- deployed code").
--
-- What was open. private.finance_transaction_guard holds a payment still once
-- it is posted or void (FIN09), while it waits for approval or is rejected
-- (FIN14), and once it is scheduled with an approval written on it (FIN14).
-- One state was left: scheduled with no approval, which is every payment out
-- that is exactly its split (a payment for a supplier's bills, a pending
-- refund, a voucher for approved expenses), whoever scheduled it. Anyone who
-- may write in the workspace, a plain member included, could by a direct call
--   * put it back to draft (finance_transaction_sign_off lets scheduled to
--     draft through for every writer), and then change its amount, its split
--     and its account, and schedule it again;
--   * while it stayed scheduled, change its account, date, reference, notes,
--     method, category and payee;
--   * point a row of its split at another document of the same kind, another
--     supplier's bill included (private.finance_allocation_guard only asks
--     that the split still adds up to the payment).
-- finance_mark_payment_paid compares nothing with what was scheduled, so what
-- an owner saw as "To be paid" was not what they then paid.
--
-- The rule, for a signed-in person, on every payment whose status is not
-- draft (pending_approval, scheduled, posted, rejected, void):
--   1. Only its status moves. direction, account_id, txn_date, amount, method,
--      reference, contact_id, party_name, category_id and notes stay as they
--      are, with or without a change of status. One exception: txn_date may
--      change in the move from scheduled to posted, which is how
--      finance_mark_payment_paid writes the day it was paid.
--   2. It does not go back to draft, whoever asks: an owner and an admin are
--      held as a member is. Which other moves of status exist, and who may
--      make them, stays the business of finance_transaction_guard and
--      finance_transaction_sign_off; this file adds no move and takes none
--      away but that one.
--   3. Its split is not changed: no row of finance_allocations is added to
--      it, taken from it, moved onto or off it, or changed (an UPDATE that
--      changes nothing but updated_at is let through).
-- FIN28, in three messages. To change a payment that is to be paid, delete it
-- and record it again, which is what the app offers; a paid one is voided.
--
-- New error code: FIN28. Nothing else raises it.
--
-- What is still written on a payment that is not a draft, and by whom:
-- number (the six functions that number a payment), approved_by and
-- approved_at (finance_transaction_guard), voided_at (finance_void_stamp),
-- created_by and approved_by cleared when a user is deleted (their foreign
-- keys), updated_at (anyone). None of those is in the list above, the first
-- five are closed to the authenticated role by column grants, and an UPDATE
-- that touches only those never calls the function: the trigger has a WHEN
-- clause. org_id and transfer_id have their own guards (FIN09, FIN16).
-- (A change of transfer_id together with a held column is answered FIN28 now,
-- where FIN16 answered it before: this trigger sorts first.)
--
-- How the triggers fit what is there. Nothing live is replaced: two new
-- functions, two new triggers. BEFORE ROW triggers fire in the order of their
-- names. finance_transaction_still sorts after finance_transaction_guard,
-- finance_transaction_insert_guard and finance_transaction_sign_off, so
-- everything those refuse they still refuse first, with the code they had
-- (FIN09, FIN03, FIN04, FIN05, FIN14): for a posted, void, waiting, rejected
-- or approved payment this trigger is reached only by what they already let
-- through. It sorts before finance_transfer_id_guard, before
-- finance_use_account_update (so an edit refused here never takes the row lock
-- on the account that an archive waits for) and before finance_void_stamp,
-- which 20261111090000 needs to be the last BEFORE trigger of the table; this
-- trigger changes nothing in the row. finance_allocation_still sorts after
-- finance_allocation_guard, the only other trigger on finance_allocations, so
-- that guard's FIN09, FIN14, FIN03, FIN04, FIN05 and FIN06 come first too.
--
-- Both functions run as their owner (security definer), like
-- private.finance_transaction_account_guard: each has to answer the same
-- whoever the caller is, including inside the functions that already run as
-- the owner. They take no argument, the first reads nothing but whether someone is signed in
-- and the second reads one payment by the (org_id, transaction_id) of the row
-- being written, they change nothing, and nobody can call them. A BEFORE
-- trigger answers before the row policy on an INSERT, so someone who may not
-- write in the workspace and adds a row to the split of a payment of it that
-- is not a draft can be answered FIN28 rather than 42501; nothing is written
-- either way. An UPDATE or DELETE by such a person finds no row, as before.
-- (In practice that person is answered FIN04, not FIN28: finance_allocation_guard
-- runs as the caller and fires first, so the person never reaches the split's
-- function. If that guard is ever made a definer, or renamed to sort later, the
-- split's function must ask private.is_org_writer(new.org_id) itself before it
-- reads the payment.)
--
-- They step aside when nobody is signed in (auth.uid() is null): a migration
-- or the SQL editor, run by the database owner, as the other finance guards
-- do. The split's trigger also steps aside when the payment is not found
-- (the payment itself is being deleted and its split goes with it) and when
-- the workspace is gone (it is being deleted with everything in it).
--
-- Applying it. Send the file as ONE call (one transaction): the lock table ...
-- nowait line below only means something inside it. Behind a payment writer, or
-- an autovacuum of either table, it fails at once with 55P03, nothing is
-- created, and it is simply sent again.
--
-- What changes for the deployed code. Nothing it does: no screen, action or
-- assistant tool edits a payment that is not a draft or sends one back to
-- draft. Every function that records money inserts a draft, writes its split
-- while it is a draft, and then moves its status once; approving, rejecting,
-- marking paid and voiding change status (and what the database stamps) and
-- nothing else; deleting is not an UPDATE. Code from before this file would
-- answer FIN28 with its general "could not be saved" sentence, and cannot
-- reach it.
--
-- Sign-up, and deleting a user or a workspace. A new workspace's seeds write
-- no payment. Deleting a user clears created_by and approved_by with an
-- UPDATE that the WHEN clause passes by. Deleting a workspace deletes its
-- payments and their splits: there is no DELETE trigger on payments here, and
-- the split's trigger lets the rows go.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';
-- What "create trigger" needs, taken first and at once, or not at all. It
-- lets every read through and holds writes of payments and their splits
-- until this file ends.
lock table public.finance_transactions, public.finance_allocations in share row exclusive mode nowait;

-- ---- the payment ----------------------------------------------------------------
create function private.finance_transaction_still_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Nobody is signed in: a migration or the SQL editor, run by the database owner.
  if (select auth.uid()) is null then
    return new;
  end if;
  -- A draft is not held. (The trigger's WHEN clause says the same.)
  if old.status = 'draft' then
    return new;
  end if;

  if new.status = 'draft' then
    raise exception 'a payment that has left draft does not go back to draft; delete it and record it again' using errcode = 'FIN28';
  end if;

  if (new.direction, new.account_id, new.amount, new.method, new.reference,
      new.contact_id, new.party_name, new.category_id, new.notes)
     is distinct from
     (old.direction, old.account_id, old.amount, old.method, old.reference,
      old.contact_id, old.party_name, old.category_id, old.notes)
     -- The day it was paid is written as a scheduled payment is marked paid.
     or (new.txn_date is distinct from old.txn_date
         and not (old.status = 'scheduled' and new.status = 'posted')) then
    raise exception 'a payment that has left draft is not edited; delete it or void it' using errcode = 'FIN28';
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_still_guard() from public, anon, authenticated, service_role;

create trigger finance_transaction_still
  before update on public.finance_transactions
  for each row
  when (old.status <> 'draft'
        and (new.status is distinct from old.status
          or new.direction is distinct from old.direction
          or new.account_id is distinct from old.account_id
          or new.txn_date is distinct from old.txn_date
          or new.amount is distinct from old.amount
          or new.method is distinct from old.method
          or new.reference is distinct from old.reference
          or new.contact_id is distinct from old.contact_id
          or new.party_name is distinct from old.party_name
          or new.category_id is distinct from old.category_id
          or new.notes is distinct from old.notes))
  execute function private.finance_transaction_still_guard();

-- ---- its split ------------------------------------------------------------------
-- Not an oracle: finance_allocation_guard (invoker, sorts first) answers FIN04 to anyone who cannot write the workspace, so this definer function is only reached by someone who can already read the payment.
create function private.finance_allocation_still_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  standing text;
begin
  -- Nobody is signed in: a migration or the SQL editor, run by the database owner.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  -- The workspace is being deleted: its payments and their splits all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs o where o.id = old.org_id) then
    return old;
  end if;
  -- Nothing changed but the time of the change.
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return new;
  end if;

  if tg_op <> 'INSERT' then
    -- Locked as finance_allocation_guard locks it, so the payment cannot leave
    -- draft while its split is being changed, nor the other way round.
    select t.status into standing
      from public.finance_transactions t
     where t.org_id = old.org_id and t.id = old.transaction_id
       for share;
    -- No row: the payment itself is being deleted, and its split goes with it.
    if found and standing <> 'draft' then
      raise exception 'the split of a payment that has left draft is not changed' using errcode = 'FIN28';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;

  select t.status into standing
    from public.finance_transactions t
   where t.org_id = new.org_id and t.id = new.transaction_id
     for share;
  -- No such payment in the row's workspace: the foreign key says so (23503).
  if found and standing <> 'draft' then
    raise exception 'the split of a payment that has left draft is not changed' using errcode = 'FIN28';
  end if;
  return new;
end $$;
revoke all on function private.finance_allocation_still_guard() from public, anon, authenticated, service_role;

create trigger finance_allocation_still
  before insert or update or delete on public.finance_allocations
  for each row execute function private.finance_allocation_still_guard();

-- ---- nothing was left out ---------------------------------------------------------
-- The two triggers are on and sit where the header says, and every column of
-- a payment that the authenticated role may write is either held by the
-- trigger or one of the three it leaves alone. Otherwise everything rolls back.
do $$
declare
  names text;
  missing text;
begin
  -- Every BEFORE ROW trigger of the table that is switched on, in the order they fire.
  select string_agg(g.tgname, ',' order by g.tgname) into names
    from pg_catalog.pg_trigger g
   where g.tgrelid = 'public.finance_transactions'::regclass and not g.tgisinternal
     and g.tgenabled = 'O' and (g.tgtype & 2) = 2;
  if names !~ ('^(.*,)?finance_transaction_guard,(.*,)?finance_transaction_insert_guard,(.*,)?finance_transaction_sign_off,'
               || '(.*,)?finance_transaction_still,(.*,)?finance_transfer_id_guard,(.*,)?finance_use_account_insert,'
               || 'finance_use_account_update,finance_void_stamp$') then
    raise exception 'the BEFORE triggers on finance_transactions are not in the order this file needs: %', names;
  end if;

  select string_agg(g.tgname, ',' order by g.tgname) into names
    from pg_catalog.pg_trigger g
   where g.tgrelid = 'public.finance_allocations'::regclass and not g.tgisinternal
     and g.tgenabled = 'O' and (g.tgtype & 2) = 2;
  if names !~ '^(.*,)?finance_allocation_guard,(.*,)?finance_allocation_still(,.*)?$' then
    raise exception 'the BEFORE triggers on finance_allocations are not in the order this file needs: %', names;
  end if;

  -- updated_at is anyone's; status is what the trigger watches; transfer_id has its own guard (FIN16).
  select string_agg(a.attname, ',' order by a.attname) into missing
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.finance_transactions'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')
     and a.attname not in ('updated_at', 'transfer_id')
     and position('new.' || a.attname || ' IS DISTINCT FROM old.' || a.attname in
           (select pg_catalog.pg_get_triggerdef(g.oid) from pg_catalog.pg_trigger g
             where g.tgrelid = a.attrelid and g.tgname = 'finance_transaction_still')) = 0;
  if missing is not null then
    raise exception 'a signed-in person may write these columns of a payment and the rule does not hold them: %', missing;
  end if;
end $$;
