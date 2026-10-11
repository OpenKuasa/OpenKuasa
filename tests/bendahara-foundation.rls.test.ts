import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);


function client(): SupabaseClient {
  return liveClient();
}

async function anonUserWithOrg(orgName: string) {
  const c = client();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

let a: Awaited<ReturnType<typeof anonUserWithOrg>>;
let b: Awaited<ReturnType<typeof anonUserWithOrg>>;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  a = await anonUserWithOrg('Foundation A Sdn Bhd');
  b = await anonUserWithOrg('Foundation B Sdn Bhd');
});

testWithSupabase('a contact can be customer and supplier at once', async () => {
  const { data, error } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Both Sdn Bhd', is_customer: true, is_supplier: true, tin: 'C1234567890' })
    .select('is_customer, is_supplier, tin')
    .single();
  expect(error, error?.message).toBeNull();
  expect(data).toEqual({ is_customer: true, is_supplier: true, tin: 'C1234567890' });
});

testWithSupabase('a contact that is neither customer nor supplier is refused', async () => {
  const { error } = await a.c
    .from('finance_contacts')
    .insert({ org_id: a.orgId, name: 'Nobody', is_customer: false, is_supplier: false });
  expect(error?.code).toBe('23514');
});

testWithSupabase('a new workspace starts with the default categories', async () => {
  const { data, error } = await a.c
    .from('finance_categories')
    .select('name, kind')
    .eq('org_id', a.orgId);
  expect(error, error?.message).toBeNull();
  const expense = (data ?? []).filter((c) => c.kind === 'expense').map((c) => c.name).sort();
  expect(expense).toEqual(['Marketing', 'Rent', 'Salaries', 'Services', 'Supplies', 'Travel', 'Utilities']);
  expect((data ?? []).filter((c) => c.kind === 'income').map((c) => c.name).sort()).toEqual(['Other income', 'Sales']);
});

testWithSupabase('the same category name twice in one workspace is refused, whatever the capitals', async () => {
  const { error } = await a.c.from('finance_categories').insert({ org_id: a.orgId, name: 'rent', kind: 'expense' });
  expect(error?.code).toBe('23505');
});

testWithSupabase('accounts, categories and sequences are invisible and unwritable across workspaces', async () => {
  const { data: account, error } = await a.c
    .from('finance_accounts')
    .insert({ org_id: a.orgId, name: 'Operations Account', kind: 'bank', bank_name: 'Maybank' })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();

  for (const table of ['finance_accounts', 'finance_categories', 'finance_sequences']) {
    const { data } = await b.c.from(table).select('id').eq('org_id', a.orgId);
    expect(data ?? [], table).toEqual([]);
  }
  const write = await b.c.from('finance_accounts').insert({ org_id: a.orgId, name: 'Intruder', kind: 'cash' });
  expect(write.error?.code).toBe('42501');
  const { data: changed } = await b.c.from('finance_accounts').update({ name: 'Hacked' }).eq('id', account!.id).select('id');
  expect(changed ?? []).toEqual([]);
});

testWithSupabase('document numbers count up per type with the default prefix', async () => {
  const first = await a.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'invoice' });
  const second = await a.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'invoice' });
  const quote = await a.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'quotation' });
  expect(first.error, first.error?.message).toBeNull();
  expect(first.data).toBe('INV-0001');
  expect(second.data).toBe('INV-0002');
  expect(quote.data).toBe('QT-0001');
});

testWithSupabase('two requests at the same moment never get the same number', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => a.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'receipt' })),
  );
  const numbers = results.map((r) => r.data as string);
  expect(results.every((r) => r.error === null)).toBe(true);
  expect(new Set(numbers).size).toBe(8);
});

// Needs 20261030123000_finance_write_guards.sql applied. Until then the owner's direct writes succeed, the
// account number is readable, and this test fails. (The padding of a number longer than four digits was
// tested here by planting next_number = 9999; a client can no longer plant it.)
testWithSupabase('the counters take no direct writes, and an account number is not read from the table', async () => {
  const taken = await a.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'credit_note' });
  expect(taken.error, taken.error?.message).toBeNull();
  expect(taken.data).toBe('CN-0001');

  // Even the owner: the function is the only writer.
  const planted = await a.c
    .from('finance_sequences')
    .insert({ org_id: a.orgId, doc_type: 'voucher', prefix: 'PV-', next_number: 9999 });
  expect(planted.error?.code).toBe('42501');
  const rewound = await a.c.from('finance_sequences').update({ next_number: 1 }).eq('org_id', a.orgId);
  expect(rewound.error?.code).toBe('42501');
  const removed = await a.c.from('finance_sequences').delete().eq('org_id', a.orgId);
  expect(removed.error?.code).toBe('42501');
  const { data: counters, error: readError } = await a.c
    .from('finance_sequences')
    .select('doc_type, next_number')
    .eq('org_id', a.orgId)
    .eq('doc_type', 'credit_note');
  expect(readError, readError?.message).toBeNull();
  expect(counters).toEqual([{ doc_type: 'credit_note', next_number: 2 }]);

  const { data: account, error } = await a.c
    .from('finance_accounts')
    .insert({ org_id: a.orgId, name: 'Numbered Account', kind: 'bank', bank_name: 'CIMB', account_no: '8001234567' })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();
  const direct = await a.c.from('finance_accounts').select('account_no').eq('id', account!.id);
  expect(direct.error?.code).toBe('42501');
  const named = await a.c.from('finance_accounts').select('id, name, kind, bank_name').eq('id', account!.id);
  expect(named.error, named.error?.message).toBeNull();
  // A writer of the workspace reads the numbers through the function; another workspace gets no row.
  const mine = await a.c.rpc('finance_account_numbers', { target_org: a.orgId });
  expect(mine.error, mine.error?.message).toBeNull();
  expect(mine.data).toContainEqual({ account_id: account!.id, account_no: '8001234567' });
  const theirs = await b.c.rpc('finance_account_numbers', { target_org: a.orgId });
  expect(theirs.data ?? []).toEqual([]);
});

testWithSupabase('a number cannot be taken for another workspace, or for an unknown document type', async () => {
  const other = await b.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'invoice' });
  expect(other.error?.code).toBe('42501');
  const unknown = await a.c.rpc('finance_next_number', { target_org: a.orgId, doc: 'payslip' });
  expect(unknown.error).not.toBeNull();
});

testWithSupabase('a demo viewer cannot take a number or add an account', async () => {
  const c = client();
  const { error: authErr } = await signInAnon(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: demoId, error } = await joinDemo(c);
  expect(error, error?.message).toBeNull();
  const number = await c.rpc('finance_next_number', { target_org: demoId, doc: 'invoice' });
  expect(number.error?.code).toBe('42501');
  const write = await c.from('finance_accounts').insert({ org_id: demoId, name: 'Viewer', kind: 'cash' });
  expect(write.error?.code).toBe('42501');
  const category = await c.from('finance_categories').insert({ org_id: demoId, name: 'Viewer', kind: 'expense' });
  expect(category.error?.code).toBe('42501');
  const sequence = await c.from('finance_sequences').insert({ org_id: demoId, doc_type: 'quotation', prefix: 'X-' });
  expect(sequence.error?.code).toBe('42501');
});
