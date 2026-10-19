import { describe, expect, it, vi } from 'vitest';
import { tool, type ModelMessage, type Tool } from 'ai';
import { z } from 'zod';
import { CHANGE_NOT_CHECKED, type DeletionGate } from '@/lib/ai/hire-deletions';
import { APPLY_TOOL, type Proposal } from '@/lib/chat/delegation';
import { memoryProposalStore } from '@/lib/chat/proposal-store';
import { createTeamTools } from '@/lib/ai/agents/specialists';
import type { ProductToolkit } from '@/lib/ai/products';

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

/* ---- team mode (createTeamTools / applyGate / apply) ------------------------------------------------ */

/** A stub finance write tool: a permissive schema, so `apply`'s parse never gets in the way of these tests. */
const financeWrite = () =>
  tool({
    description: 'stub finance write',
    inputSchema: z.record(z.string(), z.unknown()),
    execute: async () => ({ ok: true as const }),
  }) as Tool;

/** A minimal finance toolkit: a real `financeProduct` would pull the whole finance-tools graph; this is the seam. */
const financeKit = (withCheck: boolean, write: Record<string, Tool> = { decidePurchaseOrder: financeWrite() }): ProductToolkit => ({
  key: 'finance',
  name: 'Bendahara',
  read: {},
  write,
  ...(withCheck ? { checkFinanceId: makeFinanceIdCheck({ client: {} as never, orgId: 'org1' }) } : {}),
});

const teamCtx = (proposals = new Map<string, Proposal>(), store = memoryProposalStore()) => ({
  transcript: '',
  proposals,
  store,
  names: {},
});

/** Calls a tool's `execute` directly (its typed options demand a `context` the real run supplies; not needed here). */
const execTool = (t: Tool, input: unknown) =>
  (t as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'c',
    messages: [],
  });

describe('team mode: createTeamTools installs the finance apply gate', () => {
  it('makes applyChange a gate (not a plain card) when a product has checkFinanceId', () => {
    const { toolApproval } = createTeamTools([financeKit(true)], teamCtx());
    // Load-bearing: removing `|| products.some(p => p.checkFinanceId)` would make this the literal 'user-approval'.
    expect(typeof toolApproval?.[APPLY_TOOL]).toBe('function');
  });

  it('keeps applyChange a plain card when nothing gates an id or a limited kind', () => {
    const { toolApproval } = createTeamTools([financeKit(false)], teamCtx());
    expect(toolApproval?.[APPLY_TOOL]).toBe('user-approval');
  });
});

describe('team mode: the apply gate checks the finance row exists before a card', () => {
  const decide = async (poRow: unknown, inputId: string) => {
    rows.po = poRow;
    const pid = 'p-live';
    const proposals = new Map<string, Proposal>([
      [pid, { id: pid, product: 'finance', action: 'decidePurchaseOrder', input: { id: inputId }, title: 't', detail: null }],
    ]);
    const { toolApproval } = createTeamTools([financeKit(true)], teamCtx(proposals));
    const gate = toolApproval![APPLY_TOOL] as DeletionGate;
    return gate({ proposalId: pid }, { toolCallId: 'c', messages: [] });
  };

  it('denies a live finance proposal whose row the getter cannot find', async () => {
    expect(await decide(null, 'po-x')).toEqual({ type: 'denied', reason: expect.stringContaining('does not exist') });
  });

  it('lets a live finance proposal through to the card when the row exists', async () => {
    expect(await decide({ id: 'po-1' }, 'po-1')).toBe('user-approval');
  });
});

describe('team mode: apply refuses a gated finance write the gate never saw (Finding 1)', () => {
  it('returns CHANGE_NOT_CHECKED for a gated finance action absent from team.proposals', async () => {
    const store = memoryProposalStore();
    await store.record({ id: 'p-fallback', product: 'finance', action: 'decidePurchaseOrder', input: { id: 'po-x' } });
    // team.proposals is empty, so applyGate never saw this record and never ran the id check.
    const { tools } = createTeamTools([financeKit(true)], teamCtx(new Map(), store));
    const result = await execTool(tools[APPLY_TOOL] as Tool, { proposalId: 'p-fallback' });
    expect(result).toEqual({ ok: false, error: CHANGE_NOT_CHECKED });
  });

  it('lets a pure-create finance save through the fallback (no row to check)', async () => {
    const store = memoryProposalStore();
    await store.record({ id: 'p-create', product: 'finance', action: 'saveRfq', input: { supplier_id: 's1' } });
    const kit = financeKit(true, { saveRfq: financeWrite() });
    const { tools } = createTeamTools([kit], teamCtx(new Map(), store));
    const result = await execTool(tools[APPLY_TOOL] as Tool, { proposalId: 'p-create' });
    expect(result).toEqual({ ok: true });
  });
});
