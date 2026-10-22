import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact } from '@/lib/finance/contacts';
import { postInvoice } from '@/lib/finance/invoices';

// A discount on the whole invoice (#272) against the hosted database. Run by the controller only, after
// 20261125110000_bendahara_document_discount and 20261125110100_bendahara_document_discount_saves are
// applied. The split, the refusals and conversion are proved by
// supabase/tests/bendahara_document_discount_check.sql; this file adds what only the API shows: the save
// RPC takes the discount through PostgREST, the totals view reads the lines after their shares, and the
// ledger posted from them sums to the same.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Ctx = { client: SupabaseClient; orgId: string };

async function owner(orgName: string): Promise<Ctx> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  return { client: c, orgId: orgId as string };
}

const today = new Date().toISOString().slice(0, 10);
const lines = [
  { description: 'A', quantity: 1, unit_price: 100, sst_rate: 8 },
  { description: 'B', quantity: 1, unit_price: 50, sst_rate: 6 },
  { description: 'C', quantity: 1, unit_price: 0.01, sst_rate: 0 },
];

testWithSupabase('an invoice saved with 10% off the whole: totals after the shares, and a ledger that agrees', async () => {
  const ctx = await owner(`Document discount ${Date.now()}`);
  const acme = await createContact(ctx, { name: 'Kedai Diskaun', is_customer: true, is_supplier: false });
  if (!acme.ok) throw new Error(acme.error);

  const { data: id, error } = await ctx.client.rpc('finance_save_invoice', {
    target_org: ctx.orgId,
    invoice: { customer_id: acme.data.id, invoice_date: today, due_date: today, doc_discount_pct: 10 },
    lines,
  });
  expect(error, error?.message).toBeNull();

  const { data: shares, error: sharesError } = await ctx.client
    .from('finance_invoice_lines')
    .select('position, doc_discount_share, amount, sst_amount')
    .eq('invoice_id', id)
    .order('position');
  expect(sharesError, sharesError?.message).toBeNull();
  expect((shares ?? []).map((l) => [Number(l.doc_discount_share), Number(l.amount), Number(l.sst_amount)])).toEqual([
    [10, 90, 7.2],
    [5, 45, 2.7],
    [0, 0.01, 0],
  ]);

  // Σ amount after the shares = 135.01, SST 7.20 + 2.70 = 9.90, total 144.91.
  const { data: totals, error: totalsError } = await ctx.client
    .from('finance_invoice_totals')
    .select('subtotal, sst, total')
    .eq('id', id)
    .single();
  expect(totalsError, totalsError?.message).toBeNull();
  expect(Number(totals?.subtotal)).toBe(135.01);
  expect(Number(totals?.sst)).toBe(9.9);
  expect(Number(totals?.total)).toBe(144.91);

  // A save that does not name the discount keeps it.
  const { error: againError } = await ctx.client.rpc('finance_save_invoice', {
    target_org: ctx.orgId,
    invoice: { id, customer_id: acme.data.id, invoice_date: today, due_date: today },
    lines,
  });
  expect(againError, againError?.message).toBeNull();
  const { data: kept } = await ctx.client.from('finance_invoices').select('doc_discount_pct').eq('id', id).single();
  expect(Number(kept?.doc_discount_pct)).toBe(10);

  // A discount that takes everything is refused with FIN62.
  const { error: fin62 } = await ctx.client.rpc('finance_save_invoice', {
    target_org: ctx.orgId,
    invoice: { customer_id: acme.data.id, invoice_date: today, due_date: today, doc_discount_amount: 150.01 },
    lines,
  });
  expect(fin62).not.toBeNull();
  expect(fin62?.code).toBe('FIN62');

  const posted = await postInvoice(ctx, { id: id as string });
  expect(posted.ok).toBe(true);

  // The ledger for it sums to the same figures, in sen.
  const { data: ledger, error: ledgerError } = await ctx.client
    .from('finance_ledger_lines')
    .select('account_id, debit, credit')
    .eq('org_id', ctx.orgId)
    .eq('source', 'invoice')
    .eq('source_id', id);
  expect(ledgerError, ledgerError?.message).toBeNull();
  const { data: accounts, error: accountsError } = await ctx.client
    .from('finance_ledger_accounts')
    .select('id, system_key')
    .eq('org_id', ctx.orgId);
  expect(accountsError, accountsError?.message).toBeNull();
  const keyOf = new Map(((accounts ?? []) as { id: string; system_key: string | null }[]).map((a) => [a.id, a.system_key]));
  const rows = (ledger ?? []) as { account_id: string; debit: string; credit: string }[];
  const on = (key: string | null, side: 'debit' | 'credit') =>
    rows.filter((r) => (keyOf.get(r.account_id) ?? null) === key).reduce((n, r) => n + Math.round(Number(r[side]) * 100), 0) / 100;
  expect(on('receivable', 'debit')).toBe(144.91);
  expect(on(null, 'credit')).toBe(135.01);
  expect(on('sst_payable', 'credit')).toBe(9.9);
});
