-- Demo data for Bendahara Cash Receipts, Payment Vouchers and Expenses in the
-- shared demo org, built from what the three mock-up screens showed. Dates
-- are relative to today. Skips when the demo org is missing or already has an
-- expense, and touches no other workspace.
--
-- Nothing is disabled: every row goes in the way the guards allow. An expense
-- is inserted as pending and then approved or rejected. A payment is inserted
-- as a draft, split against its expense where it pays one, and then posted
-- with its number, scheduled, or sent for approval and decided. A migration
-- has no signed-in user, which is the one case the approval rules do not ask
-- for an owner or admin (private.finance_may_decide), so approved_by stays
-- empty on these rows. The functions are not used because they take their
-- numbers from finance_next_number, which answers only to a signed-in editor
-- of the workspace.
--
-- Nothing here is put against an invoice or a bill, so Invoices, Payments In,
-- Refunds, Supplier Bills and Payments Out read exactly as they did. The
-- demo's payments to suppliers, refunds and payments in also show on Payment
-- Vouchers and Cash Receipts, which list every movement of money.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  cat uuid;
  payer uuid;
  eid uuid;
  txn uuid;
  pv integer;
  rc integer;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null or exists (select 1 from public.finance_expenses where org_id = demo) then
    return;
  end if;

  -- The accounts and categories every workspace starts with. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  perform private.finance_seed_categories(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  cash := coalesce(cash, bank);
  bank := coalesce(bank, cash);
  if bank is null then
    raise exception 'the demo org has no account for its cash book';
  end if;

  -- Vouchers and receipts are numbered after any the demo already has.
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'voucher'), 1),
           coalesce((select max(substring(number from '^PV-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^PV-[0-9]{1,9}$'), 1))
    into pv;
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'receipt'), 1),
           coalesce((select max(substring(number from '^RC-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^RC-[0-9]{1,9}$'), 1))
    into rc;

  -- ---- expenses: pending, then decided; a paid one gets its payment voucher ---
  -- paid_with is null for an expense that has not been paid. An expense is
  -- paid on the day it is dated.
  for r in
    select * from (values
      ( 1, 'Marketing', 'Billboard Kuala Lumpur',    3600::numeric,  0::numeric, 'pending',  null),
      ( 2, 'Rent',      'Menara Axis Management',    4500,           0,          'approved', 'bank_transfer'),
      ( 3, 'Utilities', 'Suria Utilities Sdn Bhd',   1280,           0,          'approved', 'fpx'),
      ( 4, 'Marketing', 'Meta Ads Malaysia',         2200,           0,          'pending',  null),
      ( 5, 'Travel',    'Grab Malaysia',              186,           0,          'approved', 'ewallet'),
      ( 6, 'Supplies',  'Printhub Solutions',         640,           0,          'approved', 'cash'),
      ( 7, 'Salaries',  'Payroll, September',        8900,           0,          'approved', 'bank_transfer'),
      ( 8, 'Utilities', 'Unifi Business',              94,           5.32,       'approved', 'card'),
      ( 9, 'Travel',    'AirAsia',                    420,           0,          'rejected', null),
      (10, 'Services',  'Syarikat Guaman Lee',       1500,           0,          'approved', null),
      -- Earlier months, so the trend chart has a shape.
      ( 38, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      ( 40, 'Salaries',  'Payroll, August',          8700,           0,          'approved', 'bank_transfer'),
      ( 45, 'Marketing', 'Meta Ads Malaysia',        1900,           0,          'approved', 'card'),
      ( 69, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      ( 70, 'Salaries',  'Payroll, July',            8700,           0,          'approved', 'bank_transfer'),
      ( 75, 'Utilities', 'Suria Utilities Sdn Bhd',  1310,           0,          'approved', 'fpx'),
      (100, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      (101, 'Salaries',  'Payroll, June',            8500,           0,          'approved', 'bank_transfer'),
      (130, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      (131, 'Salaries',  'Payroll, May',             8500,           0,          'approved', 'bank_transfer'),
      (161, 'Rent',      'Menara Axis Management',   4500,           0,          'approved', 'bank_transfer'),
      (162, 'Salaries',  'Payroll, April',           8300,           0,          'approved', 'bank_transfer'),
      (190, 'Marketing', 'Meta Ads Malaysia',        2400,           0,          'approved', 'card')
    ) as v(days_ago, category, vendor, amount, sst, status, paid_with)
  loop
    select id into cat from public.finance_categories
     where org_id = demo and kind = 'expense' and name = r.category;

    insert into public.finance_expenses (org_id, expense_date, category_id, vendor_name, amount, sst_amount, status)
    values (demo, current_date - r.days_ago, cat, r.vendor, r.amount, r.sst, 'pending')
    returning id into eid;
    if r.status <> 'pending' then
      update public.finance_expenses
         set status = r.status, approved_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = eid;
    end if;

    if r.paid_with is not null then
      insert into public.finance_transactions
        (org_id, direction, account_id, txn_date, amount, method, party_name, status)
      values (
        demo, 'out',
        case when r.paid_with = 'cash' then cash else bank end,
        current_date - r.days_ago, r.amount, r.paid_with, r.vendor, 'draft'
      )
      returning id into txn;
      insert into public.finance_allocations (org_id, transaction_id, expense_id, amount)
      values (demo, txn, eid, r.amount);
      update public.finance_transactions
         set status = 'posted', number = 'PV-' || lpad(pv::text, greatest(4, length(pv::text)), '0'), updated_at = now()
       where id = txn;
      pv := pv + 1;
    end if;
  end loop;

  -- ---- vouchers that settle no document: a draft, then where it got to --------
  for r in
    select * from (values
      ( 0, 'Tenaga Nasional Berhad',      'Utilities', 'bank_transfer', 960::numeric, 'scheduled'),
      ( 1, 'Syarikat Ramli & Anak',       'Rent',      'bank_transfer', 2200,         'pending_approval'),
      ( 4, 'Kurier Pantas Sdn Bhd',       'Services',  'bank_transfer', 2140,         'pending_approval'),
      ( 6, 'Syabas Air Selangor',         'Utilities', 'fpx',            420,         'posted'),
      ( 9, 'Majlis Bandaraya Shah Alam',  'Services',  'cash',           380,         'posted'),
      (12, 'Kedai Alat Tulis Maju',       'Supplies',  'cash',            75,         'rejected')
    ) as v(days_ago, payee, category, method, amount, status)
  loop
    select id into cat from public.finance_categories
     where org_id = demo and kind = 'expense' and name = r.category;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, party_name, category_id, status)
    values (
      demo, 'out',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, r.amount, r.method, r.payee, cat, 'draft'
    )
    returning id into txn;

    if r.status = 'posted' then
      update public.finance_transactions
         set status = 'posted', number = 'PV-' || lpad(pv::text, greatest(4, length(pv::text)), '0'),
             approved_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = txn;
      pv := pv + 1;
    elsif r.status = 'scheduled' then
      update public.finance_transactions
         set status = 'scheduled', approved_at = now(), updated_at = now()
       where id = txn;
    else
      update public.finance_transactions set status = 'pending_approval', updated_at = now() where id = txn;
      if r.status = 'rejected' then
        update public.finance_transactions
           set status = 'rejected', approved_at = now() - make_interval(days => r.days_ago), updated_at = now()
         where id = txn;
      end if;
    end if;
  end loop;

  -- ---- receipts for income that settles no invoice: a draft, then posted ------
  -- A payer who is one of the demo's contacts is tied to that contact; anyone
  -- else is a typed name.
  for r in
    select * from (values
      ( 0, 'Langkawi Fresh',          'cheque',        'Sales',        2180::numeric, 'draft'),
      ( 1, 'Kedai Runcit Pak Din',    'cash',          'Sales',         850,          'posted'),
      ( 4, 'Mei Ling Bakery',         'cash',          'Sales',         900,          'posted'),
      ( 6, 'Tan & Sons Enterprise',   'duitnow',       'Sales',        1200,          'posted'),
      (11, 'Bank Islam, profit paid', 'bank_transfer', 'Other income',   64.20,       'posted'),
      (40, 'Kedai Runcit Pak Din',    'cash',          'Sales',         780,          'posted'),
      (72, 'Mei Ling Bakery',         'cash',          'Sales',         650,          'posted')
    ) as v(days_ago, payer, method, category, amount, status)
  loop
    select id into cat from public.finance_categories
     where org_id = demo and kind = 'income' and name = r.category;
    payer := null;
    select id into payer from public.finance_contacts
     where org_id = demo and name = r.payer
     order by created_at, id limit 1;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, contact_id, party_name, category_id, status)
    values (
      demo, 'in',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, r.amount, r.method,
      payer, case when payer is null then r.payer end, cat, 'draft'
    )
    returning id into txn;
    if r.status = 'posted' then
      update public.finance_transactions
         set status = 'posted', number = 'RC-' || lpad(rc::text, greatest(4, length(rc::text)), '0'), updated_at = now()
       where id = txn;
      rc := rc + 1;
    end if;
  end loop;

  -- The demo's counters start after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'voucher', 'PV-', pv), (demo, 'receipt', 'RC-', rc)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
