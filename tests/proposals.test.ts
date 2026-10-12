import { describe, expect, it } from 'vitest';
import { countPendingProposals, listPendingProposals, listRecentlyDecided } from '@/lib/agents/proposals';

type Call = { method: string; args: unknown[] };

/** A chainable fake whose terminal await resolves to { data, count, error: null }. */
function fake({ data = [], count = 0 }: { data?: unknown[]; count?: number } = {}) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'order', 'limit']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => void) => resolve({ data, count, error: null });
  const client = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return chain;
    },
  } as never;
  return { client, calls };
}

const find = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

describe('countPendingProposals', () => {
  it('returns the exact head count of pending rows for the org', async () => {
    const { client, calls } = fake({ count: 3 });
    const n = await countPendingProposals(client, 'org-1');
    expect(n).toBe(3);
    expect(find(calls, 'select')[0].args).toEqual(['id', { count: 'exact', head: true }]);
    expect(find(calls, 'eq')).toEqual([
      { method: 'eq', args: ['org_id', 'org-1'] },
      { method: 'eq', args: ['status', 'pending'] },
    ]);
  });

  it('falls back to 0 when the driver reports no count', async () => {
    const { client } = fake({ count: undefined as unknown as number });
    expect(await countPendingProposals(client, 'org-1')).toBe(0);
  });
});

describe('listRecentlyDecided', () => {
  it('reads non-pending rows, decided first then newest, limited', async () => {
    const rows = [{ id: 'p1', status: 'approved' }];
    const { client, calls } = fake({ data: rows });
    const out = await listRecentlyDecided(client, 'org-1');
    expect(out).toEqual(rows);
    expect(find(calls, 'neq')[0].args).toEqual(['status', 'pending']);
    expect(find(calls, 'order')).toEqual([
      { method: 'order', args: ['decided_at', { ascending: false, nullsFirst: false }] },
      { method: 'order', args: ['created_at', { ascending: false }] },
    ]);
    expect(find(calls, 'limit')[0].args).toEqual([5]);
  });

  it('honors a custom limit', async () => {
    const { client, calls } = fake();
    await listRecentlyDecided(client, 'org-1', 3);
    expect(find(calls, 'limit')[0].args).toEqual([3]);
  });

  it('filters by product when one is given (4th arg), leaving the limit', async () => {
    const { client, calls } = fake();
    await listRecentlyDecided(client, 'org-1', 5, 'reach');
    expect(find(calls, 'eq')).toContainEqual({ method: 'eq', args: ['product', 'reach'] });
    expect(find(calls, 'limit')[0].args).toEqual([5]);
  });
});

describe('listPendingProposals', () => {
  it('reads pending rows for the org, newest first', async () => {
    const rows = [{ id: 'p1', status: 'pending' }];
    const { client, calls } = fake({ data: rows });
    const out = await listPendingProposals(client, 'org-1');
    expect(out).toEqual(rows);
    expect(find(calls, 'eq')).toEqual([
      { method: 'eq', args: ['org_id', 'org-1'] },
      { method: 'eq', args: ['status', 'pending'] },
    ]);
    expect(find(calls, 'order')[0].args).toEqual(['created_at', { ascending: false }]);
  });

  it('filters by product when one is given', async () => {
    const { client, calls } = fake();
    await listPendingProposals(client, 'org-1', 'reach');
    expect(find(calls, 'eq')).toContainEqual({ method: 'eq', args: ['product', 'reach'] });
  });

  it('does not filter by product when none is given', async () => {
    const { client, calls } = fake();
    await listPendingProposals(client, 'org-1');
    expect(find(calls, 'eq').some((c) => c.args[0] === 'product')).toBe(false);
  });
});

describe('countPendingProposals product filter', () => {
  it('filters the count by product when one is given', async () => {
    const { client, calls } = fake({ count: 2 });
    await countPendingProposals(client, 'org-1', 'reach');
    expect(find(calls, 'eq')).toContainEqual({ method: 'eq', args: ['product', 'reach'] });
  });
});
