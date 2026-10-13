-- Bendahara ledger, part 3 of 4: manual journals (additive; safe to apply
-- while the previous code is still deployed: nothing deployed reads or writes
-- these tables).
--
-- Everything Bendahara already records reaches the books by itself, through
-- the view of the next migration. A manual journal is for what no document
-- says: depreciation, an owner's capital, a correction. It is the only part
-- of the ledger that is stored.
--
--   * finance_journals and finance_journal_lines.
--   * A journal is written, posted and reversed by an owner or admin only.
--     Members read posted journals; a draft is the owner's and admins' to see.
--   * Posting needs two lines or more, every line on an active account of the
--     workspace, and debits equal to credits. A posted journal and its lines
--     are locked: there is no void, only a reversing journal, once.
--   * finance_next_number learns one more document type, 'journal' (JV-).
--   * Posting, and posting a reversal, are written to the activity log.
--
-- New error codes:
--   FIN23  a journal's debits and credits are not equal
--   FIN24  a journal needs at least two lines, each on an active account of
--          the workspace
--   FIN27  a journal is reversed once
-- FIN01 (locked), FIN11 (no longer exists) and FIN14 (needs an owner or
-- admin) mean what they mean everywhere else in finance.
--
-- Nothing here is granted to service_role: no worker touches these tables.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- tables ---------------------------------------------------------------------
create table public.finance_journals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- JV-0001; given when the journal is posted.
  journal_no text,
  journal_date date not null default current_date,
  description text not null,
  status text not null default 'draft' check (status in ('draft','posted')),
  -- The posted journal this one undoes, if it is a reversal.
  reverses_journal_id uuid,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, journal_no),
  constraint finance_journals_description_check check (char_length(btrim(description)) between 1 and 200),
  -- A draft has no number; a posted journal has one and says when it was posted.
  constraint finance_journals_number_check check ((status = 'draft') = (journal_no is null)),
  constraint finance_journals_posted_check check ((status = 'posted') = (posted_at is not null)),
  constraint finance_journals_reverses_check check (reverses_journal_id is null or reverses_journal_id <> id),
  foreign key (org_id, reverses_journal_id) references public.finance_journals(org_id, id)
);
create index finance_journals_date_idx on public.finance_journals (org_id, journal_date);
-- One reversal per journal, draft or posted. finance_reverse_journal answers
-- FIN27 before this is reached; the index is what holds under two calls at
-- the same moment, and for an insert by hand.
create unique index finance_journals_reverses_key
  on public.finance_journals (org_id, reverses_journal_id)
  where reverses_journal_id is not null;

-- One side per line: a debit or a credit, never both and never neither. The
-- foreign key to the account has no cascade, so an account that a journal
-- line uses cannot be deleted; the account is archived instead, and keeps its
-- lines. When the whole workspace goes, the lines and the accounts go in the
-- same statement and the key is checked after both.
create table public.finance_journal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  journal_id uuid not null,
  position integer not null default 0,
  account_id uuid not null,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  constraint finance_journal_lines_one_side_check check ((debit > 0) <> (credit > 0)),
  -- NaN is a numeric, is greater than every number and fits numeric(14,2).
  constraint finance_journal_lines_number_check check (debit <> 'NaN' and credit <> 'NaN'),
  constraint finance_journal_lines_note_check check (note is null or char_length(note) <= 200),
  foreign key (org_id, journal_id) references public.finance_journals(org_id, id) on delete cascade,
  foreign key (org_id, account_id) references public.finance_ledger_accounts(org_id, id)
);
create index finance_journal_lines_journal_idx on public.finance_journal_lines (org_id, journal_id);
create index finance_journal_lines_account_idx on public.finance_journal_lines (org_id, account_id);

-- ---- who reads and writes ------------------------------------------------------------
-- A member reads a posted journal and its lines. An owner or admin reads
-- every journal, drafts included, and is the only one who writes.
alter table public.finance_journals enable row level security;
create policy finance_journals_select on public.finance_journals
  for select to authenticated
  using (private.is_org_member(org_id) and (status = 'posted' or private.finance_may_sign_off(org_id)));
create policy finance_journals_insert on public.finance_journals
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_journals_update on public.finance_journals
  for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
create policy finance_journals_delete on public.finance_journals
  for delete to authenticated using (private.finance_may_sign_off(org_id));
create policy mfa_required on public.finance_journals as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

alter table public.finance_journal_lines enable row level security;
-- The journal is read here under its own policy, so "posted" is asked once.
create policy finance_journal_lines_select on public.finance_journal_lines
  for select to authenticated
  using (
    private.is_org_member(org_id)
    and (
      private.finance_may_sign_off(org_id)
      or exists (
        select 1 from public.finance_journals j
        where j.org_id = finance_journal_lines.org_id
          and j.id = finance_journal_lines.journal_id
          and j.status = 'posted'
      )
    )
  );
create policy finance_journal_lines_insert on public.finance_journal_lines
  for insert to authenticated with check (private.finance_may_sign_off(org_id));
create policy finance_journal_lines_update on public.finance_journal_lines
  for update to authenticated
  using (private.finance_may_sign_off(org_id)) with check (private.finance_may_sign_off(org_id));
create policy finance_journal_lines_delete on public.finance_journal_lines
  for delete to authenticated using (private.finance_may_sign_off(org_id));
create policy mfa_required on public.finance_journal_lines as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.finance_journals from anon, authenticated, service_role;
revoke all on public.finance_journal_lines from anon, authenticated, service_role;
grant select, insert, update, delete on public.finance_journals to authenticated;
grant select, insert, update, delete on public.finance_journal_lines to authenticated;

-- ---- numbering: a journal takes a JV- number ----------------------------------------
alter table public.finance_sequences
  drop constraint finance_sequences_doc_type_check,
  add constraint finance_sequences_doc_type_check
    check (doc_type in ('invoice','quotation','credit_note','bill','receipt','voucher','transfer','rfq','purchase_order','journal'));

-- The body of 20261103090000_bendahara_rfq_po_tables.sql with one line added:
-- 'journal' gives 'JV-'. It stays "security definer": finance_sequences is
-- closed to the authenticated role, so this function is its only writer. The
-- revoke and the grant are the ones that file ends with.
create or replace function public.finance_next_number(target_org uuid, doc text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_prefix text;
  p text;
  n integer;
  w integer;
begin
  if not private.is_org_writer(target_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  default_prefix := case doc
    when 'invoice' then 'INV-'
    when 'quotation' then 'QT-'
    when 'credit_note' then 'CN-'
    when 'bill' then 'BILL-'
    when 'receipt' then 'RC-'
    when 'voucher' then 'PV-'
    when 'transfer' then 'TR-'
    when 'rfq' then 'RFQ-'
    when 'purchase_order' then 'PO-'
    when 'journal' then 'JV-'
  end;
  if default_prefix is null then
    raise exception 'unknown document type %', doc using errcode = '22023';
  end if;

  insert into public.finance_sequences (org_id, doc_type, prefix)
  values (target_org, doc, default_prefix)
  on conflict (org_id, doc_type) do nothing;

  update public.finance_sequences
     set next_number = next_number + 1, updated_at = now()
   where org_id = target_org and doc_type = doc
  returning prefix, next_number - 1, pad into p, n, w;

  -- lpad cuts a string longer than the target, so never pad to less than the number's own length.
  return p || lpad(n::text, greatest(w, length(n::text)), '0');
end $$;

revoke all on function public.finance_next_number(uuid, text) from public, anon, service_role;
grant execute on function public.finance_next_number(uuid, text) to authenticated;

-- ---- guards -------------------------------------------------------------------------
-- In the manner of the purchase order guards (20261103091500): each steps
-- aside when the workspace is being deleted and when nobody is signed in, and
-- on the one change of status there is, the old row is copied and only that
-- step's columns are set, so nothing else can ride along with it.
--
--   new               a draft, with no number, made by the person signed in
--   draft  -> draft   the date and the description change; the lines change
--                     through their own guard
--   draft  -> posted  needs a number, two lines or more, every line on an
--                     active account of the workspace (FIN24), and debits
--                     equal to credits (FIN23); who posted and when is
--                     written here
--   posted            locked (FIN01), and not deleted
--
-- reverses_journal_id is given when a journal is inserted and never after. It
-- must name a posted journal of the workspace. That it names one nobody has
-- reversed yet is the unique index's to hold.
create or replace function private.finance_journal_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  kept text;
  line_count integer;
  debits numeric;
  credits numeric;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a journal starts as a draft' using errcode = 'FIN01';
    end if;
    if me is not null then
      new.created_by := me;
    end if;
    new.journal_no := null;
    new.posted_by := null;
    new.posted_at := null;
    if new.reverses_journal_id is not null and not exists (
      select 1 from public.finance_journals j
      where j.org_id = new.org_id and j.id = new.reverses_journal_id and j.status = 'posted'
    ) then
      raise exception 'only a posted journal is reversed' using errcode = 'FIN01';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a posted journal cannot be deleted' using errcode = 'FIN01';
    end if;
    return old;
  end if;

  if me is null or to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;
  -- A deleted user is cleared from created_by and posted_by by their foreign
  -- keys, whatever the journal's status. That update is made by the foreign
  -- key's own trigger, so this guard runs one level down; a person's own
  -- update, at the first level, is not let through here.
  if pg_trigger_depth() > 1
     and (to_jsonb(new) - 'created_by' - 'posted_by') = (to_jsonb(old) - 'created_by' - 'posted_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.posted_by is null or new.posted_by = old.posted_by) then
    return new;
  end if;
  if new.created_by is distinct from old.created_by or new.org_id <> old.org_id then
    raise exception 'who wrote a journal does not change' using errcode = 'FIN01';
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    new.journal_no := null;
    new.posted_by := null;
    new.posted_at := null;
    new.reverses_journal_id := old.reverses_journal_id;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'posted' then
    if new.journal_no is null then
      raise exception 'a journal takes its number when it is posted' using errcode = 'FIN01';
    end if;
    select count(*), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
      into line_count, debits, credits
    from public.finance_journal_lines l
    where l.org_id = old.org_id and l.journal_id = old.id;
    if line_count < 2 then
      raise exception 'a journal needs at least two lines' using errcode = 'FIN24';
    end if;
    -- "Active" is asked now, at posting. An account archived afterwards keeps
    -- the lines it has. That the account is the workspace's own is the
    -- foreign key's (org_id, account_id); it is asked here as well so the
    -- answer is one code.
    if exists (
      select 1
      from public.finance_journal_lines l
      left join public.finance_ledger_accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = old.org_id and l.journal_id = old.id
        and (a.id is null or not a.active)
    ) then
      raise exception 'every line of a journal is on an active account of the workspace' using errcode = 'FIN24';
    end if;
    if debits <> credits then
      raise exception 'a journal''s debits and credits must be equal' using errcode = 'FIN23';
    end if;
    kept := new.journal_no;
    new := old;
    new.status := 'posted';
    new.journal_no := kept;
    new.posted_by := me;
    new.posted_at := now();
    new.updated_at := now();
    return new;
  end if;

  raise exception 'a posted journal cannot be changed' using errcode = 'FIN01';
end $$;

create trigger finance_journal_guard
  before insert or update or delete on public.finance_journals
  for each row execute function private.finance_journal_guard();

-- Lines are free while the journal is a draft and locked once it is posted.
-- The journal's row is locked (for share) while a line is written, so a
-- journal cannot be posted at the same moment a line is slipped in or taken
-- out: one waits for the other and then sees what it did.
-- A line is written on an active account of the workspace (FIN24): an
-- archived account takes no new lines. Not asked when nobody is signed in.
create or replace function private.finance_journal_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s text;
begin
  -- The workspace is being deleted: its journals and their lines all go.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    select status into s from public.finance_journals
    where org_id = old.org_id and id = old.journal_id for share;
    -- No parent row: the journal itself is being deleted, and its lines go with it.
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a posted journal cannot be changed' using errcode = 'FIN01';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from public.finance_journals
    where org_id = new.org_id and id = new.journal_id for share;
    if s is not null and s <> 'draft' then
      raise exception 'the lines of a posted journal cannot be changed' using errcode = 'FIN01';
    end if;
    if (select auth.uid()) is not null and not exists (
      select 1 from public.finance_ledger_accounts a
      where a.org_id = new.org_id and a.id = new.account_id and a.active
    ) then
      raise exception 'every line of a journal is on an active account of the workspace' using errcode = 'FIN24';
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger finance_journal_line_guard
  before insert or update or delete on public.finance_journal_lines
  for each row execute function private.finance_journal_line_guard();

revoke all on function private.finance_journal_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_journal_line_guard() from public, anon, authenticated, service_role;

-- ---- the activity log -----------------------------------------------------------------
-- The pattern of private.finance_purchase_order_log (20261106090000): runs
-- after the guard has allowed the change, as the table's owner, because the
-- activity log is closed to the authenticated role. The person is whoever is
-- signed in; with nobody signed in (a migration) nothing is written.
create or replace function private.finance_journal_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  what text := 'Posted a journal';
  about text := new.journal_no;
  original text;
begin
  if me is null or new.status is not distinct from old.status or new.status <> 'posted' then
    return null;
  end if;
  if new.reverses_journal_id is not null then
    select j.journal_no into original from public.finance_journals j
    where j.org_id = new.org_id and j.id = new.reverses_journal_id;
    what := 'Reversed a journal';
    about := coalesce(original, 'a journal') || ', with ' || new.journal_no;
  end if;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience)
  values (new.org_id, me, private.display_name(me), what, left(about, 200), 'data', 'members');
  return null;
end $$;
revoke all on function private.finance_journal_log() from public, anon, authenticated, service_role;

create trigger finance_journal_log
  after update on public.finance_journals
  for each row execute function private.finance_journal_log();

-- ---- functions ------------------------------------------------------------------------
-- All run as the caller, so row-level security and the guards decide. Each
-- begins by asking for an owner or admin, so anyone else gets one plain
-- answer (FIN14) instead of whichever policy they met first.

-- Creates a draft journal, or replaces a draft's date, description and lines.
-- Returns its id. journal has id (to change one), journal_date and
-- description; each line has account_id, debit or credit, and note. A draft
-- may be saved unfinished: with one line, or out of balance. Posting is where
-- that is asked.
create or replace function public.finance_save_journal(target_org uuid, journal jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  jid uuid := nullif(journal->>'id', '')::uuid;
  n integer;
begin
  if not private.finance_may_sign_off(target_org) then
    raise exception 'a journal is written by an owner or admin' using errcode = 'FIN14';
  end if;
  if jsonb_typeof(lines) is distinct from 'array' then
    raise exception 'a journal needs its lines as a list' using errcode = 'FIN24';
  end if;

  if jid is null then
    insert into public.finance_journals (org_id, journal_date, description, status)
    values (
      target_org,
      coalesce((journal->>'journal_date')::date, current_date),
      btrim(coalesce(journal->>'description', '')),
      'draft'
    )
    returning id into jid;
  else
    update public.finance_journals
       set journal_date = coalesce((journal->>'journal_date')::date, current_date),
           description = btrim(coalesce(journal->>'description', '')),
           updated_at = now()
     where org_id = target_org and id = jid;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'the journal no longer exists' using errcode = 'FIN11';
    end if;
    delete from public.finance_journal_lines where org_id = target_org and journal_id = jid;
  end if;

  insert into public.finance_journal_lines (org_id, journal_id, position, account_id, debit, credit, note)
  select
    target_org, jid,
    l.ord::integer,
    (l.line->>'account_id')::uuid,
    coalesce(round((l.line->>'debit')::numeric, 2), 0),
    coalesce(round((l.line->>'credit')::numeric, 2), 0),
    nullif(btrim(coalesce(l.line->>'note', '')), '')
  from jsonb_array_elements(lines) with ordinality as l(line, ord);

  return jid;
end $$;

-- Posts a draft journal and returns its number. The number is taken here, in
-- the same transaction as the post, so a refused post does not use one up.
create or replace function public.finance_post_journal(target_org uuid, target_journal uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  j record;
  no text;
begin
  if not private.finance_may_sign_off(target_org) then
    raise exception 'a journal is posted by an owner or admin' using errcode = 'FIN14';
  end if;
  select status into j from public.finance_journals
  where org_id = target_org and id = target_journal for update;
  if not found then
    raise exception 'the journal no longer exists' using errcode = 'FIN11';
  end if;
  if j.status <> 'draft' then
    raise exception 'the journal is already posted' using errcode = 'FIN01';
  end if;

  no := public.finance_next_number(target_org, 'journal');
  update public.finance_journals
     set status = 'posted', journal_no = no, updated_at = now()
   where org_id = target_org and id = target_journal;
  return no;
end $$;

-- Makes the draft that undoes a posted journal and returns its id: the same
-- accounts in the same order, each debit a credit and each credit a debit,
-- dated reversal_date (today when none is given). It is posted like any other
-- journal. A journal has one reversal, draft or posted (FIN27); deleting the
-- draft frees it to be reversed again. The original's row is locked first, so
-- two calls at the same moment are answered one after the other.
create or replace function public.finance_reverse_journal(target_org uuid, target_journal uuid, reversal_date date)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  j record;
  rid uuid;
begin
  if not private.finance_may_sign_off(target_org) then
    raise exception 'a journal is reversed by an owner or admin' using errcode = 'FIN14';
  end if;
  select status, journal_no, description into j from public.finance_journals
  where org_id = target_org and id = target_journal for update;
  if not found then
    raise exception 'the journal no longer exists' using errcode = 'FIN11';
  end if;
  if j.status <> 'posted' then
    raise exception 'only a posted journal is reversed' using errcode = 'FIN01';
  end if;
  if exists (
    select 1 from public.finance_journals
    where org_id = target_org and reverses_journal_id = target_journal
  ) then
    raise exception 'a journal is reversed once' using errcode = 'FIN27';
  end if;

  insert into public.finance_journals (org_id, journal_date, description, status, reverses_journal_id)
  values (
    target_org,
    coalesce(reversal_date, current_date),
    left('Reversal of ' || j.journal_no || ': ' || j.description, 200),
    'draft',
    target_journal
  )
  returning id into rid;

  insert into public.finance_journal_lines (org_id, journal_id, position, account_id, debit, credit, note)
  select target_org, rid, l.position, l.account_id, l.credit, l.debit, l.note
  from public.finance_journal_lines l
  where l.org_id = target_org and l.journal_id = target_journal
  order by l.position, l.id;

  return rid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_save_journal(uuid, jsonb, jsonb)',
    'public.finance_post_journal(uuid, uuid)',
    'public.finance_reverse_journal(uuid, uuid, date)'
  ] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
