// tests/mcp-transcript.test.ts
import { describe, expect, it } from 'vitest';
import { cardShown, lookedUp, thisTurn } from '@/lib/ai/hire-deletions';
import { lookedUpFinance } from '@/lib/ai/finance-id-gate';
import { lookedUpRoster } from '@/lib/ai/roster-id-gate';
import { memoryTranscriptStore } from '@/lib/mcp/transcript';

const K = 'cred1:user1';

describe('the MCP transcript', () => {
  it('a recorded read lets lookedUp find the id', () => {
    const store = memoryTranscriptStore();
    store.recordCall(K, { toolCallId: 't1', toolName: 'listCandidates', input: {}, output: { total: 1, candidates: [{ id: 'c1', name: 'Aisyah Lim' }] } });
    expect(lookedUp(store.messages(K), 'candidate', 'c1')).toBe(true);
    expect(lookedUp(store.messages(K), 'candidate', 'c2')).toBe(false);
  });

  it('lookedUpFinance and lookedUpRoster see recorded reads', () => {
    const store = memoryTranscriptStore();
    store.recordCall(K, { toolCallId: 't1', toolName: 'listRfqs', input: {}, output: { rfqs: [{ id: 'rfq-1' }] } });
    store.recordCall(K, { toolCallId: 't2', toolName: 'listEmployees', input: {}, output: { employees: [{ id: 'emp-1', name: 'Siti' }] } });
    const messages = store.messages(K);
    expect(lookedUpFinance(messages, 'rfq', 'rfq-1')).toBe(true);
    expect(lookedUpFinance(messages, 'rfq', 'rfq-2')).toBe(false);
    expect(lookedUpRoster(messages, 'employee', 'emp-1')).toBe(true);
    expect(lookedUpRoster(messages, 'employee', 'emp-2')).toBe(false);
  });

  it('endTurn starts a new turn', () => {
    const store = memoryTranscriptStore();
    store.recordCall(K, { toolCallId: 't1', toolName: 'listCandidates', input: {}, output: { candidates: [] } });
    expect(thisTurn(store.messages(K))).toHaveLength(2);
    store.endTurn(K);
    expect(thisTurn(store.messages(K))).toEqual([]);
    store.recordCall(K, { toolCallId: 't2', toolName: 'listCandidates', input: {}, output: { candidates: [] } });
    expect(thisTurn(store.messages(K))).toHaveLength(2);
  });

  it('recordNote is what cardShown reads', () => {
    const store = memoryTranscriptStore();
    store.recordNote(K, { toolCallId: 'd1', toolName: 'deleteCandidate', input: { id: 'c1' }, note: 'This one: a@b.c' });
    expect(cardShown(store.messages(K), 'd1')).toEqual({ note: 'This one: a@b.c' });
    expect(cardShown(store.messages(K), 'other')).toBeNull();
    // once the call has its result, the card is over
    store.recordCall(K, { toolCallId: 'd1', toolName: 'deleteCandidate', input: { id: 'c1' }, output: { ok: true } });
    expect(cardShown(store.messages(K), 'd1')).toBeNull();
  });

  it('expires an hour after last use, and keeps only the last 200 calls', () => {
    let at = 0;
    const store = memoryTranscriptStore({ now: () => at });
    store.recordCall(K, { toolCallId: 't1', toolName: 'listRfqs', input: {}, output: { id: 'x' } });
    at = 3_600_000;
    expect(store.messages(K)).toHaveLength(2); // touched: the hour starts again
    at = 3_600_000 * 2 + 1;
    expect(store.messages(K)).toEqual([]);

    const small = memoryTranscriptStore();
    for (let i = 0; i < 205; i += 1) small.recordCall(K, { toolCallId: `t${i}`, toolName: 'listRfqs', input: {}, output: { id: `id-${i}x` } });
    const messages = small.messages(K);
    expect(messages).toHaveLength(400);
    expect(lookedUpFinance(messages, 'rfq', 'id-4x')).toBe(false);
    expect(lookedUpFinance(messages, 'rfq', 'id-5x')).toBe(true);
  });

  it('keys are separate, and clear forgets one', () => {
    const store = memoryTranscriptStore();
    store.recordCall('A', { toolCallId: 't1', toolName: 'listRfqs', input: {}, output: { id: 'rfq-1' } });
    expect(lookedUpFinance(store.messages('A'), 'rfq', 'rfq-1')).toBe(true);
    expect(lookedUpFinance(store.messages('B'), 'rfq', 'rfq-1')).toBe(false);
    store.clear('A');
    expect(store.messages('A')).toEqual([]);
  });

  it('hands out a copy the caller may change', () => {
    const store = memoryTranscriptStore();
    store.endTurn(K);
    store.recordCall(K, { toolCallId: 't1', toolName: 'listRfqs', input: {}, output: {} });
    const copy = store.messages(K);
    copy.push({ role: 'user', content: 'x' });
    (copy[0] as { content: unknown }).content = 'changed';
    (copy[1].content as { toolName?: string }[])[0].toolName = 'changed';
    expect(store.messages(K)).toHaveLength(3);
    expect(store.messages(K)[0].content).toBe('[next request]');
    expect((store.messages(K)[1].content as { toolName: string }[])[0].toolName).toBe('listRfqs');
  });

  it('sweeps other idle keys when any key is used', () => {
    let at = 0;
    const store = memoryTranscriptStore({ now: () => at });
    store.recordCall('A', { toolCallId: 't1', toolName: 'listRfqs', input: {}, output: {} });
    expect(store.size()).toBe(1);
    at = 3_600_000 + 61_000;
    store.recordCall('B', { toolCallId: 't2', toolName: 'listRfqs', input: {}, output: {} });
    expect(store.size()).toBe(1);
    expect(store.messages('A')).toEqual([]);
    expect(store.messages('B')).toHaveLength(2);
  });
});
