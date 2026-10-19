import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => [
  { id: 'po-1', status: 'pending_approval' },
  { id: 'po-2', status: 'approved' },
]);
const calls = vi.hoisted(() => ({ get: [] as string[] }));

// Hoisted by vitest above the import below, so the mock reaches createBendaharaTools.
vi.mock('@/lib/finance/purchase-orders', () => ({
  listPurchaseOrders: async () => rows,
  getPurchaseOrder: async (_ctx: unknown, id: string) => {
    calls.get.push(id);
    return rows[0];
  },
}));

const { createBendaharaTools } = await import('@/lib/ai/finance-tools');

type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };
const tools = createBendaharaTools({ client: {} as never, orgId: 'org-1', canWrite: false }) as unknown as Record<string, Exec>;
const opts = { toolCallId: 't', messages: [] };

describe('Bendahara purchase-order read tools', () => {
  it('offers both tools, to a read-only user', () => {
    expect(tools.listPurchaseOrders).toBeDefined();
    expect(tools.getPurchaseOrder).toBeDefined();
  });

  it('lists every order, or only those awaiting approval', async () => {
    expect(await tools.listPurchaseOrders.execute({}, opts)).toEqual(rows);
    expect(await tools.listPurchaseOrders.execute({ awaiting_approval: true }, opts)).toEqual([rows[0]]);
    expect(await tools.listPurchaseOrders.execute({ awaiting_approval: false }, opts)).toEqual(rows);
  });

  it('gets one order by id', async () => {
    expect(await tools.getPurchaseOrder.execute({ id: 'po-1' }, opts)).toEqual(rows[0]);
    expect(calls.get).toEqual(['po-1']);
  });
});
