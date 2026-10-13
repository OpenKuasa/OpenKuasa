import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '11111111-1111-4111-8111-111111111111';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const EXPENSE = '55555555-5555-4555-8555-555555555555';
const BILL = '66666666-6666-4666-8666-666666666666';
const CATEGORY = '77777777-7777-4777-8777-777777777777';
const SUPPLIER = '88888888-8888-4888-8888-888888888888';

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: '11111111-1111-4111-8111-111111111111', role: 'member', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  calls: [] as { fn: string; orgId: string; input: unknown }[],
  revalidated: [] as string[],
  answers: {} as Record<string, unknown>,
  /** How many times a client was made for the caller. */
  clients: 0,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clients += 1;
    return { tag: 'caller' };
  },
}));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    throw new Error('matching never uses the service client');
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

function recorder(fn: string, ok: unknown) {
  return async (ctx: { orgId: string }, input: unknown) => {
    ctl.calls.push({ fn, orgId: ctx.orgId, input });
    return ctl.answers[fn] ?? { ok: true, data: ok };
  };
}

vi.mock('@/lib/finance/receipt-match', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/receipt-match')>();
  return {
    ...actual,
    receiptToExpense: recorder('receiptToExpense', { id: '55555555-5555-4555-8555-555555555555', status: 'pending' }),
    receiptToBill: recorder('receiptToBill', { id: '66666666-6666-4666-8666-666666666666' }),
    attachReceipt: recorder('attachReceipt', { id: '44444444-4444-4444-8444-444444444444' }),
    detachReceipt: recorder('detachReceipt', { id: '44444444-4444-4444-8444-444444444444' }),
  };
});

import {
  attachReceiptAction,
  detachReceiptAction,
  receiptToBillAction,
  receiptToExpenseAction,
} from '@/app/(app)/finance/receipt-inbox-actions';
import { EXPENSE_MESSAGES } from '@/lib/finance/expenses';
import { RECEIPT_BILL_PATHS, RECEIPT_EXPENSE_PATHS, RECEIPT_MATCH_MESSAGES as M, RECEIPT_TIE_PATHS } from '@/lib/finance/receipt-match';
import { NOT_ALLOWED } from '@/lib/finance/result';

const expense = { expense_date: '2026-10-03', category_id: CATEGORY, vendor_id: null, vendor_name: 'Shell Bangsar', amount: 142.5, sst_amount: 8.07, notes: '' };
const bill = {
  supplier_id: SUPPLIER,
  supplier_ref: '',
  bill_date: '2026-10-03',
  due_date: '2026-11-02',
  purchase_order_id: '',
  category_id: '',
  notes: '',
  lines: [{ product_id: '', description: 'Receipt', quantity: 1, uom: '', pack_size: '', unit_price: 310, sst_rate: 0 }],
};

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: ORG, role: 'member', isDemo: false };
  ctl.calls = [];
  ctl.revalidated = [];
  ctl.answers = {};
  ctl.clients = 0;
});

type Action = (input: unknown) => Promise<{ ok: boolean; error?: string }>;
const WRITES: [string, Action, unknown, string[], string][] = [
  ['an expense from a receipt', receiptToExpenseAction, { receipt_id: RECEIPT, expense }, RECEIPT_EXPENSE_PATHS, 'receiptToExpense'],
  ['a draft bill from a receipt', receiptToBillAction, { receipt_id: RECEIPT, bill }, RECEIPT_BILL_PATHS, 'receiptToBill'],
  ['attach', attachReceiptAction, { receipt_id: RECEIPT, kind: 'bill', document_id: BILL }, RECEIPT_TIE_PATHS, 'attachReceipt'],
  ['untie', detachReceiptAction, { id: RECEIPT }, RECEIPT_TIE_PATHS, 'detachReceipt'],
];

describe('who may match', () => {
  it.each(WRITES)('%s: an owner, an admin and a member may, in their own workspace, and the right screens refresh', async (_name, action, input, paths, fn) => {
    for (const role of ['owner', 'admin', 'member']) {
      ctl.viewer.role = role;
      expect((await action(input)).ok, role).toBe(true);
    }
    expect(ctl.calls.map((c) => c.fn)).toEqual([fn, fn, fn]);
    expect(ctl.calls.every((c) => c.orgId === ORG)).toBe(true);
    expect(ctl.revalidated).toEqual([...paths, ...paths, ...paths]);
  });

  it.each(WRITES)('%s: a viewer and the demo are refused before a client is made or anything is written', async (_name, action, input) => {
    ctl.viewer.role = 'viewer';
    expect(await action(input)).toEqual({ ok: false, error: NOT_ALLOWED });
    ctl.viewer = { ...ctl.viewer, role: 'owner', isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(ctl.calls).toEqual([]);
    expect(ctl.clients).toBe(0);
    expect(ctl.revalidated).toEqual([]);
  });

  it('untying is not refused to a member here: only the database knows how the document stands, and its answer is passed on', async () => {
    ctl.answers.detachReceipt = { ok: false, error: M.needsDecider };
    expect(await detachReceiptAction({ id: RECEIPT })).toEqual({ ok: false, error: M.needsDecider });
    // Refreshed after a refusal too: the row behind the sentence shows as it now is.
    expect(ctl.revalidated).toEqual(RECEIPT_TIE_PATHS);
  });
});

describe('what is sent on', () => {
  it('a rejected input answers with the schema’s own sentence and reaches no database function', async () => {
    expect(await receiptToExpenseAction({ receipt_id: RECEIPT, expense: { ...expense, amount: Number.NaN } })).toEqual({ ok: false, error: EXPENSE_MESSAGES.amount });
    expect(await receiptToBillAction({ receipt_id: RECEIPT, bill: { ...bill, lines: [] } })).toMatchObject({ ok: false });
    expect(await attachReceiptAction({ receipt_id: RECEIPT })).toEqual({ ok: false, error: M.choose });
    expect(await detachReceiptAction({ id: 'nope' })).toEqual({ ok: false, error: M.gone });
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });

  it('the workspace comes from the session, never from the input', async () => {
    await attachReceiptAction({ receipt_id: RECEIPT, kind: 'expense', document_id: EXPENSE, org_id: 'someone-else', orgId: 'someone-else' });
    expect(ctl.calls[0].orgId).toBe(ORG);
    expect(ctl.calls[0].input).toEqual({ receipt_id: RECEIPT, kind: 'expense', document_id: EXPENSE });
  });

  it('an owner’s expense answers how the database left it', async () => {
    ctl.viewer.role = 'owner';
    ctl.answers.receiptToExpense = { ok: true, data: { id: EXPENSE, status: 'approved' } };
    expect(await receiptToExpenseAction({ receipt_id: RECEIPT, expense })).toEqual({ ok: true, data: { id: EXPENSE, status: 'approved' } });
  });
});

describe('how the code is kept safe', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  it('nothing made from a receipt can be posted: no action, no function and no button does', () => {
    const actions = read('src/app/(app)/finance/receipt-inbox-actions.ts');
    const layer = read('src/lib/finance/receipt-match.ts');
    for (const source of [actions, layer]) {
      expect(source).not.toMatch(/postBill|finance_post_bill|saveThenPost|saveAndPost/);
    }
    const cards = read('src/components/finance/receipt-match-cards.tsx');
    // The bill form from a receipt is draft-only, and the shared card draws no second button for one.
    expect(cards).toMatch(/<BillFormCard\s+initial=\{billFormFromReceipt\([^)]*\)\}\s+draftOnly\s/);
    // The bill card hands the flag on to the shared card: without it the button would be drawn.
    expect(read('src/components/finance/bill-form-card.tsx')).toContain('draftOnly={draftOnly}');
    // And were the button ever pressed, the form's post action answers an error and calls nothing.
    expect(cards).toContain("saveAndPost: async () => ({ ok: false, error: 'A bill made from a receipt is saved as a draft.' })");
    const shared = read('src/components/finance/document-form-card.tsx');
    expect(shared).toContain('{draftOnly ? null : (');
    expect(shared.match(/send\(true\)/g)).toHaveLength(1);
  });

  it('the new components draw text only, open nothing in the page, and use no forbidden colour', () => {
    for (const file of ['src/components/finance/receipt-match-cards.tsx', 'src/components/finance/attached-receipts.tsx']) {
      const source = read(file);
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|<iframe|<embed|<object|<img|window\.open|target="_blank"|href=\{/);
      expect(source, file).not.toMatch(/purple|violet|indigo|fuchsia/);
      expect(source, file).not.toContain('Kuasa');
    }
    // The paperclip downloads through the inbox's own path: a link action and the shared download hook.
    const clip = read('src/components/finance/attached-receipts.tsx');
    expect(clip).toContain('useReceiptDownload(');
    expect(clip).not.toMatch(/createSignedUrl|storage\.from|file_path/);
  });

  it('the data layer stays client-safe and never touches a path or the service client', () => {
    const layer = read('src/lib/finance/receipt-match.ts');
    expect(layer).not.toMatch(/server-only|supabase\/server|supabase\/service|next\/headers|file_path/);
  });
});
