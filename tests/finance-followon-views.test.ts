import { describe, expect, it } from 'vitest';
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { QuotationListRow } from '@/lib/finance/quotations';
import type { RefundRow } from '@/lib/finance/refunds';
import {
  CREDIT_NOTE_STATUS_LABELS,
  QUOTATION_STATUS_LABELS,
  REFUND_STATUS_LABELS,
  creditNotesCsv,
  creditNotesView,
  customersOf,
  filterCreditNotes,
  filterQuotations,
  filterRefunds,
  isPendingRefund,
  quotationInvoice,
  quotationsCsv,
  quotationsView,
  refundedOnNote,
  refundsCsv,
  refundsView,
} from '@/lib/finance/sales-followon-views';
import { invoicesView } from '@/lib/finance/sales-views';
import {
  SAMPLE_CREDIT_NOTES,
  SAMPLE_INVOICES,
  SAMPLE_PAYMENTS_IN,
  SAMPLE_QUOTATIONS,
  SAMPLE_REFUNDS,
  SAMPLE_TODAY,
} from '@/screens/finance/sales-sample';

const today = '2026-10-09';

let seq = 0;
const quotation = (q: Partial<QuotationListRow> = {}): QuotationListRow => {
  seq += 1;
  return {
    id: `quotation-${seq}`,
    quotation_no: `QT-${String(seq).padStart(4, '0')}`,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    quote_date: '2026-10-01',
    valid_until: '2026-10-31',
    total: 100,
    display_status: 'sent',
    accepted_on: null,
    invoice_id: null,
    invoice_no: null,
    currency: 'MYR',
    fx_rate: 1,
    fx_rate_source: null,
    fx_rate_date: null,
    total_myr: q.total ?? 100,
    ...q,
  };
};

const note = (n: Partial<CreditNoteRow> = {}): CreditNoteRow => {
  seq += 1;
  return {
    id: `note-${seq}`,
    credit_note_no: `CN-${String(seq).padStart(4, '0')}`,
    invoice_id: 'invoice-1',
    invoice_no: 'INV-0001',
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    credit_date: '2026-10-05',
    reason: 'returns',
    amount: 100,
    refunded: 0,
    status: 'issued',
    notes: null,
    ...n,
  };
};

const refund = (r: Partial<RefundRow> = {}): RefundRow => {
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
    reason: 'damaged_goods',
    notes: null,
    account_id: 'bank',
    account_name: 'Main Bank',
    invoice_id: 'invoice-1',
    invoice_no: 'INV-0001',
    credit_note_id: null,
    credit_note_no: null,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    ...r,
  };
};

const invoice = (i: Partial<InvoiceListRow> = {}): InvoiceListRow => {
  seq += 1;
  return {
    id: `invoice-${seq}`,
    invoice_no: `INV-${String(seq).padStart(4, '0')}`,
    customer_id: 'aisyah',
    customer_name: 'Aisyah Trading',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 100,
    paid: 100,
    credited: 0,
    refunded: 0,
    balance: 0,
    display_status: 'paid',
    einvoice_status: 'none',
    einvoice_uuid: null,
    ...i,
  };
};

describe('quotationsView', () => {
  it('adds up open quotes, what was accepted this month, the conversion and the pipeline', () => {
    const view = quotationsView(
      [
        quotation({ total: 6200 }),
        quotation({ total: 4800 }),
        quotation({ total: 2400, display_status: 'draft', quotation_no: null }),
        quotation({ total: 12000, display_status: 'accepted', accepted_on: '2026-10-08' }),
        // Accepted last month: accepted, but not this month's figure.
        quotation({ total: 8400, display_status: 'accepted', accepted_on: '2026-09-25', quote_date: '2026-09-20' }),
        quotation({ total: 3600, display_status: 'declined' }),
        quotation({ total: 3200, display_status: 'expired', quote_date: '2026-09-12', valid_until: '2026-09-27' }),
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Open quotes', 'RM 11.0k', '2 open quotes'],
      ['Accepted (MTD)', 'RM 12.0k', '1 quotation'],
      // 2 accepted of 4 decided: accepted, accepted, declined, expired.
      ['Conversion', '50%', '2 of 4 decided'],
      ['Pipeline value', 'RM 13.4k', '3 quotations, drafts included'],
    ]);
  });
  it('shows a dash for the conversion until a quotation has been decided', () => {
    const view = quotationsView([quotation(), quotation({ display_status: 'draft' })], today);
    expect(view.stats[2]).toMatchObject({ value: '—', delta: '0 of 0 decided' });
  });
  it('does not count an expired quotation as open, though it is still only sent', () => {
    const view = quotationsView([quotation({ display_status: 'expired' })], today);
    expect(view.stats[0]).toMatchObject({ value: 'RM 0', delta: '0 open quotes' });
    expect(view.stats[3]).toMatchObject({ value: 'RM 0' });
  });
  it('charts what was quoted by the quotation’s date and what was accepted by the day it was accepted, drafts left out', () => {
    const view = quotationsView(
      [
        quotation({ total: 4000, quote_date: '2026-09-20', display_status: 'accepted', accepted_on: '2026-10-02' }),
        quotation({ total: 2000, quote_date: '2026-10-03' }),
        quotation({ total: 9000, quote_date: '2026-10-04', display_status: 'draft' }),
      ],
      today,
    );
    expect(view.trend.map((t) => t.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(view.trend.slice(-2)).toEqual([
      { label: 'Sep', quoted: 4, accepted: 0 },
      { label: 'Oct', quoted: 2, accepted: 4 },
    ]);
    expect(view.hasTrend).toBe(true);
  });
  it('knows there is something to chart from the rows, not from the rounded figures', () => {
    expect(quotationsView([quotation({ total: 0.01 })], today)).toMatchObject({ hasTrend: true });
    expect(quotationsView([quotation({ total: 0.01 })], today).trend.at(-1)).toMatchObject({ quoted: 0 });
    expect(quotationsView([quotation({ display_status: 'draft' })], today)).toMatchObject({ hasTrend: false });
    expect(quotationsView([quotation({ quote_date: '2025-10-01' })], today)).toMatchObject({ hasTrend: false });
    expect(quotationsView([], today)).toMatchObject({ hasTrend: false, funnelCount: 0 });
  });
  it('follows this calendar quarter’s quotations from created to sent to accepted, with no viewed step', () => {
    const view = quotationsView(
      [
        quotation({ quote_date: '2026-10-01', display_status: 'draft' }),
        quotation({ quote_date: '2026-10-02' }),
        quotation({ quote_date: '2026-10-03', display_status: 'declined' }),
        quotation({ quote_date: '2026-10-04', display_status: 'accepted', accepted_on: '2026-10-05' }),
        // Last quarter: not in the funnel, even though it was accepted this quarter.
        quotation({ quote_date: '2026-09-30', display_status: 'accepted', accepted_on: '2026-10-02' }),
      ],
      today,
    );
    expect(view.funnel.map((s) => [s.key, s.label, s.value])).toEqual([
      ['created', 'Created', 4],
      ['sent', 'Sent', 3],
      ['accepted', 'Accepted', 1],
    ]);
    expect(view.funnelCount).toBe(4);
    // January to March is a quarter of its own.
    expect(quotationsView([quotation({ quote_date: '2026-03-31' })], '2026-01-01').funnelCount).toBe(1);
    expect(quotationsView([quotation({ quote_date: '2026-04-01' })], '2026-03-31').funnelCount).toBe(0);
  });
});

describe('filtering and exporting quotations', () => {
  const rows = [
    quotation({ quotation_no: 'QT-0227', customer_id: 'seri', customer_name: 'Seri Mutiara Enterprise' }),
    quotation({ quotation_no: 'QT-0225', display_status: 'accepted', accepted_on: '2026-10-08' }),
    quotation({ quotation_no: null, display_status: 'draft' }),
    quotation({ quotation_no: 'QT-0222', display_status: 'expired' }),
  ];

  it('filters by status, by customer id and by number or customer name', () => {
    expect(filterQuotations(rows, '', 'all')).toHaveLength(4);
    expect(filterQuotations(rows, '', 'expired').map((q) => q.quotation_no)).toEqual(['QT-0222']);
    expect(filterQuotations(rows, '', 'sent').map((q) => q.quotation_no)).toEqual(['QT-0227']);
    expect(filterQuotations(rows, '', 'all', 'seri').map((q) => q.quotation_no)).toEqual(['QT-0227']);
    expect(filterQuotations(rows, ' qt-0225 ', 'all')).toHaveLength(1);
    expect(filterQuotations(rows, 'mutiara', 'all')).toHaveLength(1);
  });
  it('does not match a draft on the word null', () => {
    expect(filterQuotations(rows, 'null', 'all')).toEqual([]);
  });
  it('searches the Invoice column too: the number of the invoice made from a quotation', () => {
    const converted = [...rows, quotation({ quotation_no: 'QT-0230', display_status: 'accepted', invoice_id: 'i1', invoice_no: 'INV-0044' })];
    expect(filterQuotations(converted, 'inv-0044', 'all').map((q) => q.quotation_no)).toEqual(['QT-0230']);
    expect(filterQuotations(converted, ' INV ', 'all')).toHaveLength(1);
    expect(filterQuotations(converted, 'inv-0044', 'sent')).toEqual([]);
    // A draft invoice has no number yet: its quotation is not matched on "draft", nor on the word null.
    const drafted = [quotation({ quotation_no: 'QT-0231', display_status: 'accepted', invoice_id: 'i2', invoice_no: null })];
    expect(filterQuotations(drafted, 'draft', 'all')).toEqual([]);
    expect(filterQuotations(drafted, 'null', 'all')).toEqual([]);
  });
  it('lists each customer once, by name, and keeps two customers with one name apart', () => {
    expect(customersOf(rows)).toEqual([
      { id: 'aisyah', name: 'Aisyah Trading' },
      { id: 'seri', name: 'Seri Mutiara Enterprise' },
    ]);
    expect(customersOf([quotation({ customer_id: 'b' }), quotation({ customer_id: 'a' })])).toEqual([
      { id: 'a', name: 'Aisyah Trading' },
      { id: 'b', name: 'Aisyah Trading' },
    ]);
  });
  it('names the invoice made from a quotation, or says it is still a draft', () => {
    expect(quotationInvoice(quotation())).toBeNull();
    expect(quotationInvoice(quotation({ invoice_id: 'i1', invoice_no: 'INV-0044' }))).toBe('INV-0044');
    expect(quotationInvoice(quotation({ invoice_id: 'i1', invoice_no: null }))).toBe('Draft invoice');
  });
  it('writes the table as CSV, with a formula-looking customer name made harmless and a draft’s number empty', () => {
    const csv = quotationsCsv([
      quotation({ quotation_no: 'QT-0007', customer_name: '=cmd|calc', total: 1250.5, display_status: 'accepted', invoice_id: 'i1', invoice_no: 'INV-0044' }),
      quotation({ quotation_no: null, customer_name: 'Lim, Tan & Co', total: 80, display_status: 'draft' }),
    ]);
    // The columns are in the order the table shows them: Total before Valid until.
    expect(csv).toBe(
      '﻿No.,Date,Customer,Total,Valid until,Status,Invoice\r\n' +
        "QT-0007,2026-10-01,'=cmd|calc,1250.5,2026-10-31,Accepted,INV-0044\r\n" +
        ',2026-10-01,"Lim, Tan & Co",80,2026-10-31,Draft,\r\n',
    );
  });
  it('has a label for every status', () => {
    expect(QUOTATION_STATUS_LABELS).toEqual({ draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', expired: 'Expired' });
  });
});

describe('creditNotesView', () => {
  it('counts only issued credit notes as credited: not drafts, not void ones', () => {
    const view = creditNotesView(
      [
        note({ amount: 240, invoice_id: 'a' }),
        note({ amount: 180, invoice_id: 'a', reason: 'goodwill' }),
        note({ amount: 900, invoice_id: 'b', credit_date: '2026-09-28' }),
        note({ amount: 300, status: 'draft', credit_note_no: null, invoice_id: 'c' }),
        note({ amount: 5000, status: 'void', invoice_id: 'd' }),
      ],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Credited (MTD)', 'RM 420', '2 credit notes'],
      ['Issued', '3', 'in all'],
      ['Drafts', '1', 'not yet issued'],
      ['Invoices affected', '2', 'with an issued credit note'],
    ]);
    expect(view.trend.slice(-2)).toEqual([
      { label: 'Sep', credited: 0.9 },
      { label: 'Oct', credited: 0.4 },
    ]);
    expect(view.creditedYtd).toBe('RM 1,320');
  });
  it('splits this year’s credit by reason, leaving out reasons with nothing and last year’s notes', () => {
    const view = creditNotesView(
      [
        note({ amount: 240 }),
        note({ amount: 100, reason: 'overbilling' }),
        note({ amount: 60, reason: 'overbilling' }),
        note({ amount: 999, reason: 'goodwill', credit_date: '2025-12-31' }),
      ],
      today,
    );
    expect(view.byReason.map((s) => [s.key, s.label, s.value])).toEqual([
      ['returns', 'Returns', 240],
      ['overbilling', 'Overbilling', 160],
    ]);
    expect(view.hasReasons).toBe(true);
  });
  it('has nothing to chart with no issued credit note, and says so from the rows', () => {
    const empty = creditNotesView([note({ status: 'draft' })], today);
    expect(empty).toMatchObject({ hasTrend: false, hasReasons: false, creditedYtd: 'RM 0' });
    // With nothing credited, every reason stays so the legend still shows.
    expect(empty.byReason).toHaveLength(5);
    const oneSen = creditNotesView([note({ amount: 0.01 })], today);
    expect(oneSen).toMatchObject({ hasTrend: true, hasReasons: true });
    expect(oneSen.trend.at(-1)).toMatchObject({ credited: 0 });
  });
});

describe('filtering and exporting credit notes', () => {
  const rows = [
    note({ credit_note_no: 'CN-0036', invoice_no: 'INV-1032', customer_name: 'Seri Mutiara Enterprise', refunded: 900, amount: 900 }),
    note({ credit_note_no: null, status: 'draft', invoice_no: 'INV-1041', refunded: 0 }),
    note({ credit_note_no: 'CN-0010', status: 'void', invoice_no: 'INV-1001' }),
  ];

  it('shows everything but void ones until a status is chosen, and searches number, customer and invoice', () => {
    expect(filterCreditNotes(rows, '', 'open')).toHaveLength(2);
    expect(filterCreditNotes(rows, '', 'void').map((n) => n.credit_note_no)).toEqual(['CN-0010']);
    expect(filterCreditNotes(rows, '', 'draft')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'inv-1032', 'open')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'mutiara', 'open')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'cn-0036', 'issued')).toHaveLength(1);
    expect(filterCreditNotes(rows, 'null', 'open')).toEqual([]);
  });
  it('shows what was refunded against an issued credit note, and nothing for a draft or a void one', () => {
    expect(rows.map(refundedOnNote)).toEqual([900, null, null]);
  });
  it('writes the table as CSV, with the reason as the screen words it', () => {
    expect(creditNotesCsv(rows)).toBe(
      '﻿No.,Date,Customer,Invoice,Reason,Amount,Refunded,Status\r\n' +
        'CN-0036,2026-10-05,Seri Mutiara Enterprise,INV-1032,Returns,900,900,Issued\r\n' +
        ',2026-10-05,Aisyah Trading,INV-1041,Returns,100,,Draft\r\n' +
        'CN-0010,2026-10-05,Aisyah Trading,INV-1001,Returns,100,,Void\r\n',
    );
  });
  it('has a label for every status', () => {
    expect(CREDIT_NOTE_STATUS_LABELS).toEqual({ draft: 'Draft', issued: 'Issued', void: 'Void' });
  });
});

describe('refundsView', () => {
  it('counts only refunds that were paid out as refunded, and pending ones apart', () => {
    const view = refundsView(
      [
        refund({ amount: 240, invoice_id: 'a' }),
        refund({ amount: 180, invoice_id: 'a' }),
        refund({ amount: 900, invoice_id: 'b', txn_date: '2026-09-26' }),
        refund({ amount: 680, status: 'scheduled', number: null, invoice_id: 'c' }),
        refund({ amount: 5000, status: 'void', invoice_id: 'd' }),
      ],
      [],
      today,
    );
    expect(view.stats.map((s) => [s.label, s.value, s.delta, s.deltaTone])).toEqual([
      ['Refunded (MTD)', 'RM 420', '2 refunds', 'flat'],
      ['To be paid', 'RM 680', '1 refund', 'down'],
      ['In credit', 'RM 0', '0 invoices', 'flat'],
      ['Invoices refunded', '2', 'in all', 'flat'],
    ]);
    expect(view.trend.slice(-2)).toEqual([
      { label: 'Sep', refunded: 0.9 },
      { label: 'Oct', refunded: 0.4 },
    ]);
    expect(view.refundedYtd).toBe('RM 1,320');
  });
  it('adds up what customers are in credit from the invoices, pending refunds included', () => {
    const view = refundsView(
      [refund({ amount: 680, status: 'scheduled', number: null })],
      [
        invoice({ credited: 600, balance: -600 }),
        invoice({ credited: 680, balance: -680 }),
        // Refunded in full, owed, a draft: none of them is in credit.
        invoice({ credited: 240, refunded: 240, balance: 0 }),
        invoice({ paid: 0, balance: 100, display_status: 'sent' }),
        invoice({ paid: 0, balance: -5, display_status: 'draft' }),
      ],
      today,
    );
    expect(view.stats[2]).toMatchObject({ label: 'In credit', value: 'RM 1,280', delta: '2 invoices' });
    expect(view.stats[1]).toMatchObject({ value: 'RM 680', deltaTone: 'down' });
  });
  it('splits this year’s refunds by reason, and has nothing to chart when none was paid out', () => {
    const view = refundsView(
      [refund({ amount: 240 }), refund({ amount: 450, reason: 'overpayment' }), refund({ amount: 99, reason: 'other', txn_date: '2025-12-31' })],
      [],
      today,
    );
    expect(view.byReason.map((s) => [s.key, s.label, s.value])).toEqual([
      ['damaged_goods', 'Damaged goods', 240],
      ['overpayment', 'Overpayment', 450],
    ]);
    const pendingOnly = refundsView([refund({ status: 'scheduled' })], [], today);
    expect(pendingOnly).toMatchObject({ hasTrend: false, hasReasons: false, refundedYtd: 'RM 0' });
    expect(pendingOnly.byReason).toHaveLength(5);
    expect(refundsView([refund({ amount: 0.01 })], [], today)).toMatchObject({ hasTrend: true, hasReasons: true });
    expect(refundsView([], [], today).stats.map((s) => s.value)).toEqual(['RM 0', 'RM 0', 'RM 0', '0']);
  });
});

describe('filtering and exporting refunds', () => {
  const rows = [
    refund({ number: 'PV-0003', invoice_no: 'INV-1042', credit_note_no: 'CN-0034', credit_note_id: 'n1', reference: 'TT 88' }),
    refund({ number: null, status: 'scheduled', invoice_no: 'INV-1033', customer_name: 'Nurul Boutique', reason: 'wrong_item', method: 'duitnow' }),
    refund({ number: 'PV-0001', status: 'void', invoice_no: 'INV-1001' }),
  ];

  it('shows everything but void ones until a status is chosen', () => {
    expect(filterRefunds(rows, '', 'open')).toHaveLength(2);
    expect(filterRefunds(rows, '', 'pending').map((r) => r.invoice_no)).toEqual(['INV-1033']);
    expect(filterRefunds(rows, '', 'posted').map((r) => r.number)).toEqual(['PV-0003']);
    expect(filterRefunds(rows, '', 'void').map((r) => r.number)).toEqual(['PV-0001']);
  });
  it('searches customer, invoice, credit note, voucher number and reference, and never matches on null', () => {
    expect(filterRefunds(rows, 'nurul', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'inv-1042', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'cn-0034', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'pv-0003', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'tt 88', 'open')).toHaveLength(1);
    expect(filterRefunds(rows, 'null', 'open')).toEqual([]);
  });
  it('treats a refund that is not yet money out as pending', () => {
    expect((['scheduled', 'draft', 'pending_approval', 'posted', 'void', 'rejected'] as const).map((status) => isPendingRefund(refund({ status })))).toEqual([
      true, true, true, false, false, false,
    ]);
  });
  it('writes the table as CSV, with the reason, method and status as the screen words them', () => {
    expect(refundsCsv(rows.slice(0, 2))).toBe(
      '﻿Date,No.,Customer,Invoice,Credit note,Reason,Account,Method,Amount,Status\r\n' +
        '2026-10-05,PV-0003,Aisyah Trading,INV-1042,CN-0034,Damaged goods,Main Bank,FPX,100,Refunded\r\n' +
        '2026-10-05,,Nurul Boutique,INV-1033,,Wrong item,Main Bank,DuitNow,100,To be paid\r\n',
    );
  });
  it('words scheduled as To be paid and posted as Refunded', () => {
    expect(REFUND_STATUS_LABELS).toMatchObject({ scheduled: 'To be paid', posted: 'Refunded', void: 'Void' });
  });
  it('words a refund that is still being written as To be paid, since the To be paid filter and card count it', () => {
    const draft = refund({ status: 'draft', number: null });
    expect(isPendingRefund(draft)).toBe(true);
    expect(filterRefunds([draft], '', 'pending')).toHaveLength(1);
    expect(REFUND_STATUS_LABELS.draft).toBe('To be paid');
    expect(refundsCsv([draft])).toContain(',To be paid\r\n');
  });
});

describe('the sample shown when there is no database', () => {
  it('gives every row an id of its own', () => {
    expect(new Set(SAMPLE_QUOTATIONS.map((q) => q.id)).size).toBe(SAMPLE_QUOTATIONS.length);
    expect(new Set(SAMPLE_CREDIT_NOTES.map((n) => n.id)).size).toBe(SAMPLE_CREDIT_NOTES.length);
    expect(new Set(SAMPLE_REFUNDS.map((r) => r.allocation_id)).size).toBe(SAMPLE_REFUNDS.length);
  });
  it('agrees with the sample invoices: each one is credited and refunded by exactly its credit notes and refunds', () => {
    for (const i of SAMPLE_INVOICES) {
      const credited = SAMPLE_CREDIT_NOTES.filter((n) => n.invoice_id === i.id && n.status === 'issued').reduce((total, n) => total + n.amount, 0);
      const refunded = SAMPLE_REFUNDS.filter((r) => r.invoice_id === i.id && r.status === 'posted').reduce((total, r) => total + r.amount, 0);
      const pending = SAMPLE_REFUNDS.filter((r) => r.invoice_id === i.id && isPendingRefund(r)).reduce((total, r) => total + r.amount, 0);
      expect(i.credited, `${i.invoice_no} credited`).toBe(credited);
      expect(i.refunded, `${i.invoice_no} refunded`).toBe(refunded);
      // What the database would allow: never more credited than invoiced, never more refunded than the customer is in credit.
      expect(credited, `${i.invoice_no} credit cap`).toBeLessThanOrEqual(i.total);
      expect(pending, `${i.invoice_no} refund cap`).toBeLessThanOrEqual(Math.max(0, -i.balance));
    }
  });
  it('names real sample invoices and credit notes, and refunds no credit note beyond its amount', () => {
    for (const n of SAMPLE_CREDIT_NOTES) {
      const against = SAMPLE_INVOICES.find((i) => i.id === n.invoice_id);
      expect(against, n.id).toBeTruthy();
      expect([n.invoice_no, n.customer_name], n.id).toEqual([against!.invoice_no, against!.customer_name]);
      const onNote = SAMPLE_REFUNDS.filter((r) => r.credit_note_id === n.id && r.status === 'posted').reduce((total, r) => total + r.amount, 0);
      expect(n.refunded, n.id).toBe(onNote);
      expect(onNote, n.id).toBeLessThanOrEqual(n.amount);
    }
    for (const r of SAMPLE_REFUNDS) {
      expect(SAMPLE_INVOICES.some((i) => i.id === r.invoice_id), r.allocation_id).toBe(true);
      if (r.credit_note_id) expect(SAMPLE_CREDIT_NOTES.some((n) => n.id === r.credit_note_id && n.status === 'issued'), r.allocation_id).toBe(true);
      expect(r.number === null, r.allocation_id).toBe(r.status !== 'posted');
    }
  });
  it('fills every card and chart on the three screens, and agrees with the Invoices sample', () => {
    const quotations = quotationsView(SAMPLE_QUOTATIONS, SAMPLE_TODAY);
    expect(quotations.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Open quotes', 'RM 20.5k', '3 open quotes'],
      ['Accepted (MTD)', 'RM 19.5k', '2 quotations'],
      ['Conversion', '55%', '6 of 11 decided'],
      ['Pipeline value', 'RM 22.9k', '4 quotations, drafts included'],
    ]);
    expect(quotations.hasTrend).toBe(true);
    // October's five: one draft, four sent, of which one accepted.
    expect(quotations.funnel.map((s) => s.value)).toEqual([5, 4, 1]);

    const notes = creditNotesView(SAMPLE_CREDIT_NOTES, SAMPLE_TODAY);
    expect(notes.stats.map((s) => s.value)).toEqual(['RM 3,890', '8', '1', '8']);
    expect(notes).toMatchObject({ hasTrend: true, hasReasons: true, creditedYtd: 'RM 3,890' });

    const refunds = refundsView(SAMPLE_REFUNDS, SAMPLE_INVOICES, SAMPLE_TODAY);
    expect(refunds.stats.map((s) => [s.label, s.value, s.delta])).toEqual([
      ['Refunded (MTD)', 'RM 1,770', '4 refunds'],
      ['To be paid', 'RM 1,000', '2 refunds'],
      // Siti Decor RM 600, and the two pending refunds' RM 680 and RM 320.
      ['In credit', 'RM 1,600', '3 invoices'],
      ['Invoices refunded', '4', 'in all'],
    ]);
    expect(refunds).toMatchObject({ hasTrend: true, hasReasons: true, refundedYtd: 'RM 1,770' });

    // The credit note on the unpaid invoice is what moved the Invoices sample's receivable.
    expect(invoicesView(SAMPLE_INVOICES, SAMPLE_PAYMENTS_IN, SAMPLE_TODAY).stats[0]).toMatchObject({ value: 'RM 20.5k' });
  });
});
