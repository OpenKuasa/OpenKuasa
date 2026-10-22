import { expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, liveClient, signInOwner } from './helpers/live-workspaces';
import { createContact } from '@/lib/finance/contacts';
import { issueCreditNote, saveCreditNote } from '@/lib/finance/credit-notes';
import { emptyLine } from '@/lib/finance/document-form';
import { withRateProvider, withRateTyped } from '@/lib/finance/document-currency';
import { invoicePayload, newInvoiceForm, withCustomer } from '@/lib/finance/invoice-form';
import { postInvoice, saveInvoice, voidInvoice } from '@/lib/finance/invoices';
import { sstPeriodFor } from '@/lib/finance/sst';
import { buildSstReturn } from '@/lib/finance/sst-return';
import {
  SST_FIGURES_FILED,
  listSstFigures,
  listSstFiled,
  markSstReturnFiled,
  readSstRows,
  saveSstFigures,
  sstFiguresInput,
  unmarkSstReturnFiled,
} from '@/lib/finance/sst-return-data';
import { todayInMalaysia } from '@/lib/people/dates';

// The rows an SST-02 return is built from, read from the hosted database (#222 stage 2) through the app's own
// data layer, and marking a return filed (20261125090300_bendahara_sst_returns.sql). Every workspace is made
// through tests/helpers/live-workspaces.ts, which deletes what it creates. It writes no rate (finance_fx_rates
// is shared): the USD invoice's rate is typed by hand, from Reuters, as the FX tests do.

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

// Dated in Malaysia, as the void date is, so the voided invoice is dated and voided in the same period.
const today = todayInMalaysia(new Date());

async function postedRinggit(ctx: Ctx, customer: string, lines: { description: string; unit_price: number; sst_rate: number }[]) {
  const saved = await saveInvoice(ctx, {
    customer_id: customer, invoice_date: today, due_date: today,
    lines: lines.map((l) => ({ ...l, quantity: 1 })),
  });
  if (!saved.ok) throw new Error(saved.error);
  const posted = await postInvoice(ctx, { id: saved.data.id });
  expect(posted.ok, posted.ok ? '' : posted.error).toBe(true);
  return saved.data.id;
}

testWithSupabase('a service tax return from posted, foreign, voided and credited invoices', async () => {
  const ctx = await owner(`SST return ${Date.now()}`);
  const kedai = await createContact(ctx, { name: 'Kedai Runcit', is_customer: true, is_supplier: false });
  if (!kedai.ok) throw new Error(kedai.error);

  // RM 1,000.00 at 6% (60.00) and RM 500.00 at 8% (40.00): RM 1,600.00 in all, RM 100.00 service tax.
  const ringgit = await postedRinggit(ctx, kedai.data.id, [
    { description: 'Repairs', unit_price: 1000, sst_rate: 6 },
    { description: 'Consulting', unit_price: 500, sst_rate: 8 },
  ]);

  // USD 1,000.00 at 8%, typed at 4.2000: RM 4,200.00 and RM 336.00 tax.
  const acme = await createContact(ctx, { name: 'Acme Pte Ltd', is_customer: true, is_supplier: false, default_currency: 'USD' });
  if (!acme.ok) throw new Error(acme.error);
  let form = withCustomer(newInvoiceForm(today, 'k1'), { id: acme.data.id, payment_terms_days: 30, default_currency: 'USD' });
  form = {
    ...form,
    lines: [{ ...emptyLine('k1'), description: 'Consulting', quantity: '1', unit_price: '1000', sst_rate: '8' }],
    fx: withRateProvider(withRateTyped(form.fx, '4.2000'), 'reuters'),
  };
  const usd = await saveInvoice(ctx, invoicePayload(form));
  if (!usd.ok) throw new Error(usd.error);
  expect((await postInvoice(ctx, { id: usd.data.id })).ok).toBe(true);

  // RM 200.00 at 6%, posted then voided today: dated and voided in the same period, so it counts nowhere.
  const voided = await postedRinggit(ctx, kedai.data.id, [{ description: 'Cancelled', unit_price: 200, sst_rate: 6 }]);
  const voidedResult = await voidInvoice(ctx, { id: voided });
  expect(voidedResult.ok, voidedResult.ok ? '' : voidedResult.error).toBe(true);

  // RM 160.00 credited on the ringgit invoice: 160 × 100 ÷ 1,600 = RM 10.00 service tax back.
  const note = await saveCreditNote(ctx, { invoice_id: ringgit, credit_date: today, reason: 'returns', amount: 160 });
  if (!note.ok) throw new Error(note.error);
  const issued = await issueCreditNote(ctx, { id: note.data.id });
  expect(issued.ok, issued.ok ? '' : issued.error).toBe(true);

  const period = sstPeriodFor(today, 1);
  const rows = await readSstRows(ctx, period);
  expect(rows.lines).toHaveLength(4);
  const cancelled = rows.lines.find((l) => l.invoice_id === voided);
  expect(cancelled).toMatchObject({ invoice_status: 'void', voided_on: today });
  expect(rows.lines.find((l) => l.invoice_id === usd.data.id)).toMatchObject({ amount_myr: 4200, sst_amount_myr: 336 });
  expect(rows.credits).toEqual([
    {
      id: note.data.id, credit_date: today, status: 'issued', voided_on: null, amount_myr: 160,
      invoice_total_myr: 1600, invoice_sst_myr: { service: 100, sales: 0 },
    },
  ]);

  const r = buildSstReturn('service', period, rows.lines, rows.credits);
  expect(r.b2.slice(0, 2)).toEqual([
    { item: '11(c)', label: 'Service tax 6%', value: 1000, tax: 60 },
    { item: '11(d)', label: 'Service tax 8%', value: 4700, tax: 376 },
  ]);
  expect(r.item12).toBe(436);
  expect(r.deductions[0]).toMatchObject({ item: '13(a)', tax: 10 });
  expect(r.item14).toBe(426);
});

testWithSupabase('an owner marks a past return filed once, and can take the mark off', async () => {
  const ctx = await owner(`SST filed ${Date.now()}`);
  expect(await markSstReturnFiled(ctx, { type: 'service', period_start: '2024-01-01' }, '2024-03-10')).toEqual({ ok: true });
  // Marked again later: ok, and the first date stays.
  expect(await markSstReturnFiled(ctx, { type: 'service', period_start: '2024-01-01' }, today)).toEqual({ ok: true });
  expect(await listSstFiled(ctx, 'service')).toEqual({ '2024-01-01': '2024-03-10' });
  expect(await listSstFiled(ctx, 'sales')).toEqual({});
  expect(await unmarkSstReturnFiled(ctx, { type: 'service', period_start: '2024-01-01' })).toEqual({ ok: true });
  expect(await listSstFiled(ctx, 'service')).toEqual({});
});

// Stage 5 (20261125090400_bendahara_sst_return_figures.sql): runs once that migration is applied on hosted.
testWithSupabase('typed-in figures count in item 14, stay with their own type, and are locked while filed', async () => {
  const ctx = await owner(`SST figures ${Date.now()}`);
  const key = { type: 'service', period_start: '2024-01-01' } as const;
  const save = (raw: Record<string, unknown>) => saveSstFigures(ctx, sstFiguresInput.parse(raw));

  // 4 cards (RM 100.00 in 11(e), so item 12), 13(c) RM 30.50 and 13(d) RM 9.50.
  expect(await save({ ...key, cards_11e: '4', deduction_13c: '30.50', bad_debt_13d: '9.50' })).toEqual({ ok: true });
  // The sales return of the same period has its own figures, which never reach the service return.
  expect(await save({ type: 'sales', period_start: '2024-01-01', deduction_13b: '7', adjustment_13a: '1.25', bad_debt_13d: '2' }))
    .toEqual({ ok: true });

  const service = await listSstFigures(ctx, 'service');
  expect(service).toEqual({ '2024-01-01': { cards11e: 4, deduction13b: 0, deduction13c: 30.5, badDebt13d: 9.5, adjustment13a: 0 } });
  expect(await listSstFigures(ctx, 'sales')).toEqual({
    '2024-01-01': { cards11e: 0, deduction13b: 7, deduction13c: 0, badDebt13d: 2, adjustment13a: 1.25 },
  });

  // No invoices: item 12 = 4 × RM 25.00 = 100.00; item 14 = 100.00 − 0 − 30.50 − 9.50 = 60.00.
  const period = sstPeriodFor('2024-01-01', 1);
  const rows = await readSstRows(ctx, period);
  const r = buildSstReturn('service', period, rows.lines, rows.credits, service['2024-01-01']);
  expect(r.item12).toBe(100);
  expect(r.item14).toBe(60);

  // Saving again updates in place.
  expect(await save({ ...key, cards_11e: 2 })).toEqual({ ok: true });
  expect((await listSstFigures(ctx, 'service'))['2024-01-01']).toEqual({
    cards11e: 2, deduction13b: 0, deduction13c: 0, badDebt13d: 0, adjustment13a: 0,
  });

  // Marked filed: saving is refused and nothing changes. Undo the mark and it saves again.
  expect(await markSstReturnFiled(ctx, key, '2024-03-10')).toEqual({ ok: true });
  expect(await save({ ...key, cards_11e: 9 })).toEqual({ ok: false, error: SST_FIGURES_FILED });
  expect((await listSstFigures(ctx, 'service'))['2024-01-01'].cards11e).toBe(2);
  expect(await unmarkSstReturnFiled(ctx, key)).toEqual({ ok: true });
  expect(await save({ ...key, cards_11e: 9 })).toEqual({ ok: true });
  expect((await listSstFigures(ctx, 'service'))['2024-01-01'].cards11e).toBe(9);
});
