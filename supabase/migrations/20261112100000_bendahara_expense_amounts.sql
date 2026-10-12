-- Bendahara: an expense's amount and its SST are numbers a person can read.
--
-- finance_expenses.amount has had "check (amount > 0)" and sst_amount
-- "check (sst_amount >= 0)" since 20261028100000_bendahara_cash_book. NaN is a
-- value of the numeric type, and Postgres orders it above every number and
-- equal to itself, so NaN passes "> 0", passes ">= 0", and an SST of NaN
-- passes "sst_amount <= amount" when the amount is NaN too. An expense of NaN
-- could therefore be saved through finance_save_expense (its amount comes
-- from JSON as text), be approved, and then make every total that adds it up
-- read NaN: the Expenses figures and the ledger's expense lines.
--
-- This file adds two check constraints that refuse NaN by name. Nothing else
-- changes: no function, no trigger, no policy, no grant. finance_save_expense
-- is not replaced; it is refused by the constraint (23514), as it already is
-- for an amount of 0. finance_receipt_to_expense has refused NaN itself since
-- 20261107100000_bendahara_receipts_inbox and still does, first.
--
-- Additive, and safe to apply while the previous code is still deployed: that
-- code only reads finance_expenses. What it locks: ACCESS EXCLUSIVE on
-- public.finance_expenses, once, for the one ALTER TABLE below, during which
-- every row of the table is read to prove it passes both checks. Reads and
-- writes of that table wait for as long as that takes (a table of a few
-- hundred rows: milliseconds). No other table is locked. If a row holds NaN
-- already the statement fails with 23514 and nothing is changed: the
-- controller's steps count such rows first.
--
-- Nothing here is granted to service_role, which has no rights on this table.

-- Fail fast instead of queueing behind a long transaction.
set local lock_timeout = '5s';

alter table public.finance_expenses
  add constraint finance_expenses_amount_not_nan check (amount <> 'NaN'::numeric),
  add constraint finance_expenses_sst_amount_not_nan check (sst_amount <> 'NaN'::numeric);
