import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDIT_NOTE_PAGE_SIZE,
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_REASON_LABELS,
  deleteCreditNote,
  issueCreditNote,
  listCreditNotes,
  saveCreditNote,
  saveCreditNoteInput,
  voidCreditNote,
} from '@/lib/finance/credit-notes';
import { fakeFinance } from './setup/fake-finance';

const ID = '33333333-3333-4333-8333-333333333333';
const INVOICE = '55555555-5555-4555-8555-555555555555';

const valid = { invoice_id: INVOICE, credit_date: '2026-10-06', reason: 'returns' as const, amount: 240 };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => saveCreditNoteInput.safeParse(value).error?.issues[0]?.message;

describe('saveCreditNoteInput', () => {
  it('asks for the invoice, a real date and a reason from the list', () => {
    expect(first({ ...valid, invoice_id: '' })).toBe('Choose the invoice this credit note is against.');
    expect(first({ ...valid, invoice_id: undefined })).toBe('Choose the invoice this credit note is against.');
    expect(first({ ...valid, credit_date: '2026-02-30' })).toBe('Enter a valid date.');
    expect(first({ ...valid, reason: 'because' })).toBe('Choose a reason.');
    expect(first({ ...valid, reason: undefined })).toBe('Choose a reason.');
  });
  it('rounds the amount to the sen first, then asks for more than nothing', () => {
    expect(saveCreditNoteInput.parse({ ...valid, amount: 240.005 }).amount).toBe(240.01);
    expect(saveCreditNoteInput.parse({ ...valid, amount: 0.005 }).amount).toBe(0.01);
    expect(first({ ...valid, amount: 0.004 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: 0 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: -5 })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: '240' })).toBe('Enter an amount above 0.');
    expect(first({ ...valid, amount: 1e12 })).toBe('Enter an amount above 0.');
  });
  it('keeps a note to 200 characters, and stores an empty one as nothing', () => {
    expect(saveCreditNoteInput.parse({ ...valid, notes: '  ' }).notes).toBeNull();
    expect(saveCreditNoteInput.parse(valid).notes).toBeNull();
    expect(first({ ...valid, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('has no place for a number or a status: the database gives those', () => {
    const parsed = saveCreditNoteInput.parse({ ...valid, credit_note_no: 'CN-9999', status: 'issued' });
    expect(Object.keys(parsed).sort()).toEqual(['amount', 'credit_date', 'invoice_id', 'notes', 'reason']);
  });
  it('has a label for every reason', () => {
    expect(Object.keys(CREDIT_NOTE_REASON_LABELS).sort()).toEqual([...CREDIT_NOTE_REASONS].sort());
  });
});

describe('credit note reads', () => {
  const row = (n: number) => ({
    id: `cn-${n}`, credit_note_no: `CN-${n}`, invoice_id: 'inv-1', invoice_no: 'INV-1042', customer_id: 'c1',
    customer_name: 'Aisyah Trading', credit_date: '2026-10-06', reason: 'returns', amount: '240.00', refunded: '100.00',
    status: 'issued', notes: null,
  });

  it('lists from the totals view, in the caller’s workspace, newest first, with amounts as numbers', async () => {
    const { ctx, calls } = fakeFinance({ data: [row(1)], error: null });
    expect(await listCreditNotes(ctx)).toEqual([{ ...row(1), amount: 240, refunded: 100 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_credit_note_totals',
      op: 'select',
      filters: { org_id: 'org-1' },
      order: ['credit_date desc', 'id asc'],
      range: [0, CREDIT_NOTE_PAGE_SIZE - 1],
    });
  });
  it('reads on past a full page', async () => {
    const full = Array.from({ length: CREDIT_NOTE_PAGE_SIZE }, (_, n) => row(n));
    const { ctx, calls } = fakeFinance((call) => ({ data: call.range?.[0] === 0 ? full : [row(-1)], error: null }));
    expect(await listCreditNotes(ctx)).toHaveLength(CREDIT_NOTE_PAGE_SIZE + 1);
    expect(calls).toHaveLength(2);
  });
  it('throws a read error for the screen’s error page', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(listCreditNotes(ctx)).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('credit note writes', () => {
  it('saves through the database function, in the caller’s workspace', async () => {
    const { ctx, calls } = fakeFinance({ data: ID, error: null });
    expect(await saveCreditNote(ctx, { ...valid, id: ID, notes: ' Two returned ' })).toEqual({ ok: true, data: { id: ID } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_save_credit_note' });
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      note: { id: ID, invoice_id: INVOICE, credit_date: '2026-10-06', reason: 'returns', amount: 240, notes: 'Two returned' },
    });
  });
  it('issues and returns the number', async () => {
    const { ctx, calls } = fakeFinance({ data: 'CN-0007', error: null });
    expect(await issueCreditNote(ctx, { id: ID })).toEqual({ ok: true, data: { id: ID, credit_note_no: 'CN-0007' } });
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'finance_issue_credit_note' });
    expect(calls[0].args).toEqual({ target_org: 'org-1', target_note: ID });
  });
  it('voids by setting the status and deletes a draft, both scoped to the workspace', async () => {
    const voided = fakeFinance({ data: { id: ID }, error: null });
    expect(await voidCreditNote(voided.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_credit_notes', op: 'update', filters: { id: ID, org_id: 'org-1' } });
    expect(Object.keys(voided.calls[0].values!).sort()).toEqual(['status', 'updated_at']);
    expect(voided.calls[0].values).toMatchObject({ status: 'void' });

    const removed = fakeFinance({ data: { id: ID }, error: null });
    expect(await deleteCreditNote(removed.ctx, { id: ID })).toEqual({ ok: true, data: { id: ID } });
    expect(removed.calls[0]).toMatchObject({ name: 'finance_credit_notes', op: 'delete', filters: { id: ID, org_id: 'org-1' } });
  });
  it('words FIN01 so that it reads sensibly from every button that can meet it: Save, Issue, Void and Delete', async () => {
    const sentence =
      'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.';
    const { ctx } = fakeFinance({ data: null, error: { code: 'FIN01' } });
    // Save and Delete on a draft that was issued in another tab; Issue on one issued a moment ago; Void on one already void.
    expect(await saveCreditNote(ctx, { ...valid, id: ID })).toEqual({ ok: false, error: sentence });
    expect(await issueCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: sentence });
    expect(await voidCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: sentence });
    expect(await deleteCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: sentence });
  });
  it('turns each database refusal into a sentence', async () => {
    const cases: [string, string][] = [
      ['FIN01', 'That cannot be done to this credit note as it now stands. It may have been issued or voided since this page was loaded.'],
      ['FIN02', 'A refund depends on this credit note. Void or delete that refund on Refunds before voiding it.'],
      ['FIN04', 'A credit note can only go against a posted invoice.'],
      ['FIN05', 'That is more than this invoice has left to credit.'],
      ['FIN11', 'That credit note no longer exists.'],
      ['FIN14', 'Only an owner or admin can post, pay or void. Ask one of them to do this.'],
      ['23505', 'That credit note number is already used.'],
      ['23503', 'The invoice on this credit note no longer exists.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
    ];
    for (const [code, message] of cases) {
      const { ctx } = fakeFinance({ data: null, error: { code } });
      expect(await saveCreditNote(ctx, valid), code).toEqual({ ok: false, error: message });
      expect(await issueCreditNote(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await voidCreditNote(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteCreditNote(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
  it('says the credit note is gone when void or delete touches no row', async () => {
    const { ctx } = fakeFinance({ data: null, error: null });
    expect(await voidCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: 'That credit note no longer exists.' });
    expect(await deleteCreditNote(ctx, { id: ID })).toEqual({ ok: false, error: 'That credit note no longer exists.' });
  });
  it('hides any other database error behind the general message and logs it', async () => {
    const { ctx } = fakeFinance({ data: null, error: { code: 'XX000' } });
    expect(await saveCreditNote(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
    expect(logged).toHaveBeenCalled();
  });
});
