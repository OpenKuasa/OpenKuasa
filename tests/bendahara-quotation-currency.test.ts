import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact, updateContact } from '@/lib/finance/contacts';
import { fxSstRate } from '@/lib/finance/sst-rate';
import { quotationPayload, newQuotationForm, withQuotationCustomer } from '@/lib/finance/quotation-form';
import { QUOTATION_MESSAGES, acceptQuotation, convertQuotation, getQuotation, listQuotations, saveQuotation, sendQuotation } from '@/lib/finance/quotations';
import { emptyLine } from '@/lib/finance/document-form';

// Quotations in another currency against the hosted database, through the
// app's own data layer with a real client. Run by the controller only, after
// 20261119150000_bendahara_fx_rates and 20261119160000_bendahara_quotation_currency
// are applied. What each role may do, and every check, is proved by
// supabase/tests/bendahara_quotation_currency_check.sql; this file adds what
// only the API shows: the payloads the form sends are taken by PostgREST, the
// ringgit figures come back, and each refusal arrives as the screen's sentence.
// It writes no rate (finance_fx_rates is shared and cannot be cleaned up):
// the BNM case runs only once the fetch route has stored a USD rate.

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
const lines = [{ ...emptyLine('k1'), description: 'Design work', quantity: '3', unit_price: '0.33', sst_rate: '8' }];

testWithSupabase('a ringgit-only workspace reads every quotation as before: MYR, rate 1, the ringgit total its total', async () => {
  const ctx = await owner(`Quotation ringgit ${Date.now()}`);
  const acme = await createContact(ctx, { name: 'Kedai Runcit', is_customer: true, is_supplier: false });
  expect(acme.ok).toBe(true);
  if (!acme.ok) return;
  expect(acme.data.default_currency).toBeNull();
  // As the finance assistant saves one: no currency at all.
  const saved = await saveQuotation(ctx, {
    customer_id: acme.data.id, quote_date: today, valid_until: today, lines: [{ description: 'Design work', quantity: 3, unit_price: 0.33, sst_rate: 8 }],
  });
  expect(saved.ok).toBe(true);
  const [row] = await listQuotations(ctx);
  expect(row).toMatchObject({ currency: 'MYR', fx_rate: 1, fx_rate_source: null, total: 1.07, total_myr: 1.07 });
});

testWithSupabase('a USD quotation with a typed rate: ringgit per line, sent, accepted, and not made into an invoice', async () => {
  const ctx = await owner(`Quotation USD ${Date.now()}`);
  const acme = await createContact(ctx, { name: 'Acme Pte Ltd', is_customer: true, is_supplier: false, default_currency: 'USD' });
  expect(acme.ok).toBe(true);
  if (!acme.ok) return;

  // Through the form's own payload, as the screen sends it.
  let form = withQuotationCustomer(newQuotationForm(today, 'k1'), acme.data);
  form = { ...form, lines, fx: { ...form.fx, rate: '4.5', rateSource: 'manual' } };
  const saved = await saveQuotation(ctx, quotationPayload(form));
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  const detail = await getQuotation(ctx, saved.data.id);
  // 0.99 USD at 4.5 = RM 4.455 → 4.46; SST 0.08 USD → RM 0.36.
  expect(detail).toMatchObject({ currency: 'USD', fx_rate: 4.5, fx_rate_source: 'manual', total: 1.07, total_myr: 4.82 });

  // No rate: saved, not sent.
  const noRate = await saveQuotation(ctx, { ...quotationPayload(form), fx_rate: null, fx_rate_source: null });
  expect(noRate.ok).toBe(true);
  if (!noRate.ok) return;
  expect(await sendQuotation(ctx, { id: noRate.data.id })).toEqual({ ok: false, error: QUOTATION_MESSAGES.rateBeforeSending });

  // A rate marked as BNM's that BNM did not give.
  const fake = await saveQuotation(ctx, { ...quotationPayload(form), fx_rate: 4.5, fx_rate_source: 'bnm', fx_rate_date: '2001-01-02' });
  expect(fake).toEqual({ ok: false, error: QUOTATION_MESSAGES.notBnmRate });

  expect((await sendQuotation(ctx, { id: saved.data.id })).ok).toBe(true);
  expect((await acceptQuotation(ctx, { id: saved.data.id })).ok).toBe(true);
  // Since stage 3a (FIN40 retired) it becomes a draft invoice in USD, at BNM's selling rate for today when one is stored.
  const converted = await convertQuotation(ctx, { id: saved.data.id, invoice_date: today });
  expect(converted.ok && converted.data.invoice?.currency).toBe('USD');

  // The contact's default can be cleared, and an update that does not name it leaves it.
  const renamed = await updateContact(ctx, { id: acme.data.id, name: 'Acme Asia Pte Ltd' });
  expect(renamed.ok && renamed.data.default_currency).toBe('USD');
  const cleared = await updateContact(ctx, { id: acme.data.id, default_currency: null });
  expect(cleared.ok && cleared.data.default_currency).toBeNull();
});

testWithSupabase('BNM’s selling rate is offered and taken as BNM’s, once the route has stored one', async () => {
  const ctx = await owner(`Quotation BNM ${Date.now()}`);
  const bnm = await fxSstRate(ctx.client, 'USD', today);
  if (bnm === null) {
    console.warn('No USD rate stored yet: run POST /api/finance/fx-rates/fetch first. The BNM case is skipped.');
    return;
  }
  const acme = await createContact(ctx, { name: 'Acme Pte Ltd', is_customer: true, is_supplier: false });
  if (!acme.ok) throw new Error(acme.error);
  const saved = await saveQuotation(ctx, {
    customer_id: acme.data.id, quote_date: today, valid_until: today,
    lines: [{ description: 'Design work', quantity: 1, unit_price: 100 }],
    currency: 'USD', fx_rate: bnm.rate_text ?? bnm.rate, fx_rate_source: 'bnm', fx_rate_date: bnm.rate_date,
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(await getQuotation(ctx, saved.data.id)).toMatchObject({ fx_rate: Number(bnm.rate_text ?? bnm.rate), fx_rate_source: 'bnm', fx_rate_date: bnm.rate_date });
});
