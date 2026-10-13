import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSFER_MESSAGES, recordTransfer, recordTransferInput, voidTransfer, voidTransferInput } from '@/lib/finance/transfers';
import { type FinanceCall, fakeFinance } from './setup/fake-finance';

const M = TRANSFER_MESSAGES;
const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '22222222-2222-4222-8222-222222222222';
const TRANSFER = '33333333-3333-4333-8333-333333333333';
const valid = { from_account_id: FROM, to_account_id: TO, amount: 500, txn_date: '2026-10-05' };

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { logged.mockRestore(); });

const first = (value: unknown) => recordTransferInput.safeParse(value).error?.issues[0]?.message;

describe('recordTransferInput', () => {
  it('asks for two accounts, and for two different ones', () => {
    expect(first({ ...valid, from_account_id: '' })).toBe(M.from);
    expect(first({ ...valid, from_account_id: undefined })).toBe(M.from);
    expect(first({ ...valid, to_account_id: 'nope' })).toBe(M.to);
    expect(first({ ...valid, to_account_id: FROM })).toBe('Choose two different accounts.');
  });
  it('asks for an amount above 0 that is a number and fits, and a real date', () => {
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.004, '500', null, 1e13]) {
      expect(first({ ...valid, amount }), String(amount)).toBe('Enter an amount above 0.');
    }
    expect(first({ ...valid, txn_date: '5 Oct' })).toBe('Enter a valid date.');
    expect(first({ ...valid, txn_date: '2026-02-30' })).toBe('Enter a valid date.');
  });
  it('rounds to the sen, keeps a reference and notes, and stores an empty one as nothing', () => {
    expect(recordTransferInput.parse({ ...valid, amount: 32.506, reference: ' TT-9 ', notes: ' ' })).toEqual({
      from_account_id: FROM, to_account_id: TO, amount: 32.51, txn_date: '2026-10-05', reference: 'TT-9', notes: null,
    });
    expect(recordTransferInput.parse(valid)).toMatchObject({ reference: null, notes: null });
    expect(first({ ...valid, notes: 'x'.repeat(201) })).toBe('That is too long. Keep it to 200 characters or fewer.');
  });
  it('keeps nothing it was not asked for', () => {
    const parsed = recordTransferInput.parse({ ...valid, org_id: 'someone-else', number: 'TR-1', status: 'draft', method: 'cash' });
    expect(Object.keys(parsed).sort()).toEqual(['amount', 'from_account_id', 'notes', 'reference', 'to_account_id', 'txn_date']);
  });
});

describe('voidTransferInput', () => {
  it('takes the id the two sides share, and says the transfer is gone for anything else', () => {
    expect(voidTransferInput.parse({ transfer_id: TRANSFER, id: 'x' })).toEqual({ transfer_id: TRANSFER });
    for (const bad of [{ transfer_id: 'nope' }, {}, null, { id: TRANSFER }]) {
      expect(voidTransferInput.safeParse(bad).error?.issues[0]?.message).toBe('That transfer no longer exists.');
    }
  });
});

/** Answers the database function with `rpc` and the read of the number with `read`. */
const answering = (rpc: { data: unknown; error: unknown }, read: { data: unknown; error: unknown } = { data: [{ number: 'TR-0005' }], error: null }) =>
  fakeFinance((call: FinanceCall) => (call.op === 'rpc' ? rpc : read));

describe('recordTransfer', () => {
  it('calls the one function that writes both sides, in the caller’s workspace, then reads the number', async () => {
    const { ctx, calls } = answering({ data: TRANSFER, error: null });
    expect(await recordTransfer(ctx, { ...valid, reference: 'TT-9' })).toEqual({ ok: true, data: { transfer_id: TRANSFER, number: 'TR-0005' } });
    expect(calls.map((c) => [c.name, c.op])).toEqual([['finance_record_transfer', 'rpc'], ['finance_transactions', 'select']]);
    expect(calls[0].args).toEqual({
      target_org: 'org-1',
      transfer: { from_account_id: FROM, to_account_id: TO, amount: 500, txn_date: '2026-10-05', reference: 'TT-9', notes: null },
    });
    expect(calls[1]).toMatchObject({ columns: 'number', filters: { org_id: 'org-1', transfer_id: TRANSFER }, limit: 1 });
  });
  it('is still a success when the number cannot be read back: the transfer stands', async () => {
    const failed = answering({ data: TRANSFER, error: null }, { data: null, error: { code: 'XX000' } });
    expect(await recordTransfer(failed.ctx, valid)).toEqual({ ok: true, data: { transfer_id: TRANSFER, number: null } });
    const none = answering({ data: TRANSFER, error: null }, { data: [], error: null });
    expect(await recordTransfer(none.ctx, valid)).toEqual({ ok: true, data: { transfer_id: TRANSFER, number: null } });
  });
  it('words each refusal, and reads nothing after one', async () => {
    const cases: [string, string][] = [
      ['FIN16', 'One of those accounts has been archived or no longer exists. Choose another, then try again.'],
      ['FIN37', 'One of those accounts has been archived or no longer exists. Choose another, then try again.'],
      ['FIN14', 'Only an owner or admin can record or void a transfer between accounts. Ask one of them to do this.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['22003', 'That amount is too large.'],
      ['XX000', 'That change could not be saved. Please try again.'],
    ];
    for (const [code, sentence] of cases) {
      const { ctx, calls } = answering({ data: null, error: { code } });
      expect(await recordTransfer(ctx, valid), code).toEqual({ ok: false, error: sentence });
      expect(calls).toHaveLength(1);
    }
    const { ctx } = answering({ data: null, error: null });
    expect(await recordTransfer(ctx, valid)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });
  it('throws on an input its schema refuses, before anything is sent', async () => {
    const { ctx, calls } = answering({ data: TRANSFER, error: null });
    await expect(recordTransfer(ctx, { ...valid, to_account_id: FROM })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('voidTransfer', () => {
  it('calls the one function that voids both sides', async () => {
    const { ctx, calls } = answering({ data: null, error: null });
    expect(await voidTransfer(ctx, { transfer_id: TRANSFER })).toEqual({ ok: true, data: { transfer_id: TRANSFER } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'finance_void_transfer', args: { target_org: 'org-1', target_transfer: TRANSFER } });
  });
  it('words each refusal', async () => {
    const cases: [string, string][] = [
      ['FIN09', 'This transfer has already been voided.'],
      ['FIN11', 'That transfer no longer exists.'],
      ['FIN14', 'Only an owner or admin can record or void a transfer between accounts. Ask one of them to do this.'],
      ['42501', 'You do not have permission to make changes here.'],
      ['XX000', 'That change could not be saved. Please try again.'],
    ];
    for (const [code, sentence] of cases) {
      const { ctx } = answering({ data: null, error: { code } });
      expect(await voidTransfer(ctx, { transfer_id: TRANSFER }), code).toEqual({ ok: false, error: sentence });
    }
  });
});
