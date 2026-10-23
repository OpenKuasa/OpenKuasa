-- Bendahara accounting settings: the company TIN, the financial year end, the books lock date and document numbering.
--
-- What it does:
--   1. orgs.tin: the company's tax identification number (LHDN), 1 to 20 capital letters and digits, or none. Owners
--      and admins save it with the other company details (the existing orgs_update policy; one more column grant).
--   2. finance_settings: one row per workspace. year_end_month (1-12, default 12 = December, which is today's
--      behaviour everywhere) and lock_date (null = open books). Every member reads it; only an owner or admin
--      (private.finance_may_sign_off) creates or saves it; nobody deletes it (it goes with the workspace); the
--      restrictive mfa_required policy as on every finance table. Triggers:
--        finance_settings_guard  BEFORE: a lock date after today in Malaysia is refused (FIN64).
--        finance_settings_stamp  BEFORE: who saved it last and when, whatever the caller sent.
--        finance_settings_audit  AFTER: one activity row per field that changed ("Changed the books lock date",
--          "Changed the financial year end"), with details.changed = {field: {from, to}}. A first save is compared
--          with what an unsaved workspace already has (December, open books), so saving the defaults logs nothing;
--          a save that changes nothing logs nothing.
--   3. The books lock: no ledger effect may be dated on or before lock_date. private.finance_period_lock() is a
--      BEFORE INSERT OR UPDATE trigger named finance_period_lock on each table that holds a ledger effect, with the
--      date column and the ledger statuses as its two arguments ('*' = every row is one):
--        finance_invoices (invoice_date; posted, void)        finance_credit_notes (credit_date; issued, void)
--        supplier_bills (bill_date; posted, void)             finance_supplier_credit_notes (credit_date; issued, void)
--        finance_transactions (txn_date; posted, void)        finance_expenses (expense_date; approved)
--        finance_contras (contra_date; posted, void)          finance_journals (journal_date; posted)
--        finance_fx_revaluations (period_end; *)
--      A row written in a ledger status, or moved into one, is refused (FIN63) when its date is on or before the
--      lock; a void is also refused when the void's own date (the UTC date the ledger gives its reversal) is. A row
--      leaving a ledger status for one that is not (an approved expense rejected) is refused by its old date, and a
--      ledger row whose date moves by either date. Drafts, and changes that leave the status and date alone (an
--      e-invoice status, a deleted person's id cleared by a foreign key), are not checked. On
--      finance_fx_revaluations (no status) an insert is checked, and an update only if it moves the date.
--      finance_accounts gets its own finance_period_lock trigger (INSERT, DELETE, UPDATE OF opening_balance,
--      opening_date, opening_rate): a non-zero opening balance dated on or before the lock is refused when written,
--      changed (amount, date or rate), taken out or deleted with its account. Deleting a workspace is untouched: the
--      document tables' triggers do not fire on delete, and an account's delete is let through once its workspace
--      row is gone. With no lock set (no row, or lock_date null) every trigger returns at once: nothing behaves
--      differently.
--   4. Numbering: public.finance_set_sequence(target_org, doc, new_prefix, new_next) changes a document's prefix and
--      next number (owner or admin; FIN66 for a bad prefix, stored in capitals; FIN65 when the next number would go
--      back, so no number is ever given twice; FIN67 when another document of the workspace already uses the new
--      prefix; logged per changed field), and public.finance_sequence_list(target_org)
--      lists all 13 documents, with the defaults for those never numbered. public.finance_next_number is not changed.
--   5. A closing block checks the triggers, the grants and the document list.
--
-- New error codes: FIN63 (a date in the locked period), FIN64 (a lock date in the future), FIN65 (a next number
-- going back), FIN66 (a bad prefix), FIN67 (a prefix another document uses). FIN63 names the lock date as
-- 'FMDD Mon YYYY' (5 Dec 1999). Safe to run once (it creates the table, functions and triggers).

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ============================================================================
-- 1. the company TIN
-- ============================================================================
alter table public.orgs
  add column tin text constraint orgs_tin_check check (tin is null or tin ~ '^[A-Z0-9]{1,20}$');
grant update (tin) on public.orgs to authenticated;

-- ============================================================================
-- 2. finance_settings
-- ============================================================================
create table public.finance_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  -- The month the financial year ends (12 = December: the calendar year).
  year_end_month smallint not null default 12 check (year_end_month between 1 and 12),
  -- Nothing dated on or before this day may change the ledger. Null: the books are open.
  lock_date date,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.finance_settings enable row level security;
create policy finance_settings_select on public.finance_settings
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_settings_insert on public.finance_settings
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_settings_update on public.finance_settings
  for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
-- No delete policy: the row goes with the workspace.
create policy mfa_required on public.finance_settings as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_settings from anon, authenticated;
grant select, insert, update on public.finance_settings to authenticated;

-- A lock date after today in Malaysia is refused: the books are closed only on what has happened.
create function private.finance_settings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lock_date > (now() at time zone 'Asia/Kuala_Lumpur')::date then
    raise exception 'The books can''t be locked to a date in the future.' using errcode = 'FIN64';
  end if;
  return new;
end $$;
revoke all on function private.finance_settings_guard() from public, anon, authenticated, service_role;
create trigger finance_settings_guard
  before insert or update on public.finance_settings
  for each row execute function private.finance_settings_guard();

-- Who saved it last and when, whatever the caller sent.
create function private.finance_settings_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
revoke all on function private.finance_settings_stamp() from public, anon, authenticated, service_role;
create trigger finance_settings_stamp
  before insert or update on public.finance_settings
  for each row execute function private.finance_settings_stamp();

-- One activity row per field that changed. A first save is compared with an unsaved workspace's values (December,
-- open books). Runs after every BEFORE trigger has passed, so a refused save logs nothing; private.finance_log
-- writes nothing when nobody is signed in.
create function private.finance_settings_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_lock date := case when tg_op = 'UPDATE' then old.lock_date end;
  was_month smallint := case when tg_op = 'UPDATE' then old.year_end_month else 12 end;
begin
  if new.lock_date is distinct from was_lock then
    perform private.finance_log(new.org_id, 'finance_settings', null, 'Changed the books lock date', 'Books lock date',
      jsonb_build_object('event', 'changed', 'changed',
        jsonb_build_object('lock_date', jsonb_build_object('from', was_lock, 'to', new.lock_date))));
  end if;
  if new.year_end_month is distinct from was_month then
    perform private.finance_log(new.org_id, 'finance_settings', null, 'Changed the financial year end', 'Financial year end',
      jsonb_build_object('event', 'changed', 'changed',
        jsonb_build_object('year_end_month', jsonb_build_object('from', was_month, 'to', new.year_end_month))));
  end if;
  return null;
end $$;
revoke all on function private.finance_settings_audit() from public, anon, authenticated, service_role;
create trigger finance_settings_audit
  after insert or update on public.finance_settings
  for each row execute function private.finance_settings_audit();

-- ============================================================================
-- 3. the books lock
-- ============================================================================
-- tg_argv[0]: the row's date column. tg_argv[1]: its ledger statuses, comma-separated, or '*' (every row is one).
-- On finance_accounts (no arguments): the opening balance, its date and its rate. Runs as the owner so the lock is
-- read whoever writes; it reads only the row's own workspace's settings. The status tests come first, so a draft
-- never costs a lookup.
--
-- A ledger row is refused (FIN63) when, with L the lock date:
--   * it is written in a ledger status, or moved into one, dated on or before L (and a row that was already in a
--     ledger status, by its old date too);
--   * it is voided while the void's own date is on or before L. The ledger dates a void's reversal on
--     (voided_at at time zone 'UTC')::date (finance_void_stamp sets voided_at := now()), so that is the date used;
--     it is never later than the Malaysia date;
--   * it leaves a ledger status for one that is not (approved -> rejected expense), dated on or before L: its entry
--     would disappear from the closed period;
--   * its date changes while its status stays a ledger status, when either date is on or before L (the documents'
--     own guards refuse this today; this is defence in depth).
-- The status read is NEW's as it stands when this trigger fires. BEFORE triggers fire in name order, so a guard
-- that sets new.status must sort before 'finance_period_lock' for its status to be the one checked here.
create function private.finance_period_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  l date;
  n jsonb;
  o jsonb;
  d date;
  od date;
  st text;
  ost text;
  ledger text[];
  is_ledger boolean;
  was_ledger boolean := false;
begin
  if tg_table_name = 'finance_accounts' then
    if tg_op = 'DELETE' then
      -- A workspace being deleted takes its accounts with it: its row is already gone.
      if old.opening_balance = 0 or not exists (select 1 from public.orgs o2 where o2.id = old.org_id) then
        return old;
      end if;
      select s.lock_date into l from public.finance_settings s where s.org_id = old.org_id;
      if l is not null and old.opening_date <= l then
        raise exception 'This date is in a closed period: the books are locked to %.', to_char(l, 'FMDD Mon YYYY')
          using errcode = 'FIN63';
      end if;
      return old;
    end if;
    if tg_op = 'UPDATE' and new.opening_balance is not distinct from old.opening_balance
       and new.opening_date is not distinct from old.opening_date
       and new.opening_rate is not distinct from old.opening_rate then
      return new;
    end if;
    if new.opening_balance = 0 and (tg_op = 'INSERT' or old.opening_balance = 0) then
      return new;
    end if;
    select s.lock_date into l from public.finance_settings s where s.org_id = new.org_id;
    if l is null then
      return new;
    end if;
    if (new.opening_balance <> 0 and new.opening_date <= l)
       or (tg_op = 'UPDATE' and old.opening_balance <> 0 and old.opening_date <= l) then
      raise exception 'This date is in a closed period: the books are locked to %.', to_char(l, 'FMDD Mon YYYY')
        using errcode = 'FIN63';
    end if;
    return new;
  end if;

  n := to_jsonb(new);
  d := (n ->> tg_argv[0])::date;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old);
    od := (o ->> tg_argv[0])::date;
  end if;

  if tg_argv[1] = '*' then
    if tg_op = 'UPDATE' and d is not distinct from od then
      return new;
    end if;
  else
    ledger := string_to_array(tg_argv[1], ',');
    st := n ->> 'status';
    is_ledger := coalesce(st = any (ledger), false);
    if tg_op = 'UPDATE' then
      ost := o ->> 'status';
      was_ledger := coalesce(ost = any (ledger), false);
    end if;
    if tg_op = 'INSERT' then
      if not is_ledger then
        return new;
      end if;
    elsif st is not distinct from ost then
      -- Status unchanged: only a ledger row whose date moves.
      if not is_ledger or d is not distinct from od then
        return new;
      end if;
    elsif not is_ledger and not (was_ledger and st is distinct from 'void') then
      -- Draft to draft-like statuses (pending approval, scheduled, rejected...): no ledger effect.
      return new;
    end if;
  end if;

  select s.lock_date into l from public.finance_settings s where s.org_id = new.org_id;
  if l is null then
    return new;
  end if;
  if (is_ledger is not false and d <= l)
     or (was_ledger and od <= l)
     or (st = 'void' and (now() at time zone 'UTC')::date <= l) then
    raise exception 'This date is in a closed period: the books are locked to %.', to_char(l, 'FMDD Mon YYYY')
      using errcode = 'FIN63';
  end if;
  return new;
end $$;
revoke all on function private.finance_period_lock() from public, anon, authenticated, service_role;

create trigger finance_period_lock before insert or update on public.finance_invoices
  for each row execute function private.finance_period_lock('invoice_date', 'posted,void');
create trigger finance_period_lock before insert or update on public.finance_credit_notes
  for each row execute function private.finance_period_lock('credit_date', 'issued,void');
create trigger finance_period_lock before insert or update on public.supplier_bills
  for each row execute function private.finance_period_lock('bill_date', 'posted,void');
create trigger finance_period_lock before insert or update on public.finance_supplier_credit_notes
  for each row execute function private.finance_period_lock('credit_date', 'issued,void');
create trigger finance_period_lock before insert or update on public.finance_transactions
  for each row execute function private.finance_period_lock('txn_date', 'posted,void');
create trigger finance_period_lock before insert or update on public.finance_expenses
  for each row execute function private.finance_period_lock('expense_date', 'approved');
create trigger finance_period_lock before insert or update on public.finance_contras
  for each row execute function private.finance_period_lock('contra_date', 'posted,void');
create trigger finance_period_lock before insert or update on public.finance_journals
  for each row execute function private.finance_period_lock('journal_date', 'posted');
create trigger finance_period_lock before insert or update on public.finance_fx_revaluations
  for each row execute function private.finance_period_lock('period_end', '*');
-- An opening balance: written, changed (its amount, date or rate), or deleted with its account.
create trigger finance_period_lock
  before insert or delete or update of opening_balance, opening_date, opening_rate on public.finance_accounts
  for each row execute function private.finance_period_lock();

-- ============================================================================
-- 4. numbering
-- ============================================================================
-- The 13 numbered documents, their names and the prefixes public.finance_next_number starts them with
-- (20261123110000), in the order the settings screen lists them.
create function private.finance_sequence_docs()
returns table (doc_type text, label text, default_prefix text, list_order integer)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('invoice', 'Invoice', 'INV-', 1),
    ('quotation', 'Quotation', 'QT-', 2),
    ('credit_note', 'Credit note', 'CN-', 3),
    ('bill', 'Supplier bill', 'BILL-', 4),
    ('receipt', 'Receipt', 'RC-', 5),
    ('voucher', 'Payment voucher', 'PV-', 6),
    ('transfer', 'Transfer', 'TR-', 7),
    ('rfq', 'RFQ', 'RFQ-', 8),
    ('purchase_order', 'Purchase order', 'PO-', 9),
    ('journal', 'Journal', 'JV-', 10),
    ('contra', 'Contra entry', 'CT-', 11),
    ('fx_revaluation', 'FX revaluation', 'FX-', 12),
    ('supplier_credit_note', 'Supplier credit note', 'SCN-', 13)
  ) as v(doc_type, label, default_prefix, list_order)
$$;
revoke all on function private.finance_sequence_docs() from public, anon, authenticated, service_role;

-- Changes one document's prefix and next number. Runs as the owner: the authenticated role has no write on
-- finance_sequences (20261030123000). The next number never goes down, so no number is given twice; a prefix change
-- keeps the counter (every number given under any prefix is below it). Only what changed is written and logged.
create function public.finance_set_sequence(target_org uuid, doc text, new_prefix text, new_next integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  cur record;
  p text;
  changed jsonb := '{}'::jsonb;
begin
  if not (private.is_org_writer(target_org) and private.finance_may_sign_off(target_org)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into d from private.finance_sequence_docs() s where s.doc_type = doc;
  if not found then
    raise exception 'unknown document type %', doc using errcode = '22023';
  end if;
  if new_prefix is null or new_prefix !~ '^[A-Za-z0-9/-]{1,10}$' then
    raise exception 'A prefix is 1 to 10 letters, numbers, dashes or slashes.' using errcode = 'FIN66';
  end if;
  p := upper(new_prefix);

  -- One change of numbering at a time per workspace, so two documents cannot take the same prefix at once.
  perform pg_advisory_xact_lock(hashtextextended('finance_set_sequence:' || target_org::text, 0));

  -- As public.finance_next_number does, the row is made with its default prefix when the document was never
  -- numbered; then it is locked, so a number handed out at the same moment is counted.
  insert into public.finance_sequences (org_id, doc_type, prefix)
  values (target_org, doc, d.default_prefix)
  on conflict (org_id, doc_type) do nothing;
  select s.prefix, s.next_number into cur from public.finance_sequences s
   where s.org_id = target_org and s.doc_type = doc
   for update;

  if new_next is null or new_next < cur.next_number then
    raise exception 'The next number can''t go back: it must be % or more.', cur.next_number using errcode = 'FIN65';
  end if;

  -- A new prefix may not be one another document of the workspace uses now (its stored prefix, or its default when
  -- it was never numbered): receipts and vouchers share finance_transactions.number, and a shared prefix would hand
  -- out the same number twice. Keeping a document's own prefix is never refused.
  if p is distinct from cur.prefix and exists (
    select 1
      from private.finance_sequence_docs() o
      left join public.finance_sequences s on s.org_id = target_org and s.doc_type = o.doc_type
     where o.doc_type <> doc and upper(coalesce(s.prefix, o.default_prefix)) = p
  ) then
    raise exception 'Another document already uses this prefix.' using errcode = 'FIN67';
  end if;

  if p is distinct from cur.prefix then
    changed := changed || jsonb_build_object('prefix', jsonb_build_object('from', cur.prefix, 'to', p));
  end if;
  if new_next is distinct from cur.next_number then
    changed := changed || jsonb_build_object('next_number', jsonb_build_object('from', cur.next_number, 'to', new_next));
  end if;
  if changed = '{}'::jsonb then
    return;
  end if;

  update public.finance_sequences s
     set prefix = p, next_number = new_next, updated_at = now()
   where s.org_id = target_org and s.doc_type = doc;
  perform private.finance_log(target_org, 'finance_settings', null, 'Changed document numbering', d.label || ' numbering',
    jsonb_build_object('event', 'changed', 'doc', doc, 'changed', changed));
end $$;
revoke all on function public.finance_set_sequence(uuid, text, text, integer) from public, anon, service_role;
grant execute on function public.finance_set_sequence(uuid, text, text, integer) to authenticated;

-- Every numbered document's prefix, next number and padding; a document never numbered shows what
-- public.finance_next_number would start it with (its default prefix, 1, 4). Every member reads it.
create function public.finance_sequence_list(target_org uuid)
returns table (doc_type text, prefix text, next_number integer, pad integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select d.doc_type, coalesce(s.prefix, d.default_prefix), coalesce(s.next_number, 1), coalesce(s.pad, 4)
      from private.finance_sequence_docs() d
      left join public.finance_sequences s on s.org_id = target_org and s.doc_type = d.doc_type
     order by d.list_order;
end $$;
revoke all on function public.finance_sequence_list(uuid) from public, anon, service_role;
grant execute on function public.finance_sequence_list(uuid) to authenticated;

-- ============================================================================
-- 5. closing check
-- ============================================================================
do $$
declare
  r record;
  n integer;
  want text;
  got text;
begin
  -- A finance_period_lock trigger on each table: BEFORE ROW INSERT OR UPDATE, enabled, with its arguments.
  for r in
    select * from (values
      ('public.finance_invoices', 'invoice_date', 'posted,void'),
      ('public.finance_credit_notes', 'credit_date', 'issued,void'),
      ('public.supplier_bills', 'bill_date', 'posted,void'),
      ('public.finance_supplier_credit_notes', 'credit_date', 'issued,void'),
      ('public.finance_transactions', 'txn_date', 'posted,void'),
      ('public.finance_expenses', 'expense_date', 'approved'),
      ('public.finance_contras', 'contra_date', 'posted,void'),
      ('public.finance_journals', 'journal_date', 'posted'),
      ('public.finance_fx_revaluations', 'period_end', '*')
    ) as v(tbl, col, statuses)
  loop
    -- tgtype bits: 1 row, 2 before, 4 insert, 16 update.
    select count(*) into n from pg_catalog.pg_trigger g
     where g.tgrelid = r.tbl::regclass and g.tgname = 'finance_period_lock' and not g.tgisinternal
       and g.tgenabled = 'O' and g.tgtype = 23 and g.tgnargs = 2 and g.tgattr = ''::int2vector
       and g.tgfoid = 'private.finance_period_lock()'::regprocedure
       and encode(g.tgargs, 'escape') = r.col || '\000' || r.statuses || '\000';
    if n <> 1 then
      raise exception 'finance_period_lock on % is missing or not (%, %)', r.tbl, r.col, r.statuses;
    end if;
    -- The date column is there and is a date.
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = split_part(r.tbl, '.', 2)
                      and c.column_name = r.col and c.data_type = 'date') then
      raise exception '%.% is not a date column', r.tbl, r.col;
    end if;
  end loop;
  -- On accounts: BEFORE ROW INSERT OR DELETE OR UPDATE OF the opening balance, its date and its rate (tgtype 31 = 1
  -- row + 2 before + 4 insert + 8 delete + 16 update).
  select string_agg(a.attname, ',' order by a.attname) into got
    from pg_catalog.pg_trigger g join pg_catalog.pg_attribute a on a.attrelid = g.tgrelid and a.attnum = any (g.tgattr)
   where g.tgrelid = 'public.finance_accounts'::regclass and g.tgname = 'finance_period_lock' and g.tgtype = 31
     and g.tgenabled = 'O' and g.tgnargs = 0 and g.tgfoid = 'private.finance_period_lock()'::regprocedure;
  if got is distinct from 'opening_balance,opening_date,opening_rate' then
    raise exception 'finance_period_lock on finance_accounts fires on %, not insert, delete and update of opening_balance,opening_date,opening_rate',
      coalesce(got, 'nothing');
  end if;

  -- The documents listed here are the ones finance_sequences takes.
  select string_agg(quote_literal(d.doc_type), ',' order by d.doc_type) into got from private.finance_sequence_docs() d;
  select string_agg(quote_literal(x), ',' order by x) into want
    from (select (regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g'))[1] as x
            from pg_catalog.pg_constraint c
           where c.conrelid = 'public.finance_sequences'::regclass and c.conname = 'finance_sequences_doc_type_check') s;
  if got is distinct from want then
    raise exception 'the numbered documents are %, finance_sequences takes %', got, want;
  end if;

  -- Grants: the two RPCs for the signed-in only; the trigger functions and the list for nobody.
  if not has_function_privilege('authenticated', 'public.finance_set_sequence(uuid, text, text, integer)', 'execute')
     or has_function_privilege('anon', 'public.finance_set_sequence(uuid, text, text, integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.finance_sequence_list(uuid)', 'execute')
     or has_function_privilege('anon', 'public.finance_sequence_list(uuid)', 'execute') then
    raise exception 'finance_set_sequence and finance_sequence_list are not for the authenticated role alone';
  end if;
  if has_function_privilege('authenticated', 'private.finance_period_lock()', 'execute')
     or has_function_privilege('authenticated', 'private.finance_settings_audit()', 'execute')
     or has_function_privilege('authenticated', 'private.finance_sequence_docs()', 'execute') then
    raise exception 'the authenticated role may call a private settings function';
  end if;
  if has_table_privilege('authenticated', 'public.finance_settings', 'delete')
     or has_table_privilege('anon', 'public.finance_settings', 'select')
     or not has_column_privilege('authenticated', 'public.orgs', 'tin', 'update') then
    raise exception 'the grants on finance_settings or orgs.tin are not as this file sets them';
  end if;
end $$;
