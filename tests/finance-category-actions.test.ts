import { beforeEach, describe, expect, it, vi } from 'vitest';

const CATEGORY = '77777777-7777-4777-8777-777777777777';

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

function recorder(fn: string) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: { id: '77777777-7777-4777-8777-777777777777', name: 'Fuel', kind: 'expense', active: true } };
  };
}

vi.mock('@/lib/finance/categories', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/categories')>();
  return {
    ...actual,
    createCategory: recorder('createCategory'),
    renameCategory: recorder('renameCategory'),
    setCategoryActive: recorder('setCategoryActive'),
  };
});

const actions = await import('@/app/(app)/finance/actions');

// Every screen whose forms offer a category or whose rows name one, then the three ledger screens.
const PATHS = [
  '/finance/expenses',
  '/finance/cash-receipts',
  '/finance/supplier-bills',
  '/finance/payment-vouchers',
  '/finance/banking',
  '/finance/receipts-inbox',
  '/finance/chart-of-accounts',
  '/finance/journals',
  '/finance/reports',
];
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const NEEDS = { ok: false, error: 'Only an owner or admin can add or change categories. Ask one of them to do this.' };
const SAVED = { ok: true, data: { id: CATEGORY, name: 'Fuel', kind: 'expense', active: true } };

const as = (role: string, isDemo = false) => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role, isDemo };
};

beforeEach(() => {
  ctl.calls.length = 0;
  ctl.revalidated.length = 0;
  ctl.answers = {};
  as('admin');
});

const each = [
  ['createCategoryAction', { name: 'Fuel', kind: 'expense' }],
  ['renameCategoryAction', { id: CATEGORY, name: 'Petrol' }],
  ['setCategoryActiveAction', { id: CATEGORY, active: false }],
] as const;

describe('who may use the category actions', () => {
  it.each(each)('%s refuses a viewer and the demo workspace before anything is read', async (name, input) => {
    as('viewer');
    expect(await actions[name](input)).toEqual(FORBIDDEN);
    for (const role of ['owner', 'admin', 'member']) {
      as(role, true);
      expect(await actions[name](input)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it.each(each)('%s tells a member who can, before the input is even parsed, and writes and refreshes nothing', async (name, input) => {
    as('member');
    expect(await actions[name](input)).toEqual(NEEDS);
    // Not the schema's sentence: the member is told who can before their input is looked at.
    expect(await actions[name]({ nonsense: true })).toEqual(NEEDS);
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it.each(each)('%s runs for an admin and an owner, in the workspace of the person signed in', async (name, input) => {
    for (const role of ['admin', 'owner']) {
      as(role);
      expect(await actions[name]({ ...input, org_id: 'someone-else' })).toEqual(SAVED);
    }
    expect(ctl.calls).toHaveLength(2);
    expect(ctl.calls.every((c) => c.orgId === 'org1')).toBe(true);
    expect(JSON.stringify(ctl.calls)).not.toContain('someone-else');
  });
});

describe('what the category actions do', () => {
  it('answer a rejected input with the schema’s sentence, without writing or refreshing', async () => {
    expect(await actions.createCategoryAction({ name: ' ', kind: 'expense' })).toEqual({ ok: false, error: 'Enter a name for the category.' });
    expect(await actions.createCategoryAction({ name: 'Fuel', kind: 'asset' })).toEqual({ ok: false, error: 'Choose Expense or Income.' });
    expect(await actions.renameCategoryAction({ id: 'nope', name: 'A' })).toEqual({ ok: false, error: 'That category no longer exists.' });
    expect(await actions.renameCategoryAction({ id: CATEGORY, name: 'x'.repeat(81) })).toEqual({ ok: false, error: 'Keep the name to 80 characters or fewer.' });
    expect(await actions.setCategoryActiveAction({ id: CATEGORY })).toEqual({ ok: false, error: 'Choose whether to archive or restore the category.' });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it.each(each)('%s refreshes every screen that offers or names a category and the three ledger screens, after a refusal too', async (name, input) => {
    await actions[name](input);
    expect(ctl.revalidated).toEqual(PATHS);
    ctl.revalidated.length = 0;
    const refusal = { ok: false, error: 'That category no longer exists.' };
    ctl.answers = { createCategory: refusal, renameCategory: refusal, setCategoryActive: refusal };
    expect(await actions[name](input)).toEqual(refusal);
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('pass on only what each schema keeps: a rename cannot archive, an archive cannot rename, and neither can change the kind', async () => {
    await actions.createCategoryAction({ name: ' Fuel ', kind: 'income', active: false, id: CATEGORY });
    expect(ctl.calls[0]).toEqual({ fn: 'createCategory', orgId: 'org1', input: { name: 'Fuel', kind: 'income' } });
    await actions.renameCategoryAction({ id: CATEGORY, name: ' Petrol ', kind: 'income', active: false });
    expect(ctl.calls[1]).toEqual({ fn: 'renameCategory', orgId: 'org1', input: { id: CATEGORY, name: 'Petrol' } });
    await actions.setCategoryActiveAction({ id: CATEGORY, active: false, name: 'x', kind: 'income' });
    expect(ctl.calls[2]).toEqual({ fn: 'setCategoryActive', orgId: 'org1', input: { id: CATEGORY, active: false } });
  });

  it('there is no action that deletes a category', () => {
    expect(Object.keys(actions).filter((name) => /categor/i.test(name)).sort()).toEqual([
      'createCategoryAction',
      'renameCategoryAction',
      'setCategoryActiveAction',
    ]);
  });
});
