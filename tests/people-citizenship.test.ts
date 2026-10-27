// tests/people-citizenship.test.ts
// An employee's citizenship decides the EPF and EIS rates the payroll proposes
// (issue #402, non-citizen rates). The rates are rows of hr_statutory_rules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CITIZENSHIP_LABEL, CITIZENSHIPS, isCitizenship } from '@/lib/people/citizenship';

const FILE = '20261126090100_people_citizenship.sql';

/** The migration without its comment lines, so a promise in a comment cannot satisfy a check. */
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

function fn(qualified: string): string {
  const start = sql.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

describe('citizenship', () => {
  test('the four categories are the same in the app and both checks of the migration', () => {
    expect(CITIZENSHIPS).toEqual(['citizen', 'permanent_resident', 'non_citizen_before_1998', 'non_citizen']);
    const allowed = "('citizen', 'permanent_resident', 'non_citizen_before_1998', 'non_citizen')";
    expect(sql.split(`citizenship in ${allowed}`)).toHaveLength(3);
    for (const key of CITIZENSHIPS) expect(CITIZENSHIP_LABEL[key]).toBeTruthy();
    expect(isCitizenship('permanent_resident')).toBe(true);
    expect(isCitizenship('malaysian')).toBe(false);
  });

  test('owners and admins can write the new column, and nobody else is granted anything', () => {
    expect(sql).toContain('grant update (citizenship) on public.hr_employee_private to authenticated;');
    expect(sql.match(/\bgrant\b/g)).toHaveLength(1);
  });

  test('the rules are keyed by scheme, category and age band', () => {
    expect(sql).toContain('add primary key (scheme, citizenship, employee_from_age);');
    expect(sql).toContain('drop constraint hr_statutory_rules_pkey');
    expect(sql).toContain('check (employee_until_age is null or employee_until_age > employee_from_age)');
  });

  test('the proposal matches one rule by category and age; empty is a citizen, an unknown age is working age', () => {
    const proposal = fn('private.hr_payroll_proposal');
    expect(proposal).toContain('p_scheme text, p_wage_cents bigint, p_age int, p_citizenship text');
    expect(proposal).toContain("s.citizenship = coalesce(p_citizenship, 'citizen')");
    expect(proposal).toContain('when p_age is null then s.employee_from_age <= 18 and coalesce(s.employee_until_age, 1000) >= 60');
    expect(proposal).not.toMatch(/0\.0?55|0\.02|0\.11/);
    expect(sql).toContain('drop function if exists private.hr_payroll_proposal(text, bigint, int);');
  });

  test('the payslip hands the employee\'s category to every proposal', () => {
    const refresh = fn('private.hr_payroll_refresh_payslip');
    expect(refresh).toContain('select x.citizenship into category from public.hr_employee_private x');
    for (const scheme of ['epf', 'socso', 'eis']) {
      expect(refresh).toContain(`private.hr_payroll_proposal('${scheme}', `);
    }
    expect(refresh.match(/age_years, category\)/g)).toHaveLength(3);
  });
});
