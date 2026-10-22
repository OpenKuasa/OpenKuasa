import { describe, expect, it, vi } from 'vitest';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { SWAP_REFUSALS, cancelShiftSwap, decideShiftSwap, replyShiftSwap, requestShiftSwap } from '@/lib/people/swap-writes';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';

type Reply = { data: unknown; error: { code?: string; message?: string } | null };
const client = (reply: Reply) => {
  const rpc = vi.fn(async () => reply);
  return { ctx: { client: { rpc } as never, orgId: 'org1' }, rpc };
};
const ok = (status: string) => ({ data: { id: S, status }, error: null });

describe('requestShiftSwap', () => {
  it('sends the two shifts and the trimmed note', async () => {
    const { ctx, rpc } = client(ok('requested'));
    expect(await requestShiftSwap(ctx, { my_shift_id: A, their_shift_id: B, note: '  Dentist  ' })).toEqual({ ok: true, data: { id: S, status: 'requested' } });
    expect(rpc).toHaveBeenCalledWith('hr_request_shift_swap', { p_my_shift: A, p_their_shift: B, p_note: 'Dentist' });
  });

  it('sends a blank or missing note as null', async () => {
    const { ctx, rpc } = client(ok('requested'));
    await requestShiftSwap(ctx, { my_shift_id: A, their_shift_id: B, note: '   ' });
    await requestShiftSwap(ctx, { my_shift_id: A, their_shift_id: B });
    expect(rpc.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { p_my_shift: A, p_their_shift: B, p_note: null },
      { p_my_shift: A, p_their_shift: B, p_note: null },
    ]);
  });

  it.each([
    [{ my_shift_id: 'x', their_shift_id: B }],
    [{ my_shift_id: A, their_shift_id: A }],
    [{ my_shift_id: A, their_shift_id: B, note: 'n'.repeat(501) }],
  ])('refuses %j before calling', async (input) => {
    const { ctx, rpc } = client(ok('requested'));
    expect((await requestShiftSwap(ctx, input as never)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(Object.keys(SWAP_REFUSALS))('turns %s into its sentence', async (code) => {
    const { ctx } = client({ data: null, error: { code: 'P0001', message: code } });
    expect(await requestShiftSwap(ctx, { my_shift_id: A, their_shift_id: B })).toEqual({ ok: false, error: SWAP_REFUSALS[code] });
  });

  it('gives the generic failure for an unknown error and for an odd reply', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = client({ data: null, error: { code: '23505', message: 'duplicate key' } });
    expect(await requestShiftSwap(ctx, { my_shift_id: A, their_shift_id: B })).toEqual({ ok: false, error: WRITE_FAILED });
    const odd = client({ data: { id: S, status: 'maybe' }, error: null });
    expect(await requestShiftSwap(odd.ctx, { my_shift_id: A, their_shift_id: B })).toEqual({ ok: false, error: WRITE_FAILED });
  });
});

describe('the other steps', () => {
  it('reply sends the answer', async () => {
    const { ctx, rpc } = client(ok('accepted'));
    expect(await replyShiftSwap(ctx, { id: S, accept: true })).toEqual({ ok: true, data: { id: S, status: 'accepted' } });
    expect(rpc).toHaveBeenCalledWith('hr_reply_shift_swap', { p_swap: S, p_accept: true });
  });

  it('decide keeps a note on a rejection only', async () => {
    const { ctx, rpc } = client(ok('rejected'));
    await decideShiftSwap(ctx, { id: S, approve: false, note: ' Short that day ' });
    await decideShiftSwap(ctx, { id: S, approve: true, note: 'ignored' });
    expect(rpc.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { p_swap: S, p_approve: false, p_note: 'Short that day' },
      { p_swap: S, p_approve: true, p_note: null },
    ]);
  });

  it('cancel sends the swap', async () => {
    const { ctx, rpc } = client(ok('cancelled'));
    expect(await cancelShiftSwap(ctx, { id: S })).toEqual({ ok: true, data: { id: S, status: 'cancelled' } });
    expect(rpc).toHaveBeenCalledWith('hr_cancel_shift_swap', { p_swap: S });
  });

  it('refuses a bad id or a missing answer before calling', async () => {
    const { ctx, rpc } = client(ok('accepted'));
    expect((await replyShiftSwap(ctx, { id: S } as never)).ok).toBe(false);
    expect((await decideShiftSwap(ctx, { id: 'nope', approve: true } as never)).ok).toBe(false);
    expect((await cancelShiftSwap(ctx, {} as never)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps a changed roster to its sentence', async () => {
    const { ctx } = client({ data: null, error: { message: 'SWAP_SHIFT_CHANGED' } });
    expect(await decideShiftSwap(ctx, { id: S, approve: true, note: null })).toEqual({ ok: false, error: SWAP_REFUSALS.SWAP_SHIFT_CHANGED });
  });
});
