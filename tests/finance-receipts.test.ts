import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INBOX_RECEIPT_BUCKET,
  INBOX_RECEIPT_MAX_BYTES,
  INBOX_RECEIPT_PAGE_SIZE,
  INBOX_RECEIPT_TYPES,
  listInboxReceipts,
} from '@/lib/finance/receipts';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

// PostgREST answers a numeric column as a string when it is large, and as a number otherwise.
const matchedRow = {
  id: 'r1', file_name: 'IMG_0042.JPG', mime_type: 'image/jpeg', size_bytes: 204800, has_file: true, vendor: 'Shell Bangsar',
  receipt_date: '2026-10-03', amount: '142.50', sst_amount: '8.07', status: 'matched',
  document_kind: 'expense', document_label: 'Travel', extraction_error: null, extracted_at: '2026-10-03T09:12:05+00:00',
  created_at: '2026-10-03T09:12:00+00:00',
};
const unreadRow = {
  id: 'r2', file_name: 'scan.pdf', mime_type: 'application/pdf', size_bytes: null, has_file: true, vendor: null,
  receipt_date: null, amount: null, sst_amount: null, status: 'review',
  document_kind: null, document_label: null, extraction_error: 'The receipt could not be read.', extracted_at: null,
  created_at: '2026-10-02T09:12:00+00:00',
};

/** The names of the columns of `finance_receipt_inbox`, read from the migration's own text. */
function inboxViewColumns(): string[] {
  const sql = readFileSync('supabase/migrations/20261107100000_bendahara_receipts_inbox.sql', 'utf8');
  const start = sql.indexOf('create view public.finance_receipt_inbox');
  const block = sql.slice(sql.indexOf('select', start) + 'select'.length, sql.indexOf('from public.finance_receipts r', start));
  // One column a line: "r.name," or "<expression> as name,".
  return block
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter(Boolean)
    .map((line) => /(?:\bas\s+|^r\.)(\w+)$/.exec(line)?.[1] ?? `unparsed: ${line}`);
}

describe('listInboxReceipts', () => {
  it('reads the inbox view for the workspace, newest upload first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [matchedRow, unreadRow], error: null });
    const without = (r: object) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'extraction_error'));
    const matchedKept = without(matchedRow);
    const unreadKept = without(unreadRow);
    expect(await listInboxReceipts(ctx)).toEqual([
      { ...matchedKept, amount: 142.5, sst_amount: 8.07, extraction_failed: false },
      { ...unreadKept, extraction_failed: true },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'table', name: 'finance_receipt_inbox', op: 'select', filters: { org_id: 'org-1' },
      order: ['created_at desc', 'id asc'], range: [0, INBOX_RECEIPT_PAGE_SIZE - 1],
    });
    // Every column the query asks for is one the view has: a renamed column fails here, not in production.
    const asked = calls[0].columns!.split(',').sort();
    expect(asked).toEqual(Object.keys(matchedRow).sort());
    const inView = inboxViewColumns();
    expect(inView.length).toBeGreaterThan(15);
    for (const column of asked) expect(inView, column).toContain(column);
  });
  it('sends the browser only what the screen uses: no ids of documents, and no error text', async () => {
    const rows = await listInboxReceipts(fakeFinance({ data: [matchedRow, unreadRow], error: null }).ctx);
    for (const r of rows) {
      expect(r).not.toHaveProperty('expense_id');
      expect(r).not.toHaveProperty('bill_id');
      expect(r).not.toHaveProperty('extraction_error');
      expect(JSON.stringify(r)).not.toContain('could not be read.');
    }
    expect(rows.map((r) => r.extraction_failed)).toEqual([false, true]);
  });
  it('keeps what nobody has read as null, never as zero', async () => {
    const [row] = await listInboxReceipts(fakeFinance({ data: [unreadRow], error: null }).ctx);
    expect([row.amount, row.sst_amount, row.size_bytes]).toEqual([null, null, null]);
  });
  it('does not read where the file is kept: the browser is never told a path', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    await listInboxReceipts(ctx);
    expect(calls[0].columns).not.toContain('file_path');
  });
  it('reads on until a page comes back short', async () => {
    const full = Array.from({ length: INBOX_RECEIPT_PAGE_SIZE }, (_, i) => ({ ...matchedRow, id: `r${i}` }));
    const pages = (call: FinanceCall) => ({ data: call.range![0] === 0 ? full : [unreadRow], error: null });
    const { ctx, calls } = fakeFinance(pages);
    expect(await listInboxReceipts(ctx)).toHaveLength(INBOX_RECEIPT_PAGE_SIZE + 1);
    expect(calls.map((c) => c.range)).toEqual([
      [0, INBOX_RECEIPT_PAGE_SIZE - 1],
      [INBOX_RECEIPT_PAGE_SIZE, 2 * INBOX_RECEIPT_PAGE_SIZE - 1],
    ]);
  });
  it('answers with no rows when the view has none, and throws when it cannot be read', async () => {
    expect(await listInboxReceipts(fakeFinance({ data: null, error: null }).ctx)).toEqual([]);
    await expect(listInboxReceipts(fakeFinance({ data: null, error: { code: '42501' } }).ctx)).rejects.toEqual({ code: '42501' });
  });
});

const MIGRATION = '20261107100000_bendahara_receipts_inbox.sql';
/** A migration's statements, without its comment lines. */
const statements = (file: string) =>
  readFileSync(`supabase/migrations/${file}`, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

describe('the bucket, as the app and the migration each describe it', () => {
  const sql = readFileSync(`supabase/migrations/${MIGRATION}`, 'utf8');
  const types = Object.keys(INBOX_RECEIPT_TYPES).map((t) => `'${t}'`).join(',');
  it('has the same name, size limit and types in both', () => {
    expect(sql).toContain(
      `values ('${INBOX_RECEIPT_BUCKET}', '${INBOX_RECEIPT_BUCKET}', false, ${INBOX_RECEIPT_MAX_BYTES}, array[${types}])`,
    );
    expect(sql).toContain(`size_bytes <= ${INBOX_RECEIPT_MAX_BYTES}`);
    expect(sql).toContain(`mime_type in (${types})`);
  });
  it('stores each type under the extension the upload rule and the table allow', () => {
    const extensions = Object.values(INBOX_RECEIPT_TYPES).join('|');
    expect(extensions).toBe('jpg|png|pdf|heic|heif');
    // Once in the table's check and once in the upload rule.
    expect(sql.split(`\\.(${extensions})$`).length - 1).toBe(2);
    // And the one function that turns an extension into a type knows each of them, and no other.
    for (const [type, extension] of Object.entries(INBOX_RECEIPT_TYPES)) {
      expect(sql, type).toContain(`when '${extension}' then '${type}'`);
    }
    expect(sql.match(/^ {4}when '[a-z]+' then '[a-z/]+'$/gm)).toHaveLength(Object.keys(INBOX_RECEIPT_TYPES).length);
  });
  // A tripwire on purpose: a later migration that legitimately adds or replaces one of these sixteen functions
  // (or the table, view, triggers and policies named below) must update this test.
  it('is made of new objects only: it replaces and drops nothing an earlier migration made', () => {
    const own = statements(MIGRATION);
    expect(own).not.toMatch(/create or replace/);
    expect(own).not.toMatch(/\bdrop /);
    // The only tables it alters are its own two, to switch row level security on.
    expect(own.match(/alter [a-z]+ [^\n]*/g)).toEqual([
      "alter table public.%I enable row level security', t);",
      'alter table private.finance_receipt_deletions enable row level security;',
    ]);
    const functions = [...own.matchAll(/^create function ([a-z_.]+)\(/gm)].map((m) => m[1]);
    expect(functions).toHaveLength(16);
    const made = [
      ...functions.map((name) => `function ${name}(`),
      ...[...own.matchAll(/^create (trigger|policy) (\w+)/gm)].map((m) => `create ${m[1]} ${m[2]}`),
      'create table public.finance_receipts', 'create table private.finance_receipt_deletions', 'create view public.finance_receipt_inbox',
    ];
    const others = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql') && f !== MIGRATION);
    expect(others.length).toBeGreaterThan(90);
    // The demo seed, which comes after it, makes nothing either.
    for (const file of others) {
      const text = statements(file);
      for (const thing of made) expect(text.includes(thing), `${thing} in ${file}`).toBe(false);
    }
    // And it names none of the functions the finance write guards made run as their owner.
    for (const name of ['finance_next_number', 'finance_record_', 'finance_mark_payment_paid', 'finance_post_', 'finance_sequences', 'finance_transactions']) {
      expect(own.includes(name), name).toBe(false);
    }
  });
  // A tripwire on purpose: a later migration that legitimately raises a new FIN code, or replaces one of these
  // sixteen functions, must update this test (the list of codes, the count of functions, the FIN2[3-9] range below).
  it('makes its bucket and never adopts one, refuses NaN by name, and uses error codes nobody else has', () => {
    const own = statements(MIGRATION);
    expect(own).toContain('insert into storage.buckets');
    expect(own).not.toMatch(/on conflict \(id\)/);
    expect(own).toContain("check (amount > 0 and amount <> 'NaN')");
    expect(own).toContain("check (sst_amount >= 0 and sst_amount <> 'NaN')");
    const codes = [...new Set([...own.matchAll(/errcode = '(FIN\d+)'/g)].map((m) => m[1]))].sort();
    expect(codes).toEqual(['FIN11', 'FIN14', 'FIN23', 'FIN24', 'FIN25']);
    // FIN23, FIN24 and FIN25 are this migration's alone: FIN16 to FIN22 belong to Banking, RFQs and purchase orders.
    const others = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql') && f !== MIGRATION);
    for (const file of others) expect(statements(file), file).not.toMatch(/FIN2[3-9]/);
  });
  it('lets a signed-in person write only the columns that are theirs to write', () => {
    const flat = statements(MIGRATION).replace(/\s+/g, ' ');
    expect(flat).toContain("'grant select, delete on public.%I to authenticated'");
    expect(flat).toContain('grant insert (org_id, file_path, file_name) on public.finance_receipts to authenticated;');
    expect(flat).toContain(
      'grant update (vendor, receipt_date, amount, sst_amount, status, expense_id, bill_id, extraction_error, extracted_at, updated_at) on public.finance_receipts to authenticated;',
    );
    // No other grant on the table, to anyone.
    expect(flat.match(/grant [^;]*on public\.(%I|finance_receipts)\b/g)).toHaveLength(3);
    expect(flat).toContain("'revoke all on public.%I from anon, authenticated, service_role'");
  });
  it('grants the server the four clean-up functions and no table', () => {
    // The one statement that names it as a grantee is the loop over the four functions.
    expect(sql.match(/grant [^;\n]* to [^;\n]*service_role/g)).toEqual(['grant execute on function %s to service_role']);
    // Everything else is taken from it by name: Supabase's defaults would otherwise hand it every new function.
    expect(sql).toContain("'revoke all on function %s from public, anon, service_role'");
    expect(sql).toContain('revoke all on public.finance_receipt_inbox from anon, authenticated, service_role;');
  });
});
