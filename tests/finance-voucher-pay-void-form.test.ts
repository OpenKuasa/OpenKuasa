/**
 * Paying and voiding on the Payment Vouchers screen: who is offered what, the words of the two questions, "Paid
 * now" on the form, and what the screen says afterwards about a voucher that is not in the list. Pure.
 */
import { describe, expect, it } from 'vitest';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';
import {
  PAID_NOW_HINT,
  TYPED_PAYEE,
  type QuestionPart,
  type VoucherForm,
  type WrittenVoucher,
  voucherActions,
  voucherAnswerIsStale,
  voucherDateLabel,
  voucherHiddenNote,
  voucherPaidEffect,
  voucherPayload,
  voucherPaysNow,
  voucherQuestion,
  voucherSaveHint,
  voucherSavePayload,
  voucherSubmitLabel,
  writtenVoucherTitle,
} from '@/lib/finance/voucher-form';
import { VOUCHER_MESSAGES, recordVoucherInput } from '@/lib/finance/vouchers';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '99999999-9999-4999-8999-999999999999';
const VOUCHER = '55555555-5555-4555-8555-555555555555';
const TODAY = '2026-10-12';

const row = (over: Partial<PaymentVoucherRow> = {}): PaymentVoucherRow => ({
  transaction_id: VOUCHER,
  number: null,
  txn_date: '2026-10-05',
  method: 'fpx',
  amount: 300,
  status: 'scheduled',
  reference: null,
  notes: null,
  account_id: ACCOUNT,
  account_name: 'Maybank Current',
  account_kind: 'bank',
  contact_id: null,
  party_name: 'Tenaga Nasional',
  kind: 'other',
  category_id: CATEGORY,
  category_name: 'Utilities',
  documents: null,
  approved_at: null,
  ...over,
});
const text = (parts: QuestionPart[]) => parts.map((p) => p.text).join('');
const strong = (parts: QuestionPart[]) => parts.filter((p) => p.strong).map((p) => p.text);

const form: VoucherForm = {
  id: null,
  kind: 'category',
  supplierId: '',
  amounts: {},
  payee: TYPED_PAYEE,
  payeeName: 'Tenaga Nasional',
  categoryId: CATEGORY,
  amount: '300',
  accountId: ACCOUNT,
  date: '2026-10-05',
  method: 'fpx',
  reference: '',
  notes: '',
};

describe('what a row offers', () => {
  it('gives an owner or admin Mark as paid on a To be paid voucher of this screen\'s kinds, and a member Delete only', () => {
    for (const kind of ['other', 'expense'] as const) {
      expect(voucherActions(row({ kind }), true), kind).toEqual(['markPaid', 'delete']);
      expect(voucherActions(row({ kind }), false), kind).toEqual(['delete']);
    }
  });
  it('gives an owner or admin Void on a paid one of those kinds, a member nothing, and nobody anything on a void one', () => {
    for (const kind of ['other', 'expense'] as const) {
      expect(voucherActions(row({ kind, status: 'posted' }), true), kind).toEqual(['void']);
      expect(voucherActions(row({ kind, status: 'posted' }), false), kind).toEqual([]);
      expect(voucherActions(row({ kind, status: 'void' }), true), kind).toEqual([]);
    }
  });
  it('offers neither on a payment to a supplier or a refund: those are paid and voided on their own screens', () => {
    for (const kind of ['bill', 'refund'] as const) {
      for (const status of ['scheduled', 'posted', 'void'] as const) {
        expect(voucherActions(row({ kind, status }), true), `${kind} ${status}`).toEqual([]);
      }
    }
  });
  it('offers neither before To be paid', () => {
    for (const status of ['draft', 'pending_approval', 'rejected'] as const) {
      const offered = voucherActions(row({ status }), true);
      expect(offered, status).not.toContain('markPaid');
      expect(offered, status).not.toContain('void');
    }
  });
});

describe('the questions', () => {
  it('asks the day it was paid, naming the amount, who is paid and the account', () => {
    const parts = voucherQuestion('markPaid', row());
    // The date field follows these words in the row.
    expect(text(parts)).toBe('Mark the payment of RM 300.00 to Tenaga Nasional, from Maybank Current, as paid on');
    expect(strong(parts)).toEqual(['RM 300.00', 'Tenaga Nasional', 'Maybank Current']);
    expect(text(voucherQuestion('markPaid', row({ party_name: null })))).toBe('Mark the payment of RM 300.00, from Maybank Current, as paid on');
  });
  it('says what paying does, and that expenses are then paid only for a voucher that pays expenses', () => {
    expect(voucherPaidEffect(row())).toBe(
      'It gets its payment voucher number and moves the books on that date. After this it cannot be changed or deleted, only voided.',
    );
    expect(voucherPaidEffect(row({ kind: 'expense' }))).toBe(
      'It gets its payment voucher number and moves the books on that date. What it holds of its expenses is then paid. After this it cannot be changed or deleted, only voided.',
    );
  });
  it('asks before voiding, by number, and says the expenses are owed again only for a voucher that paid expenses', () => {
    const paid = row({ status: 'posted', number: 'PV-0007' });
    expect(text(voucherQuestion('void', paid))).toBe(
      'Void PV-0007, the payment of RM 300.00 to Tenaga Nasional, paid on 05 Oct 2026 from Maybank Current? The money counts as back in the account and the books reverse it. It is kept as Void (find it under Void in the status filter), and this cannot be undone.',
    );
    expect(strong(voucherQuestion('void', paid))).toEqual(['PV-0007', 'RM 300.00', 'Tenaga Nasional', 'Maybank Current']);
    expect(text(voucherQuestion('void', { ...paid, kind: 'expense', category_id: null }))).toBe(
      'Void PV-0007, the payment of RM 300.00 to Tenaga Nasional, paid on 05 Oct 2026 from Maybank Current? The money counts as back in the account and the books reverse it. The expenses it paid are owed that amount again, and can be marked paid again on Expenses. It is kept as Void (find it under Void in the status filter), and this cannot be undone.',
    );
  });
  it('closes the question when the voucher was paid or voided by someone else meanwhile', () => {
    expect(voucherAnswerIsStale(VOUCHER_MESSAGES.alreadyPaid)).toBe(true);
    expect(voucherAnswerIsStale(VOUCHER_MESSAGES.alreadyVoided)).toBe(true);
    expect(voucherAnswerIsStale(VOUCHER_MESSAGES.gone)).toBe(true);
    // A refusal the person can act on keeps the question open.
    expect(voucherAnswerIsStale(VOUCHER_MESSAGES.paidOn)).toBe(false);
    expect(voucherAnswerIsStale(VOUCHER_MESSAGES.accountArchivedPay)).toBe(false);
    expect(voucherAnswerIsStale('Only an owner or admin can post, pay or void. Ask one of them to do this.')).toBe(false);
  });
});

describe('"Paid now" on the form', () => {
  const paid = { ...form, paidNow: true };

  it('pays only a new voucher for a category, and only for someone who may sign off', () => {
    expect(voucherPaysNow(true, paid)).toBe(true);
    expect(voucherPaysNow(false, paid)).toBe(false);
    expect(voucherPaysNow(true, form)).toBe(false);
    expect(voucherPaysNow(true, { ...paid, kind: 'bills' })).toBe(false);
    expect(voucherPaysNow(true, { ...paid, id: VOUCHER })).toBe(false);
  });
  it('sends paid_now only when it pays, in a payload the schema takes', () => {
    expect('paid_now' in voucherPayload(form)).toBe(false);
    expect('paid_now' in voucherPayload(paid)).toBe(false);
    const sent = voucherPayload(paid, voucherPaysNow(true, paid));
    expect(sent.paid_now).toBe(true);
    expect(recordVoucherInput.parse(sent).paid_now).toBe(true);
    // Saving as a draft, or sending for approval, never carries it.
    expect('paid_now' in voucherSavePayload(paid, false)).toBe(false);
    expect('paid_now' in voucherSavePayload(paid, true)).toBe(false);
  });
  it('names the button, the date and the hint by what the save will do', () => {
    expect(voucherSubmitLabel(true, paid)).toBe('Save as paid');
    expect(voucherSubmitLabel(true, form)).toBe('Save voucher');
    expect(voucherSubmitLabel(false, paid)).toBe('Send for approval');
    expect(voucherSubmitLabel(true, { ...paid, kind: 'bills' })).toBe('Send for approval');
    expect(voucherDateLabel(true)).toBe('Date paid');
    expect(voucherDateLabel(false)).toBe('Date to pay');
    expect(voucherSaveHint(true, paid)[0]).toBe(PAID_NOW_HINT);
    expect(PAID_NOW_HINT).toBe(
      'A voucher you save as paid is approved and paid at once, on the date above: you are an owner or admin. It gets its payment voucher number and moves the books, and from then on it cannot be changed or deleted, only voided. A draft is not paid.',
    );
    // Unchanged for everyone else, and for an owner who leaves it To be paid.
    expect(voucherSaveHint(true, form)).toEqual(voucherSaveHint(true));
    expect(voucherSaveHint(false, paid)).toEqual(voucherSaveHint(false));
  });
});

describe('after a write', () => {
  const written = (over: Partial<WrittenVoucher> = {}): WrittenVoucher => ({
    id: VOUCHER, status: 'posted', recorded: false, payee: 'Tenaga Nasional', amount: 300, date: '2026-10-05', ...over,
  });
  const WHAT = 'The payment of RM 300.00 to Tenaga Nasional, dated 05 Oct 2026,';
  const OLD = 'The payment of RM 300.00 to Tenaga Nasional, dated 05 Aug 2026,';

  it('titles the note by what happened', () => {
    expect(writtenVoucherTitle(written())).toBe('Voucher marked paid');
    expect(writtenVoucherTitle(written({ recorded: true }))).toBe('Voucher saved as paid');
    expect(writtenVoucherTitle(written({ status: 'void' }))).toBe('Voucher voided');
  });
  it('says nothing while it is on screen, and points at View all when only the ten-row limit hides it', () => {
    expect(voucherHiddenNote(written(), TODAY, 'month', 'open', true, true)).toBeNull();
    expect(voucherHiddenNote(written(), TODAY, 'month', 'open', true, false)).toBe(`${WHAT} was marked paid. Choose View all to see it.`);
  });
  it('says exactly what hides a paid voucher: the period (it was paid on a day outside it), a status filter, both, or neither', () => {
    const old = written({ date: '2026-08-05' });
    expect(voucherHiddenNote(old, TODAY, 'month', 'open', false, false)).toBe(`${OLD} was marked paid. Choose a longer period to see it.`);
    expect(voucherHiddenNote(old, TODAY, 'month', 'posted', false, false)).toBe(`${OLD} was marked paid. Choose a longer period to see it.`);
    expect(voucherHiddenNote(old, TODAY, 'month', 'scheduled', false, false)).toBe(
      `${OLD} was marked paid. Choose All but void and rejected in the status filter and a longer period to see it.`,
    );
    expect(voucherHiddenNote(written(), TODAY, 'month', 'scheduled', false, false)).toBe(
      `${WHAT} was marked paid. Choose All but void and rejected in the status filter to see it.`,
    );
    expect(voucherHiddenNote(written(), TODAY, 'month', 'open', false, false)).toBe(`${WHAT} was marked paid. Clear the search and the Kind filter to see it.`);
    expect(voucherHiddenNote(written({ recorded: true }), TODAY, 'month', 'void', false, false)).toBe(
      `${WHAT} was saved as paid. Choose All but void and rejected in the status filter to see it.`,
    );
  });
  it('says a voided voucher is under Void, which the first status filter leaves out', () => {
    const voided = written({ status: 'void' });
    expect(voucherHiddenNote(voided, TODAY, 'month', 'open', false, false)).toBe(`${WHAT} was voided. Choose Void in the status filter to see it.`);
    expect(voucherHiddenNote(voided, TODAY, 'month', 'posted', false, false)).toBe(`${WHAT} was voided. Choose Void in the status filter to see it.`);
    expect(voucherHiddenNote({ ...voided, date: '2026-08-05' }, TODAY, 'month', 'open', false, false)).toBe(
      `${OLD} was voided. Choose Void in the status filter and a longer period to see it.`,
    );
    expect(voucherHiddenNote({ ...voided, date: '2026-08-05' }, TODAY, 'month', 'void', false, false)).toBe(`${OLD} was voided. Choose a longer period to see it.`);
    expect(voucherHiddenNote(voided, TODAY, 'month', 'void', false, false)).toBe(`${WHAT} was voided. Clear the search and the Kind filter to see it.`);
  });
});
