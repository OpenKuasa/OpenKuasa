-- Demo data for the Bendahara Receipts Inbox in the shared demo org, built
-- from what the mock-up screen showed: eight receipts, five matched, two to
-- review (one read by a model and waiting to be checked, one that could not
-- be read) and one unmatched. Dates are relative to today. Skips when the demo
-- org is missing or already has a receipt, and touches no other workspace.
--
-- A migration cannot upload, so these rows have no file (file_path is empty)
-- and the bucket stays empty: the screen says "Sample receipt, no file" where
-- a real receipt offers its file. Nothing is disabled: a migration has no
-- signed-in user, which is the one case the guard lets a receipt in without a
-- file (see private.finance_receipt_guard), and each row is inserted in
-- review and then tied or reviewed by a plain update, the way the guard allows.
--
-- The matched rows are tied to documents the demo already has: its four
-- newest paid expenses and its newest posted supplier bill, and they carry
-- that document's own vendor, date and amount, so the inbox agrees with
-- Expenses and Supplier Bills. A document that is missing leaves its receipt
-- unmatched. No expense, bill or payment is changed: Expenses, Supplier
-- Bills, Payments Out and Payment Vouchers read exactly as they did.

do $$
declare
  demo uuid;
  rid uuid;
  doc record;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null or exists (select 1 from public.finance_receipts where org_id = demo) then
    return;
  end if;

  for r in
    select * from (values
      -- n, hours ago, file name,           type,              bytes,   what it is,  typed vendor,           typed amount, typed SST
      (1,   20, 'receipt-0042.jpg', 'image/jpeg',      184320,  'expense 1', null,                   null::numeric, null::numeric),
      (2,   44, 'receipt-0041.jpg', 'image/jpeg',      231424,  'expense 2', null,                   null,          null),
      (3,   50, 'receipt-0040.png', 'image/png',       412672,  'expense 3', null,                   null,          null),
      (4,   70, 'receipt-0039.jpg', 'image/jpeg',      198656,  'review',    'Lazada Malaysia',      249.90,        0),
      (5,   96, 'receipt-0038.pdf', 'application/pdf', 96256,   'bill',      null,                   null,          null),
      (6,  120, 'receipt-0037.jpg', 'image/jpeg',      305152,  'unread',    null,                   null,          null),
      (7,  144, 'receipt-0036.pdf', 'application/pdf', 121856,  'unmatched', 'Nusantara Logistics',  540.00,        0),
      (8,  168, 'receipt-0035.jpg', 'image/jpeg',      167936,  'expense 4', null,                   null,          null)
    ) as v(n, hours_ago, file_name, mime_type, size_bytes, what, vendor, amount, sst_amount)
    order by n
  loop
    insert into public.finance_receipts
      (org_id, file_name, mime_type, size_bytes, vendor, receipt_date, amount, sst_amount, extracted_at, created_at, updated_at)
    values (
      demo, r.file_name, r.mime_type, r.size_bytes, r.vendor,
      case when r.amount is not null then (now() - make_interval(hours => r.hours_ago))::date end,
      r.amount, r.sst_amount,
      -- The one still in review with figures on it is shown as a model's reading, waiting to be checked.
      case when r.what = 'review' then now() - make_interval(hours => r.hours_ago) end,
      now() - make_interval(hours => r.hours_ago), now() - make_interval(hours => r.hours_ago))
    returning id into rid;

    if r.what like 'expense %' then
      -- The demo's newest paid expenses, one each.
      select e.id, e.vendor_name, e.expense_date, e.amount, e.sst_amount into doc
        from public.finance_expense_totals e
       where e.org_id = demo and e.display_status = 'paid'
       order by e.expense_date desc, e.id
       offset right(r.what, 1)::integer - 1 limit 1;
      if found then
        update public.finance_receipts
           set vendor = left(doc.vendor_name, 200), receipt_date = doc.expense_date, amount = doc.amount,
               sst_amount = doc.sst_amount, expense_id = doc.id
         where id = rid;
      else
        update public.finance_receipts set status = 'unmatched' where id = rid;
      end if;
    elsif r.what = 'bill' then
      select b.id, b.supplier_name, b.bill_date, b.total into doc
        from public.supplier_bill_totals b
       where b.org_id = demo and b.status = 'posted' and b.total > 0
       order by b.bill_date desc, b.id
       limit 1;
      if found then
        update public.finance_receipts
           set vendor = left(doc.supplier_name, 200), receipt_date = doc.bill_date, amount = doc.total, bill_id = doc.id
         where id = rid;
      else
        update public.finance_receipts set status = 'unmatched' where id = rid;
      end if;
    elsif r.what = 'unread' then
      update public.finance_receipts set extraction_error = 'The receipt could not be read.' where id = rid;
    elsif r.what = 'unmatched' then
      update public.finance_receipts set status = 'unmatched' where id = rid;
    end if;
  end loop;
end $$;
