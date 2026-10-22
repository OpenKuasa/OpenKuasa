import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceFormCard } from '@/components/finance/invoice-form-card';
import { QuotationFormCard } from '@/components/finance/quotation-form-card';
import { DOC_DISCOUNT_LEAVES_NOTHING } from '@/lib/finance/bill-math';
import type { FinanceContact } from '@/lib/finance/contacts';
import { ringgitTotal, wholeUnitsError } from '@/lib/finance/document-currency';
import { type LineDraft, docDiscountProblem, emptyLine } from '@/lib/finance/document-form';
import { DOC_DISCOUNT_MESSAGES } from '@/lib/finance/document-lines';
import { type InvoiceForm, invoiceFormError, invoiceFormFromDetail, invoicePayload, newInvoiceForm } from '@/lib/finance/invoice-form';
import {
  type InvoiceDetail,
  getInvoice,
  saveInvoice,
  saveInvoiceInRinggit,
  saveInvoiceInput,
  saveInvoiceToolInput,
} from '@/lib/finance/invoices';
import { newQuotationForm, quotationFormError, quotationPayload } from '@/lib/finance/quotation-form';
import {
  type QuotationDetail,
  convertQuotation,
  getQuotation,
  saveQuotation,
  saveQuotationInRinggit,
  saveQuotationInput,
  saveQuotationToolInput,
} from '@/lib/finance/quotations';
import { fakeFinance } from './setup/fake-finance';
import { ringgitRow } from './helpers/invoice-rows';

const ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

/** Case 2 of the plan: 100.00 @ 8%, 50.00 @ 6%, 0.01 @ 0%. With 10% off, D = 15.00 and the shares 10.00 / 5.00 / 0.00. */
const caseTwo: LineDraft[] = [
  { ...emptyLine('k1'), description: 'Consulting', unit_price: '100', sst_rate: '8' },
  { ...emptyLine('k2'), description: 'Training', unit_price: '50', sst_rate: '6' },
  { ...emptyLine('k3'), description: 'Stamp', unit_price: '0.01', sst_rate: '0' },
];

const invoiceForm = (f: Partial<InvoiceForm> = {}): InvoiceForm => ({
  ...newInvoiceForm('2026-10-22', 'k1'),
  customer_id: CUSTOMER,
  due_date: '2026-11-21',
  lines: caseTwo,
  ...f,
});

const schemaLine = { description: 'Design work', quantity: 10, unit_price: 12.5 };
const invoice = { customer_id: CUSTOMER, invoice_date: '2026-10-01', due_date: '2026-10-31', lines: [schemaLine] };
const quotation = { customer_id: CUSTOMER, quote_date: '2026-10-01', valid_until: '2026-10-31', lines: [schemaLine] };
const firstIssue = (r: { error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;

describe('the discount on the whole document, in the form schemas', () => {
  it.each([
    ['invoice', saveInvoiceInput, invoice],
    ['quotation', saveQuotationInput, quotation],
  ] as const)('the %s schema refuses 101 per cent, 0, both set and 0.001', (_name, schema, base) => {
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_pct: 101 }))).toBe(DOC_DISCOUNT_MESSAGES.pct);
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_pct: 0 }))).toBe(DOC_DISCOUNT_MESSAGES.pct);
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_amount: 0 }))).toBe(DOC_DISCOUNT_MESSAGES.amount);
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_pct: 0.001 }))).toBe(DOC_DISCOUNT_MESSAGES.pct);
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_amount: 0.001 }))).toBe(DOC_DISCOUNT_MESSAGES.amount);
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_pct: 10, doc_discount_amount: 5 }))).toBe(DOC_DISCOUNT_MESSAGES.both);
  });

  it.each([
    ['invoice', saveInvoiceInput, invoice],
    ['quotation', saveQuotationInput, quotation],
  ] as const)('the %s schema takes 100 per cent only when something is left, and keeps absent keys absent', (_name, schema, base) => {
    expect(schema.safeParse({ ...base, doc_discount_pct: 12.5 }).success).toBe(true);
    expect(schema.safeParse({ ...base, doc_discount_pct: null, doc_discount_amount: null }).success).toBe(true);
    // 10 x 12.50 = 125.00: 100% or RM 125 leaves nothing to pay.
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_pct: 100 }))).toBe(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(firstIssue(schema.safeParse({ ...base, doc_discount_amount: 125 }))).toBe(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(schema.safeParse({ ...base, doc_discount_amount: 124.99 }).success).toBe(true);
    // Absent means "keep the stored discount": the parsed value must not carry the keys.
    const parsed = schema.parse(base) as Record<string, unknown>;
    expect('doc_discount_pct' in parsed).toBe(false);
    expect('doc_discount_amount' in parsed).toBe(false);
  });

  it('refuses a fixed discount with decimals in a currency with no cents, as line prices are', () => {
    const yen = { ...invoice, currency: 'JPY', fx_rate: '0.0310', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank', fx_rate_reference: 'Maybank', lines: [{ ...schemaLine, unit_price: 1000 }] };
    expect(saveInvoiceInput.safeParse({ ...yen, doc_discount_amount: 500 }).success).toBe(true);
    expect(firstIssue(saveInvoiceInput.safeParse({ ...yen, doc_discount_amount: 500.5 }))).toBe('JPY has no cents: enter whole amounts.');
    expect(firstIssue(saveQuotationInput.safeParse({ ...quotation, currency: 'JPY', fx_rate: null, lines: [{ ...schemaLine, unit_price: 1000 }], doc_discount_amount: 0.5 }))).toBe(
      'JPY has no cents: enter whole amounts.',
    );
    expect(wholeUnitsError('JPY', [{ unit_price: 1000 }], 12.5)).toBe('JPY has no cents: enter whole amounts.');
    expect(wholeUnitsError('JPY', [{ unit_price: 1000 }], null)).toBeNull();
  });
});

describe("the assistant's tool schemas", () => {
  it('do not contain the discount on the whole document', () => {
    expect(Object.keys(saveInvoiceToolInput.shape)).not.toContain('doc_discount_pct');
    expect(Object.keys(saveInvoiceToolInput.shape)).not.toContain('doc_discount_amount');
    expect(Object.keys(saveQuotationToolInput.shape)).not.toContain('doc_discount_pct');
    expect(Object.keys(saveQuotationToolInput.shape)).not.toContain('doc_discount_amount');
  });

  it('send no discount keys to the save, so a draft keeps its stored discount, even when the call carries them', async () => {
    const inv = fakeFinance((call) => ({ data: call.kind === 'rpc' ? ID : { currency: 'MYR' }, error: null }));
    expect(await saveInvoiceInRinggit(inv.ctx, { ...invoice, id: ID, doc_discount_pct: 50 })).toEqual({ ok: true, data: { id: ID } });
    const sentInvoice = inv.calls.find((c) => c.kind === 'rpc')!.args!.invoice as object;
    expect(Object.keys(sentInvoice)).not.toContain('doc_discount_pct');
    expect(Object.keys(sentInvoice)).not.toContain('doc_discount_amount');

    const quo = fakeFinance((call) => ({ data: call.kind === 'rpc' ? ID : { currency: 'MYR' }, error: null }));
    expect(await saveQuotationInRinggit(quo.ctx, { ...quotation, id: ID, doc_discount_amount: 5 })).toEqual({ ok: true, data: { id: ID } });
    const sentQuotation = quo.calls.find((c) => c.kind === 'rpc')!.args!.quotation as object;
    expect(Object.keys(sentQuotation)).not.toContain('doc_discount_pct');
    expect(Object.keys(sentQuotation)).not.toContain('doc_discount_amount');
  });
});

describe('the form payloads', () => {
  it('always carry both keys: the value and null, or two nulls', () => {
    const none = invoicePayload(invoiceForm());
    expect(none).toMatchObject({ doc_discount_pct: null, doc_discount_amount: null });
    expect(invoicePayload(invoiceForm({ docDiscount: { pct: '10', amount: '' } }))).toMatchObject({ doc_discount_pct: 10, doc_discount_amount: null });
    expect(invoicePayload(invoiceForm({ docDiscount: { pct: '', amount: '20.50' } }))).toMatchObject({ doc_discount_pct: null, doc_discount_amount: 20.5 });

    const q = { ...newQuotationForm('2026-10-22', 'k1'), customer_id: CUSTOMER, lines: caseTwo };
    expect(quotationPayload(q)).toMatchObject({ doc_discount_pct: null, doc_discount_amount: null });
    expect('doc_discount_pct' in quotationPayload(q) && 'doc_discount_amount' in quotationPayload(q)).toBe(true);
    expect(quotationPayload({ ...q, docDiscount: { pct: '10', amount: '' } })).toMatchObject({ doc_discount_pct: 10, doc_discount_amount: null });
  });

  it('block a save whose discount leaves nothing, with the database sentence', () => {
    expect(invoiceFormError(invoiceForm({ docDiscount: { pct: '10', amount: '' } }))).toBeNull();
    expect(invoiceFormError(invoiceForm({ docDiscount: { pct: '100', amount: '' } }))).toBe(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(invoiceFormError(invoiceForm({ docDiscount: { pct: '', amount: '150.01' } }))).toBe(DOC_DISCOUNT_LEAVES_NOTHING);
    const q = { ...newQuotationForm('2026-10-22', 'k1'), customer_id: CUSTOMER, lines: caseTwo };
    expect(quotationFormError({ ...q, docDiscount: { pct: '', amount: '200' } })).toBe(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(quotationFormError({ ...q, docDiscount: { pct: '', amount: '15' } })).toBeNull();
  });

  it('give the foreign total in ringgit after the shares, as amount_myr adds up', () => {
    const usd = { ...invoiceForm().fx, currency: 'USD', rate: '4.2' };
    // 100.00 USD @ 8% with 10% off: amount 90.00, SST 7.20; at 4.2: 378.00 + 30.24.
    const lines = [{ ...emptyLine('k1'), description: 'Licence', unit_price: '100', sst_rate: '8' }];
    expect(ringgitTotal(usd, lines, { pct: 10, amount: null })).toBe(408.24);
    expect(ringgitTotal(usd, lines)).toBe(453.6);
  });
});

const maju: FinanceContact = {
  id: CUSTOMER,
  name: 'Maju Sdn Bhd',
  is_customer: true,
  is_supplier: false,
  email: null,
  phone: null,
  ssm_no: null,
  tin: null,
  payment_terms_days: 30,
  active: true,
  default_currency: null,
};

const savedLine = (id: string, unit_price: number, sst_rate: number, amount: number, sst_amount: number, share: number) => ({
  id, product_id: null, description: id, quantity: 1, uom: null, pack_size: null, unit_price, sst_rate, amount, sst_amount,
  discount_pct: null, discount_amount: null, doc_discount_share: share,
});

/** The case 2 draft as the read gives it: line amounts after their shares, the subtotal before them. */
const draft = (pct: number | null): InvoiceDetail => ({
  ...ringgitRow({
    id: ID, invoice_no: null, customer_id: CUSTOMER, customer_name: 'Maju Sdn Bhd', invoice_date: '2026-10-22', due_date: '2026-11-21',
    total: 144.91, paid: 0, credited: 0, refunded: 0, balance: 144.91, display_status: 'draft', einvoice_status: 'none', einvoice_uuid: null,
  }),
  subtotal: 150.01,
  doc_discount_pct: pct,
  doc_discount_amount: null,
  doc_discount: 15,
  sst: 9.9,
  notes: null,
  lines: [savedLine('l1', 100, 8, 90, 7.2, 10), savedLine('l2', 50, 6, 45, 2.7, 5), savedLine('l3', 0.01, 0, 0.01, 0, 0)],
});

const actions = {
  save: async () => ({ ok: true as const, data: { id: 'x' } }),
  saveAndPost: async () => {
    throw new Error('not called');
  },
  fxRate: async () => ({ ok: true as const, data: null }),
};

const card = (detail: InvoiceDetail) =>
  renderToStaticMarkup(
    <InvoiceFormCard editing={detail} customers={[maju]} products={[]} today="2026-10-22" actions={actions} onClose={() => {}} />,
  );

describe('the invoice form with a discount on the whole invoice', () => {
  it('opens a saved draft with its discount, and its lines at their own prices', () => {
    const form = invoiceFormFromDetail(draft(10));
    expect(form.docDiscount).toEqual({ pct: '10', amount: '' });
    expect(form.lines.map((l) => l.unit_price)).toEqual(['100', '50', '0.01']);
  });

  it('shows the field and "Less: discount 10%" with the case 2 figures', () => {
    const out = card(draft(10));
    expect(out).toContain('Discount on the whole invoice');
    expect(out).toContain('Less: discount 10%');
    expect(out).toContain('RM 150.01'); // subtotal
    expect(out).toContain('−RM 15.00'); // D
    expect(out).toContain('RM 9.90'); // SST: 7.20 + 2.70 + 0.00
    expect(out).toContain('RM 144.91'); // total
    expect(out).not.toContain(DOC_DISCOUNT_LEAVES_NOTHING);
  });

  it('shows no "Less: discount" line when there is no discount', () => {
    const out = card({ ...draft(null), doc_discount: 0 });
    expect(out).toContain('Discount on the whole invoice');
    expect(out).not.toContain('Less: discount');
  });

  it('says beside the field when the discount leaves nothing to pay', () => {
    const out = card(draft(100));
    expect(out).toContain(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(out).toMatch(/<p[^>]*role="alert"[^>]*>[^<]*A discount on the whole document must leave something to pay/);
  });

  it('says the range, not "nothing to pay", for a percentage out of range', () => {
    const out = card(draft(150));
    expect(out).toContain(DOC_DISCOUNT_MESSAGES.pct);
    expect(out).not.toContain(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(out).toMatch(/<p[^>]*role="alert"[^>]*>Enter a discount on the whole document above 0%/);
  });

  it('docDiscountProblem: range message out of range, FIN62 sentence only when in range', () => {
    const lines = invoiceFormFromDetail(draft(null)).lines;
    const problem = (pct: string, amount = '') => docDiscountProblem(lines, { pct, amount });
    for (const pct of ['150', '100.01', '-5', '10.005']) expect(problem(pct)).toBe(DOC_DISCOUNT_MESSAGES.pct);
    expect(problem('100')).toBe(DOC_DISCOUNT_LEAVES_NOTHING);
    expect(problem('10')).toBeNull();
    expect(problem('')).toBeNull();
  });

  it('is the quotation form too, in its own word', () => {
    const quotationDraft: QuotationDetail = {
      id: ID, quotation_no: null, customer_id: CUSTOMER, customer_name: 'Maju Sdn Bhd', quote_date: '2026-10-22', valid_until: '2026-11-21',
      total: 144.91, display_status: 'draft', accepted_on: null, invoice_id: null, invoice_no: null, currency: 'MYR', fx_rate: 1,
      fx_rate_source: null, fx_rate_date: null, total_myr: 144.91, subtotal: 150.01, doc_discount_pct: null, doc_discount_amount: 15,
      doc_discount: 15, sst: 9.9, notes: null, lines: draft(10).lines,
    };
    const out = renderToStaticMarkup(
      <QuotationFormCard editing={quotationDraft} customers={[maju]} products={[]} today="2026-10-22" actions={actions} onClose={() => {}} />,
    );
    expect(out).toContain('Discount on the whole quotation');
    expect(out).toMatch(/Less: discount<\/dt>/); // a fixed amount carries no percentage
    expect(out).toContain('−RM 15.00');
    expect(out).toContain('RM 144.91');
  });
});

describe('the database refusal', () => {
  it('turns FIN62 into the same sentence, on save and on convert', async () => {
    const inv = fakeFinance({ data: null, error: { code: 'FIN62' } });
    expect(await saveInvoice(inv.ctx, invoice)).toEqual({ ok: false, error: DOC_DISCOUNT_LEAVES_NOTHING });
    const quo = fakeFinance({ data: null, error: { code: 'FIN62' } });
    expect(await saveQuotation(quo.ctx, quotation)).toEqual({ ok: false, error: DOC_DISCOUNT_LEAVES_NOTHING });
    expect(await convertQuotation(quo.ctx, { id: ID, invoice_date: '2026-10-22' })).toEqual({ ok: false, error: DOC_DISCOUNT_LEAVES_NOTHING });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('the reads', () => {
  const lines = [
    { id: 'l1', product_id: null, description: 'a', quantity: '1.000', uom: null, pack_size: null, unit_price: '100.0000', sst_rate: '8.00', amount: '90.00', sst_amount: '7.20', discount_pct: null, discount_amount: null, doc_discount_share: '10.00' },
    { id: 'l2', product_id: null, description: 'b', quantity: '1.000', uom: null, pack_size: null, unit_price: '50.0000', sst_rate: '6.00', amount: '45.00', sst_amount: '2.70', discount_pct: null, discount_amount: null, doc_discount_share: '5.00' },
  ];

  it('give an invoice its discount from the table and its subtotal before the shares', async () => {
    const { ctx, calls } = fakeFinance((call) => {
      if (call.name === 'finance_invoice_totals') return { data: { id: ID, total: '144.90', subtotal: '135.00', sst: '9.90', notes: null }, error: null };
      if (call.name === 'finance_invoices') return { data: { doc_discount_pct: '10.00', doc_discount_amount: null }, error: null };
      return { data: lines, error: null };
    });
    const read = await getInvoice(ctx, ID);
    expect(read).toMatchObject({ subtotal: 150, doc_discount_pct: 10, doc_discount_amount: null, doc_discount: 15, sst: 9.9, total: 144.9 });
    expect(read?.lines.map((l) => l.doc_discount_share)).toEqual([10, 5]);
    expect(calls.find((c) => c.name === 'finance_invoice_lines')?.columns).toContain('doc_discount_share');
    expect(calls.find((c) => c.name === 'finance_invoices')).toMatchObject({ columns: 'doc_discount_pct,doc_discount_amount', filters: { org_id: 'org-1', id: ID } });
  });

  it('give a quotation the same', async () => {
    const { ctx } = fakeFinance((call) => {
      if (call.name === 'finance_quotation_totals') return { data: { id: ID, total: '144.90', subtotal: '135.00', sst: '9.90', notes: null }, error: null };
      if (call.name === 'finance_quotations') return { data: { doc_discount_pct: null, doc_discount_amount: '15.00' }, error: null };
      return { data: lines, error: null };
    });
    expect(await getQuotation(ctx, ID)).toMatchObject({ subtotal: 150, doc_discount_pct: null, doc_discount_amount: 15, doc_discount: 15 });
  });
});
