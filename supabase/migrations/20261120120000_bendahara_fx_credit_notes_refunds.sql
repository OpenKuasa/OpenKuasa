-- Bendahara multi-currency, stage 3c: credit notes and refunds on invoices
-- in another currency
-- (docs/superpowers/specs/2026-10-15-bendahara-multi-currency-design.md,
-- stage 3; plan .superpowers/sdd/2026-10-16-bendahara-fx-sales.md, PR 3c).
-- Built on 20261120100000_bendahara_invoice_currency.sql (3a) and
-- 20261120110000_bendahara_fx_payments_in.sql (3b).
--
-- A credit note on a foreign invoice is in the invoice's currency, at the
-- invoice's rate, so issuing one makes no exchange difference:
--   * finance_credit_notes gains currency and fx_rate (always the invoice's,
--     written by the database on every draft write, whatever the caller sent)
--     and amount_myr, the ringgit it takes off the invoice, written when it is
--     issued by the one closing rule (private.finance_fx_carried): the amount
--     at the invoice's rate, rounded to the sen, or exactly the ringgit still
--     open when it clears the invoice. Stored, not generated (the plan's
--     ruling, worked example C2): a generated round(amount * rate, 2) leaves a
--     sen on Receivable when a credit note clears an invoice whose ringgit
--     total is the sum of rounded lines. Null for a ringgit credit note (it
--     means the amount) and for a foreign draft.
--   * The ledger posts a credit note in ringgit (amount_myr; the SST share
--     from the invoice's ringgit lines), and finance_invoice_totals takes
--     amount_myr off balance_myr.
-- A refund on a foreign invoice, or on a credit note of one, is paid from a
-- ringgit account like a payment in the other way round: the allocation is
-- the foreign amount refunded, the payment the ringgit that left, and
-- private.finance_fx_settle (3b) writes the allocation's amount_myr and
-- carried_myr; carried less paid out is realised gain (above 0) or loss, on
-- the fx_realised account, through 3b's refund branch of the ledger. It is
-- paid now (FIN47 for one asked as scheduled): the difference is decided when
-- the money moves.
--
-- Additive and safe to apply while the previous code is still deployed: no
-- credit note or refund on a foreign invoice exists (FIN41 refused both), so
-- every figure of finance_invoice_totals, finance_ledger_lines,
-- finance_payments_in, finance_cash_receipts, finance_credit_note_totals,
-- finance_refunds and finance_account_balances reads as before (compared row
-- for row, every workspace, at the end of this file). The previous code never
-- sends amount_myr on a refund, and offers neither on a foreign invoice; a
-- direct call that asks for one is now answered FIN46 (no ringgit paid out)
-- or FIN47 (scheduled), and a credit note is saved.
--
-- REPLACED (each restated from its newest text on main, named where it is):
--   private.finance_fx_carried                 a credit note past zero (ruling; payments read as before);
--                                              the ringgit open taken with its sign, not abs()
--   private.finance_credit_note_currency_guard 3a's FIN41 gone; writes currency, fx_rate, amount_myr
--   private.finance_allocation_currency_guard  3b's FIN41 gone; FIN44 kept
--   private.finance_transaction_guard          the split compared in the payment's own currency; FIN48
--   public.finance_record_refund               the ringgit paid out; FIN47; settles
--   public.finance_invoice_totals              credited_myr from amount_myr
--   public.finance_ledger_lines                the credit note branch in ringgit
--   public.finance_credit_note_totals          currency, fx_rate, amount_myr appended
--   public.finance_refunds                     currency, amount_myr, carried_myr, realised_myr appended
-- NEW: finance_credit_notes.currency, fx_rate, amount_myr (and their checks),
-- private.finance_split_in_payment_terms.
--
-- Error codes, new: FIN47 (a refund on a foreign invoice asked as scheduled);
-- FIN48 (money in on a foreign invoice voided while a credit note issued or
-- dated after it stands on that invoice: void the credit note first, then the
-- payment, and issue the credit note again). FIN41 is no longer raised by
-- anything. FIN46 now also means the ringgit paid out is missing on a foreign
-- refund. A ringgit void is as it was (FIN48 looks at foreign invoices only).
--
-- Known limits:
--   * Deploy window: from this file until the 3c app is deployed, the 3b
--     finance assistant's saveCreditNote/issueCreditNote check no currency, so
--     it could draft and issue a credit note on a foreign invoice with an
--     amount meant in ringgit (its refund tool sends no ringgit paid out and is
--     answered FIN46). Apply and deploy back to back.
--   * finance_credit_notes.currency, fx_rate and amount_myr keep the table's
--     grants to authenticated: whatever a caller writes on a draft is
--     overwritten by finance_credit_note_to_ringgit, and an issued or void
--     credit note is locked whole by finance_credit_note_guard (FIN01). No
--     column revoke, unlike 3b's allocation columns.
--
-- Nothing here is granted to service_role.
--
-- One call, one transaction: lock_timeout and "lock table ... nowait" only
-- mean anything inside it.

set local lock_timeout = '5s';

-- The table this file alters, and the two whose guards it replaces, at once
-- and without waiting. If anything holds one, nothing is applied; run again.
lock table
  public.finance_credit_notes,
  public.finance_transactions,
  public.finance_allocations
  in access exclusive mode nowait;
-- The four views this file replaces, so no reader holds one while "create or
-- replace view" waits for it (a reader that started after the table locks
-- would hold the view and wait on a table this file holds). After the tables
-- above and before the rest: every lock here is nowait, so this file never
-- waits and cannot be one side of a deadlock. Locking a view locks what it
-- reads in the same mode, so every table the four views read is held access
-- exclusive (reads wait) until this file commits.
lock table
  public.finance_invoice_totals,
  public.finance_ledger_lines,
  public.finance_credit_note_totals,
  public.finance_refunds
  in access exclusive mode nowait;
-- Every other table the compared views read, held against writes (reads go
-- on) so the comparison at the end sees only what this file did. The two
-- statement tables are read by finance_account_balances.
lock table
  public.finance_invoices,
  public.finance_invoice_lines,
  public.finance_contras,
  public.finance_contra_lines,
  public.finance_accounts,
  public.finance_categories,
  public.finance_contacts,
  public.finance_ledger_accounts,
  public.supplier_bills,
  public.supplier_bill_lines,
  public.finance_expenses,
  public.finance_journals,
  public.finance_journal_lines,
  public.finance_statement_imports,
  public.finance_statement_lines
  in share mode nowait;

-- What the six views and the bank balances read now, every workspace.
create temp table fx3c_ledger_before on commit drop as
  select * from public.finance_ledger_lines;
create temp table fx3c_totals_before on commit drop as
  select * from public.finance_invoice_totals;
create temp table fx3c_payments_in_before on commit drop as
  select * from public.finance_payments_in;
create temp table fx3c_cash_receipts_before on commit drop as
  select * from public.finance_cash_receipts;
create temp table fx3c_credit_notes_before on commit drop as
  select * from public.finance_credit_note_totals;
create temp table fx3c_refunds_before on commit drop as
  select * from public.finance_refunds;
create temp table fx3c_balances_before on commit drop as
  select * from public.finance_account_balances;
-- Every allocation's figures, settled foreign ones included (3b is live: a
-- foreign payment in may exist when this runs), compared at the end.
create temp table fx3c_allocations_before on commit drop as
  select id, amount, amount_myr, carried_myr from public.finance_allocations;

-- ============================================================================
-- 1. A credit note's currency, rate and ringgit
-- ============================================================================
-- The invoice's currency and rate, set by the trigger below on every draft
-- write; amount_myr is set when a foreign credit note is issued. A ringgit
-- credit note is rate 1 with no amount_myr (it means the amount); a foreign
-- draft has none yet; an issued or void foreign one has it. amount_myr may be
-- 0.00: a few units of a currency worth very little per unit (IDR 1 at
-- RM 0.00028), or the part that clears an invoice whose ringgit is already
-- used up, carry no sen (as an allocation's carried_myr may be 0.00). NaN is
-- above every number in Postgres, so it is named. Every existing row is a
-- ringgit credit note (FIN41 refused any other), so the defaults are right for
-- all of them and nothing is back-filled. Locked once issued by
-- finance_credit_note_guard, whose whole-row comparisons take in the new
-- columns (re-read; not changed). No grant changes: a caller's value is
-- always overwritten by the trigger.
alter table public.finance_credit_notes
  add column currency public.finance_currency not null default 'MYR',
  add column fx_rate numeric(20,10) not null default 1,
  add column amount_myr numeric(14,2),
  add constraint finance_credit_notes_fx_rate_check check (fx_rate > 0 and fx_rate <> 'NaN'),
  add constraint finance_credit_notes_amount_myr_check check (amount_myr is null or (amount_myr >= 0 and amount_myr <> 'NaN')),
  add constraint finance_credit_notes_fx_check check (
    case
      when currency = 'MYR' then fx_rate = 1 and amount_myr is null
      when status = 'draft' then amount_myr is null
      else amount_myr is not null
    end
  );

-- ============================================================================
-- 2. The closing rule, for a credit note past zero
-- ============================================================================
-- The text of 20261120110000_bendahara_fx_payments_in.sql lines 291 to 313
-- (3b; language plpgsql, stable, security invoker, search_path ''; revoked
-- from public, anon, service_role, granted to authenticated, both said again
-- below), with two changes. First, the ringgit still open is taken with its
-- sign (balance_myr, or -balance_myr for a refund) where 3b took abs(): the
-- same figure whenever the invoice's two balances agree in sign, and a loud
-- refusal (the ">= 0" checks) instead of a doubled residue when they do not.
-- Second: 3b's text caps a part that does not close the
-- invoice at the ringgit still open (least(...)), which is right for every
-- movement toward zero, and the only movements 3b has are: money in is held
-- to the invoice's balance and a refund to the customer's credit (FIN05). A
-- credit note is not: one on a paid invoice, or for more than is still owed,
-- takes the invoice past zero into credit, and the cap would give it the
-- ringgit open on the invoice (0.00 on a paid one) instead of its own (worked
-- example D: RM 453.60). Ruling (the plan and the spec are silent): on an
-- invoice that owes nothing, or is in credit, the part at the rate; on one
-- that owes less than the part, exactly what is open plus the rest at the
-- rate, so Receivable passes through 0.00 as it does when a payment clears an
-- invoice. Neither arm is reachable from money in or a refund, so every
-- figure 3b writes is what it was.
create or replace function private.finance_fx_carried(target_org uuid, target_invoice uuid, part numeric, refund boolean)
returns numeric
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v record;
  open_myr numeric;
begin
  select balance, balance_myr, fx_rate into v
  from public.finance_invoice_totals where org_id = target_org and id = target_invoice;
  if not found or v.fx_rate is null then
    raise exception 'a payment can only go against a posted invoice' using errcode = 'FIN04';
  end if;
  -- 20261120120000: the ringgit still open, with its sign: what is owed (balance_myr) for money in and a credit
  -- note, what the customer is in credit (-balance_myr) for a refund. 3b took the absolute value, which is the
  -- same figure whenever the invoice's two balances have the same sign; when they do not, the sign now reaches
  -- the ">= 0" checks on carried_myr and amount_myr and the write is refused, instead of a residue being
  -- doubled silently.
  open_myr := case when refund then -v.balance_myr else v.balance_myr end;
  if (not refund and v.balance = part) or (refund and v.balance = -part) then
    return open_myr;
  end if;
  -- 20261120120000: a credit note is the one movement that can take an invoice past zero (money in is held to
  -- the balance and a refund to the credit, both FIN05). On an invoice that owes nothing, or is in credit,
  -- there is nothing open to clear: the part at the rate. On one that owes less than the part: exactly what
  -- is open, and the rest at the rate. So Receivable passes through 0.00 exactly, as it does when a payment
  -- clears an invoice.
  if not refund and v.balance <= 0 then
    return round(part * v.fx_rate, 2);
  end if;
  if not refund and part > v.balance then
    return open_myr + round((part - v.balance) * v.fx_rate, 2);
  end if;
  return least(round(part * v.fx_rate, 2), open_myr);
end $$;
revoke all on function private.finance_fx_carried(uuid, uuid, numeric, boolean) from public, anon, service_role;
-- The credit note trigger of 3c runs as the caller and calls it; the private schema is not reachable through the API.
grant execute on function private.finance_fx_carried(uuid, uuid, numeric, boolean) to authenticated;

-- ============================================================================
-- 3. A credit note takes its invoice's currency
-- ============================================================================
-- Replaces 3a's function of 20261120100000_bendahara_invoice_currency.sql
-- (lines 325 to 338: FIN41 for every draft written or issued on a foreign
-- invoice; revoked from public, anon, authenticated, service_role at line
-- 387, said again below). The trigger finance_credit_note_to_ringgit (before
-- insert or update) is kept, still sorting after finance_credit_note_guard,
-- which has locked the invoice for update and refused anything it refuses,
-- and after finance_credit_note_sign_off (a member issuing hears FIN14), and
-- before finance_void_stamp. Only a draft being written, or a draft being
-- issued, is looked at; an issued or void credit note is the guard's.
create or replace function private.finance_credit_note_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  inv record;
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    return new;
  end if;
  select currency, fx_rate into inv from public.finance_invoices
  where org_id = new.org_id and id = new.invoice_id;
  -- Not there, or not this caller's: the guard, the foreign key or row-level security answers.
  if not found then
    return new;
  end if;
  -- Always the invoice's (spec "On each document"), whatever the caller sent: a credit note makes no exchange
  -- difference. A posted invoice always has its rate; the guard has refused a credit note on any other.
  new.currency := inv.currency;
  new.fx_rate := coalesce(inv.fx_rate, 1);
  new.amount_myr := null;
  if new.status = 'issued' and inv.currency <> 'MYR' then
    -- The ringgit it takes off: at the invoice's rate, or exactly what is left when it clears the invoice
    -- (private.finance_fx_carried, the one closing rule). The guard holds the invoice locked; this credit
    -- note is not yet issued in what finance_invoice_totals reads, so the balance is the one before it.
    new.amount_myr := private.finance_fx_carried(new.org_id, new.invoice_id, new.amount, false);
  end if;
  return new;
end $$;
revoke all on function private.finance_credit_note_currency_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. Refunds: the allocation currency guard
-- ============================================================================
-- The text of 20261120110000 lines 411 to 439 (3b), with its two FIN41
-- branches (a credit note, and money out, against a foreign invoice) taken
-- out. FIN44, one payment in one currency, is kept. The trigger
-- finance_allocation_currency (and its WHEN clause) is kept, still sorting
-- before finance_allocation_guard.
create or replace function private.finance_allocation_currency_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  mine text := coalesce(private.finance_allocation_currency_of(new.org_id, new.invoice_id, new.credit_note_id), 'MYR');
begin
  -- 20261120120000: a refund against a foreign invoice or its credit note is allowed (FIN41 is gone).
  -- One payment, one currency (a bill or an expense is ringgit until stage 4).
  if exists (
    select 1 from public.finance_allocations x
    where x.org_id = new.org_id and x.transaction_id = new.transaction_id and x.id <> new.id
      and coalesce(private.finance_allocation_currency_of(x.org_id, x.invoice_id, x.credit_note_id), 'MYR') <> mine
  ) then
    raise exception 'one payment settles documents in one currency' using errcode = 'FIN44';
  end if;
  return new;
end $$;
revoke all on function private.finance_allocation_currency_guard() from public, anon, authenticated, service_role;

-- ============================================================================
-- 5. The transaction guard: the split in the payment's own currency
-- ============================================================================
-- A payment's split in the payment's own currency (ringgit, every account
-- being ringgit until stage 5): the sum of the split for ringgit documents;
-- for a split in another currency, the whole payment, which
-- private.finance_fx_settle shares out exactly and finance_transaction_to_ringgit
-- holds at the move out of draft. No split: 0, as the old sum was. Runs as
-- the caller, from inside the guard; the private schema is not reachable
-- through the API.
create function private.finance_split_in_payment_terms(target_org uuid, target_txn uuid, payment_amount numeric)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when bool_or(coalesce(private.finance_allocation_currency_of(a.org_id, a.invoice_id, a.credit_note_id), 'MYR') <> 'MYR')
      then payment_amount
    else coalesce(sum(a.amount), 0)
  end
  from public.finance_allocations a
  where a.org_id = target_org and a.transaction_id = target_txn;
$$;
revoke all on function private.finance_split_in_payment_terms(uuid, uuid, numeric) from public, anon, service_role;
grant execute on function private.finance_split_in_payment_terms(uuid, uuid, numeric) to authenticated;

-- The text of 20261028100000_bendahara_cash_book.sql lines 512 to 779, the
-- newest definition on main (security invoker, search_path ''; revoked from
-- public, anon, authenticated at line 1007, said again below), with four
-- changes. FIN48, before the posted-to-void return (see the comment there;
-- foreign invoices only). And the three places that compare the payment with its split
-- ("the split is more than the payment", FIN03; "money out that settles no
-- document", when a draft is scheduled or paid and when a scheduled one is
-- changed where it stands) read private.finance_split_in_payment_terms
-- instead of sum(a.amount). A refund of a USD credit note is ringgit out
-- against a split in dollars; the old sum would take RM 445.00 paid out
-- against USD 108.00 for RM 337.00 that settles no document and stamp the
-- owner as approving it (or refuse a member FIN14 for that reason rather than
-- the sign-off's). For every ringgit payment the helper is the old sum, so
-- nothing else moves.
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

  -- A payment stays in the workspace it was recorded in. Asked first, before
  -- anything below can let an update through. org_id is an ordinary column,
  -- and the row's own references (account, contact, category) can be
  -- re-pointed in the same statement, so nothing else stops a payment made
  -- in a workspace its maker owns from being moved into one where they are
  -- only a member, and approved on the way by the rules of the first.
  if new.org_id is distinct from old.org_id then
    raise exception 'a payment does not move to another workspace' using errcode = 'FIN09';
  end if;

  -- A deleted user is cleared from these two columns by their foreign keys.
  -- That update is made by the foreign key's own trigger, so this guard runs
  -- one level down (pg_trigger_depth() > 1); a signed-in person's own update,
  -- which runs at the first level, is not let through here, or anyone who may
  -- write could erase who approved a payment. A session with no signed-in
  -- user (a migration, the SQL editor) may clear them by hand, and an update
  -- that changes nothing is let through as it always was.
  if new.status = old.status
     and (to_jsonb(new) - 'created_by' - 'approved_by') = (to_jsonb(old) - 'created_by' - 'approved_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.approved_by is null or new.approved_by = old.approved_by)
     and (pg_trigger_depth() > 1 or auth.uid() is null or to_jsonb(new) = to_jsonb(old)) then
    return new;
  end if;

  -- 20261120120000: money in that settled an invoice in another currency is not voided while a credit note
  -- issued (or dated) after it stands on that invoice (FIN48). That credit note's ringgit was worked out against
  -- the balance the payment left; with the payment gone it would be the movement that clears the invoice, and
  -- the sen of line rounding would stay on Receivable for ever. Void the credit note first, then the payment,
  -- and issue the credit note again: it then takes the closing figure. "Issued after" is issued_at at or after
  -- the payment's created_at (a payment in is recorded and posted in one call), so a credit note issued in the
  -- same transaction counts too. Only invoices in another currency are looked at: a ringgit void is as it was.
  if old.status = 'posted' and new.status = 'void' and old.direction = 'in' and exists (
    select 1
    from public.finance_allocations a
    join public.finance_invoices i on i.org_id = a.org_id and i.id = a.invoice_id
    join public.finance_credit_notes n on n.org_id = i.org_id and n.invoice_id = i.id
    where a.org_id = old.org_id and a.transaction_id = old.id
      and i.currency <> 'MYR'
      and n.status = 'issued'
      and (n.issued_at >= old.created_at or n.credit_date > old.txn_date)
  ) then
    raise exception 'void the credit note first, then the payment; issue the credit note again after' using errcode = 'FIN48';
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
    -- 20261120120000: in the payment's own currency (private.finance_split_in_payment_terms).
    allocated := private.finance_split_in_payment_terms(old.org_id, old.id, new.amount);
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
      where a.org_id = old.org_id and a.transaction_id = old.id
        and (a.invoice_id is not null or a.credit_note_id is not null)
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

  -- ---- approval ---------------------------------------------------------------
  -- Who approved and when is written below, by this guard, and by nobody
  -- else. Without this a payment's own maker could fill in approved_at on a
  -- draft, or on a scheduled payment nobody had to approve, and every rule
  -- below that reads it would take the payment for an approved one. It comes
  -- after the checks above, so a posted or void payment still answers FIN09.
  -- A session with no signed-in user is not held to it: the demo seed gives
  -- approved_at a date of its own.
  if auth.uid() is not null
     and (new.approved_at is distinct from old.approved_at or new.approved_by is distinct from old.approved_by) then
    raise exception 'only the database records who approved a payment' using errcode = 'FIN14';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'rejected' then
      raise exception 'a rejected payment is deleted, not brought back' using errcode = 'FIN14';
    end if;
    if new.status = 'pending_approval' and old.status <> 'draft' then
      raise exception 'only a draft is submitted for approval' using errcode = 'FIN14';
    end if;
    if old.status = 'pending_approval' and new.status not in ('scheduled','rejected') then
      raise exception 'a payment waiting for approval is approved, rejected or deleted' using errcode = 'FIN14';
    end if;
    if new.status = 'rejected' and old.status not in ('draft','pending_approval') then
      raise exception 'only a payment that has not been approved is rejected' using errcode = 'FIN14';
    end if;
    if old.status = 'scheduled' and old.approved_at is not null then
      if new.status <> 'posted' then
        raise exception 'an approved payment is paid or deleted' using errcode = 'FIN14';
      end if;
      if (to_jsonb(new) - 'status' - 'number' - 'txn_date' - 'updated_at')
         is distinct from (to_jsonb(old) - 'status' - 'number' - 'txn_date' - 'updated_at') then
        raise exception 'an approved payment is paid as it was approved' using errcode = 'FIN14';
      end if;
    end if;

    if new.status = 'rejected' or old.status = 'pending_approval' then
      -- A decision: approved (scheduled) or rejected.
      -- Asked of the workspace the payment is in before the write and after
      -- it, here and at the two places below. They are the same (see the top
      -- of this guard); the rule does not lean on that.
      if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
        raise exception 'only an owner or admin approves or rejects a payment' using errcode = 'FIN14';
      end if;
      if old.status = 'pending_approval'
         and (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
             is distinct from (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
        raise exception 'a payment is approved or rejected as it was submitted' using errcode = 'FIN14';
      end if;
      if auth.uid() is not null then
        new.approved_by := auth.uid();
        new.approved_at := now();
      else
        new.approved_at := coalesce(new.approved_at, now());
      end if;
    elsif new.direction = 'out' and new.status in ('scheduled','posted') and old.approved_at is null then
      -- Money out that settles no document: the part of the payment above its
      -- split. Looked at when a draft is scheduled or paid, and again when a
      -- scheduled payment nobody approved is paid, since its amount could
      -- have been raised in between.
      -- 20261120120000: in the payment's own currency (private.finance_split_in_payment_terms).
      allocated := private.finance_split_in_payment_terms(old.org_id, old.id, new.amount);
      if new.amount > allocated then
        if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
          raise exception 'money out that settles no document needs an owner or admin' using errcode = 'FIN14';
        end if;
        if auth.uid() is not null then
          new.approved_by := auth.uid();
          new.approved_at := now();
        else
          new.approved_at := coalesce(new.approved_at, now());
        end if;
      end if;
    end if;
  elsif old.status in ('pending_approval','rejected') then
    raise exception 'a payment waiting for approval, or rejected, cannot be changed' using errcode = 'FIN14';
  elsif old.status = 'scheduled' and old.approved_at is not null
        and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'an approved payment is paid as it was approved' using errcode = 'FIN14';
  elsif old.status = 'scheduled' and old.approved_at is null and new.direction = 'out' then
    -- A scheduled payment nobody had to approve, changed where it stands: its
    -- amount raised above its split, or money in turned into money out. It
    -- would then be money out that settles no document, sitting among the
    -- payments that are only waiting to be paid. The same rule as when it
    -- was scheduled: an owner or admin, who is written down as approving it.
    -- 20261120120000: in the payment's own currency (private.finance_split_in_payment_terms).
    allocated := private.finance_split_in_payment_terms(old.org_id, old.id, new.amount);
    if new.amount > allocated then
      if not (private.finance_may_decide(old.org_id) and private.finance_may_decide(new.org_id)) then
        raise exception 'money out that settles no document needs an owner or admin' using errcode = 'FIN14';
      end if;
      if auth.uid() is not null then
        new.approved_by := auth.uid();
        new.approved_at := now();
      else
        new.approved_at := coalesce(new.approved_at, now());
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.finance_transaction_guard() from public, anon, authenticated;

-- ============================================================================
-- 6. Recording a refund: the ringgit paid out
-- ============================================================================
-- The text of 20261030123000_finance_write_guards.sql lines 413 to 478, the
-- newest definition on main (security definer, the writer check first,
-- search_path ''; granted by the block at lines 613 to 626, said again
-- below), with three changes, all for a refund against an invoice in another
-- currency or a credit note on one (a ringgit refund does exactly what it
-- did):
--   * after the customer lookup and before anything is written: FIN47 when it
--     is asked as scheduled; the payment's amount is refund->>'amount_myr',
--     rounded to the sen (FIN46 when it is missing, not above 0, or NaN), and
--     the allocation keeps the foreign amount;
--   * private.finance_fx_settle (3b) writes the allocation's amount_myr and
--     carried_myr between the allocation and the move out of draft.
create or replace function public.finance_record_refund(target_org uuid, refund jsonb)
returns uuid
language plpgsql
security definer
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
  foreign_doc boolean;
  paid numeric;
begin
  -- Runs as the owner, so row-level security no longer asks this for it.
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

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

  -- 20261120120000: an invoice in another currency, or a credit note on one. The allocation is the foreign
  -- amount refunded (amt); the payment is the ringgit that left the account (every account is ringgit until
  -- stage 5), sent as refund->>'amount_myr'. It is paid now: the realised difference is decided when the
  -- money moves, and a scheduled payment's split is frozen before that (decision 7). Asked before anything
  -- is written.
  foreign_doc := coalesce(private.finance_allocation_currency_of(target_org, inv, note), 'MYR') <> 'MYR';
  if foreign_doc then
    if want <> 'posted' then
      raise exception 'a refund on an invoice in another currency is paid now' using errcode = 'FIN47';
    end if;
    paid := round(nullif(refund->>'amount_myr', '')::numeric, 2);
    -- NaN is above every number in Postgres, so it is named.
    if paid is null or not (paid > 0) or paid = 'NaN' then
      raise exception 'the ringgit paid out is needed' using errcode = 'FIN46';
    end if;
  else
    paid := amt;
  end if;

  insert into public.finance_transactions
    (org_id, direction, account_id, txn_date, amount, method, reference, contact_id, notes, status)
  values (
    target_org, 'out',
    (refund->>'account_id')::uuid,
    coalesce((refund->>'txn_date')::date, current_date),
    paid,
    refund->>'method',
    nullif(refund->>'reference', ''),
    customer,
    nullif(refund->>'notes', ''),
    'draft'
  )
  returning id into tid;

  insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
  values (target_org, tid, inv, note, amt, coalesce(nullif(refund->>'reason', ''), 'other'));

  -- 20261120120000: a foreign split takes its ringgit (amount_myr) and what it carried (carried_myr) while the
  -- refund is still a draft. Nothing is done for a ringgit split.
  perform private.finance_fx_settle(target_org, tid);

  if want = 'posted' then
    no := public.finance_next_number(target_org, 'voucher');
  end if;
  update public.finance_transactions
     set status = want, number = no, updated_at = now()
   where org_id = target_org and id = tid;
  return tid;
end $$;
revoke all on function public.finance_record_refund(uuid, jsonb) from public, anon;
grant execute on function public.finance_record_refund(uuid, jsonb) to authenticated;

-- ============================================================================
-- 7. finance_invoice_totals (REPLACED)
-- ============================================================================
-- The text of 20261120110000 lines 874 to 982 (3b), the newest definition on
-- main, with one change: k's credited_myr is what each issued credit note
-- took off in ringgit, coalesce(amount_myr, amount) (the amount for a
-- ringgit invoice), so balance_myr counts it. The 36 columns are as they
-- were, in place; security_invoker is said again.
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
  v.set_off::numeric(14,2) as set_off,
  i.currency,
  i.fx_rate,
  i.fx_rate_source,
  i.fx_rate_date,
  i.fx_rate_provider,
  i.fx_rate_reference,
  i.supply_date,
  (case when i.fx_rate is null then null else coalesce(l.subtotal_myr, 0) end)::numeric(14,2) as subtotal_myr,
  (case when i.fx_rate is null then null else coalesce(l.sst_myr, 0) end)::numeric(14,2) as sst_myr,
  (case when i.fx_rate is null then null else coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) end)::numeric(14,2) as total_myr,
  -- 20261120110000: what each posted payment carried off, in ringgit (balance for a ringgit invoice).
  (case when i.fx_rate is null then null else w.balance_myr end)::numeric(14,2) as balance_myr,
  (case when i.fx_rate is null then null else w.paid_myr end)::numeric(14,2) as paid_myr
from public.finance_invoices i
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(amount) as subtotal, sum(sst_amount) as sst, sum(amount_myr) as subtotal_myr, sum(sst_amount_myr) as sst_myr
  from public.finance_invoice_lines
  where org_id = i.org_id and invoice_id = i.id
) l on true
left join lateral (
  -- Only posted money in counts as paid.
  select sum(a.amount) as paid, sum(coalesce(a.carried_myr, a.amount)) as paid_myr
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'in' and t.status = 'posted'
) p on true
left join lateral (
  -- Only issued credit notes reduce what is owed.
  -- 20261120120000: in ringgit, what each took off (amount_myr; the amount for a ringgit invoice).
  select sum(n.amount) as credited, sum(coalesce(n.amount_myr, n.amount)) as credited_myr
  from public.finance_credit_notes n
  where n.org_id = i.org_id and n.invoice_id = i.id and n.status = 'issued'
) k on true
left join lateral (
  -- Posted money out against the invoice itself.
  select sum(a.amount) as refunded, sum(coalesce(a.carried_myr, a.amount)) as refunded_myr
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = i.org_id and a.invoice_id = i.id and t.direction = 'out' and t.status = 'posted'
) ri on true
left join lateral (
  -- Posted money out against one of the invoice's credit notes.
  select sum(a.amount) as refunded, sum(coalesce(a.carried_myr, a.amount)) as refunded_myr
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
) v
cross join lateral (
  -- 20261120110000: the same balance in ringgit. Money in and refunds count at what they carried
  -- (carried_myr; the amount for a ringgit document); 20261120120000: credit notes at what they took off
  -- (amount_myr); contra entries are ringgit (refused on a foreign invoice for all of stage 3).
  select
    coalesce(p.paid_myr, 0) as paid_myr,
    coalesce(l.subtotal_myr, 0) + coalesce(l.sst_myr, 0) - coalesce(p.paid_myr, 0) - coalesce(k.credited_myr, 0)
      + coalesce(ri.refunded_myr, 0) + coalesce(rn.refunded_myr, 0)
      - coalesce(sc.set_off, 0) as balance_myr
) w;
revoke all on public.finance_invoice_totals from anon, authenticated, service_role;
grant select on public.finance_invoice_totals to authenticated;

-- ============================================================================
-- 8. finance_ledger_lines (REPLACED)
-- ============================================================================
-- The text of 20261120110000 lines 1006 to 1407 (3b), the newest definition on
-- main, with changes to the credit note branch only (as the spec's ledger
-- table has it): Sales is amount_myr less the share, SST Payable the share,
-- Accounts Receivable amount_myr, the share being round(amount_myr x invoice
-- SST in ringgit / invoice total in ringgit, 2) from the invoice's
-- amount_myr and sst_amount_myr lines. For a ringgit credit note amount_myr
-- is null (the amount) and the lines' ringgit figures are their figures, so
-- every entry is what it was (compared at the end of this file, every
-- workspace, row for row). The refund rows were made ringgit by 3b. The same
-- ten columns, so "create or replace" keeps the view, its grants and
-- finance_ledger_balances.
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
  -- 20261120100000: in ringgit, from the lines' generated amount_myr and
  -- sst_amount_myr (equal to amount and sst_amount at rate 1), so a foreign
  -- invoice posts its ringgit and a ringgit one posts what it always did.
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
    select coalesce(sum(il.amount_myr), 0) as subtotal, coalesce(sum(il.sst_amount_myr), 0) as sst
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
  -- 20261120120000: in ringgit. The credit note's amount_myr (what it took
  -- off the invoice, at the invoice's rate or the closing figure; null, so
  -- the amount, for a ringgit invoice), and the share from the invoice's
  -- ringgit lines. At rate 1 every figure is the one it was.
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
      coalesce(sum(il.amount_myr), 0) + coalesce(sum(il.sst_amount_myr), 0) as total,
      coalesce(sum(il.sst_amount_myr), 0) as sst
    from public.finance_invoice_lines il
    where il.org_id = n.org_id and il.invoice_id = n.invoice_id
  ) t
  cross join lateral (select coalesce(n.amount_myr, n.amount) as amount_myr) m
  cross join lateral (
    select least(coalesce(round(m.amount_myr * t.sst / nullif(t.total, 0), 2), 0), m.amount_myr) as sst_share
  ) sh
  cross join lateral (values
    (null::uuid, null::text, null::uuid, null::uuid, 'sales'::text, (m.amount_myr - sh.sst_share)::numeric, 0::numeric),
    (null::uuid, 'sst_payable'::text, null::uuid, null::uuid, null::text, sh.sst_share::numeric, 0::numeric),
    (null::uuid, 'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, m.amount_myr::numeric)
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
      -- 20261120110000: what the split used of the payment, and what the documents carried, in ringgit.
      -- Both are the amount for a ringgit document (null columns).
      coalesce(sum(coalesce(a.amount_myr, a.amount)), 0) as allocated_myr,
      coalesce(sum(coalesce(a.carried_myr, a.amount)), 0) as carried_myr,
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
      case when t.category_id is not null then greatest(t.amount - k.allocated_myr, 0) else 0 end as to_category
  ) p
  cross join lateral (
    -- Only money out that is not a refund has a part for expenses.
    select
      case when p.source = 'payment_out' then least(k.expenses, t.amount - p.to_category) else 0 end as to_expenses
  ) q
  cross join lateral (
    -- 20261120110000: realised exchange gain (above 0) or loss (below 0) on documents in another
    -- currency: the ringgit received less the ringgit they carried (money in), or the ringgit they
    -- carried less the ringgit paid out (a refund). 0 for ringgit documents, whose two figures are equal.
    select
      case p.source
        when 'payment_in' then k.allocated_myr - k.carried_myr
        when 'refund' then k.carried_myr - k.allocated_myr
        else 0
      end as realised
  ) g
  cross join lateral (values
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then t.amount else 0 end)::numeric,
      (case when t.direction = 'out' then t.amount else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out'
            then t.amount - p.to_category - q.to_expenses
                 + case when p.source = 'refund' then k.carried_myr - k.allocated_myr else 0 end
            else 0 end)::numeric,
      (case when t.direction = 'in' then t.amount - p.to_category - k.allocated_myr + k.carried_myr else 0 end)::numeric),
    (null::uuid, 'accrued_expenses'::text, null::uuid, null::uuid, null::text,
      q.to_expenses::numeric,
      0::numeric),
    (null::uuid, null::text, null::uuid, t.category_id, null::text,
      (case when t.direction = 'out' then p.to_category else 0 end)::numeric,
      (case when t.direction = 'in' then p.to_category else 0 end)::numeric),
    -- 20261120110000: the realised difference, a gain as a credit and a loss as a debit. 0 drops out.
    (null::uuid, 'fx_realised'::text, null::uuid, null::uuid, null::text,
      greatest(-g.realised, 0)::numeric, greatest(g.realised, 0)::numeric)
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
-- 9. finance_credit_note_totals, finance_refunds (REPLACED)
-- ============================================================================
-- finance_credit_note_totals: the text of
-- 20261022100000_bendahara_sales_followons.sql lines 286 to 315;
-- finance_refunds: the same file, lines 321 to 352 (neither redefined since).
-- Each keeps its columns in place and appends the new ones. "create or
-- replace" keeps the views and their readers; security_invoker is said again,
-- and service_role is named in the revoke as 20261116110000 left it (it holds
-- nothing).
create or replace view public.finance_credit_note_totals with (security_invoker = true) as
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
  coalesce(r.refunded, 0)::numeric(14,2) as refunded,
  -- 20261120120000: amount and refunded are in the invoice's currency, which is the credit note's; its rate is
  -- the invoice's. amount_myr is what it took off in ringgit: the amount for a ringgit invoice, null while a
  -- foreign one is a draft (it is worked out when it is issued).
  n.currency,
  n.fx_rate,
  (case when n.currency = 'MYR' then n.amount else n.amount_myr end)::numeric(14,2) as amount_myr
from public.finance_credit_notes n
join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
left join lateral (
  select sum(a.amount) as refunded
  from public.finance_allocations a
  join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
  where a.org_id = n.org_id and a.credit_note_id = n.id and t.direction = 'out' and t.status = 'posted'
) r on true;
revoke all on public.finance_credit_note_totals from anon, authenticated, service_role;
grant select on public.finance_credit_note_totals to authenticated;

create or replace view public.finance_refunds with (security_invoker = true) as
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
  t.created_at,
  -- 20261120120000: amount is in the invoice's currency. In ringgit: what the refund used of the ringgit paid
  -- out, what the invoice carried for the part refunded, and the realised difference, carried less paid out
  -- (spec "The difference"; above 0 a gain). Null until a foreign split is settled.
  i.currency,
  (case when i.currency = 'MYR' then a.amount else a.amount_myr end)::numeric(14,2) as amount_myr,
  (case when i.currency = 'MYR' then a.amount else a.carried_myr end)::numeric(14,2) as carried_myr,
  (case when i.currency = 'MYR' then 0 else a.carried_myr - a.amount_myr end)::numeric(14,2) as realised_myr
from public.finance_allocations a
join public.finance_transactions t on t.org_id = a.org_id and t.id = a.transaction_id
left join public.finance_credit_notes n on n.org_id = a.org_id and n.id = a.credit_note_id
join public.finance_invoices i on i.org_id = a.org_id and i.id = coalesce(a.invoice_id, n.invoice_id)
join public.finance_contacts c on c.org_id = i.org_id and c.id = i.customer_id
join public.finance_accounts acc on acc.org_id = t.org_id and acc.id = t.account_id
where t.direction = 'out';
revoke all on public.finance_refunds from anon, authenticated, service_role;
grant select on public.finance_refunds to authenticated;

-- ============================================================================
-- 10. Nothing is out of place, and nothing moved
-- ============================================================================
do $$
declare
  t text;
  n integer;
  started timestamptz := clock_timestamp();
begin
  -- Triggers, in name order (the order BEFORE ROW triggers fire in): as 3a and 3b left them.
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_credit_notes'::regclass and not tgisinternal;
  if t is distinct from 'finance_credit_note_guard,finance_credit_note_sign_off,finance_credit_note_to_ringgit,finance_void_stamp' then
    raise exception 'triggers on finance_credit_notes are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_transactions'::regclass and not tgisinternal;
  if t is distinct from 'finance_transaction_guard,finance_transaction_insert_guard,finance_transaction_sign_off,'
       || 'finance_transaction_still,finance_transaction_to_ringgit,finance_transaction_unmatch,finance_transfer_id_guard,'
       || 'finance_transfer_pair_delete,finance_transfer_pair_insert,finance_transfer_pair_update,finance_use_account_insert,'
       || 'finance_use_account_update,finance_void_stamp' then
    raise exception 'triggers on finance_transactions are: %', t;
  end if;
  select string_agg(tgname, ',' order by tgname) into t from pg_catalog.pg_trigger
   where tgrelid = 'public.finance_allocations'::regclass and not tgisinternal;
  if t is distinct from 'finance_allocation_currency,finance_allocation_guard,finance_allocation_less_contra,finance_allocation_still' then
    raise exception 'triggers on finance_allocations are: %', t;
  end if;

  -- The views kept their columns in place; two appended new ones.
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_invoice_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,customer_id,customer_name,invoice_no,invoice_date,due_date,notes,status,posted_at,'
       || 'einvoice_status,einvoice_uuid,created_by,created_at,updated_at,subtotal,sst,total,paid,balance,'
       || 'display_status,credited,refunded,set_off,currency,fx_rate,fx_rate_source,fx_rate_date,fx_rate_provider,'
       || 'fx_rate_reference,supply_date,subtotal_myr,sst_myr,total_myr,balance_myr,paid_myr' then
    raise exception 'finance_invoice_totals columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_credit_note_totals'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'id,org_id,invoice_id,invoice_no,customer_id,customer_name,credit_note_no,credit_date,reason,'
       || 'amount,notes,status,issued_at,created_by,created_at,updated_at,refunded,currency,fx_rate,amount_myr' then
    raise exception 'finance_credit_note_totals columns are: %', t;
  end if;
  select string_agg(attname, ',' order by attnum) into t from pg_catalog.pg_attribute
   where attrelid = 'public.finance_refunds'::regclass and attnum > 0 and not attisdropped;
  if t is distinct from 'allocation_id,transaction_id,org_id,number,txn_date,method,amount,transaction_amount,status,'
       || 'reference,reason,notes,account_id,account_name,invoice_id,invoice_no,credit_note_id,credit_note_no,'
       || 'customer_id,customer_name,created_at,currency,amount_myr,carried_myr,realised_myr' then
    raise exception 'finance_refunds columns are: %', t;
  end if;

  -- Every credit note is a ringgit one, at rate 1, with no ringgit figure of its own, and in its invoice's currency.
  select count(*) into n from public.finance_credit_notes cn
   join public.finance_invoices i on i.org_id = cn.org_id and i.id = cn.invoice_id
   where cn.currency <> 'MYR' or cn.fx_rate <> 1 or cn.amount_myr is not null or i.currency::text <> cn.currency::text;
  if n <> 0 then
    raise exception '% credit notes are not ringgit credit notes on ringgit invoices', n;
  end if;
  -- No allocation's figures were touched by this file, ringgit or settled foreign, row for row, both ways.
  select count(*) into n from (
    (select id, amount, amount_myr, carried_myr from public.finance_allocations
     except all select * from fx3c_allocations_before)
    union all
    (select * from fx3c_allocations_before
     except all select id, amount, amount_myr, carried_myr from public.finance_allocations)
  ) d;
  if n <> 0 then
    raise exception '% allocations do not read as they did', n;
  end if;

  -- Every invoice reads as it did, all 36 columns, both ways.
  select count(*) into n from (
    (select * from public.finance_invoice_totals except all select * from fx3c_totals_before)
    union all
    (select * from fx3c_totals_before except all select * from public.finance_invoice_totals)
  ) d;
  if n <> 0 then
    raise exception '% invoices do not read as they did', n;
  end if;

  -- The ledger, every workspace, row for row, both ways.
  select count(*) into n from (
    (select * from public.finance_ledger_lines except all select * from fx3c_ledger_before)
    union all
    (select * from fx3c_ledger_before except all select * from public.finance_ledger_lines)
  ) d;
  if n <> 0 then
    raise exception '% ledger lines changed', n;
  end if;

  -- Payments in and cash receipts: not replaced here, and still what they were, both ways.
  select count(*) into n from (
    (select * from public.finance_payments_in except all select * from fx3c_payments_in_before)
    union all
    (select * from fx3c_payments_in_before except all select * from public.finance_payments_in)
  ) d;
  if n <> 0 then
    raise exception '% payments in do not read as they did', n;
  end if;
  select count(*) into n from (
    (select * from public.finance_cash_receipts except all select * from fx3c_cash_receipts_before)
    union all
    (select * from fx3c_cash_receipts_before except all select * from public.finance_cash_receipts)
  ) d;
  if n <> 0 then
    raise exception '% cash receipts do not read as they did', n;
  end if;

  -- Credit notes and refunds: the columns they had, row for row, both ways; the new ones are ringgit's.
  select count(*) into n from (
    (select id, org_id, invoice_id, invoice_no, customer_id, customer_name, credit_note_no, credit_date, reason,
            amount, notes, status, issued_at, created_by, created_at, updated_at, refunded
     from public.finance_credit_note_totals
     except all select * from fx3c_credit_notes_before)
    union all
    (select * from fx3c_credit_notes_before
     except all
     select id, org_id, invoice_id, invoice_no, customer_id, customer_name, credit_note_no, credit_date, reason,
            amount, notes, status, issued_at, created_by, created_at, updated_at, refunded
     from public.finance_credit_note_totals)
  ) d;
  if n <> 0 then
    raise exception '% credit notes do not read as they did', n;
  end if;
  select count(*) into n from public.finance_credit_note_totals
   where currency <> 'MYR' or fx_rate <> 1 or amount_myr is distinct from amount;
  if n <> 0 then
    raise exception '% credit notes have ringgit figures that are not their figures', n;
  end if;
  select count(*) into n from (
    (select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, reason, notes, account_id, account_name, invoice_id, invoice_no, credit_note_id, credit_note_no,
            customer_id, customer_name, created_at
     from public.finance_refunds
     except all select * from fx3c_refunds_before)
    union all
    (select * from fx3c_refunds_before
     except all
     select allocation_id, transaction_id, org_id, number, txn_date, method, amount, transaction_amount, status,
            reference, reason, notes, account_id, account_name, invoice_id, invoice_no, credit_note_id, credit_note_no,
            customer_id, customer_name, created_at
     from public.finance_refunds)
  ) d;
  if n <> 0 then
    raise exception '% refunds do not read as they did', n;
  end if;
  select count(*) into n from public.finance_refunds
   where currency <> 'MYR' or amount_myr is distinct from amount or carried_myr is distinct from amount or realised_myr <> 0;
  if n <> 0 then
    raise exception '% refunds have ringgit figures that are not their figures', n;
  end if;

  -- Every bank and cash account's balance, both ways.
  select count(*) into n from (
    (select * from public.finance_account_balances except all select * from fx3c_balances_before)
    union all
    (select * from fx3c_balances_before except all select * from public.finance_account_balances)
  ) d;
  if n <> 0 then
    raise exception '% account balances changed', n;
  end if;

  -- Who may call what.
  if has_function_privilege('anon', 'public.finance_record_refund(uuid, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.finance_record_refund(uuid, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_record_refund(uuid, jsonb)', 'execute') then
    raise exception 'public.finance_record_refund is not callable by exactly the signed-in';
  end if;
  foreach t in array array[
    'private.finance_fx_carried(uuid, uuid, numeric, boolean)',
    'private.finance_split_in_payment_terms(uuid, uuid, numeric)'
  ] loop
    if has_function_privilege('anon', t, 'execute') or has_function_privilege('service_role', t, 'execute')
       or not has_function_privilege('authenticated', t, 'execute') then
      raise exception '% is not callable by exactly the signed-in', t;
    end if;
  end loop;
  foreach t in array array[
    'private.finance_credit_note_currency_guard()', 'private.finance_allocation_currency_guard()'
  ] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute')
       or has_function_privilege('service_role', t, 'execute') then
      raise exception '% can be called directly', t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'private.finance_transaction_guard()', 'execute')
     or has_function_privilege('anon', 'private.finance_transaction_guard()', 'execute') then
    raise exception 'private.finance_transaction_guard can be called directly';
  end if;
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'finance_record_refund' and p.prosecdef;
  if n <> 1 then
    raise exception 'finance_record_refund no longer runs as its owner';
  end if;
  select count(*) into n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'private'
     and p.proname in ('finance_fx_carried', 'finance_split_in_payment_terms', 'finance_credit_note_currency_guard',
                       'finance_allocation_currency_guard', 'finance_transaction_guard')
     and p.prosecdef;
  if n <> 0 then
    raise exception 'a guard or a helper runs as its owner';
  end if;

  -- The views read as their caller, and service_role holds nothing on what this file touched.
  foreach t in array array['public.finance_invoice_totals', 'public.finance_ledger_lines',
                           'public.finance_credit_note_totals', 'public.finance_refunds'] loop
    if not exists (select 1 from pg_catalog.pg_class where oid = t::regclass and reloptions @> array['security_invoker=true']) then
      raise exception '% no longer reads as its caller', t;
    end if;
  end loop;
  select string_agg(c.relname, ',' order by c.relname) into t
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('finance_credit_notes', 'finance_transactions', 'finance_allocations', 'finance_invoice_totals',
                       'finance_ledger_lines', 'finance_credit_note_totals', 'finance_refunds')
     and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'service_role'::regrole);
  if t is not null then
    raise exception 'service_role holds a privilege on: %', t;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'finance_credit_notes' and grantee = 'service_role';
  if n <> 0 then
    raise exception 'service_role holds a column privilege on finance_credit_notes';
  end if;

  raise notice 'fx3c: the last block took %', clock_timestamp() - started;
end $$;
