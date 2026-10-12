import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const WRITES = '20261027090000_people_payroll_writes.sql';
const VERSION = WRITES.slice(0, 14);

/** The migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = () =>
  readFileSync(join(DIR, WRITES), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The nine functions the app calls, with the argument types their grants name and the first thing each does. */
const FUNCTIONS: { name: string; args: string; gate: string }[] = [
  { name: 'hr_run_payroll', args: 'uuid, date', gate: 'perform private.hr_payroll_admin_only(p_org);' },
  { name: 'hr_recalculate_payroll', args: 'uuid', gate: 'run := private.hr_payroll_held_run(p_run, null, null);' },
  {
    name: 'hr_save_payslip_line',
    args: 'uuid, uuid, text, text, bigint',
    gate: 'run := private.hr_payroll_held_run(null, p_payslip, null);',
  },
  { name: 'hr_delete_payslip_line', args: 'uuid', gate: 'run := private.hr_payroll_held_run(null, null, p_line);' },
  { name: 'hr_set_statutory', args: 'uuid, text, bigint', gate: 'run := private.hr_payroll_held_run(null, p_payslip, null);' },
  { name: 'hr_remove_payslip', args: 'uuid', gate: 'run := private.hr_payroll_held_run(null, p_payslip, null);' },
  { name: 'hr_delete_payroll_run', args: 'uuid', gate: 'run := private.hr_payroll_held_run(p_run, null, null);' },
  { name: 'hr_mark_payroll_paid', args: 'uuid', gate: 'run := private.hr_payroll_held_run(p_run, null, null);' },
  { name: 'hr_unmark_payroll_paid', args: 'uuid', gate: 'run := private.hr_payroll_held_run(p_run, null, null);' },
];
/** The two overtime functions of the claims slice, replaced here. */
const OVERTIME: { name: string; args: string }[] = [
  { name: 'hr_cancel_overtime', args: 'uuid' },
  { name: 'hr_decide_overtime', args: 'uuid, boolean, text' },
];
const HELPERS = [
  'private.hr_payroll_admin_only',
  'private.hr_payroll_held_run',
  'private.hr_payroll_working_days',
  'private.hr_payroll_unpaid_days',
  'private.hr_payroll_proposal',
  'private.hr_payroll_build_payslip',
  'private.hr_payroll_refresh_payslip',
  'private.hr_payroll_fill',
  'private.hr_payroll_skipped',
  'private.hr_payroll_earlier_overtime',
  'private.hr_payroll_run_json',
  'private.hr_payslip_json',
  'private.hr_employee_delete_guard',
  'private.reseed_demo_people',
];
const PAYROLL_CODES = [
  'PAYROLL_NOT_ALLOWED',
  'PAYROLL_NOT_FOUND',
  'PAYROLL_RUN_EXISTS',
  'PAYROLL_MONTH_NOT_STARTED',
  'PAYROLL_EARLIER_DRAFT',
  'PAYROLL_NOT_DRAFT',
  'PAYROLL_NOT_PAID',
  'PAYROLL_LATER_RUN',
  'PAYROLL_SKIPS_MONTH',
  'PAYROLL_NEGATIVE_NET',
  'PAYROLL_STALE',
  'PAYROLL_SYSTEM_LINE',
  'PAYROLL_BAD_INPUT',
];
/** What the two overtime functions already raised, plus the one new code. */
const OVERTIME_CODES = ['PAY_NOT_ALLOWED', 'PAY_NOT_FOUND', 'PAY_NOT_PENDING', 'PAY_BAD_INPUT', 'PAY_IN_PAID_RUN'];
const NOT_DRAFT = "if run.status <> 'draft' then raise exception 'PAYROLL_NOT_DRAFT'; end if;";
const PAID_RUN =
  "if exists (select 1 from public.hr_payslips p where p.id = req.payslip_id and p.status = 'paid') then\n"
  + "    raise exception 'PAY_IN_PAID_RUN';\n"
  + '  end if;';

/** One function's text: `header` up to `as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}

/** Every function the file creates, by its qualified name. */
function allFunctions(text: string): string[] {
  return [...text.matchAll(/create or replace function ((?:public|private)\.\w+)\(/g)].map((m) => m[1]);
}

/** Where the first thing that changes a row begins: a statement, or a call to a helper that writes. */
function firstWrite(body: string): number {
  const at = [
    'insert into public.',
    'update public.',
    'delete from public.',
    'private.hr_payroll_fill(',
    'private.hr_payroll_build_payslip(',
    'private.hr_payroll_refresh_payslip(',
  ]
    .map((s) => body.indexOf(s))
    .filter((i) => i > -1);
  expect(at.length).toBeGreaterThan(0);
  return Math.min(...at);
}

/** The bare messages of every `raise exception` in a piece of text. */
function raised(text: string): string[] {
  return [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
}

/** The file without the demo re-seed, which is copied from the first people slice and keeps its one plain message. */
function withoutReseed(text: string): string {
  const start = text.indexOf('create or replace function private.reseed_demo_people(');
  const end = text.indexOf('$$;', start);
  expect(start).toBeGreaterThan(-1);
  return text.slice(0, start) + text.slice(end);
}

describe('Lekiu payroll migration', () => {
  test('sorts after the migrations it builds on, alone on its timestamp', () => {
    const files = readdirSync(DIR).sort();
    expect(files.filter((f) => f.startsWith(VERSION))).toEqual([WRITES]);
    // After the attendance slice it builds on, and sharing its 14-digit version with no other file.
    expect(VERSION > '20261024090100').toBe(true);
    expect(files.filter((f) => f.slice(0, 14) === VERSION)).toHaveLength(1);
    // It edits no applied migration: the functions it changes are replaced in this file.
    expect(files).toContain('20261014090700_people_demo_seed.sql');
    expect(files).toContain('20261020090000_people_claims_overtime_writes.sql');
  });

  test('adds exactly the columns in the spec', () => {
    const text = statements();
    for (const line of [
      // hr_payroll_runs
      'add column created_by uuid references auth.users(id) on delete set null,',
      'add column paid_by uuid references auth.users(id) on delete set null;',
      // hr_payslips
      'add column basic_cents bigint not null default 0 check (basic_cents >= 0),',
      'add column other_deductions_cents bigint not null default 0 check (other_deductions_cents >= 0),',
      "add column set_by_hr text[] not null default '{}'",
      // hr_overtime_records
      'add column payslip_id uuid references public.hr_payslips(id) on delete set null;',
    ]) {
      expect(text).toContain(line);
    }
    // Only the four statutory figures can be named as typed over.
    expect(text).toContain("check (set_by_hr <@ array['epf','socso','eis','pcb']);");
    // Six new columns, and net pay added back.
    expect(text.match(/add column/g)).toHaveLength(7);
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual([
      'alter table public.hr_payroll_runs',
      'alter table public.hr_payslips',
      'alter table public.hr_overtime_records',
      'alter table public.hr_payslip_lines',
      'alter table public.hr_statutory_rules',
    ]);
    expect(text).not.toMatch(/alter column/);
  });

  test('existing payslips get their basic pay from their gross, before anything reads it', () => {
    const text = statements();
    const backfill = text.indexOf('update public.hr_payslips set basic_cents = gross_cents;');
    expect(backfill).toBeGreaterThan(text.indexOf('add column basic_cents'));
    expect(backfill).toBeLessThan(text.indexOf('create table'));
  });

  test('net pay is regenerated, with the other deductions taken off', () => {
    const text = statements();
    const drop = text.indexOf('alter table public.hr_payslips drop column net_cents;');
    const add = text.indexOf(
      'add column net_cents bigint generated always as\n'
        + '    (gross_cents - epf_cents - socso_cents - eis_cents - pcb_cents - other_deductions_cents) stored;',
    );
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    // Nothing else is dropped: one column and the two read policies that are recreated.
    expect((text.match(/\bdrop \w+[^;]*;/g) ?? []).sort()).toEqual([
      'drop column net_cents;',
      'drop policy hr_letters_select on public.hr_letters;',
      'drop policy hr_payslips_select on public.hr_payslips;',
    ]);
  });

  test('payslip lines: the table in the spec, with every check', () => {
    const text = statements();
    expect(text).toContain(
      'create table public.hr_payslip_lines (\n'
        + '  id uuid primary key default gen_random_uuid(),\n'
        + '  org_id uuid not null references public.orgs(id) on delete cascade,\n'
        + '  payslip_id uuid not null references public.hr_payslips(id) on delete cascade,\n'
        + "  kind text not null check (kind in ('earning','unpaid','deduction')),\n"
        + "  source text not null check (source in ('hr','overtime','unpaid_leave','joiner')),\n"
        + '  label text not null check (label = trim(label) and char_length(label) between 1 and 80),\n'
        + '  amount_cents bigint not null check (amount_cents > 0),\n'
        + '  overtime_record_id uuid references public.hr_overtime_records(id) on delete cascade,\n'
        + '  created_at timestamptz not null default now(),\n'
        + '  constraint hr_payslip_lines_source_kind check (\n'
        + "    (source = 'overtime' and kind = 'earning')\n"
        + "    or (source in ('unpaid_leave','joiner') and kind = 'unpaid')\n"
        + "    or (source = 'hr' and kind in ('earning','deduction'))),\n"
        + '  constraint hr_payslip_lines_overtime_record check (\n'
        + "    (source = 'overtime') = (overtime_record_id is not null))\n"
        + ');',
    );
    // An overtime record is on one line at most.
    expect(text).toContain(
      'create unique index hr_payslip_lines_overtime_record_idx on public.hr_payslip_lines (overtime_record_id)\n'
        + '  where overtime_record_id is not null;',
    );
    expect(text.match(/create table/g)).toHaveLength(2);
  });

  test('payslip lines: row level security on, readable, and no way to write', () => {
    const text = statements();
    expect(text).toContain('alter table public.hr_payslip_lines enable row level security;');
    expect(text).toContain('revoke all on public.hr_payslip_lines from anon, authenticated;');
    expect(text).toContain('grant select on public.hr_payslip_lines to authenticated;');
    expect(text).toContain(
      'create policy mfa_required on public.hr_payslip_lines as restrictive for all to authenticated\n'
        + '  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));',
    );
  });

  test('statutory rules: one row a scheme, readable by signed-in users and written by nobody', () => {
    const text = statements();
    expect(text).toContain(
      'create table public.hr_statutory_rules (\n'
        + "  scheme text primary key check (scheme in ('epf','socso','eis')),\n"
        + '  rate numeric(6,5) not null check (rate >= 0 and rate <= 1),\n'
        + '  max_cents bigint check (max_cents is null or max_cents >= 0),\n'
        + '  note text\n'
        + ');',
    );
    expect(text).toContain('alter table public.hr_statutory_rules enable row level security;');
    expect(text).toContain('revoke all on public.hr_statutory_rules from anon, authenticated;');
    expect(text).toContain('grant select on public.hr_statutory_rules to authenticated;');
    expect(text).toContain(
      'create policy hr_statutory_rules_select on public.hr_statutory_rules for select to authenticated using (true);',
    );
    // The three rows, with the rates and maxima of the spec.
    expect(text).toContain(
      'insert into public.hr_statutory_rules (scheme, rate, max_cents, note) values\n'
        + "  ('epf', 0.11, null, 'EPF Act 1991, Third Schedule, employee share below age 60'),\n"
        + "  ('socso', 0.005, 2975, 'Employee share, first category; wage ceiling RM 6,000 from 1 October 2024'),\n"
        + "  ('eis', 0.002, 1190, 'Employee share; wage ceiling RM 6,000 from 1 October 2024');",
    );
    expect(text.match(/(insert into|update|delete from) public\.hr_statutory_rules/g)).toHaveLength(1);
  });

  test('no table gets a write grant, and row level security is never turned off', () => {
    const text = statements();
    const grants = (text.match(/grant [^;]*;/g) ?? []).sort();
    expect(grants).toEqual(
      [
        ...[...FUNCTIONS, ...OVERTIME].map((f) => `grant execute on function public.${f.name}(${f.args}) to authenticated;`),
        'grant select on public.hr_payslip_lines to authenticated;',
        'grant select on public.hr_statutory_rules to authenticated;',
      ].sort(),
    );
    expect(text).not.toMatch(/grant\s+(all|insert|update|delete|truncate)/i);
    expect(text).not.toMatch(/disable row level security/i);
    expect(text).not.toMatch(/for (all|insert|update|delete) to authenticated\s+using \((?!\(select private\.mfa_ok)/);
  });

  test('a payslip is read by owners and admins, by its employee once paid, and by the demo', () => {
    const text = statements();
    const drop = text.indexOf('drop policy hr_payslips_select on public.hr_payslips;');
    const create = text.indexOf(
      'create policy hr_payslips_select on public.hr_payslips for select to authenticated using (\n'
        + '  private.is_org_admin(org_id)\n'
        + "  or (status = 'paid' and private.is_own_employee(employee_id))\n"
        + '  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));',
    );
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  test('a payslip line is read through its payslip, by the same rule', () => {
    const text = statements();
    expect(text).toContain(
      'create policy hr_payslip_lines_select on public.hr_payslip_lines for select to authenticated using (\n'
        + '  exists (\n'
        + '    select 1 from public.hr_payslips p\n'
        + '    where p.id = hr_payslip_lines.payslip_id\n'
        + '      and (private.is_org_admin(p.org_id)\n'
        + "        or (p.status = 'paid' and private.is_own_employee(p.employee_id))\n"
        + '        or (private.is_demo_org(p.org_id) and private.is_org_member(p.org_id)))));',
    );
  });

  test('a letter is read by owners and admins, by its employee once issued, and by the demo', () => {
    const text = statements();
    const drop = text.indexOf('drop policy hr_letters_select on public.hr_letters;');
    const create = text.indexOf(
      'create policy hr_letters_select on public.hr_letters for select to authenticated using (\n'
        + '  private.is_org_admin(org_id)\n'
        + "  or (status = 'issued' and private.is_own_employee(employee_id))\n"
        + '  or (private.is_demo_org(org_id) and private.is_org_member(org_id)));',
    );
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  test('five policies are created and none is a write policy; the second-factor policies stay', () => {
    const text = statements();
    expect((text.match(/create policy (\w+) on (\w+\.\w+)/g) ?? []).sort()).toEqual([
      'create policy hr_letters_select on public.hr_letters',
      'create policy hr_payslip_lines_select on public.hr_payslip_lines',
      'create policy hr_payslips_select on public.hr_payslips',
      'create policy hr_statutory_rules_select on public.hr_statutory_rules',
      'create policy mfa_required on public.hr_payslip_lines',
    ]);
    // An employee's own rows are never read on being theirs alone.
    const policies = (text.match(/create policy \w+_select[^;]*;/g) ?? []).join('\n');
    expect(policies.match(/is_own_employee/g)).toHaveLength(3);
    expect(policies.match(/status = '(paid|issued)' and private\.is_own_employee/g)).toHaveLength(3);
    expect(text).not.toMatch(/drop policy mfa_required/);
  });

  test('creates the nine functions and replaces the two overtime ones, and no other in the public schema', () => {
    const made = allFunctions(statements()).filter((name) => name.startsWith('public.'));
    expect(made.sort()).toEqual([...FUNCTIONS, ...OVERTIME].map((f) => `public.${f.name}`).sort());
    // One of each: no second function of a name, with other arguments.
    expect(new Set(made).size).toBe(made.length);
  });

  test.each([...FUNCTIONS, ...OVERTIME])('$name runs as the owner on a fixed search path and returns jsonb', ({ name }) => {
    const { header } = fn(statements(), `public.${name}`);
    expect(header).toContain('returns jsonb language plpgsql security definer set search_path = public');
  });

  test.each([...FUNCTIONS, ...OVERTIME])('$name can be called by signed-in users only', ({ name, args }) => {
    const text = statements();
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test.each(FUNCTIONS)('$name begins by refusing the demo and anyone who is not an owner or admin', ({ name, gate }) => {
    const { body } = fn(statements(), `public.${name}`);
    const call = body.indexOf(gate);
    expect(call, name).toBeGreaterThan(-1);
    // It is the first thing the function does.
    expect(body.slice(body.indexOf('begin'), call).trim(), name).toBe('begin');
    expect(firstWrite(body), name).toBeGreaterThan(call);
    // The decision is made in the two gates and nowhere else.
    expect(body, name).not.toMatch(/is_org_(admin|writer|member)|is_own_employee|is_demo_org/);
  });

  test('a new run is for owners and admins of the workspace named, and never in the demo', () => {
    const { body } = fn(statements(), 'private.hr_payroll_admin_only');
    expect(body).toContain("if auth.uid() is null or p_org is null then raise exception 'PAYROLL_NOT_ALLOWED'; end if;");
    expect(body).toContain("if private.is_demo_org(p_org) then raise exception 'PAYROLL_NOT_ALLOWED'; end if;");
    expect(body).toContain("if not private.is_org_admin(p_org) then raise exception 'PAYROLL_NOT_ALLOWED'; end if;");
    expect(body).not.toMatch(/is_org_(writer|member)/);
    // Only hr_run_payroll takes a workspace from its caller.
    for (const { name } of FUNCTIONS.filter((f) => f.name !== 'hr_run_payroll')) {
      expect(fn(statements(), `public.${name}`).header, name).not.toMatch(/org/i);
    }
  });

  test('every other function takes its workspace from the run, which it holds before reading it', () => {
    const { header, body } = fn(statements(), 'private.hr_payroll_held_run');
    expect(header).toContain('(p_run uuid, p_payslip uuid, p_line uuid)');
    const signedIn = body.indexOf("if auth.uid() is null then raise exception 'PAYROLL_NOT_ALLOWED'; end if;");
    const lock = body.indexOf('select r.* into run from public.hr_payroll_runs r where r.id = run_id for no key update;');
    const missing = body.indexOf("if not found then raise exception 'PAYROLL_NOT_FOUND'; end if;");
    const hidden = body.indexOf(
      'if not (private.is_org_admin(run.org_id)\n'
        + '          or (private.is_demo_org(run.org_id) and private.is_org_member(run.org_id))) then\n'
        + "    raise exception 'PAYROLL_NOT_FOUND';\n"
        + '  end if;',
    );
    const demo = body.indexOf("if private.is_demo_org(run.org_id) then raise exception 'PAYROLL_NOT_ALLOWED'; end if;");
    const order = [signedIn, lock, missing, hidden, demo];
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The run row is read here, under the lock, and by no public function before it holds it.
    expect(body.match(/from public\.hr_payroll_runs/g)).toHaveLength(1);
    expect(body).not.toMatch(/is_org_writer/);
  });

  test.each(FUNCTIONS.filter((f) => !['hr_run_payroll', 'hr_unmark_payroll_paid'].includes(f.name)))(
    '$name changes nothing unless the run is a draft',
    ({ name, gate }) => {
      const { body } = fn(statements(), `public.${name}`);
      const draft = body.indexOf(NOT_DRAFT);
      expect(draft, name).toBeGreaterThan(body.indexOf(gate));
      expect(firstWrite(body), name).toBeGreaterThan(draft);
      // Nothing is asked of a paid run before it is refused: no other refusal comes first.
      expect(body.indexOf('raise exception'), name).toBe(body.indexOf("raise exception 'PAYROLL_NOT_DRAFT'"));
    },
  );

  test('a new run holds the workspace, and is refused in the order the spec gives', () => {
    const { body } = fn(statements(), 'public.hr_run_payroll');
    const order = [
      'perform private.hr_payroll_admin_only(p_org);',
      'perform 1 from public.orgs o where o.id = p_org for no key update;',
      "raise exception 'PAYROLL_BAD_INPUT'",
      "if p_month > today then raise exception 'PAYROLL_MONTH_NOT_STARTED'; end if;",
      "raise exception 'PAYROLL_RUN_EXISTS'",
      "raise exception 'PAYROLL_LATER_RUN'",
      "raise exception 'PAYROLL_EARLIER_DRAFT'",
      'select max(r.period_month) into latest from public.hr_payroll_runs r where r.org_id = p_org;',
      "if latest is not null and p_month <> (latest + interval '1 month')::date then",
      "raise exception 'PAYROLL_SKIPS_MONTH'",
      'insert into public.hr_payroll_runs (org_id, period_month, status, created_by)',
    ].map((line) => body.indexOf(line));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A month with nobody to pay is still run: nothing is refused once the run is made.
    expect(body.lastIndexOf('raise exception')).toBeLessThan(body.indexOf('insert into public.hr_payroll_runs'));
    expect(body).not.toMatch(/made = 0|made < 1/);
    expect(body).toContain("today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;");
    // The month is the first of a month, as given: it is not rounded to one.
    expect(body).toContain('extract(day from p_month) <> 1');
    expect(body).toContain("values (p_org, p_month, 'draft', auth.uid())");
    expect(body).toContain("r.period_month < p_month and r.status = 'draft'");
    // Runs are made in order of month: a later run, whatever its status, stops an earlier month.
    expect(body).toContain('where r.org_id = p_org and r.period_month > p_month\n');
    expect(body).toContain("'earlier_overtime', private.hr_payroll_earlier_overtime(run)");
  });

  test('today is today in Malaysia, and nothing reads another clock', () => {
    expect(statements()).not.toMatch(/current_date|current_time|localtime|clock_timestamp|statement_timestamp|timeofday/i);
  });

  test('who gets a payslip: active, with a salary, joined by the end of the month', () => {
    const { body } = fn(statements(), 'private.hr_payroll_fill');
    expect(body).toContain(
      "where e.org_id = p_run.org_id and e.status = 'active' and x.base_salary_cents > 0\n"
        + '      and (e.join_date is null or e.join_date <= month_end)',
    );
    // Nobody already in the run is added twice, and nobody is ever removed.
    expect(body).toContain('and not exists (');
    expect(body).not.toMatch(/delete from/);
    // Every payslip of the run is then worked out again.
    expect(body).toContain('perform private.hr_payroll_build_payslip(slip_id);');
    const skipped = fn(statements(), 'private.hr_payroll_skipped').body;
    expect(skipped).toContain("'reason', 'no_salary'");
    expect(skipped).toContain("e.status = 'active' and coalesce(x.base_salary_cents, 0) = 0");
    // Someone who joins after the month is not "skipped for want of a salary".
    expect(skipped).toContain("and (e.join_date is null or e.join_date <= (p_run.period_month + interval '1 month')::date - 1)");
  });

  test('a payslip is built from the salary now, the joiner rule, unpaid leave and overtime', () => {
    const text = statements();
    const { body } = fn(text, 'private.hr_payroll_build_payslip');
    // System lines are rebuilt and their overtime released first; HR's own lines are kept.
    const release = body.indexOf('update public.hr_overtime_records r set payslip_id = null where r.payslip_id = slip.id;');
    const clear = body.indexOf("delete from public.hr_payslip_lines l where l.payslip_id = slip.id and l.source <> 'hr';");
    expect(release).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(release);
    // The records it lets go or takes are held first, in order of id, as paying a run holds them.
    const hold = body.indexOf(
      'perform 1 from public.hr_overtime_records r\n'
        + '  where r.employee_id = slip.employee_id and r.org_id = slip.org_id\n'
        + "    and (r.payslip_id = slip.id or (r.status = 'approved' and r.payslip_id is null))\n"
        + '  order by r.id\n'
        + '  for update;',
    );
    expect(hold).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(hold);
    expect(fn(text, 'public.hr_mark_payroll_paid').body).toContain('order by r.id\n  for update;');
    expect(body.match(/delete from/g)).toHaveLength(1);
    // Joiner: only inside the month after its first day, by working days, and only with a working day in the month.
    expect(body).toContain('if joined > slip.period_month and joined <= month_end then');
    expect(body).toContain('joiner := salary - round(salary::numeric * w_after / w_month)::bigint;');
    expect(body).toContain('if w_month > 0 then');
    expect(body).toContain('if joiner > 0 then');
    // Unpaid leave: a 26th of basic a day, rounded once more after the days, capped by what basic has left.
    expect(body).toContain('unpaid := least(round(round(salary / 26.0) * days)::bigint, salary - joiner);');
    expect(body).toContain('if unpaid > 0 then');
    // Overtime: approved, not yet taken, worth something, worked by the end of the month; taken as it is listed.
    const take = body.indexOf('update public.hr_overtime_records r set payslip_id = slip.id');
    expect(take).toBeGreaterThan(clear);
    expect(body).toContain(
      "where r.employee_id = slip.employee_id and r.org_id = slip.org_id\n"
        + "      and r.status = 'approved' and r.payslip_id is null\n"
        + '      and r.amount_cents > 0 and r.work_date <= month_end',
    );
    // Working days and leave are counted by the one rule the attendance slice wrote.
    expect(fn(text, 'private.hr_payroll_working_days').body).toContain('private.hr_is_working_day(p_org, p_from + g.i)');
    expect(withoutReseed(text)).not.toMatch(/isodow/);
    const leave = fn(text, 'private.hr_payroll_unpaid_days').body;
    expect(leave).toContain("r.leave_type = 'unpaid' and r.status = 'approved'");
    expect(leave).toContain('case when r.half_day then 0.5 else 1 end');
    expect(leave).toContain('greatest(r.start_date, p_month)');
  });

  test('gross, the proposals and the deductions total are worked out in one place', () => {
    const text = statements();
    const { body } = fn(text, 'private.hr_payroll_refresh_payslip');
    expect(body).toContain('gross := greatest(slip.basic_cents + earnings - unpaid, 0);');
    for (const field of ['epf', 'socso', 'eis']) {
      expect(body).toContain(
        `${field}_cents = case when '${field}' = any(p.set_by_hr) then p.${field}_cents else private.hr_payroll_proposal('${field}', gross) end,`,
      );
    }
    expect(body).toContain("pcb_cents = case when 'pcb' = any(p.set_by_hr) then p.pcb_cents else coalesce(last_pcb, 0) end,");
    expect(body).toContain('other_deductions_cents = deductions');
    // PCB is copied from the employee's latest paid payslip.
    expect(body).toContain("where q.employee_id = slip.employee_id and q.status = 'paid'\n  order by q.period_month desc limit 1;");
    // A rate, and a maximum where the scheme has one.
    expect(fn(text, 'private.hr_payroll_proposal').body).toContain('least(round(p_gross * s.rate), s.max_cents)::bigint');
    // No function sets gross or a proposal itself.
    for (const { name } of FUNCTIONS) {
      expect(fn(text, `public.${name}`).body, name).not.toMatch(/gross_cents\s*=|other_deductions_cents\s*=/);
    }
    expect(text.match(/\b0\.11\b|\b0\.005\b|\b0\.002\b/g)).toHaveLength(3);
  });

  test('a line is HR\'s to change only when HR made it', () => {
    const text = statements();
    for (const name of ['hr_save_payslip_line', 'hr_delete_payslip_line']) {
      const { body } = fn(text, `public.${name}`);
      const system = body.indexOf("if line.source <> 'hr' then raise exception 'PAYROLL_SYSTEM_LINE'; end if;");
      expect(system, name).toBeGreaterThan(body.indexOf(NOT_DRAFT));
      expect(firstWrite(body), name).toBeGreaterThan(system);
      expect(body, name).toContain('private.hr_payroll_refresh_payslip(');
    }
    const save = fn(text, 'public.hr_save_payslip_line').body;
    expect(save).toContain("p_kind is null or p_kind not in ('earning','deduction')");
    expect(save).toContain('title is null or char_length(title) not between 1 and 80');
    expect(save).toContain('p_amount_cents is null or p_amount_cents <= 0');
    // A line being changed must be a line of the payslip named.
    expect(save).toContain('where l.id = p_line and l.payslip_id = slip.id;');
    expect(save).toContain("values (slip.org_id, slip.id, p_kind, 'hr', title, p_amount_cents)");
  });

  test('a run says how many of its overtime lines are for work done before its month', () => {
    const text = statements();
    const { header, body } = fn(text, 'private.hr_payroll_earlier_overtime');
    expect(header).toContain('returns int language sql stable set search_path = public');
    expect(body).toContain('join public.hr_overtime_records r on r.id = l.overtime_record_id');
    expect(body).toContain('where p.payroll_run_id = p_run.id and r.work_date < p_run.period_month;');
    for (const name of ['hr_run_payroll', 'hr_recalculate_payroll']) {
      expect(fn(text, `public.${name}`).body, name).toContain("'earlier_overtime', private.hr_payroll_earlier_overtime(run)");
    }
  });

  test('a statutory figure is one of four, never below zero, and remembers that HR set it', () => {
    const { body } = fn(statements(), 'public.hr_set_statutory');
    expect(body).toContain("p_field is null or p_field not in ('epf','socso','eis','pcb')");
    expect(body).toContain('p_amount_cents < 0');
    expect(body.indexOf("raise exception 'PAYROLL_BAD_INPUT'")).toBeGreaterThan(body.indexOf(NOT_DRAFT));
    expect(body).toContain('where f = any(p.set_by_hr) or f = p_field');
    expect(body).toContain('where f = any(p.set_by_hr) and f <> p_field');
    expect(body).toContain('private.hr_payroll_refresh_payslip(');
  });

  test('removing a payslip or a draft lets its overtime go', () => {
    const text = statements();
    const remove = fn(text, 'public.hr_remove_payslip').body;
    expect(remove).toContain('update public.hr_overtime_records r set payslip_id = null where r.payslip_id = slip.id;');
    expect(remove).toContain('delete from public.hr_payslips p where p.id = slip.id;');
    const del = fn(text, 'public.hr_delete_payroll_run').body;
    expect(del).toContain('where r.payslip_id in (select p.id from public.hr_payslips p where p.payroll_run_id = run.id);');
    expect(del).toContain('delete from public.hr_payroll_runs r where r.id = run.id;');
  });

  test('a run is paid only when no payslip is negative and its overtime still stands; an empty one can be paid', () => {
    const { body } = fn(statements(), 'public.hr_mark_payroll_paid');
    const order = [
      NOT_DRAFT,
      "raise exception 'PAYROLL_NEGATIVE_NET'",
      'for update;',
      "raise exception 'PAYROLL_STALE'",
      "update public.hr_payslips p set status = 'paid' where p.payroll_run_id = run.id;",
      "set status = 'paid', paid_at = now(), paid_by = auth.uid()",
    ].map((line) => body.indexOf(line));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain('p.net_cents < 0');
    // Three refusals and no more: a draft with no payslips is paid as a record that nothing was paid.
    expect(raised(body)).toEqual(["'PAYROLL_NOT_DRAFT'", "'PAYROLL_NEGATIVE_NET'", "'PAYROLL_STALE'"]);
    expect(body).not.toMatch(/not exists/);
    expect(body).toContain("(r.status <> 'approved' or r.payslip_id is distinct from l.payslip_id)");
  });

  test('undoing paid needs a paid run with no later run, and puts everything back', () => {
    const { body } = fn(statements(), 'public.hr_unmark_payroll_paid');
    const order = [
      "if run.status <> 'paid' then raise exception 'PAYROLL_NOT_PAID'; end if;",
      'perform 1 from public.orgs o where o.id = run.org_id for no key update;',
      "raise exception 'PAYROLL_LATER_RUN'",
      "update public.hr_payslips p set status = 'pending' where p.payroll_run_id = run.id;",
      "set status = 'draft', paid_at = null, paid_by = null",
    ].map((line) => body.indexOf(line));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain('r.org_id = run.org_id and r.period_month > run.period_month');
  });

  test('overtime paid in a run cannot be cancelled or decided again', () => {
    const text = statements();
    const cancel = fn(text, 'public.hr_cancel_overtime').body;
    const decide = fn(text, 'public.hr_decide_overtime').body;
    for (const [name, body] of [['hr_cancel_overtime', cancel], ['hr_decide_overtime', decide]] as const) {
      const paid = body.indexOf(PAID_RUN);
      expect(paid, name).toBeGreaterThan(-1);
      expect(firstWrite(body), name).toBeGreaterThan(paid);
      // The record is held before its payslip is looked at.
      expect(paid, name).toBeGreaterThan(body.indexOf('from public.hr_overtime_records r where r.id = p_request for update;'));
      // Everything the claims slice decided is still there.
      expect(body, name).toContain("if is_demo then raise exception 'PAY_NOT_ALLOWED'; end if;");
      expect(body, name).toContain(
        'if not (is_admin or private.is_own_employee(req.employee_id)\n'
          + '          or (is_demo and private.is_org_member(req.org_id))) then\n'
          + "    raise exception 'PAY_NOT_FOUND';",
      );
    }
    expect(cancel).toContain("if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;");
    expect(cancel).toContain("update public.hr_overtime_records set status = 'cancelled' where id = req.id;");
    // Deciding looks before it asks whether the record is still pending, or it could never say so.
    expect(decide.indexOf(PAID_RUN)).toBeLessThan(decide.indexOf("if req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;"));
    expect(decide).toContain("if not is_admin then raise exception 'PAY_NOT_ALLOWED'; end if;");
    expect(decide).toContain('private.hr_overtime_figures(req.org_id, req.employee_id, req.work_date, req.hours)');
  });

  test('an employee with a paid payslip cannot be deleted, except with their workspace', () => {
    const text = statements();
    const { header, body } = fn(text, 'private.hr_employee_delete_guard');
    expect(header).toContain('returns trigger language plpgsql security definer set search_path = public');
    expect(body).toContain("where p.employee_id = old.id and p.status = 'paid'");
    // The runs of the employee's payslips are held before the payslips are looked at, so paying a run
    // cannot slip in between: the run's row, in order of id, which every payroll function takes first.
    const hold = body.indexOf(
      'perform 1 from public.hr_payroll_runs r\n'
        + '  where r.id in (select p.payroll_run_id from public.hr_payslips p where p.employee_id = old.id)\n'
        + '  order by r.id\n'
        + '  for no key update;',
    );
    // It does not hold the payslips themselves, which could cross with a function holding overtime rows.
    expect(body).not.toMatch(/perform 1 from public\.hr_payslips/);
    expect(body.match(/for (no key )?update/g)).toHaveLength(1);
    expect(hold).toBeGreaterThan(-1);
    expect(body.indexOf('if exists (')).toBeGreaterThan(hold);
    expect(body).toContain("raise exception 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS';");
    expect(body).toContain('return old;');
    // A delete that cascades from the workspace runs inside another trigger, and is let through.
    expect(text).toContain(
      'create trigger hr_employees_paid_payslips_guard before delete on public.hr_employees\n'
        + '  for each row when (pg_trigger_depth() = 0) execute function private.hr_employee_delete_guard();',
    );
    expect(text.match(/pg_trigger_depth\(\)/g)).toHaveLength(1);
    expect(text.match(/create trigger/g)).toHaveLength(1);
  });

  test('the helpers are private, on a fixed search path, and closed to the API roles', () => {
    const text = statements();
    const helpers = allFunctions(text).filter((name) => name.startsWith('private.'));
    expect(helpers).toEqual(HELPERS);
    for (const helper of helpers) {
      const { header } = fn(text, helper);
      expect(header, helper).toContain('set search_path = public');
      expect(text, helper).toMatch(
        new RegExp(`revoke all on function ${helper.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`),
      );
    }
  });

  test('a refusal is one of the codes and carries nothing else', () => {
    const text = statements();
    // The two codes for "nobody to pay" are gone: such a month is run and paid like any other.
    expect(readFileSync(join(DIR, WRITES), 'utf8')).not.toMatch(/PAYROLL_NOBODY|PAYROLL_NO_PAYSLIPS/);
    const payroll = withoutReseed(text);
    const messages = raised(payroll);
    expect(messages.length).toBeGreaterThan(30);
    // Every raise is a `raise exception '<CODE>'`: no notice, no format arguments, no `using`.
    expect(payroll.match(/\braise /g)).toHaveLength(messages.length);
    for (const message of messages) expect(message).toMatch(/^'[A-Z_]+'$/);

    const overtime = OVERTIME.map((f) => fn(text, `public.${f.name}`).body).join('\n');
    expect([...new Set(raised(overtime).map((m) => m.slice(1, -1)))].sort()).toEqual([...OVERTIME_CODES].sort());
    expect(raised(fn(text, 'private.hr_employee_delete_guard').body)).toEqual(["'HR_EMPLOYEE_HAS_PAID_PAYSLIPS'"]);

    const rest = [...FUNCTIONS.map((f) => `public.${f.name}`), ...HELPERS.slice(0, -2)]
      .map((name) => fn(text, name).body)
      .join('\n');
    expect([...new Set(raised(rest).map((m) => m.slice(1, -1)))].sort()).toEqual([...PAYROLL_CODES].sort());
    // Sixteen codes in all, as the spec lists them.
    const all = new Set(messages.map((m) => m.slice(1, -1)));
    for (const code of [...PAYROLL_CODES, 'PAY_IN_PAID_RUN', 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS']) expect(all.has(code), code).toBe(true);
    expect(all.size).toBe(PAYROLL_CODES.length + OVERTIME_CODES.length + 1);
  });

  test('the demo re-seed removes the payroll runs before the employees, and builds payslips that add up', () => {
    const text = statements();
    const { header, body } = fn(text, 'private.reseed_demo_people');
    expect(header).toContain('returns void language plpgsql security definer set search_path = public');
    // Paid payslips go first, or the employee guard would stop the hourly job.
    const runs = body.indexOf('delete from public.hr_payroll_runs where org_id = demo;');
    const employees = body.indexOf('delete from public.hr_employees where org_id = demo;');
    expect(runs).toBeGreaterThan(-1);
    expect(employees).toBeGreaterThan(runs);
    expect(body).toContain('insert into public.hr_payslips (org_id, employee_id, payroll_run_id, period_month,\n    basic_cents, gross_cents,');
    expect(body).toContain('insert into public.hr_payslip_lines');
    // Every figure comes from the same place a real payslip's does.
    expect(body).toContain('perform private.hr_payroll_refresh_payslip(p.id) from public.hr_payslips p where p.org_id = demo;');
    // The settings row is there before the joiner lines count working days from it.
    const settings = body.indexOf('insert into public.hr_settings (org_id, notifications)');
    expect(settings).toBeGreaterThan(body.indexOf('-- Payroll:'));
    expect(settings).toBeLessThan(body.indexOf('insert into public.hr_payroll_runs ('));
    expect(body.match(/insert into public\.hr_settings/g)).toHaveLength(1);
    // Its one message is the one it always had.
    expect(raised(body)).toEqual(["'demo org missing'"]);
    // The rest of the demo is still built: one insert for every table the first seed filled.
    for (const table of [
      'hr_departments', 'hr_employees', 'hr_employee_private', 'hr_leave_requests', 'hr_leave_balances',
      'hr_time_off_requests', 'hr_claims', 'hr_overtime_records', 'hr_attendance_days', 'hr_timesheet_entries',
      'hr_shifts', 'hr_public_holidays', 'hr_payroll_runs', 'hr_payslips', 'hr_payment_vouchers', 'hr_goals',
      'hr_scorecards', 'hr_reviews', 'hr_trainings', 'hr_training_enrolments', 'hr_announcements', 'hr_documents',
      'hr_letters', 'hr_settings',
    ]) {
      expect(body, table).toContain(`insert into public.${table} (`);
    }
    // And the demo is rebuilt as the migration is applied, so it is right from the first minute.
    expect(text.trimEnd().endsWith('select private.reseed_demo_people();')).toBe(true);
  });

  test('everything but the payroll part of the demo re-seed is word for word what it was', () => {
    const before = fn(
      readFileSync(join(DIR, '20261014090700_people_demo_seed.sql'), 'utf8'),
      'private.reseed_demo_people',
    ).body.split('\n');
    const after = fn(readFileSync(join(DIR, WRITES), 'utf8'), 'private.reseed_demo_people').body.split('\n');
    // Up to the payroll section, only the order of the first two deletes differs.
    const cut = (lines: string[], from: string, to: string) =>
      lines.slice(lines.findIndex((l) => l.includes(from)), lines.findIndex((l) => l.includes(to)));
    const head = (lines: string[]) => cut(lines, 'delete from public.hr_payment_vouchers', '-- Payroll:');
    expect(head(after)).toEqual(head(before));
    expect(head(after).length).toBeGreaterThan(200);
    // After it, from the payment vouchers to the end, nothing differs but the
    // settings row, which moved up to before the payroll part, unchanged.
    const settings = (lines: string[]) => {
      const at = lines.findIndex((l) => l.includes('insert into public.hr_settings (org_id, notifications)'));
      return lines.slice(at, at + 2);
    };
    expect(settings(after)).toEqual(settings(before));
    expect(settings(after)).toHaveLength(2);
    const tail = (lines: string[]) =>
      lines
        .slice(lines.findIndex((l) => l.includes('insert into public.hr_payment_vouchers')))
        .filter((l) => l.trim() !== '' && !settings(lines).includes(l));
    expect(tail(after)).toEqual(tail(before));
    expect(tail(after).length).toBeGreaterThan(80);
  });
});
