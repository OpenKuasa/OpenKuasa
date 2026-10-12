-- Bendahara ledger, part 1 of 4: the chart of accounts (additive; safe to
-- apply while the previous code is still deployed: nothing deployed reads it).
--
--   * finance_ledger_accounts: one row per account of a workspace's books.
--     An account stands for a system role (Accounts Receivable), for one bank
--     or cash account, for one category, or for nothing but itself (the
--     workspace's own: Equipment, Loan from director).
--   * Triggers on finance_accounts and finance_categories keep one ledger
--     account per bank or cash account and per category: made when the row is
--     added, renamed with it until someone renames the ledger account by hand,
--     archived and unarchived with it, and gone with it if it is deleted.
--   * private.finance_ledger_seed gives a workspace everything it is missing.
--     It is run here for every workspace and by the new-workspace seed.
--   * Every workspace gets an expense category "Purchases" (the default
--     category of a supplier bill, next migration) and keeps an income
--     category for its invoices ("Sales").
--
-- What changes for writes the deployed code can make: none. The app reads
-- finance_accounts and finance_categories and never writes them. For a write
-- by hand:
--   1. Adding a bank account or a category also adds a ledger account. It is
--      added by the database, so the writer needs no right on the new table.
--   2. A category's kind (expense or income) no longer changes once it has a
--      ledger account (FIN25): the account's type was fixed when it was made.
--   3. The category invoices post to and the category bills default to cannot
--      be deleted (FIN25). Every other unused category or bank account is
--      deleted as before, and its ledger account goes with it; one that a
--      manual journal has used is refused by that journal line's foreign key.
--
-- New error code: FIN25, "an account that is used, or that stands for a bank
-- account, a category or a system role, cannot be deleted, and what an
-- account stands for cannot change".
--
-- Nothing here is granted to service_role: no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- the table ----------------------------------------------------------------
-- At most one of system_key, bank_account_id and category_id is set; an
-- account with none is the workspace's own.
--
-- default_for is not one of those three links. It marks, on an account that
-- already stands for a category, the one job the ledger needs a category for:
--   'sales'      the income category every invoice credits;
--   'purchases'  the expense category a supplier bill gets when none is given.
-- A marker rather than the category's name, so that renaming "Sales" to
-- "Jualan", or having five income categories, changes nothing about where an
-- invoice posts. At most one account per workspace carries each.
create table public.finance_ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','income','expense')),
  system_key text,
  bank_account_id uuid,
  category_id uuid,
  default_for text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, code),
  unique (org_id, system_key),
  unique (org_id, bank_account_id),
  unique (org_id, category_id),
  unique (org_id, default_for),
  constraint finance_ledger_accounts_code_check check (char_length(code) between 1 and 10),
  constraint finance_ledger_accounts_name_check check (char_length(btrim(name)) between 1 and 200),
  constraint finance_ledger_accounts_system_key_check check (
    system_key in ('receivable','payable','sst_payable','opening_equity','owner_equity','retained_earnings')
  ),
  constraint finance_ledger_accounts_one_link_check
    check (num_nonnulls(system_key, bank_account_id, category_id) <= 1),
  -- The type follows from what the account stands for. That a category's
  -- account is 'income' for an income category and 'expense' for an expense
  -- category is seen to by the function that makes it (a check cannot read
  -- another table), and the category's kind is then held still.
  constraint finance_ledger_accounts_stands_for_check check (
    case
      when system_key = 'receivable' then type = 'asset'
      when system_key in ('payable','sst_payable') then type = 'liability'
      when system_key in ('opening_equity','owner_equity','retained_earnings') then type = 'equity'
      when bank_account_id is not null then type = 'asset'
      when category_id is not null then type in ('income','expense')
      else true
    end
  ),
  constraint finance_ledger_accounts_default_for_check check (
    default_for is null
    or (category_id is not null
        and ((default_for = 'sales' and type = 'income') or (default_for = 'purchases' and type = 'expense')))
  ),
  -- Deleting an unused bank account or category takes its ledger account with
  -- it, as before this table existed nothing stood in the way of that delete.
  foreign key (org_id, bank_account_id) references public.finance_accounts(org_id, id) on delete cascade,
  foreign key (org_id, category_id) references public.finance_categories(org_id, id) on delete cascade
);
create unique index finance_ledger_accounts_name_key on public.finance_ledger_accounts (org_id, lower(name));

-- Members read. An owner or admin adds, renames, recodes, archives and deletes.
alter table public.finance_ledger_accounts enable row level security;
create policy finance_ledger_accounts_select on public.finance_ledger_accounts
  for select to authenticated using (private.is_org_member(org_id));
create policy finance_ledger_accounts_insert on public.finance_ledger_accounts
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_ledger_accounts_update on public.finance_ledger_accounts
  for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
create policy finance_ledger_accounts_delete on public.finance_ledger_accounts
  for delete to authenticated using (private.finance_may_sign_off(org_id));
create policy mfa_required on public.finance_ledger_accounts as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.finance_ledger_accounts from anon, authenticated, service_role;
grant select, insert, update, delete on public.finance_ledger_accounts to authenticated;

-- ---- the guard ------------------------------------------------------------------
-- Steps aside when the workspace is being deleted (by the time a cascade
-- reaches these rows the orgs row is already gone) and when nobody is signed
-- in (a migration or the SQL editor, run by the database owner).
--
-- How it tells the database's own writes from a person's. The accounts that
-- stand for something are written by the functions below, from a trigger on
-- finance_accounts, finance_categories or orgs, so this guard then runs at
-- least one trigger down: pg_trigger_depth() > 1. A person's own INSERT or
-- UPDATE of this table runs it at depth 1. No function a person can call
-- writes this table, so depth 1 with somebody signed in is a write by hand.
--   * By hand, an account is added with no link and no marker: the
--     workspace's own.
--   * Nobody changes what an account is: its workspace, type, system_key,
--     bank_account_id and category_id are fixed when it is made. Code, name
--     and active are an owner's or admin's to change, on any account.
--   * default_for is the database's to write.
--   * Deleted by hand: only the workspace's own, and only while no journal
--     line uses it (the foreign key from finance_journal_lines, two
--     migrations on, backs this up). An account that stands for a bank
--     account or a category goes only when that row goes, and never the one
--     invoices post to or bills default to.
create or replace function private.finance_ledger_account_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if tg_op = 'DELETE' then
    -- The workspace is being deleted: its accounts all go.
    if not exists (select 1 from public.orgs where id = old.org_id) then
      return old;
    end if;
    if me is null then
      return old;
    end if;
    if old.default_for is not null then
      raise exception 'the category invoices post to, and the one bills default to, are kept' using errcode = 'FIN25';
    end if;
    -- No parent row: the bank account or category itself is being deleted,
    -- and its ledger account goes with it.
    if old.bank_account_id is not null and not exists (
      select 1 from public.finance_accounts where org_id = old.org_id and id = old.bank_account_id
    ) then
      return old;
    end if;
    if old.category_id is not null and not exists (
      select 1 from public.finance_categories where org_id = old.org_id and id = old.category_id
    ) then
      return old;
    end if;
    if num_nonnulls(old.system_key, old.bank_account_id, old.category_id) > 0 then
      raise exception 'an account that stands for a bank account, a category or a system role is archived, not deleted'
        using errcode = 'FIN25';
    end if;
    -- to_regclass: the journal tables arrive two migrations after this one.
    if to_regclass('public.finance_journal_lines') is not null then
      if private.finance_ledger_account_in_use(old.org_id, old.id) then
        raise exception 'an account with journal lines is archived, not deleted' using errcode = 'FIN25';
      end if;
    end if;
    return old;
  end if;

  if me is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if pg_trigger_depth() = 1
       and (num_nonnulls(new.system_key, new.bank_account_id, new.category_id) > 0 or new.default_for is not null) then
      raise exception 'the accounts of bank accounts, categories and system roles are made by the database'
        using errcode = 'FIN25';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.type is distinct from old.type
     or new.system_key is distinct from old.system_key
     or new.bank_account_id is distinct from old.bank_account_id
     or new.category_id is distinct from old.category_id then
    raise exception 'what an account stands for, and its type, do not change' using errcode = 'FIN25';
  end if;
  if pg_trigger_depth() = 1 and new.default_for is distinct from old.default_for then
    raise exception 'what an account stands for, and its type, do not change' using errcode = 'FIN25';
  end if;
  return new;
end $$;

-- Whether a stored journal line uses the account. Its own function, written
-- as dynamic SQL, because the table it reads does not exist until
-- 20261108093000: a plain query here would be planned against a missing
-- table the first time the guard reached it. Runs as the caller, from inside
-- the guard, which has already checked that the table is there.
create or replace function private.finance_ledger_account_in_use(target_org uuid, target_account uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  used boolean;
begin
  execute 'select exists (select 1 from public.finance_journal_lines where org_id = $1 and account_id = $2)'
    into used using target_org, target_account;
  return used;
end $$;
revoke all on function private.finance_ledger_account_in_use(uuid, uuid) from public, anon, service_role;
grant execute on function private.finance_ledger_account_in_use(uuid, uuid) to authenticated;

create trigger finance_ledger_account_guard
  before insert or update or delete on public.finance_ledger_accounts
  for each row execute function private.finance_ledger_account_guard();

revoke all on function private.finance_ledger_account_guard() from public, anon, authenticated, service_role;

-- ---- codes and names --------------------------------------------------------------
-- One workspace's accounts are numbered and named by one transaction at a
-- time, so two categories added at the same moment do not take the same code.
-- Held until the transaction ends.
-- Not taken when nobody is signed in. That is a migration, and this one seeds
-- every workspace in a single transaction: one lock per workspace, all held
-- to the end, could outgrow the server's lock table. A migration has the
-- table to itself in any case (it is created, or locked, in the same
-- transaction).
create or replace function private.finance_ledger_lock(target_org uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance_ledger:' || target_org::text, 0));
  end if;
end $$;
revoke all on function private.finance_ledger_lock(uuid) from public, anon, authenticated, service_role;

-- The lowest unused code at or after range_start, in steps of 10: 1000, 1010,
-- 1020 and so on. A code somebody already uses is stepped over, whoever gave
-- it, so a range that fills up, or a workspace that numbered an account 5000
-- by hand, moves the new account to the next free step and never refuses the
-- write that asked for it. The steps do not stop at the end of a range: an
-- eleventh cash account takes the first free step after 1090. An owner or
-- admin can change any code afterwards. Codes are compared as text, so a code
-- that is not a number never collides.
create or replace function private.finance_ledger_next_code(target_org uuid, range_start integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  candidate integer := range_start;
begin
  while exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and code = candidate::text
  ) loop
    candidate := candidate + 10;
  end loop;
  return candidate::text;
end $$;
revoke all on function private.finance_ledger_next_code(uuid, integer) from public, anon, authenticated, service_role;

-- The name an account takes when it should be called `wanted`: that name, or
-- with " (2)", " (3)" after it while another account of the workspace has it
-- (names are unique without regard to capitals, and a bank account, an income
-- category and an expense category may share one). skip leaves one account
-- out: the one being renamed. An empty name becomes "Unnamed"; a very long
-- one is cut so the result fits the table's 200 characters.
create or replace function private.finance_ledger_free_name(target_org uuid, wanted text, skip uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  base text := left(coalesce(nullif(btrim(wanted), ''), 'Unnamed'), 180);
  candidate text := base;
  n integer := 1;
begin
  while exists (
    select 1 from public.finance_ledger_accounts
    where org_id = target_org and lower(name) = lower(candidate) and (skip is null or id <> skip)
  ) loop
    n := n + 1;
    candidate := base || ' (' || n || ')';
  end loop;
  return candidate;
end $$;
revoke all on function private.finance_ledger_free_name(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---- one account per bank or cash account, and per category ------------------------
-- Each makes the ledger account of one row if it has none, and does nothing
-- otherwise, so the seed below and the triggers can both call them. They run
-- inside security definer callers, as the owner.

-- Cash accounts from 1000, bank accounts from 1100.
create or replace function private.finance_ledger_link_bank(target_org uuid, target_account uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  a record;
begin
  perform private.finance_ledger_lock(target_org);
  select name, kind, active into a from public.finance_accounts
  where org_id = target_org and id = target_account;
  if not found or exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and bank_account_id = target_account
  ) then
    return;
  end if;
  insert into public.finance_ledger_accounts (org_id, code, name, type, bank_account_id, active)
  values (
    target_org,
    private.finance_ledger_next_code(target_org, case when a.kind = 'cash' then 1000 else 1100 end),
    private.finance_ledger_free_name(target_org, a.name, null),
    'asset', target_account, a.active
  );
end $$;
revoke all on function private.finance_ledger_link_bank(uuid, uuid) from public, anon, authenticated, service_role;

-- Income categories from 4000; expense categories from 6000, but for the
-- Purchases category, which starts at 5000. The first income category named
-- "Sales" and the first expense category named "Purchases" (capitals aside)
-- take the workspace's 'sales' and 'purchases' markers if nobody has them.
create or replace function private.finance_ledger_link_category(target_org uuid, target_category uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  c record;
  marker text;
begin
  perform private.finance_ledger_lock(target_org);
  select name, kind, active into c from public.finance_categories
  where org_id = target_org and id = target_category;
  if not found or exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and category_id = target_category
  ) then
    return;
  end if;
  marker := case
    when c.kind = 'income' and lower(c.name) = 'sales' then 'sales'
    when c.kind = 'expense' and lower(c.name) = 'purchases' then 'purchases'
  end;
  if marker is not null and exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and default_for = marker
  ) then
    marker := null;
  end if;
  insert into public.finance_ledger_accounts (org_id, code, name, type, category_id, default_for, active)
  values (
    target_org,
    private.finance_ledger_next_code(target_org, case
      when c.kind = 'income' then 4000
      when marker = 'purchases' then 5000
      else 6000
    end),
    private.finance_ledger_free_name(target_org, c.name, null),
    c.kind, target_category, marker, c.active
  );
end $$;
revoke all on function private.finance_ledger_link_category(uuid, uuid) from public, anon, authenticated, service_role;

-- ---- the triggers that keep them in step ---------------------------------------------
-- Security definer: a member who is neither owner nor admin may add a bank
-- account or a category (the policies of those tables let any writer), and
-- may not write finance_ledger_accounts. The ledger account is the
-- database's to make. Each function takes no argument, writes only the
-- ledger account of the row its trigger fired for, and nobody can call it.
--
-- The name follows while the ledger account still has the name it was given
-- for the old name; once someone has renamed the ledger account by hand it is
-- left alone. active follows each time the bank account or category is
-- archived or unarchived.
create or replace function private.finance_ledger_sync_bank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.finance_ledger_link_bank(new.org_id, new.id);
    return null;
  end if;
  if new.name is distinct from old.name then
    perform private.finance_ledger_lock(new.org_id);
    update public.finance_ledger_accounts la
       set name = private.finance_ledger_free_name(la.org_id, new.name, la.id), updated_at = now()
     where la.org_id = new.org_id and la.bank_account_id = new.id
       and la.name = private.finance_ledger_free_name(la.org_id, old.name, la.id);
  end if;
  if new.active is distinct from old.active then
    update public.finance_ledger_accounts la
       set active = new.active, updated_at = now()
     where la.org_id = new.org_id and la.bank_account_id = new.id;
  end if;
  return null;
end $$;
revoke all on function private.finance_ledger_sync_bank() from public, anon, authenticated, service_role;

create trigger finance_ledger_sync_bank_insert
  after insert on public.finance_accounts
  for each row execute function private.finance_ledger_sync_bank();
create trigger finance_ledger_sync_bank_update
  after update on public.finance_accounts
  for each row
  when (new.name is distinct from old.name or new.active is distinct from old.active)
  execute function private.finance_ledger_sync_bank();

-- The same for a category, and one rule more: its kind stays what it was
-- (FIN25). The ledger account's type was taken from it and never changes, so
-- an expense category turned into an income category would leave its bills
-- and expenses posting to an account of the wrong type. Not asked of a
-- session with nobody signed in.
create or replace function private.finance_ledger_sync_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.finance_ledger_link_category(new.org_id, new.id);
    return null;
  end if;
  if new.kind is distinct from old.kind and (select auth.uid()) is not null then
    raise exception 'a category stays an expense category or an income category' using errcode = 'FIN25';
  end if;
  if new.name is distinct from old.name then
    perform private.finance_ledger_lock(new.org_id);
    update public.finance_ledger_accounts la
       set name = private.finance_ledger_free_name(la.org_id, new.name, la.id), updated_at = now()
     where la.org_id = new.org_id and la.category_id = new.id
       and la.name = private.finance_ledger_free_name(la.org_id, old.name, la.id);
  end if;
  if new.active is distinct from old.active then
    update public.finance_ledger_accounts la
       set active = new.active, updated_at = now()
     where la.org_id = new.org_id and la.category_id = new.id;
  end if;
  return null;
end $$;
revoke all on function private.finance_ledger_sync_category() from public, anon, authenticated, service_role;

create trigger finance_ledger_sync_category_insert
  after insert on public.finance_categories
  for each row execute function private.finance_ledger_sync_category();
create trigger finance_ledger_sync_category_update
  after update on public.finance_categories
  for each row
  when (new.name is distinct from old.name or new.active is distinct from old.active
        or new.kind is distinct from old.kind)
  execute function private.finance_ledger_sync_category();

-- ---- the seed ------------------------------------------------------------------------
-- Gives one workspace whatever it is missing, and nothing twice:
--   1. an expense category "Purchases" and an income category "Sales", each
--      only if the workspace has no account marked for that job (so a
--      workspace that renamed its Sales category is not given a second one);
--   2. the six system accounts, at the codes of the design, or the next free
--      step if a code is taken;
--   3. the ledger account of every bank and cash account, oldest first;
--   4. the ledger account of every category, oldest first;
--   5. the 'purchases' and 'sales' markers, if step 4 found the accounts
--      already made and unmarked.
-- For a new workspace steps 3 and 4 find nothing to do: the triggers above
-- made those accounts as the categories and bank accounts were seeded. Run
-- again, every step finds what it made the first time.
create or replace function private.finance_ledger_seed(target_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  r record;
begin
  if not exists (select 1 from public.orgs where id = target_org) then
    return;
  end if;
  perform private.finance_ledger_lock(target_org);

  if not exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and default_for = 'purchases'
  ) then
    insert into public.finance_categories (org_id, name, kind)
    values (target_org, 'Purchases', 'expense')
    on conflict do nothing;
  end if;
  if not exists (
    select 1 from public.finance_ledger_accounts where org_id = target_org and default_for = 'sales'
  ) then
    insert into public.finance_categories (org_id, name, kind)
    values (target_org, 'Sales', 'income')
    on conflict do nothing;
  end if;

  for s in
    select v.key, v.code, v.name, v.type
    from (values
      ('receivable', 1200, 'Accounts Receivable', 'asset'),
      ('payable', 2000, 'Accounts Payable', 'liability'),
      ('sst_payable', 2100, 'SST Payable', 'liability'),
      ('owner_equity', 3000, 'Owner''s Equity', 'equity'),
      ('retained_earnings', 3100, 'Retained Earnings', 'equity'),
      ('opening_equity', 3900, 'Opening Balance Equity', 'equity')
    ) as v(key, code, name, type)
    order by v.code
  loop
    if not exists (
      select 1 from public.finance_ledger_accounts where org_id = target_org and system_key = s.key
    ) then
      insert into public.finance_ledger_accounts (org_id, code, name, type, system_key)
      values (
        target_org,
        private.finance_ledger_next_code(target_org, s.code),
        private.finance_ledger_free_name(target_org, s.name, null),
        s.type, s.key
      );
    end if;
  end loop;

  for r in
    select id from public.finance_accounts where org_id = target_org order by created_at, name, id
  loop
    perform private.finance_ledger_link_bank(target_org, r.id);
  end loop;

  for r in
    select id from public.finance_categories where org_id = target_org order by created_at, name, id
  loop
    perform private.finance_ledger_link_category(target_org, r.id);
  end loop;

  update public.finance_ledger_accounts la
     set default_for = 'purchases', updated_at = now()
   where la.org_id = target_org
     and not exists (
       select 1 from public.finance_ledger_accounts x where x.org_id = target_org and x.default_for = 'purchases'
     )
     and la.id = (
       select a.id
       from public.finance_ledger_accounts a
       join public.finance_categories c on c.org_id = a.org_id and c.id = a.category_id
       where a.org_id = target_org and c.kind = 'expense' and lower(c.name) = 'purchases'
       order by c.created_at, c.id
       limit 1
     );
  update public.finance_ledger_accounts la
     set default_for = 'sales', updated_at = now()
   where la.org_id = target_org
     and not exists (
       select 1 from public.finance_ledger_accounts x where x.org_id = target_org and x.default_for = 'sales'
     )
     and la.id = (
       select a.id
       from public.finance_ledger_accounts a
       join public.finance_categories c on c.org_id = a.org_id and c.id = a.category_id
       where a.org_id = target_org and c.kind = 'income' and lower(c.name) = 'sales'
       order by c.created_at, c.id
       limit 1
     );
end $$;
revoke all on function private.finance_ledger_seed(uuid) from public, anon, authenticated, service_role;

-- ---- the seeds of a new workspace ---------------------------------------------------
-- private.finance_seed_categories: the body of
-- 20261012170000_bendahara_foundation.sql (language sql, security definer,
-- search_path ''), with one value added: ('Purchases','expense').
create or replace function private.finance_seed_categories(target_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.finance_categories (org_id, name, kind)
  select target_org, v.name, v.kind
  from (values
    ('Rent','expense'), ('Utilities','expense'), ('Marketing','expense'),
    ('Travel','expense'), ('Supplies','expense'), ('Salaries','expense'),
    ('Services','expense'), ('Purchases','expense'), ('Sales','income'), ('Other income','income')
  ) as v(name, kind)
  on conflict do nothing;
$$;
revoke all on function private.finance_seed_categories(uuid) from public, anon, authenticated;

-- private.finance_seed_accounts: the body of 20261013100000_bendahara_money.sql,
-- unchanged. Not replaced; named here because the order below leans on it.

-- private.finance_seed_new_org: the body of 20261013100000_bendahara_money.sql
-- (language plpgsql, security definer, search_path ''), with one line added:
-- the ledger seed, last. Categories and bank accounts are seeded first and
-- their triggers make the linked ledger accounts as each row goes in (the
-- "Sales" and "Purchases" categories taking their markers), so the ledger
-- seed finds those made and adds the six system accounts.
create or replace function private.finance_seed_new_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.finance_seed_categories(new.id);
  perform private.finance_seed_accounts(new.id);
  perform private.finance_ledger_seed(new.id);
  return new;
end $$;
revoke all on function private.finance_seed_new_org() from public, anon, authenticated;

-- ---- every workspace that exists -----------------------------------------------------
-- Run with nobody signed in, so the guard above steps aside. Each workspace
-- gets "Purchases" if it has none, the six system accounts, and an account
-- for every bank account, cash account and category it already has.
select private.finance_ledger_seed(id) from public.orgs;
