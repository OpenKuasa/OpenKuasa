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
  upserts: [] as { table: string; row: unknown; options: unknown }[],
  selects: [] as { table: string; columns: string; filters: [string, unknown][] }[],
  rows: [] as Record<string, unknown>[],
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
        upsert: async (row: unknown, options: unknown) => {
          ctl.upserts.push({ table, row, options });
          return { error: ctl.error };
        },
        select: (columns: string) => {
          const filters: [string, unknown][] = [];
          ctl.selects.push({ table, columns, filters });
          const chain = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return chain;
            },
            order: () => chain,
            range: async (from: number, to: number) => ({ data: ctl.rows.slice(from, to + 1), error: ctl.error }),
          };
          return chain;
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

const { markSstReturnFiledAction, saveSstFiguresAction, unmarkSstReturnFiledAction } = await import('@/app/(app)/finance/actions');
const { listSstFigures, sstFiguresInput, toSstLineRow } = await import('@/lib/finance/sst-return-data');
const { todayInMalaysia } = await import('@/lib/people/dates');

const NEEDS = { ok: false, error: 'Only an owner or admin can mark a return as filed.' };
const PAST = { type: 'service', period_start: '2024-01-01' };
const today = todayInMalaysia(new Date());

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false };
  ctl.inserts = [];
  ctl.upserts = [];
  ctl.selects = [];
  ctl.rows = [];
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

describe('saveSstFiguresAction', () => {
  const SERVICE = { type: 'service', period_start: '2026-09-01', cards_11e: '4', deduction_13c: '1,234.50', bad_debt_13d: 20 };
  const SALES = { type: 'sales', period_start: '2026-09-01', deduction_13b: '10', bad_debt_13d: '', adjustment_13a: '0.05' };
  const KEY = { onConflict: 'org_id,tax_type,period_start' };
  const FIGURES_NEEDS = { ok: false, error: 'Only an owner or admin can change the typed-in figures.' };

  it.each(['owner', 'admin'])('saves a service return\'s figures for an %s, the sales columns as 0', async (role) => {
    ctl.viewer.role = role;
    expect(await saveSstFiguresAction(SERVICE)).toEqual({ ok: true, data: null });
    expect(ctl.upserts).toEqual([{
      table: 'finance_sst_return_figures',
      row: {
        org_id: 'org1', tax_type: 'service', period_start: '2026-09-01',
        cards_11e: 4, deduction_13b: 0, deduction_13c: 1234.5, bad_debt_13d: 20, adjustment_13a: 0,
      },
      options: KEY,
    }]);
    expect(ctl.revalidated).toEqual(['/finance/sst-report']);
  });

  it('saves a sales return\'s figures, the service columns as 0 and an empty box as 0', async () => {
    expect(await saveSstFiguresAction(SALES)).toEqual({ ok: true, data: null });
    expect(ctl.upserts[0].row).toEqual({
      org_id: 'org1', tax_type: 'sales', period_start: '2026-09-01',
      cards_11e: 0, deduction_13b: 10, deduction_13c: 0, bad_debt_13d: 0, adjustment_13a: 0.05,
    });
  });

  it('never carries one type\'s figures into the other: a service-only figure on a sales return is refused', async () => {
    for (const extra of [{ cards_11e: 3 }, { deduction_13c: '5' }]) {
      const r = await saveSstFiguresAction({ ...SALES, ...extra });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toMatch(/^.+ is on the service tax return only\.$/);
    }
    for (const extra of [{ deduction_13b: '1' }, { adjustment_13a: 2 }]) {
      const r = await saveSstFiguresAction({ ...SERVICE, ...extra });
      expect(r.ok ? '' : r.error).toMatch(/^.+ is on the sales tax return only\.$/);
    }
    expect(ctl.upserts).toEqual([]);
  });

  it('accepts the other type\'s fields when they are 0', async () => {
    expect((await saveSstFiguresAction({ ...SALES, cards_11e: '0', deduction_13c: 0 })).ok).toBe(true);
  });

  it('tells a member who may, before anything is read or written', async () => {
    ctl.viewer.role = 'member';
    expect(await saveSstFiguresAction(SERVICE)).toEqual(FIGURES_NEEDS);
    expect(ctl.upserts).toEqual([]);
  });

  it('answers the database refusal for a non-signer in the same words', async () => {
    ctl.error = { code: '42501', message: 'new row violates row-level security policy' };
    expect(await saveSstFiguresAction(SERVICE)).toEqual(FIGURES_NEEDS);
  });

  it('refuses a filed period with the FIN60 sentence', async () => {
    ctl.error = { code: 'FIN60', message: 'filed' };
    expect(await saveSstFiguresAction(SERVICE)).toEqual({
      ok: false, error: 'This return is marked filed. Undo the mark to change its figures.',
    });
  });

  it.each(['FIN61', '23514', 'XX000'])('answers %s with the general message', async (code) => {
    ctl.error = { code, message: 'no' };
    expect(await saveSstFiguresAction(SERVICE)).toEqual({ ok: false, error: 'That change could not be saved. Please try again.' });
  });

  it('refuses a viewer and the demo', async () => {
    ctl.viewer.role = 'viewer';
    expect((await saveSstFiguresAction(SERVICE)).ok).toBe(false);
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    expect((await saveSstFiguresAction(SERVICE)).ok).toBe(false);
    expect(ctl.upserts).toEqual([]);
  });

  it('refuses a period start that is not day 1', async () => {
    expect((await saveSstFiguresAction({ ...SERVICE, period_start: '2026-09-02' })).ok).toBe(false);
    expect(ctl.upserts).toEqual([]);
  });
});

describe('sstFiguresInput', () => {
  const base = { type: 'service', period_start: '2026-09-01' };
  const amount = (v: unknown) => sstFiguresInput.safeParse({ ...base, deduction_13c: v });
  const cards = (v: unknown) => sstFiguresInput.safeParse({ ...base, cards_11e: v });
  const message = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0].message;

  it.each([
    ['1,234.50', 1234.5], ['1234.5', 1234.5], ['12', 12], ['  12.30 ', 12.3], ['', 0], [undefined, 0],
    [0, 0], [99.99, 99.99], [0.29, 0.29], [1234567890.12, 1234567890.12], ['9,999,999,999.99', 9999999999.99], [9999999999.99, 9999999999.99],
  ])('takes the amount %j as %d', (v, want) => {
    const r = amount(v);
    expect(r.success).toBe(true);
    expect(r.data?.deduction_13c).toBe(want);
  });

  it.each(['-1', -1, '12.345', 12.345, '1e3', 'abc', '1,23', '12.', '.5', '10000000000', 10_000_000_000, Number.NaN, Infinity, null, true])(
    'refuses the amount %j with a sentence naming the item',
    (v) => {
      const r = amount(v);
      expect(r.success).toBe(false);
      expect(message(r)).toMatch(/^13\(c\) .*\.$|^Enter 13\(c\) .*\.$/);
    },
  );

  it('says how to type an amount', () => {
    expect(message(amount('abc'))).toBe('Enter 13(c) as an amount in ringgit, like 1,234.50.');
    expect(message(amount('10000000000'))).toBe('13(c) can be at most 9,999,999,999.99.');
  });

  it.each([['4', 4], [4, 4], ['10,000,000', 10_000_000], ['', 0], [0, 0]])('takes the cards %j as %d', (v, want) => {
    const r = cards(v);
    expect(r.success).toBe(true);
    expect(r.data?.cards_11e).toBe(want);
  });

  it.each(['4.5', 4.5, '-1', -1, '1e3', 'abc', '10000001', 10_000_001])('refuses the cards %j with a sentence', (v) => {
    const r = cards(v);
    expect(r.success).toBe(false);
    expect(message(r)).toMatch(/^(Enter 11\(e\)|11\(e\)) .*\.$/);
  });
});

describe('listSstFigures', () => {
  it('reads one type\'s figures, period start to figures, numbers from PostgREST strings', async () => {
    ctl.rows = [
      { period_start: '2026-07-01', cards_11e: 2, deduction_13b: '0.00', deduction_13c: '15.50', bad_debt_13d: '3.00', adjustment_13a: '0.00' },
    ];
    expect(await listSstFigures({ client: fakeClient() as never, orgId: 'org1' }, 'service')).toEqual({
      '2026-07-01': { cards11e: 2, deduction13b: 0, deduction13c: 15.5, badDebt13d: 3, adjustment13a: 0 },
    });
    expect(ctl.selects[0]).toMatchObject({
      table: 'finance_sst_return_figures', filters: [['org_id', 'org1'], ['tax_type', 'service']],
    });
  });

  it('throws when the read fails', async () => {
    ctl.error = { code: 'XX000', message: 'down' };
    await expect(listSstFigures({ client: fakeClient() as never, orgId: 'org1' }, 'sales')).rejects.toBeTruthy();
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
