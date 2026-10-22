-- Seeds the Bendahara (finance) procurement screens that ship empty in the shared
-- demo workspace: RFQs, purchase orders, and contra entries. The purchases seed
-- (20261012160100) populated bills/payments but predates the RFQ->PO chain (#226)
-- and contra (#223), so a demo visitor saw empty RFQs / Purchase Orders / Contra.
--
-- Scoped to orgs.slug = 'rimba-ventures-demo' and idempotent (skips if RFQs already
-- exist). Finance migration guards bypass validation when auth.uid() is null, so this
-- seed sets statuses, document numbers and posted_at itself and advances the sequences.
-- RFQs/POs carry no ledger effect; a posted contra offsets a posted receivable invoice
-- against a posted payable bill for a contact that is both customer and supplier, and
-- finance_ledger_lines (a view) picks it up automatically.

do $$
declare
  demo uuid;
  s_kedai uuid; s_lim uuid; s_nusantara uuid; s_suria uuid; s_maju uuid;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid;
  k1 uuid; k2 uuid; k3 uuid;
  ct_nus uuid; ct_lim uuid;
  inv_nus uuid; bill_nus uuid; inv_lim uuid; bill_lim uuid;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null or exists (select 1 from public.finance_rfqs where org_id = demo) then
    return;
  end if;

  select id into s_kedai     from public.finance_contacts where org_id = demo and name = 'Kedai Kertas Ah Seng'  limit 1;
  select id into s_lim       from public.finance_contacts where org_id = demo and name ilike 'Lim Hardware%'     limit 1;
  select id into s_nusantara from public.finance_contacts where org_id = demo and name = 'Nusantara Logistics'   limit 1;
  select id into s_suria     from public.finance_contacts where org_id = demo and name = 'Suria Utilities Sdn Bhd' limit 1;
  select id into s_maju      from public.finance_contacts where org_id = demo and name = 'Syarikat Maju Jaya'     limit 1;

  -- ========================= RFQs =========================
  -- r1 quoted
  insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status)
    values (demo, s_kedai, current_date - 20, current_date - 13, 'Monthly office supplies', 'draft') returning id into r1;
  insert into public.finance_rfq_lines (org_id, rfq_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, r1, 1, 'A4 copier paper 80gsm', 50, 'ream', 14.50, 0),
    (demo, r1, 2, 'Printer ink cartridge', 20, 'unit', 85.00, 0);
  update public.finance_rfqs set status='quoted', rfq_no='RFQ-0001', sent_at=now()-interval '20 days', quoted_at=now()-interval '14 days', updated_at=now() where id=r1;

  -- r2 sent, awaiting reply (reply_by in the future)
  insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status)
    values (demo, s_lim, current_date - 8, current_date + 5, 'Workshop hand tools', 'draft') returning id into r2;
  insert into public.finance_rfq_lines (org_id, rfq_id, position, description, quantity, uom, sst_rate) values
    (demo, r2, 1, 'Cordless drill set', 10, 'set', 0),
    (demo, r2, 2, 'Measuring tape 5m', 40, 'unit', 0);
  update public.finance_rfqs set status='sent', rfq_no='RFQ-0002', sent_at=now()-interval '8 days', updated_at=now() where id=r2;

  -- r3 sent, reply overdue (reply_by in the past)
  insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status)
    values (demo, s_nusantara, current_date - 15, current_date - 3, 'Pallet delivery — east coast', 'draft') returning id into r3;
  insert into public.finance_rfq_lines (org_id, rfq_id, position, description, quantity, uom, sst_rate) values
    (demo, r3, 1, 'Pallet delivery per trip', 8, 'trip', 0);
  update public.finance_rfqs set status='sent', rfq_no='RFQ-0003', sent_at=now()-interval '15 days', updated_at=now() where id=r3;

  -- r4 quoted
  insert into public.finance_rfqs (org_id, supplier_id, rfq_date, reply_by, notes, status)
    values (demo, s_suria, current_date - 10, current_date - 5, 'Warehouse LED retrofit', 'draft') returning id into r4;
  insert into public.finance_rfq_lines (org_id, rfq_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, r4, 1, 'LED high-bay 150W', 24, 'unit', 220.00, 0),
    (demo, r4, 2, 'Installation labour', 1, 'job', 1800.00, 0);
  update public.finance_rfqs set status='quoted', rfq_no='RFQ-0004', sent_at=now()-interval '10 days', quoted_at=now()-interval '6 days', updated_at=now() where id=r4;

  -- r5 draft
  insert into public.finance_rfqs (org_id, supplier_id, rfq_date, notes, status)
    values (demo, s_maju, current_date - 2, 'Packaging materials — festive', 'draft') returning id into r5;
  insert into public.finance_rfq_lines (org_id, rfq_id, position, description, quantity, uom, sst_rate) values
    (demo, r5, 1, 'Gift boxes medium', 500, 'unit', 0),
    (demo, r5, 2, 'Ribbon roll 50m', 60, 'roll', 0);

  -- ========================= Purchase orders =========================
  -- p1 approved (from the quoted RFQ r1)
  insert into public.finance_purchase_orders (org_id, supplier_id, rfq_id, po_date, expected_date, notes, status, payment_terms_days)
    values (demo, s_kedai, r1, current_date - 12, current_date + 3, 'Monthly office supplies', 'draft', 30) returning id into p1;
  insert into public.finance_purchase_order_lines (org_id, purchase_order_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, p1, 1, 'A4 copier paper 80gsm', 50, 'ream', 14.50, 0),
    (demo, p1, 2, 'Printer ink cartridge', 20, 'unit', 85.00, 0);
  update public.finance_purchase_orders set status='approved', po_no='PO-0001', submitted_at=now()-interval '12 days', approved_at=now()-interval '11 days', updated_at=now() where id=p1;

  -- p2 approved
  insert into public.finance_purchase_orders (org_id, supplier_id, po_date, expected_date, notes, status, payment_terms_days)
    values (demo, s_lim, current_date - 9, current_date + 2, 'Hardware restock', 'draft', 30) returning id into p2;
  insert into public.finance_purchase_order_lines (org_id, purchase_order_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, p2, 1, 'Assorted fasteners box', 30, 'box', 42.00, 0),
    (demo, p2, 2, 'Safety gloves', 100, 'pair', 6.50, 0);
  update public.finance_purchase_orders set status='approved', po_no='PO-0002', submitted_at=now()-interval '9 days', approved_at=now()-interval '8 days', updated_at=now() where id=p2;

  -- p3 pending approval
  insert into public.finance_purchase_orders (org_id, supplier_id, po_date, expected_date, notes, status, payment_terms_days)
    values (demo, s_nusantara, current_date - 4, current_date + 6, 'Outbound delivery — November', 'draft', 14) returning id into p3;
  insert into public.finance_purchase_order_lines (org_id, purchase_order_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, p3, 1, 'Pallet delivery per trip', 8, 'trip', 320.00, 0);
  update public.finance_purchase_orders set status='pending_approval', po_no='PO-0003', submitted_at=now()-interval '4 days', updated_at=now() where id=p3;

  -- p4 draft
  insert into public.finance_purchase_orders (org_id, supplier_id, po_date, notes, status, payment_terms_days)
    values (demo, s_suria, current_date - 1, 'Warehouse LED retrofit', 'draft', 30) returning id into p4;
  insert into public.finance_purchase_order_lines (org_id, purchase_order_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, p4, 1, 'LED high-bay 150W', 24, 'unit', 220.00, 0),
    (demo, p4, 2, 'Installation labour', 1, 'job', 1800.00, 0);

  -- p5 approved
  insert into public.finance_purchase_orders (org_id, supplier_id, po_date, expected_date, notes, status, payment_terms_days)
    values (demo, s_maju, current_date - 6, current_date + 1, 'Festive packaging', 'draft', 30) returning id into p5;
  insert into public.finance_purchase_order_lines (org_id, purchase_order_id, position, description, quantity, uom, unit_price, sst_rate) values
    (demo, p5, 1, 'Gift boxes medium', 500, 'unit', 3.20, 0),
    (demo, p5, 2, 'Ribbon roll 50m', 60, 'roll', 9.00, 0);
  update public.finance_purchase_orders set status='approved', po_no='PO-0004', submitted_at=now()-interval '6 days', approved_at=now()-interval '5 days', updated_at=now() where id=p5;

  -- ========================= Contra entries =========================
  select id into ct_nus from public.finance_contacts where org_id = demo and name = 'Nusantara Logistics' limit 1;
  select id into ct_lim from public.finance_contacts where org_id = demo and name ilike 'Lim Hardware%' limit 1;
  select id into inv_nus  from public.finance_invoices where org_id = demo and invoice_no = 'INV-1037' limit 1;
  select id into bill_nus from public.supplier_bills  where org_id = demo and bill_no    = 'BILL-0232' limit 1;
  select id into inv_lim  from public.finance_invoices where org_id = demo and invoice_no = 'INV-1035' limit 1;
  select id into bill_lim from public.supplier_bills  where org_id = demo and bill_no    = 'BILL-0231' limit 1;

  -- k1 posted: fully set off Nusantara's bill BILL-0232 (RM2600) against INV-1037.
  if ct_nus is not null and inv_nus is not null and bill_nus is not null then
    insert into public.finance_contras (org_id, contact_id, contra_date, amount, reference, notes)
      values (demo, ct_nus, current_date - 5, 2600, 'Set off BILL-0232 against INV-1037', 'Mutual set-off agreed with Nusantara Logistics.') returning id into k1;
    insert into public.finance_contra_lines (org_id, contra_id, invoice_id, amount) values (demo, k1, inv_nus, 2600);
    insert into public.finance_contra_lines (org_id, contra_id, bill_id, amount)    values (demo, k1, bill_nus, 2600);
    update public.finance_contras set status='posted', contra_no='CT-0001', posted_at=now()-interval '5 days', updated_at=now() where id=k1;
  end if;

  -- k2 posted: partial RM2000 set-off for Lim Hardware (INV-1035 vs BILL-0231).
  if ct_lim is not null and inv_lim is not null and bill_lim is not null then
    insert into public.finance_contras (org_id, contact_id, contra_date, amount, reference, notes)
      values (demo, ct_lim, current_date - 3, 2000, 'Partial set-off INV-1035 vs BILL-0231', 'Agreed to net RM2,000 against the October bill.') returning id into k2;
    insert into public.finance_contra_lines (org_id, contra_id, invoice_id, amount) values (demo, k2, inv_lim, 2000);
    insert into public.finance_contra_lines (org_id, contra_id, bill_id, amount)    values (demo, k2, bill_lim, 2000);
    update public.finance_contras set status='posted', contra_no='CT-0002', posted_at=now()-interval '3 days', updated_at=now() where id=k2;

    -- k3 draft: remaining RM243.60, awaiting both sides to confirm.
    insert into public.finance_contras (org_id, contact_id, contra_date, amount, reference, notes)
      values (demo, ct_lim, current_date - 1, 243.60, 'Draft set-off — bill remainder', 'Pending confirmation before posting.') returning id into k3;
    insert into public.finance_contra_lines (org_id, contra_id, invoice_id, amount) values (demo, k3, inv_lim, 243.60);
    insert into public.finance_contra_lines (org_id, contra_id, bill_id, amount)    values (demo, k3, bill_lim, 243.60);
  end if;

  -- ========================= Sequences =========================
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number, pad) values
    (demo, 'rfq', 'RFQ-', 5, 4),
    (demo, 'purchase_order', 'PO-', 5, 4),
    (demo, 'contra', 'CT-', 3, 4)
  on conflict (org_id, doc_type) do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);

  raise notice 'bendahara procurement demo seed complete for org %', demo;
end $$;
