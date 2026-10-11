import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOICE_MESSAGES, setEInvoice, setEInvoiceInput, voidInvoice } from '@/lib/finance/invoices';
import {
  markPaymentPaid,
  recordPaymentIn,
  recordPaymentInInput,
  recordPaymentOut,
  recordPaymentOutInput,
} from '@/lib/finance/money';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const TXN = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const LOWER = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const UPPER = LOWER.toUpperCase();

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('setEInvoiceInput', () => {
  const first = (value: unknown) => setEInvoiceInput.safeParse(value).error?.issues[0]?.message;

  it('takes one of the four statuses and nothing else', () => {
    for (const einvoice_status of ['none', 'pending', 'validated', 'rejected']) {
      expect(setEInvoiceInput.safeParse({ id: ID, einvoice_status }).success, einvoice_status).toBe(true);
    }
    expect(first({ id: ID, einvoice_status: 'submitted' })).toBe('Choose an e-Invois status.');
    expect(first({ id: ID })).toBe('Choose an e-Invois status.');
  });
  it('trims the UUID, stores an empty box as null, and keeps it to 100 characters', () => {
    expect(setEInvoiceInput.parse({ id: ID, einvoice_status: 'validated', einvoice_uuid: ' F9D425P6DS7D8IU ' })).toEqual({
      id: ID,
      einvoice_status: 'validated',
      einvoice_uuid: 'F9D425P6DS7D8IU',
    });
    expect(setEInvoiceInput.parse({ id: ID, einvoice_status: 'pending', einvoice_uuid: '   ' }).einvoice_uuid).toBeNull();
    expect(setEInvoiceInput.parse({ id: ID, einvoice_status: 'pending' }).einvoice_uuid).toBeNull();
    expect(first({ id: ID, einvoice_status: 'validated', einvoice_uuid: 'x'.repeat(101) })).toBe('Keep the UUID to 100 characters or fewer.');
    expect(first({ id: ID, einvoice_status: 'validated', einvoice_uuid: 'x'.repeat(100) })).toBeUndefined();
  });
  it('refuses a UUID with no status, after trimming', () => {
    expect(first({ id: ID, einvoice_status: 'none', einvoice_uuid: 'F9D425P6DS7D8IU' })).toBe(
      'An invoice with no e-Invois status has no UUID. Clear the UUID, or choose a status.',
    );
    expect(first({ id: ID, einvoice_status: 'none', einvoice_uuid: '  ' })).toBeUndefined();
  });
  it('asks for a real invoice id and has no place for anything else on the invoice', () => {
    expect(first({ id: 'nope', einvoice_status: 'none' })).toBe('That invoice no longer exists.');
    const parsed = setEInvoiceInput.parse({ id: ID, einvoice_status: 'pending', status: 'void', invoice_no: 'INV-1', org_id: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(['einvoice_status', 'einvoice_uuid', 'id']);
  });
});

describe('setEInvoice', () => {
  const input = { id: ID, einvoice_status: 'validated' as const, einvoice_uuid: 'F9D425P6DS7D8IU' };

  it('changes only the two e-Invois columns and updated_at, scoped to the workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    expect(await setEInvoice(ctx, input)).toEqual({ ok: true, data: { id: ID } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'finance_invoices', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(calls[0].values!).sort()).toEqual(['einvoice_status', 'einvoice_uuid', 'updated_at']);
    expect(calls[0].values).toMatchObject({ einvoice_status: 'validated', einvoice_uuid: 'F9D425P6DS7D8IU' });
  });
  it('clears the UUID when the status goes back to none', async () => {
    const { ctx, calls } = fakeFinance({ data: { id: ID }, error: null });
    await setEInvoice(ctx, { id: ID, einvoice_status: 'none', einvoice_uuid: '' });
    expect(calls[0].values).toMatchObject({ einvoice_status: 'none', einvoice_uuid: null });
  });
  it('says a draft has no e-Invois yet, a voided invoice can no longer be changed, and a missing one is gone', async () => {
    const refused = async (code: string) => setEInvoice(fakeFinance({ data: null, error: { code } }).ctx, input);
    expect(await refused('23514')).toEqual({ ok: false, error: 'e-Invois details can be recorded once the invoice is posted.' });
    expect(await refused('FIN01')).toEqual({ ok: false, error: 'This invoice has been posted or voided, so that can no longer be done.' });
    expect(await refused('42501')).toEqual({ ok: false, error: 'You do not have permission to make changes here.' });
    expect(await setEInvoice(fakeFinance({ data: null, error: null }).ctx, input)).toEqual({ ok: false, error: 'That invoice no longer exists.' });
    expect(logged).not.toHaveBeenCalled();
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await setEInvoice(ctx, input)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});

describe('the sentence for an invoice that can no longer be changed', () => {
  it('never tells a person to void what they have just tried to void', async () => {
    // Voiding an invoice that someone else voided a moment ago is FIN01.
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    const result = await voidInvoice(ctx, { id: ID });
    expect(result).toEqual({ ok: false, error: INVOICE_MESSAGES.locked });
    expect(INVOICE_MESSAGES.locked).not.toMatch(/void it/i);
  });
  it('says where the payments and the refunds of an invoice are voided', () => {
    // A receipt cannot be deleted, so deleting is offered for refunds only: a pending refund has no void.
    expect(INVOICE_MESSAGES.hasPayments).toBe(
      'This invoice has payments or refunds. Void the payments on Payments In, and void or delete the refunds on Refunds, before voiding it.',
    );
    expect(INVOICE_MESSAGES.hasPayments).not.toMatch(/delete the payments/i);
  });
  it('has its own sentence for an invoice that credit notes hold', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN12' } });
    expect(await voidInvoice(ctx, { id: ID })).toEqual({
      ok: false,
      error: 'This invoice has credit notes. Void them on Credit Notes, or delete the drafts, before voiding it.',
    });
  });
});

describe('the same document twice on one payment', () => {
  const payment = { account_id: ACCOUNT, txn_date: '2026-10-05', method: 'fpx' as const };
  const firstIn = (value: unknown) => recordPaymentInInput.safeParse(value).error?.issues[0]?.message;
  const firstOut = (value: unknown) => recordPaymentOutInput.safeParse(value).error?.issues[0]?.message;

  it('is refused for an invoice whatever the capitals of its id', () => {
    const allocations = [{ invoice_id: LOWER, amount: 1 }, { invoice_id: UPPER, amount: 2 }];
    expect(firstIn({ ...payment, allocations })).toBe('Each invoice can appear once on a payment.');
    expect(firstIn({ ...payment, allocations: [allocations[1]] })).toBeUndefined();
  });
  it('is refused for a bill whatever the capitals of its id', () => {
    const allocations = [{ bill_id: UPPER, amount: 1 }, { bill_id: LOWER, amount: 2 }];
    expect(firstOut({ ...payment, allocations })).toBe('Each bill can appear once on a payment.');
    expect(firstOut({ ...payment, allocations: [allocations[0]] })).toBeUndefined();
  });
  it('is worded the same way when the database is the one to refuse it', async () => {
    const duplicate = { data: null, error: { code: '23505' } };
    expect(await recordPaymentIn(fakeFinance(duplicate).ctx, { ...payment, allocations: [{ invoice_id: LOWER, amount: 1 }] })).toEqual({
      ok: false,
      error: 'Each invoice can appear once on a payment.',
    });
    expect(await recordPaymentOut(fakeFinance(duplicate).ctx, { ...payment, allocations: [{ bill_id: LOWER, amount: 1 }] })).toEqual({
      ok: false,
      error: 'Each bill can appear once on a payment.',
    });
    expect(logged).not.toHaveBeenCalled();
  });
  it('is not what a unique violation means when a payment is marked paid', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: '23505' } });
    expect(await markPaymentPaid(ctx, { id: TXN, paid_on: '2026-10-09' })).toEqual({
      ok: false,
      error: 'That change could not be saved. Please try again.',
    });
    expect(logged).toHaveBeenCalled();
  });
});
