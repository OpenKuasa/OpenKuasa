/**
 * Reads the migration of this change as text, beside the migrations it is
 * applied after. Nothing here touches a database: it checks that the file
 * builds on the void guard from #425 instead of repeating it, that both guards
 * fire only on the transition they are for, and that no earlier file already
 * uses the same trigger name or error code.
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

const FILE = '20261129090000_bendahara_post_into_filed_period.sql';
const VOID_GUARD = '20261128092000_bendahara_void_on_filed_return.sql';

/** One `create ... function <name>(...) ... $$;` out of a file. */
function fn(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = text.slice(start).search(/\nend \$\$;/);
  expect(end, name).toBeGreaterThan(0);
  return text.slice(start, start + end);
}

test('one marks lookup serves both guards, and it reads each mark its own period', () => {
  const text = sql(FILE);
  const helper = fn(text, 'private.finance_filed_period_label');
  // The period comes from the mark, as the void guard does it, never from settings.
  expect(helper).toMatch(/from public\.finance_sst_returns r/);
  expect(helper).toMatch(/doc_date >= r\.period_start/);
  expect(helper).toMatch(/doc_date < \(r\.period_start \+ interval '2 months'\)::date/);
  // Only the tax types the document carries can hold it back.
  expect(helper).toMatch(/r\.tax_type = any \(kinds\)/);
  expect(helper).toMatch(/returns text/);
  expect(text).not.toMatch(/finance_sst_settings/);
});

test('the two guards fire only on the transition they are for', () => {
  const inv = fn(sql(FILE), 'private.finance_invoice_post_filed_guard');
  expect(inv).toMatch(/old\.status = 'draft' and new\.status = 'posted'/);
  expect(inv).toMatch(/new\.invoice_date/);
  expect(inv).toMatch(/errcode = 'FIN72'/);

  const note = fn(sql(FILE), 'private.finance_credit_note_issue_filed_guard');
  expect(note).toMatch(/old\.status = 'draft' and new\.status = 'issued'/);
  expect(note).toMatch(/new\.credit_date/);
  expect(note).toMatch(/errcode = 'FIN73'/);
});

test('one line rule says which returns a document is on, and all four guards use it', () => {
  const text = sql(FILE);
  // The helper is plain SQL: it ends at its own `$$;`.
  const start = text.indexOf('function private.finance_invoice_sst_kinds(');
  expect(start).toBeGreaterThanOrEqual(0);
  const helper = text.slice(start, text.indexOf('\n$$;', start));
  // A line with no type takes its rate's type: service is 6 and 8, sales 5 and 10.
  expect(helper).toMatch(/coalesce\(\s*l\.tax_type/);
  expect(helper).toMatch(/l\.sst_rate in \(5, 10\) then 'sales' when l\.sst_rate in \(6, 8\) then 'service'/);
  expect(helper).toMatch(/l\.sst_rate > 0/);
  // form_only keeps a line at the return's own rates; without it any taxed line of the type counts.
  expect(helper).toMatch(/not form_only/);
  expect(helper).toMatch(/t\.kind = 'service' and t\.sst_rate in \(6, 8\)/);
  expect(helper).toMatch(/t\.kind = 'sales' and t\.sst_rate in \(5, 10\)/);

  // An invoice is on a return by its form lines; a credit note deducts a share of any taxed line (creditTaxSen).
  const calls: [string, RegExp][] = [
    ['private.finance_invoice_post_filed_guard', /finance_invoice_sst_kinds\(old\.org_id, old\.id, true\)/],
    ['private.finance_invoice_void_filed_guard', /finance_invoice_sst_kinds\(old\.org_id, old\.id, true\)/],
    ['private.finance_credit_note_issue_filed_guard', /finance_invoice_sst_kinds\(old\.org_id, old\.invoice_id, false\)/],
    ['private.finance_credit_note_void_filed_guard', /finance_invoice_sst_kinds\(old\.org_id, old\.invoice_id, false\)/],
  ];
  for (const [guard, call] of calls) {
    const body = fn(text, guard);
    expect(body, guard).toMatch(call);
    expect(body, guard).not.toMatch(/finance_invoice_lines/);
  }
});

test('the two void guards keep their codes and sentences word for word', () => {
  const text = sql(FILE);
  expect(fn(text, 'private.finance_invoice_void_filed_guard')).toMatch(/old\.status = 'posted' and new\.status = 'void'/);
  expect(fn(text, 'private.finance_invoice_void_filed_guard')).toContain(
    "'This invoice is on the % return, which is marked filed. Issue a credit note instead. If the invoice should never have been issued, take the filed mark off the return, void the invoice, and file an amended return (Pindaan).'",
  );
  expect(fn(text, 'private.finance_invoice_void_filed_guard')).toMatch(/errcode = 'FIN71'/);
  expect(fn(text, 'private.finance_credit_note_void_filed_guard')).toMatch(/old\.status = 'issued' and new\.status = 'void'/);
  expect(fn(text, 'private.finance_credit_note_void_filed_guard')).toContain(
    "'This credit note is on the % return, which is marked filed. If the credit note should never have been issued, take the filed mark off the return, void the credit note, and file an amended return (Pindaan). A credit taken back in a later period is a debit note, which Bendahara does not issue yet.'",
  );
  expect(fn(text, 'private.finance_credit_note_void_filed_guard')).toMatch(/errcode = 'FIN74'/);
  // Replaced in place: the triggers from #425 and #428 are not created again.
  expect(text).toMatch(/create or replace function private\.finance_invoice_void_filed_guard\(\)/);
  expect(text).toMatch(/create or replace function private\.finance_credit_note_void_filed_guard\(\)/);
});

test('the triggers are new, on the right tables, and fire before the status change', () => {
  const text = sql(FILE);
  const created = [...text.matchAll(/create trigger (\w+)\s+[\s\S]{0,80}?on public\.(\w+)/g)].map((m) => [m[1], m[2]]);
  expect(created).toEqual([
    ['finance_invoice_post_filed_guard', 'finance_invoices'],
    ['finance_credit_note_issue_filed_guard', 'finance_credit_notes'],
  ]);
  expect(text).toMatch(/before update of status on public\.finance_invoices/);
  expect(text).toMatch(/before update of status on public\.finance_credit_notes/);

  const earlier = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql') && name < FILE)
    .map(sql)
    .join('\n');
  for (const [name] of created) expect(earlier, name).not.toMatch(new RegExp(`create trigger ${name}\\b`));
  for (const code of ['FIN72', 'FIN73']) expect(earlier, code).not.toMatch(new RegExp(code));
});

test('nothing is granted to a caller, and the change adds no table or column', () => {
  const text = sql(FILE);
  for (const name of ['private.finance_invoice_sst_kinds', 'private.finance_filed_period_label', 'private.finance_invoice_post_filed_guard', 'private.finance_credit_note_issue_filed_guard']) {
    const start = text.indexOf(`revoke all on function ${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    expect(text.slice(start, text.indexOf(';', start)), name).toMatch(/from public, anon, authenticated, service_role/);
  }
  expect(text).not.toMatch(/create table|alter table|create policy/);
  // The void guard's trigger stays where #425 made it; this file only replaces its function.
  expect(sql(VOID_GUARD)).toMatch(/create trigger finance_invoice_void_filed_guard/);
});
