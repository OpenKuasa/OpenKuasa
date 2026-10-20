import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBendaharaTools } from '@/lib/ai/finance-tools';
import {
  type CreditNoteForm,
  creditNoteAmountLabel,
  creditNoteFormError,
  creditNoteRinggitNote,
  creditNoteSaved,
  creditNoteSavedNote,
  creditableInvoices,
  creditableLabel,
} from '@/lib/finance/credit-note-form';
import { CREDIT_NOTE_MESSAGES, type CreditNoteRow, creditNoteRinggit, saveCreditNoteInRinggit } from '@/lib/finance/credit-notes';
import { carriedSen, creditNoteRinggit as creditNoteRinggitPreview, refundPreview } from '@/lib/finance/fx-settlement';
import type { InvoiceListRow } from '@/lib/finance/invoices';
import { CASH_RECEIPT_MESSAGES, voidCashReceipt } from '@/lib/finance/cash-receipts';
import { type FinanceAccount, RECEIPT_MESSAGES, voidPaymentIn } from '@/lib/finance/money';
import {
  type RefundForm,
  chooseRefundTarget,
  foreignRefundTarget,
  invoiceTargetKey,
  newRefundForm,
  noteTargetKey,
  refundAmountLabel,
  refundFormError,
  refundPayload,
  refundPreviewNotes,
  refundSaved,
  refundSavedNote,
  refundTargetLabel,
  refundTargets,
  withRefundRinggit,
} from '@/lib/finance/refund-form';
import {
  REFUND_MESSAGES,
  type RefundRow,
  recordRefund,
  recordRefundInRinggit,
  recordRefundInput,
  recordRefundToolInput,
  refundRinggit,
} from '@/lib/finance/refunds';
import { creditNotesCsv, creditNotesView, refundsCsv, refundsView } from '@/lib/finance/sales-followon-views';
import { inCreditRinggit } from '@/lib/finance/sales-views';
import { ringgitRow } from './helpers/invoice-rows';

/**
 * Stage 3c, credit notes and refunds on invoices in another currency: the closing rule past zero, the forms, the
 * data layer, the assistant, and every figure that adds credit notes and refunds up, in ringgit. The figures are
 * the plan's worked examples C1, C2 and D (.superpowers/sdd/2026-10-16-bendahara-fx-sales.md) and the migration's
 * rulings, the same ones supabase/tests/bendahara_fx_credit_notes_refunds_check.sql asserts against the database.
 */

const sen = (n: number) => BigInt(Math.round(n * 100));
const rate = (text: string) => BigInt(text.replace('.', '').padEnd(text.indexOf('.') + 10, '0'));

const AISYAH = '11111111-1111-4111-8111-111111111111';
const BANK = '66666666-6666-4666-8666-666666666666';
const TODAY = '2026-10-19';
const MYR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const C1_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const D_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const JPY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const NOTE_D = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';

const MYR_ROW: InvoiceListRow = ringgitRow({
  id: MYR_ID, invoice_no: 'INV-1', customer_id: AISYAH, customer_name: 'Aisyah Trading', invoice_date: '2026-10-05',
  due_date: '2026-10-30', total: 100, paid: 0, credited: 0, refunded: 0, balance: 100, display_status: 'sent',
  einvoice_status: 'none', einvoice_uuid: null,
});
/** Worked example A: USD 1,080.00 at 4.2 (RM 4,536.00), unpaid. */
const C1_ROW: InvoiceListRow = {
  ...MYR_ROW, id: C1_ID, invoice_no: 'INV-2', total: 1080, balance: 1080,
  currency: 'USD', fx_rate: 4.2, fx_rate_text: '4.2000000000', fx_rate_source: 'manual', fx_rate_provider: 'reuters',
  total_myr: 4536, balance_myr: 4536, sst_myr: 336, paid_myr: 0,
};
/** Worked example D after the credit note: paid in full, then credited USD 108.00 (RM 453.60). In credit. */
const D_ROW: InvoiceListRow = {
  ...C1_ROW, id: D_ID, invoice_no: 'INV-3', paid: 1080, credited: 108, balance: -108, balance_myr: -453.6,
  paid_myr: 4536, display_status: 'paid',
};
const JPY_ROW: InvoiceListRow = {
  ...C1_ROW, id: JPY_ID, invoice_no: 'INV-4', currency: 'JPY', total: 100000, balance: 100000,
  fx_rate: 0.029, fx_rate_text: '0.0290000000', total_myr: 2900, balance_myr: 2900, sst_myr: 0,
};
const D_NOTE: CreditNoteRow = {
  id: NOTE_D, credit_note_no: 'CN-0001', invoice_id: D_ID, invoice_no: 'INV-3', customer_id: AISYAH,
  customer_name: 'Aisyah Trading', credit_date: '2026-10-15', reason: 'returns', amount: 108, refunded: 0,
  status: 'issued', notes: null, currency: 'USD', fx_rate: 4.2, amount_myr: 453.6,
};

/* ---- the closing rule, past zero ------------------------------------------------- */

describe('what a credit note carries (private.finance_fx_carried, 3c)', () => {
  it('C1: USD 108.00 on an invoice that owes USD 1,080.00 at 4.2 takes round(453.6) = 453.60', () => {
    expect(carriedSen(sen(108), rate('4.2'), sen(1080), sen(4536))).toBe(sen(453.6));
  });
  it('C2: USD 99.99 that clears the three-line invoice takes the 425.52 open, not round(425.507445) = 425.51', () => {
    expect(carriedSen(sen(99.99), rate('4.2555'), sen(99.99), sen(425.52))).toBe(sen(425.52));
  });
  it('D: on a paid invoice nothing is open, so the part at the rate (453.60, not 0.00)', () => {
    expect(carriedSen(sen(108), rate('4.2'), sen(0), sen(0))).toBe(sen(453.6));
    // Already in credit: the same.
    expect(carriedSen(sen(10), rate('4.2'), sen(-5), sen(-21))).toBe(sen(42));
  });
  it('past zero: what is open, then the rest at the rate (212.74 + round(42.597555) = 255.34, not 255.33)', () => {
    expect(carriedSen(sen(60), rate('4.2555'), sen(49.99), sen(212.74))).toBe(sen(255.34));
  });
  it('keeps the cap for a part that does not clear an invoice whose lines rounded down (IDR)', () => {
    expect(carriedSen(sen(2000029), rate('0.00028'), sen(2000030), sen(560))).toBe(sen(560));
    expect(carriedSen(sen(1), rate('0.00028'), sen(1), sen(0))).toBe(sen(0));
  });
  it('a refund of a credit balance: closing takes the ringgit in credit (D: 453.60)', () => {
    // For a refund what is open is the credit, in both currencies (the caller passes it as a positive figure).
    expect(carriedSen(sen(108), rate('4.2'), sen(108), sen(453.6))).toBe(sen(453.6));
  });
});

describe('the previews, in whole sen', () => {
  it('a credit note takes about RM 453.60 (C1), and null while the amount is not a number', () => {
    expect(creditNoteRinggitPreview('108', '4.2000000000', 1080, 4536)).toBe(453.6);
    expect(creditNoteRinggitPreview('', '4.2000000000', 1080, 4536)).toBeNull();
    expect(creditNoteRinggitPreview('108', null, 1080, 4536)).toBeNull();
  });
  it('a refund of USD 108.00 paid out as RM 445.00 carried 453.60, a gain of 8.60 (D)', () => {
    expect(refundPreview('445', '108', '4.2000000000', 108, 453.6)).toEqual({ carried: 453.6, realised: 8.6 });
    expect(refundPreview('460', '108', '4.2000000000', 108, 453.6)).toEqual({ carried: 453.6, realised: -6.4 });
    expect(refundPreview('', '108', '4.2000000000', 108, 453.6)).toBeNull();
  });
});

/* ---- the credit note form ------------------------------------------------------------ */

describe('the credit note form, on an invoice in another currency', () => {
  const offered = creditableInvoices([MYR_ROW, C1_ROW, JPY_ROW]);
  const usd = offered.find((i) => i.id === C1_ID)!;
  const form = (f: Partial<CreditNoteForm> = {}): CreditNoteForm => ({
    invoiceId: C1_ID, date: TODAY, reason: 'returns', amount: '108', notes: '', ...f,
  });

  it('offers it in its currency, with its rate and what it still carries', () => {
    expect(offered.map((i) => i.id)).toEqual([MYR_ID, C1_ID, JPY_ID]);
    expect(usd).toMatchObject({ currency: 'USD', fx_rate_text: '4.2000000000', creditable: 1080, balance: 1080, balance_myr: 4536 });
    expect(creditableLabel(usd)).toBe('INV-2 · Aisyah Trading · USD 1,080.00 left to credit');
    // A foreign draft with no rate yet is not posted, so it is not offered either way.
    expect(creditableInvoices([{ ...C1_ROW, fx_rate_text: null }])).toEqual([]);
  });

  it('asks for the amount in its currency and says about what it takes off in ringgit', () => {
    expect(creditNoteAmountLabel(form(), offered)).toBe('Amount (USD)');
    expect(creditNoteAmountLabel(form({ invoiceId: MYR_ID }), offered)).toBe('Amount (RM)');
    expect(creditNoteRinggitNote(form(), offered)).toBe('≈ RM 453.60 at the invoice’s rate. No exchange gain or loss.');
    expect(creditNoteRinggitNote(form({ invoiceId: MYR_ID }), offered)).toBeNull();
    expect(creditNoteRinggitNote(form({ amount: 'x' }), offered)).toBeNull();
  });

  it('asks for whole yen, and no more than is left to credit', () => {
    expect(creditNoteFormError(form({ invoiceId: JPY_ID, amount: '100.5' }), offered)).toBe('JPY has no cents: enter whole amounts.');
    expect(creditNoteFormError(form({ invoiceId: JPY_ID, amount: '100' }), offered)).toBeNull();
    expect(creditNoteFormError(form({ amount: '1080.01' }), offered)).toBe(CREDIT_NOTE_MESSAGES.tooMuch);
    expect(creditNoteFormError(form(), offered)).toBeNull();
  });

  it('says what was saved in its currency', () => {
    const saved = creditNoteSaved(form(), offered, true)!;
    expect(saved).toMatchObject({ amount: 108, currency: 'USD' });
    expect(creditNoteSavedNote(saved).lead).toBe(
      'A credit note of USD 108.00 was issued against INV-2. It can be voided, or refunded while the customer is in credit, on',
    );
  });
});

/* ---- the refund form ---------------------------------------------------------------- */

describe('the refund form, on an invoice in another currency', () => {
  const accounts: FinanceAccount[] = [{ id: BANK, name: 'Main Bank', kind: 'bank', bank_name: 'Maybank', currency: 'MYR' }];
  const targets = refundTargets([D_ROW, MYR_ROW], [D_NOTE], []);
  const onNote = targets.find((t) => t.key === noteTargetKey(NOTE_D))!;
  const opened = (): RefundForm => ({ ...newRefundForm(targets, accounts, TODAY, noteTargetKey(NOTE_D)), reason: 'damaged_goods' });

  it('offers the invoice in credit and its credit note, in its currency, with what the customer is in credit in ringgit', () => {
    expect(targets.map((t) => t.key)).toEqual([invoiceTargetKey(D_ID), noteTargetKey(NOTE_D)]);
    expect(onNote).toMatchObject({ currency: 'USD', refundable: 108, credit: 108, credit_myr: 453.6, fx_rate_text: '4.2000000000' });
    expect(refundTargetLabel(onNote)).toBe('CN-0001 on INV-3 · Aisyah Trading · USD 108.00 can be refunded');
  });

  it('asks for the ringgit paid out, and previews example D: carried 453.60, a gain of 8.60', () => {
    const form = opened();
    expect(foreignRefundTarget(form, targets)?.currency).toBe('USD');
    expect(refundAmountLabel(form, targets)).toBe('Amount refunded (USD)');
    expect(refundFormError(form, targets)).toBe(REFUND_MESSAGES.ringgitPaidOut);
    const paid = withRefundRinggit(form, '445.00');
    expect(refundFormError(paid, targets)).toBeNull();
    expect(refundPreviewNotes(paid, targets)).toEqual([
      'The invoice carries about RM 453.60 for what is refunded.',
      'Realised exchange gain of about RM 8.60.',
    ]);
    expect(refundPreviewNotes(withRefundRinggit(form, '453.60'), targets)).toEqual([
      'The invoice carries about RM 453.60 for what is refunded.',
      'No exchange gain or loss.',
    ]);
  });

  it('sends the ringgit as the text typed, commas dropped, and the amount in the invoice’s currency', () => {
    const paid = withRefundRinggit(opened(), '1,445.00');
    expect(refundPayload(paid, targets)).toMatchObject({ credit_note_id: NOTE_D, amount: 108, amount_myr: '1445.00', scheduled: false });
    expect(recordRefundInput.parse(refundPayload(paid, targets)).amount_myr).toBe('1445.00');
    // A ringgit refund sends no ringgit figure.
    const myr = chooseRefundTarget(opened(), refundTargets([{ ...MYR_ROW, paid: 110, balance: -10, balance_myr: -10, display_status: 'paid' }], [], [])[0]);
    expect(refundPayload(myr, targets)).not.toHaveProperty('amount_myr');
  });

  it('is paid out now: never scheduled (FIN47), and choosing it clears a pay-later choice', () => {
    const scheduled = { ...withRefundRinggit(opened(), '445'), scheduled: true };
    expect(refundFormError(scheduled, targets)).toBe(REFUND_MESSAGES.payNow);
    const fromMyr = { ...opened(), target: invoiceTargetKey(MYR_ID), scheduled: true };
    expect(chooseRefundTarget(fromMyr, onNote)).toMatchObject({ target: onNote.key, scheduled: false, ringgit: '', amount: '108.00' });
  });

  it('says what was recorded in its currency and in ringgit', () => {
    const saved = refundSaved(withRefundRinggit(opened(), '445'), targets)!;
    expect(saved).toMatchObject({ amount: 108, ringgit: '445', scheduled: false });
    expect(refundSavedNote(saved).lead).toBe('USD 108.00 (RM 445.00) was paid out against CN-0001 on INV-3. It can be voided on');
  });
});

/* ---- the data layer and the assistant ------------------------------------------ */

function fakeClient(rows: { invoices?: Record<string, string>; notes?: Record<string, string>; accounts?: Record<string, string> } = {}) {
  const calls: { kind: string; payload: unknown }[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: `rpc:${name}`, payload: args });
      return { data: 'new-1', error: null };
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let id = '';
      q.select = () => q;
      q.eq = (column: string, value: string) => {
        if (column === 'id') id = value;
        return q;
      };
      q.maybeSingle = () => {
        calls.push({ kind: `read:${table}`, payload: id });
        // Stage 5a: the assistant reads the account's currency first.
        if (table === 'finance_accounts') return Promise.resolve({ data: { id, currency: rows.accounts?.[id] ?? 'MYR' }, error: null });
        if (table === 'finance_invoices') {
          const currency = rows.invoices?.[id];
          return Promise.resolve({ data: currency ? { currency } : null, error: null });
        }
        const invoiceId = rows.notes?.[id];
        return Promise.resolve({ data: invoiceId ? { invoice_id: invoiceId } : null, error: null });
      };
      return q;
    },
  };
  return { client: client as never, calls };
}

const refundInput = { account_id: BANK, txn_date: TODAY, method: 'fpx' as const, reason: 'damaged_goods' as const, amount: 108 };

describe('recording a refund', () => {
  it('sends the ringgit paid out only when there is one, and maps FIN46 and FIN47 to their sentences', async () => {
    const { client, calls } = fakeClient();
    await recordRefund({ client, orgId: 'org1' }, { ...refundInput, credit_note_id: NOTE_D, amount_myr: '445' });
    await recordRefund({ client, orgId: 'org1' }, { ...refundInput, invoice_id: MYR_ID });
    const sent = calls.map((c) => (c.payload as { refund: object }).refund);
    expect(sent[0]).toMatchObject({ amount_myr: '445', status: 'posted' });
    expect(sent[1]).not.toHaveProperty('amount_myr');
    for (const [code, sentence] of [['FIN46', REFUND_MESSAGES.ringgitPaidOut], ['FIN47', REFUND_MESSAGES.payNow]]) {
      const failing = { rpc: async () => ({ data: null, error: { code, message: 'x' } }) } as never;
      expect(await recordRefund({ client: failing, orgId: 'org1' }, { ...refundInput, credit_note_id: NOTE_D })).toEqual({ ok: false, error: sentence });
    }
  });

  it('refuses a ringgit figure that is not money above 0', () => {
    for (const bad of ['0', '0.00', '1.005', '1,445', 'NaN', '-5']) {
      expect(recordRefundInput.safeParse({ ...refundInput, credit_note_id: NOTE_D, amount_myr: bad }).success, bad).toBe(false);
    }
  });
});

describe('the assistant records credit notes and refunds in ringgit only', () => {
  it('is offered no ringgit-paid-out figure', () => {
    const { client } = fakeClient();
    const tools = createBendaharaTools({ client, orgId: 'org1', canWrite: true }) as unknown as Record<string, { inputSchema: z.ZodType }>;
    const schema = z.toJSONSchema(tools.recordRefund.inputSchema, { unrepresentable: 'any', io: 'input' }) as { properties: object };
    expect(Object.keys(schema.properties)).not.toContain('amount_myr');
    expect(recordRefundToolInput.parse({ ...refundInput, invoice_id: MYR_ID, amount_myr: '5' })).not.toHaveProperty('amount_myr');
  });

  it('refuses a refund on a foreign invoice, or on a credit note of one, in its own words, and records nothing', async () => {
    const { client, calls } = fakeClient({ invoices: { [D_ID]: 'USD' }, notes: { [NOTE_D]: D_ID } });
    expect(await recordRefundInRinggit({ client, orgId: 'org1' }, { ...refundInput, credit_note_id: NOTE_D })).toEqual({
      ok: false,
      error: 'This invoice is not in ringgit. Record its refund on the Refunds screen.',
    });
    expect(await recordRefundInRinggit({ client, orgId: 'org1' }, { ...refundInput, invoice_id: D_ID })).toEqual({
      ok: false,
      error: 'This invoice is not in ringgit. Record its refund on the Refunds screen.',
    });
    expect(calls.map((c) => c.kind)).toEqual([
      'read:finance_accounts', 'read:finance_credit_notes', 'read:finance_invoices', 'read:finance_accounts', 'read:finance_invoices',
    ]);
  });

  it('records a ringgit refund', async () => {
    const { client, calls } = fakeClient({ invoices: { [MYR_ID]: 'MYR' } });
    expect(await recordRefundInRinggit({ client, orgId: 'org1' }, { ...refundInput, invoice_id: MYR_ID })).toEqual({ ok: true, data: { id: 'new-1' } });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts', 'read:finance_invoices', 'rpc:finance_record_refund']);
  });

  it('refuses a refund from an account in another currency in its own words, before anything else (stage 5a)', async () => {
    const { client, calls } = fakeClient({ invoices: { [MYR_ID]: 'MYR' }, accounts: { [BANK]: 'USD' } });
    expect(await recordRefundInRinggit({ client, orgId: 'org1' }, { ...refundInput, invoice_id: MYR_ID })).toEqual({
      ok: false,
      error: 'This account is not in ringgit. Record this on the screen, where its currency and rate are shown.',
    });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_accounts']);
  });

  it('refuses a credit note on a foreign invoice in its own words, and saves a ringgit one', async () => {
    const { client, calls } = fakeClient({ invoices: { [C1_ID]: 'USD', [MYR_ID]: 'MYR' } });
    const note = { credit_date: TODAY, reason: 'returns' as const, amount: 10 };
    expect(await saveCreditNoteInRinggit({ client, orgId: 'org1' }, { ...note, invoice_id: C1_ID })).toEqual({
      ok: false,
      error: CREDIT_NOTE_MESSAGES.foreignByAssistant,
    });
    expect(await saveCreditNoteInRinggit({ client, orgId: 'org1' }, { ...note, invoice_id: MYR_ID })).toEqual({ ok: true, data: { id: 'new-1' } });
    expect(calls.map((c) => c.kind)).toEqual(['read:finance_invoices', 'read:finance_invoices', 'rpc:finance_save_credit_note']);
  });
});

/* ---- every figure that adds credit notes and refunds up is in ringgit ------------- */

const MYR_NOTE: CreditNoteRow = { ...D_NOTE, id: 'n-myr', invoice_id: MYR_ID, credit_note_no: 'CN-0002', amount: 30, currency: 'MYR', fx_rate: 1, amount_myr: 30 };
const refundRow = (r: Partial<RefundRow>): RefundRow => ({
  allocation_id: 'a', transaction_id: 't', number: 'PV-1', txn_date: '2026-10-12', method: 'fpx', amount: 20,
  transaction_amount: 20, status: 'posted', reference: null, reason: 'damaged_goods', notes: null, account_id: BANK,
  account_name: 'Main Bank', invoice_id: MYR_ID, invoice_no: 'INV-1', credit_note_id: null, credit_note_no: null,
  customer_id: AISYAH, customer_name: 'Aisyah Trading', ...r,
});
const MYR_REFUND = refundRow({ allocation_id: 'a1', transaction_id: 't1' });
const USD_REFUND = refundRow({
  allocation_id: 'a2', transaction_id: 't2', amount: 108, transaction_amount: 445, invoice_id: D_ID, invoice_no: 'INV-3',
  credit_note_id: NOTE_D, credit_note_no: 'CN-0001', currency: 'USD', amount_myr: 445, carried_myr: 453.6, realised_myr: 8.6,
});

describe('credit notes and refunds added up', () => {
  it('count a foreign credit note at what it took off, and a foreign refund at the ringgit paid out', () => {
    expect(creditNoteRinggit(D_NOTE)).toBe(453.6);
    expect(creditNoteRinggit(MYR_NOTE)).toBe(30);
    // A foreign draft has taken nothing off yet.
    expect(creditNoteRinggit({ amount: 5, currency: 'USD', amount_myr: null })).toBe(0);
    expect(refundRinggit(USD_REFUND)).toBe(445);
    expect(refundRinggit(MYR_REFUND)).toBe(20);
    expect(inCreditRinggit(D_ROW)).toBe(453.6);
    expect(inCreditRinggit(C1_ROW)).toBe(0);
  });

  it('on Credit Notes: credited this month and this year in ringgit', () => {
    const view = creditNotesView([D_NOTE, { ...MYR_NOTE, credit_date: '2026-10-16' }], TODAY);
    expect(view.stats[0]).toMatchObject({ label: 'Credited (MTD)', value: 'RM 484' });
    expect(view.creditedYtd).toBe('RM 484');
  });

  it('on Refunds: refunded this month and what customers are in credit, in ringgit', () => {
    const view = refundsView([MYR_REFUND, USD_REFUND], [D_ROW, MYR_ROW], TODAY);
    expect(view.stats[0]).toMatchObject({ label: 'Refunded (MTD)', value: 'RM 465' });
    expect(view.stats[2]).toMatchObject({ label: 'In credit', value: 'RM 454' });
  });

  it('in the exports, with the currency and the ringgit once one is foreign', () => {
    const notes = creditNotesCsv([MYR_NOTE, D_NOTE]).replace(/^﻿/, '').split(/\r?\n/);
    expect(notes[0]).toBe('No.,Date,Customer,Invoice,Reason,Amount,Refunded,Status,Currency,Rate (RM per unit),Amount (RM)');
    expect(notes[2]).toContain(',108,0,Issued,USD,4.2,453.6');
    expect(creditNotesCsv([MYR_NOTE]).replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('No.,Date,Customer,Invoice,Reason,Amount,Refunded,Status');
    const refunds = refundsCsv([MYR_REFUND, USD_REFUND]).replace(/^﻿/, '').split(/\r?\n/);
    expect(refunds[0]).toBe('Date,No.,Customer,Invoice,Credit note,Reason,Account,Method,Amount,Status,Currency,Amount (RM),Carried (RM),Realised (RM)');
    expect(refunds[1]).toContain(',20,Refunded,MYR,20,20,0');
    expect(refunds[2]).toContain(',108,Refunded,USD,445,453.6,8.6');
    expect(refundsCsv([MYR_REFUND]).replace(/^﻿/, '').split(/\r?\n/)[0]).toBe('Date,No.,Customer,Invoice,Credit note,Reason,Account,Method,Amount,Status');
  });
});

/* ---- FIN48: a payment in that a later credit note leans on is not voided ------------ */

/** A client whose pre-void lookup finds the payment and whose void is answered with `code`. */
function voidClient(code: string) {
  const q: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'update']) q[name] = () => q;
  q.limit = () => Promise.resolve({ data: [{ transaction_id: 't1' }], error: null });
  q.maybeSingle = () => Promise.resolve({ data: null, error: { code, message: 'x' } });
  return { from: () => q } as never;
}

describe('voiding a payment in that a later credit note leans on (FIN48)', () => {
  const sentence =
    'A credit note on this invoice was issued after this payment. Void the credit note first, then the payment; issue the credit note again after.';
  it('says what to do, on Payments In and on Cash Receipts', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    expect(RECEIPT_MESSAGES.creditNoteAfter).toBe(sentence);
    expect(CASH_RECEIPT_MESSAGES.creditNoteAfter).toBe(sentence);
    expect(await voidPaymentIn({ client: voidClient('FIN48'), orgId: 'org1' }, { id })).toEqual({ ok: false, error: sentence });
    expect(await voidCashReceipt({ client: voidClient('FIN48'), orgId: 'org1' }, { id })).toEqual({ ok: false, error: sentence });
  });
});
