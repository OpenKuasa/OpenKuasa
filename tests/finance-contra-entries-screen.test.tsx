import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Contra Entries loader: which action each key of the view's `writer` holds, who is given a writer at all, who
 * is told who records contra entries, and that the form's reads are made only for someone who can record one. The
 * view and the lists are mocked; the loader's own wiring is read.
 */

const actions = vi.hoisted(() => ({
  deleteContraAction: vi.fn(),
  postContraAction: vi.fn(),
  saveAndPostContraAction: vi.fn(),
  saveContraAction: vi.fn(),
  voidContraAction: vi.fn(),
}));
vi.mock('@/app/(app)/finance/actions', () => actions);

const LIM = '11111111-1111-4111-8111-111111111111';

const { lists, reading } = vi.hoisted(() => {
  const lists = {
    viewer: { orgId: 'org', role: 'owner', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
    /** Which list reads were made, by name. */
    reads: [] as string[],
  };
  const reading = <T,>(name: string, rows: T) => async () => {
    lists.reads.push(name);
    return rows;
  };
  return { lists, reading };
});
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => lists.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
// Only the lists are replaced; every other export of these modules is the real one (the form's rules import them).
vi.mock('@/lib/finance/contras', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listContras: reading('listContras', []),
}));
vi.mock('@/lib/finance/contacts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listContacts: reading('listContacts', [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Lim Hardware', is_customer: true, is_supplier: true, active: true },
  ]),
}));
vi.mock('@/lib/finance/invoices', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listInvoices: reading('listInvoices', [
    { id: 'i1', invoice_no: 'INV-0001', customer_id: '11111111-1111-4111-8111-111111111111', customer_name: 'Lim Hardware', due_date: '2026-10-31', balance: 100, display_status: 'sent', currency: 'MYR' },
  ]),
}));
vi.mock('@/lib/finance/bills', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBills: reading('listBills', [
    { id: 'b1', bill_no: 'BILL-0001', supplier_id: '11111111-1111-4111-8111-111111111111', supplier_name: 'Lim Hardware', purchase_order_id: null, due_date: '2026-10-31', balance: 80, display_status: 'pending', currency: 'MYR' },
  ]),
}));
vi.mock('@/lib/finance/money', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPaymentsIn: reading('listPaymentsIn', []),
  listPaymentsOut: reading('listPaymentsOut', [{ transaction_id: 'p1', bill_id: 'b1', status: 'scheduled', amount: 30 }]),
}));
// Replace the view with a component that is never rendered: the element's props are what the loader decided.
vi.mock('@/components/finance/contras-view', () => ({ ContrasView: () => null }));

import ContraEntriesScreen from '@/screens/finance/contra-entries';

type Props = {
  writer?: { actions: Record<string, unknown>; parties: { id: string; invoices: { payable: number }[]; bills: { payable: number }[] }[] };
  memberNote?: boolean;
};
const load = async (role: string, isDemo = false) => {
  lists.viewer = { orgId: 'org', role, isDemo };
  lists.reads.length = 0;
  const element = (await ContraEntriesScreen()) as { props: Props };
  return element.props;
};

beforeEach(() => {
  lists.reads.length = 0;
});

describe('the Contra Entries loader', () => {
  it('hands each key of the view the action of that name', async () => {
    const { writer } = await load('owner');
    expect(writer?.actions).toEqual({
      save: actions.saveContraAction,
      saveAndPost: actions.saveAndPostContraAction,
      post: actions.postContraAction,
      voidContra: actions.voidContraAction,
      remove: actions.deleteContraAction,
    });
  });

  it('gives an owner and an admin the writer, with what the form can set off after payments not yet paid', async () => {
    for (const role of ['owner', 'admin']) {
      const props = await load(role);
      expect(props.writer?.parties.map((p) => [p.id, p.invoices[0].payable, p.bills[0].payable])).toEqual([[LIM, 100, 50]]);
      expect(props.memberNote).toBe(false);
      expect(lists.reads.sort()).toEqual(['listBills', 'listContacts', 'listContras', 'listInvoices', 'listPaymentsIn', 'listPaymentsOut']);
    }
  });

  it('gives a member no writer, tells them who records contra entries, and reads only the list', async () => {
    const props = await load('member');
    expect(props.writer).toBeUndefined();
    expect(props.memberNote).toBe(true);
    expect(lists.reads).toEqual(['listContras']);
  });

  it('gives a viewer and the demo workspace’s owner no writer and no note, and reads only the list', async () => {
    for (const [role, isDemo] of [['viewer', false], ['owner', true]] as const) {
      const props = await load(role, isDemo);
      expect(props.writer).toBeUndefined();
      expect(props.memberNote).toBe(false);
      expect(lists.reads).toEqual(['listContras']);
    }
  });
});
