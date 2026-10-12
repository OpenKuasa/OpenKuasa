/**
 * Reads the three migrations of this change as text, beside the migrations
 * they are applied after. Nothing here touches a database: it checks that each
 * file builds on what is already there and repeats none of it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
/** The statements of a file, without its comments. */
const sql = (name: string) =>
  read(name)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const GATING = '20261030121500_people_release_gating.sql';
const GUARDS = '20261030123000_finance_write_guards.sql';
const OWN = '20261030124500_people_no_self_approval.sql';
const CASH_BOOK = '20261028100000_bendahara_cash_book.sql';

/** One `create or replace function <name>(...) ... $$;` out of a file. */
function fn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = text.slice(start).search(/\n(end;? \$\$;|\$\$;)/);
  return text.slice(start, start + end);
}

test('release gating adds only what the performance slice left: scorecards', () => {
  const text = sql(GATING);
  // Reviews and announcements already have their column, their constraint and their read rule.
  expect(text).not.toMatch(/hr_reviews|hr_announcements/);
  expect(text).toMatch(/alter table public\.hr_scorecards add column released_at timestamptz;/);
  expect(text.match(/drop policy/g)).toHaveLength(1);
  expect(text).toMatch(/released_at is not null and private\.is_own_employee\(employee_id\)/);
});

test('the finance guards create nothing the cash book already created', () => {
  const text = sql(GUARDS);
  const earlier = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql') && name < GUARDS)
    .map(sql)
    .join('\n');
  const created = [...text.matchAll(/create trigger (\w+)/g)].map((m) => m[1]);
  expect(created).toEqual([
    'finance_bill_sign_off',
    'finance_invoice_sign_off',
    'finance_credit_note_sign_off',
    'finance_transaction_sign_off',
  ]);
  for (const name of created) expect(earlier, name).not.toMatch(new RegExp(`create trigger ${name}\\b`));
  // The policies it drops are there to drop, and it adds no column.
  for (const [, policy, table] of text.matchAll(/drop policy (\w+) on public\.(\w+);/g)) {
    expect(policy, policy).toBe(`${table}_${policy.split('_').pop()}`);
    expect(earlier).toMatch(new RegExp(`'${table}'`));
  }
  expect(text).not.toMatch(/add column|create table/);
});

test('each function that numbers a payment is the latest text, run as the owner behind a check of the caller', () => {
  const guards = sql(GUARDS);
  const sources: Record<string, string> = {
    'public.finance_record_payment_out': '20261013100000_bendahara_money.sql',
    'public.finance_record_payment_in': '20261014100000_bendahara_invoices.sql',
    'public.finance_record_refund': '20261022100000_bendahara_sales_followons.sql',
    'public.finance_mark_payment_paid': CASH_BOOK,
    'public.finance_post_cash_receipt': CASH_BOOK,
    'public.finance_record_voucher': CASH_BOOK,
  };
  const check = [
    "  if not private.is_org_writer(target_org) then",
    "    raise exception 'not allowed' using errcode = '42501';",
    '  end if;',
    '',
    '',
  ].join('\n');
  for (const [name, file] of Object.entries(sources)) {
    const now = fn(guards, name);
    expect(now, name).toContain('security definer');
    expect(now, name).toContain("set search_path = ''");
    expect(now, name).toContain(check);
    // Take the two changes back out and it is the function as it stood, word for word.
    const before = fn(sql(file), name);
    expect(now.replace('security definer', 'security invoker').replace(check, ''), name).toBe(before);
    expect(guards).toContain(`'${name}(`);
  }
  // The cash book's rule that money in is never marked paid is still there.
  expect(fn(guards, 'public.finance_mark_payment_paid')).toContain("t.direction <> 'out'");
});

test('a new payment keeps the cash book rules and gains two', () => {
  const now = fn(sql(GUARDS), 'private.finance_transaction_insert_guard');
  const before = fn(sql(CASH_BOOK), 'private.finance_transaction_insert_guard');
  for (const line of before.split('\n')) expect(now).toContain(line);
  expect(now).toContain('new.number is not null');
  expect(now).toContain('new.created_by := (select auth.uid());');
});

test('the columns closed on a payment are in neither grant', () => {
  const text = sql(GUARDS);
  const grants = [...text.matchAll(/grant (insert|update) \(([^)]+)\)\s+on public\.finance_transactions/g)];
  expect(grants.map((g) => g[1])).toEqual(['insert', 'update']);
  for (const [, , columns] of grants) {
    const names = columns.split(',').map((c) => c.trim());
    for (const closed of ['number', 'approved_by', 'approved_at', 'created_by']) expect(names).not.toContain(closed);
    // What finance_save_cash_receipt, which still runs as the caller, writes.
    for (const open of ['account_id', 'txn_date', 'amount', 'method', 'reference', 'contact_id', 'party_name', 'category_id', 'notes', 'status']) {
      expect(names).toContain(open);
    }
  }
  expect(text).toMatch(/grant select \((?![^)]*account_no)[^)]+\)\s+on public\.finance_accounts to authenticated;/);
});

test('each HR function is the latest text with the one test added', () => {
  const own = sql(OWN);
  const sources: Record<string, [string, string]> = {
    'public.hr_decide_leave': ['20261018090000_people_leave_writes.sql', 'LEAVE_OWN_REQUEST'],
    'public.hr_decide_time_off': ['20261018090000_people_leave_writes.sql', 'LEAVE_OWN_REQUEST'],
    'public.hr_decide_claim': ['20261020090000_people_claims_overtime_writes.sql', 'PAY_OWN_REQUEST'],
    'public.hr_mark_claim_paid': ['20261020090000_people_claims_overtime_writes.sql', 'PAY_OWN_REQUEST'],
    'public.hr_decide_overtime': ['20261027090000_people_payroll_writes.sql', 'PAY_OWN_REQUEST'],
  };
  for (const [name, [file, code]] of Object.entries(sources)) {
    const added = [
      '  if private.is_own_employee(req.employee_id) and not private.is_org_owner(req.org_id) then',
      `    raise exception '${code}';`,
      '  end if;',
      '',
    ].join('\n');
    const now = fn(own, name);
    expect(now, name).toContain(added);
    expect(now.replace(added, ''), name).toBe(fn(sql(file), name));
    // No migration after the one it is taken from defines the function again.
    const later = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > file && f !== OWN);
    for (const f of later) expect(read(f), `${name} in ${f}`).not.toContain(`create or replace function ${name}(`);
  }
});
