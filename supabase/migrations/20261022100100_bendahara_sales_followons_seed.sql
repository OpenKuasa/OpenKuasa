-- Demo data for Bendahara Quotations, Credit Notes and Refunds in the shared
-- demo org, built from what the three mock-up screens showed. Dates are
-- relative to today. Skips when the demo org is missing or already has a
-- quotation or a credit note, and touches no other workspace.
--
-- Nothing is disabled: every row goes in the way the guards allow. A
-- quotation is inserted as a draft, given its line, sent with its number, and
-- then accepted or declined. A credit note is inserted as a draft against an
-- invoice the invoices seed posted, then issued with its number. A refund is
-- a draft payment out, split against its credit note or invoice, then paid
-- out with its number or left scheduled. The functions are not used because
-- they take their numbers from finance_next_number, which answers only to a
-- signed-in editor of the workspace, and a migration has no signed-in user.
--
-- The credit notes hang off the demo's seeded invoices. One of them is
-- against an invoice that is still owed (INV-1037), so the demo's receivable
-- goes down by its RM 520.00; the rest are against paid invoices and leave
-- those customers in credit until refunded. A credit note or refund whose
-- invoice is not there, or is not posted, is left out.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  customer uuid;
  qid uuid;
  inv uuid;
  note uuid;
  txn uuid;
  pv integer;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null
     or exists (select 1 from public.finance_quotations where org_id = demo)
     or exists (select 1 from public.finance_credit_notes where org_id = demo) then
    return;
  end if;

  -- The accounts refunds are paid from. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  cash := coalesce(cash, bank);
  bank := coalesce(bank, cash);
  if bank is null then
    raise exception 'the demo org has no account to pay refunds from';
  end if;

  -- Customers: the same eight the invoices seed uses. One that is already
  -- there is ticked as a customer; one that is missing is added.
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

  -- ---- quotations: a draft, its one line, sent, then the customer's answer ---
  -- no is null for the quotation that stays a draft. days_ago and valid_in are
  -- counted from today; valid_in below zero is a quotation past its date, which
  -- reads Expired while it is still only sent. answered_ago is how many days
  -- ago an accepted quotation was accepted.
  for r in
    select * from (values
      (null,      'Nurul Boutique',            1,  29, 'Seasonal lookbook, 24 pages',       1::numeric, 2400::numeric, 'draft',    null::integer),
      ('QT-0227', 'Seri Mutiara Enterprise',   2,  28, 'Website refresh, phase 2',          1,          6200,          'sent',     null),
      ('QT-0226', 'Langkawi Fresh',            3,  27, 'Loyalty programme set-up',          1,          4800,          'sent',     null),
      ('QT-0225', 'Aisyah Trading',            4,  26, 'Year-end campaign',                 1,         12000,          'accepted', 2),
      ('QT-0224', 'Zaki Enterprise',           6,  24, 'Second outlet point-of-sale',       1,          9500,          'sent',     null),
      ('QT-0223', 'Lim Hardware Sdn Bhd',     11,  19, 'Product catalogue, 2027 edition',   1,          7500,          'accepted', 8),
      ('QT-0222', 'Siti Decor',               28, -13, 'Showroom lighting plan',            1,          3200,          'sent',     null),
      ('QT-0221', 'Nusantara Logistics',      38, -23, 'Driver training, 2 days',           2,          2900,          'sent',     null),
      ('QT-0220', 'Aisyah Trading',           20,  10, 'Social media retainer, 3 months',   3,          2800,          'accepted', 15),
      ('QT-0219', 'Langkawi Fresh',           24,   6, 'Delivery app prototype',            1,          3600,          'declined', null),
      -- Earlier months, so the trend chart has a shape.
      ('QT-0212', 'Aisyah Trading',           58, -28, 'Mid-year campaign',                 1,         18000,          'accepted', 50),
      ('QT-0208', 'Zaki Enterprise',          89, -59, 'Stock system review',               1,          9000,          'declined', null),
      ('QT-0205', 'Siti Decor',              119, -89, 'Showroom refit drawings',           1,         14000,          'accepted', 110),
      ('QT-0203', 'Lim Hardware Sdn Bhd',    150, -120, 'Trade counter signage',            1,         11000,          'accepted', 141),
      ('QT-0201', 'Nusantara Logistics',     180, -150, 'Warehouse layout study',           1,          7500,          'sent',     null)
    ) as v(no, customer_name, days_ago, valid_in, description, quantity, unit_price, status, answered_ago)
  loop
    select id into customer from public.finance_contacts
     where org_id = demo and name = r.customer_name
     order by created_at, id limit 1;

    insert into public.finance_quotations (org_id, customer_id, quote_date, valid_until, status)
    values (demo, customer, current_date - r.days_ago, current_date + r.valid_in, 'draft')
    returning id into qid;
    insert into public.finance_quotation_lines (org_id, quotation_id, position, description, quantity, uom, unit_price)
    values (demo, qid, 1, r.description, r.quantity, 'job', r.unit_price);

    if r.no is not null then
      update public.finance_quotations
         set status = 'sent', quotation_no = r.no, sent_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = qid;
    end if;
    if r.status in ('accepted', 'declined') then
      update public.finance_quotations
         set status = r.status,
             accepted_at = case when r.status = 'accepted' then now() - make_interval(days => r.answered_ago) end,
             updated_at = now()
       where id = qid;
    end if;
  end loop;

  -- ---- credit notes: a draft against a posted invoice, then issued -----------
  -- no is null for the credit note that stays a draft.
  for r in
    select * from (values
      (null,      'INV-1041', 1, 'pricing_adjustment', 300::numeric),
      ('CN-0037', 'INV-1037', 2, 'goodwill',           520),
      ('CN-0036', 'INV-1032', 3, 'returns',            900),
      ('CN-0035', 'INV-1036', 2, 'returns',            180),
      ('CN-0034', 'INV-1042', 1, 'returns',            240),
      ('CN-0033', 'INV-1039', 4, 'overbilling',        450),
      ('CN-0032', 'INV-1038', 4, 'pricing_adjustment', 600),
      ('CN-0031', 'INV-1033', 3, 'returns',            680),
      ('CN-0030', 'INV-1030', 6, 'overbilling',        320)
    ) as v(no, invoice_no, days_ago, reason, amount)
  loop
    select id into inv from public.finance_invoices
     where org_id = demo and invoice_no = r.invoice_no and status = 'posted';
    continue when inv is null;

    insert into public.finance_credit_notes (org_id, invoice_id, credit_date, reason, amount, status)
    values (demo, inv, current_date - r.days_ago, r.reason, r.amount, 'draft')
    returning id into note;
    if r.no is not null then
      update public.finance_credit_notes
         set status = 'issued', credit_note_no = r.no, issued_at = now() - make_interval(days => r.days_ago), updated_at = now()
       where id = note;
    end if;
  end loop;

  -- ---- refunds: a draft payment out, its split, then paid out or left pending -
  -- Vouchers are numbered after any the demo already has.
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'voucher'), 1),
           coalesce((select max(substring(number from '^PV-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^PV-[0-9]{1,9}$'), 1))
    into pv;

  -- against is a credit note's number, or an invoice's for a refund put against the invoice itself.
  for r in
    select * from (values
      ('CN-0036',  2, 'bank_transfer', 'order_cancelled', 900::numeric, 'posted'),
      ('CN-0035',  1, 'fpx',           'damaged_goods',   180,          'posted'),
      ('CN-0034',  0, 'fpx',           'damaged_goods',   240,          'posted'),
      ('INV-1039', 3, 'bank_transfer', 'overpayment',     450,          'posted'),
      ('CN-0031',  0, 'duitnow',       'wrong_item',      680,          'scheduled'),
      ('CN-0030',  1, 'bank_transfer', 'overpayment',     320,          'scheduled')
    ) as v(against, days_ago, method, reason, amount, status)
  loop
    note := null;
    inv := null;
    if r.against like 'CN-%' then
      select n.id, i.customer_id into note, customer
        from public.finance_credit_notes n
        join public.finance_invoices i on i.org_id = n.org_id and i.id = n.invoice_id
       where n.org_id = demo and n.credit_note_no = r.against and n.status = 'issued';
      continue when note is null;
    else
      select t.id, t.customer_id into inv, customer
        from public.finance_invoice_totals t
       where t.org_id = demo and t.invoice_no = r.against and t.status = 'posted' and t.balance < 0;
      continue when inv is null;
    end if;

    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, contact_id, status)
    values (
      demo, 'out',
      case when r.method = 'cash' then cash else bank end,
      current_date - r.days_ago, r.amount, r.method, customer, 'draft'
    )
    returning id into txn;
    insert into public.finance_allocations (org_id, transaction_id, invoice_id, credit_note_id, amount, reason)
    values (demo, txn, inv, note, r.amount, r.reason);
    if r.status = 'posted' then
      update public.finance_transactions
         set status = 'posted', number = 'PV-' || lpad(pv::text, greatest(4, length(pv::text)), '0'), updated_at = now()
       where id = txn;
      pv := pv + 1;
    else
      update public.finance_transactions set status = 'scheduled', updated_at = now() where id = txn;
    end if;
  end loop;

  -- The demo's counters start after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'quotation', 'QT-', 228), (demo, 'credit_note', 'CN-', 38), (demo, 'voucher', 'PV-', pv)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
