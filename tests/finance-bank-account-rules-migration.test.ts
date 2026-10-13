/**
 * Reads the account rules migration as text, beside the migrations it is
 * applied after. Nothing here touches a database: it checks that the file
 * replaces nothing that is live and closes the columns it says it closes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const NAME = '20261114110000_bendahara_bank_account_rules.sql';
/** The statements of a file, without its comments. */
const sql = (name: string) =>
  readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const text = sql(NAME);
const earlier = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql') && name < NAME)
  .map(sql)
  .join('\n');

test('it replaces nothing: one new function, one new trigger, one new constraint', () => {
  expect(text).not.toMatch(/create or replace/);
  expect(text).not.toMatch(/drop (function|trigger|view|policy|table|index)|alter function|create table|add column|create policy/);
  expect([...text.matchAll(/create function ([\w.]+)\(/g)].map((m) => m[1])).toEqual(['private.finance_bank_account_guard']);
  expect([...text.matchAll(/create trigger (\w+)/g)].map((m) => m[1])).toEqual(['finance_bank_account_guard']);
  expect([...text.matchAll(/add constraint (\w+)/g)].map((m) => m[1])).toEqual(['finance_accounts_opening_balance_number_check']);
  // None of the three names is taken by anything earlier.
  expect(earlier).not.toMatch(/finance_bank_account_guard\b/);
  expect(earlier).not.toMatch(/finance_accounts_opening_balance_number_check/);
});

test('the guard runs as the caller with a fixed search path, and nobody can call it', () => {
  const start = text.indexOf('create function private.finance_bank_account_guard()');
  const body = text.slice(start, text.indexOf('end $$;', start));
  expect(body).toContain("set search_path = ''");
  expect(body).not.toContain('security definer');
  expect(body).toContain('(select auth.uid()) is null');
  expect(body).toContain('private.finance_may_sign_off(new.org_id)');
  expect(body).toContain('private.finance_may_sign_off(old.org_id)');
  expect(body).toContain("t.status in ('scheduled','pending_approval')");
  expect(text).toContain('revoke all on function private.finance_bank_account_guard() from public, anon, authenticated, service_role;');
  expect(text).toMatch(/before insert or update or delete on public\.finance_accounts\s+for each row/);
});

test('the columns closed on an account and on a statement import are in no grant', () => {
  const grants = [...text.matchAll(/grant (insert|update) \(([^)]+)\)\s+on public\.(\w+) to authenticated;/g)].map((m) => ({
    what: `${m[1]} ${m[3]}`,
    columns: m[2].split(',').map((c) => c.trim()),
  }));
  expect(grants.map((g) => g.what)).toEqual([
    'insert finance_accounts',
    'update finance_accounts',
    'insert finance_statement_imports',
    'update finance_statement_imports',
  ]);
  const [insertAccount, updateBankAccount, insertImport, updateImport] = grants.map((g) => g.columns);
  expect(insertAccount).toEqual(['org_id', 'name', 'kind', 'bank_name', 'account_no', 'opening_balance', 'opening_date', 'active']);
  // Not kind, not org_id: bank or cash and the workspace are fixed once an account is made.
  expect(updateBankAccount).toEqual(['name', 'bank_name', 'account_no', 'opening_balance', 'opening_date', 'active', 'updated_at']);
  // What finance_import_statement, which runs as the caller, inserts.
  expect(insertImport).toEqual(['org_id', 'account_id', 'file_name']);
  expect(updateImport).toEqual(['org_id', 'account_id', 'file_name', 'updated_at']);
  expect(text).toContain('revoke insert, update on public.finance_accounts from authenticated;');
  expect(text).toContain('revoke insert, update on public.finance_statement_imports from authenticated;');
  // Select and delete are not touched, and nothing is given to anyone else.
  expect(text).not.toMatch(/revoke (select|delete|all) on public/);
  expect(text).not.toMatch(/to (anon|service_role|public)\b/);
});

test('finance_import_statement names only columns that are still open', () => {
  const banking = sql('20261031090000_bendahara_banking.sql');
  expect(banking).toContain('insert into public.finance_statement_imports (org_id, account_id, file_name)');
});
