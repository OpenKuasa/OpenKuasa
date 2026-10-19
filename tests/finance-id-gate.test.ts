import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import type { DeletionGate } from '@/lib/ai/hire-deletions';

// The team-mode existence check reads a row through these getters. Mock them so no database is touched and
// each test can say what the getter finds. finance-id-gate.ts only runtime-imports these three functions.
const rows = vi.hoisted(() => ({ rfq: null as unknown, po: null as unknown, journal: null as unknown }));
vi.mock('@/lib/finance/rfqs', () => ({ getRfq: async () => rows.rfq }));
vi.mock('@/lib/finance/purchase-orders', () => ({ getPurchaseOrder: async () => rows.po }));
vi.mock('@/lib/finance/ledger', () => ({ getJournal: async () => rows.journal }));

const { lookedUpFinance, notLookedUpFinance, guardFinanceWrites, makeFinanceIdCheck } = await import(
  '@/lib/ai/finance-id-gate'
);

/** A tool-result message as the SDK writes one, holding a row id a read returned. */
const lookup = (toolName: string, id: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolName, toolCallId: 'c', output: { type: 'json', value: [{ id }] } }] as never,
});

describe('lookedUpFinance / notLookedUpFinance', () => {
  it('passes an id a read of the right kind returned this conversation', () => {
    expect(lookedUpFinance([lookup('listPurchaseOrders', 'po-1')], 'purchase-order', 'po-1')).toBe(true);
  });

  it('refuses an id no read returned, and an id only a read of another kind returned', () => {
    expect(lookedUpFinance([], 'purchase-order', 'po-1')).toBe(false);
    expect(lookedUpFinance([lookup('listRfqs', 'r-1')], 'purchase-order', 'r-1')).toBe(false);
    expect(notLookedUpFinance('purchase-order', 'po-1')).toContain('listPurchaseOrders');
  });

  it('names the right read tool for each kind', () => {
    expect(notLookedUpFinance('rfq', 'r-1')).toContain('listRfqs');
    expect(notLookedUpFinance('journal', 'j-1')).toContain('listJournals');
  });
});

describe('guardFinanceWrites — the single-agent composed gate', () => {
  const gateFor = () => {
    const gated = guardFinanceWrites({ decidePurchaseOrder: 'user-approval' });
    expect(typeof gated?.decidePurchaseOrder).toBe('function');
    return gated!.decidePurchaseOrder as DeletionGate;
  };

  it('denies decidePurchaseOrder when no purchase-order lookup holds the id', async () => {
    const decision = await gateFor()({ id: 'po-1', approve: true }, { toolCallId: 'c', messages: [] });
    expect(decision).toEqual({ type: 'denied', reason: expect.stringContaining('listPurchaseOrders') });
  });

  it('lets decidePurchaseOrder through after a listPurchaseOrders result holds the id', async () => {
    const messages = [lookup('listPurchaseOrders', 'po-1')];
    const decision = await gateFor()({ id: 'po-1', approve: true }, { toolCallId: 'c', messages });
    expect(decision).toBe('user-approval');
  });

  it('leaves undefined when there is nothing to guard', () => {
    expect(guardFinanceWrites(undefined)).toBeUndefined();
  });
});

describe('makeFinanceIdCheck — the team-mode existence check', () => {
  const check = () => makeFinanceIdCheck({ client: {} as never, orgId: 'org1' });

  it('denies a gated action whose row the getter cannot find', async () => {
    rows.po = null;
    expect(await check()('decidePurchaseOrder', 'po-x')).toBe(false);
  });

  it('allows a gated action whose row the getter finds', async () => {
    rows.po = { id: 'po-1' };
    expect(await check()('decidePurchaseOrder', 'po-1')).toBe(true);
  });

  it('allows a pure create (saveRfq with no id)', async () => {
    expect(await check()('saveRfq', undefined)).toBe(true);
  });

  it('denies an act-on-existing with no id (decidePurchaseOrder, no id)', async () => {
    expect(await check()('decidePurchaseOrder', undefined)).toBe(false);
  });

  it('passes an action that is not an id-gated finance write', async () => {
    expect(await check()('listPurchaseOrders', 'anything')).toBe(true);
  });
});
