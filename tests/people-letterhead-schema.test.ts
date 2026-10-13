import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const LOGO = '20261109133700_org_logo.sql';
const LETTERS = '20261109133800_people_letter_salary_templates.sql';
/** The file after them: it replaces some of their functions (see its own test file). */
const HARDENING = '20261109140000_people_letterhead_hardening.sql';
/** The letters slice: the functions the second file redefines come from here. */
const BEFORE = '20261102090100_people_letters_writes.sql';

const files = readdirSync(DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<workspace>/<uuid>.<ext>`, as the database spells it. */
const PATH_RULE = `'^${UUID}/${UUID}\\.(png|jpg|webp)$'`;
const SEVEN = "'\\{(employee_name|employee_no|designation|department|join_date|company_name|today)\\}'";
const EIGHT = "'\\{(employee_name|employee_no|designation|department|join_date|company_name|today|salary)\\}'";
const NAMES = ['employee_name', 'employee_no', 'designation', 'department', 'join_date', 'company_name', 'today', 'salary'];
const TYPES = ['offer', 'confirmation', 'promotion', 'warning', 'contract_renewal', 'other'];
const ENGLISH = ['Offer of employment', 'Confirmation of employment', 'Promotion', 'Warning', 'Contract renewal', 'General letter'];
const MALAY = [
  'Surat Tawaran Pekerjaan', 'Surat Pengesahan Jawatan', 'Surat Kenaikan Pangkat', 'Surat Amaran',
  'Surat Pembaharuan Kontrak', 'Surat Pengesahan Majikan',
];

/** One function's text: `header` up to `as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}
const allFunctions = (text: string) =>
  [...text.matchAll(/create or replace function ((?:public|private)\.\w+)\(/g)].map((m) => m[1]);
/** The bare messages of every `raise exception` in a piece of text. */
const raised = (text: string) => [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
const codes = (text: string) => [...new Set(raised(text).map((m) => m.slice(1, -1)))].sort();
/** The placeholders a text uses, in the order of the list. */
const used = (text: string) => NAMES.filter((name) => text.includes(`{${name}}`));

type Starter = { lang: string; name: string; type: string; title: string; body: string };
/** The rows of a `values` list of starter templates: `(1, 'en', 'Name', 'type', 'Title',\n E'body')`, the first two columns optional. */
function starters(text: string): Starter[] {
  const row = /\((?:\d+, '(en|ms)', )?'((?:[^']|'')+)', '(\w+)', '((?:[^']|'')+)',\s+E'((?:[^']|'')*)'\)/g;
  return [...text.matchAll(row)].map((m) => ({
    lang: m[1] ?? 'en',
    name: m[2].replaceAll("''", "'"),
    type: m[3],
    title: m[4].replaceAll("''", "'"),
    body: m[5].replaceAll("''", "'").replaceAll('\\n', '\n'),
  }));
}

describe('Lekiu letterhead migrations: the two files', () => {
  test('exist, one after the other, after everything on main, each alone on its version', () => {
    const at = [LOGO, LETTERS].map((file) => files.indexOf(file));
    expect(at[0]).toBeGreaterThan(files.indexOf('20261104090000_kasturi_landing_pages.sql'));
    expect(at[1]).toBe(at[0] + 1);
    for (const file of [LOGO, LETTERS]) {
      expect(files.filter((other) => other.slice(0, 14) === file.slice(0, 14)), file).toEqual([file]);
    }
    // Later, only the hardening file defines any of their functions again: the logo is then set by the server alone, and a
    // template has a language (tests/people-letterhead-hardening-schema.test.ts pins each against its text here).
    const later = files.slice(at[1] + 1).filter((file) => file !== HARDENING).map((file) => statements(file)).join('\n');
    const again = allFunctions(statements(HARDENING));
    const here = [...allFunctions(statements(LOGO)), ...allFunctions(statements(LETTERS))];
    for (const name of here) expect(later, name).not.toContain(`function ${name}(`);
    expect(here.filter((name) => again.includes(name))).toEqual([
      'public.set_org_logo', 'private.hr_starter_letter_templates', 'private.hr_seed_letter_templates',
      'private.hr_backfill_ms_letter_templates', 'public.hr_start_letter_from_template',
    ]);
  });

  test('add and never take away: no table, no drop but a policy of their own, no write grant, nothing for anon', () => {
    for (const file of [LOGO, LETTERS]) {
      const text = statements(file);
      expect(text, file).not.toMatch(/create table|drop (table|column|function|index|constraint|trigger)|alter column|truncate/i);
      expect(text, file).not.toMatch(/grant (?!execute on function)/);
      expect(text, file).not.toMatch(/grant[^;]*\bto (public|anon|service_role)\b/);
      // No pattern here can fail to compile (a repetition bound above 255).
      const bounds = [...text.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].filter(([, low, high]) => Number(low) > 255 || Number(high ?? 0) > 255);
      expect(bounds, file).toEqual([]);
    }
    // Outside a function the first file changes no row; the second only calls its backfill.
    const outside = (file: string) => statements(file).replace(/ as \$\$[\s\S]*?\$\$;/g, '');
    expect(outside(LOGO)).not.toMatch(/\b(update public|delete from)\b/);
    expect(outside(LOGO).match(/insert into/g)).toHaveLength(1);
    expect(outside(LETTERS)).not.toMatch(/\b(insert into|update|delete from)\b/);
    // The demo re-seed is left as it is.
    expect(statements(LOGO) + statements(LETTERS)).not.toContain('reseed_demo_people');
  });
});

describe('the workspace logo', () => {
  const text = statements(LOGO);

  test('one nullable column, in no update grant of any migration', () => {
    expect(text).toContain('alter table public.orgs add column if not exists logo_path text;');
    expect(text.match(/alter table/g)).toHaveLength(1);
    for (const file of files) {
      const grants = flat(statements(file)).match(/grant [^;]*update[^;]*on public\.orgs to[^;]*;/g) ?? [];
      for (const grant of grants) expect(grant, file).not.toContain('logo_path');
    }
    // The column list signed-in users may update is the one main states, to the letter.
    const newest = files
      .map((file) => flat(statements(file)).match(/grant update \(([^)]*)\) on public\.orgs to authenticated;/g) ?? [])
      .flat()
      .at(-1);
    expect(newest).toBe(
      'grant update (name, registration_no, sst_no, website, industry, company_size, address, city, state, postcode) on public.orgs to authenticated;',
    );
  });

  test('a public bucket of 1 MB for three image types, stated again on a second run', () => {
    expect(flat(text)).toContain(
      "insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('org-logos', 'org-logos', true, 1048576, array['image/png','image/jpeg','image/webp']) "
        + "on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/png','image/jpeg','image/webp'];",
    );
    expect(text).not.toContain('svg');
  });

  test('upload: one shape, an owner or admin of the workspace in the path, not the demo, not anonymous, not onto a logo', () => {
    expect(text).toContain('drop policy if exists org_logos_insert on storage.objects;');
    expect(flat(text)).toContain(
      'create policy org_logos_insert on storage.objects for insert to authenticated with check ( '
        + `case when bucket_id = 'org-logos' and name ~ ${PATH_RULE} `
        + 'then private.is_org_admin(((storage.foldername(name))[1])::uuid) '
        + 'and not private.is_demo_org(((storage.foldername(name))[1])::uuid) '
        + "and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false "
        + 'and not exists (select 1 from public.orgs o where o.logo_path = storage.objects.name) '
        + 'else false end );',
    );
    // Every cast of a folder sits after the `case`.
    const policy = text.slice(text.indexOf('create policy org_logos_insert'));
    expect(policy.indexOf('::uuid')).toBeGreaterThan(policy.indexOf('case when bucket_id'));
  });

  test('a session that owes a second factor gets nothing; no read, update or delete policy at all', () => {
    expect(text).toContain('drop policy if exists org_logos_mfa_required on storage.objects;');
    expect(flat(text)).toContain(
      'create policy org_logos_mfa_required on storage.objects as restrictive for all to authenticated '
        + "using (bucket_id <> 'org-logos' or (select private.mfa_ok())) "
        + "with check (bucket_id <> 'org-logos' or (select private.mfa_ok()));",
    );
    expect([...text.matchAll(/create policy (\w+)/g)].map((m) => m[1])).toEqual(['org_logos_insert', 'org_logos_mfa_required']);
    expect(flat(text)).not.toMatch(/on storage\.objects (as restrictive )?for (select|update|delete)\b/);
    // No other migration gives this bucket a policy: only the hardening file names it at all, and it writes no policy.
    for (const file of files.filter((other) => other !== LOGO && other !== HARDENING)) expect(statements(file), file).not.toContain('org-logos');
    expect(statements(HARDENING)).not.toMatch(/(create|drop|alter) policy|storage\.buckets/);
  });

  test('two functions, run as the owner on a fixed search path, for signed-in users only', () => {
    expect(allFunctions(text)).toEqual(['public.set_org_logo', 'public.clear_org_logo']);
    for (const [name, args] of [['set_org_logo', 'uuid, text'], ['clear_org_logo', 'uuid']]) {
      const { header } = fn(text, `public.${name}`);
      expect(header, name).toContain('returns jsonb language plpgsql security definer set search_path = public');
      expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
      expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
    }
    expect(fn(text, 'public.set_org_logo').header).toContain('public.set_org_logo(p_org uuid, p_path text)');
    expect(fn(text, 'public.clear_org_logo').header).toContain('public.clear_org_logo(p_org uuid)');
    expect(text.match(/grant execute/g)).toHaveLength(2);
  });

  test('both refuse everyone but an owner or admin, and the demo, with one bare code, before they read anything', () => {
    const gate = "if uid is null or p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then\n    raise exception 'LOGO_NOT_ALLOWED';\n  end if;";
    for (const name of ['set_org_logo', 'clear_org_logo']) {
      const { body } = fn(text, `public.${name}`);
      expect(body, name).toContain(gate);
      // The gate is the first statement; the row is then held before the old path is read or anything is written.
      expect(body.indexOf(gate), name).toBeLessThan(body.indexOf('select '));
      const held = body.indexOf('select o.logo_path, o.name into old_path, called from public.orgs o where o.id = p_org for no key update;');
      expect(held, name).toBeGreaterThan(body.indexOf(gate));
      expect(body.slice(held), name).toContain("if not found then raise exception 'LOGO_NOT_ALLOWED'; end if;");
      for (const write of ['update public.orgs', 'insert into public.activity_log']) {
        expect(body.indexOf(write), `${name}: ${write}`).toBeGreaterThan(held);
      }
      expect(body.match(/update public\.orgs/g), name).toHaveLength(1);
    }
    expect(codes(text)).toEqual(['LOGO_BAD_FILE', 'LOGO_NOT_ALLOWED']);
    // A refusal carries its code and nothing else.
    for (const message of raised(text)) expect(message).toMatch(/^'LOGO_[A-Z_]+'$/);
    expect(codes(fn(text, 'public.clear_org_logo').body)).toEqual(['LOGO_NOT_ALLOWED']);
  });

  test('set: the shape, the folder, an uploaded object and its recorded type, then the old path handed back', () => {
    const { body } = fn(text, 'public.set_org_logo');
    expect(body).toContain(
      `if p_path is null\n     or p_path !~ ${PATH_RULE}\n     or split_part(p_path, '/', 1) <> p_org::text then\n    raise exception 'LOGO_BAD_FILE';\n  end if;`,
    );
    expect(flat(body)).toContain("select ob.metadata into meta from storage.objects ob where ob.bucket_id = 'org-logos' and ob.name = p_path; if not found then raise exception 'LOGO_BAD_FILE'; end if;");
    expect(flat(body)).toContain(
      "if meta ? 'mimetype' and meta ->> 'mimetype' <> (case split_part(p_path, '.', 2) when 'png' then 'image/png' when 'jpg' then 'image/jpeg' else 'image/webp' end) then raise exception 'LOGO_BAD_FILE'; end if;",
    );
    expect(body).toContain('update public.orgs o set logo_path = p_path where o.id = p_org;');
    expect(body).toContain("return jsonb_build_object('logo_path', p_path, 'old_path', old_path);");
    // The path is checked before the file is looked for, and the file before anything is written.
    const order = ["p_path !~", 'from storage.objects ob', "meta ? 'mimetype'", 'update public.orgs'].map((s) => body.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
    // Setting the logo it already is hands back no path to remove: that file is the logo.
    expect(body).toContain('if old_path is not distinct from p_path then');
    expect(body).toContain("return jsonb_build_object('logo_path', p_path, 'old_path', null);");
  });

  test('clear: the column emptied and the old path handed back', () => {
    const { body } = fn(text, 'public.clear_org_logo');
    expect(body).toContain('update public.orgs o set logo_path = null where o.id = p_org;');
    expect(body).toContain("return jsonb_build_object('old_path', old_path);");
    expect(body).not.toContain('storage.');
  });

  test('each records one activity entry of the kind the company details save records', () => {
    for (const [name, action] of [['set_org_logo', 'Updated the workspace logo'], ['clear_org_logo', 'Removed the workspace logo']]) {
      const { body } = fn(text, `public.${name}`);
      expect(flat(body), name).toContain(
        'insert into public.activity_log (org_id, actor_id, actor_name, action, target, category, audience) '
          + `values (p_org, uid, private.display_name(uid), '${action}', left(called, 200), 'data', 'members');`,
      );
      expect(body.match(/insert into public\.activity_log/g), name).toHaveLength(1);
    }
    // Neither is a path, a file name or anything typed.
    expect(text).not.toMatch(/activity_log[^;]*p_path/);
  });
});

describe('letters: the salary placeholder', () => {
  const text = statements(LETTERS);
  const before = statements(BEFORE);

  test('the list of eight is the only list, in the fill, the start and the issue check', () => {
    expect(text).not.toContain(SEVEN);
    expect(fn(text, 'private.hr_letter_fill').body.split(EIGHT)).toHaveLength(3);
    expect(fn(text, 'public.hr_issue_letter').body.split(EIGHT)).toHaveLength(3);
    expect(text.split(EIGHT)).toHaveLength(5);
    expect(fn(text, 'public.hr_start_letter_from_template').body).toContain(
      `from unnest(array[${NAMES.map((name) => `'${name}'`).join(',')}]) with ordinality as n(name, at)`,
    );
    // No other spelling of the list anywhere in the file.
    expect(text.match(/employee_name\|employee_no/g)).toHaveLength(4);
    expect(text.match(/'employee_name','employee_no'/g)).toHaveLength(1);
  });

  test('the fill and the issue check are the functions as they were, with the eighth name', () => {
    for (const name of ['private.hr_letter_fill', 'public.hr_issue_letter']) {
      const now = fn(text, name);
      const was = fn(before, name);
      expect(now.header, name).toBe(was.header);
      expect(now.body.replaceAll(EIGHT, SEVEN), name).toBe(was.body);
    }
    expect(text).toContain('revoke all on function private.hr_letter_fill(text, jsonb) from public, anon, authenticated;');
    expect(text).toContain('revoke all on function public.hr_issue_letter(uuid) from public, anon;');
    expect(text).toContain('grant execute on function public.hr_issue_letter(uuid) to authenticated;');
  });

  const SALARY =
    ",\n    'salary', (select 'RM ' || to_char(p.base_salary_cents * 0.01, 'FM999,999,999,999,999,990.00') || ' per month'\n"
    + '               from public.hr_employee_private p\n'
    + '               where p.employee_id = emp.id and p.org_id = emp.org_id and p.base_salary_cents > 0)';

  test('starting a letter is the function as it was, with the salary read from the same workspace', () => {
    const now = fn(text, 'public.hr_start_letter_from_template');
    const was = fn(before, 'public.hr_start_letter_from_template');
    expect(now.header).toBe(was.header);
    expect(now.body.split(SALARY)).toHaveLength(2);
    expect(now.body.replace(SALARY, '').replace(",'today','salary']", ",'today']")).toBe(was.body);
    // A missing or zero salary gives no value: nulls are stripped, so the placeholder stays and is reported.
    expect(now.body).toContain('vals := jsonb_strip_nulls(jsonb_build_object(');
    expect(text).toContain('revoke all on function public.hr_start_letter_from_template(uuid, uuid) from public, anon;');
    expect(text).toContain('grant execute on function public.hr_start_letter_from_template(uuid, uuid) to authenticated;');
  });

  test('the amount is written with thousands separators and two decimals, room for any amount the column holds', () => {
    // Times 0.01, never a division: dividing a numeric rounds the last digits of a very large amount.
    const mask = /to_char\(p\.base_salary_cents \* 0\.01, '(FM[0-9,.]+)'\)/.exec(fn(text, 'public.hr_start_letter_from_template').body)?.[1] ?? '';
    // The largest bigint is 92,233,720,368,547,758.07 ringgit: seventeen digits before the point.
    expect(mask.split('.')[0].replace(/[^09]/g, '').length).toBeGreaterThanOrEqual(17);
    expect(mask.endsWith('990.00')).toBe(true);
  });
});

describe('letters: the starter templates', () => {
  const text = statements(LETTERS);
  const list = fn(text, 'private.hr_starter_letter_templates');
  const rows = starters(list.body);

  test('twelve: the six English ones as they were, then six in Bahasa Malaysia, one per letter type', () => {
    expect(rows).toHaveLength(12);
    expect(rows.map((row) => row.lang)).toEqual([...Array(6).fill('en'), ...Array(6).fill('ms')]);
    expect(rows.slice(0, 6).map((row) => row.name)).toEqual(ENGLISH);
    expect(rows.slice(6).map((row) => row.name)).toEqual(MALAY);
    expect(rows.slice(0, 6).map((row) => row.type)).toEqual(TYPES);
    expect(rows.slice(6).map((row) => row.type)).toEqual(TYPES);
    // Not one character of an English template is changed.
    const was = starters(fn(statements(BEFORE), 'private.hr_seed_letter_templates').body);
    expect(was).toHaveLength(6);
    expect(rows.slice(0, 6).map(({ name, type, title, body }) => ({ name, type, title, body }))).toEqual(
      was.map(({ name, type, title, body }) => ({ name, type, title, body })),
    );
    expect(list.header).toContain('returns table (nth int, lang text, name text, letter_type text, title text, body text)');
    expect(text).toContain('revoke all on function private.hr_starter_letter_templates() from public, anon, authenticated;');
  });

  test('each Bahasa Malaysia template uses the placeholders of its English twin; offer and confirmation add the salary', () => {
    for (let i = 0; i < 6; i += 1) {
      const english = rows[i];
      const malay = rows[i + 6];
      const extra = ['offer', 'confirmation'].includes(malay.type) ? ['salary'] : [];
      expect(used(malay.body), malay.name).toEqual([...used(english.body), ...extra]);
      expect(used(english.body), english.name).not.toContain('salary');
      // Nothing in braces that is no placeholder, and no placeholder in a title.
      expect((malay.body.match(/\{[^}]*\}/g) ?? []).every((found) => NAMES.includes(found.slice(1, -1))), malay.name).toBe(true);
      expect(malay.title).not.toMatch(/[{}]/);
      expect(malay.body.split('\n')[0]).toBe('{today}');
      expect(malay.body.endsWith('\n{company_name}')).toBe(true);
    }
  });

  test('every template fits the table: a name used once whatever its capitals, and the lengths', () => {
    expect(new Set(rows.map((row) => row.name.toLowerCase())).size).toBe(12);
    for (const row of rows) {
      expect(row.name.trim().length, row.name).toBeGreaterThan(0);
      expect(row.name.length, row.name).toBeLessThanOrEqual(120);
      expect(row.title.trim().length, row.name).toBeGreaterThan(0);
      expect(row.title.length, row.name).toBeLessThanOrEqual(200);
      expect(row.body.length, row.name).toBeGreaterThan(200);
      expect(row.body.length, row.name).toBeLessThanOrEqual(10000);
    }
  });

  test('the wording is Malaysian business usage', () => {
    const malay = rows.slice(6).map((row) => `${row.title}\n${row.body}`).join('\n');
    for (const word of ['Tuan/Puan', 'Dengan sukacitanya', 'jawatan', 'Gaji', 'syarikat', 'Yang benar,']) expect(malay, word).toContain(word);
    expect(malay).not.toMatch(/\b(anda|kantor|karyawan|perusahaan|silakan|dipersilakan|hormat kami|kami senang)\b/i);
  });

  test('the seed gives all twelve to a workspace with no template, and to none other', () => {
    const { header, body } = fn(text, 'private.hr_seed_letter_templates');
    expect(header).toContain('private.hr_seed_letter_templates(p_org uuid)\nreturns void language sql security definer set search_path = public');
    expect(flat(body)).toContain(
      'insert into public.hr_letter_templates (org_id, name, letter_type, title, body) '
        + 'select p_org, v.name, v.letter_type, v.title, v.body from private.hr_starter_letter_templates() v '
        + 'where not exists (select 1 from public.hr_letter_templates t where t.org_id = p_org) order by v.nth;',
    );
    expect(body).not.toContain('lang');
    expect(text).toContain('revoke all on function private.hr_seed_letter_templates(uuid) from public, anon, authenticated;');
    // The trigger that seeds a new workspace is the one main has: not made again here.
    expect(text).not.toMatch(/create trigger|hr_seed_letter_templates_new_org/);
  });

  test('the backfill: only a workspace that has a template, only a name not used there, never past 50', () => {
    const { header, body } = fn(text, 'private.hr_backfill_ms_letter_templates');
    expect(header).toContain('private.hr_backfill_ms_letter_templates(p_org uuid default null)\nreturns int language plpgsql security definer set search_path = public');
    for (const guard of [
      // 1. a workspace is visited only if it has a template, and is counted again once it is held
      'select distinct t.org_id from public.hr_letter_templates t where p_org is null or t.org_id = p_org',
      'where held > 0 and held + m.place <= 50\n    on conflict (org_id, lower(name)) do nothing;',
      // 2. the name is not already used there, whatever its capitals
      "where v.lang = 'ms'\n            and not exists (select 1 from public.hr_letter_templates t where t.org_id = o and lower(t.name) = lower(v.name))",
      // 3. the ones still missing are numbered, so the count stops at 50
      'select v.*, row_number() over (order by v.nth) as place',
    ]) {
      expect(body, guard).toContain(guard);
    }
    // Templates are added to a workspace one caller at a time: the lock hr_save_letter_template takes.
    const lock = "perform pg_advisory_xact_lock(hashtextextended('hr_letter_templates:' || o, 0));";
    expect(body).toContain(lock);
    expect(statements(BEFORE)).toContain("perform pg_advisory_xact_lock(hashtextextended('hr_letter_templates:' || tpl.org_id, 0));");
    expect(body.indexOf(lock)).toBeLessThan(body.indexOf('select count(*) into held'));
    expect(body.indexOf('select count(*) into held')).toBeLessThan(body.indexOf('insert into public.hr_letter_templates'));
    expect(text).toContain('revoke all on function private.hr_backfill_ms_letter_templates(uuid) from public, anon, authenticated;');
    // Run once, for every workspace, after the list it reads exists.
    expect(text.match(/select private\.hr_backfill_ms_letter_templates\(\);/g)).toHaveLength(1);
    expect(text.indexOf('select private.hr_backfill_ms_letter_templates();')).toBeGreaterThan(text.indexOf('create or replace function private.hr_backfill_ms_letter_templates('));
  });
});

describe('letters: asking for an acknowledgement, and the released list', () => {
  const text = statements(LETTERS);

  test('hr_request_letter_ack: owners and admins, a draft only, through the gate the other letter functions pass', () => {
    const { header, body } = fn(text, 'public.hr_request_letter_ack');
    expect(header).toContain('public.hr_request_letter_ack(p_letter uuid, p_requested boolean)\nreturns jsonb language plpgsql security definer set search_path = public');
    const steps = [
      'letter := private.hr_letter_held(p_letter);',
      "if not private.is_org_admin(letter.org_id) then raise exception 'LETTER_NOT_FOUND'; end if;",
      "if p_requested is null then raise exception 'LETTER_BAD_INPUT'; end if;",
      "if letter.status <> 'draft' then raise exception 'LETTER_NOT_DRAFT'; end if;",
      'update public.hr_letters l set ack_requested = p_requested where l.id = letter.id returning l.* into letter;',
      'return private.hr_letter_json(letter);',
    ].map((step) => body.indexOf(step));
    expect(steps.every((at) => at > -1)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    // The gate holds the row `for update`, refuses the demo and a call with no user.
    const gate = fn(statements(BEFORE), 'private.hr_letter_held').body;
    expect(gate).toContain('where l.id = p_letter for update;');
    expect(gate).toContain("if private.is_demo_org(letter.org_id) then raise exception 'LETTER_NOT_ALLOWED'; end if;");
    expect(text).toContain('revoke all on function public.hr_request_letter_ack(uuid, boolean) from public, anon;');
    expect(text).toContain('grant execute on function public.hr_request_letter_ack(uuid, boolean) to authenticated;');
    for (const message of raised(text)) expect(message).toMatch(/^'LETTER_[A-Z_]+'$/);
  });

  test('the functions of the file, and who may call them', () => {
    expect(allFunctions(text)).toEqual([
      'private.hr_starter_letter_templates', 'private.hr_seed_letter_templates', 'private.hr_backfill_ms_letter_templates',
      'private.hr_letter_fill', 'public.hr_start_letter_from_template', 'public.hr_issue_letter', 'public.hr_request_letter_ack',
      'private.hr_prune_released_documents',
    ]);
    expect([...text.matchAll(/grant execute on function (\S+)\(/g)].map((m) => m[1])).toEqual([
      'public.hr_start_letter_from_template', 'public.hr_issue_letter', 'public.hr_request_letter_ack',
    ]);
    for (const name of allFunctions(text).filter((qualified) => qualified.startsWith('private.'))) {
      expect(text, name).toMatch(new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated(, service_role)?;`));
    }
  });

  test('pruning: a path released over 30 days ago with no file behind it, and no other', () => {
    const { header, body } = fn(text, 'private.hr_prune_released_documents');
    expect(header).toContain('private.hr_prune_released_documents()\nreturns int language plpgsql security definer set search_path = public');
    expect(flat(body)).toContain(
      "delete from private.hr_released_documents r where r.released_at < now() - interval '30 days' "
        + "and not exists (select 1 from storage.objects o where o.bucket_id = 'hr-documents' and o.name = r.path);",
    );
    expect(body).toContain('get diagnostics gone = row_count;');
    expect(body.match(/delete from/g)).toHaveLength(1);
    expect(text).toContain('revoke all on function private.hr_prune_released_documents() from public, anon, authenticated, service_role;');
  });

  test('a daily job runs it, declared so the file also applies where pg_cron is not installed, and again on a second run', () => {
    const job = text.slice(text.indexOf('do $job$'), text.indexOf('end $job$;'));
    expect(job).toContain("if exists (select 1 from pg_available_extensions where name = 'pg_cron') then");
    expect(job).toContain('create extension if not exists pg_cron;');
    // By name, so a second run replaces the job. 18:40 GMT is 02:40 in Malaysia, clear of the demo re-seed on the hour.
    expect(job).toContain("perform cron.schedule('prune-released-documents', '40 18 * * *', 'select private.hr_prune_released_documents()');");
    expect(text.match(/cron\.schedule/g)).toHaveLength(1);
    expect(text.indexOf('do $job$')).toBeGreaterThan(text.indexOf('create or replace function private.hr_prune_released_documents('));
  });
});
