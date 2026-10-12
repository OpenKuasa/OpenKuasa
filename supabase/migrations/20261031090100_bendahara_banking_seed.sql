-- Demo data for Bendahara Banking in the shared demo org, built from what the
-- mock-up screen showed: three accounts that add up to RM 92,300, four
-- transfers between them, and one imported statement for the main bank
-- account with most of its lines matched. Dates are relative to today. Skips
-- when the demo org is missing or already has a statement import or a
-- transfer, and touches no other workspace.
--
-- Nothing is disabled: every row goes in the way the guards allow. The two
-- sides of a transfer are inserted as drafts and posted by one UPDATE. A
-- migration has no signed-in user, which is the one case the approval rule
-- does not ask for an owner or admin (private.finance_may_decide), so
-- approved_by stays empty on the money out. The functions are not used
-- because they take their numbers from finance_next_number, which answers
-- only to a signed-in editor of the workspace.
--
-- No invoice, bill, expense or payment the demo already has is touched, and
-- a transfer is in neither cash book view, so every screen that is live
-- reads as it did, with two exceptions that are meant: the demo's account
-- pickers gain a third account, "Savings", and the demo's two accounts get a
-- bank name, an account number and an opening balance.

do $$
declare
  demo uuid;
  bank uuid;
  cash uuid;
  savings uuid;
  imp uuid;
  line uuid;
  tr integer;
  pos integer := 0;
  r record;
begin
  select id into demo from public.orgs where slug = 'rimba-ventures-demo';
  if demo is null
     or exists (select 1 from public.finance_statement_imports where org_id = demo)
     or exists (select 1 from public.finance_transactions where org_id = demo and transfer_id is not null) then
    return;
  end if;

  -- The accounts every workspace starts with. Seeding them again changes nothing if they are there.
  perform private.finance_seed_accounts(demo);
  select id into bank from public.finance_accounts
   where org_id = demo and kind = 'bank'
   order by (lower(name) = 'main bank') desc, created_at, id limit 1;
  select id into cash from public.finance_accounts
   where org_id = demo and kind = 'cash'
   order by (lower(name) = 'cash in hand') desc, created_at, id limit 1;
  if bank is null or cash is null then
    raise exception 'the demo org has no bank or cash account for its banking';
  end if;

  -- A second bank account.
  select id into savings from public.finance_accounts where org_id = demo and lower(name) = 'savings';
  if savings is null then
    insert into public.finance_accounts (org_id, name, kind, bank_name, account_no)
    values (demo, 'Savings', 'bank', 'CIMB Bank', '8600 4471 2290')
    returning id into savings;
  end if;
  update public.finance_accounts
     set bank_name = 'Maybank', account_no = '5140 2218 7730', updated_at = now()
   where id = bank and bank_name is null;

  -- Transfers are numbered after any the demo already has.
  select greatest(
           coalesce((select next_number from public.finance_sequences where org_id = demo and doc_type = 'transfer'), 1),
           coalesce((select max(substring(number from '^TR-([0-9]{1,9})$')::integer) + 1
                       from public.finance_transactions where org_id = demo and number ~ '^TR-[0-9]{1,9}$'), 1))
    into tr;

  -- ---- transfers: two draft sides, then both posted together -----------------
  for r in
    select v.days_ago, v.amount, v.note,
           case v.src when 'bank' then bank when 'cash' then cash else savings end as src,
           case v.dst when 'bank' then bank when 'cash' then cash else savings end as dst,
           (v.src = 'cash' or v.dst = 'cash') as by_cash,
           gen_random_uuid() as transfer_id
    from (values
      (35, 'bank', 'savings', 2000::numeric, 'Monthly sweep to savings'),
      (20, 'bank', 'cash',     500,          'Petty cash top-up'),
      ( 8, 'cash', 'bank',    1500,          'Counter takings banked'),
      ( 3, 'bank', 'savings', 2000,          'Monthly sweep to savings')
    ) as v(days_ago, src, dst, amount, note)
    order by v.days_ago desc
  loop
    insert into public.finance_transactions
      (org_id, direction, account_id, txn_date, amount, method, notes, transfer_id, status)
    select demo, s.direction, s.account_id, current_date - r.days_ago, r.amount,
           case when r.by_cash then 'cash' else 'bank_transfer' end, r.note, r.transfer_id, 'draft'
    from (values ('out', r.src), ('in', r.dst)) as s(direction, account_id);
    update public.finance_transactions
       set status = 'posted', number = 'TR-' || lpad(tr::text, greatest(4, length(tr::text)), '0'),
           -- Only money out is approved, as when the function records a transfer.
           approved_at = case when direction = 'out' then now() - make_interval(days => r.days_ago) end,
           updated_at = now()
     where org_id = demo and transfer_id = r.transfer_id;
    tr := tr + 1;
  end loop;

  -- ---- opening balances: what makes each account read as the mock-up did -----
  -- An opening balance is the balance before anything recorded here, so it is
  -- the figure wanted today less everything posted so far.
  update public.finance_accounts a
     set opening_balance = v.wanted - coalesce((
           select sum(case when t.direction = 'in' then t.amount else -t.amount end)
           from public.finance_transactions t
           where t.org_id = a.org_id and t.account_id = a.id and t.status = 'posted'), 0),
         opening_date = coalesce((
           select min(t.txn_date) - 1
           from public.finance_transactions t
           where t.org_id = a.org_id and t.account_id = a.id), a.opening_date),
         updated_at = now()
    from (values (bank, 72400::numeric), (savings, 8100), (cash, 11800)) as v(id, wanted)
   where a.id = v.id;

  -- ---- one statement for the main bank account -------------------------------
  -- A line for every posted movement on the account in the last two weeks,
  -- as the bank would print it. All but the last three days are matched.
  insert into public.finance_statement_imports (org_id, account_id, file_name)
  values (demo, bank, 'maybank-statement.csv')
  returning id into imp;

  for r in
    select b.transaction_id, b.txn_date, b.direction, b.amount,
           upper(left(coalesce(b.party_name, 'TRANSFER ' || b.other_account_name, 'PAYMENT'), 40)) as said
    from public.finance_bank_transactions b
    where b.org_id = demo and b.account_id = bank and b.status = 'posted'
      and b.txn_date between current_date - 14 and current_date
    order by b.txn_date, b.created_at, b.transaction_id
  loop
    pos := pos + 1;
    insert into public.finance_statement_lines
      (org_id, import_id, account_id, position, line_date, description, money_in, money_out)
    values (
      demo, imp, bank, pos, r.txn_date, r.said,
      case when r.direction = 'in' then r.amount else 0 end,
      case when r.direction = 'out' then r.amount else 0 end
    )
    returning id into line;
    if r.txn_date <= current_date - 3 then
      update public.finance_statement_lines set transaction_id = r.transaction_id, updated_at = now() where id = line;
    end if;
  end loop;

  -- Two lines only the bank knows about so far: a charge and profit paid.
  insert into public.finance_statement_lines
    (org_id, import_id, account_id, position, line_date, description, money_in, money_out)
  values
    (demo, imp, bank, pos + 1, current_date - 2, 'SERVICE CHARGE', 0, 25),
    (demo, imp, bank, pos + 2, current_date - 1, 'PROFIT PAID', 12.40, 0);

  -- The demo's counter starts after the numbers used above.
  insert into public.finance_sequences (org_id, doc_type, prefix, next_number)
  values (demo, 'transfer', 'TR-', tr)
  on conflict (org_id, doc_type)
    do update set next_number = greatest(public.finance_sequences.next_number, excluded.next_number);
end $$;
