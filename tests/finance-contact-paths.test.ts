import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';

const ctl = vi.hoisted(() => ({ revalidated: [] as string[] }));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ userId: 'u1', orgId: 'org1', role: 'member', isDemo: false }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));
vi.mock('@/lib/finance/contacts', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/contacts')>();
  const done = async () => ({ ok: true, data: { id: '11111111-1111-4111-8111-111111111111' } });
  return { ...actual, createContact: done, updateContact: done, setContactActive: done, deleteContact: done };
});

const actions = await import('@/app/(app)/finance/actions');

beforeEach(() => {
  ctl.revalidated = [];
});

describe('a change to a contact', () => {
  const writes: [string, (input: unknown) => Promise<unknown>, unknown][] = [
    ['createContactAction', actions.createContactAction, { name: 'Aisyah Trading', is_customer: true, is_supplier: false }],
    ['updateContactAction', actions.updateContactAction, { id: ID, name: 'Aisyah Trading Sdn Bhd' }],
    ['setContactActiveAction', actions.setContactActiveAction, { id: ID, active: false }],
    ['deleteContactAction', actions.deleteContactAction, { id: ID }],
  ];

  it('refreshes every screen that shows a contact’s name, the five sales screens included', async () => {
    for (const [name, action, input] of writes) {
      ctl.revalidated = [];
      expect(await action(input), name).toMatchObject({ ok: true });
      expect(ctl.revalidated, name).toEqual([
        '/finance/customers-suppliers',
        '/finance/supplier-bills',
        '/finance/payments-out',
        '/finance/invoices',
        '/finance/payments-in',
        '/finance/quotations',
        '/finance/credit-notes',
        '/finance/refunds',
        // The payer on a receipt, the payee on a voucher and the vendor on an expense.
        '/finance/cash-receipts',
        '/finance/payment-vouchers',
        '/finance/expenses',
        '/finance/banking',
      ]);
    }
  });
});
