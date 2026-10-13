import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = readdirSync(DIR).find((f) => f.endsWith('_people_reporting_lines.sql')) ?? 'missing';
/** Where each replaced function's newest earlier definition lives. */
const DECIDE = '20261030124500_people_no_self_approval.sql';
const LEAVE = '20261018090000_people_leave_writes.sql';
const CLAIM = '20261020100000_people_receipt_release.sql';
const OVERTIME = '20261020090000_people_claims_overtime_writes.sql';
const RESEED = '20261102090200_people_documents_demo_seed.sql';

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
/** A migration's statements without its comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ');
/** One function's text: `header` up to ` as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}
const sql = FILE === 'missing' ? '' : statements(FILE);

const DECIDERS: [string, 'leave' | 'time_off' | 'claim' | 'overtime', 'LEAVE' | 'PAY'][] = [
  ['public.hr_decide_leave', 'leave', 'LEAVE'],
  ['public.hr_decide_time_off', 'time_off', 'LEAVE'],
  ['public.hr_decide_claim', 'claim', 'PAY'],
  ['public.hr_decide_overtime', 'overtime', 'PAY'],
];
const FILERS: [string, string, string][] = [
  ['public.hr_apply_leave', LEAVE, 'leave'],
  ['public.hr_apply_time_off', LEAVE, 'time_off'],
  ['public.hr_submit_claim', CLAIM, 'claim'],
  ['public.hr_submit_overtime', OVERTIME, 'overtime'],
];
/** The statement this slice adds to the demo re-seed, exactly as written in the migration. */
const REPORTING_LINES =
  "  update public.hr_employees e set reports_to = md5('rimba-emp-' || v.lead)::uuid\n" +
  "  from (values ('Sales', 12), ('Operations', 3), ('Marketing', 9), ('Finance', 18)) as v(dept, lead)\n" +
  "  where e.org_id = demo and e.department_id = md5('rimba-dept-' || v.dept)::uuid\n" +
  "    and e.id <> md5('rimba-emp-' || v.lead)::uuid;\n\n";

describe('the reporting-lines migration', () => {
  test('is one file, later than every file it copies a function from', () => {
    expect(FILE).not.toBe('missing');
    expect(files.filter((f) => f.endsWith('_people_reporting_lines.sql'))).toEqual([FILE]);
    // Not "the newest of all": the next slice's migration must not break this test. Unique and ordered versions
    // are migration-versions.test's job; "later than main's newest when applied" is the coordinator's (Task 6).
    for (const source of [DECIDE, LEAVE, CLAIM, OVERTIME, RESEED]) expect(FILE.slice(0, 14) > source.slice(0, 14), source).toBe(true);
  });

  test('adds the column, its index and no write grant', () => {
    const text = flat(sql);
    expect(text).toContain(
      'add column if not exists reports_to uuid null references public.hr_employees (id) on delete set null',
    );
    expect(text).toContain('create index if not exists hr_employees_reports_to_idx on public.hr_employees (org_id, reports_to)');
    expect(text).not.toMatch(/grant\s+(insert|update|all)[^;]*reports_to/);
    expect(text).not.toMatch(/grant\s+(insert|update|delete|all)\s+on\s+public\.hr_/);
  });

  test('guards the column with a trigger that returns before the lock for a blank manager', () => {
    const text = flat(sql);
    expect(text).toContain(
      'create trigger hr_employees_reports_to_guard before insert or update of reports_to, org_id on public.hr_employees for each row execute function private.hr_reports_to_guard()',
    );
    const body = flat(fn(sql, 'private.hr_reports_to_guard').body);
    const blank = body.indexOf('if new.reports_to is null then return new; end if;');
    const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('hr_reports_to:' || new.org_id::text, 0))");
    expect(blank).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(blank);
    expect(body).toContain('if steps > 50 then');
    expect([...body.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1])).toEqual(
      expect.arrayContaining(['EMP_BAD_MANAGER']),
    );
    expect(new Set([...body.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]))).toEqual(new Set(['EMP_BAD_MANAGER']));
  });

  test.each([
    ['private.is_manager_of', 'authenticated'],
    ['private.hr_manages_any', null],
    ['public.hr_my_team', 'authenticated'],
    ['public.hr_set_reports_to', 'authenticated'],
    ['public.hr_waiting_counts', 'authenticated'],
    ['public.hr_team_overtime', 'authenticated'],
    ['private.hr_notify_request_filed', null],
    ['private.hr_notify_request_decided', null],
    ['private.hr_reports_to_guard', null],
  ])('%s is a definer function on a fixed search path, executable by %s only', (name, role) => {
    const { header } = fn(sql, name);
    expect(header).toContain('security definer');
    expect(header).toContain('set search_path = public');
    const text = flat(sql);
    const bare = name.replace('.', '\\.');
    expect(text).toMatch(new RegExp(`revoke (all|execute) on function ${bare}\\([^)]*\\) from public, anon`));
    const granted = new RegExp(`grant execute on function ${bare}\\([^)]*\\) to authenticated`).test(text);
    expect(granted).toBe(role === 'authenticated');
    expect(text).not.toMatch(new RegExp(`grant execute on function ${bare}\\([^)]*\\) to (anon|public)`));
  });

  test('is_manager_of asks every one of the five conditions and looks one hop only', () => {
    const body = flat(fn(sql, 'private.is_manager_of').body);
    for (const part of [
      'private.mfa_ok()',
      'm.id = e.reports_to and m.org_id = e.org_id',
      'om.org_id = m.org_id and om.user_id = m.user_id',
      'm.user_id = auth.uid()',
      "m.status = 'active'",
      'not private.is_demo_org(e.org_id)',
    ]) expect(body, part).toContain(part);
    expect(body.match(/reports_to/g)).toHaveLength(1);
  });

  test('hr_set_reports_to answers a stranger as it answers a made-up id, before it says not allowed', () => {
    const body = flat(fn(sql, 'public.hr_set_reports_to').body);
    const found = body.indexOf("raise exception 'EMP_NOT_FOUND'");
    const allowed = body.indexOf("if private.is_demo_org(org) or not private.is_org_admin(org) then raise exception 'EMP_NOT_ALLOWED'");
    expect(found).toBeGreaterThan(-1);
    expect(allowed).toBeGreaterThan(found);
    expect(body).toContain('if org is null or not private.is_org_member(org) then');
    expect(body).toContain("pg_advisory_xact_lock(hashtextextended('hr_reports_to:' || org::text, 0))");
    expect(body).toContain('exception when foreign_key_violation then');
    expect(new Set([...body.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]))).toEqual(
      new Set(['EMP_NOT_ALLOWED', 'EMP_NOT_FOUND', 'EMP_BAD_MANAGER']),
    );
  });

  test.each([
    'hr_leave_requests', 'hr_leave_balances', 'hr_time_off_requests', 'hr_claims', 'hr_attendance_days',
  ])('%s keeps its read rule and gains the manager branch, and nothing else about it changes', (table) => {
    const text = flat(sql);
    expect(text).toContain(
      `alter policy ${table}_select on public.${table} using (private.is_org_admin(org_id) or private.is_own_employee(employee_id) ` +
        'or (private.is_demo_org(org_id) and private.is_org_member(org_id)) or private.is_manager_of(employee_id));',
    );
    expect(text).not.toContain(`drop policy ${table}_select`);
    expect(text).not.toMatch(new RegExp(`policy mfa_required on public\\.${table}\\b`));
  });

  test('no other table and no other policy is touched', () => {
    const touched = [...flat(sql).matchAll(/(?:alter|create|drop) policy (?:if exists )?(\w+) on (\w+\.\w+)/g)].map((m) => `${m[1]} on ${m[2]}`);
    expect(touched.sort()).toEqual(
      [
        'hr_attendance_days_select on public.hr_attendance_days',
        'hr_claims_select on public.hr_claims',
        'hr_leave_balances_select on public.hr_leave_balances',
        'hr_leave_requests_select on public.hr_leave_requests',
        'hr_receipts_select on storage.objects',
        'hr_time_off_requests_select on public.hr_time_off_requests',
      ].sort(),
    );
  });

  test('the overtime table is not opened to a manager: its read rule is not touched', () => {
    expect(flat(sql)).not.toMatch(/policy \w+ on public\.hr_overtime_records/);
  });

  test('a manager reads team overtime through a function that returns no pay', () => {
    const { header, body } = fn(sql, 'public.hr_team_overtime');
    expect(flat(header)).toBe(
      'create or replace function public.hr_team_overtime(p_org uuid) returns table (id uuid, org_id uuid, employee_id uuid, work_date date, hours numeric, ' +
        'day_kind text, rate_multiplier numeric, reason text, status text, requested_by uuid, decided_by uuid, decided_at timestamptz, decision_note text, ' +
        'created_at timestamptz) language sql security definer stable set search_path = public',
    );
    for (const word of ['cents', 'payslip', 'r.*', 'select *']) expect(header + body, word).not.toContain(word);
    expect(flat(body)).toContain(
      'from public.hr_overtime_records r where r.org_id = p_org and private.hr_manages_any(p_org) and private.is_manager_of(r.employee_id) order by r.created_at desc, r.id;',
    );
  });

  test('every function is defined once, so the definition the tests read is the one the database keeps', () => {
    const names = [...sql.matchAll(/create or replace function (\w+\.\w+)\(/g)].map((m) => m[1]);
    expect(names).toHaveLength(18);
    expect(new Set(names).size).toBe(names.length);
  });

  test('hr_set_reports_to says not found when the employee went between its look and its write', () => {
    expect(flat(fn(sql, 'public.hr_set_reports_to').body)).toContain(
      "update public.hr_employees set reports_to = p_manager where id = p_employee; if not found then raise exception 'EMP_NOT_FOUND'; end if; exception when foreign_key_violation then",
    );
  });

  test('the receipts rule gains the same branch for the claim a file belongs to', () => {
    expect(flat(sql)).toContain(
      "alter policy hr_receipts_select on storage.objects using ( bucket_id = 'hr-receipts' and ( (storage.foldername(name))[1] = (select auth.uid())::text " +
        'or exists ( select 1 from public.hr_claims c where c.receipt_path = storage.objects.name ' +
        'and (private.is_org_admin(c.org_id) or private.is_own_employee(c.employee_id) or private.is_manager_of(c.employee_id)) ) ) );',
    );
  });

  test.each(DECIDERS)('%s is its newest body with five edits and nothing else', (name, kind, prefix) => {
    const now = fn(sql, name);
    const before = fn(statements(DECIDE), name);
    expect(now.header).toBe(before.header);
    const undone = now.body
      .replace('  is_mgr boolean;\n', '')
      .replace('  is_mgr := private.is_manager_of(req.employee_id);\n', '')
      .replace('if not (is_admin or is_mgr or private.is_own_employee(req.employee_id)', 'if not (is_admin or private.is_own_employee(req.employee_id)')
      .replace(
        `if not (is_admin or is_mgr) then raise exception '${prefix}_NOT_ALLOWED'; end if;`,
        `if not is_admin then raise exception '${prefix}_NOT_ALLOWED'; end if;`,
      )
      .replace(`  perform private.hr_notify_request_decided(req.org_id, req.employee_id, '${kind}', outcome);\n`, '')
      // Overtime only: the reply carries the amount for an owner or admin, and null for a manager.
      .replace("'amount_cents', case when is_admin then req.amount_cents end);", "'amount_cents', req.amount_cents);")
      // Overtime only: a manager is told "no longer waiting" before the paid-run test, so never whether it was paid.
      .replace(`  if not is_admin and req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;\n`, '');
    expect(undone).toBe(before.body);
    expect(now.body.includes('case when is_admin then req.amount_cents end')).toBe(kind === 'overtime');
    const early = now.body.indexOf("if not is_admin and req.status <> 'pending' then raise exception 'PAY_NOT_PENDING'; end if;");
    expect(early > -1).toBe(kind === 'overtime');
    if (kind === 'overtime') {
      expect(early).toBeLessThan(now.body.indexOf("raise exception 'PAY_IN_PAID_RUN'"));
      expect(early).toBeLessThan(now.body.indexOf('from public.hr_payslips p'));
      expect(early).toBeGreaterThan(now.body.indexOf("raise exception 'PAY_BAD_INPUT'"));
    }
    expect(now.body).not.toBe(before.body);
    expect(now.body.match(/is_mgr/g)).toHaveLength(4);
    // The decision is written before anyone is told.
    expect(now.body.indexOf('hr_notify_request_decided')).toBeGreaterThan(now.body.indexOf('set status = outcome'));
  });

  test.each(FILERS)('%s is its newest body with one line added after its insert', (name, file, kind) => {
    const now = fn(sql, name);
    const before = fn(statements(file), name);
    expect(now.header).toBe(before.header);
    const line = `  perform private.hr_notify_request_filed(org, p_employee, '${kind}');\n`;
    expect(now.body.replace(line, '')).toBe(before.body);
    expect(now.body.indexOf(line)).toBeGreaterThan(now.body.indexOf('returning * into saved;'));
  });

  test('every replaced function repeats its revoke and its grant', () => {
    const text = flat(sql);
    for (const [name] of [...DECIDERS, ...FILERS]) {
      const bare = name.replace('.', '\\.');
      expect(text, name).toMatch(new RegExp(`revoke all on function ${bare}\\([^)]*\\) from public, anon; grant execute on function ${bare}\\([^)]*\\) to authenticated;`));
    }
  });

  test('the demo re-seed is its newest body with the reporting lines added, and is not run here', () => {
    const now = fn(sql, 'private.reseed_demo_people');
    const before = fn(statements(RESEED), 'private.reseed_demo_people');
    expect(now.header).toBe(before.header);
    expect(now.body.replace(REPORTING_LINES, '')).toBe(before.body);
    expect(now.body.indexOf(REPORTING_LINES)).toBeGreaterThan(now.body.indexOf('insert into public.hr_employees ('));
    expect(now.body.indexOf(REPORTING_LINES)).toBeLessThan(now.body.indexOf('insert into public.hr_employee_private ('));
    expect(flat(sql)).toContain('revoke all on function private.reseed_demo_people() from public, anon, authenticated;');
    expect(sql).not.toMatch(/select\s+private\.reseed_demo_people\(\)/);
  });

  test('a notification names the kind and the person, and nothing about the request', () => {
    for (const name of ['private.hr_notify_request_filed', 'private.hr_notify_request_decided']) {
      const body = fn(sql, name).body;
      for (const word of ['amount', 'reason', 'note', 'days', 'hours', 'category', 'description', '_date', 'cents']) {
        expect(body, `${name}: ${word}`).not.toContain(word);
      }
      expect(flat(body)).toContain('exception when others then');
      expect(flat(body)).toMatch(/perform private\.deliver_notification\([^;]*, null, href\);/);
    }
  });

  test('holds no regular expression at all, so no repetition bound to check', () => {
    expect(sql).not.toMatch(/\s~\*?\s|regexp_|similar to/i);
  });
});
