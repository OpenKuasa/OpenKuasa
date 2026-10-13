import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentVoucherRow } from '@/lib/finance/cash-book';

/**
 * The Payment Vouchers loader: which action each key of the view's `writer` holds, which purchase orders reach the
 * form, and who is given the over-billing notes. The view and the lists are mocked; the loader's own wiring is read.
 */

const actions = vi.hoisted(() => ({
  approveVoucherAction: vi.fn(),
  deleteVoucherAction: vi.fn(),
  markVoucherPaidAction: vi.fn(),
  recordVoucherAction: vi.fn(),
  rejectVoucherAction: vi.fn(),
  saveVoucherAction: vi.fn(),
  submitVoucherAction: vi.fn(),
  voidVoucherAction: vi.fn(),
}));
vi.mock('@/app/(app)/finance/actions', () => actions);

const lists = vi.hoisted(() => ({
  viewer: { orgId: 'org', role: 'owner', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  rows: [] as unknown[],
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => lists.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
// Only the lists are replaced; every other export of these modules is the real one (the form's rules import them).
vi.mock('@/lib/finance/cash-book', async (importOriginal) => ({ ...(await importOriginal<object>()), listPaymentVouchers: async () => lists.rows }));
vi.mock('@/lib/finance/contacts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listContacts: async () => [{ id: 'c1', name: 'Maju', active: true }, { id: 'c2', name: 'Gone', active: false }],
}));
vi.mock('@/lib/finance/expenses', async (importOriginal) => ({ ...(await importOriginal<object>()), listExpenseCategories: async () => [{ id: 'k1', name: 'Utilities' }] }));
vi.mock('@/lib/finance/money', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listAccounts: async () => [{ id: 'a1', name: 'Maybank' }],
  listPaymentsOut: async () => [{ transaction_id: 'v1', bill_id: 'b1', status: 'pending_approval' }],
}));
vi.mock('@/lib/finance/bills', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBills: async () => [{ id: 'b1', bill_no: 'BILL-0001', purchase_order_id: 'po-ok' }],
}));
const order = (id: string, status: string) => ({ id, po_no: id.toUpperCase(), status, total: 100, billed_total: 300, received_total: 0, over_billed: true, billed_over_received: false });
vi.mock('@/lib/finance/purchase-orders', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPurchaseOrders: async () => [order('po-ok', 'approved'), order('po-closed', 'closed'), order('po-cancelled', 'cancelled'), order('po-draft', 'draft')],
}));
// Replace the view with a component that is never rendered: the element's props are what the loader decided.
vi.mock('@/components/finance/payment-vouchers-view', () => ({ PaymentVouchersView: () => null }));

import PaymentVouchersScreen from '@/screens/finance/payment-vouchers';

type Writer = {
  actions: Record<string, unknown>;
  orders: { id: string }[];
  contacts: unknown[];
  orderNotes: Record<string, string[]>;
  bills: unknown[];
  payments: unknown[];
};
const waiting = { kind: 'bill', status: 'pending_approval' } as PaymentVoucherRow;
const load = async (role: string, rows: unknown[] = [waiting], isDemo = false) => {
  lists.viewer = { orgId: 'org', role, isDemo };
  lists.rows = rows;
  const element = (await PaymentVouchersScreen()) as { props: { writer?: Writer } };
  return element.props.writer;
};

beforeEach(() => {
  lists.rows = [];
});

describe('the Payment Vouchers loader', () => {
  it('hands each key of the view the action of that name: Send is submit, never approve', async () => {
    const writer = await load('owner');
    expect(writer?.actions).toEqual({
      record: actions.recordVoucherAction,
      save: actions.saveVoucherAction,
      submit: actions.submitVoucherAction,
      approve: actions.approveVoucherAction,
      reject: actions.rejectVoucherAction,
      markPaid: actions.markVoucherPaidAction,
      remove: actions.deleteVoucherAction,
      voidVoucher: actions.voidVoucherAction,
    });
    expect(writer?.actions.submit).not.toBe(actions.approveVoucherAction);
    // Void is the voucher's own, never a delete.
    expect(writer?.actions.voidVoucher).not.toBe(actions.deleteVoucherAction);
  });

  it('passes the form only the approved and closed purchase orders, and only the active contacts', async () => {
    const writer = await load('member');
    expect(writer?.orders.map((o) => o.id)).toEqual(['po-ok', 'po-closed']);
    expect(writer?.contacts).toEqual([{ id: 'c1', name: 'Maju' }]);
  });

  it('works out the over-billing notes only for someone who may approve, and only while a bill voucher waits', async () => {
    expect(Object.keys((await load('owner'))?.orderNotes ?? {})).toEqual(['v1']);
    expect(Object.keys((await load('admin'))?.orderNotes ?? {})).toEqual(['v1']);
    expect((await load('member'))?.orderNotes).toEqual({});
    expect((await load('owner', [{ kind: 'bill', status: 'draft' }]))?.orderNotes).toEqual({});
    expect((await load('owner', [{ kind: 'expense', status: 'pending_approval' }]))?.orderNotes).toEqual({});
  });

  it('gives a writer the form\'s reads and a viewer or the demo workspace nothing', async () => {
    const member = await load('member');
    expect(member?.bills).toHaveLength(1);
    expect(member?.payments).toHaveLength(1);
    expect(await load('viewer')).toBeUndefined();
    expect(await load('owner', [waiting], true)).toBeUndefined();
  });
});
