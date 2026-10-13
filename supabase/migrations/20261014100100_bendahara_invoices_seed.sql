-- Demo data for Bendahara Invoices and Payments In in the shared demo org.
-- Mirrors the sample the two screens show without a database. Dates are
-- relative to today so the Sent and Overdue examples stay meaningful. Skips
-- when the demo org is missing or already has invoices.
--
-- Nothing is disabled: every row goes in the way the guards allow. An invoice
-- is inserted as a draft, given its lines, then posted with its number in one
-- update. A payment is inserted as a draft, split, then posted with its number.
-- The posting functions are not used because they take their numbers from
-- finance_next_number, which answers only to a signed-in editor of the
-- workspace, and a migration has no signed-in user.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  customer uuid;
  inv uuid;
  txn uuid;
  amt numeric;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null or exists (select 1 from public.finance_invoices where org_id = demo) then
    return;
  end if;

  -- The accounts money is received into. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  -- A demo org whose cash account was archived or renamed still gets its receipts.
  cash := coalesce(cash, bank);
  bank := coalesce(bank, cash);
  if bank is null then
    raise exception 'the demo org has no account to receive money into';
  end if;

  -- Customers: a contact that is already there (some are suppliers too) is
  -- ticked as a customer; the rest are added.
  update public.finance_contacts
     set is_customer = true, updated_at = now()
   where org_id = demo and not is_customer
     and name in ('Aisyah Trading', 'Zaki Enterprise', 'Nurul Boutique', 'Lim Hardware Sdn Bhd',
                  'Siti Decor', 'Nusantara Logistics', 'Langkawi Fresh', 'Seri Mutiara Enterprise');
  insert into public.finance_contacts (org_id, name, is_customer, email, payment_terms_days)
  select demo, v.name, true, v.email, v.terms
  from (values
    ('Aisyah Trading', 'accounts@aisyahtrading.my', 30),
    ('Zaki Enterprise', 'zaki@zakient.my', 30),
    ('Nurul Boutique', 'hello@nurulboutique.my', 7),
    ('Lim Hardware Sdn Bhd', 'sales@limhardware.com.my', 30),
    ('Siti Decor', 'akaun@sitidecor.my', 30),
    ('Nusantara Logistics', 'orders@nusantara.my', 30),
    ('Langkawi Fresh', 'billing@langkawifresh.my', 30),
    ('Seri Mutiara Enterprise', 'admin@serimutiara.my', 30)
  ) as v(name, email, terms)
  where not exists (
    select 1 from public.finance_contacts c where c.org_id = demo and c.name = v.name
  );

  -- ---- invoices: a draft, its one line, then posted with its number ---------
  -- no is null for the invoice that stays a draft. days_ago and due_in are
  -- counted from today; due_in below zero is an invoice past its due date.
  for r in
    select * from (values
      (null,       'Seri Mutiara Enterprise',   2,  28, 'Website refresh, phase 1',            1::numeric, 2750::numeric,  0::numeric, 'none'),
      ('INV-1042', 'Aisyah Trading',            3,  27, 'Monthly retainer, October',           1,          1240,           0,          'validated'),
      ('INV-1041', 'Zaki Enterprise',           5,  25, 'Point-of-sale setup and training',    1,          3500,           0,          'pending'),
      ('INV-1040', 'Nurul Boutique',            9,  -2, 'Product photography, 89 items',      89,           100,           0,          'validated'),
      ('INV-1039', 'Lim Hardware Sdn Bhd',     12,  18, 'Stock-take support, 3 days',          3,           700,           0,          'validated'),
      ('INV-1038', 'Siti Decor',               15,  15, 'Showroom signage design',             1,          4200,           0,          'validated'),
      ('INV-1037', 'Nusantara Logistics',      20,   5, 'Route planning workshop',             2,          3200,           0,          'pending'),
      ('INV-1036', 'Langkawi Fresh',           26,   4, 'Online store build',                  1,          5600,           0,          'validated'),
      ('INV-1035', 'Lim Hardware Sdn Bhd',     30, -16, 'Catalogue design',                    1,          3000,           6,          'validated'),
      ('INV-1033', 'Nurul Boutique',           35,  -5, 'Lookbook layout',                     1,           850,           0,          'validated'),
      ('INV-1032', 'Seri Mutiara Enterprise',  37,  -7, 'Brand guidelines',                    1,          3000,           6,          'validated'),
      ('INV-1030', 'Nusantara Logistics',      41, -11, 'Fleet tracking dashboard',            1,          6800,           0,          'validated'),
      -- Earlier months, so the trend chart has a shape.
      ('INV-1006', 'Aisyah Trading',           58, -44, 'Monthly retainer and campaign work',  1,         41200,           0,          'validated'),
      ('INV-1005', 'Aisyah Trading',           89, -75, 'Monthly retainer and campaign work',  1,         46000,           0,          'validated'),
      ('INV-1004', 'Aisyah Trading',          119, -105, 'Monthly retainer and campaign work', 1,         43000,           0,          'validated'),
      ('INV-1003', 'Aisyah Trading',          150, -136, 'Monthly retainer and campaign work', 1,         36000,           0,          'validated'),
      ('INV-1002', 'Aisyah Trading',          180, -166, 'Monthly retainer and campaign work', 1,         38000,           0,          'validated'),
      ('INV-1001', 'Aisyah Trading',          211, -197, 'Monthly retainer and campaign work', 1,         34000,           0,          'validated')
    ) as v(no, customer_name, days_ago, due_in, description, quantity, unit_price, sst_rate, einvoice)
  loop
    select id into customer from public.finance_contacts
     where org_id = demo and name = r.customer_name
     order by created_at, id limit 1;

    insert into public.finance_invoices (org_id, customer_id, invoice_date, due_date, status)
    values (demo, customer, current_date - r.days_ago, current_date + r.due_in, 'draft')
    returning id into inv;
    insert into public.finance_invoice_lines (org_id, invoice_id, position, description, quantity, uom, unit_price, sst_rate)
    values (demo, inv, 1, r.description, r.quantity, 'job', r.unit_price, r.sst_rate);

    if r.no is not null then
      update public.finance_invoices
         set status = 'posted', invoice_no = r.no, posted_at = now(),
             einvoice_status = r.einvoice, updated_at = now()
       where id = inv;
    end if;
  end loop;

  -- ---- payments in: a draft, its split, then posted with its number ---------
  -- amount is null for a payment of the invoice's whole total.
  for r in
    select * from (values
      ('RC-0108', 'INV-1042',   2, 'fpx',           null::numeric),
      ('RC-0107', 'INV-1041',   2, 'fpx',           1000),
      ('RC-0106', 'INV-1036',   3, 'fpx',           null),
      ('RC-0105', 'INV-1039',   5, 'bank_transfer', null),
      ('RC-0104', 'INV-1038',   6, 'card',          null),
      ('RC-0103', 'INV-1032',   7, 'duitnow',       null),
      ('RC-0102', 'INV-1033',   8, 'cash',          null),
      ('RC-0101', 'INV-1030',  10, 'bank_transfer', null),
      ('RC-0096', 'INV-1006',  46, 'bank_transfer', null),
      ('RC-0095', 'INV-1005',  77, 'bank_transfer', null),
      ('RC-0094', 'INV-1004', 107, 'bank_transfer', null),
      ('RC-0093', 'INV-1003', 138, 'bank_transfer', null),
      ('RC-0092', 'INV-1002', 168, 'bank_transfer', null),
      ('RC-0091', 'INV-1001', 199, 'bank_transfer', null)
    ) as v(no, invoice_no, days_ago, method, amount)
  loop
    select t.id, t.customer_id, coalesce(r.amount, t.total)
      into inv, customer, amt
      from public.finance_invoice_totals t
     where t.org_id = demo and t.invoice_no = r.invoice_no;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, contact_id, status)
    values (
      demo, 'in',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, amt, r.method, customer, 'draft'
    )
    returning id into txn;
    insert into public.finance_allocations (org_id, transaction_id, invoice_id, amount)
    values (demo, txn, inv, amt);
    update public.finance_transactions
       set status = 'posted', number = r.no, updated_at = now()
     where id = txn;
  end loop;

  -- The demo's counters start after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'invoice', 'INV-', 1043), (demo, 'receipt', 'RC-', 109)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
