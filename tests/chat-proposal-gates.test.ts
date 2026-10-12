import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { guardDeletions, ONE_DELETION, type DeletionGate } from '@/lib/ai/hire-deletions';
import { guardPoolChanges, HIRE_POOL_TOOL_NAMES, ONE_POOL_CHANGE } from '@/lib/ai/hire-pool-gate';
import { HIRE_WRITE_TOOL_NAMES, approvalBinding, bindApprovals, combineToolkits, hireProduct } from '@/lib/ai/products';
import { NOT_PREPARED, memoryProposalStore, noProposalStore, type ProposalStore } from '@/lib/chat/proposal-store';
import { createSeedHireData } from '@/lib/hire/seed';

/**
 * An agent that holds the hiring tools itself has two gates in front of a card
 * (deletions, talent pool changes) and then the record of what was proposed.
 * Both gates run first, in the order they always did; only a call they let
 * through is recorded, and one that cannot be recorded gets no card.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

const lookedUp: ModelMessage[] = [
  { role: 'user', content: 'Mark Aina as passive' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'listCandidates', input: {} }] },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'l1', toolName: 'listCandidates', output: { type: 'json', value: [{ id: A, name: 'Aina Rahman' }, { id: B, name: 'Badrul Hisham' }] } },
      { type: 'tool-result', toolCallId: 'l2', toolName: 'listJobs', output: { type: 'json', value: [{ id: JOB, name: 'Barista', title: 'Barista' }] } },
    ],
  } as ModelMessage,
];

/** The approval map exactly as the agents build it: deletions, then the pool, then the record. */
function gates(store: ProposalStore, messages: ModelMessage[]) {
  const product = hireProduct({ data: createSeedHireData(), write: { ctx: { client: {} as never, orgId: 'org1' }, canWrite: true } });
  const kit = combineToolkits([product]);
  const toolApproval = guardPoolChanges(guardDeletions(kit.toolApproval), undefined);
  const bound = bindApprovals({ tools: kit.tools, toolApproval }, [product], approvalBinding(store, messages));
  const ask = (tool: string, input: unknown, toolCallId: string) =>
    (bound.toolApproval![tool] as DeletionGate)(input, { toolCallId, messages });
  return { ask, tools: bound.tools, product };
}

describe('the talent pool tools are change tools like any other', () => {
  it('are in the hiring list, so every agent binds them to the record', () => {
    for (const name of HIRE_POOL_TOOL_NAMES) expect(HIRE_WRITE_TOOL_NAMES).toContain(name);
    const { tools, product } = gates(memoryProposalStore(), lookedUp);
    for (const name of HIRE_POOL_TOOL_NAMES) {
      expect(Object.keys(product.write)).toContain(name);
      // The bound tool, not the product's own: it runs only from a record.
      expect(tools[name]).not.toBe(product.write[name]);
    }
  });

  it('a pool change nobody looked up is refused by its gate and never recorded', async () => {
    const store = memoryProposalStore();
    const { ask } = gates(store, [{ role: 'user', content: 'Mark someone as passive' }]);
    const decision = await ask('setPoolStatus', { id: A, status: 'passive' }, 'c1');
    expect(decision).toMatchObject({ type: 'denied' });
    expect((decision as { reason: string }).reason).toMatch(/^You have not looked up /);
    expect(store.rows).toEqual([]);
  });

  it('the first pool change of a request is recorded and shown; a second is refused and not recorded', async () => {
    const store = memoryProposalStore();
    const { ask } = gates(store, lookedUp);
    expect(await ask('setPoolStatus', { id: A, status: 'passive' }, 'c1')).toBe('user-approval');
    expect(await ask('moveToPipeline', { id: B, job_id: JOB }, 'c2')).toEqual({ type: 'denied', reason: ONE_POOL_CHANGE });
    expect(store.rows.map((r) => [r.toolCallId, r.product, r.action, r.input])).toEqual([
      ['c1', 'hire', 'setPoolStatus', { id: A, status: 'passive' }],
    ]);
  });

  it('a deletion is held to its own rule beside a pool change, and both are recorded once let through', async () => {
    const store = memoryProposalStore();
    const { ask } = gates(store, lookedUp);
    expect(await ask('deleteCandidate', { id: A }, 'd1')).toBe('user-approval');
    // Counted apart: a pool change in the same request is still the pool's first.
    expect(await ask('setPoolStatus', { id: B, status: 'passive' }, 'c1')).toBe('user-approval');
    expect(await ask('deleteCandidate', { id: B }, 'd2')).toEqual({ type: 'denied', reason: ONE_DELETION });
    expect(store.rows.map((r) => r.action)).toEqual(['deleteCandidate', 'setPoolStatus']);
  });

  it('a pool change or a deletion that cannot be recorded gets no card', async () => {
    const { ask } = gates(noProposalStore, lookedUp);
    expect(await ask('setPoolStatus', { id: A, status: 'passive' }, 'c1')).toEqual({ type: 'denied', reason: NOT_PREPARED });
    expect(await ask('deleteCandidate', { id: A }, 'd1')).toEqual({ type: 'denied', reason: NOT_PREPARED });
  });

  it('a pool change runs only from its record, with the arguments that were kept', async () => {
    const store = memoryProposalStore();
    const { tools } = gates(store, lookedUp);
    const run = (tools.setPoolStatus as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
    // Never proposed here: nothing runs.
    expect(await run({ id: A, status: 'passive' }, { toolCallId: 'c1', messages: [] })).toMatchObject({ ok: false });
    expect(store.rows).toEqual([]);
    // Proposed for A; the answer comes back naming B: nothing runs, and A's is still waiting.
    await store.record({ toolCallId: 'c1', product: 'hire', action: 'setPoolStatus', input: { id: A, status: 'passive' } });
    expect(await run({ id: B, status: 'passive' }, { toolCallId: 'c1', messages: [] })).toMatchObject({ ok: false });
    expect(store.rows[0].status).toBe('pending');
  });
});
