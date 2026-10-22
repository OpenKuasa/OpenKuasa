import { describe, expect, it } from 'vitest';
import { readSstRows } from '@/lib/finance/sst-return-data';
import type { FinanceWriteContext } from '@/lib/finance/result';

/**
 * The four reads behind an SST return (#222 stage 2), on a fake client that records each query. The reads for
 * documents voided within the span are the only way a document dated before the span reaches the return, and
 * no live test can make them the only read returning a row, so their filters are pinned here: the right table,
 * the void status, and a voided_at window from the span's first Malaysian midnight to the midnight after it.
 */
type Call = [method: string, ...args: unknown[]];
type Recorded = { table: string; calls: Call[] };

function recordingClient(queries: Recorded[]) {
  return {
    from(table: string) {
      const q: Recorded = { table, calls: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'order']) {
        chain[method] = (...args: unknown[]) => {
          q.calls.push([method, ...args]);
          return chain;
        };
      }
      chain.range = () => Promise.resolve({ data: [], error: null });
      return chain;
    },
  };
}

const has = (q: Recorded, method: string, ...args: unknown[]) =>
  q.calls.some((c) => c[0] === method && JSON.stringify(c.slice(1)) === JSON.stringify(args));

async function read(span: { start: string; end: string }) {
  const queries: Recorded[] = [];
  const ctx = { client: recordingClient(queries), orgId: 'org1' } as unknown as FinanceWriteContext;
  await readSstRows(ctx, span);
  return queries;
}

describe('readSstRows', () => {
  it('reads lines of invoices voided in the span by a Malaysian voided_at window, joined to their invoice', async () => {
    const queries = await read({ start: '2026-09-01', end: '2026-10-31' });
    const voided = queries.filter((q) => q.table === 'finance_invoice_lines' && has(q, 'eq', 'finance_invoices.status', 'void'));
    expect(voided).toHaveLength(1);
    const [q] = voided;
    expect(q.calls.find((c) => c[0] === 'select')?.[1]).toContain('finance_invoices!inner(invoice_date,status,voided_at)');
    expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(q, 'gte', 'finance_invoices.voided_at', '2026-09-01T00:00:00+08:00')).toBe(true);
    expect(has(q, 'lt', 'finance_invoices.voided_at', '2026-11-01T00:00:00+08:00')).toBe(true);
    // Not limited by the invoice's own date: that is what lets an older invoice in.
    expect(q.calls.some((c) => String(c[1]).startsWith('finance_invoices.invoice_date'))).toBe(false);
  });

  it('reads credit notes voided in the span by the same window, whatever their credit date', async () => {
    const queries = await read({ start: '2026-09-01', end: '2026-10-31' });
    const voided = queries.filter((q) => q.table === 'finance_credit_notes' && has(q, 'eq', 'status', 'void'));
    expect(voided).toHaveLength(1);
    const [q] = voided;
    expect(has(q, 'eq', 'org_id', 'org1')).toBe(true);
    expect(has(q, 'gte', 'voided_at', '2026-09-01T00:00:00+08:00')).toBe(true);
    expect(has(q, 'lt', 'voided_at', '2026-11-01T00:00:00+08:00')).toBe(true);
    expect(q.calls.some((c) => c[1] === 'credit_date')).toBe(false);
  });

  it('reads documents dated in the span, posted or voided, by their own dates', async () => {
    const queries = await read({ start: '2026-09-01', end: '2026-10-31' });
    const lines = queries.find((q) => q.table === 'finance_invoice_lines' && has(q, 'in', 'finance_invoices.status', ['posted', 'void']));
    expect(lines && has(lines, 'gte', 'finance_invoices.invoice_date', '2026-09-01')).toBe(true);
    expect(lines && has(lines, 'lte', 'finance_invoices.invoice_date', '2026-10-31')).toBe(true);
    const credits = queries.find((q) => q.table === 'finance_credit_notes' && has(q, 'in', 'status', ['issued', 'void']));
    expect(credits && has(credits, 'gte', 'credit_date', '2026-09-01')).toBe(true);
    expect(credits && has(credits, 'lte', 'credit_date', '2026-10-31')).toBe(true);
  });

  it('ends the void window at the midnight after the span, across a year end', async () => {
    const queries = await read({ start: '2026-11-01', end: '2026-12-31' });
    const q = queries.find((x) => x.table === 'finance_credit_notes' && has(x, 'eq', 'status', 'void'));
    expect(q && has(q, 'lt', 'voided_at', '2027-01-01T00:00:00+08:00')).toBe(true);
  });
});
