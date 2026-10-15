import { describe, expect, it } from 'vitest';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { PaymentInRow } from '@/lib/finance/money';
import {
  EINVOICE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  PAYMENT_IN_STATUS_LABELS,
  balanceText,
  filterInvoices,
  filterPaymentsIn,
  inCredit,
  invoiceCustomers,
  invoicesCsv,
  owed,
  invoicesView,
  paymentsInCsv,
  paymentsInView,
} from '@/lib/finance/sales-views';
import { SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY } from '@/screens/finance/sales-sample';

const today = '2026-10-09';

let seq = 0;
const invoice = (i: Partial<InvoiceListRow>): InvoiceListRow => {
  seq += 1;
  return {
    id: `invoice-${seq}`,
    invoice_no: `INV-${String(seq).padStart(4, '0')}`,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 100,
    paid: 0,
    credited: 0,
    refunded: 0,
    balance: 100,
    display_status: 'sent',
    einvoice_status: 'none',
    einvoice_uuid: null,
    ...i,
  };
};

const payment = (p: Partial<PaymentInRow>): PaymentInRow => {
  seq += 1;
  return {
    allocation_id: `alloc-${seq}`,
    transaction_id: `txn-${seq}`,
    number: `RC-${String(seq).padStart(4, '0')}`,
    txn_date: '2026-10-05',
    method: 'fpx',
    amount: 100,
    transaction_amount: 100,
    status: 'posted',
    reference: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    invoice_id: 'invoice-x',
    invoice_no: 'INV-0001',
    customer_name: 'Aisyah Trading',
    ...p,
  };
};

describe('status words', () => {
  it('calls a posted invoice Sent and a posted payment in Received', () => {
    expect(INVOICE_STATUS_LABELS).toEqual({ draft: 'Draft', sent: 'Sent', overdue: 'Overdue', paid: 'Paid', void: 'Void' });
    expect(PAYMENT_IN_STATUS_LABELS.posted).toBe('Received');
    expect(PAYMENT_IN_STATUS_LABELS.void).toBe('Void');
    expect(EINVOICE_STATUS_LABELS).toEqual({ none: '', pending: 'Pending', validated: 'Validated', rejected: 'Rejected' });
  });
});

describe('invoicesView', () => {
  it('sums what is owed, what is due this week, what is overdue and what was received this month', () => {
    const view = invoicesView(
      [
        invoice({ balance: 2600, due_date: '2026-10-13' }),
        invoice({ balance: 4300, customer_id: 'zaki', customer_name: 'Zaki Enterprise', due_date: '2026-11-01' }),
        invoice({ balance: 1800, display_status: 'overdue', due_date: '2026-10-04' }),
        invoice({ balance: 0, paid: 100, display_status: 'paid' }),
        invoice({ balance: 780, display_status: 'draft', invoice_no: null }),
        invoice({ balance: 999, display_status: 'void' }),
      ],
      [payment({ amount: 1450 }), payment({ amount: 500, txn_date: '2026-09-30' })],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Total receivable', 'RM 8,700', '3 open invoices'],
      ['Due this week', 'RM 2,600', '1 invoice'],
      ['Overdue', 'RM 1,800', '1 invoice'],
      ['Received (MTD)', 'RM 1,450', '1 payment'],
    ]);
    expect(view.stats[2].deltaTone).toBe('down');
  });

  it('keeps a part-paid invoice in what is owed, at its lower balance', () => {
    const view = invoicesView([invoice({ total: 3500, paid: 1000, balance: 2500 })], [payment({ amount: 1000 })], today);
    expect([view.stats[0].value, view.stats[0].delta]).toEqual(['RM 2,500', '1 open invoice']);
  });

  it('counts a due date exactly a week away as due this week, and the day after as not', () => {
    const due = (due_date: string) => invoicesView([invoice({ due_date })], [], today).stats[1].delta;
    expect(due('2026-10-16')).toBe('1 invoice');
    expect(due('2026-10-17')).toBe('0 invoices');
  });

  it('counts a payment split across two invoices once, and adds both parts', () => {
    const view = invoicesView(
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

  it('does not count a voided or half-written payment as received', () => {
    const view = invoicesView([], [payment({ status: 'void' }), payment({ status: 'draft', number: null })], today);
    expect([view.stats[3].value, view.stats[3].delta]).toEqual(['RM 0', '0 payments']);
    expect(view.hasTrend).toBe(false);
  });

  it('leaves void invoices out of the status donut and its count', () => {
    const view = invoicesView(
      [invoice({}), invoice({}), invoice({ display_status: 'paid' }), invoice({ display_status: 'overdue' }), invoice({ display_status: 'draft' }), invoice({ display_status: 'void' })],
      [],
      today,
    );
    expect(view.byStatus.map((s) => [s.label, s.value])).toEqual([
      ['Sent', 2],
      ['Paid', 1],
      ['Overdue', 1],
      ['Draft', 1],
    ]);
    expect(view.invoiceCount).toBe(5);
  });

  it('charts what was invoiced and what was received over the last 8 months, in RM thousands', () => {
    const view = invoicesView(
      [
        invoice({ total: 3000 }),
        invoice({ total: 1500, display_status: 'paid' }),
        invoice({ total: 2500, invoice_date: '2026-03-02', display_status: 'overdue' }),
        invoice({ total: 999, invoice_date: '2026-02-27' }), // older than 8 months
        invoice({ total: 7000, display_status: 'draft', invoice_no: null }), // not issued
        invoice({ total: 8000, display_status: 'void' }),
      ],
      [payment({ amount: 1500 }), payment({ amount: 700, txn_date: '2026-09-30' })],
      today,
    );
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend[0]).toEqual({ label: 'Mar', invoiced: 2.5, received: 0 });
    expect(view.trend[6]).toEqual({ label: 'Sep', invoiced: 0, received: 0.7 });
    expect(view.trend[7]).toEqual({ label: 'Oct', invoiced: 4.5, received: 1.5 });
    expect(view.hasTrend).toBe(true);
  });

  describe('hasTrend', () => {
    it('is true for one small invoice this month, although the chart rounds it to nothing', () => {
      const view = invoicesView([invoice({ total: 30 })], [], today);
      expect(view.hasTrend).toBe(true);
      expect(view.trend.every((t) => t.invoiced === 0 && t.received === 0)).toBe(true);
    });
    it('is true for one small payment at the oldest month the trend covers', () => {
      expect(invoicesView([], [payment({ amount: 30, txn_date: '2026-03-01' })], today).hasTrend).toBe(true);
    });
    it('is false when everything is older than the eight months, a draft or void', () => {
      const view = invoicesView(
        [invoice({ invoice_date: '2026-02-28' }), invoice({ display_status: 'draft', invoice_no: null }), invoice({ display_status: 'void' })],
        [payment({ txn_date: '2026-01-09' })],
        today,
      );
      expect(view.hasTrend).toBe(false);
    });
  });

  it('adds sen without floating point drift', () => {
    const view = invoicesView([invoice({ balance: 0.1 }), invoice({ balance: 0.2 }), invoice({ balance: 9999.7 })], [], today);
    expect(view.stats[0].value).toBe('RM 10.0k');
  });

  it('is all zeros for a workspace with nothing yet', () => {
    const view = invoicesView([], [], today);
    expect(view.stats.map((s) => s.value)).toEqual(['RM 0', 'RM 0', 'RM 0', 'RM 0']);
    expect(view.stats[2].deltaTone).toBe('flat');
    expect(view.hasTrend).toBe(false);
    expect(view.invoiceCount).toBe(0);
    expect(view.byStatus.map((s) => s.value)).toEqual([0, 0, 0, 0]);
  });
});

describe('paymentsInView', () => {
  it('counts only received money: the total, how many payments, their average and the electronic share', () => {
    const view = paymentsInView(
      [
        payment({ amount: 3000, method: 'bank_transfer' }),
        payment({ amount: 1000, method: 'cash' }),
        payment({ amount: 700, status: 'void' }),
        payment({ amount: 2500, txn_date: '2026-03-02' }),
        payment({ amount: 999, txn_date: '2026-02-27' }), // older than 8 months
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Received (MTD)', 'RM 4,000', 'this month'],
      ['Payments', '2', 'this month'],
      ['Average payment', 'RM 2,000', 'this month'],
      ['Via bank / FPX', '75%', 'of received MTD'],
    ]);
    expect(view.receivedMtd).toBe('RM 4,000');
    expect(view.hasReceived).toBe(true);
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend[0]).toEqual({ label: 'Mar', received: 2.5 });
    expect(view.trend[7]).toEqual({ label: 'Oct', received: 4 });
  });

  it('counts a payment split across three invoices once: the parts add up, the average is per payment', () => {
    const view = paymentsInView(
      [
        payment({ transaction_id: 'split', amount: 60, transaction_amount: 150 }),
        payment({ transaction_id: 'split', amount: 40, transaction_amount: 150 }),
        payment({ transaction_id: 'split', amount: 50, transaction_amount: 150 }),
        payment({ amount: 50 }),
      ],
      today,
    );
    expect(view.stats.map((s) => s.value)).toEqual(['RM 200', '2', 'RM 100', '100%']);
  });

  it('shows only the methods used this month, with their own labels and amounts in RM', () => {
    const view = paymentsInView(
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

  it('keeps all seven methods at zero, with dashes for the ratios, when nothing was received this month', () => {
    const view = paymentsInView([payment({ status: 'void' }), payment({ txn_date: '2026-09-30' })], today);
    expect(view.byMethod.map((s) => s.label)).toEqual(['Bank Transfer', 'FPX', 'DuitNow', 'Card', 'E-Wallet', 'Cash', 'Cheque']);
    expect(view.byMethod.every((s) => s.value === 0)).toBe(true);
    expect(view.hasReceived).toBe(false);
    expect(view.stats.map((s) => s.value)).toEqual(['RM 0', '0', '—', '—']);
    expect(view.hasTrend).toBe(true);
  });

  describe('hasTrend and hasReceived', () => {
    it('are true for one payment of one sen this month, although the chart rounds it to nothing', () => {
      const view = paymentsInView([payment({ amount: 0.01 })], today);
      expect(view.hasTrend).toBe(true);
      expect(view.hasReceived).toBe(true);
      expect(view.trend.every((t) => t.received === 0)).toBe(true);
    });
    it('are false with only voided payments, and with no rows', () => {
      expect(paymentsInView([payment({ status: 'void' })], today)).toMatchObject({ hasTrend: false, hasReceived: false });
      expect(paymentsInView([], today)).toMatchObject({ hasTrend: false, hasReceived: false });
    });
    it('hasTrend is false when the only payment is older than the eight months', () => {
      expect(paymentsInView([payment({ amount: 5000, txn_date: '2026-02-28' })], today).hasTrend).toBe(false);
    });
  });

  it('uses no purple, violet, indigo or fuchsia for a method', () => {
    for (const slice of paymentsInView([], today).byMethod) {
      expect(slice.color, slice.label).toMatch(/^(var\(--chart-[1-5]\)|oklch\(0\.\d+ 0\.\d+ (\d+)\))$/);
      const hue = /oklch\([\d.]+ [\d.]+ (\d+)\)/.exec(slice.color ?? '')?.[1];
      // Violet to fuchsia sits between hue 270 and 350.
      if (hue) expect(Number(hue) < 270 || Number(hue) > 350, slice.label).toBe(true);
    }
  });
});

describe('filterInvoices', () => {
  const rows = [
    invoice({ id: 's', invoice_no: 'INV-0007', customer_id: 'aisyah', customer_name: 'Aisyah Trading' }),
    invoice({ id: 'o', invoice_no: 'INV-0008', customer_id: 'zaki', customer_name: 'Zaki Enterprise', display_status: 'overdue' }),
    invoice({ id: 'd', invoice_no: null, customer_id: 'aisyah', customer_name: 'Aisyah Trading', display_status: 'draft' }),
    invoice({ id: 'p', invoice_no: 'INV-0009', customer_id: 'zaki', customer_name: 'Zaki Enterprise', display_status: 'paid' }),
    invoice({ id: 'v', invoice_no: 'INV-0010', customer_id: 'aisyah', customer_name: 'Aisyah Trading', display_status: 'void' }),
  ];
  const ids = (list: InvoiceListRow[]) => list.map((i) => i.id);

  it('shows everything except void invoices until a status is chosen', () => {
    expect(ids(filterInvoices(rows, '', 'open'))).toEqual(['s', 'o', 'd', 'p']);
  });
  it('shows one status when chosen, void included', () => {
    expect(ids(filterInvoices(rows, '', 'sent'))).toEqual(['s']);
    expect(ids(filterInvoices(rows, '', 'draft'))).toEqual(['d']);
    expect(ids(filterInvoices(rows, '', 'void'))).toEqual(['v']);
  });
  it('narrows to one customer by id, together with the status', () => {
    expect(ids(filterInvoices(rows, '', 'open', 'zaki'))).toEqual(['o', 'p']);
    expect(ids(filterInvoices(rows, '', 'paid', 'aisyah'))).toEqual([]);
    expect(ids(filterInvoices(rows, '', 'open', 'all'))).toEqual(['s', 'o', 'd', 'p']);
  });
  it('searches the number and the customer, ignoring case and spaces around', () => {
    expect(ids(filterInvoices(rows, '  zaki ', 'open'))).toEqual(['o', 'p']);
    expect(ids(filterInvoices(rows, 'inv-0007', 'open'))).toEqual(['s']);
    expect(filterInvoices(rows, 'nobody', 'open')).toEqual([]);
  });
  it('does not match a draft on the word null', () => {
    expect(filterInvoices(rows, 'null', 'open')).toEqual([]);
  });
});

describe('invoiceCustomers', () => {
  it('lists each customer once, by name, and keeps two customers with one name apart', () => {
    expect(
      invoiceCustomers([
        invoice({ customer_id: 'z', customer_name: 'Zaki Enterprise' }),
        invoice({ customer_id: 'a2', customer_name: 'Ali Trading' }),
        invoice({ customer_id: 'a1', customer_name: 'Ali Trading' }),
        invoice({ customer_id: 'z', customer_name: 'Zaki Enterprise' }),
      ]),
    ).toEqual([
      { id: 'a1', name: 'Ali Trading' },
      { id: 'a2', name: 'Ali Trading' },
      { id: 'z', name: 'Zaki Enterprise' },
    ]);
    expect(invoiceCustomers([])).toEqual([]);
  });
});

describe('filterPaymentsIn', () => {
  const rows = [
    payment({ allocation_id: 'got', number: 'RC-0003', invoice_no: 'INV-0007', reference: 'MBB 8841' }),
    payment({ allocation_id: 'cash', number: 'RC-0004', method: 'cash', customer_name: 'Zaki Enterprise', invoice_no: 'INV-0008' }),
    payment({ allocation_id: 'gone', number: 'RC-0002', status: 'void', method: 'cash' }),
  ];
  const ids = (list: PaymentInRow[]) => list.map((p) => p.allocation_id);

  it('shows received payments until a status is chosen', () => {
    expect(ids(filterPaymentsIn(rows, '', 'posted', 'all'))).toEqual(['got', 'cash']);
    expect(ids(filterPaymentsIn(rows, '', 'void', 'all'))).toEqual(['gone']);
    expect(ids(filterPaymentsIn(rows, '', 'all', 'all'))).toEqual(['got', 'cash', 'gone']);
  });
  it('narrows by method', () => {
    expect(ids(filterPaymentsIn(rows, '', 'posted', 'cash'))).toEqual(['cash']);
    expect(ids(filterPaymentsIn(rows, '', 'all', 'cash'))).toEqual(['cash', 'gone']);
    expect(ids(filterPaymentsIn(rows, '', 'posted', 'cheque'))).toEqual([]);
  });
  it('searches customer, invoice number, receipt number and reference', () => {
    expect(ids(filterPaymentsIn(rows, 'zaki', 'all', 'all'))).toEqual(['cash']);
    expect(ids(filterPaymentsIn(rows, 'inv-0007', 'all', 'all'))).toEqual(['got']);
    expect(ids(filterPaymentsIn(rows, 'rc-0002', 'all', 'all'))).toEqual(['gone']);
    expect(ids(filterPaymentsIn(rows, 'mbb', 'all', 'all'))).toEqual(['got']);
    expect(filterPaymentsIn(rows, 'null', 'all', 'all')).toEqual([]);
  });
});

describe('owed', () => {
  it('is the balance of an issued invoice and nothing for a draft or a void one', () => {
    expect(owed(invoice({ display_status: 'sent', balance: 40 }))).toBe(40);
    expect(owed(invoice({ display_status: 'overdue', balance: 25 }))).toBe(25);
    expect(owed(invoice({ display_status: 'paid', balance: 0 }))).toBe(0);
    expect(owed(invoice({ display_status: 'draft', balance: 80 }))).toBeNull();
    expect(owed(invoice({ display_status: 'void', balance: 80 }))).toBeNull();
  });
});

describe('an invoice whose customer is in credit', () => {
  // RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit until it is refunded.
  const credit = () => invoice({ total: 100, paid: 100, credited: 30, balance: -30, display_status: 'paid' });

  it('keeps its balance below zero, and says how much the customer is in credit', () => {
    expect(owed(credit())).toBe(-30);
    expect(inCredit(credit())).toBe(30);
    expect(balanceText(credit())).toBe('RM 30.00 in credit');
  });
  it('is in credit by nothing when it is owed, settled, a draft or void', () => {
    expect(inCredit(invoice({ balance: 40 }))).toBe(0);
    expect(inCredit(invoice({ total: 100, paid: 70, credited: 30, balance: 0, display_status: 'paid' }))).toBe(0);
    // A draft or a void invoice has no balance to speak of, whatever the row says.
    expect(inCredit(invoice({ balance: -30, display_status: 'draft' }))).toBe(0);
    expect(inCredit(invoice({ balance: -30, display_status: 'void' }))).toBe(0);
    expect(inCredit(invoice({ balance: -0.1 - 0.2, display_status: 'paid' }))).toBe(0.3);
  });
  it('words every other balance as before: an amount, or a dash on a draft and a void invoice', () => {
    expect(balanceText(invoice({ balance: 1250.5 }))).toBe('RM 1,250.50');
    expect(balanceText(invoice({ balance: 0, display_status: 'paid' }))).toBe('RM 0.00');
    expect(balanceText(invoice({ balance: 80, display_status: 'draft' }))).toBe('—');
    expect(balanceText(invoice({ balance: 80, display_status: 'void' }))).toBe('—');
    expect(balanceText(invoice({ balance: -0.01, display_status: 'paid' }))).toBe('RM 0.01 in credit');
  });
  it('counts as paid, and never lowers what the other invoices are owed', () => {
    const view = invoicesView([credit(), invoice({ balance: 100 }), invoice({ balance: 50, display_status: 'overdue' })], [], today);
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Total receivable', 'RM 150', '2 open invoices'],
      ['Due this week', 'RM 0', '0 invoices'],
      ['Overdue', 'RM 50', '1 invoice'],
      ['Received (MTD)', 'RM 0', '0 payments'],
    ]);
    expect(view.byStatus.find((s) => s.key === 'paid')?.value).toBe(1);
  });
  it('owes less, and stays open, when it is credited before it is paid', () => {
    const partCredited = invoice({ total: 100, credited: 30, balance: 70 });
    expect(balanceText(partCredited)).toBe('RM 70.00');
    expect(invoicesView([partCredited], [], today).stats[0]).toMatchObject({ value: 'RM 70', delta: '1 open invoice' });
  });
  it('is found by the Paid filter like any other paid invoice', () => {
    const rows = [credit(), invoice({ balance: 100 })];
    expect(filterInvoices(rows, '', 'paid')).toHaveLength(1);
    expect(filterInvoices(rows, '', 'open')).toHaveLength(2);
  });
});

describe('CSV export', () => {
  it('writes the invoices table, with a formula-looking customer name made harmless', () => {
    const csv = invoicesCsv([
      invoice({ invoice_no: 'INV-0007', customer_name: '=cmd|calc', total: 1250.5, paid: 1000, balance: 250.5, einvoice_status: 'validated' }),
      invoice({ invoice_no: null, customer_name: 'Lim, Tan & Co', total: 80, balance: 80, display_status: 'draft' }),
    ]);
    expect(csv).toBe(
      '\uFEFFNo.,Date,Customer,Due,Total,Paid,Credited,Refunded,Balance,Status,e-Invois,Set off\r\n' +
        "INV-0007,2026-10-01,'=cmd|calc,2026-10-31,1250.5,1000,0,0,250.5,Sent,Validated,0\r\n" +
        ',2026-10-01,"Lim, Tan & Co",2026-10-31,80,0,0,0,,Draft,,0\r\n',
    );
  });

  it('writes what was credited and refunded, and a balance below zero for a customer in credit, so the columns add up', () => {
    const csv = invoicesCsv([
      invoice({ invoice_no: 'INV-0008', total: 100, paid: 100, credited: 30, refunded: 10, balance: -20, display_status: 'paid' }),
      invoice({ invoice_no: 'INV-0009', total: 100, credited: 30, balance: 70 }),
    ]);
    expect(csv.split('\r\n').slice(1, 3)).toEqual([
      'INV-0008,2026-10-01,Aisyah Trading,2026-10-31,100,100,30,10,-20,Paid,,0',
      'INV-0009,2026-10-01,Aisyah Trading,2026-10-31,100,0,30,0,70,Sent,,0',
    ]);
  });

  it('writes what contra entries set off in its own column, as its last column, so the other columns keep their places and still add up', () => {
    const csv = invoicesCsv([invoice({ invoice_no: 'INV-0010', total: 100, paid: 20, set_off: 50, balance: 30 })]);
    expect(csv.split('\r\n')[1]).toBe('INV-0010,2026-10-01,Aisyah Trading,2026-10-31,100,20,0,0,30,Sent,,50');
  });

  it('leaves the balance empty for a draft and a void invoice, and fills it for the rest', () => {
    const csv = invoicesCsv([
      invoice({ invoice_no: null, total: 80, balance: 80, display_status: 'draft' }),
      invoice({ invoice_no: 'INV-0002', total: 90, balance: 90, display_status: 'void' }),
      invoice({ invoice_no: 'INV-0003', total: 70, paid: 20, balance: 50, display_status: 'overdue' }),
      invoice({ invoice_no: 'INV-0004', total: 60, paid: 60, balance: 0, display_status: 'paid' }),
    ]);
    expect(csv.split('\r\n').slice(1, 5)).toEqual([
      ',2026-10-01,Aisyah Trading,2026-10-31,80,0,0,0,,Draft,,0',
      'INV-0002,2026-10-01,Aisyah Trading,2026-10-31,90,0,0,0,,Void,,0',
      'INV-0003,2026-10-01,Aisyah Trading,2026-10-31,70,20,0,0,50,Overdue,,0',
      'INV-0004,2026-10-01,Aisyah Trading,2026-10-31,60,60,0,0,0,Paid,,0',
    ]);
  });

  it('writes the payments table, one line per invoice paid, with the method and status as the screen words them', () => {
    const csv = paymentsInCsv([
      payment({ number: 'RC-0003', transaction_id: 't', invoice_no: 'INV-0007', amount: 132.5, method: 'bank_transfer' }),
      payment({ number: 'RC-0003', transaction_id: 't', invoice_no: 'INV-0008', amount: 40, method: 'bank_transfer', customer_name: '+60 Trading' }),
      payment({ number: 'RC-0001', status: 'void', invoice_no: 'INV-0001', amount: 5, method: 'ewallet' }),
    ]);
    expect(csv).toBe(
      '\uFEFFDate,No.,Customer,Invoice,Account,Method,Amount,Status\r\n' +
        '2026-10-05,RC-0003,Aisyah Trading,INV-0007,Main Bank,Bank Transfer,132.5,Received\r\n' +
        "2026-10-05,RC-0003,'+60 Trading,INV-0008,Main Bank,Bank Transfer,40,Received\r\n" +
        '2026-10-05,RC-0001,Aisyah Trading,INV-0001,Main Bank,E-Wallet,5,Void\r\n',
    );
  });
});

describe('the sample shown when there is no database', () => {
  it('gives every invoice and every payment row an id of its own', () => {
    expect(new Set(SAMPLE_INVOICES.map((i) => i.id)).size).toBe(SAMPLE_INVOICES.length);
    expect(new Set(SAMPLE_PAYMENTS_IN.map((p) => p.allocation_id)).size).toBe(SAMPLE_PAYMENTS_IN.length);
  });
  it('agrees with itself: what is paid on each invoice is what the payments against it add up to', () => {
    for (const i of SAMPLE_INVOICES) {
      const paid = SAMPLE_PAYMENTS_IN.filter((p) => p.invoice_id === i.id).reduce((total, p) => total + p.amount, 0);
      expect(paid, i.invoice_no ?? 'draft').toBe(i.paid);
      expect(i.balance, i.invoice_no ?? 'draft').toBe(i.total - i.paid - i.credited + i.refunded);
      // An open invoice is owed something; one with nothing left to pay reads Paid, in credit or not.
      if (i.display_status === 'sent' || i.display_status === 'overdue') expect(i.balance, i.invoice_no ?? '').toBeGreaterThan(0);
      if (i.display_status === 'paid') expect(i.balance, i.invoice_no ?? '').toBeLessThanOrEqual(0);
    }
  });
  it('fills every card and chart on both screens', () => {
    const invoices = invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY);
    expect(invoices.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      // INV-1037 is owed RM 5,880: its RM 6,400 less a credit note of RM 520.
      ['Total receivable', 'RM 20.5k', '4 open invoices'],
      ['Due this week', 'RM 5,880', '1 invoice'],
      ['Overdue', 'RM 12.1k', '2 invoices'],
      ['Received (MTD)', 'RM 18.2k', '7 payments'],
    ]);
    expect(invoices.hasTrend).toBe(true);
    expect(invoices.trend.every((t) => t.invoiced > 0 && t.received > 0)).toBe(true);
    expect(invoices.invoiceCount).toBe(18);

    const payments = paymentsInView(SAMPLE_PAYMENTS_IN, SAMPLE_TODAY);
    expect(payments.stats.map((s) => s.value)).toEqual(['RM 18.2k', '7', 'RM 2,596', '95%']);
    expect(payments.hasReceived).toBe(true);
    expect(payments.byMethod.map((s) => s.label)).toEqual(['Bank Transfer', 'FPX', 'DuitNow', 'Card', 'Cash']);
  });
});
