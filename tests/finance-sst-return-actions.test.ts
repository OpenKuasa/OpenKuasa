import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * markSstReturnFiledAction and unmarkSstReturnFiledAction (#222 stage 2), through the real data layer on a
 * fake client: an owner or admin marks a past period with a plain insert (the table has no update grant), an
 * already-marked period answers ok and keeps its first date, a member is told who may before anything is
 * written, and a bad or unfinished period is refused. Also the row mapper the reader runs every line through.
 */
const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  inserts: [] as { table: string; row: unknown }[],
  deletes: [] as { table: string; filters: [string, unknown][] }[],
  error: null as { code: string; message: string } | null,
  revalidated: [] as string[],
}));

function fakeClient() {
  return {
    from(table: string) {
      return {
        insert: async (row: unknown) => {
          ctl.inserts.push({ table, row });
          return { error: ctl.error };
        },
        delete: () => {
          const filters: [string, unknown][] = [];
          ctl.deletes.push({ table, filters });
          const chain = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return chain;
            },
            then(resolve: (v: { error: unknown }) => unknown) {
              return Promise.resolve({ error: ctl.error }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
}

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient() }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

const { markSstReturnFiledAction, unmarkSstReturnFiledAction } = await import('@/app/(app)/finance/actions');
const { toSstLineRow } = await import('@/lib/finance/sst-return-data');
const { todayInMalaysia } = await import('@/lib/people/dates');

const NEEDS = { ok: false, error: 'Only an owner or admin can mark a return as filed.' };
const PAST = { type: 'service', period_start: '2024-01-01' };
const today = todayInMalaysia(new Date());

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false };
  ctl.inserts = [];
  ctl.deletes = [];
  ctl.error = null;
  ctl.revalidated = [];
});

describe('markSstReturnFiledAction', () => {
  it.each(['owner', 'admin'])('marks a past period for an %s with a plain insert dated today', async (role) => {
    ctl.viewer.role = role;
    expect(await markSstReturnFiledAction(PAST)).toEqual({ ok: true, data: null });
    expect(ctl.inserts).toEqual([
      { table: 'finance_sst_returns', row: { org_id: 'org1', tax_type: 'service', period_start: '2024-01-01', filed_on: today } },
    ]);
    expect(ctl.revalidated).toEqual(['/finance/sst-report']);
  });

  it('tells a member who may, without writing', async () => {
    ctl.viewer.role = 'member';
    expect(await markSstReturnFiledAction(PAST)).toEqual(NEEDS);
    expect(ctl.inserts).toEqual([]);
  });

  it('answers the database refusal in the same words', async () => {
    ctl.error = { code: '42501', message: 'new row violates row-level security policy' };
    expect(await markSstReturnFiledAction(PAST)).toEqual(NEEDS);
  });

  it('refuses a period start that is not day 1, with a sentence', async () => {
    const r = await markSstReturnFiledAction({ type: 'service', period_start: '2026-09-02' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/^[A-Z].*\.$/);
    expect(ctl.inserts).toEqual([]);
  });

  it('refuses a type that is not service or sales', async () => {
    expect((await markSstReturnFiledAction({ type: 'income', period_start: '2024-01-01' })).ok).toBe(false);
    expect(ctl.inserts).toEqual([]);
  });

  it('refuses the current period, which has not ended', async () => {
    const r = await markSstReturnFiledAction({ type: 'sales', period_start: `${today.slice(0, 7)}-01` });
    expect(r).toEqual({ ok: false, error: 'You can mark a return as filed once its period has ended.' });
    expect(ctl.inserts).toEqual([]);
  });

  it('answers ok for a period already marked, keeping the first date (no update)', async () => {
    ctl.error = { code: '23505', message: 'duplicate key value violates unique constraint' };
    expect(await markSstReturnFiledAction(PAST)).toEqual({ ok: true, data: null });
    expect(ctl.inserts).toHaveLength(1);
  });

  it('refuses a viewer and the demo', async () => {
    ctl.viewer.role = 'viewer';
    expect((await markSstReturnFiledAction(PAST)).ok).toBe(false);
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    expect((await markSstReturnFiledAction(PAST)).ok).toBe(false);
    expect(ctl.inserts).toEqual([]);
  });
});

describe('unmarkSstReturnFiledAction', () => {
  it('deletes the one mark by its key', async () => {
    expect(await unmarkSstReturnFiledAction({ type: 'sales', period_start: '2024-03-01' })).toEqual({ ok: true, data: null });
    expect(ctl.deletes).toEqual([
      { table: 'finance_sst_returns', filters: [['org_id', 'org1'], ['tax_type', 'sales'], ['period_start', '2024-03-01']] },
    ]);
  });

  it('tells a member who may, without writing', async () => {
    ctl.viewer.role = 'member';
    expect(await unmarkSstReturnFiledAction({ type: 'sales', period_start: '2024-03-01' })).toEqual(NEEDS);
    expect(ctl.deletes).toEqual([]);
  });
});

describe('toSstLineRow', () => {
  const raw = {
    id: 'l1', invoice_id: 'i1', product_id: null, description: 'Repairs', sst_rate: '8', tax_type: null, sst_code: null,
    amount_myr: '100.50', sst_amount_myr: '8.04',
    finance_invoices: { invoice_date: '2026-09-15', status: 'void', voided_at: '2026-10-31T16:30:00Z' },
  };

  it('takes the void date in Malaysia and turns PostgREST numeric strings into numbers', () => {
    expect(toSstLineRow(raw)).toEqual({
      id: 'l1', invoice_id: 'i1', product_id: null, description: 'Repairs', sst_rate: 8, tax_type: null, sst_code: null,
      amount_myr: 100.5, sst_amount_myr: 8.04, invoice_date: '2026-09-15', invoice_status: 'void', voided_on: '2026-11-01',
    });
  });

  it('gives no void date to a posted invoice, nor to a void one with no voided_at', () => {
    expect(toSstLineRow({ ...raw, finance_invoices: { invoice_date: '2026-09-15', status: 'posted', voided_at: null } }))
      .toMatchObject({ invoice_status: 'posted', voided_on: null });
    expect(toSstLineRow({ ...raw, finance_invoices: { invoice_date: '2026-09-15', status: 'void', voided_at: null } }))
      .toMatchObject({ invoice_status: 'void', voided_on: null });
  });
});
