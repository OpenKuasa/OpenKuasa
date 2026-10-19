import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillFormCard } from '@/components/finance/bill-form-card';
import { BillsView } from '@/components/finance/bills-view';
import type { BillDetail, BillListRow } from '@/lib/finance/bills';
import type { FinanceContact } from '@/lib/finance/contacts';
import { billsView } from '@/lib/finance/purchase-views';
import { ringgitBill } from './helpers/bill-rows';

/**
 * The Supplier Bills screen as the server sends it: rendered to a string and
 * read as markup (no DOM here). What a press decides is in
 * tests/finance-bill-form.test.ts; what needs a browser is checked by hand.
 */

// A closed select draws no options. Here its options are drawn in place, and the chosen one is marked.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-chosen={value}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <div data-option={value}>{children}</div>,
  };
});

const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const PO = '88888888-8888-4888-8888-888888888888';
const PO_2 = '77777777-7777-4777-8777-777777777777';

const bill = (id: string, extra: Partial<BillListRow> = {}): BillListRow => ringgitBill({
  id,
  bill_no: 'BILL-0001',
  supplier_id: SUPPLIER,
  supplier_name: 'Lim Hardware',
  bill_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 0,
  balance: 100,
  display_status: 'pending',
  purchase_order_id: null,
  purchase_order_no: null,
  category_id: null,
  category_name: null,
  ...extra,
});

describe('the bills list', () => {
  it('has a Purchase order column showing the number on a linked bill and a dash on the rest', () => {
    const rows = [bill('a', { purchase_order_id: PO, purchase_order_no: 'PO-0003' }), bill('b', { bill_no: 'BILL-0002' })];
    const html = renderToStaticMarkup(<BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} />);
    expect(html).toContain('Purchase order');
    expect(html).toContain('PO-0003');
    const cells = html.match(/<td[^>]*>[^<]*<\/td>/g) ?? [];
    expect(cells.filter((c) => c.includes('PO-0003'))).toHaveLength(1);
  });

  it('draws the paperclip in the row of a bill that has a receipt, as a button and not a link, in a column wide enough for its name', () => {
    const rows = [bill('a'), bill('b', { bill_no: 'BILL-0002' })];
    const receipts = {
      a: [{ id: 'r1', file_name: 'kedai-kertas.pdf', mime_type: 'application/pdf' as const, has_file: true, expense_id: null, bill_id: 'a' }],
    };
    const linkOf = vi.fn(async () => ({ ok: false as const, error: 'unused' }));
    const html = renderToStaticMarkup(
      <BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} receipts={receipts} receiptLinkOf={linkOf} />,
    );
    expect(html).toContain('aria-label="Download the receipt kedai-kertas.pdf"');
    expect(html.match(/Download the receipt/g)).toHaveLength(1);
    expect(html).not.toContain('<a ');
    expect(html).toMatch(/<td[^>]*class="[^"]*\bmin-w-36\b[^"]*"[^>]*><span[^>]*>BILL-0001<\/span>/);
  });

  it('says under the balance how much a contra entry set off, and nothing on a bill with none', () => {
    const rows = [bill('a', { set_off: 40, balance: 60 }), bill('b', { bill_no: 'BILL-0002' })];
    const html = renderToStaticMarkup(<BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} />);
    expect(html.match(/Set off RM/g)).toHaveLength(1);
    expect(html).toContain('Set off RM 40.00');
  });
});

const supplier = (id: string, name: string): FinanceContact =>
  ({ id, name, is_supplier: true, is_customer: false, active: true, payment_terms_days: 30 }) as unknown as FinanceContact;

const detail = (extra: Partial<BillDetail> = {}): BillDetail => ringgitBill({
  ...bill('d', { display_status: 'draft', bill_no: null }),
  supplier_ref: null,
  notes: null,
  lines: [{ id: 'l1', product_id: null, description: 'Gloves', quantity: 1, uom: null, pack_size: null, unit_price: 100, sst_rate: 0, amount: 100, sst_amount: 0 }],
  ...extra,
});

const actions = { save: vi.fn(), saveAndPost: vi.fn() };
const orders = [
  { id: PO, po_no: 'PO-0003', supplier_id: SUPPLIER, status: 'approved', total: 1200, billed_total: 300, received_total: 1200, currency: 'MYR' },
  { id: PO_2, po_no: 'PO-0009', supplier_id: OTHER, status: 'approved', total: 50, billed_total: 0, received_total: 0, currency: 'MYR' },
];

const card = (props: Partial<Parameters<typeof BillFormCard>[0]> = {}) =>
  renderToStaticMarkup(
    <BillFormCard suppliers={[supplier(SUPPLIER, 'Lim Hardware'), supplier(OTHER, 'Other')]} products={[]} today="2026-10-11" actions={actions} onClose={() => {}} {...props} />,
  );

describe('the bill form’s purchase order picker', () => {
  it('lists the chosen supplier’s approved orders, with a none choice, and no other supplier’s', () => {
    const html = card({ editing: detail(), orders });
    expect(html).toContain('Purchase order');
    expect(html).toContain('PO-0003 · RM 1,200.00 · billed RM 300.00');
    expect(html).not.toContain('PO-0009');
    expect(html).toContain('data-option="none"');
  });
  it('is absent when the screen offers no orders (nothing else changes)', () => {
    expect(card({ editing: detail() })).not.toContain('Purchase order');
  });
  it('marks the linked order as chosen, and still offers it when it has since been closed', () => {
    const html = card({ editing: detail({ purchase_order_id: PO_2, purchase_order_no: 'PO-0002' }), orders: [{ id: PO_2, po_no: 'PO-0002', supplier_id: SUPPLIER, status: 'closed', total: 500, billed_total: 500, received_total: 500, currency: 'MYR' }] });
    expect(html).toContain('data-chosen="' + PO_2 + '"');
    expect(html).toContain('PO-0002 · RM 500.00 · billed RM 500.00');
  });
  it('does not count the bill twice after a save that leaves the form open: its own total comes from the saved row', () => {
    const linked = detail({ purchase_order_id: PO, purchase_order_no: 'PO-0003', total: 1000, lines: [{ ...detail().lines[0], unit_price: 1000, amount: 1000 }] });
    const row = bill('d', { purchase_order_id: PO, purchase_order_no: 'PO-0003', total: 1000, display_status: 'draft' });
    // The order's billed figure (1000) is just this bill: 1000 of 1200 is fine.
    const html = card({ editing: linked, orders: [{ ...orders[0], billed_total: 1000 }], rows: [row] });
    expect(html).not.toContain('over its total');
  });
  it('keeps the party-choice notes in one status container that is always there', () => {
    const quiet = card({ editing: detail(), orders });
    expect(quiet.match(/role="status"/g)).toHaveLength(1);
    const html = card({ editing: detail({ purchase_order_id: PO, purchase_order_no: 'PO-0003', total: 1000, lines: [{ ...detail().lines[0], unit_price: 1000, amount: 1000 }] }), orders: [{ ...orders[0], billed_total: 1300 }] });
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/role="status"[^>]*>(<p[^>]*>)?This takes/);
  });
  it('warns, as a status and not an alert, when the draft would take the order over its total', () => {
    const html = card({ editing: detail({ purchase_order_id: PO, purchase_order_no: 'PO-0003', total: 1000, lines: [{ ...detail().lines[0], unit_price: 1000, amount: 1000 }] }), orders: [{ ...orders[0], billed_total: 1300 }] });
    expect(html).toContain('role="status"');
    expect(html).toContain('This takes the bills for PO-0003 over its total of RM 1,200.00.');
  });
});

describe('the bill form’s category picker', () => {
  const CAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const categories = [
    { id: CAT_A, name: 'Purchases' },
    { id: CAT_B, name: 'Utilities' },
  ];

  it('lists the active expense categories and chooses the default for a new bill', () => {
    const html = card({ categories, defaultCategoryId: CAT_A });
    expect(html).toContain('Category');
    expect(html).toContain('data-option="' + CAT_A + '"');
    expect(html).toContain('data-option="' + CAT_B + '"');
    expect(html).toContain('data-chosen="' + CAT_A + '"');
  });
  it('sits beside the purchase order picker when both are offered', () => {
    const html = card({ categories, defaultCategoryId: CAT_A, orders });
    expect(html).toContain('Purchase order');
    expect(html).toContain('Category');
  });
  it('shows the draft’s own category, and still offers it when it has since been archived', () => {
    const html = card({ editing: detail({ category_id: 'gone', category_name: 'Old Courier' }), categories, defaultCategoryId: CAT_A });
    expect(html).toContain('data-chosen="gone"');
    expect(html).toContain('Old Courier');
  });
  it('is absent when the screen offers no categories (nothing else changes)', () => {
    expect(card({ editing: detail() })).not.toContain('Category');
  });
});

describe('the bills list category column', () => {
  it('shows the category, hidden below 2xl, and a dash where there is none', () => {
    const rows = [bill('a', { category_id: 'c', category_name: 'Utilities' }), bill('b', { bill_no: 'BILL-0002' })];
    const html = renderToStaticMarkup(<BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} />);
    expect(html).toMatch(/<th[^>]*hidden[^>]*2xl:table-cell[^>]*>Category<\/th>/);
    expect(html).toMatch(/<td[^>]*hidden[^>]*2xl:table-cell[^>]*>Utilities<\/td>/);
  });
});

describe('a bill in another currency (stage 4a)', () => {
  const usd = (extra: Partial<BillListRow> = {}) =>
    bill('u', {
      bill_no: 'BILL-0009', total: 1080, balance: 1080, currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000',
      fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank', fx_rate_reference: 'Maybank',
      subtotal_myr: 4200, sst_myr: 336, total_myr: 4536, balance_myr: 4536, ...extra,
    });
  it('lists its amounts in its own currency with the ringgit under them, and a ringgit bill as before', () => {
    const rows = [usd(), bill('m', { bill_no: 'BILL-0010' })];
    const html = renderToStaticMarkup(<BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} />);
    expect(html).toContain('USD 1,080.00');
    expect(html).toContain('≈ RM 4,536.00, rate typed');
    expect(html).toContain('RM 100.00');
    // The KPIs add ringgit: RM 4,536.00 + RM 100.00.
    expect(html).toContain('RM 4,636');
  });
  it('says a foreign draft has no rate yet', () => {
    const rows = [
      usd({
        display_status: 'draft', bill_no: null, fx_rate: null, fx_rate_text: null, fx_rate_source: null, fx_rate_provider: null,
        fx_rate_reference: null, total_myr: null, balance_myr: null, subtotal_myr: null, sst_myr: null,
      }),
    ];
    const html = renderToStaticMarkup(<BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} />);
    expect(html).toContain('No rate yet');
  });
  it('draws no currency note on a list of ringgit bills', () => {
    const rows = [bill('m')];
    expect(renderToStaticMarkup(<BillsView rows={rows} view={billsView(rows, [], '2026-10-09')} held={{}} />)).not.toContain('≈');
  });
  it('offers a currency on the form, and keeps a linked bill in the order’s currency with the picker shut', () => {
    const free = card({ editing: detail(), orders });
    expect(free).toContain('Currency');
    expect(free).not.toContain('In the order’s currency.');
    const linked = card({ editing: detail({ purchase_order_id: PO, purchase_order_no: 'PO-0003' }), orders });
    expect(linked).toContain('In the order’s currency.');
  });
  it('shows a saved foreign draft’s rate and where it came from', () => {
    const html = card({
      editing: detail({
        currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'malaysian_bank',
        fx_rate_reference: 'Maybank',
      }),
    });
    expect(html).toContain('data-chosen="USD"');
    expect(html).toContain('Exchange rate (RM per USD)');
    expect(html).toContain('value="4.2"');
    expect(html).toContain('Maybank');
  });
  it('offers no currency on a bill made from a receipt', () => {
    expect(card({ ringgitOnly: true, draftOnly: true })).not.toContain('Currency');
  });
});
