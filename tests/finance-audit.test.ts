import { describe, expect, it } from 'vitest';
import {
  buildAuditSummary,
  listFinanceAudit,
  parseAuditFilters,
  readAuditSummaryRows,
  type AuditFilters,
} from '@/lib/finance/audit';
import type { FinanceWriteContext } from '@/lib/finance/result';

describe('parseAuditFilters', () => {
  it('defaults everything', () => {
    expect(parseAuditFilters({})).toEqual({ type: null, actor: null, period: '30d', q: '', before: null });
  });

  it('falls back on each field on its own', () => {
    const f = parseAuditFilters({ type: 'finance_bogus', period: ['7d', '90d'], actor: 'Aisyah', q: '  inv  ' });
    expect(f.type).toBeNull();
    expect(f.period).toBe('30d');
    expect(f.actor).toBe('Aisyah');
    expect(f.q).toBe('inv');
  });

  it('keeps good values and caps q at 100 characters', () => {
    const f = parseAuditFilters({ type: 'finance_invoice', period: 'all', q: 'x'.repeat(150), before: '2026-10-22T10:00:00.123456+00:00~0b9c1f0e-1111-4222-8333-444455556666' });
    expect(f.type).toBe('finance_invoice');
    expect(f.period).toBe('all');
    expect(f.q).toHaveLength(100);
    expect(f.before).toBe('2026-10-22T10:00:00.123456+00:00~0b9c1f0e-1111-4222-8333-444455556666');
  });

  it('accepts a cursor only as <timestamp>~<uuid>', () => {
    const ok = '2026-10-22T10:00:00.123456+00:00~0b9c1f0e-1111-4222-8333-444455556666';
    expect(parseAuditFilters({ before: ok }).before).toBe(ok);
    for (const bad of ['2026-10-22T10:00:00.123456+00:00', '2026-10-22T10:00:00+00:00~id1', '~0b9c1f0e-1111-4222-8333-444455556666', 'x~0b9c1f0e-1111-4222-8333-444455556666', '2026-10-22T10:00:00+00:00~0b9c1f0e-1111-4222-8333-444455556666~z', '2026-10-22T10:00:00+00:00~0b9c1f0e-1111-4222-8333-444455556666),id.gt.0']) {
      expect(parseAuditFilters({ before: bad }).before).toBeNull();
    }
  });

  it('drops a bad cursor and an empty actor', () => {
    const f = parseAuditFilters({ before: 'yesterday', actor: '' });
    expect(f.before).toBeNull();
    expect(f.actor).toBeNull();
  });
});

describe('buildAuditSummary', () => {
  const row = (created_at: string, entity_type = 'finance_invoice', actor_name = 'Aisyah', event = 'created') => ({
    created_at,
    entity_type,
    actor_name,
    event,
  });

  it('counts by Malaysia day, so 17:00Z is already the next day', () => {
    const s = buildAuditSummary([row('2026-10-22T17:00:00Z'), row('2026-10-22T15:59:00Z')], '2026-10-23');
    expect(s.today).toBe(1);
    expect(s.week).toBe(2);
  });

  it('week is the last 7 days including today', () => {
    const s = buildAuditSummary([row('2026-10-17T04:00:00Z'), row('2026-10-16T04:00:00Z')], '2026-10-23');
    expect(s.week).toBe(1);
  });

  it('counts voids and deletions only in this month', () => {
    const s = buildAuditSummary(
      [
        row('2026-10-05T04:00:00Z', 'finance_invoice', 'A', 'voided'),
        row('2026-09-30T04:00:00Z', 'finance_invoice', 'A', 'voided'),
        row('2026-10-06T04:00:00Z', 'finance_expense', 'A', 'deleted'),
        row('2026-09-29T04:00:00Z', 'finance_expense', 'A', 'deleted'),
      ],
      '2026-10-23',
    );
    expect(s.voidsThisMonth).toBe(1);
    expect(s.deletionsThisMonth).toBe(1);
  });

  it('gives 30 daily points ending today, oldest first, with zeros', () => {
    const s = buildAuditSummary([row('2026-10-23T04:00:00Z'), row('2026-10-23T05:00:00Z')], '2026-10-23');
    expect(s.daily).toHaveLength(30);
    expect(s.daily[0]).toEqual({ date: '2026-09-24', label: '24 Sep', count: 0 });
    expect(s.daily[29]).toEqual({ date: '2026-10-23', label: '23 Oct', count: 2 });
  });

  it('sorts types by count, leaves out zeros and unknown types, and lists actors sorted', () => {
    const s = buildAuditSummary(
      [
        row('2026-10-23T04:00:00Z', 'finance_expense', 'Zed'),
        row('2026-10-23T04:00:00Z', 'finance_invoice', 'Aisyah'),
        row('2026-10-23T04:00:00Z', 'finance_invoice', 'Aisyah'),
        row('2026-10-23T04:00:00Z', 'finance_mystery', 'Aisyah'),
      ],
      '2026-10-23',
    );
    expect(s.byType).toEqual([
      { type: 'finance_invoice', label: 'Invoice', count: 2 },
      { type: 'finance_expense', label: 'Expense', count: 1 },
    ]);
    expect(s.actors).toEqual(['Aisyah', 'Zed']);
  });

  it('names a blank actor System in the actors list', () => {
    const s = buildAuditSummary([row('2026-10-23T04:00:00Z', 'finance_invoice', ''), row('2026-10-23T04:00:00Z', 'finance_invoice', 'Aisyah')], '2026-10-23');
    expect(s.actors).toEqual(['Aisyah', 'System']);
  });
});

type Call = [string, ...unknown[]];

function fakeCtx(data: unknown[], error: { message: string } | null = null) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'like', 'ilike', 'gte', 'lte', 'lt', 'or', 'order', 'limit', 'range']) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: error ? null : data, error }).then(resolve);
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      return chain;
    },
  };
  return { ctx: { client, orgId: 'org1' } as unknown as FinanceWriteContext, calls, tables };
}

const none: AuditFilters = { type: null, actor: null, period: 'all', q: '', before: null };

const dbRow = (i: number, entity_type = 'finance_invoice') => ({
  id: `id${i}`,
  created_at: `2026-10-2${i}T04:00:00Z`,
  actor_name: 'Aisyah',
  action: 'Created invoice',
  target: 'INV-1',
  entity_type,
  entity_id: `e${i}`,
  details: { event: 'created' },
});

describe('listFinanceAudit', () => {
  it('reads activity_log for the org, finance rows only, newest first', async () => {
    const { ctx, calls, tables } = fakeCtx([dbRow(1)]);
    const out = await listFinanceAudit(ctx, none);
    expect(tables).toEqual(['activity_log']);
    expect(calls).toContainEqual(['eq', 'org_id', 'org1']);
    expect(calls).toContainEqual(['like', 'entity_type', 'finance\\_%']);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(calls).toContainEqual(['order', 'id', { ascending: false }]);
    expect(calls).toContainEqual(['limit', 51]);
    expect(calls.some((c) => ['gte', 'lt', 'ilike'].includes(c[0] as string))).toBe(false);
    expect(out.entries[0]).toMatchObject({ id: 'id1', actorName: 'Aisyah', entityType: 'finance_invoice', entityId: 'e1', details: { event: 'created' } });
  });

  it('turns filters into the matching calls', async () => {
    const { ctx, calls } = fakeCtx([]);
    await listFinanceAudit(ctx, { type: 'finance_payment', actor: 'Aisyah', period: '7d', q: 'abc', before: '2026-10-22T00:00:00.5+00:00~0b9c1f0e-1111-4222-8333-444455556666' });
    expect(calls).toContainEqual(['eq', 'entity_type', 'finance_payment']);
    expect(calls.some((c) => c[0] === 'like')).toBe(false);
    expect(calls).toContainEqual(['eq', 'actor_name', 'Aisyah']);
    expect(calls).toContainEqual([
      'or',
      'created_at.lt."2026-10-22T00:00:00.5+00:00",and(created_at.eq."2026-10-22T00:00:00.5+00:00",id.lt.0b9c1f0e-1111-4222-8333-444455556666)',
    ]);
    expect(calls.some((c) => c[0] === 'lt')).toBe(false);
    expect(calls).toContainEqual(['ilike', 'target', '%abc%']);
    const gte = calls.find((c) => c[0] === 'gte')!;
    expect(gte[1]).toBe('created_at');
    const ageDays = (Date.now() - Date.parse(gte[2] as string)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(6.99);
    expect(ageDays).toBeLessThan(7.01);
  });

  it('escapes search', async () => {
    const { ctx, calls } = fakeCtx([]);
    await listFinanceAudit(ctx, { ...none, q: '50%_off\\x' });
    expect(calls).toContainEqual(['ilike', 'target', '%50\\%\\_off\\\\x%']);
  });

  it('sets nextBefore only when pageSize+1 rows came back', async () => {
    const full = fakeCtx([dbRow(1), dbRow(2), dbRow(3)]);
    const a = await listFinanceAudit(full.ctx, none, 2);
    expect(a.entries.map((e) => e.id)).toEqual(['id1', 'id2']);
    expect(a.nextBefore).toBe('2026-10-22T04:00:00Z~id2');
    expect(full.calls).toContainEqual(['limit', 3]);

    const short = fakeCtx([dbRow(1), dbRow(2)]);
    const b = await listFinanceAudit(short.ctx, none, 2);
    expect(b.entries).toHaveLength(2);
    expect(b.nextBefore).toBeNull();
  });

  it('matches the System actor to a blank or missing name', async () => {
    const { ctx, calls } = fakeCtx([]);
    await listFinanceAudit(ctx, { ...none, actor: 'System' });
    expect(calls).toContainEqual(['or', 'actor_name.is.null,actor_name.eq.']);
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'actor_name')).toBe(false);
  });

  it('shows a blank actor as System', async () => {
    const { ctx } = fakeCtx([{ ...dbRow(1), actor_name: null }]);
    expect((await listFinanceAudit(ctx, none)).entries[0].actorName).toBe('System');
  });

  it('drops unknown entity types', async () => {
    const { ctx } = fakeCtx([dbRow(1, 'finance_mystery'), dbRow(2)]);
    const out = await listFinanceAudit(ctx, none);
    expect(out.entries.map((e) => e.id)).toEqual(['id2']);
  });

  it('throws when the read fails', async () => {
    const { ctx } = fakeCtx([], { message: 'down' });
    await expect(listFinanceAudit(ctx, none)).rejects.toBeTruthy();
  });
});

/** A client whose answer is the `.range(from, to)` slice of `all`, as PostgREST pages; records each range asked. */
function pagedCtx(all: unknown[]) {
  const ranges: [number, number][] = [];
  const client = {
    from() {
      let slice: [number, number] = [0, all.length - 1];
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'like', 'gte', 'lte', 'order']) chain[m] = () => chain;
      chain.range = (from: number, to: number) => {
        slice = [from, to];
        ranges.push(slice);
        return chain;
      };
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: all.slice(slice[0], slice[1] + 1), error: null }).then(resolve);
      return chain;
    },
  };
  return { ctx: { client, orgId: 'org1' } as unknown as FinanceWriteContext, ranges };
}

const summaryRow = (i: number) => ({ created_at: `2026-10-23T00:00:${String(i % 60).padStart(2, '0')}Z`, entity_type: 'finance_invoice', actor_name: 'A', event: 'posted' });

describe('readAuditSummaryRows', () => {
  it('reads finance rows of the last 31 days, newest first, a page of 1000 at a time', async () => {
    const { ctx, calls } = fakeCtx([{ created_at: '2026-10-23T00:00:00Z', entity_type: 'finance_invoice', actor_name: 'A', event: 'created' }]);
    const rows = await readAuditSummaryRows(ctx);
    expect(rows).toHaveLength(1);
    expect(calls).toContainEqual(['select', 'created_at, entity_type, actor_name, event:details->>event']);
    expect(calls).toContainEqual(['eq', 'org_id', 'org1']);
    expect(calls).toContainEqual(['like', 'entity_type', 'finance\\_%']);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(calls).toContainEqual(['order', 'id', { ascending: false }]);
    expect(calls).toContainEqual(['range', 0, 999]);
    expect(calls.some((c) => c[0] === 'limit')).toBe(false);
    const gte = calls.find((c) => c[0] === 'gte')!;
    const ageDays = (Date.now() - Date.parse(gte[2] as string)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(30.99);
    expect(ageDays).toBeLessThan(31.01);
    // The window's end is fixed when the read starts.
    const lte = calls.find((c) => c[0] === 'lte')!;
    expect(lte[1]).toBe('created_at');
    expect(Date.now() - Date.parse(lte[2] as string)).toBeLessThan(60_000);
  });

  it('reads a second page when the first is full, and stops at a short one', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => summaryRow(i));
    const { ctx, ranges } = pagedCtx(all);
    const rows = await readAuditSummaryRows(ctx);
    expect(rows).toHaveLength(1500);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('reads one more page after exactly 1000 rows, and stops when it is empty', async () => {
    const { ctx, ranges } = pagedCtx(Array.from({ length: 1000 }, (_, i) => summaryRow(i)));
    expect(await readAuditSummaryRows(ctx)).toHaveLength(1000);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('stops at 5000 rows', async () => {
    const { ctx, ranges } = pagedCtx(Array.from({ length: 6200 }, (_, i) => summaryRow(i)));
    expect(await readAuditSummaryRows(ctx)).toHaveLength(5000);
    expect(ranges).toHaveLength(5);
    expect(ranges[4]).toEqual([4000, 4999]);
  });

  it('throws when a page cannot be read', async () => {
    const { ctx } = fakeCtx([], { message: 'down' });
    await expect(readAuditSummaryRows(ctx)).rejects.toBeTruthy();
  });
});
