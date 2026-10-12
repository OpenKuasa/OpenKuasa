import { describe, expect, it } from 'vitest';
import type { BillListRow } from '@/lib/finance/bills';
import type { PaymentOutRow } from '@/lib/finance/money';
import type { PurchaseOrderListRow } from '@/lib/finance/purchase-orders';
import type { RfqListRow } from '@/lib/finance/rfqs';
import {
  PO_DELIVERY_LABELS,
  PO_STATUS_LABELS,
  RFQ_STATUS_LABELS,
  alsoCovers,
  billsCsv,
  billsView,
  displayDate,
  filterBills,
  filterPayments,
  filterPurchaseOrders,
  filterRfqs,
  paymentsCsv,
  paymentsView,
  purchaseOrderActions,
  purchaseOrderName,
  purchaseOrdersCsv,
  purchaseOrdersView,
  rfqActions,
  rfqDisplayStatus,
  rfqName,
  rfqsCsv,
  rfqsView,
  siblingBills,
} from '@/lib/finance/purchase-views';

const today = '2026-10-09';

let seq = 0;
const bill = (b: Partial<BillListRow>): BillListRow => {
  seq += 1;
  return {
    id: `bill-${seq}`,
    bill_no: `BILL-${String(seq).padStart(4, '0')}`,
    supplier_id: 'lim',
    supplier_name: 'Lim Hardware',
    bill_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 100,
    paid: 0,
    balance: 100,
    display_status: 'pending',
    purchase_order_id: null,
    purchase_order_no: null,
    ...b,
  };
};

const payment = (p: Partial<PaymentOutRow>): PaymentOutRow => {
  seq += 1;
  return {
    allocation_id: `alloc-${seq}`,
    transaction_id: `txn-${seq}`,
    number: `PV-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    transaction_amount: 100,
    status: 'posted',
    reference: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    bill_id: 'bill-x',
    bill_no: 'BILL-0001',
    supplier_name: 'Lim Hardware',
    ...p,
  };
};

describe('billsView', () => {
  it('sums open balances, this week, overdue and what was paid this month', () => {
    const view = billsView(
      [
        bill({ balance: 2600, due_date: '2026-10-13' }),
        bill({ balance: 4300, supplier_id: 'maju', supplier_name: 'Maju Jaya', due_date: '2026-11-01' }),
        bill({ balance: 1800, display_status: 'overdue', due_date: '2026-10-04' }),
        bill({ balance: 0, paid: 100, display_status: 'paid' }),
        bill({ balance: 780, display_status: 'draft', bill_no: null }),
        bill({ balance: 999, display_status: 'void' }),
      ],
      [payment({ amount: 1450 }), payment({ amount: 500, txn_date: '2026-09-30' })],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Total payable', 'RM 8,700', '3 open bills'],
      ['Due this week', 'RM 2,600', '1 bill'],
      ['Overdue', 'RM 1,800', '1 bill'],
      ['Paid (MTD)', 'RM 1,450', '1 payment'],
    ]);
    expect(view.stats[2].deltaTone).toBe('down');
    // Draft, paid and void bills owe nothing; Lim Hardware has two open bills.
    expect(view.bySupplier).toEqual([
      { label: 'Lim Hardware', value: 4400 },
      { label: 'Maju Jaya', value: 4300 },
    ]);
  });

  it('leaves void bills out of the status donut', () => {
    const view = billsView(
      [bill({}), bill({}), bill({ display_status: 'paid' }), bill({ display_status: 'overdue' }), bill({ display_status: 'draft' }), bill({ display_status: 'void' })],
      [],
      today,
    );
    expect(view.byStatus.map((s) => [s.label, s.value])).toEqual([
      ['Pending', 2],
      ['Paid', 1],
      ['Overdue', 1],
      ['Draft', 1],
    ]);
  });

  it('counts a payment split across two bills once, and adds both parts', () => {
    const view = billsView(
      [],
      [
        payment({ transaction_id: 'split', amount: 60 }),
        payment({ transaction_id: 'split', amount: 40 }),
        payment({ amount: 25 }),
      ],
      today,
    );
    expect([view.stats[3].value, view.stats[3].delta]).toEqual(['RM 125', '2 payments']);
  });

  it('does not count scheduled or voided payments as paid', () => {
    const view = billsView(
      [],
      [payment({ status: 'scheduled', number: null }), payment({ status: 'void' }), payment({ status: 'draft', number: null })],
      today,
    );
    expect([view.stats[3].value, view.stats[3].delta]).toEqual(['RM 0', '0 payments']);
  });

  it('keeps two suppliers with the same name apart, and shows the five largest', () => {
    const view = billsView(
      [
        bill({ supplier_id: 'a', supplier_name: 'Ali Trading', balance: 10 }),
        bill({ supplier_id: 'b', supplier_name: 'Ali Trading', balance: 20 }),
        bill({ supplier_id: 'c', supplier_name: 'C', balance: 30 }),
        bill({ supplier_id: 'd', supplier_name: 'D', balance: 40 }),
        bill({ supplier_id: 'e', supplier_name: 'E', balance: 50 }),
        bill({ supplier_id: 'f', supplier_name: 'F', balance: 60 }),
      ],
      [],
      today,
    );
    expect(view.bySupplier.map((s) => s.value)).toEqual([60, 50, 40, 30, 20]);
  });

  it('adds sen without floating point drift', () => {
    const view = billsView([bill({ balance: 0.1 }), bill({ balance: 0.2 })], [], today);
    expect(view.bySupplier).toEqual([{ label: 'Lim Hardware', value: 0.3 }]);
  });

  it('is all zeros for a workspace with nothing yet', () => {
    const view = billsView([], [], today);
    expect(view.stats.map((s) => s.value)).toEqual(['RM 0', 'RM 0', 'RM 0', 'RM 0']);
    expect(view.stats[2].deltaTone).toBe('flat');
    expect(view.bySupplier).toEqual([]);
    expect(view.byStatus.map((s) => s.value)).toEqual([0, 0, 0, 0]);
  });
});

describe('paymentsView', () => {
  it('counts only paid money; the trend covers the last 8 months', () => {
    const view = paymentsView(
      [
        payment({ amount: 3000, method: 'bank_transfer' }),
        payment({ amount: 1000, method: 'cash' }),
        payment({ amount: 4300, status: 'scheduled', number: null, txn_date: '2026-10-14' }),
        payment({ amount: 700, status: 'void' }),
        payment({ amount: 2500, txn_date: '2026-03-02' }),
        payment({ amount: 999, txn_date: '2026-02-27' }), // older than 8 months
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Paid (MTD)', 'RM 4,000', 'this month'],
      ['Payments', '2', 'this month'],
      ['Via bank / FPX', '75%', 'of paid MTD'],
      ['To be paid', 'RM 4,300', '1 payment'],
    ]);
    expect(view.paidMtd).toBe('RM 4,000');
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend[0]).toEqual({ label: 'Mar', electronic: 2.5, cash: 0 });
    expect(view.trend[7]).toEqual({ label: 'Oct', electronic: 3, cash: 1 });
  });

  it('counts DuitNow, card and e-wallet as electronic, cash and cheque as not', () => {
    const view = paymentsView(
      [
        payment({ amount: 1000, method: 'duitnow' }),
        payment({ amount: 1000, method: 'card' }),
        payment({ amount: 1000, method: 'ewallet' }),
        payment({ amount: 500, method: 'cash' }),
        payment({ amount: 500, method: 'cheque' }),
      ],
      today,
    );
    expect(view.stats[2].value).toBe('75%');
    expect(view.trend[7]).toEqual({ label: 'Oct', electronic: 3, cash: 1 });
  });

  it('shows only the methods used this month, with their own labels and amounts in RM', () => {
    const view = paymentsView(
      [
        payment({ amount: 120.5, method: 'duitnow' }),
        payment({ amount: 40, method: 'cheque' }),
        payment({ amount: 900, method: 'fpx', txn_date: '2026-09-30' }),
      ],
      today,
    );
    expect(view.byMethod.map((s) => [s.key, s.label, s.value])).toEqual([
      ['duitnow', 'DuitNow', 120.5],
      ['cheque', 'Cheque', 40],
    ]);
  });

  it('keeps all seven methods at zero when nothing was paid this month, so the legend still shows', () => {
    const view = paymentsView([payment({ status: 'scheduled', number: null })], today);
    expect(view.byMethod.map((s) => s.label)).toEqual(['Bank Transfer', 'FPX', 'DuitNow', 'Card', 'E-Wallet', 'Cash', 'Cheque']);
    expect(view.byMethod.every((s) => s.value === 0)).toBe(true);
    expect(view.stats[2].value).toBe('—');
  });

  it('counts a split payment once, paid or scheduled', () => {
    const view = paymentsView(
      [
        payment({ transaction_id: 'paid-split', amount: 60 }),
        payment({ transaction_id: 'paid-split', amount: 40 }),
        payment({ transaction_id: 'later', amount: 10, status: 'scheduled', number: null }),
        payment({ transaction_id: 'later', amount: 15, status: 'scheduled', number: null }),
      ],
      today,
    );
    expect(view.stats.map((s) => [s.value, s.delta])).toEqual([
      ['RM 100', 'this month'],
      ['1', 'this month'],
      ['100%', 'of paid MTD'],
      ['RM 25', '1 payment'],
    ]);
  });

  describe('hasTrend', () => {
    it('is true for one small paid payment this month, although the chart rounds it to nothing', () => {
      const view = paymentsView([payment({ amount: 30 })], today);
      expect(view.hasTrend).toBe(true);
      expect(view.trend.every((t) => t.electronic === 0 && t.cash === 0)).toBe(true);
    });
    it('is true at the oldest month the trend covers', () => {
      expect(paymentsView([payment({ amount: 30, txn_date: '2026-03-01' })], today).hasTrend).toBe(true);
    });
    it('is false when the only paid payment is older than the eight months', () => {
      expect(paymentsView([payment({ amount: 5000, txn_date: '2026-01-09' })], today).hasTrend).toBe(false);
      expect(paymentsView([payment({ amount: 5000, txn_date: '2026-02-28' })], today).hasTrend).toBe(false);
    });
    it('is false when there are only scheduled and void payments', () => {
      const view = paymentsView(
        [payment({ amount: 4300, status: 'scheduled', number: null }), payment({ amount: 700, status: 'void' })],
        today,
      );
      expect(view.hasTrend).toBe(false);
    });
    it('is false with no rows', () => {
      expect(paymentsView([], today).hasTrend).toBe(false);
    });
  });

  it('uses no purple, violet, indigo or fuchsia for a method', () => {
    const view = paymentsView([], today);
    for (const slice of view.byMethod) {
      expect(slice.color, slice.label).toMatch(/^(var\(--chart-[1-5]\)|oklch\(0\.\d+ 0\.\d+ (\d+)\))$/);
      const hue = /oklch\([\d.]+ [\d.]+ (\d+)\)/.exec(slice.color ?? '')?.[1];
      // Violet to fuchsia sits between hue 270 and 350.
      if (hue) expect(Number(hue) < 270 || Number(hue) > 350, slice.label).toBe(true);
    }
  });
});

describe('filterBills', () => {
  const rows = [
    bill({ id: 'p', bill_no: 'BILL-0007', supplier_name: 'Lim Hardware' }),
    bill({ id: 'o', bill_no: 'BILL-0008', supplier_name: 'Maju Jaya', display_status: 'overdue' }),
    bill({ id: 'd', bill_no: null, supplier_name: 'Lim Hardware', display_status: 'draft' }),
    bill({ id: 'x', bill_no: 'BILL-0009', supplier_name: 'Maju Jaya', display_status: 'paid' }),
    bill({ id: 'v', bill_no: 'BILL-0010', supplier_name: 'Lim Hardware', display_status: 'void' }),
  ];
  const ids = (list: BillListRow[]) => list.map((b) => b.id);

  it('shows everything except void bills until a status is chosen', () => {
    expect(ids(filterBills(rows, '', 'open'))).toEqual(['p', 'o', 'd', 'x']);
  });
  it('shows one status when chosen, void included', () => {
    expect(ids(filterBills(rows, '', 'draft'))).toEqual(['d']);
    expect(ids(filterBills(rows, '', 'void'))).toEqual(['v']);
  });
  it('searches the number and the supplier, ignoring case and spaces around', () => {
    expect(ids(filterBills(rows, '  maju ', 'open'))).toEqual(['o', 'x']);
    expect(ids(filterBills(rows, 'bill-0007', 'open'))).toEqual(['p']);
    expect(ids(filterBills(rows, 'lim', 'void'))).toEqual(['v']);
    expect(filterBills(rows, 'nobody', 'open')).toEqual([]);
  });
  it('does not match a draft on the word null', () => {
    expect(filterBills(rows, 'null', 'open')).toEqual([]);
  });
});

describe('filterPayments', () => {
  const rows = [
    payment({ allocation_id: 'paid', number: 'PV-0003', bill_no: 'BILL-0007', reference: 'MBB 8841' }),
    payment({ allocation_id: 'later', number: null, status: 'scheduled', method: 'cheque', supplier_name: 'Maju Jaya', bill_no: 'BILL-0008' }),
    payment({ allocation_id: 'gone', number: 'PV-0002', status: 'void', method: 'cash' }),
  ];
  const ids = (list: PaymentOutRow[]) => list.map((p) => p.allocation_id);

  it('shows paid and scheduled until a status is chosen', () => {
    expect(ids(filterPayments(rows, '', 'current', 'all'))).toEqual(['paid', 'later']);
    expect(ids(filterPayments(rows, '', 'all', 'all'))).toEqual(['paid', 'later', 'gone']);
    expect(ids(filterPayments(rows, '', 'void', 'all'))).toEqual(['gone']);
    expect(ids(filterPayments(rows, '', 'posted', 'all'))).toEqual(['paid']);
    expect(ids(filterPayments(rows, '', 'scheduled', 'all'))).toEqual(['later']);
  });
  it('narrows by method', () => {
    expect(ids(filterPayments(rows, '', 'all', 'cash'))).toEqual(['gone']);
    expect(ids(filterPayments(rows, '', 'current', 'cash'))).toEqual([]);
  });
  it('searches supplier, bill number, voucher number and reference', () => {
    expect(ids(filterPayments(rows, 'maju', 'all', 'all'))).toEqual(['later']);
    expect(ids(filterPayments(rows, 'bill-0007', 'all', 'all'))).toEqual(['paid']);
    expect(ids(filterPayments(rows, 'pv-0002', 'all', 'all'))).toEqual(['gone']);
    expect(ids(filterPayments(rows, 'mbb', 'all', 'all'))).toEqual(['paid']);
    expect(filterPayments(rows, 'null', 'all', 'all')).toEqual([]);
  });
});

describe('siblingBills', () => {
  const first = payment({ allocation_id: 'a1', transaction_id: 't1', bill_no: 'BILL-0007' });
  const second = payment({ allocation_id: 'a2', transaction_id: 't1', bill_no: 'BILL-0009' });
  const third = payment({ allocation_id: 'a3', transaction_id: 't1', bill_no: 'BILL-0008' });
  const alone = payment({ allocation_id: 'a4', transaction_id: 't2', bill_no: 'BILL-0010' });
  const rows = [first, second, third, alone];

  it('names the other bills of a split payment, from whichever row is asked', () => {
    expect(siblingBills(rows, first)).toEqual(['BILL-0008', 'BILL-0009']);
    expect(siblingBills(rows, second)).toEqual(['BILL-0007', 'BILL-0008']);
  });
  it('is empty for a payment against one bill', () => {
    expect(siblingBills(rows, alone)).toEqual([]);
    expect(alsoCovers(rows, alone)).toBe('');
  });
  it('says so in a sentence, whichever row the menu was opened from', () => {
    const two = [first, second];
    expect(alsoCovers(two, second)).toBe('This payment also covers BILL-0007.');
    expect(alsoCovers(two, first)).toBe('This payment also covers BILL-0009.');
    expect(alsoCovers(rows, second)).toBe('This payment also covers BILL-0007 and BILL-0008.');
    const fourth = payment({ allocation_id: 'a5', transaction_id: 't1', bill_no: 'BILL-0011' });
    expect(alsoCovers([...rows, fourth], fourth)).toBe('This payment also covers BILL-0007, BILL-0008 and BILL-0009.');
  });
});

describe('CSV export', () => {
  it('writes the bills table, with a formula-looking supplier name made harmless', () => {
    const csv = billsCsv([
      bill({ bill_no: 'BILL-0007', supplier_name: '=cmd|calc', total: 1250.5, balance: 250.5, bill_date: '2026-10-01', due_date: '2026-10-31', purchase_order_id: 'po-1', purchase_order_no: 'PO-0003' }),
      bill({ bill_no: null, supplier_name: 'Lim, Tan & Co', total: 80, balance: 80, display_status: 'draft' }),
    ]);
    expect(csv).toBe(
      '﻿No.,Date,Supplier,Due,Total,Balance,Status,Purchase order\r\n' +
        "BILL-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,250.5,Pending,PO-0003\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,80,Draft,\r\n',
    );
  });

  it('writes the payments table with the method and status as the screen words them', () => {
    const csv = paymentsCsv([
      payment({ number: 'PV-0003', bill_no: 'BILL-0007', amount: 132.5, method: 'bank_transfer' }),
      payment({ number: null, status: 'scheduled', bill_no: 'BILL-0008', amount: 40, method: 'ewallet', supplier_name: '+60 Trading' }),
    ]);
    expect(csv).toBe(
      '﻿Date,No.,Supplier,Bill,Account,Method,Amount,Status\r\n' +
        '2026-10-05,PV-0003,Lim Hardware,BILL-0007,Main Bank,Bank Transfer,132.5,Paid\r\n' +
        "2026-10-05,,'+60 Trading,BILL-0008,Main Bank,E-Wallet,40,To be paid\r\n",
    );
  });
});

describe('displayDate', () => {
  it('writes the month as a fixed three-letter name', () => {
    expect(displayDate('2026-10-08')).toBe('08 Oct 2026');
    expect(displayDate('2026-09-30')).toBe('30 Sep 2026');
  });
});

const rfq = (r: Partial<RfqListRow>): RfqListRow => {
  seq += 1;
  return {
    id: `rfq-${seq}`,
    rfq_no: `RFQ-${String(seq).padStart(4, '0')}`,
    supplier_id: 'kertas',
    supplier_name: 'Syarikat Kertas',
    rfq_date: '2026-10-01',
    reply_by: '2026-10-20',
    supplier_ref: null,
    status: 'sent',
    line_count: 2,
    total: 0,
    fully_priced: false,
    purchase_order_id: null,
    purchase_order_no: null,
    ...r,
  };
};

describe('rfqDisplayStatus', () => {
  it('is overdue only for a sent RFQ whose reply-by date has passed', () => {
    expect(rfqDisplayStatus(rfq({ status: 'sent', reply_by: '2026-10-08' }), today)).toBe('overdue');
    expect(rfqDisplayStatus(rfq({ status: 'sent', reply_by: today }), today)).toBe('sent');
    expect(rfqDisplayStatus(rfq({ status: 'sent', reply_by: null }), today)).toBe('sent');
    for (const status of ['draft', 'quoted', 'closed'] as const) {
      expect(rfqDisplayStatus(rfq({ status, rfq_no: null, reply_by: '2026-10-08' }), today)).toBe(status);
    }
  });
  it('words every status', () => {
    expect(RFQ_STATUS_LABELS).toEqual({ draft: 'Draft', sent: 'Sent', quoted: 'Quoted', closed: 'Closed', overdue: 'Reply overdue' });
  });
});

describe('filterRfqs', () => {
  const rows = [
    rfq({ rfq_no: null, status: 'draft', supplier_name: 'Lim Hardware' }),
    rfq({ rfq_no: 'RFQ-0007', status: 'sent', reply_by: '2026-10-08' }),
    rfq({ rfq_no: 'RFQ-0008', status: 'sent', reply_by: '2026-10-30' }),
    rfq({ rfq_no: 'RFQ-0009', status: 'quoted', supplier_ref: 'Q-4411' }),
    rfq({ rfq_no: 'RFQ-0010', status: 'closed' }),
  ];
  it('shows everything but closed by default', () => {
    expect(filterRfqs(rows, '', 'open', today).map((r) => r.rfq_no)).toEqual([null, 'RFQ-0007', 'RFQ-0008', 'RFQ-0009']);
    expect(filterRfqs(rows, '', 'all', today)).toHaveLength(5);
  });
  it('filters by display status, so an overdue RFQ is not also "sent"', () => {
    expect(filterRfqs(rows, '', 'overdue', today).map((r) => r.rfq_no)).toEqual(['RFQ-0007']);
    expect(filterRfqs(rows, '', 'sent', today).map((r) => r.rfq_no)).toEqual(['RFQ-0008']);
    expect(filterRfqs(rows, '', 'closed', today).map((r) => r.rfq_no)).toEqual(['RFQ-0010']);
  });
  it('searches the number, the supplier and the supplier’s reference', () => {
    expect(filterRfqs(rows, ' rfq-0008 ', 'all', today)).toHaveLength(1);
    expect(filterRfqs(rows, 'lim', 'all', today)).toHaveLength(1);
    expect(filterRfqs(rows, 'q-4411', 'all', today).map((r) => r.rfq_no)).toEqual(['RFQ-0009']);
    expect(filterRfqs(rows, 'nothing', 'all', today)).toEqual([]);
  });
});

describe('rfqActions', () => {
  it('offers only what the status allows', () => {
    expect(rfqActions(rfq({ status: 'draft', rfq_no: null }))).toEqual(['edit', 'send', 'delete']);
    expect(rfqActions(rfq({ status: 'sent' }))).toEqual(['recordPrices', 'close']);
    expect(rfqActions(rfq({ status: 'sent', reply_by: '2026-10-01' }))).toEqual(['recordPrices', 'close']);
    expect(rfqActions(rfq({ status: 'quoted' }))).toEqual(['convert', 'close']);
    expect(rfqActions(rfq({ status: 'closed' }))).toEqual([]);
  });
  it('offers a purchase order only for a quoted RFQ that has none: a standing order is the way on', () => {
    expect(rfqActions(rfq({ status: 'quoted', purchase_order_id: 'po-1', purchase_order_no: 'PO-0003' }))).toEqual(['close']);
    for (const status of ['draft', 'sent', 'closed'] as const) {
      expect(rfqActions(rfq({ status, purchase_order_id: null })), status).not.toContain('convert');
    }
  });
  it('names an RFQ by its number, or as a draft', () => {
    expect(rfqName(rfq({ rfq_no: 'RFQ-0007' }))).toBe('RFQ-0007');
    expect(rfqName(rfq({ rfq_no: null, status: 'draft' }))).toBe('this draft RFQ');
  });
});

describe('rfqsView', () => {
  it('counts each status, those waiting for a reply, and those overdue', () => {
    const rows = [
      rfq({ status: 'draft', rfq_no: null }),
      rfq({ status: 'sent', reply_by: '2026-10-08' }),
      rfq({ status: 'sent', reply_by: '2026-10-30' }),
      rfq({ status: 'sent', reply_by: null }),
      rfq({ status: 'quoted' }),
      rfq({ status: 'closed' }),
    ];
    expect(rfqsView(rows, today)).toEqual({
      counts: { draft: 1, sent: 2, quoted: 1, closed: 1, overdue: 1 },
      awaitingReply: 3,
      overdue: 1,
    });
  });
  it('is all zeros for no RFQs', () => {
    expect(rfqsView([], today)).toEqual({ counts: { draft: 0, sent: 0, quoted: 0, closed: 0, overdue: 0 }, awaitingReply: 0, overdue: 0 });
  });
});

describe('rfqsCsv', () => {
  it('writes the RFQ table, with the status as the screen words it', () => {
    const csv = rfqsCsv(
      [
        rfq({ rfq_no: 'RFQ-0007', rfq_date: '2026-10-01', reply_by: '2026-10-08', supplier_name: '=cmd|calc', status: 'sent', line_count: 3 }),
        rfq({ rfq_no: null, status: 'draft', reply_by: null, supplier_name: 'Lim, Tan & Co', line_count: 1 }),
        rfq({ rfq_no: 'RFQ-0009', status: 'quoted', supplier_ref: 'Q-4411', total: 132.5, fully_priced: true, line_count: 2, purchase_order_no: 'PO-0003' }),
        rfq({ rfq_no: 'RFQ-0010', status: 'sent', total: 40, fully_priced: false, line_count: 2 }),
      ],
      today,
    );
    expect(csv).toBe(
      '\uFEFFNo.,Date,Supplier,Reply by,Supplier ref,Lines,Total,Status,Purchase order\r\n' +
        "RFQ-0007,2026-10-01,'=cmd|calc,2026-10-08,,3,,Reply overdue,\r\n" +
        ',2026-10-01,"Lim, Tan & Co",,,1,,Draft,\r\n' +
        'RFQ-0009,2026-10-01,Syarikat Kertas,2026-10-20,Q-4411,2,132.5,Quoted,PO-0003\r\n' +
        'RFQ-0010,2026-10-01,Syarikat Kertas,2026-10-20,,2,,Sent,\r\n',
    );
  });
});

/* ---- purchase orders ------------------------------------------------ */

const po = (r: Partial<PurchaseOrderListRow>): PurchaseOrderListRow => {
  seq += 1;
  return {
    id: `po-${seq}`,
    po_no: `PO-${String(seq).padStart(4, '0')}`,
    supplier_id: 'kertas',
    supplier_name: 'Syarikat Kertas',
    rfq_id: null,
    rfq_no: null,
    po_date: '2026-10-01',
    expected_date: null,
    status: 'approved',
    created_by: 'raiser',
    submitted_by: 'raiser',
    rejection_reason: null,
    payment_terms_days: 30,
    delivery_address: null,
    total: 100,
    delivery: 'pending',
    received_total: 0,
    billed_total: 0,
    over_billed: false,
    billed_over_received: false,
    ...r,
  };
};

describe('purchase order labels', () => {
  it('words each status and delivery state', () => {
    expect(PO_STATUS_LABELS).toEqual({
      draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled',
    });
    expect(PO_DELIVERY_LABELS).toEqual({ pending: 'Not delivered', partial: 'Partly delivered', delivered: 'Delivered' });
  });
});

describe('filterPurchaseOrders', () => {
  const rows = [
    po({ po_no: null, status: 'draft', supplier_name: 'Lim Hardware' }),
    po({ po_no: 'PO-0007', status: 'pending_approval' }),
    po({ po_no: 'PO-0008', status: 'approved', rfq_no: 'RFQ-0042' }),
    po({ po_no: 'PO-0009', status: 'closed' }),
    po({ po_no: 'PO-0010', status: 'cancelled' }),
  ];
  it('shows what is still going on until a status is chosen', () => {
    expect(filterPurchaseOrders(rows, '', 'open').map((r) => r.po_no)).toEqual([null, 'PO-0007', 'PO-0008']);
    expect(filterPurchaseOrders(rows, '', 'all')).toHaveLength(5);
  });
  it('filters by one status', () => {
    expect(filterPurchaseOrders(rows, '', 'closed').map((r) => r.po_no)).toEqual(['PO-0009']);
    expect(filterPurchaseOrders(rows, '', 'cancelled').map((r) => r.po_no)).toEqual(['PO-0010']);
    expect(filterPurchaseOrders(rows, '', 'pending_approval').map((r) => r.po_no)).toEqual(['PO-0007']);
  });
  it('matches the search text against the number, the supplier and the RFQ number, ignoring case and spaces', () => {
    expect(filterPurchaseOrders(rows, ' po-0008 ', 'all')).toHaveLength(1);
    expect(filterPurchaseOrders(rows, 'lim', 'all')).toHaveLength(1);
    expect(filterPurchaseOrders(rows, 'rfq-0042', 'all').map((r) => r.po_no)).toEqual(['PO-0008']);
    expect(filterPurchaseOrders(rows, 'nothing', 'all')).toEqual([]);
  });
});

describe('purchaseOrderActions', () => {
  // A member, the admin who raised the order, another admin, and the owner. The order is raised by 'raiser'.
  const member = { userId: 'raiser', canSignOff: false, isOwner: false };
  const otherMember = { userId: 'someone', canSignOff: false, isOwner: false };
  const raisingAdmin = { userId: 'raiser', canSignOff: true, isOwner: false };
  const otherAdmin = { userId: 'admin', canSignOff: true, isOwner: false };
  const owner = { userId: 'owner', canSignOff: true, isOwner: true };
  const raisingOwner = { userId: 'raiser', canSignOff: true, isOwner: true };

  it('offers a draft that was never numbered to be edited, submitted or deleted, to anyone who may write', () => {
    const draft = po({ status: 'draft', po_no: null, submitted_by: null });
    for (const viewer of [member, otherMember, raisingAdmin, otherAdmin, owner]) {
      expect(purchaseOrderActions(draft, viewer), JSON.stringify(viewer)).toEqual(['edit', 'submit', 'delete']);
    }
  });
  it('offers a numbered draft (rejected or withdrawn) to be cancelled, not deleted, by its raiser or an admin', () => {
    const rejected = po({ status: 'draft', po_no: 'PO-0007', rejection_reason: 'Too dear' });
    expect(purchaseOrderActions(rejected, member)).toEqual(['edit', 'submit', 'cancel']);
    expect(purchaseOrderActions(rejected, otherMember)).toEqual(['edit', 'submit']);
    expect(purchaseOrderActions(rejected, otherAdmin)).toEqual(['edit', 'submit', 'cancel']);
    expect(purchaseOrderActions(rejected, owner)).toEqual(['edit', 'submit', 'cancel']);
  });
  it('offers a numbered draft with no recorded raiser to edit and submit, and to cancel only to a sign-off viewer', () => {
    const orphan = po({ status: 'draft', po_no: 'PO-0007', created_by: null, submitted_by: null });
    expect(purchaseOrderActions(orphan, member)).toEqual(['edit', 'submit']);
    expect(purchaseOrderActions(orphan, otherAdmin)).toEqual(['edit', 'submit', 'cancel']);
  });
  describe('awaiting approval', () => {
    const pending = po({ status: 'pending_approval', created_by: 'raiser', submitted_by: 'submitter' });
    it('lets the person who raised it take it back or cancel it, and nothing more', () => {
      expect(purchaseOrderActions(pending, member)).toEqual(['withdraw', 'cancel']);
    });
    it('lets another member do nothing', () => {
      expect(purchaseOrderActions(pending, otherMember)).toEqual([]);
    });
    it('lets another admin approve, reject, withdraw or cancel it', () => {
      expect(purchaseOrderActions(pending, otherAdmin)).toEqual(['approve', 'reject', 'withdraw', 'cancel']);
    });
    it('lets the admin who raised it reject, withdraw or cancel it, but not approve it', () => {
      expect(purchaseOrderActions(pending, raisingAdmin)).toEqual(['reject', 'withdraw', 'cancel']);
    });
    it('keeps the person who submitted it from approving it, even when someone else raised it', () => {
      const submitter = { userId: 'submitter', canSignOff: true, isOwner: false };
      expect(purchaseOrderActions(pending, submitter)).toEqual(['reject', 'withdraw', 'cancel']);
      expect(purchaseOrderActions(pending, { ...submitter, canSignOff: false })).toEqual([]);
    });
    it('lets the owner approve even an order they raised or submitted', () => {
      expect(purchaseOrderActions(pending, owner)).toEqual(['approve', 'reject', 'withdraw', 'cancel']);
      expect(purchaseOrderActions(pending, raisingOwner)).toEqual(['approve', 'reject', 'withdraw', 'cancel']);
    });
    it('treats an order with no known raiser as nobody’s own', () => {
      const orphan = po({ status: 'pending_approval', created_by: null, submitted_by: null });
      expect(purchaseOrderActions(orphan, otherAdmin)).toEqual(['approve', 'reject', 'withdraw', 'cancel']);
      expect(purchaseOrderActions(orphan, member)).toEqual([]);
    });
  });
  describe('approved', () => {
    const approved = po({ status: 'approved' });
    it('lets anyone who may write record a delivery and raise a bill', () => {
      for (const viewer of [member, otherMember]) {
        expect(purchaseOrderActions(approved, viewer), JSON.stringify(viewer)).toEqual(['receive', 'createBill']);
      }
    });
    it('lets an admin or the owner also close or cancel it', () => {
      for (const viewer of [raisingAdmin, otherAdmin, owner]) {
        expect(purchaseOrderActions(approved, viewer), JSON.stringify(viewer)).toEqual(['receive', 'createBill', 'close', 'cancel']);
      }
    });
  });
  it('offers nothing on a closed or a cancelled order', () => {
    for (const status of ['closed', 'cancelled'] as const) {
      for (const viewer of [member, otherAdmin, owner]) {
        expect(purchaseOrderActions(po({ status }), viewer), `${status} ${JSON.stringify(viewer)}`).toEqual([]);
      }
    }
  });
  it('names an order by its number, or as a draft', () => {
    expect(purchaseOrderName(po({ po_no: 'PO-0007' }))).toBe('PO-0007');
    expect(purchaseOrderName(po({ po_no: null, status: 'draft' }))).toBe('this draft purchase order');
  });
});

describe('purchaseOrdersView', () => {
  it('counts those awaiting approval, those approved and still open, and those billed for more than ordered', () => {
    const rows = [
      po({ status: 'draft', po_no: null }),
      po({ status: 'pending_approval' }),
      po({ status: 'pending_approval' }),
      po({ status: 'approved' }),
      po({ status: 'approved', over_billed: true, billed_total: 120 }),
      po({ status: 'closed', over_billed: true, billed_total: 130 }),
      po({ status: 'cancelled' }),
    ];
    expect(purchaseOrdersView(rows)).toEqual({ awaitingApproval: 2, approvedOpen: 2, overBilled: 2 });
  });
  it('is all zeros for no orders', () => {
    expect(purchaseOrdersView([])).toEqual({ awaitingApproval: 0, approvedOpen: 0, overBilled: 0 });
  });
});

describe('purchaseOrdersCsv', () => {
  it('writes the purchase order table, with the status and delivery as the screen words them', () => {
    const csv = purchaseOrdersCsv([
      po({
        po_no: 'PO-0007', po_date: '2026-10-01', supplier_name: '=cmd|calc', rfq_no: 'RFQ-0042', expected_date: '2026-10-20',
        total: 132.5, received_total: 50, billed_total: 40, delivery: 'partial', status: 'approved',
      }),
      po({ po_no: null, status: 'draft', supplier_name: 'Lim, Tan & Co', total: 10, delivery: 'pending' }),
      po({ po_no: 'PO-0009', status: 'closed', total: 100, received_total: 100, billed_total: 100, delivery: 'delivered' }),
    ]);
    expect(csv).toBe(
      '\uFEFFNo.,Date,Supplier,RFQ,Expected delivery,Total,Received,Billed,Delivery,Status\r\n' +
        "PO-0007,2026-10-01,'=cmd|calc,RFQ-0042,2026-10-20,132.5,50,40,Partly delivered,Approved\r\n" +
        ',2026-10-01,"Lim, Tan & Co",,,10,0,0,,Draft\r\n' +
        'PO-0009,2026-10-01,Syarikat Kertas,,,100,100,100,Delivered,Closed\r\n',
    );
  });
});
