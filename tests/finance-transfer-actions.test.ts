import { beforeEach, describe, expect, it, vi } from 'vitest';

const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '22222222-2222-4222-8222-222222222222';
const TRANSFER = '33333333-3333-4333-8333-333333333333';

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'admin', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  /** Every data-layer call, in order: the function, the workspace it was given, and its input. */
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  /** What each data-layer function answers; a function with no entry succeeds. */
  answers: {} as Record<string, unknown>,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

function recorder(fn: string, data: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data };
  };
}

vi.mock('@/lib/finance/transfers', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/transfers')>();
  return {
    ...actual,
    recordTransfer: recorder('recordTransfer', { transfer_id: '33333333-3333-4333-8333-333333333333', number: 'TR-0005' }),
    voidTransfer: recorder('voidTransfer', { transfer_id: '33333333-3333-4333-8333-333333333333' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

// Banking, and the three ledger screens: a transfer is an entry in the books. Nothing else lists one.
const PATHS = ['/finance/banking', '/finance/chart-of-accounts', '/finance/journals', '/finance/reports'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can record or void a transfer between accounts. Ask one of them to do this.' };
const transfer = { from_account_id: FROM, to_account_id: TO, amount: 500, txn_date: '2026-10-05' };

const as = (role: string, isDemo = false) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo };
};

beforeEach(() => {
  ctl.calls.length = 0;
  ctl.revalidated.length = 0;
  ctl.answers = {};
  as('admin');
});

describe('who may record and void a transfer', () => {
  const each = [
    ['recordTransferAction', transfer],
    ['voidTransferAction', { transfer_id: TRANSFER }],
  ] as const;

  it.each(each)('%s refuses a viewer and the demo workspace before anything is read', async (name, input) => {
    as('viewer');
    expect(await actions[name](input)).toEqual(FORBIDDEN);
    as('owner', true);
    expect(await actions[name](input)).toEqual(FORBIDDEN);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it.each(each)('%s tells a member who can, before anything is read or written, even for an input that is not valid', async (name, input) => {
    as('member');
    expect(await actions[name](input)).toEqual(NEEDS);
    expect(await actions[name]({})).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it.each(each)('%s runs for an admin and an owner, in the workspace of the person signed in', async (name, input) => {
    for (const role of ['admin', 'owner']) {
      as(role);
      expect(await actions[name]({ ...input, org_id: 'someone-else' })).toMatchObject({ ok: true });
    }
    expect(ctl.calls).toHaveLength(2);
    expect(ctl.calls.every((c) => c.orgId === 'org1')).toBe(true);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });
});

describe('what the transfer actions do', () => {
  it('answer a rejected input with the schema’s sentence, without writing or refreshing', async () => {
    expect(await actions.recordTransferAction({ ...transfer, to_account_id: FROM })).toEqual({ ok: false, error: 'Choose two different accounts.' });
    expect(await actions.recordTransferAction({ ...transfer, amount: 0 })).toEqual({ ok: false, error: 'Enter an amount above 0.' });
    expect(await actions.voidTransferAction({ transfer_id: 'nope' })).toEqual({ ok: false, error: 'That transfer no longer exists.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('pass on only what the schema keeps', async () => {
    await actions.recordTransferAction({ ...transfer, amount: 32.506, reference: ' TT-9 ', status: 'draft', number: 'TR-1' });
    expect(ctl.calls[0]).toEqual({
      fn: 'recordTransfer',
      orgId: 'org1',
      input: { from_account_id: FROM, to_account_id: TO, amount: 32.51, txn_date: '2026-10-05', reference: 'TT-9', notes: null },
    });
    await actions.voidTransferAction({ transfer_id: TRANSFER, number: 'TR-1' });
    expect(ctl.calls[1]).toEqual({ fn: 'voidTransfer', orgId: 'org1', input: { transfer_id: TRANSFER } });
  });

  it('refresh Banking and the three ledger screens, after a refusal too', async () => {
    expect(await actions.recordTransferAction(transfer)).toEqual({ ok: true, data: { transfer_id: TRANSFER, number: 'TR-0005' } });
    expect(ctl.revalidated).toEqual(PATHS);
    ctl.revalidated.length = 0;
    const refusal = { ok: false, error: 'This transfer has already been voided.' };
    ctl.answers.voidTransfer = refusal;
    expect(await actions.voidTransferAction({ transfer_id: TRANSFER })).toEqual(refusal);
    expect(ctl.revalidated).toEqual(PATHS);
  });
});
