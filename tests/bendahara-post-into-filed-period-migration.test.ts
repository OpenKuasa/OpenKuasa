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

test('the tax kinds come from the same line rule the return uses', () => {
  const text = sql(FILE);
  // service is 6 and 8, sales 5 and 10, and a line with no type takes the rate's type.
  for (const guard of ['private.finance_invoice_post_filed_guard', 'private.finance_credit_note_issue_filed_guard']) {
    const body = fn(text, guard);
    expect(body, guard).toMatch(/coalesce\(l\.tax_type/);
    expect(body, guard).toMatch(/in \(6, 8\)/);
    expect(body, guard).toMatch(/in \(5, 10\)/);
  }
  // A credit note has no lines: its invoice's lines decide what the note can deduct.
  expect(fn(text, 'private.finance_credit_note_issue_filed_guard')).toMatch(/l\.invoice_id = old\.invoice_id/);
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
  for (const name of ['private.finance_filed_period_label', 'private.finance_invoice_post_filed_guard', 'private.finance_credit_note_issue_filed_guard']) {
    const start = text.indexOf(`revoke all on function ${name}`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    expect(text.slice(start, text.indexOf(';', start)), name).toMatch(/from public, anon, authenticated, service_role/);
  }
  expect(text).not.toMatch(/create table|alter table|create policy/);
  // The void guard keeps its own copy of the period arithmetic: it is already applied
  // in existing projects, so lifting it would reach fresh installs only.
  expect(sql(VOID_GUARD)).toMatch(/finance_invoice_void_filed_guard/);
});
