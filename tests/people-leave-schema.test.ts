import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const WRITES = '20261018090000_people_leave_writes.sql';
const CRON = '20261018090100_people_leave_cron.sql';

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const writes = () => statements(WRITES);
const cron = () => statements(CRON);

/** The eight functions the app calls, with the argument types their grants name. */
const FUNCTIONS: { name: string; args: string }[] = [
  { name: 'hr_leave_preview', args: 'uuid, text, date, date, boolean' },
  { name: 'hr_apply_leave', args: 'uuid, text, date, date, boolean, text' },
  { name: 'hr_apply_time_off', args: 'uuid, date, time, time, text' },
  { name: 'hr_cancel_leave', args: 'uuid' },
  { name: 'hr_cancel_time_off', args: 'uuid' },
  { name: 'hr_decide_leave', args: 'uuid, boolean, text' },
  { name: 'hr_decide_time_off', args: 'uuid, boolean, text' },
  { name: 'hr_set_leave_entitlement', args: 'uuid, text, int, numeric' },
];

const CODES = [
  'LEAVE_NOT_ALLOWED',
  'LEAVE_OVERLAP',
  'LEAVE_NO_WORKING_DAY',
  'LEAVE_NOT_PENDING',
  'LEAVE_ALREADY_STARTED',
  'LEAVE_INACTIVE_EMPLOYEE',
  'LEAVE_NOT_FOUND',
  'LEAVE_BAD_INPUT',
];

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

describe('Lekiu leave migration', () => {
  test('sorts after the migrations it builds on, the cron file second', () => {
    // 20261017090000 was the latest file when this was written.
    expect(WRITES > '20261017090000_hire_application_form_settings.sql').toBe(true);
    expect(CRON > WRITES).toBe(true);
    const files = readdirSync(DIR);
    expect(files).toContain(WRITES);
    expect(files).toContain(CRON);
    expect(files.filter((f) => f.startsWith('20261018090000') || f.startsWith('20261018090100'))).toHaveLength(2);
  });

  test('adds exactly the columns in the spec', () => {
    const text = writes();
    for (const line of [
      'add column half_day boolean not null default false,',
      'add column decision_note text check (decision_note is null or char_length(decision_note) <= 500),',
      'add column requested_by uuid references auth.users(id) on delete set null,',
      'add constraint hr_leave_requests_half_day_single_date check (not half_day or start_date = end_date);',
      'add column decision_note text,',
      'add column requested_by uuid references auth.users(id) on delete set null;',
      'add column default_medical_leave_days numeric(4,1) not null default 14 check (default_medical_leave_days >= 0),',
      'add column default_emergency_leave_days numeric(4,1) not null default 3 check (default_emergency_leave_days >= 0);',
    ]) {
      expect(text).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(7);
    expect(text.match(/alter table public\.(\w+)/g)).toEqual([
      'alter table public.hr_leave_requests',
      'alter table public.hr_time_off_requests',
      'alter table public.hr_settings',
    ]);
    expect(text).not.toMatch(/drop (table|column|policy|function)/);
  });

  test('creates the eight functions, and no other in the public schema', () => {
    const made = allFunctions(writes()).filter((name) => name.startsWith('public.'));
    expect(made).toEqual(FUNCTIONS.map((f) => `public.${f.name}`));
  });

  test.each(FUNCTIONS)('$name runs as the owner on a fixed search path and returns jsonb', ({ name }) => {
    const { header } = fn(writes(), `public.${name}`);
    expect(header).toContain('returns jsonb language plpgsql');
    expect(header).toContain('security definer');
    expect(header).toContain('set search_path = public');
  });

  test.each(FUNCTIONS)('$name can be called by signed-in users only', ({ name, args }) => {
    const text = writes();
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test('execute is granted on those eight and on nothing else', () => {
    const grants = writes().match(/grant [^;]*;/g) ?? [];
    expect(grants).toEqual(
      FUNCTIONS.map((f) => `grant execute on function public.${f.name}(${f.args}) to authenticated;`),
    );
  });

  test('the leave tables get no write grant and no new policy', () => {
    for (const text of [writes(), cron()]) {
      expect(text).not.toMatch(/grant\s+(all|insert|update|delete|truncate)/i);
      expect(text).not.toMatch(/create policy/i);
      expect(text).not.toMatch(/disable row level security/i);
    }
  });

  test('no function takes a workspace from its caller', () => {
    const text = writes();
    for (const { name } of FUNCTIONS) {
      const { header } = fn(text, `public.${name}`);
      expect(header, name).not.toMatch(/org/i);
    }
  });

  test('every helper is private, on a fixed search path, and closed to the API roles', () => {
    const text = writes();
    const helpers = allFunctions(text).filter((name) => name.startsWith('private.'));
    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      const { header } = fn(text, helper);
      expect(header, helper).toContain('set search_path = public');
      expect(text, helper).toMatch(
        new RegExp(`revoke all on function ${helper.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;`),
      );
    }
    for (const helper of [
      'private.hr_leave_days',
      'private.hr_leave_request_days_in_year',
      'private.hr_ensure_leave_balances',
      'private.hr_ensure_leave_balances_all',
      'private.hr_recount_leave_used',
    ]) {
      expect(helpers).toContain(helper);
    }
  });

  test('a refusal is one of the eight codes and carries nothing else', () => {
    const text = writes();
    const raised = [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
    expect(raised.length).toBeGreaterThan(20);
    for (const message of raised) expect(message).toMatch(/^'LEAVE_[A-Z_]+'$/);
    expect([...new Set(raised.map((m) => m.slice(1, -1)))].sort()).toEqual([...CODES].sort());
    expect(text).not.toMatch(/raise (notice|warning|log|info)/i);
  });

  test.each(['hr_cancel_leave', 'hr_cancel_time_off', 'hr_decide_leave', 'hr_decide_time_off'])(
    '%s locks the request before it reads the status',
    (name) => {
      const { body } = fn(writes(), `public.${name}`);
      const lock = body.search(/where r\.id = p_request for update;/);
      const status = body.indexOf('req.status');
      expect(lock, name).toBeGreaterThan(-1);
      expect(status, name).toBeGreaterThan(lock);
    },
  );

  test.each(['hr_decide_leave', 'hr_decide_time_off'])('%s is for owners and admins only', (name) => {
    const { body } = fn(writes(), `public.${name}`);
    expect(body).toContain('is_admin := private.is_org_admin(req.org_id);');
    const gate = body.indexOf("if not is_admin then raise exception 'LEAVE_NOT_ALLOWED'; end if;");
    expect(gate, name).toBeGreaterThan(-1);
    // Nothing is changed, and no status is revealed, before that gate.
    expect(body.indexOf('update public.'), name).toBeGreaterThan(gate);
    expect(body.indexOf('req.status'), name).toBeGreaterThan(gate);
    expect(body).not.toContain('is_org_writer');
  });

  test('hr_set_leave_entitlement is for owners and admins only', () => {
    const { body } = fn(writes(), 'public.hr_set_leave_entitlement');
    const gate = body.indexOf("if not private.is_org_admin(org) then raise exception 'LEAVE_NOT_ALLOWED'; end if;");
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf('insert into'), 'writes after the gate').toBeGreaterThan(gate);
    expect(body).not.toContain('is_own_employee');
    expect(body).not.toContain('is_org_member');
    expect(body).not.toContain('is_org_writer');
  });

  test.each(['hr_cancel_leave', 'hr_cancel_time_off', 'hr_decide_leave', 'hr_decide_time_off'])(
    '%s tells someone with no business with the request only that it was not found',
    (name) => {
      const { body } = fn(writes(), `public.${name}`);
      expect(body).toContain(
        'if not (is_admin or private.is_own_employee(req.employee_id)\n'
          + '          or (is_demo and private.is_org_member(req.org_id))) then\n'
          + "    raise exception 'LEAVE_NOT_FOUND';",
      );
      expect(body.match(/raise exception 'LEAVE_NOT_FOUND'/g)).toHaveLength(2);
      // That answer comes before any other refusal that depends on the request.
      const hidden = body.lastIndexOf("raise exception 'LEAVE_NOT_FOUND'");
      for (const later of ["if is_demo then raise exception 'LEAVE_NOT_ALLOWED'", 'req.status', 'LEAVE_BAD_INPUT']) {
        const at = body.indexOf(later);
        if (at > -1) expect(at, `${name}: ${later}`).toBeGreaterThan(hidden);
      }
    },
  );

  test('acting for an employee means an admin of their workspace or the member linked to them', () => {
    const text = writes();
    const { body } = fn(text, 'private.hr_leave_may_act');
    expect(body).toContain('select e.org_id into org from public.hr_employees e where e.id = p_employee;');
    expect(body).toContain('if not (private.is_org_admin(org) or private.is_own_employee(p_employee)) then');
    for (const name of ['hr_leave_preview', 'hr_apply_leave', 'hr_apply_time_off']) {
      expect(fn(text, `public.${name}`).body, name).toContain('org := private.hr_leave_may_act(p_employee);');
    }
    for (const name of ['hr_cancel_leave', 'hr_cancel_time_off']) {
      const body = fn(text, `public.${name}`).body;
      expect(body, name).toContain('is_admin := private.is_org_admin(req.org_id);');
      expect(body, name).toContain('if not (is_admin or private.is_own_employee(req.employee_id)');
      expect(body, name).toContain('if not is_admin then');
    }
  });

  test('every function refuses in the demo workspace', () => {
    const text = writes();
    expect(fn(text, 'private.hr_leave_may_act').body).toContain(
      "if private.is_demo_org(org) then raise exception 'LEAVE_NOT_ALLOWED'; end if;",
    );
    for (const name of ['hr_cancel_leave', 'hr_cancel_time_off', 'hr_decide_leave', 'hr_decide_time_off']) {
      const body = fn(text, `public.${name}`).body;
      expect(body, name).toContain('is_demo := private.is_demo_org(req.org_id);');
      const refusal = body.indexOf("if is_demo then raise exception 'LEAVE_NOT_ALLOWED'; end if;");
      expect(refusal, name).toBeGreaterThan(-1);
      expect(body.indexOf('update public.'), name).toBeGreaterThan(refusal);
    }
    expect(fn(text, 'public.hr_set_leave_entitlement').body).toContain(
      "if private.is_demo_org(org) then raise exception 'LEAVE_NOT_ALLOWED'; end if;",
    );
  });

  test('the preview cannot write', () => {
    const { header, body } = fn(writes(), 'public.hr_leave_preview');
    expect(header).toContain('language plpgsql stable security definer');
    expect(body).not.toMatch(/\b(insert into|update public|delete from)\b/);
    expect(body).not.toContain('hr_ensure_leave_balances');
  });

  test('used days are recounted from approved leave, never incremented', () => {
    const text = writes();
    expect(text).not.toMatch(/used_days\s*=\s*(b\.)?used_days\s*[+-]/);
    const { body } = fn(text, 'private.hr_recount_leave_used');
    expect(body.match(/update public\.hr_leave_balances/g)).toHaveLength(1);
    expect(body).toContain("r.status = 'approved'");
    // From each request's own stored days, not a fresh count of its dates.
    expect(body).toContain(
      'private.hr_leave_request_days_in_year(r.org_id, r.start_date, r.end_date, r.half_day, r.days, b.year)',
    );
    expect(body).not.toContain('private.hr_leave_days(');
    expect(fn(text, 'public.hr_decide_leave').body).toContain('perform private.hr_recount_leave_used(');
    expect(fn(text, 'public.hr_cancel_leave').body).toContain('perform private.hr_recount_leave_used(');
  });

  test('a saved request inside one year costs exactly its stored days', () => {
    const text = writes();
    const { body } = fn(text, 'private.hr_leave_request_days_in_year');
    expect(body).toContain('if first_year = last_year then return p_days; end if;');
    // Across New Year the parts add up to the stored days: the last year takes what is left.
    expect(body).toContain('left_over numeric := p_days;');
    expect(body).toContain('part := left_over;');
    expect(body).toContain('least(private.hr_leave_days_in_year(p_org, p_start, p_end, p_half_day, y), left_over)');
    expect(fn(text, 'public.hr_leave_preview').body).toContain(
      'private.hr_leave_request_days_in_year(r.org_id, r.start_date, r.end_date, r.half_day, r.days, y)',
    );
  });

  test('applying and setting an entitlement make balance rows for that employee only', () => {
    const text = writes();
    expect(fn(text, 'public.hr_apply_leave').body).toContain('perform private.hr_ensure_leave_balances(org, y, p_employee);');
    expect(fn(text, 'public.hr_set_leave_entitlement').body).toContain(
      'perform private.hr_ensure_leave_balances(org, p_year, p_employee);',
    );
    for (const { name } of FUNCTIONS) {
      const { body } = fn(text, `public.${name}`);
      expect(body, name).not.toMatch(/hr_ensure_leave_balances\([^,)]*,[^,)]*\)/);
      expect(body, name).not.toContain('hr_ensure_leave_balances_all');
    }
  });

  test('today is today in Malaysia', () => {
    const text = writes();
    for (const name of ['hr_cancel_leave', 'hr_cancel_time_off']) {
      expect(fn(text, `public.${name}`).body, name).toContain(
        "today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;",
      );
    }
    expect(text).not.toContain('current_date');
  });

  test('a new employee gets balances from a trigger that runs as the owner and skips the demo', () => {
    const text = writes();
    expect(fn(text, 'private.hr_employee_leave_balances').header).toContain('security definer');
    expect(text).toContain(
      'create trigger hr_employees_leave_balances after insert on public.hr_employees\n'
        + '  for each row execute function private.hr_employee_leave_balances();',
    );
    const ensure = fn(text, 'private.hr_ensure_leave_balances').body;
    expect(ensure).toContain('private.is_demo_org(p_org)');
    expect(ensure).toContain('on conflict (employee_id, leave_type, year) do nothing');
    expect(ensure).toContain("e.status = 'active'");
    expect(fn(text, 'private.hr_ensure_leave_balances_all').body).toContain('where not private.is_demo_org(e.org_id)');
    expect(text.trimEnd().endsWith('select private.hr_ensure_leave_balances_all();')).toBe(true);
  });

  test('the yearly job is the only thing scheduled, in its own file', () => {
    const text = cron();
    expect(writes()).not.toContain('cron.');
    expect(text).toContain('create extension if not exists pg_cron;');
    expect(text.match(/cron\.schedule\(/g)).toHaveLength(1);
    expect(text).toContain(
      "select cron.schedule('ensure-leave-balances', '0 16 31 12 *', $$select private.hr_ensure_leave_balances_all()$$);",
    );
    const { body } = fn(writes(), 'private.hr_ensure_leave_balances_all');
    expect(body).toContain("extract(year from (now() at time zone 'Asia/Kuala_Lumpur'))::int");
  });
});
