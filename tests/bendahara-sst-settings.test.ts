import { expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

// SST settings per workspace, and the tax type and code on products and invoice
// lines, against the hosted database (20261124100000). Every workspace but one is
// made through tests/helpers/live-workspaces.ts, which deletes what it creates; the
// one the last test deletes itself is explained there.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Org = { c: SupabaseClient; orgId: string; customer: string };

async function workspace(orgName: string): Promise<Org> {
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, orgName);
  expect(error, error?.message).toBeNull();
  const { data: contact, error: contactErr } = await c
    .from('finance_contacts')
    .insert({ org_id: orgId, name: `Customer of ${orgName}`, is_customer: true, is_supplier: false })
    .select('id')
    .single();
  expect(contactErr, contactErr?.message).toBeNull();
  return { c, orgId: orgId as string, customer: contact!.id as string };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function product(o: Org, fields: Record<string, unknown>) {
  const { data, error } = await o.c
    .from('finance_products')
    .insert({ org_id: o.orgId, name: `Product ${Math.random()}`, ...fields })
    .select('id, tax_type, sst_code')
    .single();
  expect(error, error?.message).toBeNull();
  return data as { id: string; tax_type: string | null; sst_code: string | null };
}

async function saveInvoice(o: Org, lines: object[], id?: string) {
  const saved = await o.c.rpc('finance_save_invoice', {
    target_org: o.orgId,
    invoice: { ...(id ? { id } : {}), customer_id: o.customer, invoice_date: today(), due_date: today() },
    lines,
  });
  expect(saved.error, saved.error?.message).toBeNull();
  return saved.data as string;
}

async function lines(o: Org, invoice: string) {
  const { data, error } = await o.c
    .from('finance_invoice_lines')
    .select('id, position, tax_type, sst_code')
    .eq('invoice_id', invoice)
    .order('position');
  expect(error, error?.message).toBeNull();
  return data as { id: string; position: number; tax_type: string | null; sst_code: string | null }[];
}

async function settings(c: SupabaseClient, orgId: string) {
  const { data, error } = await c
    .from('finance_sst_settings')
    .select('period_start_month, service_tax_no, sales_tax_no, service_tax_basis')
    .eq('org_id', orgId);
  expect(error, error?.message).toBeNull();
  return data;
}

testWithSupabase('settings: an owner saves and re-saves; a member reads but cannot insert or update', async () => {
  const o = await workspace('SST Settings A Sdn Bhd');
  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'sst-settings-member-pass-123');
  const invite = await o.c.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();

  // The member cannot be the first to save them.
  const early = await m
    .from('finance_sst_settings')
    .upsert({ org_id: o.orgId, period_start_month: 3 }, { onConflict: 'org_id' })
    .select('org_id');
  expect(early.error).not.toBeNull();
  expect(await settings(o.c, o.orgId)).toEqual([]);

  const first = await o.c
    .from('finance_sst_settings')
    .upsert({ org_id: o.orgId, period_start_month: 1, service_tax_no: 'W10-1808-32000001' }, { onConflict: 'org_id' })
    .select('org_id');
  expect(first.error, first.error?.message).toBeNull();
  const again = await o.c
    .from('finance_sst_settings')
    .upsert(
      { org_id: o.orgId, period_start_month: 2, service_tax_no: 'W10-1808-32000001', sales_tax_no: 'B16-1808-32000002', service_tax_basis: 'invoice' },
      { onConflict: 'org_id' },
    )
    .select('org_id');
  expect(again.error, again.error?.message).toBeNull();
  const saved = [
    { period_start_month: 2, service_tax_no: 'W10-1808-32000001', sales_tax_no: 'B16-1808-32000002', service_tax_basis: 'invoice' },
  ];
  expect(await settings(o.c, o.orgId)).toEqual(saved);

  // The member reads them, and neither an upsert nor an update moves them.
  expect(await settings(m, o.orgId)).toEqual(saved);
  const upsert = await m
    .from('finance_sst_settings')
    .upsert({ org_id: o.orgId, period_start_month: 7 }, { onConflict: 'org_id' })
    .select('org_id');
  expect(upsert.error).not.toBeNull();
  const update = await m.from('finance_sst_settings').update({ period_start_month: 7 }).eq('org_id', o.orgId).select('org_id');
  expect(update.data ?? []).toEqual([]);
  expect(await settings(o.c, o.orgId)).toEqual(saved);
});

testWithSupabase('settings: bad values are refused', async () => {
  const o = await workspace('SST Settings B Sdn Bhd');
  const bad = [
    { period_start_month: 0 },
    { period_start_month: 13 },
    { period_start_month: 1, service_tax_basis: 'cash' },
    { period_start_month: 1, service_tax_no: '  W10 ' },
    { period_start_month: 1, sales_tax_no: 'A'.repeat(36) },
  ];
  for (const row of bad) {
    const res = await o.c.from('finance_sst_settings').insert({ org_id: o.orgId, ...row }).select('org_id');
    expect(res.error, JSON.stringify(row)).not.toBeNull();
  }
  expect(await settings(o.c, o.orgId)).toEqual([]);
});

testWithSupabase('products: tax type is proposed from the rate when not given', async () => {
  const o = await workspace('SST Settings C Sdn Bhd');
  const expected: [number, string | null][] = [
    [5, 'sales'],
    [10, 'sales'],
    [6, 'service'],
    [8, 'service'],
    [0, 'none'],
    [7, null],
  ];
  for (const [rate, type] of expected) {
    expect((await product(o, { sst_rate: rate })).tax_type, `rate ${rate}`).toBe(type);
  }
  expect((await product(o, { sst_rate: 6, tax_type: 'sales' })).tax_type).toBe('sales');
});

testWithSupabase('invoice lines: a line takes its product\'s tax type and code', async () => {
  const o = await workspace('SST Settings D Sdn Bhd');
  const p = await product(o, { sst_rate: 8, tax_type: 'service', sst_code: 'G1' });
  const id = await saveInvoice(o, [
    { product_id: p.id, description: 'Consulting', quantity: 1, unit_price: 1000, sst_rate: 8 },
    { description: 'Goods', quantity: 1, unit_price: 100, sst_rate: 10 },
  ]);
  const [withProduct, withoutProduct] = await lines(o, id);
  expect({ tax_type: withProduct.tax_type, sst_code: withProduct.sst_code }).toEqual({ tax_type: 'service', sst_code: 'G1' });
  expect({ tax_type: withoutProduct.tax_type, sst_code: withoutProduct.sst_code }).toEqual({ tax_type: 'sales', sst_code: null });
});

testWithSupabase('invoice lines: a draft re-saved after the product changed takes the new type', async () => {
  const o = await workspace('SST Settings E Sdn Bhd');
  const p = await product(o, { sst_rate: 8, tax_type: 'service', sst_code: 'G1' });
  const line = { product_id: p.id, description: 'Consulting', quantity: 1, unit_price: 1000, sst_rate: 8 };
  const id = await saveInvoice(o, [line]);
  const changed = await o.c.from('finance_products').update({ tax_type: 'sales', sst_code: 'S2' }).eq('id', p.id).select('id');
  expect(changed.error, changed.error?.message).toBeNull();
  await saveInvoice(o, [line], id);
  const [after] = await lines(o, id);
  expect({ tax_type: after.tax_type, sst_code: after.sst_code }).toEqual({ tax_type: 'sales', sst_code: 'S2' });
});

testWithSupabase('invoice lines: a posted line still refuses an update (FIN01)', async () => {
  const o = await workspace('SST Settings F Sdn Bhd');
  const id = await saveInvoice(o, [{ description: 'Goods', quantity: 1, unit_price: 100, sst_rate: 10 }]);
  const posted = await o.c.rpc('finance_post_invoice', { target_org: o.orgId, target_invoice: id });
  expect(posted.error, posted.error?.message).toBeNull();
  const [line] = await lines(o, id);
  const res = await o.c.from('finance_invoice_lines').update({ tax_type: 'none' }).eq('id', line.id).select('id');
  expect(res.error?.code).toBe('FIN01');
});

testWithSupabase('deleting the workspace removes its settings', async () => {
  // This workspace is made with the raw RPC, not createOrg, so the helper does
  // not record it: the helper's cleanup counts an already-deleted workspace as a
  // failure. It is deleted here with the same service-role function the helper
  // uses. service_role holds no grant on finance_sst_settings, so the proof is
  // the delete itself: with a settings row present, the workspace delete only
  // goes through if the row is deleted with it (on delete cascade); without the
  // cascade it fails on the foreign key and returns an error. The owner user is
  // recorded by signInOwner and cleaned up by the helper.
  const c = liveClient();
  const { error: authErr } = await signInOwner(c);
  expect(authErr, authErr?.message).toBeNull();
  const made = await c.rpc('create_org_for_current_user', { org_name: 'SST Settings G Sdn Bhd' });
  expect(made.error, made.error?.message).toBeNull();
  const orgId = made.data as string;
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let deleted = false;
  try {
    const saved = await c.from('finance_sst_settings').insert({ org_id: orgId, period_start_month: 1 }).select('org_id');
    expect(saved.error, saved.error?.message).toBeNull();
    expect(await settings(c, orgId)).toHaveLength(1);
  } finally {
    const res = await service.rpc('delete_test_org', { p_id: orgId });
    expect(res.error, res.error?.message).toBeNull();
    deleted = res.data === true;
  }
  expect(deleted).toBe(true);
  expect(await settings(c, orgId)).toEqual([]);
});
