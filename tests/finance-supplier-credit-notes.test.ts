import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySupplierCredit,
  applySupplierCreditInput,
  deleteSupplierCreditNote,
  issueSupplierCreditNote,
  listOpenSupplierCredit,
  listSupplierCreditNotes,
  openCreditBySupplier,
  supplierCreditNotesOrNone,
  saveSupplierCreditNote,
  saveSupplierCreditNoteInput,
  unapplySupplierCredit,
  voidSupplierCreditNote,
} from '@/lib/finance/supplier-credit-notes';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

const NOTE = '11111111-1111-4111-8111-111111111111';
const BILL = '22222222-2222-4222-8222-222222222222';
const LATER = '33333333-3333-4333-8333-333333333333';

const typed = { bill_id: BILL, credit_date: '2026-10-05', reason: 'overpaid', amount: 150, supplier_ref: ' PH-CN-118 ', notes: '' };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

describe('saveSupplierCreditNoteInput', () => {
  const first = (v: unknown) => saveSupplierCreditNoteInput.safeParse(v).error?.issues[0]?.message;
  it('asks for a bill, a date, a reason and an amount above 0', () => {
    expect(first({ ...typed, bill_id: '' })).toBe('Choose the bill this credit note is against.');
    expect(first({ ...typed, credit_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...typed, reason: 'goodwill' })).toBe('Choose a reason.');
    expect(first({ ...typed, amount: 0 })).toBe('Enter an amount above 0.');
  });
  it('trims the supplier’s reference and blanks empty notes', () => {
    expect(saveSupplierCreditNoteInput.parse(typed)).toMatchObject({ supplier_ref: 'PH-CN-118', notes: null });
  });
});

describe('listSupplierCreditNotes', () => {
  it('reads the notes, where their credit went, and the numbers of later bills', async () => {
    const { ctx, calls } = fakeFinance((call: FinanceCall) => {
      if (call.name === 'finance_supplier_credit_note_totals') {
        return {
          data: [
            {
              id: NOTE, credit_note_no: 'SCN-0001', bill_id: BILL, bill_no: 'BILL-0001', supplier_id: 's', supplier_name: 'Printhub',
              credit_date: '2026-10-03', reason: 'overpaid', amount: '150.00', supplier_ref: null, notes: null, status: 'issued',
              applied: '150.00', open_amount: '0.00',
            },
          ],
          error: null,
        };
      }
      if (call.name === 'finance_supplier_credit_applications') {
        return { data: [{ credit_note_id: NOTE, bill_id: LATER, amount: '30' }, { credit_note_id: NOTE, bill_id: BILL, amount: '120' }], error: null };
      }
      return { data: [{ id: LATER, bill_no: 'BILL-0004' }], error: null };
    });
    const [row] = await listSupplierCreditNotes(ctx);
    expect(row).toMatchObject({ amount: 150, applied: 150, open_amount: 0 });
    // Its own bill first.
    expect(row.applications).toEqual([
      { bill_id: BILL, bill_no: 'BILL-0001', amount: 120 },
      { bill_id: LATER, bill_no: 'BILL-0004', amount: 30 },
    ]);
    expect(calls[0]).toMatchObject({ filters: { org_id: 'org-1' }, order: ['credit_date desc', 'id asc'], range: [0, 999] });
    // Only the bill not already known is read.
    expect(calls[2]).toMatchObject({ name: 'supplier_bills', filters: { org_id: 'org-1', 'id in': [LATER] } });
  });
  it('reads the notes and the applications together, and no bill numbers when there are no notes', async () => {
    const { ctx, calls } = fakeFinance({ data: [], error: null });
    expect(await listSupplierCreditNotes(ctx)).toEqual([]);
    expect(calls.map((c) => c.name).sort()).toEqual(['finance_supplier_credit_applications', 'finance_supplier_credit_note_totals']);
  });
});

describe('listOpenSupplierCredit', () => {
  it('reads only issued notes with credit left, and only the three columns open credit needs', async () => {
    const { ctx, calls } = fakeFinance({
      data: [{ supplier_id: 's', status: 'issued', open_amount: '40.50' }],
      error: null,
    });
    expect(await listOpenSupplierCredit(ctx)).toEqual([{ supplier_id: 's', status: 'issued', open_amount: 40.5 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'finance_supplier_credit_note_totals',
      columns: 'supplier_id,status,open_amount',
      filters: { org_id: 'org-1', status: 'issued', 'open_amount gt': 0 },
      range: [0, 999],
    });
  });
});

describe('openCreditBySupplier', () => {
  it('adds up what issued notes still have open, per supplier', () => {
    expect(
      openCreditBySupplier([
        { supplier_id: 'a', status: 'issued', open_amount: 10.1 },
        { supplier_id: 'a', status: 'issued', open_amount: 0.2 },
        { supplier_id: 'b', status: 'draft', open_amount: 50 },
        { supplier_id: 'c', status: 'issued', open_amount: 0 },
      ]),
    ).toEqual({ a: 10.3 });
  });
});

describe('supplierCreditNotesOrNone', () => {
  it('gives the notes when the read works, and none (logged) when it fails, so Supplier Bills still loads', async () => {
    const rows = [{ id: 'n1' }] as never;
    expect(await supplierCreditNotesOrNone(async () => rows)).toBe(rows);
    const log = vi.fn();
    const failure = new Error('permission denied');
    expect(
      await supplierCreditNotesOrNone(async () => {
        throw failure;
      }, log),
    ).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('supplier credit notes'), failure);
  });
});

describe('writes', () => {
  it('save and issue call the database functions with the note, kept to the workspace', async () => {
    const saved = fakeFinance({ data: NOTE, error: null });
    expect(await saveSupplierCreditNote(saved.ctx, typed as never)).toEqual({ ok: true, data: { id: NOTE } });
    expect(saved.calls[0]).toMatchObject({ name: 'finance_save_supplier_credit_note', args: { target_org: 'org-1' } });
    const issued = fakeFinance({ data: 'SCN-0001', error: null });
    expect(await issueSupplierCreditNote(issued.ctx, { id: NOTE })).toEqual({ ok: true, data: { id: NOTE, credit_note_no: 'SCN-0001' } });
    expect(issued.calls[0]).toMatchObject({ name: 'finance_issue_supplier_credit_note', args: { target_org: 'org-1', target_note: NOTE } });
  });
  it('void is a change of status, delete removes a draft, and a row that is gone says so', async () => {
    const voided = fakeFinance({ data: { id: NOTE }, error: null });
    await voidSupplierCreditNote(voided.ctx, { id: NOTE });
    expect(voided.calls[0]).toMatchObject({ name: 'finance_supplier_credit_notes', op: 'update', values: { status: 'void' }, filters: { id: NOTE, org_id: 'org-1' } });
    expect(await deleteSupplierCreditNote(fakeFinance({ data: null, error: null }).ctx, { id: NOTE })).toEqual({
      ok: false,
      error: 'That credit note no longer exists.',
    });
  });
  it('applying is one insert; taking off deletes that bill’s row', async () => {
    const applied = fakeFinance({ data: null, error: null });
    expect(await applySupplierCredit(applied.ctx, { credit_note_id: NOTE, bill_id: LATER, amount: 30 })).toMatchObject({ ok: true });
    expect(applied.calls).toHaveLength(1);
    expect(applied.calls[0]).toMatchObject({ op: 'insert', values: { org_id: 'org-1', credit_note_id: NOTE, bill_id: LATER, amount: 30 } });
    const off = fakeFinance({ data: [{ bill_id: LATER }], error: null });
    expect(await unapplySupplierCredit(off.ctx, { credit_note_id: NOTE, bill_id: LATER })).toMatchObject({ ok: true });
    expect(off.calls[0]).toMatchObject({ op: 'delete', filters: { org_id: 'org-1', credit_note_id: NOTE, bill_id: LATER } });
    expect(await unapplySupplierCredit(fakeFinance({ data: [], error: null }).ctx, { credit_note_id: NOTE, bill_id: LATER })).toEqual({
      ok: false,
      error: 'That credit is no longer on this bill.',
    });
  });
  it('words each refusal', async () => {
    const said = async (fn: () => Promise<unknown>) => ((await fn()) as { error?: string }).error;
    const refused = (code: string) => fakeFinance({ data: null, error: { code } }).ctx;
    expect(await said(() => voidSupplierCreditNote(refused('FIN57'), { id: NOTE }))).toBe(
      'Its credit is on a later bill. Take it off that bill first, then void the credit note.',
    );
    expect(await said(() => applySupplierCredit(refused('FIN58'), { credit_note_id: NOTE, bill_id: LATER, amount: 1 }))).toBe(
      'Credit can only go on a bill from the same supplier.',
    );
    expect(await said(() => applySupplierCredit(refused('FIN05'), { credit_note_id: NOTE, bill_id: LATER, amount: 1 }))).toBe(
      'That is more than the credit note has left, or more than the bill still owes.',
    );
    expect(await said(() => applySupplierCredit(refused('23505'), { credit_note_id: NOTE, bill_id: LATER, amount: 1 }))).toBe(
      'Some of this credit is already on that bill. Take it off first, then apply the new amount.',
    );
    expect(await said(() => issueSupplierCreditNote(refused('FIN05'), { id: NOTE }))).toBe('That is more than this bill has left to credit.');
    expect(await said(() => issueSupplierCreditNote(refused('FIN14'), { id: NOTE }))).toMatch(/owner or admin/);
    // The books lock is worded by the shared writeFailed.
    expect(await said(() => issueSupplierCreditNote(refused('FIN63'), { id: NOTE }))).toMatch(/closed period/);
  });
  it('asks a bill and an amount above 0 of an application', () => {
    expect(applySupplierCreditInput.safeParse({ credit_note_id: NOTE, bill_id: '', amount: 1 }).error?.issues[0]?.message).toBe(
      'Choose the bill to put this credit on.',
    );
  });
});
