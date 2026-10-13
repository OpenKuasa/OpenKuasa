/**
 * FIN28, "a payment that has left draft is held still" (20261117090000). The code and its sentence, the migration
 * read as text beside the ones before it, and the one thing the rule leans on in this repository: nothing in `src`
 * edits a payment that is not a draft, sends one back to draft, or writes a split. Nothing here touches a database.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FIN_HELD_STILL, HELD_STILL } from '@/lib/finance/result';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'supabase', 'migrations');
const NAME = '20261117090000_bendahara_payment_held_still.sql';
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

/** What the trigger and the function hold, in the order the migration writes them. */
const HELD = ['direction', 'account_id', 'txn_date', 'amount', 'method', 'reference', 'contact_id', 'party_name', 'category_id', 'notes'];

test('the code has one sentence, true of the one payment it is raised for', () => {
  expect(FIN_HELD_STILL).toBe('FIN28');
  expect(HELD_STILL).toBe('This is waiting to be paid, so it can no longer be changed. Delete it and record it again.');
});

test('the migration replaces nothing: two new functions and two new triggers', () => {
  expect(text).not.toMatch(/create or replace/);
  expect(text).not.toMatch(/drop (function|trigger|view|policy|table|index|constraint)|alter (function|table|trigger)|create (table|policy|view)|add column/);
  expect([...text.matchAll(/create function ([\w.]+)\(/g)].map((m) => m[1])).toEqual([
    'private.finance_transaction_still_guard',
    'private.finance_allocation_still_guard',
  ]);
  expect([...text.matchAll(/create trigger (\w+)/g)].map((m) => m[1])).toEqual(['finance_transaction_still', 'finance_allocation_still']);
  expect(earlier).not.toMatch(/finance_transaction_still|finance_allocation_still/);
  // Nothing earlier raises the code, this file raises no other, and it grants nothing to anyone.
  expect(earlier).not.toContain('FIN28');
  expect([...new Set([...text.matchAll(/FIN\d\d/g)].map((m) => m[0]))]).toEqual(['FIN28']);
  expect(text).not.toMatch(/\bgrant\b/);
  for (const name of ['finance_transaction_still_guard', 'finance_allocation_still_guard']) {
    expect(text).toContain(`revoke all on function private.${name}() from public, anon, authenticated, service_role;`);
  }
  expect(text).toContain("set local lock_timeout = '5s';");
  expect(text).toContain('lock table public.finance_transactions, public.finance_allocations in share row exclusive mode nowait;');
});

test('each trigger fires after every guard that was there, and the payment one before the account lock and the stamp', () => {
  const before = (table: string) => [
    ...new Set(
      [...earlier.matchAll(new RegExp(`create trigger (\\w+)\\s+before (?:insert|update|delete)[^;]*?on public\\.${table}\\b`, 'g'))].map((m) => m[1]),
    ),
  ].sort();
  expect(before('finance_transactions')).toEqual([
    'finance_transaction_guard',
    'finance_transaction_insert_guard',
    'finance_transaction_sign_off',
    'finance_transfer_id_guard',
    'finance_use_account_insert',
    'finance_use_account_update',
    'finance_void_stamp',
  ]);
  const name = 'finance_transaction_still';
  for (const guard of ['finance_transaction_guard', 'finance_transaction_insert_guard', 'finance_transaction_sign_off']) expect(name > guard).toBe(true);
  for (const later of ['finance_transfer_id_guard', 'finance_use_account_insert', 'finance_use_account_update', 'finance_void_stamp']) expect(name < later).toBe(true);
  expect(before('finance_allocations')).toEqual(['finance_allocation_guard']);
  expect('finance_allocation_still' > 'finance_allocation_guard').toBe(true);
});

test('every column of a payment a signed-in person may write is held, or is one of the three left alone', () => {
  const grants = [...earlier.matchAll(/grant update \(([^)]*)\)\s+on public\.finance_transactions to authenticated;/g)];
  // One grant, in the write guards. A later one would be a column this rule has not been asked about.
  expect(grants).toHaveLength(1);
  const writable = grants[0][1].split(',').map((c) => c.trim());
  expect(writable.filter((c) => !['status', 'transfer_id', 'updated_at'].includes(c)).sort()).toEqual([...HELD].sort());
  // No later migration gave the role the whole table back.
  const after = earlier.slice(earlier.indexOf(grants[0][0]) + grants[0][0].length);
  expect(after).not.toMatch(/grant (all|update|insert, update)[^;(]* on (table )?public\.finance_transactions /);

  const trigger = text.slice(text.indexOf('create trigger finance_transaction_still'), text.indexOf('execute function private.finance_transaction_still_guard()'));
  expect(trigger).toContain("when (old.status <> 'draft'");
  for (const column of ['status', ...HELD]) expect(trigger).toContain(`new.${column} is distinct from old.${column}`);
  const start = text.indexOf('create function private.finance_transaction_still_guard()');
  const body = text.slice(start, text.indexOf('end $$;', start));
  for (const column of HELD) {
    expect(body, column).toContain(`new.${column}`);
    expect(body, column).toContain(`old.${column}`);
  }
  expect(body).toContain('security definer');
  expect(body).toContain("set search_path = ''");
  expect(body).toContain('(select auth.uid()) is null');
  // Back to draft is refused whoever asks: the function reads no role.
  expect(body).toContain("if new.status = 'draft' then");
  expect(body).not.toMatch(/finance_may_decide|finance_may_sign_off|is_org_admin/);
  expect(body).toContain("and not (old.status = 'scheduled' and new.status = 'posted')");
});

test('the split guard runs as its owner, locks the payment, and lets a deleted payment and a deleted workspace go', () => {
  const start = text.indexOf('create function private.finance_allocation_still_guard()');
  const body = text.slice(start, text.indexOf('end $$;', start));
  expect(body).toContain('security definer');
  expect(body).toContain("set search_path = ''");
  expect(body).toContain('(select auth.uid()) is null');
  expect(body.match(/for share;/g)).toHaveLength(2);
  expect(body).toContain("if tg_op = 'DELETE' and not exists (select 1 from public.orgs o where o.id = old.org_id) then");
  expect(body.match(/if found and standing <> 'draft' then/g)).toHaveLength(2);
  expect(text).toMatch(/create trigger finance_allocation_still\s+before insert or update or delete on public\.finance_allocations\s+for each row execute function private\.finance_allocation_still_guard\(\);/);
});

/** Every source file under a directory. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('nothing in src edits a payment that is not a draft, sends one back to draft, or writes a split', () => {
  const sources = files(join(ROOT, 'src')).map((path) => ({ path: path.slice(ROOT.length + 1), code: readFileSync(path, 'utf8') }));
  const updates: string[] = [];
  for (const { path, code } of sources) {
    // A split is written by the database functions only.
    expect(code, path).not.toMatch(/from\('finance_allocations'\)\s*\.(insert|update|upsert|delete)\(/);
    // A payment is never inserted or upserted from here, and never set to draft.
    expect(code, path).not.toMatch(/from\('finance_transactions'\)\s*(\/\/[^\n]*\n\s*)*\.(insert|upsert)\(/);
    for (const m of code.matchAll(/from\('finance_transactions'\)\s*(?:\/\/[^\n]*\n\s*)*\.update\(\{([^}]*)\}\)/g)) {
      const keys = m[1].split(',').map((pair) => pair.split(':')[0].trim()).filter(Boolean).sort();
      updates.push(`${path}: ${keys.join(',')}`);
      expect(m[1], path).not.toMatch(/status:\s*'draft'/);
    }
  }
  // The direct updates there are: four voids (status 'void') and the voucher decision (the status it is given).
  expect(updates.sort()).toEqual([
    'src/lib/finance/cash-receipts.ts: status,updated_at',
    'src/lib/finance/money.ts: status,updated_at',
    'src/lib/finance/money.ts: status,updated_at',
    'src/lib/finance/refunds.ts: status,updated_at',
    'src/lib/finance/vouchers.ts: status,updated_at',
  ]);
  // And no update of a payment is built any other way (a variable, a spread) that the scan above would not see.
  const all = sources.flatMap(({ path, code }) => [...code.matchAll(/from\('finance_transactions'\)\s*(?:\/\/[^\n]*\n\s*)*\.update\(/g)].map(() => path));
  expect(all).toHaveLength(updates.length);
  // Whatever the spelling: every file that names the table, with how many times it calls .update( on anything.
  const writers = sources
    .filter(({ code }) => /finance_transactions/.test(code) && /\.(update|upsert)\(/.test(code))
    .map(({ path, code }) => `${path}: ${[...code.matchAll(/\.(update|upsert)\(/g)].length}`)
    .sort();
  expect(writers).toEqual([
    'src/lib/finance/cash-receipts.ts: 1',
    'src/lib/finance/money.ts: 2',
    'src/lib/finance/refunds.ts: 1',
    'src/lib/finance/vouchers.ts: 1',
  ]);
});
