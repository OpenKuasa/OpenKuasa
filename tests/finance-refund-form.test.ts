import { describe, expect, it } from 'vitest';
import type { CreditNoteRow } from '@/lib/finance/credit-notes';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import type { FinanceAccount } from '@/lib/finance/money';
import {
  type RefundForm,
  chooseRefundTarget,
  invoiceTargetKey,
  keepRefundTarget,
  newRefundForm,
  noteTargetKey,
  refundFormError,
  refundPayload,
  refundSaved,
  refundSavedNote,
  refundTargetLabel,
  refundTargets,
} from '@/lib/finance/refund-form';
import { type RefundRow, recordRefundInput } from '@/lib/finance/refunds';

const INVOICE = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const NOTE_2 = '33333333-3333-4333-8333-333333333333';
const BANK = '44444444-4444-4444-8444-444444444444';
const CASH = '55555555-5555-4555-8555-555555555555';

/** RM 100 invoiced and paid, then RM 30 credited: the customer is RM 30 in credit. */
const invoice = (i: Partial<InvoiceListRow> = {}): InvoiceListRow => ({
  id: INVOICE,
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  total: 100,
  paid: 100,
  credited: 30,
  refunded: 0,
  balance: -30,
  display_status: 'paid',
  einvoice_status: 'none',
  einvoice_uuid: null,
  ...i,
});

const note = (n: Partial<CreditNoteRow> = {}): CreditNoteRow => ({
  id: NOTE,
  credit_note_no: 'CN-0003',
  invoice_id: INVOICE,
  invoice_no: 'INV-0007',
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  credit_date: '2026-10-06',
  reason: 'returns',
  amount: 30,
  refunded: 0,
  status: 'issued',
  notes: null,
  ...n,
});

const refund = (r: Partial<RefundRow> = {}): RefundRow => ({
  allocation_id: 'a-1',
  transaction_id: 't-1',
  number: null,
  txn_date: '2026-10-07',
  method: 'fpx',
  amount: 10,
  transaction_amount: 10,
  status: 'scheduled',
  reference: null,
  reason: 'damaged_goods',
  notes: null,
  account_id: BANK,
  account_name: 'Main Bank',
  invoice_id: INVOICE,
  invoice_no: 'INV-0007',
  credit_note_id: null,
  credit_note_no: null,
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  ...r,
});

const accounts: FinanceAccount[] = [
  { id: CASH, name: 'Cash in hand', kind: 'cash', bank_name: null },
  { id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank' },
];

const refundable = (invoices: InvoiceListRow[], notes: CreditNoteRow[], refunds: RefundRow[]) =>
  Object.fromEntries(refundTargets(invoices, notes, refunds).map((t) => [t.key, t.refundable]));

describe('refundTargets: what can be refunded, and how much', () => {
  it('offers an invoice whose customer is in credit, and its issued credit note, each for the credit', () => {
    expect(refundTargets([invoice()], [note()], [])).toEqual([
      {
        key: invoiceTargetKey(INVOICE), kind: 'invoice', id: INVOICE, number: 'INV-0007',
        invoice_id: INVOICE, invoice_no: 'INV-0007', customer_name: 'Aisyah Trading', refundable: 30,
      },
      {
        key: noteTargetKey(NOTE), kind: 'credit_note', id: NOTE, number: 'CN-0003',
        invoice_id: INVOICE, invoice_no: 'INV-0007', customer_name: 'Aisyah Trading', refundable: 30,
      },
    ]);
  });
  it('offers nothing while the customer owes money, is exactly settled, or the invoice is a draft or void', () => {
    expect(refundTargets([invoice({ paid: 0, credited: 30, balance: 70, display_status: 'sent' })], [note()], [])).toEqual([]);
    expect(refundTargets([invoice({ paid: 70, balance: 0 })], [note()], [])).toEqual([]);
    expect(refundTargets([invoice({ display_status: 'void' })], [note()], [])).toEqual([]);
    expect(refundTargets([invoice({ display_status: 'draft' })], [], [])).toEqual([]);
  });
  it('takes a pending refund off what is left, whether it was put against the invoice or against the credit note', () => {
    // A refund row names its invoice whichever way it was recorded, so both hold the invoice's credit.
    const onInvoice = refund();
    expect(refundable([invoice()], [note()], [onInvoice])).toEqual({ [invoiceTargetKey(INVOICE)]: 20, [noteTargetKey(NOTE)]: 20 });
    const onNote = refund({ credit_note_id: NOTE, credit_note_no: 'CN-0003' });
    expect(refundable([invoice()], [note()], [onNote])).toEqual({ [invoiceTargetKey(INVOICE)]: 20, [noteTargetKey(NOTE)]: 20 });
    // A refund still being written, or waiting for approval, holds the credit as a scheduled one does.
    for (const status of ['draft', 'pending_approval'] as const) {
      expect(refundable([invoice()], [note()], [refund({ status })])[invoiceTargetKey(INVOICE)], status).toBe(20);
    }
  });
  it('does not count a refund twice once it is paid out: the balance already has it', () => {
    // RM 10 paid out against the note: the view shows the customer RM 20 in credit and the note RM 10 refunded.
    const paidOut = refund({ status: 'posted', number: 'PV-0004', credit_note_id: NOTE, credit_note_no: 'CN-0003' });
    expect(
      refundable([invoice({ refunded: 10, balance: -20 })], [note({ refunded: 10 })], [paidOut]),
    ).toEqual({ [invoiceTargetKey(INVOICE)]: 20, [noteTargetKey(NOTE)]: 20 });
  });
  it('ignores refunds that were voided or rejected: they hold nothing', () => {
    for (const status of ['void', 'rejected'] as const) {
      expect(refundable([invoice()], [note()], [refund({ status })]), status).toEqual({
        [invoiceTargetKey(INVOICE)]: 30,
        [noteTargetKey(NOTE)]: 30,
      });
    }
  });
  it('offers nothing once pending refunds hold all of the credit', () => {
    expect(refundTargets([invoice()], [note()], [refund({ amount: 30 })])).toEqual([]);
    expect(refundTargets([invoice()], [note()], [refund({ amount: 20 }), refund({ allocation_id: 'a-2', transaction_id: 't-2' })])).toEqual([]);
  });
  it('caps a refund against a credit note at what is left of the note, counting pending refunds against it', () => {
    // Two credit notes, RM 30 and RM 50, on a paid invoice: RM 80 in credit.
    const inv = invoice({ credited: 80, balance: -80 });
    const notes = [note(), note({ id: NOTE_2, credit_note_no: 'CN-0004', amount: 50 })];
    expect(refundable([inv], notes, [])).toEqual({
      [invoiceTargetKey(INVOICE)]: 80,
      [noteTargetKey(NOTE)]: 30,
      [noteTargetKey(NOTE_2)]: 50,
    });
    // RM 10 pending against the first note: the invoice has RM 70 free, the first note RM 20, the second still RM 50.
    const pending = refund({ credit_note_id: NOTE, credit_note_no: 'CN-0003' });
    expect(refundable([inv], notes, [pending])).toEqual({
      [invoiceTargetKey(INVOICE)]: 70,
      [noteTargetKey(NOTE)]: 20,
      [noteTargetKey(NOTE_2)]: 50,
    });
    // RM 45 pending against the invoice itself: RM 35 free, which now limits the second note too.
    expect(refundable([inv], notes, [refund({ amount: 45 })])).toEqual({
      [invoiceTargetKey(INVOICE)]: 35,
      [noteTargetKey(NOTE)]: 30,
      [noteTargetKey(NOTE_2)]: 35,
    });
  });
  it('caps a refund against a credit note at the invoice’s credit when the note is larger than it', () => {
    // RM 100 invoiced, RM 60 paid, RM 50 credited: the customer is RM 10 in credit, not RM 50.
    const inv = invoice({ paid: 60, credited: 50, balance: -10 });
    expect(refundable([inv], [note({ amount: 50 })], [])).toEqual({ [invoiceTargetKey(INVOICE)]: 10, [noteTargetKey(NOTE)]: 10 });
  });
  it('offers what is left of a credit note that was partly paid out, when that is less than the customer’s credit', () => {
    // RM 80 credited in all and RM 20 already paid out against the RM 50 note: the customer is RM 60 in credit,
    // and the note has RM 30 left, which is the smaller of the two.
    const inv = invoice({ credited: 80, refunded: 20, balance: -60 });
    expect(refundable([inv], [note({ amount: 50, refunded: 20 })], [])).toEqual({
      [invoiceTargetKey(INVOICE)]: 60,
      [noteTargetKey(NOTE)]: 30,
    });
    expect(refundTargetLabel(refundTargets([inv], [note({ amount: 50, refunded: 20 })], [])[1])).toBe(
      'CN-0003 on INV-0007 · Aisyah Trading · RM 30.00 can be refunded',
    );
  });
  it('leaves out a credit note that is a draft, void, or already refunded in full', () => {
    const inv = invoice({ credited: 80, balance: -50, refunded: 30 });
    const notes = [
      note({ refunded: 30 }),
      note({ id: NOTE_2, credit_note_no: 'CN-0004', amount: 50 }),
      note({ id: 'draft', credit_note_no: null, status: 'draft' }),
      note({ id: 'void', credit_note_no: 'CN-0002', status: 'void' }),
    ];
    expect(refundTargets([inv], notes, []).map((t) => t.key)).toEqual([invoiceTargetKey(INVOICE), noteTargetKey(NOTE_2)]);
  });
  it('works in whole sen', () => {
    const inv = invoice({ total: 1, paid: 1, credited: 0.3, balance: -0.3 });
    expect(refundable([inv], [note({ amount: 0.3 })], [refund({ amount: 0.1 })])).toEqual({
      [invoiceTargetKey(INVOICE)]: 0.2,
      [noteTargetKey(NOTE)]: 0.2,
    });
  });
  it('lists by customer, then invoice, each invoice before its credit notes', () => {
    const zaki = invoice({ id: 'z', invoice_no: 'INV-0002', customer_id: 'zaki', customer_name: 'Zaki Enterprise' });
    const targets = refundTargets(
      [zaki, invoice()],
      [note(), note({ id: 'zn', credit_note_no: 'CN-0001', invoice_id: 'z', customer_name: 'Zaki Enterprise' })],
      [],
    );
    expect(targets.map((t) => t.number)).toEqual(['INV-0007', 'CN-0003', 'INV-0002', 'CN-0001']);
  });
  it('orders numbers as numbers once they pass four digits: 9999 before 10000, for invoices and for credit notes', () => {
    const late = invoice({ id: 'late', invoice_no: 'INV-10000', credited: 80, balance: -80 });
    const early = invoice({ id: 'early', invoice_no: 'INV-9999' });
    const targets = refundTargets(
      [late, early],
      [
        note({ id: 'n-late', credit_note_no: 'CN-10000', invoice_id: 'late', invoice_no: 'INV-10000' }),
        note({ id: 'n-early', credit_note_no: 'CN-9999', invoice_id: 'late', invoice_no: 'INV-10000' }),
      ],
      [],
    );
    expect(targets.map((t) => t.number)).toEqual(['INV-9999', 'INV-10000', 'CN-9999', 'CN-10000']);
  });
  it('names a target in the picker: a credit note with its invoice', () => {
    const [onInvoice, onNote] = refundTargets([invoice({ credited: 1240, balance: -1240 })], [note({ amount: 1240 })], []);
    expect(refundTargetLabel(onInvoice)).toBe('INV-0007 · Aisyah Trading · RM 1,240.00 can be refunded');
    expect(refundTargetLabel(onNote)).toBe('CN-0003 on INV-0007 · Aisyah Trading · RM 1,240.00 can be refunded');
  });
});

describe('a new refund form', () => {
  const two = refundTargets(
    [invoice(), invoice({ id: 'z', invoice_no: 'INV-0002', customer_name: 'Zaki Enterprise', credited: 50, balance: -50 })],
    [],
    [],
  );

  it('is paid out now, from the first bank account, by bank transfer, with nothing chosen', () => {
    expect(newRefundForm(two, accounts, '2026-10-09')).toEqual({
      target: '',
      amount: '',
      reason: '',
      accountId: BANK,
      date: '2026-10-09',
      method: 'bank_transfer',
      reference: '',
      notes: '',
      scheduled: false,
    });
    expect(newRefundForm(two, [], '2026-10-09').accountId).toBe('');
  });
  it('opens on the row it was started from, for all that can be refunded there', () => {
    const fromInvoice = newRefundForm(two, accounts, '2026-10-09', invoiceTargetKey(INVOICE));
    expect(fromInvoice).toMatchObject({ target: invoiceTargetKey(INVOICE), amount: '30.00' });
    const targets = refundTargets([invoice()], [note()], [refund()]);
    expect(newRefundForm(targets, accounts, '2026-10-09', noteTargetKey(NOTE))).toMatchObject({ target: noteTargetKey(NOTE), amount: '20.00' });
  });
  it('chooses the only thing that can be refunded, and nothing when the row it was started from can no longer be', () => {
    const [only] = refundTargets([invoice()], [], []);
    expect(newRefundForm([only], accounts, '2026-10-09')).toMatchObject({ target: only.key, amount: '30.00' });
    expect(newRefundForm(two, accounts, '2026-10-09', noteTargetKey(NOTE))).toMatchObject({ target: '', amount: '' });
    expect(newRefundForm([], accounts, '2026-10-09', invoiceTargetKey(INVOICE))).toMatchObject({ target: '', amount: '' });
  });
});

describe('choosing what to refund', () => {
  const targets = refundTargets([invoice({ credited: 80, balance: -80 })], [note()], []);
  const [onInvoice, onNote] = targets;
  const open = newRefundForm(targets, accounts, '2026-10-09', onInvoice.key);

  it('sets the amount to all the new choice can take, and keeps everything else', () => {
    const typed = { ...open, amount: '12', reason: 'overpayment' as const, notes: 'By cheque' };
    expect(chooseRefundTarget(typed, onNote)).toEqual({ ...typed, target: onNote.key, amount: '30.00' });
  });
  it('changes nothing when the same thing is chosen again', () => {
    const typed = { ...open, amount: '12' };
    expect(chooseRefundTarget(typed, onInvoice)).toBe(typed);
  });
  it('drops a choice that is no longer offered after a refresh, and keeps one that is', () => {
    expect(keepRefundTarget(open, targets)).toBe(open);
    expect(keepRefundTarget(open, [onNote])).toEqual({ ...open, target: '' });
    const empty = newRefundForm([], accounts, '2026-10-09');
    expect(keepRefundTarget(empty, [])).toBe(empty);
  });
});

describe('refundPayload', () => {
  const targets = refundTargets([invoice()], [note()], []);
  const form = (f: Partial<RefundForm> = {}): RefundForm => ({
    ...newRefundForm(targets, accounts, '2026-10-09', invoiceTargetKey(INVOICE)),
    reason: 'overpayment',
    ...f,
  });

  it('names the invoice, or the credit note, never both', () => {
    expect(refundPayload(form(), targets)).toEqual({
      invoice_id: INVOICE,
      credit_note_id: null,
      account_id: BANK,
      txn_date: '2026-10-09',
      method: 'bank_transfer',
      reason: 'overpayment',
      amount: 30,
      reference: '',
      notes: '',
      scheduled: false,
    });
    expect(refundPayload(form({ target: noteTargetKey(NOTE), scheduled: true }), targets)).toMatchObject({
      invoice_id: null,
      credit_note_id: NOTE,
      scheduled: true,
    });
  });
  it('names nothing when the choice is no longer offered, so the schema refuses it', () => {
    const sent = refundPayload(form({ target: noteTargetKey(NOTE_2) }), targets);
    expect(sent).toMatchObject({ invoice_id: null, credit_note_id: null });
    expect(recordRefundInput.safeParse(sent).success).toBe(false);
  });
  it('is what the write’s own schema accepts', () => {
    expect(recordRefundInput.safeParse(refundPayload(form(), targets)).success).toBe(true);
    expect(recordRefundInput.safeParse(refundPayload(form({ target: noteTargetKey(NOTE) }), targets)).success).toBe(true);
  });
});

describe('refundFormError', () => {
  const targets = refundTargets([invoice()], [note()], [refund()]);
  const form = (f: Partial<RefundForm> = {}): RefundForm => ({
    ...newRefundForm(targets, accounts, '2026-10-09', invoiceTargetKey(INVOICE)),
    reason: 'overpayment',
    ...f,
  });

  it('lets a form through that can be saved, for all that can be refunded or less', () => {
    expect(form().amount).toBe('20.00');
    expect(refundFormError(form(), targets)).toBeNull();
    expect(refundFormError(form({ amount: '0.01' }), targets)).toBeNull();
    expect(refundFormError(form({ scheduled: true }), targets)).toBeNull();
  });
  it('asks first what the refund is for, also when the choice went while the form was open', () => {
    const sentence = 'Choose the invoice or the credit note this refund is for.';
    expect(refundFormError(form({ target: '', accountId: '', reason: '' }), targets)).toBe(sentence);
    expect(refundFormError(form({ target: noteTargetKey(NOTE_2) }), targets)).toBe(sentence);
    expect(refundFormError(keepRefundTarget(form(), []), [])).toBe(sentence);
  });
  it('asks for an account, a real date and a reason, in the schema’s own sentences', () => {
    expect(refundFormError(form({ accountId: '' }), targets)).toBe('Choose the account the money leaves.');
    expect(refundFormError(form({ date: '2026-02-30' }), targets)).toBe('Enter a valid date.');
    expect(refundFormError(form({ reason: '' }), targets)).toBe('Choose a reason.');
    expect(refundFormError(form({ reference: 'x'.repeat(201) }), targets)).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('refuses an empty amount, nothing, and a figure typed with a comma', () => {
    for (const amount of ['', '0', '0.004', '-5', '1,200.50', 'abc']) {
      expect(refundFormError(form({ amount }), targets), amount).toBe('Enter an amount above 0.');
    }
  });
  it('refuses a sen more than can be refunded, counting the refund that is pending, before the database is asked', () => {
    // RM 30 in credit, RM 10 of it held by a pending refund.
    expect(refundFormError(form({ amount: '20.01' }), targets)).toBe(
      'That is more than the customer is in credit, or more than is left of the credit note.',
    );
    expect(refundFormError(form({ amount: '30' }), targets)).toBe(
      'That is more than the customer is in credit, or more than is left of the credit note.',
    );
    expect(refundFormError(form({ amount: '20.004' }), targets)).toBeNull();
  });
});

describe('the note that a refund was recorded', () => {
  const OTHER = '66666666-6666-4666-8666-666666666666';
  // Aisyah's invoice and its credit note, and an invoice of another customer who is RM 45 in credit.
  const offered = refundTargets(
    [invoice(), invoice({ id: OTHER, invoice_no: 'INV-0009', customer_id: 'bakar', customer_name: 'Bakar Enterprise', credited: 45, balance: -45 })],
    [note()],
    [],
  );
  const other = offered.find((t) => t.key === invoiceTargetKey(OTHER))!;
  /** The card as it opens from CN-0003's row on Credit Notes, with a reason chosen. */
  const form = (f: Partial<RefundForm> = {}): RefundForm => ({
    ...newRefundForm(offered, accounts, '2026-10-07', noteTargetKey(NOTE)),
    reason: 'overpayment',
    ...f,
  });

  it('names what the form recorded when the person picked something other than the row the card was opened from', () => {
    // Opened from CN-0003's row on Credit Notes, then "Refund for" changed to another customer's invoice.
    const opened = form();
    expect(opened.target).toBe(noteTargetKey(NOTE));
    const changed = chooseRefundTarget(opened, other);
    expect(refundFormError(changed, offered)).toBeNull();

    const saved = refundSaved(changed, offered);
    expect(saved).toEqual({ target: other, amount: 45, scheduled: false });
    // What the note says is what was sent.
    expect(refundPayload(changed, offered)).toMatchObject({ invoice_id: OTHER, credit_note_id: null, amount: 45 });
    const said = refundSavedNote(saved!);
    expect(said).toEqual({
      subtitle: 'For Bakar Enterprise',
      lead: 'RM 45.00 was paid out against INV-0009. It can be voided on',
    });
    expect(`${said.subtitle} ${said.lead}`).not.toMatch(/CN-0003|INV-0007|Aisyah/);
  });
  it('names the credit note with its invoice, and says when the refund was left pending', () => {
    const pending = form({ amount: '12.5', scheduled: true });
    expect(refundSavedNote(refundSaved(pending, offered)!)).toEqual({
      subtitle: 'For Aisyah Trading',
      lead: 'RM 12.50 was left pending against CN-0003 on INV-0007. It is marked as paid or deleted on',
    });
  });
  it('states the amount as it was stored, rounded to the sen as the schema rounds it', () => {
    // 1.005 is stored as RM 1.00 and 1.255 as RM 1.25: the note says the same, not a sen more.
    const saved = refundSaved(form({ amount: '1.005' }), offered)!;
    expect(saved.amount).toBe(1);
    expect(saved.amount).toBe(recordRefundInput.parse(refundPayload(form({ amount: '1.005' }), offered)).amount);
    expect(refundSavedNote(saved).lead).toBe('RM 1.00 was paid out against CN-0003 on INV-0007. It can be voided on');
    expect(refundSaved(form({ amount: '1.255' }), offered)!.amount).toBe(1.25);
  });
  it('has nothing to say of a form with no target or no amount', () => {
    expect(refundSaved(form({ target: '' }), offered)).toBeNull();
    expect(refundSaved(form({ amount: '1,200.50' }), offered)).toBeNull();
  });
  it('describes a document that has no number, never a dash', () => {
    const unnumbered = { ...other, number: '—', invoice_no: '—' };
    expect(refundSavedNote({ target: unnumbered, amount: 5, scheduled: false }).lead).toBe(
      'RM 5.00 was paid out against the invoice. It can be voided on',
    );
    expect(refundSavedNote({ target: { ...unnumbered, kind: 'credit_note' }, amount: 5, scheduled: false }).lead).toBe(
      'RM 5.00 was paid out against the credit note on its invoice. It can be voided on',
    );
  });
});
