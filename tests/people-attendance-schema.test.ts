import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const WRITES = '20261024090000_people_attendance_writes.sql';
const CRON = '20261024090100_people_attendance_cron.sql';

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const writes = () => statements(WRITES);

/** The six functions the app calls, with the argument types their grants name. */
const FUNCTIONS: { name: string; args: string }[] = [
  { name: 'hr_clock_in', args: 'uuid' },
  { name: 'hr_clock_out', args: 'uuid' },
  { name: 'hr_correct_attendance', args: 'uuid, date, text, time, time, text' },
  { name: 'hr_save_holiday', args: 'uuid, uuid, text, date' },
  { name: 'hr_delete_holiday', args: 'uuid' },
  { name: 'hr_save_attendance_settings', args: 'uuid, jsonb, time, int' },
];
const CLOCK = ['hr_clock_in', 'hr_clock_out'];
const HELPERS = [
  'private.hr_is_working_day',
  'private.hr_on_approved_leave',
  'private.hr_attendance_status',
  'private.hr_attendance_may_clock',
  'private.hr_attendance_admin_only',
  'private.hr_attendance_day_json',
  'private.hr_attendance_close',
];
const CODES = [
  'ATT_NOT_ALLOWED',
  'ATT_NOT_FOUND',
  'ATT_ALREADY_IN',
  'ATT_NOT_IN',
  'ATT_ALREADY_OUT',
  'ATT_NOT_WORKING_DAY',
  'ATT_ON_LEAVE',
  'ATT_INACTIVE_EMPLOYEE',
  'ATT_HOLIDAY_EXISTS',
  'ATT_BAD_INPUT',
];
const EMPLOYEE_LOCK = /from public\.hr_employees e\s+where e\.id = p_employee for no key update;/;

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

/** Where the first statement that changes a row begins, or -1. */
function firstWrite(body: string): number {
  const at = ['insert into public.', 'update public.', 'delete from public.']
    .map((s) => body.indexOf(s))
    .filter((i) => i > -1);
  return at.length ? Math.min(...at) : -1;
}

describe('Lekiu attendance migrations', () => {
  test('sort after the migrations they build on, each alone on its timestamp', () => {
    // 20261021090000 was the latest file when this was written.
    expect(WRITES > '20261021090000_hire_cv_sweep_and_cap.sql').toBe(true);
    expect(CRON > WRITES).toBe(true);
    const files = readdirSync(DIR);
    expect(files.filter((f) => f.startsWith('20261024090000'))).toEqual([WRITES]);
    expect(files.filter((f) => f.startsWith('20261024090100'))).toEqual([CRON]);
  });

  test('adds exactly the columns in the spec', () => {
    const text = writes();
    for (const line of [
      // hr_settings
      "add column work_start_time time not null default '09:00',",
      'add column late_grace_minutes int not null default 15 check (late_grace_minutes between 0 and 240);',
      // hr_attendance_days
      'add column corrected_by uuid references auth.users(id) on delete set null,',
      'add column corrected_at timestamptz,',
      'add column correction_note text check (correction_note is null or char_length(correction_note) <= 500);',
    ]) {
      expect(text).toContain(line);
    }
    expect(text.match(/add column/g)).toHaveLength(5);
    // The demo seed is not changed: every new column is nullable or has a default.
    for (const column of text.match(/add column[^,;]*/g) ?? []) {
      expect(/\bnot null\b/.test(column), column).toBe(/\bdefault\b/.test(column));
    }
    expect([...new Set(text.match(/alter table public\.(\w+)/g))]).toEqual([
      'alter table public.hr_settings',
      'alter table public.hr_attendance_days',
    ]);
    expect(text).not.toMatch(/drop (table|column|policy|function|index|constraint)/);
    expect(text).not.toMatch(/alter column/);
  });

  test('the epoch is one row, filled once, in a table nobody may touch', () => {
    const text = writes();
    expect(text).toContain(
      'create table private.hr_attendance_epoch (\n'
        + '  id boolean primary key default true check (id),\n'
        + '  started_on date not null\n'
        + ');',
    );
    expect(text).toContain('alter table private.hr_attendance_epoch enable row level security;');
    expect(text).toContain('revoke all on private.hr_attendance_epoch from public, anon, authenticated, service_role;');
    // Filled with today in Malaysia; a second apply cannot move it.
    expect(text).toContain(
      'insert into private.hr_attendance_epoch (id, started_on)\n'
        + "values (true, (now() at time zone 'Asia/Kuala_Lumpur')::date)\n"
        + 'on conflict (id) do nothing;',
    );
    expect(text.match(/(insert into|update|delete from) private\.hr_attendance_epoch/g)).toHaveLength(1);
    expect(text.match(/create table/g)).toHaveLength(3);
  });

  test('the day a workspace first used attendance is kept in a table nobody may touch', () => {
    const text = writes();
    expect(text).toContain(
      'create table private.hr_attendance_started (\n'
        + '  org_id uuid primary key references public.orgs(id) on delete cascade,\n'
        + '  started_on date not null\n'
        + ');',
    );
    expect(text).toContain('alter table private.hr_attendance_started enable row level security;');
    expect(text).toContain('revoke all on private.hr_attendance_started from public, anon, authenticated, service_role;');
    // Written by clock-in and by a correction, with today in Malaysia, once: a later use never moves it.
    const first =
      'insert into private.hr_attendance_started (org_id, started_on) values (org, today)\n'
      + '  on conflict (org_id) do nothing;';
    for (const name of ['hr_clock_in', 'hr_correct_attendance']) {
      const { body } = fn(text, `public.${name}`);
      const at = body.indexOf(first);
      expect(at, name).toBeGreaterThan(-1);
      // After every refusal, so a refused call starts nothing.
      expect(at, name).toBeGreaterThan(body.lastIndexOf('raise exception'));
      expect(at, name).toBeGreaterThan(body.search(EMPLOYEE_LOCK));
    }
    expect(text.match(/insert into private\.hr_attendance_started/g)).toHaveLength(2);
    expect(text).not.toMatch(/(update|delete from|truncate) private\.hr_attendance_started/);
    expect(text).not.toMatch(/on conflict \(org_id\) do update[^;]*started_on/);
  });

  test('creates the six functions, and no other in the public schema', () => {
    const made = allFunctions(writes()).filter((name) => name.startsWith('public.'));
    expect(made.sort()).toEqual(FUNCTIONS.map((f) => `public.${f.name}`).sort());
  });

  test('the day the close first saw an employee linked and active is kept in a table nobody may touch', () => {
    const text = writes();
    expect(text).toContain(
      'create table private.hr_attendance_covered (\n'
        + '  employee_id uuid primary key references public.hr_employees(id) on delete cascade,\n'
        + '  covered_from date not null\n'
        + ');',
    );
    expect(text).toContain('alter table private.hr_attendance_covered enable row level security;');
    expect(text).toContain('revoke all on private.hr_attendance_covered from public, anon, authenticated, service_role;');
    // Written by the nightly close and by nothing else.
    for (const name of allFunctions(text).filter((f) => f !== 'private.hr_attendance_close')) {
      expect(fn(text, name).body, name).not.toContain('hr_attendance_covered');
    }
    expect(text.match(/hr_attendance_covered/g)).toHaveLength(
      3 + (fn(text, 'private.hr_attendance_close').body.match(/hr_attendance_covered/g) ?? []).length,
    );
    const { body } = fn(text, 'private.hr_attendance_close');
    // 1. Whoever is no longer linked and active is forgotten, so coming back starts them over.
    const forget = body.indexOf(
      'delete from private.hr_attendance_covered c\n'
        + '    using public.hr_employees e\n'
        + '    where e.id = c.employee_id and e.org_id = o.org_id\n'
        + "      and (e.status is distinct from 'active' or e.user_id is null);",
    );
    // 2. Days are written only for employees already noted, from the day they were.
    const close = body.indexOf('insert into public.hr_attendance_days');
    expect(body).toContain('join private.hr_attendance_covered c on c.employee_id = e.id');
    expect(body).not.toMatch(/left join/);
    // 3. Only then are tonight's newly eligible employees noted, from today, once.
    const note = body.indexOf(
      'insert into private.hr_attendance_covered (employee_id, covered_from)\n'
        + '    select e.id, today from public.hr_employees e\n'
        + "    where e.org_id = o.org_id and e.status = 'active' and e.user_id is not null\n"
        + '    order by e.id\n'
        + '    on conflict (employee_id) do nothing;',
    );
    expect(forget).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(forget);
    expect(note).toBeGreaterThan(close);
    expect(body).not.toMatch(/update private\.hr_attendance_covered/);
  });

  test.each(FUNCTIONS)('$name runs as the owner on a fixed search path and returns jsonb', ({ name }) => {
    const { header } = fn(writes(), `public.${name}`);
    expect(header).toContain('returns jsonb language plpgsql security definer set search_path = public');
  });

  test.each(FUNCTIONS)('$name can be called by signed-in users only', ({ name, args }) => {
    const text = writes();
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test('execute is granted on those six and on nothing else', () => {
    const grants = (writes().match(/grant [^;]*;/g) ?? []).sort();
    expect(grants).toEqual(
      FUNCTIONS.map((f) => `grant execute on function public.${f.name}(${f.args}) to authenticated;`).sort(),
    );
  });

  test('the three tables get no write grant, no new policy, and keep row level security', () => {
    const text = writes();
    expect(text).not.toMatch(/grant\s+(all|select|insert|update|delete|truncate)/i);
    expect(text).not.toMatch(/create policy/i);
    expect(text).not.toMatch(/alter table public\.\w+ (disable|enable) row level security/i);
    expect(text).not.toMatch(/disable row level security/i);
    expect(statements(CRON)).not.toMatch(/\b(grant|policy|alter table)\b/i);
  });

  test.each(CLOCK)('%s takes an employee and nothing else: no date, no time', (name) => {
    const text = writes();
    const { header, body } = fn(text, `public.${name}`);
    expect(header).toContain(`create or replace function public.${name}(p_employee uuid)\n`);
    // The only argument the body can read is the employee.
    expect(body.match(/\bp_\w+/g)?.every((arg) => arg === 'p_employee')).toBe(true);
    // No second function of that name, with more arguments.
    expect(text.match(new RegExp(`function public\\.${name}\\(`, 'g'))).toHaveLength(3);
  });

  test('the database stamps the clock, and today is today in Malaysia', () => {
    const text = writes();
    const clockIn = fn(text, 'public.hr_clock_in').body;
    expect(clockIn).toContain('values (org, p_employee, today, now(), private.hr_attendance_status(org, now()))');
    expect(fn(text, 'public.hr_clock_out').body).toContain('set clock_out = now()');
    for (const name of ['public.hr_clock_in', 'public.hr_clock_out', 'public.hr_correct_attendance', 'private.hr_attendance_close']) {
      expect(fn(text, name).body, name).toContain("today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;");
    }
    expect(text).not.toMatch(/current_date|current_time|localtime|clock_timestamp|statement_timestamp|timeofday/i);
    // A correction's times are read as Malaysia time on the day corrected.
    const correct = fn(text, 'public.hr_correct_attendance').body;
    expect(correct).toContain("(p_work_date + p_clock_in) at time zone 'Asia/Kuala_Lumpur'");
    expect(correct).toContain("(p_work_date + p_clock_out) at time zone 'Asia/Kuala_Lumpur'");
    // Neither time may be 24:00, nor a moment that has not happened yet.
    expect(correct).toContain("p_clock_in >= time '24:00' or p_clock_out >= time '24:00'");
    expect(correct).toContain("if time_in > now() or time_out > now() then raise exception 'ATT_BAD_INPUT'; end if;");
  });

  test.each([...CLOCK, 'hr_correct_attendance'])(
    '%s takes the employee row, so one employee\'s changes take turns',
    (name) => {
      const { body } = fn(writes(), `public.${name}`);
      const lock = body.search(EMPLOYEE_LOCK);
      expect(lock, name).toBeGreaterThan(-1);
      expect(firstWrite(body), name).toBeGreaterThan(lock);
      // The day is read only once the lock is held.
      const read = body.indexOf('from public.hr_attendance_days a');
      if (read > -1) expect(read, name).toBeGreaterThan(lock);
    },
  );

  test('only the member linked to an employee clocks them in or out', () => {
    const text = writes();
    const gate = fn(text, 'private.hr_attendance_may_clock').body;
    expect(gate).toContain("if not private.is_own_employee(p_employee) then raise exception 'ATT_NOT_ALLOWED'; end if;");
    expect(gate).toContain("if org is null or private.is_demo_org(org) then raise exception 'ATT_NOT_ALLOWED'; end if;");
    // Being an owner or admin opens nothing here.
    expect(gate).not.toMatch(/is_org_(admin|writer|member)/);
    for (const name of CLOCK) {
      const body = fn(text, `public.${name}`).body;
      const call = body.indexOf('org := private.hr_attendance_may_clock(p_employee);');
      expect(call, name).toBeGreaterThan(-1);
      // It is the first thing each of them does.
      expect(body.slice(body.indexOf('begin'), call).trim(), name).toBe('begin');
      expect(body, name).not.toMatch(/is_org_(admin|writer|member)/);
    }
  });

  test('a second clock-in is refused, and a clock-in replaces only a day with none', () => {
    const { body } = fn(writes(), 'public.hr_clock_in');
    const order = [
      "if employee_status is distinct from 'active' then raise exception 'ATT_INACTIVE_EMPLOYEE'; end if;",
      "if not private.hr_is_working_day(org, today) then raise exception 'ATT_NOT_WORKING_DAY'; end if;",
      "if private.hr_on_approved_leave(p_employee, today, false) then raise exception 'ATT_ON_LEAVE'; end if;",
      "if saved.clock_in is not null then raise exception 'ATT_ALREADY_IN'; end if;",
      'insert into public.hr_attendance_days',
    ].map((line) => body.indexOf(line));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Replacing an early correction clears that it was one.
    expect(body).toContain('corrected_by = null, corrected_at = null, correction_note = null');
  });

  test('clocking out needs a clock-in that has happened and no clock-out yet', () => {
    const { body } = fn(writes(), 'public.hr_clock_out');
    // A clock-in stamped after this clock-out began (two taps that crossed) is no clock-in yet.
    const notIn = body.indexOf("if saved.clock_in is null or saved.clock_in > now() then raise exception 'ATT_NOT_IN'; end if;");
    const already = body.indexOf("if saved.clock_out is not null then raise exception 'ATT_ALREADY_OUT'; end if;");
    expect(notIn).toBeGreaterThan(-1);
    expect(already).toBeGreaterThan(notIn);
    expect(firstWrite(body)).toBeGreaterThan(already);
    expect(body).toContain('where a.employee_id = p_employee and a.work_date = today;');
  });

  test.each(['hr_correct_attendance', 'hr_save_holiday', 'hr_save_attendance_settings'])(
    '%s is for owners and admins only, and never in the demo',
    (name) => {
      const text = writes();
      const { body } = fn(text, `public.${name}`);
      const gate = body.search(/perform private\.hr_attendance_admin_only\((org|p_org)\);/);
      expect(gate, name).toBeGreaterThan(-1);
      expect(firstWrite(body), name).toBeGreaterThan(gate);
      // No other refusal comes before it, so nothing is learnt by someone with no right to ask.
      for (const code of ['ATT_BAD_INPUT', 'ATT_NOT_FOUND', 'ATT_HOLIDAY_EXISTS']) {
        const at = body.indexOf(code);
        if (at > -1) expect(at, `${name}: ${code}`).toBeGreaterThan(gate);
      }
      expect(body).not.toContain('is_org_writer');
      expect(body).not.toContain('is_own_employee');
      const only = fn(text, 'private.hr_attendance_admin_only').body;
      expect(only).toContain("if private.is_demo_org(p_org) then raise exception 'ATT_NOT_ALLOWED'; end if;");
      expect(only).toContain("if not private.is_org_admin(p_org) then raise exception 'ATT_NOT_ALLOWED'; end if;");
      expect(only).not.toContain('is_org_writer');
    },
  );

  test('a correction takes its workspace from the employee, never from the caller', () => {
    const { header, body } = fn(writes(), 'public.hr_correct_attendance');
    expect(header).not.toMatch(/org/i);
    expect(body).toContain('select e.org_id into org from public.hr_employees e where e.id = p_employee;');
    expect(body).toContain("if org is null then raise exception 'ATT_NOT_ALLOWED'; end if;");
    expect(body).toContain('corrected_by = auth.uid()');
    for (const name of [...CLOCK, 'hr_delete_holiday']) {
      expect(fn(writes(), `public.${name}`).header, name).not.toMatch(/org/i);
    }
  });

  test('removing a holiday tells anyone but an owner or admin only that it was not found', () => {
    const { body } = fn(writes(), 'public.hr_delete_holiday');
    const lock = body.indexOf('from public.hr_public_holidays h where h.id = p_id for update;');
    const hidden = body.indexOf("if not private.is_org_admin(holiday.org_id) then raise exception 'ATT_NOT_FOUND'; end if;");
    const demo = body.indexOf("if private.is_demo_org(holiday.org_id) then raise exception 'ATT_NOT_ALLOWED'; end if;");
    expect(lock).toBeGreaterThan(-1);
    expect(hidden).toBeGreaterThan(lock);
    expect(demo).toBeGreaterThan(hidden);
    expect(firstWrite(body)).toBeGreaterThan(demo);
  });

  test('one holiday per date per workspace, checked while the workspace is held', () => {
    const { body } = fn(writes(), 'public.hr_save_holiday');
    const lock = body.indexOf('perform 1 from public.orgs o where o.id = p_org for no key update;');
    const taken = body.indexOf("raise exception 'ATT_HOLIDAY_EXISTS'");
    expect(lock).toBeGreaterThan(-1);
    expect(taken).toBeGreaterThan(lock);
    expect(firstWrite(body)).toBeGreaterThan(taken);
    expect(body).toContain('where h.org_id = p_org and h.holiday_date = p_holiday_date and h.id is distinct from p_id');
    // An edit that finds its holiday gone (removed in the meantime) says so.
    const edit = body.indexOf('update public.hr_public_holidays h');
    expect(body.indexOf("if not found then raise exception 'ATT_NOT_FOUND'; end if;")).toBeGreaterThan(edit);
    // An edit must be of a holiday of that workspace.
    expect(body).toContain('where h.id = p_id and h.org_id = p_org');
    // Editing changes the name and the date; scope and state stay as they are.
    expect(body).toContain('set name = title, holiday_date = p_holiday_date');
    expect(body).toContain('insert into public.hr_public_holidays (org_id, name, holiday_date)');
    expect(body).not.toMatch(/\b(scope|state)\b/);
  });

  test('saving the settings touches the three columns and when the row was updated, nothing else', () => {
    const { body } = fn(writes(), 'public.hr_save_attendance_settings');
    expect(body).toContain(
      'insert into public.hr_settings (org_id, work_week, work_start_time, late_grace_minutes)\n'
        + '  values (p_org, week, p_work_start_time, p_late_grace_minutes)\n'
        + '  on conflict (org_id) do update\n'
        + '    set work_week = excluded.work_week, work_start_time = excluded.work_start_time,\n'
        + '        late_grace_minutes = excluded.late_grace_minutes, updated_at = now()\n'
        + '  returning * into saved;',
    );
    expect(body).not.toMatch(/overtime_rates|notifications|default_\w+_leave_days|created_at/);
    expect(body).toContain('p_late_grace_minutes not between 0 and 240');
  });

  test('the helpers are private, on a fixed search path, and closed to the API roles', () => {
    const text = writes();
    const helpers = allFunctions(text).filter((name) => name.startsWith('private.'));
    expect(helpers).toEqual(HELPERS);
    for (const helper of helpers) {
      const { header } = fn(text, helper);
      expect(header, helper).toContain('set search_path = public');
      expect(text, helper).toMatch(
        new RegExp(`revoke all on function ${helper.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated(, service_role)?;`),
      );
    }
    expect(text).toContain('revoke all on function private.hr_attendance_close() from public, anon, authenticated, service_role;');
  });

  test('a refusal is one of the ten codes and carries nothing else', () => {
    const text = writes();
    const raised = [...text.matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
    expect(raised.length).toBeGreaterThan(20);
    expect(text.match(/raise /g)).toHaveLength(raised.length);
    for (const message of raised) expect(message).toMatch(/^'ATT_[A-Z_]+'$/);
    expect([...new Set(raised.map((m) => m.slice(1, -1)))].sort()).toEqual([...CODES].sort());
  });

  test('a working day, and approved leave, are each worked out in one place', () => {
    const text = writes();
    // No second copy of either rule: the weekday arithmetic, the holiday lookup by date, the leave lookup.
    expect(text.match(/isodow/g)).toHaveLength(1);
    expect(text.match(/from public\.hr_leave_requests/g)).toHaveLength(1);
    const workingDay = fn(text, 'private.hr_is_working_day').body;
    expect(workingDay).toContain('isodow');
    expect(workingDay).toContain('from public.hr_public_holidays h');
    // A work week that is not a list of days falls back to Monday to Friday.
    expect(workingDay).toContain("jsonb_typeof(week) <> 'array'");
    expect(workingDay.match(/\["mon","tue","wed","thu","fri"\]/g)).toHaveLength(1);
    const leave = fn(text, 'private.hr_on_approved_leave').body;
    expect(leave).toContain("r.employee_id = p_employee and r.status = 'approved'");
    expect(leave).toContain('and (p_half_day_counts or not r.half_day)');
    // Clock-in and the close both use them: a half day stops neither a clock-in nor an absence being "on leave".
    expect(fn(text, 'public.hr_clock_in').body).toContain('private.hr_is_working_day(org, today)');
    expect(fn(text, 'public.hr_clock_in').body).toContain('private.hr_on_approved_leave(p_employee, today, false)');
    const close = fn(text, 'private.hr_attendance_close').body;
    expect(close).toContain('private.hr_is_working_day(o.org_id,');
    expect(close).toContain('private.hr_on_approved_leave(e.id, d.day, true)');
  });

  test('present or late is decided in one place, on the clock in Malaysia', () => {
    const text = writes();
    const { body } = fn(text, 'private.hr_attendance_status');
    // Judged to the minute: the seconds of the clock-in are dropped before the comparison.
    expect(body).toContain("clock time := date_trunc('minute', p_at at time zone 'Asia/Kuala_Lumpur')::time;");
    expect(body.match(/p_at/g)).toHaveLength(1);
    expect(body).toContain("coalesce(start_time, time '09:00')");
    expect(body).toContain('coalesce(grace, 15)');
    expect(body).toContain('extract(epoch from clock) <= extract(epoch from start_time) + grace * 60');
    // Defined once, called once: by clock-in.
    expect(text.match(/private\.hr_attendance_status\(/g)).toHaveLength(3);
    expect(fn(text, 'public.hr_clock_in').body).toContain('private.hr_attendance_status(org, now())');
    expect(text.match(/grace \* 60/g)).toHaveLength(1);
  });

  test('the nightly close runs as the owner, skips the demo, and never touches a clocked or corrected day', () => {
    const text = writes();
    const { header, body } = fn(text, 'private.hr_attendance_close');
    expect(header).toContain('returns void language plpgsql security definer set search_path = public');
    // Nothing before the epoch, and nothing at all without one.
    expect(body).toContain('select x.started_on into epoch from private.hr_attendance_epoch x;');
    expect(body).toContain('if epoch is null then return; end if;');
    expect(body).toContain('first_day := greatest(epoch, today - 31);');
    // Workspaces in a fixed order, the demo left out.
    expect(body).toContain(
      'select s.org_id, s.started_on from private.hr_attendance_started s\n'
        + '    where not private.is_demo_org(s.org_id)\n'
        + '    order by s.org_id',
    );
    // Active employees, from the day they joined and the day their record was made, up to yesterday.
    // A workspace is closed only from the day it first used attendance; one with
    // no start day is not in the loop at all. The date a row is about plays no part.
    expect(body).not.toMatch(/min\(|from public\.hr_employees e\s+where not/);
    // Active employees with a linked account, from that day, the day they joined and the day their record was made, up to yesterday.
    expect(body).toContain("where e.org_id = o.org_id and e.status = 'active' and e.user_id is not null");
    expect(body).toContain(
      "greatest(o.started_on, e.join_date, (e.created_at at time zone 'Asia/Kuala_Lumpur')::date, c.covered_from)",
    );
    expect(body).toContain('generate_series(0, today - 1 - first_day)');
    // Both statements leave alone any day with a clock-in or a correction.
    const guard = 'clock_in is null and a.corrected_at is null';
    expect(body.match(/a\.clock_in is null and a\.corrected_at is null/g)).toHaveLength(2);
    expect(body).toContain(guard);
    const remove = body.slice(body.indexOf('delete from public.hr_attendance_days'), body.indexOf('insert into public.hr_attendance_days'));
    expect(remove).toContain('a.clock_in is null and a.corrected_at is null');
    // From the workspace's start day on, as the insert is.
    expect(remove).toContain('a.work_date between greatest(first_day, o.started_on) and today - 1');
    const upsert = body.slice(body.indexOf('insert into public.hr_attendance_days'));
    expect(upsert).toContain('on conflict (employee_id, work_date) do update set status = excluded.status');
    expect(upsert).toContain('where a.clock_in is null and a.corrected_at is null and a.status is distinct from excluded.status;');
    expect(upsert).toContain('order by e.id, d.day');
    // It changes nothing else, and says nothing.
    expect(body.match(/\b(insert into|update|delete from) (public|private)\.\w+/g)).toEqual([
      'delete from private.hr_attendance_covered',
      'delete from public.hr_attendance_days',
      'insert into public.hr_attendance_days',
      'insert into private.hr_attendance_covered',
    ]);
    expect(body).not.toContain('raise');
    // The migration does not run it: the first night's run does.
    expect(text).not.toMatch(/^select private\./m);
  });

  test('the cron file schedules exactly one job, at 00:05 in Malaysia', () => {
    const cron = statements(CRON)
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(cron).toEqual([
      'create extension if not exists pg_cron;',
      "select cron.schedule('close-attendance', '5 16 * * *', $$select private.hr_attendance_close()$$);",
    ]);
    // And the functions file schedules nothing.
    expect(writes()).not.toMatch(/cron\./);
  });
});
