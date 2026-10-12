import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const LOGO = '20261109133700_org_logo.sql';
const LETTERS = '20261109133800_people_letter_salary_templates.sql';
/** The letters slice: `hr_save_letter_template` comes from here. */
const BEFORE = '20261102090100_people_letters_writes.sql';
const HARD = '20261109140000_people_letterhead_hardening.sql';

const files = readdirSync(DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

/** A migration's statements, without its comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NAMES = ['employee_name', 'employee_no', 'designation', 'department', 'join_date', 'company_name', 'today', 'salary'];
const MALAY = [
  'Surat Tawaran Pekerjaan', 'Surat Pengesahan Jawatan', 'Surat Kenaikan Pangkat', 'Surat Amaran',
  'Surat Pembaharuan Kontrak', 'Surat Pengesahan Majikan',
];
const MONTHS = ['Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'];

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
const raised = (text: string) => [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
const used = (text: string) => NAMES.filter((name) => text.includes(`{${name}}`));
/** `old` must be in `text` exactly once; it is replaced by `next`. */
function swap(text: string, old: string, next: string): string {
  expect(text.split(old), old).toHaveLength(2);
  return text.replace(old, next);
}

type Starter = { nth: number; lang: string; name: string; type: string; title: string; body: string };
function starters(text: string): Starter[] {
  const row = /\((\d+), '(en|ms)', '((?:[^']|'')+)', '(\w+)', '((?:[^']|'')+)',\s+E'((?:[^']|'')*)'\)/g;
  return [...text.matchAll(row)].map((m) => ({
    nth: Number(m[1]),
    lang: m[2],
    name: m[3].replaceAll("''", "'"),
    type: m[4],
    title: m[5].replaceAll("''", "'"),
    body: m[6].replaceAll("''", "'").replaceAll('\\n', '\n'),
  }));
}

const text = statements(HARD);
const logo = statements(LOGO);
const letters = statements(LETTERS);
const before = statements(BEFORE);

describe('the hardening migration: the file', () => {
  test('is the last of the three, alone on its version, and the newest definition of everything it defines', () => {
    expect(files.indexOf(HARD)).toBeGreaterThan(files.indexOf(LETTERS));
    expect(files.filter((other) => other.slice(0, 14) === HARD.slice(0, 14))).toEqual([HARD]);
    const later = files.slice(files.indexOf(HARD) + 1).map((file) => statements(file)).join('\n');
    for (const name of allFunctions(text)) expect(later, name).not.toContain(`function ${name}(`);
    expect(later).not.toContain('org-logos');
  });

  test('its functions, in order', () => {
    expect(allFunctions(text)).toEqual([
      'public.set_org_logo', 'public.org_orphaned_logo_files', 'public.org_logo_file_is_orphaned',
      'private.hr_ms_letter_templates_as_seeded', 'private.hr_starter_letter_templates', 'private.hr_seed_letter_templates',
      'private.hr_backfill_ms_letter_templates', 'private.hr_mark_ms_letter_templates', 'private.hr_correct_ms_letter_templates',
      'private.hr_letter_date', 'public.hr_start_letter_from_template', 'public.hr_save_letter_template',
    ]);
  });

  test('who may call what: three for the service role alone, two for signed-in users, nothing for anon, no private helper for anyone', () => {
    expect([...text.matchAll(/grant execute on function (\S+)\(([^)]*)\) to ([^;]+);/g)].map((m) => `${m[1]}(${m[2]}) ${m[3]}`)).toEqual([
      'public.set_org_logo(uuid, uuid, text) service_role',
      'public.org_orphaned_logo_files() service_role',
      'public.org_logo_file_is_orphaned(text) service_role',
      'public.hr_start_letter_from_template(uuid, uuid) authenticated',
      'public.hr_save_letter_template(uuid, uuid, text, text, text, text, text) authenticated',
    ]);
    expect(text).not.toMatch(/grant (?!execute on function)/);
    for (const name of ['set_org_logo(uuid, uuid, text)', 'org_orphaned_logo_files()', 'org_logo_file_is_orphaned(text)']) {
      expect(text, name).toContain(`revoke all on function public.${name} from public, anon, authenticated;`);
    }
    for (const name of ['hr_start_letter_from_template(uuid, uuid)', 'hr_save_letter_template(uuid, uuid, text, text, text, text, text)']) {
      expect(text, name).toContain(`revoke all on function public.${name} from public, anon;`);
    }
    for (const name of allFunctions(text).filter((qualified) => qualified.startsWith('private.'))) {
      expect(text, name).toMatch(new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated(, service_role)?;`));
    }
    // Every public function runs as its owner on a fixed search path.
    for (const name of allFunctions(text).filter((qualified) => qualified.startsWith('public.'))) {
      expect(fn(text, name).header, name).toContain('security definer set search_path = public');
    }
  });

  test('it drops the two functions it replaces and nothing else, makes no table, and changes rows only through its two one-off calls', () => {
    expect([...text.matchAll(/^drop [^;]*;/gm)].map((m) => m[0])).toEqual([
      'drop function if exists public.set_org_logo(uuid, text);',
      'drop function if exists public.hr_save_letter_template(uuid, uuid, text, text, text, text);',
    ]);
    expect(text).not.toMatch(/create table|create policy|drop policy|create trigger|truncate|alter column|reseed_demo_people|cron\./i);
    const outside = text.replace(/ as \$\$[\s\S]*?\$\$;/g, '');
    expect(outside).not.toMatch(/\b(insert into|update|delete from)\b/);
    expect(outside.match(/^select [^;]*;/gm)).toEqual([
      'select private.hr_mark_ms_letter_templates();',
      'select private.hr_correct_ms_letter_templates();',
    ]);
    // The backfill of the earlier file is defined again but never run: it would give back a template a workspace deleted.
    expect(outside).not.toContain('hr_backfill_ms_letter_templates();');
    expect(text.match(/alter table/g)).toHaveLength(1);
    // No pattern here can fail to compile (a repetition bound above 255).
    const bounds = [...text.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].filter(([, low, high]) => Number(low) > 255 || Number(high ?? 0) > 255);
    expect(bounds).toEqual([]);
  });

  test('safe to apply twice: every statement says so itself', () => {
    const outside = text.replace(/ as \$\$[\s\S]*?\$\$;/g, ' as $$$$;');
    const heads = outside
      .split(';')
      .map((statement) => flat(statement).trim())
      .filter((statement) => statement !== '')
      .map((statement) => statement.split(' ').slice(0, 4).join(' '));
    for (const head of heads) {
      expect(head).toMatch(/^(drop function if exists|create or replace function|revoke all on function|grant execute on function|alter table public\.hr_letter_templates add|select private\.hr_(mark|correct)_ms_letter_templates\(\))/);
    }
    expect(flat(text)).toContain("alter table public.hr_letter_templates add column if not exists lang text not null default 'en' check (lang in ('en', 'ms'));");
  });
});

describe('the logo is set by the server only', () => {
  const now = fn(text, 'public.set_org_logo');
  const was = fn(logo, 'public.set_org_logo');

  test('three arguments, the second the acting user', () => {
    expect(now.header).toBe(
      'create or replace function public.set_org_logo(p_org uuid, p_actor uuid, p_path text)\nreturns jsonb language plpgsql security definer set search_path = public',
    );
    // Dropped before it is made again, so a database never holds both.
    expect(text.indexOf('drop function if exists public.set_org_logo(uuid, text);')).toBeLessThan(text.indexOf('create or replace function public.set_org_logo('));
    // clear_org_logo is left as the earlier file wrote it.
    expect(text).not.toContain('clear_org_logo');
  });

  test('it is the function as it was, but for who is asked, whose name is recorded and the age of the file', () => {
    let expected = was.body;
    expected = swap(expected, '  uid uuid := auth.uid();\n', '');
    expected = swap(expected, '  meta jsonb;\n', '  meta jsonb;\n  made timestamptz;\n');
    expected = swap(
      expected,
      "  if uid is null or p_org is null or private.is_demo_org(p_org) or not private.is_org_admin(p_org) then\n    raise exception 'LOGO_NOT_ALLOWED';\n  end if;\n",
      "  if coalesce((select auth.role()), '') <> 'service_role' then\n    raise exception 'LOGO_NOT_ALLOWED';\n  end if;\n"
        + '  if p_org is null or p_actor is null or private.is_demo_org(p_org) or not exists (\n'
        + '    select 1 from public.org_members m\n'
        + "     where m.org_id = p_org and m.user_id = p_actor and m.role in ('owner', 'admin')\n"
        + "  ) then\n    raise exception 'LOGO_NOT_ALLOWED';\n  end if;\n",
    );
    expected = swap(expected, '  select ob.metadata into meta from storage.objects ob\n', '  select ob.metadata, ob.created_at into meta, made from storage.objects ob\n');
    expected = swap(
      expected,
      "    return jsonb_build_object('logo_path', p_path, 'old_path', null);\n  end if;\n",
      "    return jsonb_build_object('logo_path', p_path, 'old_path', null);\n  end if;\n"
        + "  if made is null or made < now() - interval '1 hour' then\n    raise exception 'LOGO_BAD_FILE';\n  end if;\n",
    );
    expected = swap(
      expected,
      "values (p_org, uid, private.display_name(uid), 'Updated the workspace logo'",
      "values (p_org, p_actor, private.display_name(p_actor), 'Updated the workspace logo'",
    );
    expect(now.body).toBe(expected);
    expect(now.body).not.toMatch(/\buid\b|auth\.uid|is_org_admin/);
  });

  test('the caller is checked first, then the actor, both before anything is read', () => {
    const order = ["auth.role()), '') <> 'service_role'", 'from public.org_members m', 'from public.orgs o where o.id = p_org for no key update', 'from storage.objects ob', 'update public.orgs'].map((s) => now.body.indexOf(s));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect([...new Set(raised(now.body))].sort()).toEqual(["'LOGO_BAD_FILE'", "'LOGO_NOT_ALLOWED'"]);
    // The path rule is the one the bucket's upload policy and the app use.
    expect(now.body).toContain(`p_path !~ '^${UUID}/${UUID}\\.(png|jpg|webp)$'`);
  });

  test('a file is taken within an hour of its upload, and listed as stray only after a day: the two never overlap', () => {
    expect(now.body.match(/interval '[^']+'/g)).toEqual(["interval '1 hour'"]);
    for (const name of ['public.org_orphaned_logo_files', 'public.org_logo_file_is_orphaned']) {
      expect(fn(text, name).body.match(/interval '[^']+'/g), name).toEqual(["interval '1 day'"]);
    }
    // The file that already is the logo is recognised before its age is asked.
    expect(now.body.indexOf('if old_path is not distinct from p_path then')).toBeLessThan(now.body.indexOf('made < now()'));
  });
});

describe('the stray logo files', () => {
  test('listed: in the bucket, over a day old, no workspace\'s logo, oldest first', () => {
    const { header, body } = fn(text, 'public.org_orphaned_logo_files');
    expect(header).toBe('create or replace function public.org_orphaned_logo_files()\nreturns setof text language sql stable security definer set search_path = public');
    expect(flat(body)).toContain(
      "select ob.name from storage.objects ob where ob.bucket_id = 'org-logos' and ob.created_at < now() - interval '1 day' "
        + 'and not exists (select 1 from public.orgs o where o.logo_path = ob.name) order by ob.created_at, ob.name;',
    );
  });

  test('asked of one name: the same three conditions', () => {
    const { header, body } = fn(text, 'public.org_logo_file_is_orphaned');
    expect(header).toBe('create or replace function public.org_logo_file_is_orphaned(p_name text)\nreturns boolean language sql stable security definer set search_path = public');
    expect(flat(body)).toContain(
      "select exists ( select 1 from storage.objects ob where ob.bucket_id = 'org-logos' and ob.name = p_name and ob.created_at < now() - interval '1 day' "
        + 'and not exists (select 1 from public.orgs o where o.logo_path = ob.name) );',
    );
  });

  test('neither changes anything', () => {
    for (const name of ['public.org_orphaned_logo_files', 'public.org_logo_file_is_orphaned']) {
      expect(fn(text, name).body, name).not.toMatch(/\b(insert|update|delete)\b/);
    }
  });
});

describe('the starter templates, corrected', () => {
  const rows = starters(fn(text, 'private.hr_starter_letter_templates').body);
  const old = starters(fn(letters, 'private.hr_starter_letter_templates').body);
  const CORRECTED = MALAY.filter((name) => name !== 'Surat Amaran');

  test('twelve, as the earlier file listed them: the same order, languages, names, types and titles', () => {
    expect(old).toHaveLength(12);
    const outline = (list: Starter[]) => list.map((row) => [row.nth, row.lang, row.name, row.type, row.title]);
    expect(outline(rows)).toEqual(outline(old));
    expect(fn(text, 'private.hr_starter_letter_templates').header).toBe(fn(letters, 'private.hr_starter_letter_templates').header);
    expect(rows.slice(6).map((row) => row.name)).toEqual(MALAY);
  });

  test('the six English bodies and Surat Amaran are unchanged to the character', () => {
    for (let i = 0; i < 12; i += 1) {
      if (CORRECTED.includes(rows[i].name)) continue;
      expect(rows[i].body, rows[i].name).toBe(old[i].body);
    }
    expect(rows.filter((row) => !CORRECTED.includes(row.name))).toHaveLength(7);
  });

  test('five Bahasa Malaysia bodies differ by one capital letter: "di Jabatan {department}"', () => {
    for (const name of CORRECTED) {
      const now = rows.find((row) => row.name === name)!;
      const was = old.find((row) => row.name === name)!;
      expect(was.body.split('di jabatan {department}'), name).toHaveLength(2);
      expect(now.body, name).toBe(was.body.replace('di jabatan {department}', 'di Jabatan {department}'));
    }
  });

  test('no Bahasa Malaysia body has the lower-case form any more, and each has exactly the placeholders it had', () => {
    for (const row of rows.filter((r) => r.lang === 'ms')) {
      expect(row.body, row.name).not.toContain('di jabatan {department}');
      const was = old.find((o) => o.name === row.name)!;
      expect(used(row.body), row.name).toEqual(used(was.body));
      expect(row.body.match(/\{[^}]*\}/g), row.name).toEqual(was.body.match(/\{[^}]*\}/g));
    }
    expect(rows.filter((r) => r.lang === 'ms' && r.body.includes('di Jabatan {department}'))).toHaveLength(5);
    expect(rows.find((r) => r.name === 'Surat Amaran')!.body).not.toContain('{department}');
  });

  test('each body is written once in the file; the seeded ones are known by their md5', () => {
    for (const row of rows) expect(text.split(row.body.split('\n')[4].replaceAll("'", "''")).length, row.name).toBe(2);
    const listed = [...fn(text, 'private.hr_ms_letter_templates_as_seeded').body.matchAll(/\('((?:[^']|'')+)', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
    const seeded = old.filter((row) => row.lang === 'ms').map((row) => [row.name, createHash('md5').update(row.body, 'utf8').digest('hex')]);
    expect(listed).toEqual(seeded);
    expect(listed).toHaveLength(6);
  });
});

describe('a template has a language', () => {
  test('the seed gives each starter its language', () => {
    const now = fn(text, 'private.hr_seed_letter_templates');
    const was = fn(letters, 'private.hr_seed_letter_templates');
    expect(now.header).toBe(was.header);
    let expected = swap(was.body, '(org_id, name, letter_type, title, body)', '(org_id, name, letter_type, title, body, lang)');
    expected = swap(expected, 'select p_org, v.name, v.letter_type, v.title, v.body\n', 'select p_org, v.name, v.letter_type, v.title, v.body, v.lang\n');
    expect(now.body).toBe(expected);
  });

  test('the earlier backfill is the function as it was, with the language', () => {
    const now = fn(text, 'private.hr_backfill_ms_letter_templates');
    const was = fn(letters, 'private.hr_backfill_ms_letter_templates');
    expect(now.header).toBe(was.header);
    let expected = swap(was.body, '(org_id, name, letter_type, title, body)', '(org_id, name, letter_type, title, body, lang)');
    expected = swap(expected, 'select o, m.name, m.letter_type, m.title, m.body\n', 'select o, m.name, m.letter_type, m.title, m.body, m.lang\n');
    expect(now.body).toBe(expected);
  });

  test('the templates that exist are marked by one of the six names (whatever its capitals) or by their text, and by nothing else', () => {
    const { body } = fn(text, 'private.hr_mark_ms_letter_templates');
    expect(flat(body)).toContain(
      "update public.hr_letter_templates t set lang = 'ms' where t.lang <> 'ms' "
        + 'and (exists (select 1 from private.hr_ms_letter_templates_as_seeded() w where lower(w.name) = lower(t.name) or w.body_md5 = md5(t.body)) '
        + "or exists (select 1 from private.hr_starter_letter_templates() v where v.lang = 'ms' and v.body = t.body));",
    );
    expect(body.match(/\bupdate\b/g)).toHaveLength(1);
    expect(text.indexOf('select private.hr_mark_ms_letter_templates();')).toBeGreaterThan(text.indexOf('add column if not exists lang'));
  });

  test('the wording is corrected only in a copy under the starter\'s name with the text as it was seeded', () => {
    const { body } = fn(text, 'private.hr_correct_ms_letter_templates');
    expect(flat(body)).toContain(
      'update public.hr_letter_templates t set body = v.body from private.hr_starter_letter_templates() v '
        + 'join private.hr_ms_letter_templates_as_seeded() w on w.name = v.name '
        + "where v.lang = 'ms' and t.name = v.name and md5(t.body) = w.body_md5 and t.body <> v.body;",
    );
    expect(body.match(/\bupdate\b/g)).toHaveLength(1);
    // Run once, after the corrected list exists.
    expect(text.indexOf('select private.hr_correct_ms_letter_templates();')).toBeGreaterThan(text.indexOf('create or replace function private.hr_starter_letter_templates('));
  });

  test('a date is written in English as it always was, or with the twelve Bahasa Malaysia months', () => {
    const { header, body } = fn(text, 'private.hr_letter_date');
    expect(header).toBe('create or replace function private.hr_letter_date(p_date date, p_lang text)\nreturns text language sql stable set search_path = public');
    expect(body).toContain(`(array[${MONTHS.map((month) => `'${month}'`).join(',')}])[extract(month from p_date)::int]`);
    expect(body).toContain("else to_char(p_date, 'FMDD FMMonth YYYY') end;");
    expect(body).toContain("select case when p_lang = 'ms'");
  });

  test('starting a letter is the function as it was, with the two dates and the salary in the template\'s language', () => {
    const now = fn(text, 'public.hr_start_letter_from_template');
    const was = fn(letters, 'public.hr_start_letter_from_template');
    expect(now.header).toBe(was.header);
    let expected = swap(was.body, "'join_date', to_char(emp.join_date, 'FMDD FMMonth YYYY'),", "'join_date', private.hr_letter_date(emp.join_date, tpl.lang),");
    expected = swap(
      expected,
      "'today', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'FMDD FMMonth YYYY'),",
      "'today', private.hr_letter_date((now() at time zone 'Asia/Kuala_Lumpur')::date, tpl.lang),",
    );
    expected = swap(expected, " || ' per month'\n", " || (case when tpl.lang = 'ms' then ' sebulan' else ' per month' end)\n");
    expect(now.body).toBe(expected);
  });

  test('saving a template is the function as it was, with the language as a last argument that may be left unsaid', () => {
    const now = fn(text, 'public.hr_save_letter_template');
    const was = fn(before, 'public.hr_save_letter_template');
    expect(now.header).toBe(swap(was.header, 'p_title text, p_body text)', 'p_title text, p_body text, p_lang text default null)'));
    let expected = swap(was.body, '     or char_length(said) > 10000 then', "     or char_length(said) > 10000\n     or (p_lang is not null and p_lang not in ('en', 'ms')) then");
    expected = swap(expected, '(org_id, name, letter_type, title, body)\n', '(org_id, name, letter_type, title, body, lang)\n');
    expected = swap(expected, 'values (tpl.org_id, called, p_letter_type, named, said)', "values (tpl.org_id, called, p_letter_type, named, said, coalesce(p_lang, 'en'))");
    expected = swap(expected, 'title = named, body = said\n', 'title = named, body = said, lang = coalesce(p_lang, t.lang)\n');
    expected = swap(expected, "'title', tpl.title, 'body', tpl.body);", "'title', tpl.title, 'body', tpl.body, 'lang', tpl.lang);");
    expect(now.body).toBe(expected);
    // The six-argument function is gone before this one is made, so a call naming six arguments has one function to find.
    expect(text.indexOf('drop function if exists public.hr_save_letter_template(uuid, uuid, text, text, text, text);')).toBeLessThan(
      text.indexOf('create or replace function public.hr_save_letter_template('),
    );
  });

  test('the app on main names exactly the six arguments the function still has, in its order', () => {
    const args = [...fn(text, 'public.hr_save_letter_template').header.matchAll(/\b(p_\w+) (?:uuid|text)/g)].map((m) => m[1]);
    expect(args).toEqual(['p_org', 'p_template', 'p_name', 'p_letter_type', 'p_title', 'p_body', 'p_lang']);
  });
});
