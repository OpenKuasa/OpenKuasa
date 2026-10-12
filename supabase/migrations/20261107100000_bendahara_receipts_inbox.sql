-- Bendahara Receipts Inbox, database half (additive; safe to apply while the
-- previous code is still deployed: nothing deployed reads or writes any of it).
--   * finance_receipts: one row per uploaded receipt, with the details read
--     from it and the expense or supplier bill it is tied to.
--   * The private storage bucket finance-receipts. A file lives at
--     <workspace id>/<random uuid>.<jpg|png|pdf|heic|heif>; a member of the workspace
--     reads it, a writer who is signed up uploads it, and nobody signed in
--     changes or removes it: the server removes files the database has let go.
--   * private.finance_receipt_deletions: the files to remove. A deleted
--     receipt, and an upload nobody recorded within the hour, land there.
--   * The view finance_receipt_inbox, a guard, and the functions the screen
--     will call: record an upload, write what was read from it, review it,
--     make an expense or a draft bill from it, tie it to an expense or a
--     bill, and untie it.
--
-- The two foreign keys to finance_expenses and supplier_bills are
-- ON DELETE SET NULL (expense_id) / (bill_id): deleting a pending or rejected
-- expense, or a draft bill, works exactly as it does today, and a receipt
-- that was tied to it goes back to Unmatched. No deployed write is refused or
-- answered differently by this migration.
--
-- service_role is granted execute on four functions, the ones the clean-up
-- run calls, and nothing else: no table here is readable or writable by it,
-- and everything else is revoked from it by name.
-- Three error codes are new: FIN23, FIN24 and FIN25 (FIN16 and FIN17 are
-- Banking's; FIN18 to FIN22 are the RFQ's and the purchase order's).
--
-- Fit to the finance write guards (20261030123000), to Banking as it was
-- applied (20261031090000 to 20261031090300) and to RFQs and purchase orders
-- (20261103090000 to 20261103100000, which redefined finance_next_number and
-- finance_save_bill). Written after all three:
--   * This file creates new objects only. Every function is made with
--     "create function", which stops the migration if the name is already
--     taken. Nothing in it replaces, alters or drops an object that exists. In particular it
--     does not touch finance_next_number, the six functions that number a
--     payment, finance_record_transfer, finance_save_expense, finance_save_bill
--     or any guard.
--   * It writes no column that file closed. finance_receipt_to_expense calls
--     finance_save_expense and finance_receipt_to_bill calls finance_save_bill,
--     both of which still run as the caller and write no closed column; a bill
--     made here is a draft, which is not a sign-off, so a member may make one.
--     finance_save_bill now also reads purchase_order_id from what it is given;
--     it is passed through untouched, and the bill's own guard decides on it.
--     Nothing here posts, numbers, pays or voids.
--   * finance_receipts follows that file's rule for columns only the database
--     writes: the authenticated role may insert org_id, file_path and file_name
--     and nothing else, and may update what was read from the receipt, its
--     status and what it is tied to. uploaded_by, mime_type, size_bytes,
--     created_at, id, and after the insert org_id, file_path and file_name are
--     closed to it (42501), whatever value is sent. The guard keeps the same
--     rules for a write that gets past the grants.
--   * The functions here run as the caller, because row-level security and
--     the grants are exactly what should decide. The ones that run as the
--     owner each say why.

-- Fail fast instead of queueing behind a long transaction and stalling sign-ins.
set local lock_timeout = '5s';

-- ---- receipts ---------------------------------------------------------------
-- file_path is the object's name in the bucket. It is empty only on the demo
-- workspace's seeded rows, which have no file: a migration cannot upload.
-- vendor, receipt_date, amount and sst_amount are what was read from the
-- receipt, by a model or by a person; amount has its SST inside it, as an
-- expense's does. status: 'review' until a person has looked at it,
-- 'unmatched' once reviewed, 'matched' while it is tied to an expense or a
-- bill, and to one of them at most.
create table public.finance_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  file_path text,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','application/pdf','image/heic','image/heif')),
  size_bytes bigint check (size_bytes > 0 and size_bytes <= 10485760),
  vendor text check (char_length(vendor) between 1 and 200),
  receipt_date date,
  -- NaN is a numeric and is greater than every number, so it is refused by name.
  amount numeric(14,2) check (amount > 0 and amount <> 'NaN'),
  sst_amount numeric(14,2) check (sst_amount >= 0 and sst_amount <> 'NaN'),
  status text not null default 'review' check (status in ('review','matched','unmatched')),
  expense_id uuid,
  bill_id uuid,
  extraction_error text check (char_length(extraction_error) between 1 and 500),
  -- When a model last read the receipt and got something from it. Empty when
  -- nothing has tried, when the reading failed, and on a receipt whose details
  -- only a person has typed: the screen never says "read" without it.
  extracted_at timestamptz,
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  -- The first folder of the path is the workspace the row is in.
  constraint finance_receipts_file_path_check check (
    file_path is null
    or file_path ~ ('^' || org_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf|heic|heif)$')),
  -- A name to show, never a path: no slash, no backslash, no control character.
  constraint finance_receipts_file_name_check check (
    char_length(file_name) between 1 and 200 and file_name !~ '[[:cntrl:]/\\]'),
  constraint finance_receipts_sst_check check (sst_amount is null or amount is null or sst_amount <= amount),
  constraint finance_receipts_match_check check (
    num_nonnulls(expense_id, bill_id) <= 1 and (status = 'matched') = (num_nonnulls(expense_id, bill_id) = 1)),
  constraint finance_receipts_expense_fkey
    foreign key (org_id, expense_id) references public.finance_expenses(org_id, id) on delete set null (expense_id),
  constraint finance_receipts_bill_fkey
    foreign key (org_id, bill_id) references public.supplier_bills(org_id, id) on delete set null (bill_id)
);
create unique index finance_receipts_file_path_key on public.finance_receipts (file_path) where file_path is not null;
create index finance_receipts_created_idx on public.finance_receipts (org_id, created_at);
create index finance_receipts_expense_idx on public.finance_receipts (org_id, expense_id);
create index finance_receipts_bill_idx on public.finance_receipts (org_id, bill_id);

do $$
declare t text;
begin
  foreach t in array array['finance_receipts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_org_writer(org_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_org_writer(org_id))', t || '_delete', t);
    execute format(
      'create policy mfa_required on public.%I as restrictive for all to authenticated '
      || 'using ((select private.mfa_ok())) with check ((select private.mfa_ok()))', t);
    execute format('revoke all on public.%I from anon, authenticated, service_role', t);
    execute format('grant select, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Insert and update are granted column by column, as the finance write guards
-- did for payments. A new receipt is its workspace, its file and the file's
-- name: its type, its size and who uploaded it are written by the guard from
-- what the database knows. Afterwards a person changes what was read from it,
-- its status and what it is tied to. A write that names any other column is
-- refused with 42501 before a trigger runs.
grant insert (org_id, file_path, file_name) on public.finance_receipts to authenticated;
grant update (vendor, receipt_date, amount, sst_amount, status, expense_id, bill_id,
              extraction_error, extracted_at, updated_at)
  on public.finance_receipts to authenticated;

-- ---- files to remove --------------------------------------------------------
-- Postgres cannot delete a stored object safely, so a deleted receipt leaves
-- its path here and the server removes the object. Read and written only by
-- the functions below, which run as the owner: no grant to anyone, row level
-- security on with no policy.
create table private.finance_receipt_deletions (
  path text primary key,
  deleted_at timestamptz not null default now()
);
alter table private.finance_receipt_deletions enable row level security;
revoke all on private.finance_receipt_deletions from public, anon, authenticated, service_role;

-- ---- the bucket -------------------------------------------------------------
-- Private; JPEG, PNG, PDF and a phone's HEIC or HEIF; 10 MB a file. A plain
-- insert: if a bucket of this id is already there the migration stops, where
-- "on conflict do update" would have adopted it with whatever is in it. The app
-- turns a HEIC or HEIF photo into a JPEG before it uploads whenever the
-- browser can, so the original is stored only when that fails.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-receipts', 'finance-receipts', false, 10485760, array['image/jpeg','image/png','application/pdf','image/heic','image/heif']);

-- True while the workspace's receipts take less than 1 GB in the bucket and
-- the bucket as a whole holds less than 20 GB. Asked by the upload rule below:
-- one workspace cannot fill the bucket, and since a workspace costs one
-- confirmed email to make, the bucket has a ceiling of its own. Runs as the
-- owner: the caller sees only the answer.
create function private.finance_receipt_room(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(o.size) filter (where o.name like target_org::text || '/%'), 0) < 1073741824
     and coalesce(sum(o.size), 0) < 21474836480
    from (
      -- A size storage wrote as anything but a whole number counts as nothing:
      -- one odd row must not refuse every upload.
      select x.name, case when (x.metadata ->> 'size') ~ '^[0-9]{1,15}$' then (x.metadata ->> 'size')::bigint else 0 end as size
        from storage.objects x
       where x.bucket_id = 'finance-receipts'
    ) o;
$$;
revoke all on function private.finance_receipt_room(uuid) from public, anon, service_role;
grant execute on function private.finance_receipt_room(uuid) to authenticated;

-- A member may read (sign a link for) a file of their own workspace: the first
-- folder of the path is the workspace. The case keeps the cast from ever
-- running on another bucket's names.
create policy finance_receipt_files_select on storage.objects for select to authenticated
  using (case when bucket_id = 'finance-receipts'
                   and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
              then private.is_org_member(((storage.foldername(name))[1])::uuid)
              else false end);
-- Whoever may write in the workspace uploads into its folder, under a random
-- name with one of the five extensions, when they are signed up (an
-- anonymous account costs nothing to make), the workspace is not the shared
-- demo, and it has room left. There is no update and no delete rule: a file
-- is never replaced, and the server removes what the database has let go.
create policy finance_receipt_files_insert on storage.objects for insert to authenticated
  with check (case when bucket_id = 'finance-receipts'
                        and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf|heic|heif)$'
                   then private.is_org_writer(((storage.foldername(name))[1])::uuid)
                        and not private.is_demo_org(((storage.foldername(name))[1])::uuid)
                        and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
                        and private.finance_receipt_room(((storage.foldername(name))[1])::uuid)
                   else false end);
-- A session that still owes a second factor gets nothing in this bucket.
create policy finance_receipt_files_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'finance-receipts' or (select private.mfa_ok()))
  with check (bucket_id <> 'finance-receipts' or (select private.mfa_ok()));

-- ---- what the database knows about an uploaded file -------------------------
-- found: the object is in the bucket. fresh: it was uploaded in the last 30
-- minutes; the clean-up run takes a file nobody recorded only once it is an
-- hour old, so a file that can still be recorded is never one being removed.
-- released: its path is waiting to be removed, so it can never be recorded
-- again. Runs as the owner, because the list of files to remove is closed to
-- everyone; called by the guard below and by nothing the API can reach.
create function private.finance_receipt_file(p_path text)
returns table (found boolean, fresh boolean, released boolean, size_bytes bigint, mime_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name is not null,
    coalesce(o.created_at > now() - interval '30 minutes', false),
    exists (select 1 from private.finance_receipt_deletions d where d.path = p_path),
    case when (o.metadata ->> 'size') ~ '^[0-9]{1,12}$' then (o.metadata ->> 'size')::bigint end,
    o.metadata ->> 'mimetype'
  from (select 1) one
  left join storage.objects o on o.bucket_id = 'finance-receipts' and o.name = p_path;
$$;
revoke all on function private.finance_receipt_file(text) from public, anon, service_role;
grant execute on function private.finance_receipt_file(text) to authenticated;

-- The media type a path's extension names, or null when it names none of the
-- five. One place, so the guard and the function that records a file agree.
create function private.finance_receipt_type(p_path text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case substring(p_path from '\.([a-z]+)$')
    when 'jpg' then 'image/jpeg'
    when 'png' then 'image/png'
    when 'pdf' then 'application/pdf'
    when 'heic' then 'image/heic'
    when 'heif' then 'image/heif'
  end;
$$;
revoke all on function private.finance_receipt_type(text) from public, anon, service_role;
grant execute on function private.finance_receipt_type(text) to authenticated;

-- ---- the guard --------------------------------------------------------------
-- It steps aside when its workspace is being deleted: by the time a cascade
-- reaches these rows the orgs row is already gone.
--
-- A receipt is recorded as 'review', tied to nothing, by whoever is signed in
-- and for a file that is really in the workspace's folder of the bucket. Its
-- file, its name and its workspace never change. It is tied to an expense or
-- a bill by setting expense_id or bill_id, and the guard keeps status in step:
-- 'matched' while tied, 'unmatched' once untied. A receipt that is tied to an
-- approved expense or a posted bill is that document's evidence: only an
-- owner or admin unties it. A matched receipt is untied before it is deleted.
create function private.finance_receipt_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  f record;
  kind text;
begin
  if tg_op = 'DELETE' then
    if old.file_path is not null then
      -- The lock the insert below takes: the same file cannot be let go and recorded at one moment.
      perform pg_advisory_xact_lock(hashtextextended(old.file_path, 0));
    end if;
    if old.status = 'matched' and exists (select 1 from public.orgs where id = old.org_id) then
      raise exception 'a matched receipt is untied before it is deleted' using errcode = 'FIN23';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'review' or new.expense_id is not null or new.bill_id is not null then
      raise exception 'a receipt starts in review, tied to nothing' using errcode = 'FIN23';
    end if;
    -- A session with no signed-in user is a migration or the SQL editor: the
    -- demo seed, whose rows have no file. Neither API role can be in that
    -- state and still write (see private.finance_may_decide).
    if auth.uid() is null then
      return new;
    end if;
    -- Row level security says the same a moment later. It is asked here first
    -- so that someone who may not write learns nothing about a file from the
    -- answers below.
    if not private.is_org_writer(new.org_id) then
      raise exception 'you may not record a receipt in this workspace' using errcode = '42501';
    end if;
    new.uploaded_by := auth.uid();
    new.extraction_error := null;
    kind := private.finance_receipt_type(new.file_path);
    if new.file_path is null or kind is null then
      raise exception 'a receipt has a file' using errcode = 'FIN24';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.file_path, 0));
    select * into f from private.finance_receipt_file(new.file_path);
    if not f.found then
      raise exception 'the file is not in the bucket' using errcode = 'FIN24';
    end if;
    if f.released or not f.fresh then
      raise exception 'the file was uploaded too long ago, or is being removed' using errcode = 'FIN24';
    end if;
    if exists (select 1 from public.finance_receipts r where r.file_path = new.file_path) then
      raise exception 'the file is already a receipt' using errcode = 'FIN24';
    end if;
    -- The type is the one the path's extension names (the upload rule allows
    -- only these five), and storage must not have been told another.
    if f.mime_type is not null and f.mime_type <> kind then
      raise exception 'the file is not the type its name says' using errcode = 'FIN24';
    end if;
    new.mime_type := kind;
    new.size_bytes := f.size_bytes;
    return new;
  end if;

  -- A receipt stays in the workspace it was uploaded to. Asked first, before
  -- anything below can let an update through.
  if new.org_id is distinct from old.org_id then
    raise exception 'a receipt does not move to another workspace' using errcode = 'FIN23';
  end if;

  -- A deleted user, expense or bill is cleared from its column by a foreign
  -- key, whose own trigger makes the update, so this guard runs one level
  -- down (pg_trigger_depth() > 1). Nothing else may change with it, and a
  -- receipt left tied to nothing goes back to Unmatched.
  if pg_trigger_depth() > 1
     and (to_jsonb(new) - 'uploaded_by' - 'expense_id' - 'bill_id')
         = (to_jsonb(old) - 'uploaded_by' - 'expense_id' - 'bill_id')
     and (new.uploaded_by is null or new.uploaded_by = old.uploaded_by)
     and (new.expense_id is null or new.expense_id = old.expense_id)
     and (new.bill_id is null or new.bill_id = old.bill_id) then
    if old.status = 'matched' and num_nonnulls(new.expense_id, new.bill_id) = 0 then
      new.status := 'unmatched';
    end if;
    return new;
  end if;

  -- The file, its name, who uploaded it and when are fixed once recorded.
  if auth.uid() is not null
     and (new.file_path is distinct from old.file_path
          or new.file_name is distinct from old.file_name
          or new.mime_type is distinct from old.mime_type
          or new.size_bytes is distinct from old.size_bytes
          or new.uploaded_by is distinct from old.uploaded_by
          or new.created_at is distinct from old.created_at) then
    raise exception 'a receipt''s file does not change' using errcode = 'FIN23';
  end if;

  if new.expense_id is not distinct from old.expense_id and new.bill_id is not distinct from old.bill_id then
    -- Tied to what it was tied to. A receipt that is tied to nothing is in
    -- review or unmatched, whichever is asked for; the check constraint
    -- refuses 'matched' with no document and anything else with one.
    return new;
  end if;

  -- Untied from a document, or moved from one to another: an approved expense
  -- and a posted bill keep their receipt unless an owner or admin says so.
  if num_nonnulls(old.expense_id, old.bill_id) = 1
     and (exists (select 1 from public.finance_expenses e
                   where e.org_id = old.org_id and e.id = old.expense_id and e.status = 'approved')
          or exists (select 1 from public.supplier_bills b
                      where b.org_id = old.org_id and b.id = old.bill_id and b.status = 'posted'))
     and not private.finance_may_decide(old.org_id) then
    raise exception 'only an owner or admin unties a receipt from an approved expense or a posted bill'
      using errcode = 'FIN14';
  end if;

  if num_nonnulls(new.expense_id, new.bill_id) = 0 then
    if new.status = 'matched' then
      new.status := 'unmatched';
    end if;
    return new;
  end if;

  -- Tied to a document. Both at once is left to the check constraint.
  if new.bill_id is not null and exists (
    select 1 from public.supplier_bills b
     where b.org_id = new.org_id and b.id = new.bill_id and b.status = 'void'
  ) then
    raise exception 'a void bill takes no receipt' using errcode = 'FIN25';
  end if;
  new.status := 'matched';
  return new;
end $$;

create trigger finance_receipt_guard
  before insert or update or delete on public.finance_receipts
  for each row execute function private.finance_receipt_guard();

-- A deleted receipt's file is queued for removal, whoever deleted it and
-- however: by hand, or with its workspace. Runs as the owner, which alone may
-- write the list.
create function private.finance_receipt_note_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.finance_receipt_deletions (path) values (old.file_path) on conflict (path) do nothing;
  return old;
end $$;

create trigger finance_receipt_file_released
  after delete on public.finance_receipts
  for each row when (old.file_path is not null)
  execute function private.finance_receipt_note_deletion();

revoke all on function private.finance_receipt_guard() from public, anon, authenticated, service_role;
revoke all on function private.finance_receipt_note_deletion() from public, anon, authenticated, service_role;

-- ---- the view ---------------------------------------------------------------
-- One row per receipt, with whether it has a file and what it is tied to:
-- document_kind is 'expense' or 'bill', and document_label is the bill's
-- number or the expense's category.
create view public.finance_receipt_inbox with (security_invoker = true) as
select
  r.id,
  r.org_id,
  r.file_name,
  r.mime_type,
  r.size_bytes,
  r.file_path is not null as has_file,
  r.vendor,
  r.receipt_date,
  r.amount,
  r.sst_amount,
  r.status,
  r.expense_id,
  r.bill_id,
  case when r.expense_id is not null then 'expense' when r.bill_id is not null then 'bill' end as document_kind,
  coalesce(b.bill_no, cat.name) as document_label,
  r.extraction_error,
  r.extracted_at,
  r.uploaded_by,
  r.created_at,
  r.updated_at
from public.finance_receipts r
left join public.supplier_bills b on b.org_id = r.org_id and b.id = r.bill_id
left join public.finance_expenses e on e.org_id = r.org_id and e.id = r.expense_id
left join public.finance_categories cat on cat.org_id = e.org_id and cat.id = e.category_id;
revoke all on public.finance_receipt_inbox from anon, authenticated, service_role;
grant select on public.finance_receipt_inbox to authenticated;

-- ---- functions the screen calls ---------------------------------------------
-- Each runs as the caller, so row level security and the guard decide.

-- Records an uploaded file as a receipt in review and returns its id.
-- file has path (the object's name in the bucket) and name (what to show).
-- It inserts the three columns a signed-in person may write; the guard checks
-- the file and fills in its type, its size and who uploaded it.
create function public.finance_register_receipt(target_org uuid, file jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rid uuid;
begin
  insert into public.finance_receipts (org_id, file_path, file_name)
  values (target_org, nullif(file->>'path', ''), file->>'name')
  returning id into rid;
  return rid;
end $$;

-- Writes what a model read from a receipt, or why it could not: vendor,
-- receipt_date, amount, sst_amount and error. A reading with no error is
-- stamped (extracted_at); a failed one clears the stamp. Only while the
-- receipt is still in review, so a person's own review is never overwritten.
-- Answers whether it wrote.
create function public.finance_set_receipt_extraction(target_org uuid, target_receipt uuid, details jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  update public.finance_receipts
     set vendor = nullif(btrim(details->>'vendor'), ''),
         receipt_date = nullif(details->>'receipt_date', '')::date,
         amount = nullif(details->>'amount', '')::numeric,
         sst_amount = nullif(details->>'sst_amount', '')::numeric,
         extraction_error = nullif(left(btrim(details->>'error'), 500), ''),
         extracted_at = case when nullif(btrim(details->>'error'), '') is null then now() end,
         updated_at = now()
   where org_id = target_org and id = target_receipt and status = 'review';
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- A person has looked at the receipt: saves vendor, receipt_date, amount and
-- sst_amount as they typed them, and a receipt in review becomes unmatched. A
-- matched one keeps its document.
create function public.finance_review_receipt(target_org uuid, target_receipt uuid, details jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n integer;
begin
  update public.finance_receipts
     set vendor = nullif(btrim(details->>'vendor'), ''),
         receipt_date = nullif(details->>'receipt_date', '')::date,
         amount = nullif(details->>'amount', '')::numeric,
         sst_amount = nullif(details->>'sst_amount', '')::numeric,
         extraction_error = null,
         status = case when status = 'review' then 'unmatched' else status end,
         updated_at = now()
   where org_id = target_org and id = target_receipt;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
end $$;

-- Ties a receipt to an expense or to a bill of the workspace: exactly one of
-- the two is given. A receipt that is already matched is untied first.
create function public.finance_attach_receipt(
  target_org uuid, target_receipt uuid, target_expense uuid, target_bill uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  was text;
begin
  if num_nonnulls(target_expense, target_bill) <> 1 then
    raise exception 'a receipt is tied to an expense or to a bill' using errcode = '22023';
  end if;
  select status into was from public.finance_receipts
   where org_id = target_org and id = target_receipt for update;
  if was is null then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
  if was = 'matched' then
    raise exception 'the receipt is already matched' using errcode = 'FIN23';
  end if;
  update public.finance_receipts
     set expense_id = target_expense, bill_id = target_bill, updated_at = now()
   where org_id = target_org and id = target_receipt;
end $$;

-- Unties a matched receipt, which goes back to Unmatched. A receipt that is
-- tied to nothing is left as it is.
create function public.finance_detach_receipt(target_org uuid, target_receipt uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  was text;
begin
  select status into was from public.finance_receipts
   where org_id = target_org and id = target_receipt for update;
  if was is null then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
  update public.finance_receipts
     set expense_id = null, bill_id = null, updated_at = now()
   where org_id = target_org and id = target_receipt and status = 'matched';
end $$;

-- Makes a new expense from a receipt and ties the receipt to it, in one
-- transaction. expense is what finance_save_expense takes (expense_date,
-- category_id, vendor_id or vendor_name, amount, sst_amount, notes); an id in
-- it is ignored, so this never edits an expense. Saved by an owner or admin
-- the expense is approved at once, as any expense is. Returns the expense's id.
create function public.finance_receipt_to_expense(target_org uuid, target_receipt uuid, expense jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  was text;
  eid uuid;
begin
  select status into was from public.finance_receipts
   where org_id = target_org and id = target_receipt for update;
  if was is null then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
  if was = 'matched' then
    raise exception 'the receipt is already matched' using errcode = 'FIN23';
  end if;
  -- finance_expenses takes NaN as an amount today (its own check is "> 0").
  -- That is the expense table's to fix; this function does not add a door to it.
  if nullif(expense->>'amount', '')::numeric = 'NaN' or nullif(expense->>'sst_amount', '')::numeric = 'NaN' then
    raise exception 'an expense needs an amount that is a number' using errcode = '23514';
  end if;
  eid := public.finance_save_expense(target_org, coalesce(expense, '{}'::jsonb) - 'id');
  update public.finance_receipts
     set expense_id = eid, updated_at = now()
   where org_id = target_org and id = target_receipt;
  return eid;
end $$;

-- Makes a new draft supplier bill from a receipt and ties the receipt to it,
-- in one transaction. bill and lines are what finance_save_bill takes
-- (supplier_id, supplier_ref, bill_date, due_date, notes; at least one line);
-- an id in bill is ignored, so this never edits a bill. The bill is a draft:
-- nothing here posts it. Returns the bill's id.
create function public.finance_receipt_to_bill(target_org uuid, target_receipt uuid, bill jsonb, lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  was text;
  bid uuid;
begin
  select status into was from public.finance_receipts
   where org_id = target_org and id = target_receipt for update;
  if was is null then
    raise exception 'the receipt no longer exists' using errcode = 'FIN11';
  end if;
  if was = 'matched' then
    raise exception 'the receipt is already matched' using errcode = 'FIN23';
  end if;
  bid := public.finance_save_bill(target_org, coalesce(bill, '{}'::jsonb) - 'id', lines);
  update public.finance_receipts
     set bill_id = bid, updated_at = now()
   where org_id = target_org and id = target_receipt;
  return bid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_register_receipt(uuid, jsonb)',
    'public.finance_set_receipt_extraction(uuid, uuid, jsonb)',
    'public.finance_review_receipt(uuid, uuid, jsonb)',
    'public.finance_attach_receipt(uuid, uuid, uuid, uuid)',
    'public.finance_detach_receipt(uuid, uuid)',
    'public.finance_receipt_to_expense(uuid, uuid, jsonb)',
    'public.finance_receipt_to_bill(uuid, uuid, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---- functions the clean-up run calls ---------------------------------------
-- Run as the owner and are granted to service_role only: the server calls
-- them with the service client, which no storage rule holds back, so what may
-- be removed is decided here and not by the app.

-- Queues every file in the bucket that no receipt holds and that is at least
-- an hour old (a file can be recorded for 30 minutes after its upload).
-- Answers how many it queued.
create function public.finance_receipt_queue_orphans()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  insert into private.finance_receipt_deletions (path)
  select o.name
    from storage.objects o
   where o.bucket_id = 'finance-receipts'
     and o.created_at < now() - interval '1 hour'
     and not exists (select 1 from public.finance_receipts r where r.file_path = o.name)
  on conflict (path) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- The oldest paths waiting to be removed, 100 unless told otherwise, 500 at most.
create function public.finance_receipt_deletions_due(p_limit integer default 100)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select d.path from private.finance_receipt_deletions d
   order by d.deleted_at, d.path
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- True when this one path is waiting to be removed: asked right after a
-- receipt is deleted, so its file goes at once instead of at the next run.
create function public.finance_receipt_deletion_queued(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.finance_receipt_deletions d where d.path = p_path);
$$;

-- Takes paths off the list once their files are gone, and answers how many it
-- took. A path whose file is still in the bucket stays on the list, whatever
-- the caller believes.
create function public.finance_receipt_deletions_done(p_paths text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from private.finance_receipt_deletions d
   where d.path = any(coalesce(p_paths, '{}'))
     and not exists (
       select 1 from storage.objects o where o.bucket_id = 'finance-receipts' and o.name = d.path);
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.finance_receipt_queue_orphans()',
    'public.finance_receipt_deletions_due(integer)',
    'public.finance_receipt_deletion_queued(text)',
    'public.finance_receipt_deletions_done(text[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
