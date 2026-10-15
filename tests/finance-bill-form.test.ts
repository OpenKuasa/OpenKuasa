import { describe, expect, it } from 'vitest';
import {
  type BillForm,
  billFormError,
  billFormFromDetail,
  billOrderWarnings,
  ownCountedTotal,
  billPayload,
  defaultDueDate,
  emptyLine,
  lineNumbers,
  newBillForm,
  withCategory,
  ordersForSupplier,
  savedNotPosted,
  type BillOrderOption,
  withBillDate,
  withDueDate,
  withProduct,
  withSupplier,
} from '@/lib/finance/bill-form';
import { billTotals } from '@/lib/finance/bill-math';
import { WRITE_FAILED } from '@/lib/finance/result';
import { BILL_MESSAGES, type BillDetail, saveBillInput } from '@/lib/finance/bills';
import type { FinanceProduct } from '@/lib/finance/products';

const BILL = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const today = '2026-10-11';

const gloves: FinanceProduct = {
  id: PRODUCT,
  sku: 'PRD-010',
  name: 'Nitrile Gloves (Box)',
  type: 'product',
  category: 'Consumables',
  uom: 'box',
  price: 24.9,
  cost: 12.5,
  sst_rate: 6,
  active: true,
};

/** A form that can be saved: a supplier and one line of 10 at RM 12.50. */
const filled = (f: Partial<BillForm> = {}): BillForm => ({
  ...newBillForm(today, 'k1'),
  supplier_id: SUPPLIER,
  due_date: '2026-11-10',
  lines: [{ ...emptyLine('k1'), description: 'Gloves', quantity: '10', unit_price: '12.50' }],
  ...f,
});

describe('newBillForm', () => {
  it('is dated today with one empty line of quantity 1 and no SST', () => {
    expect(newBillForm(today, 'k1')).toEqual({
      supplier_id: '',
      supplier_ref: '',
      bill_date: today,
      due_date: today,
      dueEdited: false,
      notes: '',
      purchase_order_id: '',
      category_id: '',
      lines: [
        { key: 'k1', product_id: '', description: '', quantity: '1', uom: '', pack_size: '', unit_price: '', sst_rate: '0', discount_pct: '', discount_amount: '' },
      ],
    });
  });
});

describe('the bill’s category', () => {
  const CATEGORY = '99999999-9999-4999-8999-999999999999';
  it('starts on the default category the screen names, or on none', () => {
    expect(newBillForm(today, 'k1', CATEGORY).category_id).toBe(CATEGORY);
    expect(newBillForm(today, 'k1').category_id).toBe('');
  });
  it('is sent with the bill, empty meaning the workspace default', () => {
    expect(billPayload(filled({ category_id: CATEGORY })).category_id).toBe(CATEGORY);
    expect(billPayload(filled()).category_id).toBe('');
    expect(saveBillInput.parse(billPayload(filled({ category_id: CATEGORY }))).category_id).toBe(CATEGORY);
  });
});

describe('withCategory', () => {
  const CATEGORY = '99999999-9999-4999-8999-999999999999';
  const OTHER_CATEGORY = '88888888-8888-4888-8888-888888888888';
  it('sets the chosen category', () => {
    expect(withCategory(filled(), OTHER_CATEGORY, CATEGORY).category_id).toBe(OTHER_CATEGORY);
  });
  it('turns "default" into the default category itself, since an empty one would keep the draft’s old category', () => {
    expect(withCategory(filled({ category_id: OTHER_CATEGORY }), '', CATEGORY).category_id).toBe(CATEGORY);
  });
  it('stays empty when the workspace has no default to name', () => {
    expect(withCategory(filled({ category_id: OTHER_CATEGORY }), '', '').category_id).toBe('');
    expect(withCategory(filled({ category_id: OTHER_CATEGORY }), '', undefined).category_id).toBe('');
  });
});

describe('the due date', () => {
  const supplier = { id: SUPPLIER, payment_terms_days: 30 };

  it('is the bill date plus the supplier’s terms', () => {
    expect(defaultDueDate('2026-10-11', 30)).toBe('2026-11-10');
    expect(defaultDueDate('2026-10-11', 0)).toBe('2026-10-11');
    expect(defaultDueDate('2026-10-11', undefined)).toBe('2026-10-11');
  });
  it('follows the supplier and the bill date', () => {
    const chosen = withSupplier(newBillForm(today, 'k1'), supplier);
    expect(chosen).toMatchObject({ supplier_id: SUPPLIER, due_date: '2026-11-10', dueEdited: false });
    expect(withBillDate(chosen, '2026-12-15', 30)).toMatchObject({ bill_date: '2026-12-15', due_date: '2027-01-14' });
    expect(withSupplier(chosen, { id: 'other', payment_terms_days: 7 }).due_date).toBe('2026-10-18');
  });
  it('stops following once the person sets it by hand', () => {
    const edited = withDueDate(withSupplier(newBillForm(today, 'k1'), supplier), '2026-10-25');
    expect(edited).toMatchObject({ due_date: '2026-10-25', dueEdited: true });
    expect(withBillDate(edited, '2026-10-12', 30).due_date).toBe('2026-10-25');
    expect(withSupplier(edited, { id: 'other', payment_terms_days: 7 })).toMatchObject({ supplier_id: 'other', due_date: '2026-10-25' });
  });
  it('stays where it was while the bill date is half typed or cleared', () => {
    const chosen = withSupplier(newBillForm(today, 'k1'), supplier);
    expect(withBillDate(chosen, '', 30)).toMatchObject({ bill_date: '', due_date: '2026-11-10' });
    expect(withBillDate(chosen, '0002-10-11', 30).due_date).toBe('2026-11-10');
  });
});

describe('withProduct', () => {
  const line = { ...emptyLine('k1'), description: 'typed by hand', quantity: '4', unit_price: '9', pack_size: '100 pcs' };

  it('fills description, unit, unit price from the product’s cost, and SST, keeping the quantity', () => {
    expect(withProduct(line, gloves)).toEqual({
      key: 'k1',
      product_id: PRODUCT,
      description: 'Nitrile Gloves (Box)',
      quantity: '4',
      uom: 'box',
      pack_size: '100 pcs',
      unit_price: '12.5',
      sst_rate: '6',
      discount_pct: '',
      discount_amount: '',
    });
  });
  it('only clears the link when "no product" is chosen', () => {
    const linked = withProduct(line, gloves);
    expect(withProduct(linked, null)).toEqual({ ...linked, product_id: '' });
  });
});

describe('lineNumbers', () => {
  it('reads the boxes as numbers, with an empty SST box as 0', () => {
    expect(lineNumbers({ ...emptyLine('k'), quantity: '2.5', unit_price: '10', sst_rate: '' })).toEqual({
      quantity: 2.5,
      unit_price: 10,
      sst_rate: 0,
      discount_pct: null,
      discount_amount: null,
    });
  });
  it('rounds the SST rate to two decimals, so what is sent is what the total was worked out with', () => {
    expect(lineNumbers({ ...emptyLine('k'), sst_rate: '1.005' }).sst_rate).toBe(1.01);
    expect(lineNumbers({ ...emptyLine('k'), sst_rate: '0.145' }).sst_rate).toBe(0.15);
    expect(lineNumbers({ ...emptyLine('k'), sst_rate: '6' }).sst_rate).toBe(6);
  });
  it('gives NaN for a box that is not a number, which the total counts as nothing', () => {
    const numbers = lineNumbers({ ...emptyLine('k'), quantity: '1,000', unit_price: '', sst_rate: 'six' });
    expect([numbers.quantity, numbers.unit_price, numbers.sst_rate].every(Number.isNaN)).toBe(true);
    expect(billTotals([numbers])).toEqual({ subtotal: 0, sst: 0, total: 0 });
  });
});

describe('billFormError', () => {
  it('passes a form that can be saved', () => {
    expect(billFormError(filled())).toBeNull();
  });
  it('asks for a supplier first', () => {
    expect(billFormError(filled({ supplier_id: '' }))).toBe('Choose a supplier.');
  });
  it('asks for real dates, the due date not before the bill date', () => {
    expect(billFormError(filled({ bill_date: '' }))).toBe('Enter a valid date.');
    expect(billFormError(filled({ due_date: '20261-11-10' }))).toBe('Enter a valid date.');
    expect(billFormError(filled({ due_date: '2026-10-10' }))).toBe('The due date cannot be before the bill date.');
  });
  it('checks each line in the schema’s words', () => {
    const line = filled().lines[0];
    const withLine = (l: Partial<typeof line>) => filled({ lines: [{ ...line, ...l }] });
    expect(billFormError(withLine({ description: '  ' }))).toBe('Describe each line.');
    expect(billFormError(withLine({ quantity: '' }))).toBe('Enter a quantity above 0.');
    expect(billFormError(withLine({ quantity: '0' }))).toBe('Enter a quantity above 0.');
    expect(billFormError(withLine({ unit_price: '' }))).toBe('Enter a unit price of 0 or more.');
    expect(billFormError(withLine({ unit_price: '-1' }))).toBe('Enter a unit price of 0 or more.');
    expect(billFormError(withLine({ sst_rate: '101' }))).toBe('Enter an SST rate between 0 and 100.');
    expect(billFormError(withLine({ sst_rate: '' }))).toBeNull();
    expect(billFormError(withLine({ description: 'x'.repeat(201) }))).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses a figure typed with a comma rather than reading it as a smaller number', () => {
    const line = filled().lines[0];
    expect(billFormError(filled({ lines: [{ ...line, unit_price: '1,250.00' }] }))).toBe('Enter a unit price of 0 or more.');
    expect(billFormError(filled({ lines: [{ ...line, quantity: '1,000' }] }))).toBe('Enter a quantity above 0.');
  });
  it('reports the second line when the first is fine', () => {
    const line = filled().lines[0];
    expect(billFormError(filled({ lines: [line, { ...emptyLine('k2'), unit_price: '5' }] }))).toBe('Describe each line.');
  });
  it('asks for at least one line, and at most 100', () => {
    const line = filled().lines[0];
    expect(billFormError(filled({ lines: [] }))).toBe('Add at least one line.');
    expect(billFormError(filled({ lines: Array.from({ length: 101 }, (_, i) => ({ ...line, key: `k${i}` })) }))).toBe(
      'A bill can have at most 100 lines.',
    );
  });
  it('lets a draft total nothing, but not a bill that is being posted', () => {
    const free = filled({ lines: [{ ...filled().lines[0], unit_price: '0' }] });
    expect(billFormError(free)).toBeNull();
    expect(billFormError(free, true)).toBe('A bill needs at least one line with an amount.');
    expect(billFormError(filled(), true)).toBeNull();
  });
});

describe('billPayload', () => {
  it('sends numbers, never the text that was typed, and no id for a new bill', () => {
    const payload = billPayload(
      filled({
        supplier_ref: ' INV 88 ',
        notes: '',
        lines: [
          { key: 'k1', product_id: PRODUCT, description: ' Gloves ', quantity: '10', uom: 'box', pack_size: '', unit_price: '12.50', sst_rate: '6', discount_pct: '', discount_amount: '' },
        ],
      }),
    );
    expect(payload).toEqual({
      supplier_id: SUPPLIER,
      supplier_ref: ' INV 88 ',
      bill_date: today,
      due_date: '2026-11-10',
      purchase_order_id: '',
      category_id: '',
      notes: '',
      lines: [{ product_id: PRODUCT, description: ' Gloves ', uom: 'box', pack_size: '', quantity: 10, unit_price: 12.5, sst_rate: 6 }],
    });
    expect('id' in payload).toBe(false);
    expect(saveBillInput.parse(payload)).toMatchObject({
      supplier_ref: 'INV 88',
      notes: null,
      lines: [{ product_id: PRODUCT, description: 'Gloves', uom: 'box', pack_size: null, quantity: 10, unit_price: 12.5, sst_rate: 6 }],
    });
  });
  it('sends the id when a draft is being changed', () => {
    expect(billPayload(filled({ id: BILL })).id).toBe(BILL);
  });
  it('never carries the line keys, the dueEdited flag or a workspace', () => {
    const payload = billPayload(filled({ id: BILL }));
    expect(Object.keys(payload).sort()).toEqual(['bill_date', 'category_id', 'due_date', 'id', 'lines', 'notes', 'purchase_order_id', 'supplier_id', 'supplier_ref']);
    expect(Object.keys(payload.lines[0]).sort()).toEqual(['description', 'pack_size', 'product_id', 'quantity', 'sst_rate', 'unit_price', 'uom']);
  });
});

describe('billFormFromDetail', () => {
  const detail: BillDetail = {
    id: BILL,
    bill_no: null,
    supplier_id: SUPPLIER,
    supplier_name: 'Lim Hardware',
    bill_date: '2026-10-01',
    due_date: '2026-10-15',
    total: 132.5,
    paid: 0,
    balance: 132.5,
    display_status: 'draft',
    supplier_ref: null,
    notes: 'urgent',
    purchase_order_id: null,
    purchase_order_no: null,
    category_id: null,
    category_name: null,
    lines: [
      { id: 'line-1', product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: 10, uom: 'box', pack_size: '100 pcs', unit_price: 12.5, sst_rate: 6, amount: 125, sst_amount: 7.5 },
      { id: 'line-2', product_id: null, description: 'Delivery', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0, amount: 0, sst_amount: 0 },
    ],
  };

  it('shows a saved draft as it was saved, and keeps its due date', () => {
    const form = billFormFromDetail(detail);
    expect(form).toMatchObject({ id: BILL, supplier_id: SUPPLIER, supplier_ref: '', due_date: '2026-10-15', dueEdited: true, notes: 'urgent', purchase_order_id: '' });
    expect(form.lines).toEqual([
      { key: 'line-1', product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: '10', uom: 'box', pack_size: '100 pcs', unit_price: '12.5', sst_rate: '6', discount_pct: '', discount_amount: '' },
      { key: 'line-2', product_id: '', description: 'Delivery', quantity: '1', uom: '', pack_size: '', unit_price: '0', sst_rate: '0', discount_pct: '', discount_amount: '' },
    ]);
  });
  it('saves back what it loaded: nothing is lost by opening and saving a draft', () => {
    const form = billFormFromDetail(detail);
    expect(billFormError(form)).toBeNull();
    const parsed = saveBillInput.parse(billPayload(form));
    expect(parsed.id).toBe(BILL);
    expect(parsed.lines).toEqual([
      { product_id: PRODUCT, description: 'Nitrile Gloves (Box)', quantity: 10, uom: 'box', pack_size: '100 pcs', unit_price: 12.5, sst_rate: 6 },
      { product_id: null, description: 'Delivery', quantity: 1, uom: null, pack_size: null, unit_price: 0, sst_rate: 0 },
    ]);
    expect(billTotals(form.lines.map(lineNumbers))).toEqual({ subtotal: 125, sst: 7.5, total: 132.5 });
  });
});

describe('savedNotPosted', () => {
  it('says plainly that the draft was saved when the failure was the general one', () => {
    const text = savedNotPosted(WRITE_FAILED);
    expect(text).toBe('The bill was saved as a draft, but posting it failed. Please try again.');
    expect(text).not.toContain('could not be saved');
  });

  it('puts the reason after the fact that the draft was saved', () => {
    const text = savedNotPosted(BILL_MESSAGES.lines);
    expect(text).toBe(`The bill was saved as a draft, but it was not posted. ${BILL_MESSAGES.lines}`);
    expect(text).not.toContain('could not be saved');
  });
});

const PO = '88888888-8888-4888-8888-888888888888';
const detailFor = (): BillDetail => ({
  id: BILL,
  bill_no: null,
  supplier_id: SUPPLIER,
  supplier_name: 'Lim Hardware',
  bill_date: '2026-10-01',
  due_date: '2026-10-15',
  total: 125,
  paid: 0,
  balance: 125,
  display_status: 'draft',
  supplier_ref: null,
  notes: null,
  purchase_order_id: null,
  purchase_order_no: null,
  category_id: null,
  category_name: null,
  lines: [],
});
const PO_2 = '77777777-7777-4777-8777-777777777777';
const PO_3 = '66666666-6666-4666-8666-666666666666';
const OTHER_SUPPLIER = '55555555-5555-4555-8555-555555555555';

const order = (o: Partial<BillOrderOption> = {}): BillOrderOption => ({
  id: PO,
  po_no: 'PO-0003',
  supplier_id: SUPPLIER,
  status: 'approved',
  total: 1200,
  billed_total: 300,
  received_total: 1200,
  ...o,
});

describe('the purchase order choice', () => {
  it('is empty on a new bill, and is sent as an empty string so that choosing none unlinks', () => {
    expect(billPayload(filled()).purchase_order_id).toBe('');
    expect(saveBillInput.parse(billPayload(filled())).purchase_order_id).toBeNull();
  });
  it('is sent as chosen', () => {
    expect(billPayload(filled({ purchase_order_id: PO })).purchase_order_id).toBe(PO);
    expect(billFormError(filled({ purchase_order_id: PO }))).toBeNull();
  });
  it('shows the order a saved draft is linked to, and none when it has none', () => {
    const base = { ...detailFor(), purchase_order_id: PO, purchase_order_no: 'PO-0003' };
    expect(billFormFromDetail(base).purchase_order_id).toBe(PO);
    expect(billFormFromDetail(detailFor()).purchase_order_id).toBe('');
  });
  it('is cleared when a different supplier is chosen, and kept when the same one is', () => {
    const linked = filled({ purchase_order_id: PO });
    expect(withSupplier(linked, { id: OTHER_SUPPLIER, payment_terms_days: 30 }).purchase_order_id).toBe('');
    expect(withSupplier(linked, { id: SUPPLIER, payment_terms_days: 30 }).purchase_order_id).toBe(PO);
  });
});

describe('ordersForSupplier', () => {
  const mine = order();
  const theirs = order({ id: PO_2, po_no: 'PO-0004', supplier_id: OTHER_SUPPLIER });
  it('offers only the chosen supplier’s orders, labelled with number, total and billed so far', () => {
    expect(ordersForSupplier([mine, theirs], SUPPLIER, '')).toEqual([{ id: PO, label: 'PO-0003 · RM 1,200.00 · billed RM 300.00' }]);
  });
  it('offers nothing before a supplier is chosen', () => {
    expect(ordersForSupplier([mine, theirs], '', '')).toEqual([]);
  });
  it('still offers the order a draft is linked to when it has since been closed, and not other closed orders', () => {
    const closed = order({ id: PO_2, po_no: 'PO-0002', status: 'closed', total: 500, billed_total: 500 });
    const other = order({ id: PO_3, po_no: 'PO-0001', status: 'closed' });
    expect(ordersForSupplier([mine, closed, other], SUPPLIER, PO_2).map((o) => o.id)).toEqual([PO, PO_2]);
    expect(ordersForSupplier([mine, closed, other], SUPPLIER, '').map((o) => o.id)).toEqual([PO]);
  });
  it('does not offer the current order under another supplier', () => {
    const closed = order({ id: PO_2, status: 'closed', supplier_id: OTHER_SUPPLIER });
    expect(ordersForSupplier([mine, closed], SUPPLIER, PO_2).map((o) => o.id)).toEqual([PO]);
  });
});

describe('billOrderWarnings', () => {
  // 10 x 12.50 = RM 125.00
  const lines = filled().lines;
  const big = [{ ...emptyLine('k'), description: 'Pallets', quantity: '1', unit_price: '1000' }];
  it('says nothing without an order', () => {
    expect(billOrderWarnings(lines, null, 0)).toEqual([]);
  });
  it('says nothing when the bill fits inside both what is ordered and what has arrived', () => {
    expect(billOrderWarnings(lines, order(), 0)).toEqual([]);
  });
  it('warns when the bills would pass the order’s total', () => {
    // 300 already billed + 1000 = 1300 > 1200
    expect(billOrderWarnings(big, order({ received_total: 5000 }), 0)).toEqual(['This takes the bills for PO-0003 over its total of RM 1,200.00.']);
  });
  it('warns when the bills would pass what has arrived', () => {
    const arrived = order({ received_total: 350 });
    // 300 + 125 = 425 > 350, but within 1200
    expect(billOrderWarnings(lines, arrived, 0)).toEqual(['This is more than has been received on PO-0003 so far (RM 350.00).']);
  });
  it('gives both, the total first', () => {
    const both = order({ received_total: 400 });
    expect(billOrderWarnings(big, both, 0)).toEqual([
      'This takes the bills for PO-0003 over its total of RM 1,200.00.',
      'This is more than has been received on PO-0003 so far (RM 400.00).',
    ]);
  });
  it('does not count the bill’s own saved total twice when it is the linked draft', () => {
    // billed_total 300 includes this draft's own 125: others = 175; 175 + 125 = 300, not over 300
    expect(billOrderWarnings(lines, order({ received_total: 300 }), 125)).toEqual([]);
    expect(billOrderWarnings(lines, order({ received_total: 300 }), 0)).toHaveLength(1);
  });
  it('is not bothered by rounding, and says nothing for a bill of nothing', () => {
    expect(billOrderWarnings(lines, order({ total: 425, received_total: 425 }), 0)).toEqual([]);
    expect(billOrderWarnings([emptyLine('k')], order({ billed_total: 5000 }), 0)).toEqual([]);
  });
});

describe('ownCountedTotal', () => {
  const saved = (id: string, purchase_order_id: string | null, total: number) => ({ id, purchase_order_id, total });
  const rows = [saved('b1', PO, 125), saved('b2', PO_2, 80), saved('b3', null, 50)];
  it('is nothing for a bill never saved', () => {
    expect(ownCountedTotal(rows, undefined, PO)).toBe(0);
    expect(ownCountedTotal(rows, 'not-in-the-list', PO)).toBe(0);
  });
  it('is the saved total when the saved bill is linked to the chosen order', () => {
    expect(ownCountedTotal(rows, 'b1', PO)).toBe(125);
  });
  it('is nothing when the saved bill is linked to another order, or to none, or no order is chosen', () => {
    expect(ownCountedTotal(rows, 'b2', PO)).toBe(0);
    expect(ownCountedTotal(rows, 'b3', PO)).toBe(0);
    expect(ownCountedTotal(rows, 'b1', '')).toBe(0);
  });
});
