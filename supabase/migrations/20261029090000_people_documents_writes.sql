-- Lekiu documents: real files, who may change what, and acknowledgement,
-- decided in the database. hr_documents gets NO insert, update or delete grant
-- and no write policy. Every change is one of the functions below, which run
-- as the table owner and each begin by working out who is calling: the
-- signed-in user, the workspace (from the employee or the document named,
-- never one passed in on its own word), the role there, the second factor,
-- and whether it is the demo.
--   adding                    an owner or admin, any type; the employee
--                             themselves, four types, marked as theirs;
--   editing, replacing the    an owner or admin only;
--   file, asking for an
--   acknowledgement
--   removing                  an owner or admin; the employee, only what they
--                             uploaded themselves;
--   acknowledging             the employee the document belongs to, nobody else.
-- A file lives in the private bucket `hr-documents`, at
-- <workspace>/<employee>/<uuid>.<pdf|jpg|png|webp|heic>. It is read only
-- through the document that carries it, uploaded only into a folder the
-- caller may write, and never changed or removed by a signed-in user: the app
-- removes a file with its service client, and only for a path this file has
-- handed back or listed as released.
--
-- A refusal is `raise exception '<CODE>'` with nothing else in the message, so
-- nothing a person typed can reach an error or a log:
--   DOC_NOT_ALLOWED  DOC_NOT_FOUND  DOC_BAD_INPUT  DOC_TYPE_NOT_ALLOWED
--   DOC_TOO_MANY  DOC_BAD_FILE  DOC_ACK_NOT_REQUESTED  DOC_ALREADY_ACKNOWLEDGED
-- Where a document is named, a caller who may not do that to it is told
-- DOC_NOT_FOUND, as for an id that is no document. DOC_NOT_ALLOWED is for a
-- call with no user, for the demo, for an employee the caller may not add to
-- (or who does not exist: one answer for both), and for asking an
-- acknowledgement of something the employee uploaded.
--
-- Safe with the app deployed before this slice: every new column is nullable
-- or has a default, the status column and its check are left as they are, and
-- the only rows removed are the demo's placeholder payslips and letters, which
-- that app only counts. The demo re-seed of the performance slice cannot run
-- once the type check below is in place (it writes those two types); the last
-- file of this slice replaces it.

-- ---- rows that exist, and the type check ---------------------------------
-- The demo's placeholder payslips and letters go: the real ones live in
-- payroll and in hr_letters. A row of an old type anywhere else is kept, as
-- `other`, once the old check (which does not know `other`) is out of the
-- way. That check is found by what it says, not by a name it might not have.
-- Finding none stops the migration, so the old five-value check can never be
-- left in place unnoticed.

delete from public.hr_documents d
where d.doc_type in ('payslip','letter') and private.is_demo_org(d.org_id);

do $$
declare
  c record;
  dropped int := 0;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.hr_documents'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%doc_type%' and pg_get_constraintdef(con.oid) like '%payslip%'
  loop
    execute format('alter table public.hr_documents drop constraint %I', c.conname);
    dropped := dropped + 1;
  end loop;
  if dropped = 0 then raise exception 'the doc_type check on hr_documents was not found'; end if;
end $$;

update public.hr_documents set doc_type = 'other'
where doc_type not in ('contract','tax','benefits','identity','medical','certificate','other');

-- ---- columns ---------------------------------------------------------

-- A document that has been acknowledged was asked to be; nothing an employee
-- uploaded themselves is ever up for acknowledgement. A document has a file
-- with its name, size and type, or none of the four (the demo's have none).
alter table public.hr_documents
  add constraint hr_documents_doc_type_check check (doc_type in ('contract','tax','benefits','identity','medical','certificate','other')),
  add column file_path text,
  add column file_name text check (file_name is null or char_length(file_name) <= 200),
  add column file_size bigint,
  add column file_type text,
  add column uploaded_by uuid references auth.users(id) on delete set null,
  add column source text not null default 'hr' check (source in ('hr','employee')),
  add column ack_requested boolean not null default false,
  add column acknowledged_at timestamptz,
  add constraint hr_documents_acknowledgement
    check ((acknowledged_at is null or ack_requested) and (source <> 'employee' or not ack_requested)),
  add constraint hr_documents_file_columns check (num_nulls(file_path, file_name, file_size, file_type) in (0, 4));

-- A file is the file of one document at most. Also what the storage read rule
-- below looks a file up by.
create unique index hr_documents_file_path_idx on public.hr_documents (file_path) where file_path is not null;

-- ---- released paths -----------------------------------------------------
-- The paths that have been declared abandoned: a file uploaded and never
-- attached, the old file of a replaced document, the file of a removed one.
-- A path in this list can never be attached again, so the app may remove its
-- file. Read and written only by the functions below, which run as the
-- owner. No grant to anyone; row level security on with no policy.

create table private.hr_released_documents (
  path text primary key,
  released_at timestamptz not null default now()
);
alter table private.hr_released_documents enable row level security;
revoke all on private.hr_released_documents from public, anon, authenticated, service_role;

-- ---- helpers (private; only the functions in this file call them) ------

-- The employee a new document is for. An owner or admin of the employee's
-- workspace, or the employee themselves; never the demo. The row is held, so
-- this employee's documents are added one at a time and the count below
-- cannot be slipped past. Anyone else, and an id that is no employee, get the
-- same answer.
create or replace function private.hr_doc_employee(p_employee uuid)
returns public.hr_employees language plpgsql set search_path = public as $$
declare
  emp public.hr_employees;
begin
  if auth.uid() is null or p_employee is null then raise exception 'DOC_NOT_ALLOWED'; end if;
  select e.* into emp from public.hr_employees e where e.id = p_employee for no key update;
  if not found then raise exception 'DOC_NOT_ALLOWED'; end if;
  if private.is_demo_org(emp.org_id) then raise exception 'DOC_NOT_ALLOWED'; end if;
  if not (private.is_org_admin(emp.org_id) or private.is_own_employee(emp.id)) then
    raise exception 'DOC_NOT_ALLOWED';
  end if;
  return emp;
end; $$;
revoke all on function private.hr_doc_employee(uuid) from public, anon, authenticated;

-- The document a call is about. Its row is taken `for update` before anything
-- on it is read. Whoever may not read it (not an owner or admin of its
-- workspace, not its employee) is told DOC_NOT_FOUND, as for an id that is no
-- document; a member of the demo is told DOC_NOT_ALLOWED. What the caller may
-- then do to it is for each function to say.
create or replace function private.hr_doc_held(p_document uuid)
returns public.hr_documents language plpgsql set search_path = public as $$
declare
  doc public.hr_documents;
begin
  if auth.uid() is null then raise exception 'DOC_NOT_ALLOWED'; end if;
  select d.* into doc from public.hr_documents d where d.id = p_document for update;
  if not found then raise exception 'DOC_NOT_FOUND'; end if;
  if not (private.is_org_admin(doc.org_id) or private.is_own_employee(doc.employee_id)
          or (private.is_demo_org(doc.org_id) and private.is_org_member(doc.org_id))) then
    raise exception 'DOC_NOT_FOUND';
  end if;
  if private.is_demo_org(doc.org_id) then raise exception 'DOC_NOT_ALLOWED'; end if;
  return doc;
end; $$;
revoke all on function private.hr_doc_held(uuid) from public, anon, authenticated;

-- May this file become the file of a document of this employee? The name is 1
-- to 200 characters once trimmed, with no control character and no slash; the
-- size is 1 byte to 10 MB; the type is one the bucket takes; the path is of
-- the one shape the app makes, in this workspace and this employee's folder,
-- with the extension of its type. Then, under a lock on the path that
-- releasing takes too: the file was really uploaded, no document carries it,
-- and it has not been released; and where storage has recorded the file's
-- size and type (`metadata`, keys `size` and `mimetype`), the size and type
-- given here are those, exactly. A key storage has not recorded is not held
-- against the caller. Returns the name to store. This shape must
-- stay in step with the storage rule below, hr_release_document_file, and
-- `isDocumentPath` in src/lib/people/document-files-server.ts.
create or replace function private.hr_doc_file_ok(
  p_org uuid, p_employee uuid, p_path text, p_name text, p_size bigint, p_type text)
returns text language plpgsql set search_path = public as $$
declare
  named text := trim(p_name);
  ext text := case p_type when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
    when 'image/webp' then 'webp' when 'image/heic' then 'heic' end;
  meta jsonb;
begin
  if p_path is null or ext is null
     or named is null or char_length(named) not between 1 and 200 or named ~ '[[:cntrl:]/\\]'
     or p_size is null or p_size < 1 or p_size > 10485760
     or p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$'
     or split_part(p_path, '/', 1) <> p_org::text
     or split_part(p_path, '/', 2) <> p_employee::text
     or split_part(p_path, '.', 2) <> ext then
    raise exception 'DOC_BAD_FILE';
  end if;

  -- Held to the end of the transaction; hr_release_document_file takes the same one.
  perform pg_advisory_xact_lock(hashtextextended(p_path, 0));
  select o.metadata into meta from storage.objects o
  where o.bucket_id = 'hr-documents' and o.name = p_path;
  if not found
     or exists (select 1 from public.hr_documents d where d.file_path = p_path)
     or exists (select 1 from private.hr_released_documents x where x.path = p_path) then
    raise exception 'DOC_BAD_FILE';
  end if;
  if (meta ? 'size' and meta ->> 'size' <> p_size::text)
     or (meta ? 'mimetype' and meta ->> 'mimetype' <> p_type) then
    raise exception 'DOC_BAD_FILE';
  end if;
  return named;
end; $$;
revoke all on function private.hr_doc_file_ok(uuid, uuid, text, text, bigint, text) from public, anon, authenticated;

-- A document as the functions hand it back: never its path.
create or replace function private.hr_document_json(p_doc public.hr_documents)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_doc.id, 'employee_id', p_doc.employee_id, 'title', p_doc.title, 'doc_type', p_doc.doc_type,
    'expires_on', p_doc.expires_on, 'file_name', p_doc.file_name, 'file_size', p_doc.file_size,
    'file_type', p_doc.file_type, 'source', p_doc.source, 'ack_requested', p_doc.ack_requested,
    'acknowledged_at', p_doc.acknowledged_at, 'created_at', p_doc.created_at);
$$;
revoke all on function private.hr_document_json(public.hr_documents) from public, anon, authenticated;

-- ---- a document: add ---------------------------------------------------------
-- The title is 1 to 200 characters once trimmed; the expiry date is optional,
-- from 2000 to 2100. An owner or admin adds any type, and the row is marked
-- `hr`; the employee adds identity, medical, certificate or other to their
-- own record, and the row is marked `employee`. At most 200 documents an
-- employee. Refused, in this order: bad input; a type not allowed to the
-- caller; the 201st; a file that cannot be attached.

create or replace function public.hr_add_document(
  p_employee uuid, p_title text, p_doc_type text, p_expires_on date,
  p_file_path text, p_file_name text, p_file_size bigint, p_file_type text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  emp public.hr_employees;
  is_admin boolean;
  named text := trim(p_title);
  file_named text;
  doc public.hr_documents;
begin
  emp := private.hr_doc_employee(p_employee);
  is_admin := private.is_org_admin(emp.org_id);
  if named is null or char_length(named) not between 1 and 200
     or p_doc_type is null
     or p_doc_type not in ('contract','tax','benefits','identity','medical','certificate','other')
     or p_expires_on < date '2000-01-01' or p_expires_on > date '2100-12-31' then
    raise exception 'DOC_BAD_INPUT';
  end if;
  if not is_admin and p_doc_type not in ('identity','medical','certificate','other') then
    raise exception 'DOC_TYPE_NOT_ALLOWED';
  end if;
  if (select count(*) from public.hr_documents d where d.employee_id = emp.id) >= 200 then
    raise exception 'DOC_TOO_MANY';
  end if;
  file_named := private.hr_doc_file_ok(emp.org_id, emp.id, p_file_path, p_file_name, p_file_size, p_file_type);

  insert into public.hr_documents
    (org_id, employee_id, title, doc_type, expires_on, file_path, file_name, file_size, file_type, uploaded_by, source)
  values (emp.org_id, emp.id, named, p_doc_type, p_expires_on, p_file_path, file_named, p_file_size, p_file_type,
          auth.uid(), case when is_admin then 'hr' else 'employee' end)
  returning * into doc;

  return private.hr_document_json(doc);
exception when unique_violation then
    raise exception 'DOC_BAD_FILE';
end; $$;
revoke all on function public.hr_add_document(uuid, text, text, date, text, text, bigint, text) from public, anon;
grant execute on function public.hr_add_document(uuid, text, text, date, text, text, bigint, text) to authenticated;

-- ---- a document: change its title, type and expiry (owners and admins) ---------

create or replace function public.hr_update_document(p_document uuid, p_title text, p_doc_type text, p_expires_on date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  doc public.hr_documents;
  named text := trim(p_title);
begin
  doc := private.hr_doc_held(p_document);
  if not private.is_org_admin(doc.org_id) then raise exception 'DOC_NOT_FOUND'; end if;
  if named is null or char_length(named) not between 1 and 200
     or p_doc_type is null
     or p_doc_type not in ('contract','tax','benefits','identity','medical','certificate','other')
     or p_expires_on < date '2000-01-01' or p_expires_on > date '2100-12-31' then
    raise exception 'DOC_BAD_INPUT';
  end if;

  update public.hr_documents d
  set title = named, doc_type = p_doc_type, expires_on = p_expires_on
  where d.id = doc.id
  returning d.* into doc;

  return private.hr_document_json(doc);
end; $$;
revoke all on function public.hr_update_document(uuid, text, text, date) from public, anon;
grant execute on function public.hr_update_document(uuid, text, text, date) to authenticated;

-- ---- a document: replace its file (owners and admins) ---------------------------
-- The new file is checked as a first one is. The old path is released in the
-- same transaction that takes it off the document, and handed back so the app
-- can remove the file. What was acknowledged was the old file: the
-- acknowledgement is cleared, and the request stands.

create or replace function public.hr_replace_document_file(
  p_document uuid, p_file_path text, p_file_name text, p_file_size bigint, p_file_type text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  doc public.hr_documents;
  file_named text;
  old_path text;
begin
  doc := private.hr_doc_held(p_document);
  if not private.is_org_admin(doc.org_id) then raise exception 'DOC_NOT_FOUND'; end if;
  file_named := private.hr_doc_file_ok(doc.org_id, doc.employee_id, p_file_path, p_file_name, p_file_size, p_file_type);
  old_path := doc.file_path;

  update public.hr_documents d
  set file_path = p_file_path, file_name = file_named, file_size = p_file_size, file_type = p_file_type,
      uploaded_by = auth.uid(), acknowledged_at = null
  where d.id = doc.id
  returning d.* into doc;
  if old_path is not null then
    insert into private.hr_released_documents (path) values (old_path) on conflict do nothing;
  end if;

  return jsonb_build_object('document', private.hr_document_json(doc), 'old_path', old_path);
exception when unique_violation then
    raise exception 'DOC_BAD_FILE';
end; $$;
revoke all on function public.hr_replace_document_file(uuid, text, text, bigint, text) from public, anon;
grant execute on function public.hr_replace_document_file(uuid, text, text, bigint, text) to authenticated;

-- ---- a document: remove ---------------------------------------------------------
-- An owner or admin removes any document; the employee, only one they
-- uploaded themselves. The path is released with the row and handed back so
-- the app can remove the file.

create or replace function public.hr_remove_document(p_document uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  doc public.hr_documents;
begin
  doc := private.hr_doc_held(p_document);
  if not (private.is_org_admin(doc.org_id)
          or (doc.source = 'employee' and private.is_own_employee(doc.employee_id))) then
    raise exception 'DOC_NOT_FOUND';
  end if;

  delete from public.hr_documents d where d.id = doc.id;
  if doc.file_path is not null then
    insert into private.hr_released_documents (path) values (doc.file_path) on conflict do nothing;
  end if;

  return jsonb_build_object('id', doc.id, 'employee_id', doc.employee_id, 'path', doc.file_path);
end; $$;
revoke all on function public.hr_remove_document(uuid) from public, anon;
grant execute on function public.hr_remove_document(uuid) to authenticated;

-- ---- a file: may this upload be discarded? -------------------------------------
-- For a file that was uploaded and never attached. True means: whoever asks
-- could have uploaded it (an owner or admin of the workspace in the path, or
-- the employee in the path), no document carries it, and none ever will, so
-- the app may remove it. Anything else is false, with no reason given: no
-- user, a session that owes a second factor, no path, a path of another
-- shape, the demo, someone else's folder, a path a document carries, or a
-- path with no uploaded file behind it (unless it was released before: the
-- app may be trying again after a removal that failed).

create or replace function public.hr_release_document_file(p_path text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  org uuid;
  employee uuid;
begin
  if auth.uid() is null or not private.mfa_ok() or p_path is null then return false; end if;
  if p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$' then
    return false;
  end if;
  org := split_part(p_path, '/', 1)::uuid;
  employee := split_part(p_path, '/', 2)::uuid;
  if private.is_demo_org(org) then return false; end if;
  if not (private.is_org_admin(org)
          or (private.is_own_employee(employee)
              and exists (select 1 from public.hr_employees e where e.id = employee and e.org_id = org))) then
    return false;
  end if;

  -- Held to the end of the transaction; attaching a file takes the same one.
  perform pg_advisory_xact_lock(hashtextextended(p_path, 0));
  if exists (select 1 from public.hr_documents d where d.file_path = p_path) then return false; end if;
  if exists (select 1 from private.hr_released_documents x where x.path = p_path) then return true; end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'hr-documents' and o.name = p_path
  ) then
    return false;
  end if;

  insert into private.hr_released_documents (path) values (p_path) on conflict do nothing;
  return true;
end; $$;
revoke all on function public.hr_release_document_file(text) from public, anon;
grant execute on function public.hr_release_document_file(text) to authenticated;

-- ---- acknowledgement: ask, or withdraw the request (owners and admins) ----------
-- Only for a document an owner or admin added. Withdrawing the request clears
-- the acknowledgement; asking again leaves one that is already there.

create or replace function public.hr_request_document_ack(p_document uuid, p_requested boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  doc public.hr_documents;
begin
  doc := private.hr_doc_held(p_document);
  if not private.is_org_admin(doc.org_id) then raise exception 'DOC_NOT_FOUND'; end if;
  if p_requested is null then raise exception 'DOC_BAD_INPUT'; end if;
  if doc.source = 'employee' then raise exception 'DOC_NOT_ALLOWED'; end if;

  update public.hr_documents d
  set ack_requested = p_requested, acknowledged_at = case when p_requested then d.acknowledged_at end
  where d.id = doc.id
  returning d.* into doc;

  return private.hr_document_json(doc);
end; $$;
revoke all on function public.hr_request_document_ack(uuid, boolean) from public, anon;
grant execute on function public.hr_request_document_ack(uuid, boolean) to authenticated;

-- ---- acknowledgement: "I have read this" -------------------------------------------
-- The employee the document belongs to, and nobody else: not an owner, not an
-- admin (unless the document is their own). Once, and only while it is asked
-- for.

create or replace function public.hr_acknowledge_document(p_document uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  doc public.hr_documents;
begin
  doc := private.hr_doc_held(p_document);
  if not private.is_own_employee(doc.employee_id) then raise exception 'DOC_NOT_FOUND'; end if;
  if not doc.ack_requested then raise exception 'DOC_ACK_NOT_REQUESTED'; end if;
  if doc.acknowledged_at is not null then raise exception 'DOC_ALREADY_ACKNOWLEDGED'; end if;

  update public.hr_documents d set acknowledged_at = now() where d.id = doc.id returning d.* into doc;

  return private.hr_document_json(doc);
end; $$;
revoke all on function public.hr_acknowledge_document(uuid) from public, anon;
grant execute on function public.hr_acknowledge_document(uuid) to authenticated;

-- ---- deleting an employee ---------------------------------------------------------
-- What the app's delete did, as a function, so the paths of the employee's
-- files can be handed back before their documents go with them: an owner or
-- admin of the workspace named deletes an employee of it, and is handed the
-- employee's id and name and those paths, each released. Null when there is
-- nothing to delete for this caller: no user, another workspace's employee,
-- an id that is no employee, a caller who is not an owner or admin, the demo.
-- An employee with a paid payslip is still refused, by the trigger of the
-- payroll slice, with its own code (HR_EMPLOYEE_HAS_PAID_PAYSLIPS); nothing
-- is released then. The row is held first, so no document can be added to
-- the employee between the paths being read and the row going; the
-- employee's documents are held next, so no file can be replaced in between.

create or replace function public.hr_delete_employee(p_org uuid, p_employee uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  emp public.hr_employees;
  paths text[];
begin
  if auth.uid() is null then return null; end if;
  select e.* into emp from public.hr_employees e where e.id = p_employee and e.org_id = p_org for update;
  if not found then return null; end if;
  if private.is_demo_org(emp.org_id) or not private.is_org_admin(emp.org_id) then return null; end if;

  perform 1 from public.hr_documents d where d.employee_id = emp.id for update;
  select coalesce(array_agg(d.file_path order by d.file_path), '{}') into paths
  from public.hr_documents d where d.employee_id = emp.id and d.file_path is not null;
  insert into private.hr_released_documents (path) select unnest(paths) on conflict do nothing;
  delete from public.hr_employees e where e.id = emp.id;

  return jsonb_build_object('id', emp.id, 'name', emp.name, 'document_paths', to_jsonb(paths));
end; $$;
revoke all on function public.hr_delete_employee(uuid, uuid) from public, anon;
grant execute on function public.hr_delete_employee(uuid, uuid) to authenticated;

-- ---- the sweep: files with no document ----------------------------------------------
-- For the app's service client, and nobody else. Two steps.
-- Listing changes nothing: the names in the bucket, under one workspace's
-- folder, that are no document's file and are more than a day old (a younger
-- one may still be on its way to a document).
-- Releasing is what makes a file safe to remove: for up to p_limit of those
-- names (500 at most, and by default), each under the lock attaching takes,
-- it looks again (still there, still more than a day old, still on no
-- document), records the path as released, so it can never be attached, and
-- hands it back. The sweep removes only what this step hands back, never
-- what the listing showed, and calls it again until it hands back nothing
-- new. The workspace need not exist any more: a deleted workspace's folder is
-- swept the same way.

create or replace function public.hr_orphaned_document_files(p_org uuid)
returns setof text language sql stable security definer set search_path = public as $$
  select o.name from storage.objects o
  where o.bucket_id = 'hr-documents' and o.name like p_org::text || '/%'
    and o.created_at < now() - interval '1 day'
    and not exists (select 1 from public.hr_documents d where d.file_path = o.name)
  order by o.name;
$$;
revoke all on function public.hr_orphaned_document_files(uuid) from public, anon, authenticated;
grant execute on function public.hr_orphaned_document_files(uuid) to service_role;

create or replace function public.hr_release_orphaned_document_files(p_org uuid, p_limit int default 500)
returns setof text language plpgsql security definer set search_path = public as $$
declare
  f text;
begin
  for f in
    select o.name from storage.objects o
    where o.bucket_id = 'hr-documents' and o.name like p_org::text || '/%'
      and o.created_at < now() - interval '1 day'
      and not exists (select 1 from public.hr_documents d where d.file_path = o.name)
    order by o.name
    limit least(greatest(coalesce(p_limit, 500), 0), 500)
  loop
    -- Held to the end of the transaction; attaching a file takes the same one.
    perform pg_advisory_xact_lock(hashtextextended(f, 0));
    continue when exists (select 1 from public.hr_documents d where d.file_path = f);
    continue when not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'hr-documents' and o.name = f and o.created_at < now() - interval '1 day'
    );
    insert into private.hr_released_documents (path) values (f) on conflict do nothing;
    return next f;
  end loop;
end; $$;
revoke all on function public.hr_release_orphaned_document_files(uuid, int) from public, anon, authenticated;
grant execute on function public.hr_release_orphaned_document_files(uuid, int) to service_role;

-- ---- files: a private bucket ------------------------------------------------------
-- 10 MB a file; PDF, JPEG, PNG, WebP and HEIC. Nothing is public: the app
-- hands out links that last a minute, and the read rule below is what decides.
--   select: the file is the file of a document, and the caller is the
--     employee it belongs to or an owner or admin of its workspace.
--   insert: a path of the one shape, under a workspace that is not the demo
--     and an employee of that workspace, by a signed-up (not anonymous)
--     account that is an owner or admin there or is that employee. The case
--     keeps the casts from ever running on another bucket's names or on a
--     name of another shape. Inside the look-up the file's name is written
--     in full (storage.objects.name): an employee has a `name` too. Never
--     at a path a document already carries: should that document's file ever
--     go missing, nobody can put another in its place.
--   update, delete: nobody. The app removes files with the service client.
-- A session that still owes a second factor gets nothing in this bucket.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hr-documents', 'hr-documents', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public = false, file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp','image/heic'];

create policy hr_document_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hr-documents'
    and exists (
      select 1 from public.hr_documents d
      where d.file_path = storage.objects.name
        and (private.is_org_admin(d.org_id) or private.is_own_employee(d.employee_id))
    )
  );
create policy hr_document_files_insert on storage.objects
  for insert to authenticated
  with check (
    case when bucket_id = 'hr-documents'
              and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$'
         then not private.is_demo_org(((storage.foldername(name))[1])::uuid)
              and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false
              and exists (
                select 1 from public.hr_employees e
                where e.id = ((storage.foldername(storage.objects.name))[2])::uuid
                  and e.org_id = ((storage.foldername(storage.objects.name))[1])::uuid
                  and (private.is_org_admin(e.org_id) or private.is_own_employee(e.id))
              )
              and not exists (select 1 from public.hr_documents d where d.file_path = storage.objects.name)
         else false end
  );
create policy hr_document_files_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'hr-documents' or (select private.mfa_ok()))
  with check (bucket_id <> 'hr-documents' or (select private.mfa_ok()));
