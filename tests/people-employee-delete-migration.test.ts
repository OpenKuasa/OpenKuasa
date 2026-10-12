import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const CHECKS = join(process.cwd(), 'supabase/tests');
const FILE = '20261103120000_people_employee_delete_by_function.sql';
const CORE = '20261014090000_people_core.sql';
const DOCUMENTS = '20261102090050_people_documents_writes.sql';

const raw = (file: string) => readFileSync(join(DIR, file), 'utf8');

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  raw(file)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The statements outside the `do $$ ... $$;` block, one per entry. */
const outsideBlocks = (text: string) =>
  text
    .replace(/do \$\$[\s\S]*?\$\$;/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

describe('deleting an employee only through the function', () => {
  test('the one change is DELETE on hr_employees, taken from signed-in users', () => {
    expect(outsideBlocks(statements(FILE))).toEqual(['revoke delete on public.hr_employees from authenticated']);
  });

  test('it grants nothing, and touches no other privilege, policy, trigger, function or row', () => {
    const text = statements(FILE);
    expect(text).not.toMatch(/\bgrant\b/i);
    expect(text.match(/\brevoke\b/gi)).toHaveLength(1);
    expect(text).not.toMatch(/\b(insert|update|truncate|select)\b(?! *\()/i);
    expect(text).not.toMatch(/\b(policy|trigger|create|alter|drop|disable|session_replication_role)\b/i);
    expect(text).not.toMatch(/hr_departments|hr_employee_private|hr_documents/);
  });

  test('it stops when the function is not there for signed-in users, before it revokes', () => {
    const text = statements(FILE);
    const guard = text.indexOf("declare fn oid := to_regprocedure('public.hr_delete_employee(uuid,uuid)');");
    const callable = text.indexOf("if fn is null or not has_function_privilege('authenticated', fn, 'execute') then");
    const stop = text.indexOf('raise exception');
    const revoke = text.indexOf('revoke delete on public.hr_employees from authenticated;');
    expect(guard).toBeGreaterThan(-1);
    expect(callable).toBeGreaterThan(guard);
    expect(stop).toBeGreaterThan(callable);
    expect(revoke).toBeGreaterThan(stop);
    expect(text.match(/raise exception/g)).toHaveLength(1);
  });

  test('it comes after the grant it takes away and the function it relies on', () => {
    const files = readdirSync(DIR).sort();
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf(DOCUMENTS));
    expect(statements(CORE)).toContain('grant delete on public.hr_employees to authenticated;');
    // The core policy is `for all`: there is no policy for deleting alone, so none is dropped.
    expect(statements(CORE)).toContain('create policy hr_employees_write on public.hr_employees for all to authenticated');
    for (const file of files.filter((f) => f > FILE)) {
      expect(statements(file), file).not.toMatch(/grant[^;]*\b(delete|all)\b[^;]*on (table )?public\.hr_employees\b[^;]*to[^;]*authenticated/i);
    }
  });

  test('the function deletes as the table owner, for signed-in users, and leaves the paid-payslip guard alone', () => {
    const text = statements(DOCUMENTS);
    const start = text.indexOf('create or replace function public.hr_delete_employee(p_org uuid, p_employee uuid)');
    const end = text.indexOf('$$;', start);
    const fn = text.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(fn).toContain('returns jsonb language plpgsql security definer set search_path = public as $$');
    expect(fn).toContain('delete from public.hr_employees e where e.id = emp.id;');
    expect(fn).toContain('if private.is_demo_org(emp.org_id) or not private.is_org_admin(emp.org_id) then return null; end if;');
    expect(fn).not.toMatch(/disable trigger|session_replication_role/);
    expect(text).toContain('grant execute on function public.hr_delete_employee(uuid, uuid) to authenticated;');
  });

  test('the header says what, why, what stays, and the order to deploy in', () => {
    const header = raw(FILE).split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const said of [
      'public.hr_delete_employee', '20261014090000_people_core.sql', '20261102090050_people_documents_writes.sql',
      'hr_employees_write', 'hr_employees_paid_payslips_guard', 'HR_EMPLOYEE_HAS_PAID_PAYSLIPS', 'private.reseed_demo_people',
      'Safe with the app deployed before it?', 'createEmployee', 'deploy the app release first', 'Safe to apply twice.',
    ]) expect(header, said).toContain(said);
  });

  test('the app never deletes an employee from the table', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/people/capabilities.ts'), 'utf8');
    expect(src).not.toMatch(/from\('hr_employees'\)\s*\.delete\(/);
    // createEmployee takes a half-made employee back out through the function too.
    expect(src).toContain("await ctx.client.rpc('hr_delete_employee', { p_org: ctx.orgId, p_employee: saved.id })");
  });

  test('the access checks no longer delete an employee as a signed-in user and expect it to go through', () => {
    const docs = readFileSync(join(CHECKS, 'people_documents_check.sql'), 'utf8');
    expect(docs).not.toContain('as the app deployed before did');
    expect(docs).toContain("format('delete from public.hr_employees where id = %L', eb), 'denied')");
    expect(docs).toContain("if has_table_privilege('authenticated', 'public.hr_employees', 'DELETE')");
    const rls = readFileSync(join(CHECKS, 'people_rls_check.sql'), 'utf8');
    expect(rls).toContain("or has_table_privilege('authenticated', 'public.' || t, 'DELETE') <> (t <> 'hr_employees') then");
    expect(rls).toContain("perform public.hr_delete_employee(org, e1);");
    const payroll = readFileSync(join(CHECKS, 'people_payroll_check.sql'), 'utf8');
    expect(payroll).toContain('perform public.hr_delete_employee(org, ea);');
    expect(payroll).toContain("if public.hr_delete_employee(org, ex) ->> 'id' is distinct from ex::text then");
  });
});
