import { beforeEach, describe, expect, it, vi } from 'vitest';

const CONTACT = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';
const CONTRA = '44444444-4444-4444-8444-444444444444';

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

vi.mock('@/lib/finance/contras', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/contras')>();
  return {
    ...actual,
    saveContra: recorder('saveContra', { id: '44444444-4444-4444-8444-444444444444' }),
    postContra: recorder('postContra', { id: '44444444-4444-4444-8444-444444444444', contra_no: 'CT-0001' }),
    voidContra: recorder('voidContra', { id: '44444444-4444-4444-8444-444444444444' }),
    deleteContra: recorder('deleteContra', { id: '44444444-4444-4444-8444-444444444444' }),
  };
});

const actions = await import('@/app/(app)/finance/actions');

const LEDGER = ['/finance/chart-of-accounts', '/finance/journals', '/finance/reports'];
// Posting and voiding move what invoices and bills owe, every form that offers them, the contacts' totals and the
// books. Banking is not among them: no money moves.
const PATHS = [
  '/finance/contra-entries',
  '/finance/invoices',
  '/finance/payments-in',
  '/finance/cash-receipts',
  '/finance/credit-notes',
  '/finance/refunds',
  '/finance/supplier-bills',
  '/finance/payments-out',
  '/finance/payment-vouchers',
  '/finance/customers-suppliers',
  ...LEDGER,
];
// A draft holds nothing and is not in the books.
const DRAFT_PATHS = ['/finance/contra-entries'];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can record, post or void contra entries.' };
const contra = {
  contact_id: CONTACT,
  contra_date: '2026-10-16',
  amount: 70,
  invoices: [{ invoice_id: INVOICE, amount: 70 }],
  bills: [{ bill_id: BILL, amount: 70 }],
};

const as = (role: string, isDemo = false) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo };
};

beforeEach(() => {
  ctl.calls.length = 0;
  ctl.revalidated.length = 0;
  ctl.answers = {};
  as('admin');
});

describe('who may write a contra entry', () => {
  const each = [
    ['saveContraAction', contra],
    ['saveAndPostContraAction', contra],
    ['postContraAction', { id: CONTRA }],
    ['voidContraAction', { id: CONTRA }],
    ['deleteContraAction', { id: CONTRA }],
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
    expect(ctl.calls.length).toBeGreaterThanOrEqual(2);
    expect(ctl.calls.every((c) => c.orgId === 'org1')).toBe(true);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });
});

describe('what the contra entry actions do', () => {
  it('answer a rejected input with the schema’s sentence, without writing or refreshing', async () => {
    expect(await actions.saveContraAction({ ...contra, amount: 0 })).toEqual({
      ok: false,
      error: 'Enter an amount above zero for the contra entry and for each invoice and bill.',
    });
    expect(await actions.saveContraAction({ ...contra, contact_id: 'nope' })).toEqual({
      ok: false,
      error: 'Choose a contact who is both a customer and a supplier.',
    });
    expect(await actions.postContraAction({ id: 'nope' })).toEqual({ ok: false, error: 'That contra entry no longer exists.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('pass on only what the schema keeps', async () => {
    await actions.saveContraAction({ ...contra, reference: ' Agreed ', status: 'posted', contra_no: 'CT-9' });
    expect(ctl.calls[0]).toEqual({
      fn: 'saveContra',
      orgId: 'org1',
      input: { ...contra, reference: 'Agreed', notes: null },
    });
    await actions.voidContraAction({ id: CONTRA, contra_no: 'CT-1' });
    expect(ctl.calls[1]).toEqual({ fn: 'voidContra', orgId: 'org1', input: { id: CONTRA } });
  });

  it('refresh only Contra Entries after saving or deleting a draft', async () => {
    await actions.saveContraAction(contra);
    expect(ctl.revalidated).toEqual(DRAFT_PATHS);
    ctl.revalidated.length = 0;
    await actions.deleteContraAction({ id: CONTRA });
    expect(ctl.revalidated).toEqual(DRAFT_PATHS);
  });

  it('refresh every screen that shows what is owed, and the books, after posting or voiding, a refusal too', async () => {
    expect(await actions.postContraAction({ id: CONTRA })).toEqual({ ok: true, data: { id: CONTRA, contra_no: 'CT-0001' } });
    expect(ctl.revalidated).toEqual(PATHS);
    expect(ctl.revalidated).not.toContain('/finance/banking');
    ctl.revalidated.length = 0;
    const refusal = { ok: false, error: 'Refunds paid on one of its invoices depend on this contra entry, so it cannot be voided.' };
    ctl.answers.voidContra = refusal;
    expect(await actions.voidContraAction({ id: CONTRA })).toEqual(refusal);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('save and post: saves, then posts the draft it saved', async () => {
    expect(await actions.saveAndPostContraAction(contra)).toEqual({ ok: true, data: { id: CONTRA, contra_no: 'CT-0001' } });
    expect(ctl.calls.map((c) => c.fn)).toEqual(['saveContra', 'postContra']);
    expect(ctl.calls[1].input).toEqual({ id: CONTRA });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('save and post: a refused post keeps the draft and says which it is', async () => {
    ctl.answers.postContra = { ok: false, error: 'One of the invoices or bills is no longer posted. Reload the page and choose again.' };
    expect(await actions.saveAndPostContraAction(contra)).toEqual({
      ok: false,
      error: 'One of the invoices or bills is no longer posted. Reload the page and choose again.',
      draftId: CONTRA,
    });
  });
});
