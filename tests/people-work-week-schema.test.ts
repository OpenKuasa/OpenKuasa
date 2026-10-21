import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = readdirSync(DIR).find((f) => f.endsWith('_people_work_week.sql')) ?? 'missing';
/** Where the settings table and the working-day rule this copies were written. */
const SETTINGS = '20261014090600_people_comms_documents.sql';
const WORKING_DAY = '20261024090000_people_attendance_writes.sql';
const REPORTING = '20261115133700_people_reporting_lines.sql';

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
/** A migration's statements without its comment lines. */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const flat = (text: string) => text.replace(/\s+/g, ' ');
const sql = FILE === 'missing' ? '' : statements(FILE);
const text = flat(sql);

function fn(qualified: string): { header: string; body: string } {
  const start = sql.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = sql.indexOf(' as $$', start);
  const close = sql.indexOf('$$;', open + 6);
  return { header: flat(sql.slice(start, open)), body: flat(sql.slice(open, close)) };
}

describe('the work-week migration', () => {
  test('is one file, later than the table and the rules it reads', () => {
    expect(FILE).not.toBe('missing');
    expect(files.filter((f) => f.endsWith('_people_work_week.sql'))).toEqual([FILE]);
    for (const source of [SETTINGS, WORKING_DAY, REPORTING]) expect(FILE.slice(0, 14) > source.slice(0, 14), source).toBe(true);
  });

  test('adds one function and touches no table, policy or grant on a table', () => {
    expect([...text.matchAll(/create or replace function ([\w.]+)\(/g)].map((m) => m[1])).toEqual(['public.hr_work_week']);
    expect(text).not.toMatch(/\b(alter|create|drop) (table|policy|view|trigger)\b/);
    expect(text).not.toMatch(/\b(insert into|update public|delete from)\b/);
    expect(text).not.toMatch(/grant [^;]* on (table )?public\.hr_/);
  });

  test('hr_work_week(uuid) returns jsonb, is a stable definer function on a fixed search path', () => {
    const { header } = fn('public.hr_work_week');
    expect(header).toBe(
      'create or replace function public.hr_work_week(p_org uuid) returns jsonb language sql security definer stable set search_path = public',
    );
  });

  test('is executable by signed-in users only', () => {
    expect(text).toContain('revoke all on function public.hr_work_week(uuid) from public, anon;');
    expect(text).toContain('grant execute on function public.hr_work_week(uuid) to authenticated;');
    expect(text).not.toMatch(/grant execute on function public\.hr_work_week\([^)]*\) to (anon|public)/);
  });

  test('answers any member of the workspace, and only a member', () => {
    const { body } = fn('public.hr_work_week');
    expect(body).toContain('case when private.is_org_member(p_org) then');
    expect(body).toContain('s.org_id = p_org');
    // Any member: no admin, manager or demo test, and no else branch (a stranger gets null).
    expect(body).not.toMatch(/is_org_admin|hr_manages_any|is_manager_of|is_demo_org|\belse\b/);
  });

  test('reveals the work week and no other column of the settings', () => {
    const { body } = fn('public.hr_work_week');
    expect(body).toContain('from public.hr_settings s');
    for (const column of [
      'work_start_time', 'late_grace_minutes', 'default_annual_leave_days', 'default_medical_leave_days',
      'default_emergency_leave_days', 'overtime_rates', 'notifications', 's.*', 'to_jsonb(s',
    ]) expect(body, column).not.toContain(column);
    expect([...body.matchAll(/\bs\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['org_id', 'work_week', 'work_week']);
  });

  test('reads the week as clock-in does: the known days in week order, else Monday to Friday', () => {
    const { body } = fn('public.hr_work_week');
    expect(body).toContain("unnest(array['mon','tue','wed','thu','fri','sat','sun']) with ordinality as d(key, n)");
    expect(body).toContain("jsonb_typeof(s.work_week) = 'array' and s.work_week ? d.key");
    expect(body).toContain('jsonb_agg(d.key order by d.n)');
    expect(body).toContain(`'["mon","tue","wed","thu","fri"]'::jsonb`);
    // The same default and the same seven keys as private.hr_is_working_day.
    const rule = flat(statements(WORKING_DAY));
    expect(rule).toContain("keys constant text[] := array['mon','tue','wed','thu','fri','sat','sun'];");
    expect(rule).toContain(`week := coalesce(week, '["mon","tue","wed","thu","fri"]'::jsonb);`);
  });

  test('never raises', () => {
    expect(fn('public.hr_work_week').body).not.toContain('raise');
  });
});
