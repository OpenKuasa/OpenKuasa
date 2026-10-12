import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const DOCUMENTS = '20261102090050_people_documents_writes.sql';
const LETTERS = '20261102090100_people_letters_writes.sql';
const SEED = '20261102090200_people_documents_demo_seed.sql';
const FILES = [DOCUMENTS, LETTERS, SEED];

const raw = (file: string) => readFileSync(join(DIR, file), 'utf8');

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  raw(file)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The two files that hold the rules, read as one. */
const rules = () => `${statements(DOCUMENTS)}\n${statements(LETTERS)}`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<workspace>/<employee>/<uuid>.<ext>`, as the database spells it. */
const PATH_RULE = `'^${UUID}/${UUID}/${UUID}\\.(pdf|jpg|png|webp|heic)$'`;
const PLACEHOLDER_RULE = "'\\{(employee_name|employee_no|designation|department|join_date|company_name|today)\\}'";

type Fn = { name: string; args: string; file: string; gate: string; returns: 'jsonb' | 'boolean' };

/** The sixteen functions the app calls: the argument types their grants name, and the gate each passes before it writes. */
const FUNCTIONS: Fn[] = [
  { name: 'hr_add_document', args: 'uuid, text, text, date, text, text, bigint, text', file: DOCUMENTS, gate: 'private.hr_doc_employee(p_employee)', returns: 'jsonb' },
  { name: 'hr_update_document', args: 'uuid, text, text, date', file: DOCUMENTS, gate: 'private.hr_doc_held(p_document)', returns: 'jsonb' },
  { name: 'hr_replace_document_file', args: 'uuid, text, text, bigint, text', file: DOCUMENTS, gate: 'private.hr_doc_held(p_document)', returns: 'jsonb' },
  { name: 'hr_remove_document', args: 'uuid', file: DOCUMENTS, gate: 'private.hr_doc_held(p_document)', returns: 'jsonb' },
  { name: 'hr_release_document_file', args: 'text', file: DOCUMENTS, gate: 'private.is_demo_org(org)', returns: 'boolean' },
  { name: 'hr_request_document_ack', args: 'uuid, boolean', file: DOCUMENTS, gate: 'private.hr_doc_held(p_document)', returns: 'jsonb' },
  { name: 'hr_acknowledge_document', args: 'uuid', file: DOCUMENTS, gate: 'private.hr_doc_held(p_document)', returns: 'jsonb' },
  { name: 'hr_delete_employee', args: 'uuid, uuid', file: DOCUMENTS, gate: 'private.is_demo_org(emp.org_id)', returns: 'jsonb' },
  { name: 'hr_save_letter', args: 'uuid, uuid, text, text, text, boolean', file: LETTERS, gate: 'private.hr_letter_employee(p_employee)', returns: 'jsonb' },
  { name: 'hr_start_letter_from_template', args: 'uuid, uuid', file: LETTERS, gate: 'private.hr_letter_employee(p_employee)', returns: 'jsonb' },
  { name: 'hr_issue_letter', args: 'uuid', file: LETTERS, gate: 'private.hr_letter_held(p_letter)', returns: 'jsonb' },
  { name: 'hr_unissue_letter', args: 'uuid', file: LETTERS, gate: 'private.hr_letter_held(p_letter)', returns: 'jsonb' },
  { name: 'hr_delete_letter', args: 'uuid', file: LETTERS, gate: 'private.hr_letter_held(p_letter)', returns: 'jsonb' },
  { name: 'hr_acknowledge_letter', args: 'uuid', file: LETTERS, gate: 'private.hr_letter_held(p_letter)', returns: 'jsonb' },
  { name: 'hr_save_letter_template', args: 'uuid, uuid, text, text, text, text', file: LETTERS, gate: 'private.hr_template_held(p_org, p_template)', returns: 'jsonb' },
  { name: 'hr_delete_letter_template', args: 'uuid', file: LETTERS, gate: 'private.hr_template_held(null, p_template)', returns: 'jsonb' },
];
const HELPERS: Record<string, string[]> = {
  [DOCUMENTS]: ['private.hr_doc_employee', 'private.hr_doc_held', 'private.hr_doc_file_ok', 'private.hr_document_json'],
  [LETTERS]: [
    'private.hr_seed_letter_templates', 'private.hr_seed_letter_templates_new_org', 'private.hr_letter_employee', 'private.hr_letter_held',
    'private.hr_template_held', 'private.hr_letter_json', 'private.hr_letter_fill',
  ],
};
/** The two steps of the sweep: for the app's service client only. */
const SWEEP = [
  { name: 'hr_orphaned_document_files', args: 'uuid' },
  { name: 'hr_release_orphaned_document_files', args: 'uuid, int' },
];
const DOC_CODES = [
  'DOC_NOT_ALLOWED', 'DOC_NOT_FOUND', 'DOC_BAD_INPUT', 'DOC_TYPE_NOT_ALLOWED', 'DOC_TOO_MANY', 'DOC_BAD_FILE',
  'DOC_ACK_NOT_REQUESTED', 'DOC_ALREADY_ACKNOWLEDGED',
];
const LETTER_CODES = [
  'LETTER_NOT_ALLOWED', 'LETTER_NOT_FOUND', 'LETTER_BAD_INPUT', 'LETTER_NOT_DRAFT', 'LETTER_NOT_ISSUED', 'LETTER_EMPTY',
  'LETTER_PLACEHOLDER', 'LETTER_ACK_NOT_REQUESTED', 'LETTER_ALREADY_ACKNOWLEDGED', 'LETTER_TEMPLATE_EXISTS',
  'LETTER_TOO_MANY_TEMPLATES',
];
const DOC_TYPES = "('contract','tax','benefits','identity','medical','certificate','other')";
const LETTER_TYPES = "('offer','confirmation','promotion','warning','contract_renewal','other')";

/** One function's text: `header` up to `as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}

/** Every function a file creates, by its qualified name. */
const allFunctions = (text: string) =>
  [...text.matchAll(/create or replace function ((?:public|private)\.\w+)\(/g)].map((m) => m[1]);

/** Where the first statement that changes a row begins. */
function firstWrite(body: string): number {
  const at = ['insert into public.', 'update public.', 'delete from public.', 'insert into private.']
    .map((s) => body.indexOf(s))
    .filter((i) => i > -1);
  return at.length ? Math.min(...at) : -1;
}

/** The bare messages of every `raise exception` in a piece of text. */
const raised = (text: string) => [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
const codes = (text: string) => [...new Set(raised(text).map((m) => m.slice(1, -1)))].sort();

describe('Lekiu letters and documents migrations', () => {
  test('the three files exist, in order, after everything they build on, each alone on its version', () => {
    const files = readdirSync(DIR).sort();
    const at = FILES.map((f) => files.indexOf(f));
    expect(at.every((i) => i > -1)).toBe(true);
    expect(at).toEqual([at[0], at[0] + 1, at[0] + 2]);
    for (const f of FILES) expect(files.filter((x) => x.slice(0, 14) === f.slice(0, 14)), f).toEqual([f]);
    expect(FILES.map((f) => f.slice(0, 14))).toEqual(['20261102090050', '20261102090100', '20261102090200']);
  });

  test('documents: old rows dealt with as the type check is replaced, then the columns and checks of the spec', () => {
    const text = statements(DOCUMENTS);
    // The demo's placeholder payslips and letters go; any other row of an old type becomes `other`.
    const gone = text.indexOf("delete from public.hr_documents d\nwhere d.doc_type in ('payslip','letter') and private.is_demo_org(d.org_id);");
    const mapped = text.indexOf(`update public.hr_documents set doc_type = 'other'\nwhere doc_type not in ${DOC_TYPES};`);
    const dropped = text.indexOf("pg_get_constraintdef(con.oid) like '%doc_type%'");
    const added = text.indexOf(`add constraint hr_documents_doc_type_check check (doc_type in ${DOC_TYPES}),`);
    // In that order: the old check does not know `other`, and the new one does not know the old types.
    expect(gone).toBeGreaterThan(-1);
    expect([gone, dropped, mapped, added]).toEqual([...[gone, dropped, mapped, added]].sort((a, b) => a - b));
    expect(text).toContain("if dropped = 0 then raise exception 'the doc_type check on hr_documents was not found'; end if;");
    // Nothing else of anyone's is deleted outside a function.
    const outside = text.replace(/ as \$\$[\s\S]*?\$\$;/g, '');
    expect(outside.match(/delete from/g)).toHaveLength(1);
    for (const line of [
      'add column file_path text,',
      'add column file_name text check (file_name is null or char_length(file_name) <= 200),',
      'add column file_size bigint,',
      'add column file_type text,',
      'add column uploaded_by uuid references auth.users(id) on delete set null,',
      "add column source text not null default 'hr' check (source in ('hr','employee')),",
      'add column ack_requested boolean not null default false,',
      'add column acknowledged_at timestamptz,',
      "add constraint hr_documents_acknowledgement\n    check ((acknowledged_at is null or ack_requested) and (source <> 'employee' or not ack_requested)),",
      // A file comes with its name, size and type, or there is none of the four.
      'add constraint hr_documents_file_columns check (num_nulls(file_path, file_name, file_size, file_type) in (0, 4));',
      'create unique index hr_documents_file_path_idx on public.hr_documents (file_path) where file_path is not null;',
    ]) {
      expect(text, line).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(8);
    // The status column and its check stay as they are, for the app deployed before this slice.
    expect(text).not.toMatch(/drop (table|column|default)|alter column|pending_signature/);
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual(['alter table public.hr_documents']);
    expect(text.match(/create table/g)).toHaveLength(1);
  });

  test('letters: old rows dealt with before the checks are added, then the columns and checks of the spec', () => {
    const text = statements(LETTERS);
    const mapped = text.indexOf('update public.hr_letters l\nset letter_type = case');
    const dated = text.indexOf("update public.hr_letters set issued_on = (created_at at time zone 'Asia/Kuala_Lumpur')::date\nwhere status = 'issued' and issued_on is null;");
    const undated = text.indexOf("update public.hr_letters set issued_on = null where status = 'draft' and issued_on is not null;");
    const added = text.indexOf(`add constraint hr_letters_letter_type_check check (letter_type in ${LETTER_TYPES}),`);
    for (const at of [mapped, dated, undated]) {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(added);
    }
    expect(text).toContain(`else 'other' end\nwhere l.letter_type not in ${LETTER_TYPES};`);
    for (const line of [
      "add column body text not null default '' check (char_length(body) <= 10000),",
      'add column issued_by uuid references auth.users(id) on delete set null,',
      'add column ack_requested boolean not null default false,',
      'add column acknowledged_at timestamptz,',
      'add column template_id uuid references public.hr_letter_templates(id) on delete set null,',
      "add constraint hr_letters_issued_on check ((status = 'issued') = (issued_on is not null)),",
      "add constraint hr_letters_acknowledgement check (acknowledged_at is null or (status = 'issued' and ack_requested));",
    ]) {
      expect(text, line).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(5);
    // No letter of anyone's is deleted by the migration itself, and nothing is dropped.
    expect(text).not.toMatch(/drop (table|column|default|constraint)|alter column/);
    expect(text.replace(/ as \$\$[\s\S]*?\$\$;/g, '')).not.toMatch(/delete from/);
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual(['alter table public.hr_letters']);
  });

  test('templates: the table of the spec, read by owners and admins only, one name per workspace, and no way to write', () => {
    const text = statements(LETTERS);
    expect(text).toContain(
      'create table public.hr_letter_templates (\n'
        + '  id uuid primary key default gen_random_uuid(),\n'
        + '  org_id uuid not null references public.orgs(id) on delete cascade,\n'
        + '  name text not null check (char_length(trim(name)) between 1 and 120),\n'
        + `  letter_type text not null check (letter_type in ${LETTER_TYPES}),\n`
        + '  title text not null check (char_length(trim(title)) between 1 and 200),\n'
        + "  body text not null default '' check (char_length(body) <= 10000),\n"
        + '  created_at timestamptz not null default now(),\n'
        + '  updated_at timestamptz not null default now()\n'
        + ');',
    );
    expect(text.match(/create table/g)).toHaveLength(1);
    expect(text).toContain('create unique index hr_letter_templates_org_name_idx on public.hr_letter_templates (org_id, lower(name));');
    expect(text).toContain("select private.people_secure_table('hr_letter_templates', 'hr');");
    // The table exists before the letters point at it.
    expect(text.indexOf('create table public.hr_letter_templates')).toBeLessThan(text.indexOf('add column template_id'));
  });

  test('the starter templates: one per letter type, for every workspace with none and for each new one', () => {
    const text = statements(LETTERS);
    const { header, body } = fn(text, 'private.hr_seed_letter_templates');
    expect(header).toContain('security definer set search_path = public');
    expect(body).toContain('insert into public.hr_letter_templates (org_id, name, letter_type, title, body)');
    expect(body).toContain('where not exists (select 1 from public.hr_letter_templates t where t.org_id = p_org)');
    const starters = [...body.matchAll(/^\s+\('([^']+)', '([a-z_]+)', /gm)].map((m) => m[2]);
    expect(starters.sort()).toEqual(['confirmation', 'contract_renewal', 'offer', 'other', 'promotion', 'warning']);
    expect(body).toContain('{employee_name}');
    expect(body).toContain('{company_name}');
    expect(text).toContain(
      'create trigger hr_seed_letter_templates_new_org\n  after insert on public.orgs\n  for each row execute function private.hr_seed_letter_templates_new_org();',
    );
    expect(fn(text, 'private.hr_seed_letter_templates_new_org').body).toContain('perform private.hr_seed_letter_templates(new.id);');
    expect(text).toContain('select private.hr_seed_letter_templates(o.id) from public.orgs o;');
  });

  test('the bucket: private, 10 MB, a PDF or one of four image types', () => {
    const text = statements(DOCUMENTS);
    expect(text).toContain(
      'insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)\n'
        + "values ('hr-documents', 'hr-documents', false, 10485760,\n"
        + "        array['application/pdf','image/jpeg','image/png','image/webp','image/heic'])\n"
        + 'on conflict (id) do update\n'
        + '  set public = false, file_size_limit = 10485760,\n'
        + "      allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp','image/heic'];",
    );
    expect(statements(LETTERS)).not.toMatch(/storage\./);
  });

  test('storage: a file is read through its document, written only into a folder the caller may write, never changed or removed', () => {
    const text = statements(DOCUMENTS);
    expect((text.match(/create policy (\w+) on storage\.objects/g) ?? []).sort()).toEqual([
      'create policy hr_document_files_insert on storage.objects',
      'create policy hr_document_files_mfa_required on storage.objects',
      'create policy hr_document_files_select on storage.objects',
    ]);
    expect(text.match(/create policy/g)).toHaveLength(3);
    expect(text).toContain(
      'create policy hr_document_files_select on storage.objects\n'
        + '  for select to authenticated\n'
        + '  using (\n'
        + "    bucket_id = 'hr-documents'\n"
        + '    and exists (\n'
        + '      select 1 from public.hr_documents d\n'
        + '      where d.file_path = storage.objects.name\n'
        + '        and (private.is_org_admin(d.org_id) or private.is_own_employee(d.employee_id))\n'
        + '    )\n'
        + '  );',
    );
    expect(text).toContain(
      'create policy hr_document_files_insert on storage.objects\n'
        + '  for insert to authenticated\n'
        + '  with check (\n'
        + "    case when bucket_id = 'hr-documents'\n"
        + `              and name ~ ${PATH_RULE}\n`
        + '         then not private.is_demo_org(((storage.foldername(name))[1])::uuid)\n'
        + "              and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false\n"
        + '              and exists (\n'
        + '                select 1 from public.hr_employees e\n'
        // Written in full inside the look-up: a bare `name` there would be the employee's.
        + '                where e.id = ((storage.foldername(storage.objects.name))[2])::uuid\n'
        + '                  and e.org_id = ((storage.foldername(storage.objects.name))[1])::uuid\n'
        + '                  and (private.is_org_admin(e.org_id) or private.is_own_employee(e.id))\n'
        + '              )\n'
        // Never at a path a document carries, should that document's file ever go missing.
        + '              and not exists (select 1 from public.hr_documents d where d.file_path = storage.objects.name)\n'
        + '         else false end\n'
        + '  );',
    );
    expect(text).toContain(
      'create policy hr_document_files_mfa_required on storage.objects as restrictive\n'
        + '  for all to authenticated\n'
        + "  using (bucket_id <> 'hr-documents' or (select private.mfa_ok()))\n"
        + "  with check (bucket_id <> 'hr-documents' or (select private.mfa_ok()));",
    );
    // No update or delete policy, for anyone, and nothing for signed-out visitors.
    expect(text).not.toMatch(/for (update|delete) to|\bto (anon|public)\b/);
  });

  test('a path is the same shape everywhere, checked against the workspace, the folder, the type and what is attached or released', () => {
    const text = statements(DOCUMENTS);
    expect(text.split(PATH_RULE).length - 1).toBe(3);
    const { body } = fn(text, 'private.hr_doc_file_ok');
    expect(body).toContain(`p_path !~ ${PATH_RULE}`);
    expect(body).toContain("split_part(p_path, '/', 1) <> p_org::text");
    expect(body).toContain("split_part(p_path, '/', 2) <> p_employee::text");
    expect(body).toContain("when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png'");
    expect(body).toContain("when 'image/webp' then 'webp' when 'image/heic' then 'heic' end");
    expect(body).toContain('p_size < 1 or p_size > 10485760');
    const lock = body.indexOf('perform pg_advisory_xact_lock(hashtextextended(p_path, 0));');
    expect(lock).toBeGreaterThan(-1);
    for (const read of [
      "select o.metadata into meta from storage.objects o\n  where o.bucket_id = 'hr-documents' and o.name = p_path;",
      'if not found\n',
      'select 1 from public.hr_documents d where d.file_path = p_path',
      'select 1 from private.hr_released_documents x where x.path = p_path',
    ]) {
      expect(body.indexOf(read), read).toBeGreaterThan(lock);
    }
    // What storage recorded of the file is what the caller must say; a key it did not record is not held against them.
    expect(body).toContain("if (meta ? 'size' and meta ->> 'size' <> p_size::text)\n     or (meta ? 'mimetype' and meta ->> 'mimetype' <> p_type) then\n    raise exception 'DOC_BAD_FILE';");
    expect(codes(body)).toEqual(['DOC_BAD_FILE']);
    for (const name of ['hr_add_document', 'hr_replace_document_file']) {
      const caller = fn(text, `public.${name}`).body;
      expect(caller.indexOf('private.hr_doc_file_ok('), name).toBeGreaterThan(-1);
      expect(caller.indexOf('private.hr_doc_file_ok('), name).toBeLessThan(firstWrite(caller));
      expect(caller, name).toContain("exception when unique_violation then\n    raise exception 'DOC_BAD_FILE';");
    }
    // Releasing takes the same lock, and never says yes to a path a document carries.
    const release = fn(text, 'public.hr_release_document_file').body;
    expect(release).toContain(`p_path !~ ${PATH_RULE}`);
    const held = release.indexOf('perform pg_advisory_xact_lock(hashtextextended(p_path, 0));');
    const attached = release.indexOf('if exists (select 1 from public.hr_documents d where d.file_path = p_path) then return false; end if;');
    expect(held).toBeGreaterThan(-1);
    expect(attached).toBeGreaterThan(held);
    expect(release.indexOf('insert into private.hr_released_documents')).toBeGreaterThan(attached);
    expect(raised(release)).toEqual([]);
  });

  test('released paths: a private table nobody is granted, the service role included', () => {
    const text = statements(DOCUMENTS);
    expect(text).toContain(
      'create table private.hr_released_documents (\n'
        + '  path text primary key,\n'
        + '  released_at timestamptz not null default now()\n'
        + ');',
    );
    expect(text).toContain('alter table private.hr_released_documents enable row level security;');
    expect(text).toContain('revoke all on private.hr_released_documents from public, anon, authenticated, service_role;');
    // A file leaves its document only into that list: replaced, removed, or gone with its employee.
    for (const name of ['hr_replace_document_file', 'hr_remove_document', 'hr_delete_employee']) {
      expect(fn(text, `public.${name}`).body, name).toContain('insert into private.hr_released_documents (path)');
    }
  });

  test('the sweep: two public functions for the service role only, a listing that changes nothing and a release that is limited', () => {
    const text = statements(DOCUMENTS);
    expect((rules().match(/[^\n]*service_role[^\n]*/g) ?? []).map((l) => l.trim()).sort()).toEqual([
      'grant execute on function public.hr_orphaned_document_files(uuid) to service_role;',
      'grant execute on function public.hr_release_orphaned_document_files(uuid, int) to service_role;',
      'revoke all on private.hr_released_documents from public, anon, authenticated, service_role;',
    ]);
    // The service role is let into no schema it was not in, and signed-in users are let into neither function.
    expect(rules()).not.toMatch(/grant usage|private\.hr_orphaned/);
    for (const { name, args } of SWEEP) {
      expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`);
      expect(text).not.toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
      const { header, body } = fn(text, `public.${name}`);
      expect(header, name).toMatch(/returns setof text language (sql stable|plpgsql) security definer set search_path = public$/);
      expect(body, name).toContain("o.bucket_id = 'hr-documents' and o.name like p_org::text || '/%'");
      expect(body, name).toContain("and o.created_at < now() - interval '1 day'");
      expect(body, name).toContain('and not exists (select 1 from public.hr_documents d where d.file_path = o.name)');
    }
    // Listing: one read, declared stable, so the database itself refuses a write from it.
    const list = fn(text, 'public.hr_orphaned_document_files');
    expect(list.header).toContain('(p_org uuid)\nreturns setof text language sql stable');
    expect(list.body).not.toMatch(/\b(insert|update|delete|perform)\b/);
    // Releasing: at most 500 a call; each path locked, looked at again, recorded, and only then handed back.
    const release = fn(text, 'public.hr_release_orphaned_document_files');
    expect(release.header).toContain('(p_org uuid, p_limit int default 500)');
    const steps = [
      'limit least(greatest(coalesce(p_limit, 500), 0), 500)',
      'perform pg_advisory_xact_lock(hashtextextended(f, 0));',
      'continue when exists (select 1 from public.hr_documents d where d.file_path = f);',
      "where o.bucket_id = 'hr-documents' and o.name = f and o.created_at < now() - interval '1 day'",
      'insert into private.hr_released_documents (path) values (f) on conflict do nothing;',
      'return next f;',
    ].map((step) => release.body.indexOf(step));
    expect(steps.every((i) => i > -1)).toBe(true);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
  });

  test('no table gets a write grant or a write policy', () => {
    const text = rules();
    expect((text.match(/grant [^;]*;/g) ?? []).sort()).toEqual(
      [
        ...FUNCTIONS.map((f) => `grant execute on function public.${f.name}(${f.args}) to authenticated;`),
        ...SWEEP.map((f) => `grant execute on function public.${f.name}(${f.args}) to service_role;`),
      ].sort(),
    );
    expect(text).not.toMatch(/grant\s+(all|select|insert|update|delete|truncate)/i);
    expect(text).not.toMatch(/disable row level security/i);
    expect(text).not.toMatch(/drop policy/);
    expect(statements(SEED)).not.toMatch(/\bgrant\b|(create|drop) policy|alter table|create table|storage\./);
  });

  test('the sixteen functions and the two of the sweep, and no other in the public schema', () => {
    for (const file of [DOCUMENTS, LETTERS]) {
      const made = allFunctions(statements(file));
      expect(made.filter((n) => n.startsWith('public.'))).toEqual([
        ...FUNCTIONS.filter((f) => f.file === file).map((f) => `public.${f.name}`),
        ...(file === DOCUMENTS ? SWEEP.map((f) => `public.${f.name}`) : []),
      ]);
      expect(made.filter((n) => n.startsWith('private.'))).toEqual(HELPERS[file]);
      expect(new Set(made).size).toBe(made.length);
    }
    expect(FUNCTIONS).toHaveLength(16);
  });

  test.each(FUNCTIONS)('$name runs as the owner on a fixed search path, for signed-in users only', ({ name, args, file, returns }) => {
    const text = statements(file);
    const { header } = fn(text, `public.${name}`);
    expect(header).toMatch(new RegExp(`returns ${returns} language plpgsql security definer set search_path = public$`));
    // As many arguments as the grant names.
    expect(header.slice(header.indexOf('(') + 1, header.indexOf(')')).split(',')).toHaveLength(args.split(', ').length);
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test('the argument names are the ones the app passes', () => {
    const text = rules();
    const names = (name: string) => {
      const { header } = fn(text, `public.${name}`);
      return header.slice(header.indexOf('(') + 1, header.indexOf(')')).split(',').map((a) => a.trim().split(' ')[0]);
    };
    expect(names('hr_add_document')).toEqual(['p_employee', 'p_title', 'p_doc_type', 'p_expires_on', 'p_file_path', 'p_file_name', 'p_file_size', 'p_file_type']);
    expect(names('hr_update_document')).toEqual(['p_document', 'p_title', 'p_doc_type', 'p_expires_on']);
    expect(names('hr_replace_document_file')).toEqual(['p_document', 'p_file_path', 'p_file_name', 'p_file_size', 'p_file_type']);
    expect(names('hr_remove_document')).toEqual(['p_document']);
    expect(names('hr_release_document_file')).toEqual(['p_path']);
    expect(names('hr_request_document_ack')).toEqual(['p_document', 'p_requested']);
    expect(names('hr_acknowledge_document')).toEqual(['p_document']);
    expect(names('hr_delete_employee')).toEqual(['p_org', 'p_employee']);
    expect(names('hr_save_letter')).toEqual(['p_employee', 'p_letter', 'p_letter_type', 'p_title', 'p_body', 'p_ack_requested']);
    expect(names('hr_start_letter_from_template')).toEqual(['p_employee', 'p_template']);
    for (const name of ['hr_issue_letter', 'hr_unissue_letter', 'hr_delete_letter', 'hr_acknowledge_letter']) expect(names(name)).toEqual(['p_letter']);
    expect(names('hr_save_letter_template')).toEqual(['p_org', 'p_template', 'p_name', 'p_letter_type', 'p_title', 'p_body']);
    expect(names('hr_delete_letter_template')).toEqual(['p_template']);
  });

  test.each(FUNCTIONS)('$name passes its gate, which refuses the demo, before it changes anything', ({ name, file, gate }) => {
    const text = statements(file);
    const { body } = fn(text, `public.${name}`);
    const call = body.indexOf(gate);
    expect(call, name).toBeGreaterThan(-1);
    expect(firstWrite(body), name).toBeGreaterThan(call);
    // Nobody is let in on being a writer, or on a role read here.
    expect(body, name).not.toMatch(/is_org_writer|\brole\b/);
  });

  test('the gates: signed in, the row held before it is read, hidden from outsiders, never the demo', () => {
    const all = rules();
    const gates: [string, string, string][] = [
      ['private.hr_doc_held', 'select d.* into doc from public.hr_documents d where d.id = p_document for update;', 'DOC'],
      ['private.hr_letter_held', 'select l.* into letter from public.hr_letters l where l.id = p_letter for update;', 'LETTER'],
      ['private.hr_template_held', 'select t.* into tpl from public.hr_letter_templates t where t.id = p_template for update;', 'LETTER'],
    ];
    for (const [name, lock, prefix] of gates) {
      const { body } = fn(all, name);
      const signedIn = body.indexOf(`if auth.uid() is null then raise exception '${prefix}_NOT_ALLOWED'; end if;`);
      const held = body.indexOf(lock);
      const missing = body.indexOf(`if not found then raise exception '${prefix}_NOT_FOUND'; end if;`, held);
      const hidden = body.indexOf(`raise exception '${prefix}_NOT_FOUND';`, missing + 10);
      const demo = body.lastIndexOf(`then raise exception '${prefix}_NOT_ALLOWED'; end if;`);
      const order = [signedIn, held, missing, hidden, demo];
      expect(order.every((i) => i > -1), name).toBe(true);
      expect([...order].sort((a, b) => a - b), name).toEqual(order);
      expect(body, name).toContain('private.is_demo_org(');
      expect(body, name).toContain('private.is_org_admin(');
    }
    // An employee named: owners and admins, and for a document the employee themselves; never the demo; one answer for all the rest.
    const docEmployee = fn(all, 'private.hr_doc_employee').body;
    expect(docEmployee).toContain('select e.* into emp from public.hr_employees e where e.id = p_employee for no key update;');
    expect(docEmployee).toContain('if not (private.is_org_admin(emp.org_id) or private.is_own_employee(emp.id)) then');
    expect(codes(docEmployee)).toEqual(['DOC_NOT_ALLOWED']);
    const letterEmployee = fn(all, 'private.hr_letter_employee').body;
    expect(letterEmployee).toContain('private.is_demo_org(emp.org_id) or not private.is_org_admin(emp.org_id)');
    expect(letterEmployee).not.toContain('is_own_employee');
    expect(codes(letterEmployee)).toEqual(['LETTER_NOT_ALLOWED']);
    // A draft letter is hidden from the employee it is addressed to, in the gate itself.
    expect(fn(all, 'private.hr_letter_held').body).toContain("(letter.status = 'issued' and private.is_own_employee(letter.employee_id))");
    // A new template: the workspace named, for its owners and admins, never the demo.
    expect(fn(all, 'private.hr_template_held').body).toContain(
      "if p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then\n      raise exception 'LETTER_NOT_ALLOWED';",
    );
  });

  test('who may do what to a document: owners and admins, and the employee only where the spec says own', () => {
    const text = statements(DOCUMENTS);
    const adminOnly = "if not private.is_org_admin(doc.org_id) then raise exception 'DOC_NOT_FOUND'; end if;";
    for (const name of ['hr_update_document', 'hr_replace_document_file', 'hr_request_document_ack']) {
      const { body } = fn(text, `public.${name}`);
      expect(body.indexOf(adminOnly), name).toBeGreaterThan(-1);
      expect(body.indexOf(adminOnly), name).toBeLessThan(firstWrite(body));
      expect(body, name).not.toContain('is_own_employee');
    }
    const add = fn(text, 'public.hr_add_document').body;
    expect(add).toContain("if not is_admin and p_doc_type not in ('identity','medical','certificate','other') then\n    raise exception 'DOC_TYPE_NOT_ALLOWED';");
    expect(add).toContain("case when is_admin then 'hr' else 'employee' end");
    expect(add).toContain('>= 200 then');
    expect(add.indexOf("raise exception 'DOC_TOO_MANY'")).toBeLessThan(firstWrite(add));
    expect(add).toContain("p_expires_on < date '2000-01-01' or p_expires_on > date '2100-12-31'");
    const remove = fn(text, 'public.hr_remove_document').body;
    expect(remove).toContain(
      "if not (private.is_org_admin(doc.org_id)\n          or (doc.source = 'employee' and private.is_own_employee(doc.employee_id))) then\n    raise exception 'DOC_NOT_FOUND';",
    );
    // Replacing the file clears the acknowledgement; withdrawing the request clears it too.
    expect(fn(text, 'public.hr_replace_document_file').body).toContain('acknowledged_at = null');
    const ask = fn(text, 'public.hr_request_document_ack').body;
    expect(ask).toContain("if doc.source = 'employee' then raise exception 'DOC_NOT_ALLOWED'; end if;");
    expect(ask).toContain('acknowledged_at = case when p_requested then d.acknowledged_at end');
  });

  test('an acknowledgement is recorded only by the employee concerned, once, and only while it is asked for', () => {
    const text = rules();
    const doc = fn(text, 'public.hr_acknowledge_document').body;
    const letter = fn(text, 'public.hr_acknowledge_letter').body;
    const order = (body: string, steps: string[]) => {
      const at = steps.map((s) => body.indexOf(s));
      expect(at.every((i) => i > -1), steps.join(' | ')).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(at[at.length - 1]).toBeLessThan(firstWrite(body));
    };
    order(doc, [
      "if not private.is_own_employee(doc.employee_id) then raise exception 'DOC_NOT_FOUND'; end if;",
      "if not doc.ack_requested then raise exception 'DOC_ACK_NOT_REQUESTED'; end if;",
      "if doc.acknowledged_at is not null then raise exception 'DOC_ALREADY_ACKNOWLEDGED'; end if;",
    ]);
    order(letter, [
      "if not private.is_own_employee(letter.employee_id) then raise exception 'LETTER_NOT_FOUND'; end if;",
      "if letter.status <> 'issued' then raise exception 'LETTER_NOT_ISSUED'; end if;",
      "if not letter.ack_requested then raise exception 'LETTER_ACK_NOT_REQUESTED'; end if;",
      "if letter.acknowledged_at is not null then raise exception 'LETTER_ALREADY_ACKNOWLEDGED'; end if;",
    ]);
    // Nothing else ever sets the time: every other mention clears it, or keeps what was there.
    expect(text.match(/acknowledged_at = now\(\)/g)).toHaveLength(2);
    expect(doc).toContain('acknowledged_at = now()');
    expect(letter).toContain('acknowledged_at = now()');
    const others = text.replace(doc, '').replace(letter, '');
    expect(others).not.toMatch(/acknowledged_at = (?!null|case when p_requested then d\.acknowledged_at end)/);
    expect(others).not.toMatch(/insert into public\.hr_(documents|letters)[^;]*acknowledged_at/);
  });

  test('a letter is changed, issued or deleted only as a draft, by owners and admins, and never issued with a placeholder', () => {
    const text = statements(LETTERS);
    const adminOnly = "if not private.is_org_admin(letter.org_id) then raise exception 'LETTER_NOT_FOUND'; end if;";
    for (const name of ['hr_issue_letter', 'hr_unissue_letter', 'hr_delete_letter']) {
      const { body } = fn(text, `public.${name}`);
      expect(body.indexOf(adminOnly), name).toBeGreaterThan(-1);
      expect(body.indexOf(adminOnly), name).toBeLessThan(firstWrite(body));
    }
    for (const name of ['hr_issue_letter', 'hr_delete_letter', 'hr_save_letter']) {
      const { body } = fn(text, `public.${name}`);
      const at = body.indexOf("if letter.status <> 'draft' then raise exception 'LETTER_NOT_DRAFT'; end if;");
      expect(at, name).toBeGreaterThan(-1);
      expect(at, name).toBeLessThan(body.search(/(update|delete from) public\.hr_letters/));
    }
    const issue = fn(text, 'public.hr_issue_letter').body;
    const empty = issue.indexOf("then raise exception 'LETTER_EMPTY'; end if;");
    const placeholder = issue.indexOf(`if letter.title ~ ${PLACEHOLDER_RULE}\n     or letter.body ~ ${PLACEHOLDER_RULE} then\n    raise exception 'LETTER_PLACEHOLDER';`);
    expect(empty).toBeGreaterThan(-1);
    expect(placeholder).toBeGreaterThan(empty);
    expect(placeholder).toBeLessThan(firstWrite(issue));
    expect(issue).toContain("set status = 'issued', issued_on = (now() at time zone 'Asia/Kuala_Lumpur')::date, issued_by = auth.uid()");
    const back = fn(text, 'public.hr_unissue_letter').body;
    expect(back).toContain("if letter.status <> 'issued' then raise exception 'LETTER_NOT_ISSUED'; end if;");
    expect(back).toContain("set status = 'draft', issued_on = null, issued_by = null, acknowledged_at = null");
    // A saved letter is always a draft, and a change is to the letter of the employee named.
    const save = fn(text, 'public.hr_save_letter').body;
    expect(save).toContain('select l.* into letter from public.hr_letters l where l.id = p_letter and l.employee_id = emp.id for update;');
    expect(save).not.toContain("'issued'");
    expect(save).toContain("'draft'");
  });

  test('placeholders: one list, filled in a single pass from the employee and the workspace named', () => {
    const text = statements(LETTERS);
    // The rule is written as one pattern, in the fill and in the issue check, and nowhere differently.
    expect(text.split(PLACEHOLDER_RULE).length - 1).toBe(4);
    const fill = fn(text, 'private.hr_letter_fill').body;
    expect(fill).toContain(`regexp_split_to_array(p_text, ${PLACEHOLDER_RULE})`);
    expect(fill).toContain(`regexp_matches(p_text, ${PLACEHOLDER_RULE}, 'g') with ordinality`);
    // A value that is missing leaves its placeholder as it was.
    expect(fill).toContain("coalesce(p_values ->> names[i], '{' || names[i] || '}')");
    expect(fill).not.toMatch(/\breplace\(/);
    const start = fn(text, 'public.hr_start_letter_from_template').body;
    expect(start).toContain('select t.* into tpl from public.hr_letter_templates t where t.id = p_template and t.org_id = emp.org_id for share;');
    expect(start).toContain("if not found then raise exception 'LETTER_NOT_FOUND'; end if;");
    for (const value of [
      "'employee_name', nullif(trim(emp.name), '')",
      "'employee_no', nullif(trim(emp.employee_no), '')",
      "'designation', nullif(trim(emp.designation), '')",
      "'department', (select nullif(trim(d.name), '') from public.hr_departments d where d.id = emp.department_id and d.org_id = emp.org_id)",
      "'join_date', to_char(emp.join_date, 'FMDD FMMonth YYYY')",
      "'company_name', (select nullif(trim(o.name), '') from public.orgs o where o.id = emp.org_id)",
      "'today', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'FMDD FMMonth YYYY')",
    ]) {
      expect(start, value).toContain(value);
    }
    expect(start).toContain("jsonb_build_object('letter', private.hr_letter_json(letter), 'unfilled', to_jsonb(unfilled))");
    expect(start).not.toContain("'issued'");
  });

  test('templates: fifty a workspace, one name each, changed by owners and admins only', () => {
    const text = statements(LETTERS);
    const save = fn(text, 'public.hr_save_letter_template').body;
    expect(save).toContain('>= 50 then');
    expect(save.indexOf("raise exception 'LETTER_TOO_MANY_TEMPLATES'")).toBeLessThan(firstWrite(save));
    expect(save.match(/exception when unique_violation then\n\s+raise exception 'LETTER_TEMPLATE_EXISTS';/g)).toHaveLength(1);
    expect(save).toContain("jsonb_build_object('id', tpl.id, 'name', tpl.name, 'letter_type', tpl.letter_type, 'title', tpl.title, 'body', tpl.body)");
    expect(fn(text, 'public.hr_delete_letter_template').body).toContain('delete from public.hr_letter_templates t where t.id = tpl.id;');
  });

  test('what the functions hand back: a document without its path, a letter with its body', () => {
    const text = rules();
    expect(fn(text, 'private.hr_document_json').body).toContain(
      "'id', p_doc.id, 'employee_id', p_doc.employee_id, 'title', p_doc.title, 'doc_type', p_doc.doc_type,\n"
        + "    'expires_on', p_doc.expires_on, 'file_name', p_doc.file_name, 'file_size', p_doc.file_size,\n"
        + "    'file_type', p_doc.file_type, 'source', p_doc.source, 'ack_requested', p_doc.ack_requested,\n"
        + "    'acknowledged_at', p_doc.acknowledged_at, 'created_at', p_doc.created_at);",
    );
    expect(fn(text, 'private.hr_document_json').body).not.toContain('file_path');
    expect(fn(text, 'private.hr_letter_json').body).toContain(
      "'id', p_letter.id, 'employee_id', p_letter.employee_id, 'letter_type', p_letter.letter_type,\n"
        + "    'title', p_letter.title, 'body', p_letter.body, 'status', p_letter.status, 'issued_on', p_letter.issued_on,\n"
        + "    'ack_requested', p_letter.ack_requested, 'acknowledged_at', p_letter.acknowledged_at);",
    );
    // A path leaves the database only from a replace, a remove, and an employee's deletion.
    expect(fn(text, 'public.hr_replace_document_file').body).toContain("jsonb_build_object('document', private.hr_document_json(doc), 'old_path', old_path)");
    expect(fn(text, 'public.hr_remove_document').body).toContain("jsonb_build_object('id', doc.id, 'employee_id', doc.employee_id, 'path', doc.file_path)");
    expect(fn(text, 'public.hr_delete_employee').body).toContain("jsonb_build_object('id', emp.id, 'name', emp.name, 'document_paths', to_jsonb(paths))");
    const returns = (name: string) => (fn(text, `public.${name}`).body.match(/^\s*return [^;]*;/gm) ?? []).join('\n');
    const pathReturned = FUNCTIONS.filter((f) => /path/.test(returns(f.name)));
    expect(pathReturned.map((f) => f.name)).toEqual(['hr_replace_document_file', 'hr_remove_document', 'hr_delete_employee']);
  });

  test('deleting an employee hands back their files, and the paid-payslip refusal still stands', () => {
    const text = statements(DOCUMENTS);
    const { body } = fn(text, 'public.hr_delete_employee');
    const held = body.indexOf('select e.* into emp from public.hr_employees e where e.id = p_employee and e.org_id = p_org for update;');
    // The employee's documents are held too, so no file is replaced between the paths being read and the row going.
    const docsHeld = body.indexOf('perform 1 from public.hr_documents d where d.employee_id = emp.id for update;');
    const collected = body.indexOf('from public.hr_documents d where d.employee_id = emp.id and d.file_path is not null;');
    const deleted = body.indexOf('delete from public.hr_employees e where e.id = emp.id;');
    expect(held).toBeGreaterThan(-1);
    expect(docsHeld).toBeGreaterThan(held);
    expect(collected).toBeGreaterThan(docsHeld);
    expect(deleted).toBeGreaterThan(collected);
    expect(body).toContain('private.is_org_admin(emp.org_id)');
    // The guard of the payroll slice is a trigger on the table: it is not touched, replaced or switched off here.
    expect(rules()).not.toMatch(/hr_employee_delete_guard|hr_employees_paid_payslips_guard|disable trigger|session_replication_role/);
    expect(raised(body)).toEqual([]);
  });

  test('today is today in Malaysia, and nothing reads another clock', () => {
    const text = rules();
    expect(text.match(/now\(\) at time zone '[^']*'/g)?.every((m) => m.includes('Asia/Kuala_Lumpur'))).toBe(true);
    expect(text).not.toMatch(/current_date|current_timestamp|clock_timestamp|localtime/i);
  });

  test('the helpers are private, on a fixed search path, and closed to the API roles', () => {
    for (const file of [DOCUMENTS, LETTERS]) {
      const text = statements(file);
      for (const helper of HELPERS[file]) {
        const { header } = fn(text, helper);
        expect(header, helper).toContain('set search_path = public');
        expect(text, helper).toMatch(
          new RegExp(`revoke all on function ${helper.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`),
        );
      }
    }
  });

  test('a refusal is one of the nineteen codes and carries nothing else', () => {
    const text = rules();
    const inFunctions = [...text.matchAll(/ as \$\$[\s\S]*?\$\$;/g)].map((m) => m[0]).join('\n');
    const messages = raised(inFunctions);
    expect(messages.length).toBeGreaterThan(40);
    // Every raise in a function is a `raise exception '<CODE>'`: no notice, no format arguments, no `using`.
    expect(inFunctions.match(/\braise /g)).toHaveLength(messages.length);
    for (const message of messages) expect(message).toMatch(/^'[A-Z_]+'$/);
    expect(codes(inFunctions)).toEqual([...DOC_CODES, ...LETTER_CODES].sort());
    // Documents answer in their own codes, letters and templates in theirs.
    expect(codes([...statements(DOCUMENTS).matchAll(/ as \$\$[\s\S]*?\$\$;/g)].map((m) => m[0]).join('\n'))).toEqual([...DOC_CODES].sort());
    expect(codes([...statements(LETTERS).matchAll(/ as \$\$[\s\S]*?\$\$;/g)].map((m) => m[0]).join('\n'))).toEqual([...LETTER_CODES].sort());
    // Outside the functions, the only raise is the migration stopping itself when the old check is not there.
    expect(raised(text.replace(/ as \$\$[\s\S]*?\$\$;/g, ''))).toEqual(["'the doc_type check on hr_documents was not found'"]);
  });

  test('the third file is the demo re-seed and nothing else, and does not run it', () => {
    const text = statements(SEED);
    expect(allFunctions(text)).toEqual(['private.reseed_demo_people']);
    expect(fn(text, 'private.reseed_demo_people').header).toContain('returns void language plpgsql security definer set search_path = public');
    expect(text).toContain('revoke all on function private.reseed_demo_people() from public, anon, authenticated;');
    expect(raw(SEED)).not.toMatch(/(select|perform)\s+private\.reseed_demo_people/);
    // Outside the function there is nothing but that revoke.
    const outside = text.slice(0, text.indexOf('create or replace function')) + text.slice(text.indexOf('$$;') + 3);
    expect(outside.trim()).toBe('revoke all on function private.reseed_demo_people() from public, anon, authenticated;');
    expect(raised(text)).toEqual(["'demo org missing'"]);
  });

  test('only the documents, the letters and the templates of the demo re-seed differ from the performance slice\'s', () => {
    const parts = (file: string) => fn(raw(file), 'private.reseed_demo_people').body.split('\n\n');
    // The re-seed this one replaces: the newest earlier migration that defines it, whatever its version.
    const earlier = readdirSync(DIR).sort().filter((f) => f < SEED && /create or replace function private\.reseed_demo_people\(/.test(raw(f)));
    const before = parts(earlier[earlier.length - 1]);
    const after = parts(SEED);
    expect(before.length).toBeGreaterThan(30);
    // One part more: the templates. Every other part is where it was.
    expect(after).toHaveLength(before.length + 1);
    const same = (i: number) => after[i] === before[i];
    const changed = before.map((_, i) => (same(i) ? null : i)).filter((i): i is number => i !== null);
    // The clearing-out at the top (one more line), the two document inserts, and the letters.
    expect(changed).toHaveLength(4);
    const [clear, contracts, others, letters] = changed.map((i) => after[i]);
    expect(clear.split('\n').filter((l) => !before[changed[0]].includes(l))).toEqual(['  delete from public.hr_letter_templates where org_id = demo;']);
    expect(before[changed[0]].split('\n').every((l) => clear.includes(l))).toBe(true);
    for (const part of [contracts, others]) {
      expect(part.match(/insert into public\.(\w+) \(/g)).toEqual(['insert into public.hr_documents (']);
      // No file, no placeholder payslip or letter, and no status but the one new rows have.
      expect(part).not.toMatch(/file_path|file_name|payslip|'letter'|'signed'|pending_signature|'expiring'/);
      expect(part).not.toMatch(/\b(delete|update|perform)\b/);
    }
    expect(others).toMatch(/ack_requested/);
    // Every demo document is of a type the app deployed before this slice can label.
    const types = [...`${contracts}\n${others}`.matchAll(/'(contract|tax|benefits|identity|medical|certificate|other)'/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(3);
    expect(types.every((t) => ['contract', 'tax', 'benefits'].includes(t))).toBe(true);
    expect(letters.match(/insert into public\.(\w+) \(/g)).toEqual(['insert into public.hr_letters (']);
    expect(letters).toContain('body');
    const letterRows = [...letters.matchAll(/^\s+\((\d+), '([a-z_]+)', '[^']+', '(issued|draft)', /gm)];
    expect(letterRows).toHaveLength(5);
    expect(letterRows.map((m) => m[2]).sort()).toEqual(['confirmation', 'contract_renewal', 'offer', 'promotion', 'warning']);
    expect(letterRows.filter((m) => m[3] === 'draft')).toHaveLength(2);
    expect(letters).not.toMatch(new RegExp(PLACEHOLDER_RULE.slice(1, -1)));
    // The templates: the starter set, made by the one function that makes it for every workspace.
    expect(after[after.length - 1].split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'))).toEqual([
      'perform private.hr_seed_letter_templates(demo);',
      'end;',
    ]);
    expect(after.slice(0, -1).filter((p, i) => i > changed[3] && p !== before[i])).toEqual([]);
  });
});
