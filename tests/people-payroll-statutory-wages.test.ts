// tests/people-payroll-statutory-wages.test.ts
// The payroll proposals follow the age and overtime rules of the KWSP Third
// Schedule and PERKESO's tables, as far as the record already says enough to
// apply them (issue #402).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const FILE = '20261126090000_people_payroll_statutory_age_wages.sql';

/** The workspace's own arithmetic check, which calls the private functions the migration replaces. */
const checks = () => readFileSync(join(process.cwd(), 'supabase/tests/people_payroll_check.sql'), 'utf8');

/** The top-level arguments of each call of a function, ignoring commas inside a nested call or a string. */
function callArguments(text: string, called: string): string[][] {
  const found: string[][] = [];
  for (let at = text.indexOf(called); at > -1; at = text.indexOf(called, at + 1)) {
    let depth = 0;
    let quoted = false;
    const args: string[] = [];
    let from = at + called.length + 1;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === "'") quoted = !quoted;
      if (quoted) continue;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) {
          args.push(text.slice(from, i));
          found.push(args);
          break;
        }
        depth--;
      }
      if (c === ',' && depth === 0) {
        args.push(text.slice(from, i));
        from = i + 1;
      }
    }
  }
  return found;
}


/** The migration without its comment lines, so a promise in a comment cannot satisfy a check. */
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/** One function's header and body, from `create or replace function <name>(` to its `$$;`. */
function fn(qualified: string): string {
  const start = sql.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

describe('payroll statutory wages and age', () => {
  test('age is read from the date of birth, else the identity card, on the day before the wage month', () => {
    const age = fn('private.hr_payroll_age_on');
    expect(age).toContain('p_employee uuid, p_on date');
    expect(age).toContain('extract(year from age(p_on, born))::int');
    // The identity card is read only when no date of birth is on file, and only a real date counts.
    expect(age).toContain("born is null and card ~ '^[0-9]{12}$'");
    expect(age).toContain('exception when datetime_field_overflow or invalid_datetime_format');
    // Nothing at all when neither gives a date: the proposal reads an unknown age as keeping every share.
    expect(age).toContain('if born is null or born > p_on then');
    expect(sql).toContain('revoke all on function private.hr_payroll_age_on(uuid, date) from public, anon, authenticated;');
    // A birthday inside the month changes the shares from the next month.
    expect(fn('private.hr_payroll_refresh_payslip')).toContain(
      'private.hr_payroll_age_on(slip.employee_id, slip.period_month - 1)',
    );
  });

  test('the ages each share covers are rule data: none from 60, no EIS below 18, an unknown age keeps the share', () => {
    const proposal = fn('private.hr_payroll_proposal');
    expect(proposal).toContain('p_scheme text, p_wage_cents bigint, p_age int');
    expect(proposal).toContain('when p_age < s.employee_from_age or p_age >= s.employee_until_age then 0');
    expect(proposal).not.toMatch(/\b(60|18)\b/);
    expect(sql).toContain('add column employee_from_age int');
    expect(sql).toContain('add column employee_until_age int');
    expect(sql).toMatch(/set employee_until_age = 60,\s*note = '[^']*'\s*where scheme = 'epf';/);
    expect(sql).toMatch(/set employee_until_age = 60,\s*note = '[^']*'\s*where scheme = 'socso';/);
    expect(sql).toMatch(/set employee_from_age = 18, employee_until_age = 60,\s*note = '[^']*'\s*where scheme = 'eis';/);
    // The rate on the base it is handed, still capped, still in one place.
    expect(proposal).toContain('least(round(p_wage_cents * s.rate), s.max_cents)::bigint');
    expect(sql).toContain('drop function if exists private.hr_payroll_proposal(text, bigint);');
  });

  test('EPF is worked out without the overtime lines, SOCSO and EIS on gross', () => {
    const refresh = fn('private.hr_payroll_refresh_payslip');
    expect(refresh).toContain("l.kind = 'earning' and l.source <> 'overtime'");
    expect(refresh).toContain('epf_wages := greatest(slip.basic_cents + earnings_epf - unpaid, 0);');
    expect(refresh).toContain('gross := greatest(slip.basic_cents + earnings - unpaid, 0);');
    expect(refresh).toContain(
      "private.hr_payroll_proposal('epf', epf_wages, age_years)",
    );
    expect(refresh).toContain("private.hr_payroll_proposal('socso', gross, age_years)");
    expect(refresh).toContain("private.hr_payroll_proposal('eis', gross, age_years)");
  });

  test('a figure an owner or admin typed over still wins, and PCB is left as it was', () => {
    const refresh = fn('private.hr_payroll_refresh_payslip');
    for (const field of ['epf', 'socso', 'eis']) {
      expect(refresh).toContain(`'${field}' = any(p.set_by_hr) then p.${field}_cents`);
    }
    expect(refresh).toContain(
      "pcb_cents = case when 'pcb' = any(p.set_by_hr) then p.pcb_cents else coalesce(last_pcb, 0) end,",
    );
  });

  test('the migration changes these three functions and two rule columns, and nothing else', () => {
    const replaced = [...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((m) => m[1]);
    expect(replaced.sort()).toEqual([
      'private.hr_payroll_age_on',
      'private.hr_payroll_proposal',
      'private.hr_payroll_refresh_payslip',
    ]);
    expect([...sql.matchAll(/alter table ([a-z_.]+)/g)].map((m) => m[1])).toEqual(['public.hr_statutory_rules']);
    expect(sql).not.toMatch(/(drop policy|create policy|create table|create index|grant )\b/);
  });

  test('every draft payslip is worked out again, and no paid one', () => {
    const tail = sql.slice(sql.lastIndexOf('do $$'));
    expect(tail).toContain('perform private.hr_payroll_refresh_payslip(p.id)');
    expect(tail).toContain("where r.status = 'draft'");
  });

  test('the workspace check calls the proposal with the age, and no figure is left on the old signature', () => {
    const text = checks();
    const calls = callArguments(text, 'private.hr_payroll_proposal');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      // Four arguments since 20261126090100: the scheme, the wages, the age and the citizenship.
      // A shorter call names a signature that no longer exists.
      expect(args.length, args.join(' | ')).toBe(4);
    }
    // The demo's figures are compared with what the payslip function works out, not a copy of its rules.
    expect(text).toContain('from private.hr_payroll_refresh_payslip(p.id) f)');
  });
});
