-- Bendahara ledger, part 4 of 4: the ledger itself (additive; nothing
-- deployed reads it).
--
--   * finance_ledger_lines: one row per journal line, worked out from the
--     posted documents and from posted manual journals. Nothing is stored
--     for a document, so there is nothing to back-fill and nothing to drift:
--     a document that is posted is in the books, and one that is voided has
--     left them.
--   * finance_ledger_balances: one row per account, with its totals.
--
-- Both run as whoever reads them (security_invoker), so the row-level
-- security of every table underneath applies. Each of those tables is read
-- by any member of the workspace under the same policy
-- (private.is_org_member(org_id)): finance_invoices, finance_invoice_lines,
-- finance_credit_notes, supplier_bills, supplier_bill_lines,
-- finance_expenses, finance_transactions, finance_allocations,
-- finance_contacts, finance_accounts, finance_ledger_accounts; and posted
-- journals and their lines. Of finance_accounts only id, org_id, name,
-- opening_balance and opening_date are read, all of them columns the
-- authenticated role may select (20261030123000 closed account_no). No
-- "*_totals" view is read: the sums are taken from the base tables with the
-- expressions those views use, so both sides of an entry are one number.
--
-- ---- how each entry is known to balance ---------------------------------------
-- Every money column underneath is numeric(14,2), already rounded to the sen
-- when it was stored (line amounts and line SST are generated columns that
-- round). The view adds and subtracts them and never multiplies, except once,
-- for a credit note, where the product is rounded and the other line is
-- found by subtraction. So no entry can be out by a sen:
--   invoice      debit  (sum of line amounts + sum of line SST)
--                credit (sum of line amounts) and (sum of line SST)
--   credit note  debit  (amount - share) and (share);  credit amount
--   payment      one side the payment's amount A; the other side
--                (A - c) and c, where c is the part that goes to a category
--   bill         debit and credit the same sum(amount + sst_amount)
--   expense      debit and credit the same amount
--   transfer     debit and credit the paying side's amount
--   opening      debit and credit the same absolute opening balance
--   journal      debits equal credits or it could not have been posted
--
-- ---- what is in, once -------------------------------------------------------------
-- A document is one entry, keyed by its own row: an invoice, a credit note,
-- a bill and an expense by their id; a payment by the id of its
-- finance_transactions row, however many documents it settles; a transfer by
-- its transfer_id, so its two rows make one entry and neither is a payment
-- (the payment branch takes only rows with no transfer_id, the transfer
-- branch only rows with one); an opening balance by its bank account.
--   * A payment split over two invoices: one entry, one bank line for the
--     whole amount and one Accounts Receivable line for the whole amount.
--   * A payment against a bill and an expense together cannot be recorded
--     (one payment pays one kind of document, FIN06 in
--     private.finance_allocation_guard); if it could, both are Accounts
--     Payable and it would still be one entry of two lines.
--   * A voided payment on a posted bill: the bill's entry stays, the
--     payment's is gone, and Accounts Payable shows the bill owed again.
--   * A document cannot be voided or rejected while a payment stands against
--     it (FIN02 in the guards on bills, invoices, credit notes and
--     expenses), so a posted payment never settles a document that has left
--     the books.
--
-- ---- which account ------------------------------------------------------------------
-- A line names its account by what the account stands for, and the outer
-- query finds it by one of four unique keys of finance_ledger_accounts:
-- system_key, bank_account_id, category_id, or default_for = 'sales' for the
-- account invoices credit. A manual journal line names its account outright.
-- The lookups are outer joins on purpose: if an account were ever missing,
-- the line would still be there, with no account_id, and the entry would
-- still balance, instead of one line silently dropping out of it.
-- An archived or renamed account is found all the same: lines appear under
-- the account as it is now.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

create view public.finance_ledger_lines with (security_invoker = true) as
select
  l.org_id,
  l.entry_key,
  l.entry_date,
  l.source,
  l.source_id,
  l.source_no,
  l.description,
  coalesce(l.acct, s.id, b.id, c.id, d.id) as account_id,
  l.debit::numeric(14,2) as debit,
  l.credit::numeric(14,2) as credit
from (
  -- ---- invoice: posted ------------------------------------------------------------
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
  where i.status = 'posted'

  union all

  -- ---- credit note: issued ----------------------------------------------------------
  -- Mirrors finance_invoice_totals, which takes only issued credit notes off
  -- what an invoice owes. A credit note is one amount, not lines, so its SST
  -- is the invoice's SST in proportion: amount * invoice SST / invoice total,
  -- rounded to the sen. The Sales line is the amount less that share, found
  -- by subtraction, so the two debits add back to the amount exactly whatever
  -- the rounding did. The share is never more than the amount (an invoice's
  -- SST is never more than its total); least() says so again.
  select
    n.org_id,
    'credit_note:' || n.id::text,
    n.credit_date,
    'credit_note'::text,
    n.id,
    n.credit_note_no,
    concat_ws(' ', 'Credit note', n.credit_note_no, 'on ' || i.invoice_no),
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
  where n.status = 'issued'

  union all

  -- ---- money in and money out: posted, and not a side of a transfer ----------------
  -- 'posted' is the one status that means the money has moved: it is what
  -- supplier_bill_totals, finance_invoice_totals, finance_expense_totals and
  -- finance_account_balances count. Drafts, payments waiting for approval,
  -- scheduled, rejected and void ones are out.
  --
  -- What it is follows finance_cash_receipts and finance_payment_vouchers:
  --   money in                          source 'payment_in'
  --   money out against invoices or
  --     credit notes (finance_refunds)  source 'refund'
  --   every other money out             source 'payment_out'
  --
  -- The bank or cash account takes the whole amount on one side. The other
  -- side is at most two lines:
  --   * to_category, on the payment's own category: the part of the payment
  --     that settles no document, when the payment has a category. A cash
  --     receipt for income and a payment voucher for a category have no
  --     split, so this is their whole amount.
  --   * the rest, on Accounts Receivable (money in, and refunds) or Accounts
  --     Payable (money out against bills or expenses): what settles
  --     documents.
  -- The two are the amount less to_category, and to_category, so they add to
  -- the bank line by construction.
  --
  -- The functions the app records money with never make a payment that both
  -- settles documents and carries a category (FIN15 in
  -- finance_save_cash_receipt, finance_post_cash_receipt and
  -- finance_record_voucher), and they make its amount exactly its split. No
  -- table constraint says either, though: the guards only hold the split to
  -- no more than the amount (FIN03), and call the part above it "money out
  -- that settles no document" (20261028100000, items 7 to 10). So a payment
  -- written by hand can be above its split. Its category then takes the part
  -- above the split, as that guard's wording has it. If it has no category,
  -- the whole amount stays on Accounts Receivable or Accounts Payable, as
  -- money received or paid on account, since there is no other account it
  -- could honestly go to. Either way the entry balances.
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
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_transactions t
  left join public.finance_contacts ct on ct.org_id = t.org_id and ct.id = t.contact_id
  cross join lateral (
    select
      coalesce(sum(a.amount), 0) as allocated,
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
  cross join lateral (values
    (null::uuid, null::text, t.account_id, null::uuid, null::text,
      (case when t.direction = 'in' then t.amount else 0 end)::numeric,
      (case when t.direction = 'out' then t.amount else 0 end)::numeric),
    (null::uuid, case when p.source = 'payment_out' then 'payable' else 'receivable' end, null::uuid, null::uuid, null::text,
      (case when t.direction = 'out' then t.amount - p.to_category else 0 end)::numeric,
      (case when t.direction = 'in' then t.amount - p.to_category else 0 end)::numeric),
    (null::uuid, null::text, null::uuid, t.category_id, null::text,
      (case when t.direction = 'out' then p.to_category else 0 end)::numeric,
      (case when t.direction = 'in' then p.to_category else 0 end)::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where t.status = 'posted' and t.transfer_id is null

  union all

  -- ---- supplier bill: posted ---------------------------------------------------------
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
  where sb.status = 'posted'

  union all

  -- ---- expense: approved -------------------------------------------------------------
  -- Mirrors finance_expense_totals: an expense counts once approved (it then
  -- reads 'approved' or 'paid'); pending and rejected ones are out. amount is
  -- what is to be paid, SST included, and all of it is the cost. Paying it is
  -- a payment out against it, above, which takes it off Accounts Payable.
  select
    e.org_id,
    'expense:' || e.id::text,
    e.expense_date,
    'expense'::text,
    e.id,
    null::text,
    concat_ws(' ', 'Expense', 'to ' || coalesce(ct.name, e.vendor_name)),
    v.acct, v.sys, v.bank, v.cat, v.dflt, v.debit, v.credit
  from public.finance_expenses e
  left join public.finance_contacts ct on ct.org_id = e.org_id and ct.id = e.vendor_id
  cross join lateral (values
    (null::uuid, null::text, null::uuid, e.category_id, null::text, e.amount::numeric, 0::numeric),
    (null::uuid, 'payable'::text, null::uuid, null::uuid, null::text, 0::numeric, e.amount::numeric)
  ) as v(acct, sys, bank, cat, dflt, debit, credit)
  where e.status = 'approved'

  union all

  -- ---- transfer between accounts: both sides posted ----------------------------------
  -- Two finance_transactions rows that share a transfer_id, money out of one
  -- account and money in to another (20261031090000;
  -- finance_bank_transactions calls both 'transfer'). One entry, read from
  -- the paying side: its date, its number and its amount on both lines.
  -- private.finance_transfer_pair_check holds the two sides to the same
  -- amount, date, number and status, so the receiving side would say the
  -- same; taking one amount for both lines is what makes this balance
  -- without leaning on that.
  select
    o.org_id,
    'transfer:' || o.transfer_id::text,
    o.txn_date,
    'transfer'::text,
    o.transfer_id,
    o.number,
    concat_ws(' ', 'Transfer', o.number, 'from ' || fa.name, 'to ' || ta.name),
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
    and o.status = 'posted' and i.status = 'posted'

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

  -- ---- manual journal: posted ---------------------------------------------------------
  -- As entered. The guard on journals refused to post it unless its debits
  -- equalled its credits, and a posted journal's lines cannot change.
  select
    jl.org_id,
    'journal:' || j.id::text,
    j.journal_date,
    'journal'::text,
    j.id,
    j.journal_no,
    j.description,
    jl.account_id, null::text, null::uuid, null::uuid, null::text, jl.debit::numeric, jl.credit::numeric
  from public.finance_journal_lines jl
  join public.finance_journals j on j.org_id = jl.org_id and j.id = jl.journal_id
  where j.status = 'posted'
) l
left join public.finance_ledger_accounts s on s.org_id = l.org_id and s.system_key = l.sys
left join public.finance_ledger_accounts b on b.org_id = l.org_id and b.bank_account_id = l.bank
left join public.finance_ledger_accounts c on c.org_id = l.org_id and c.category_id = l.cat
left join public.finance_ledger_accounts d on d.org_id = l.org_id and d.default_for = l.dflt
-- A line with no amount is left out: an invoice with no SST has no SST line.
where l.debit > 0 or l.credit > 0;

revoke all on public.finance_ledger_lines from anon, authenticated, service_role;
grant select on public.finance_ledger_lines to authenticated;

-- One row per account, those with no lines included (zeroes). balance is
-- debit less credit for asset and expense accounts, and credit less debit for
-- liability, equity and income accounts, so an account that is the way round
-- it is expected to be reads as a positive number.
create view public.finance_ledger_balances with (security_invoker = true) as
select
  a.org_id,
  a.id as account_id,
  coalesce(t.debit_total, 0)::numeric(14,2) as debit_total,
  coalesce(t.credit_total, 0)::numeric(14,2) as credit_total,
  (case
     when a.type in ('asset','expense') then coalesce(t.debit_total, 0) - coalesce(t.credit_total, 0)
     else coalesce(t.credit_total, 0) - coalesce(t.debit_total, 0)
   end)::numeric(14,2) as balance
from public.finance_ledger_accounts a
left join (
  select ll.org_id, ll.account_id, sum(ll.debit) as debit_total, sum(ll.credit) as credit_total
  from public.finance_ledger_lines ll
  group by ll.org_id, ll.account_id
) t on t.org_id = a.org_id and t.account_id = a.id;

revoke all on public.finance_ledger_balances from anon, authenticated, service_role;
grant select on public.finance_ledger_balances to authenticated;
