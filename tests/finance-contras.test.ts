import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRA_ID_CHUNK,
  CONTRA_MESSAGES as M,
  contraActions,
  contraContacts,
  contraSides,
  deleteContra,
  listContras,
  postContra,
  saveContra,
  saveContraInput,
  voidContra,
} from '@/lib/finance/contras';
import { SOURCE_LABELS, SOURCE_PATHS } from '@/lib/finance/ledger-views';
import { cashMovements } from '@/lib/finance/reports';
import { WRITE_FAILED, type FinanceWriteContext } from '@/lib/finance/result';

// Contra entries, stage 1 (migration 20261119100000). Node only, no database: the migration is read as text,
// the data layer is driven through a fake client, and the pure helpers are called directly.

const MIGRATION = 'supabase/migrations/20261119100000_bendahara_contra_entries.sql';
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8');
const code = readFileSync(join(process.cwd(), 'src/lib/finance/contras.ts'), 'utf8');
/** The migration without its comments, so a word in a comment never passes or fails a test. */
const body = sql
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the migration', () => {
  it('replaces exactly the four live objects it names, and nothing else', () => {
    const replaced = [...body.matchAll(/create or replace (view|function) ([a-z_.]+)/gi)].map((m) => m[2]).sort();
    expect(replaced).toEqual([
      'public.finance_invoice_totals',
      'public.finance_ledger_lines',
      'public.finance_next_number',
      'public.supplier_bill_totals',
    ]);
  });

  it('drops and alters nothing but the doc_type constraint of finance_sequences', () => {
    expect([...body.matchAll(/\bdrop\s+(\w+)\s+([a-z_.]+)/gi)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'constraint finance_sequences_doc_type_check',
    ]);
    expect([...body.matchAll(/\balter\s+table\s+([a-z_.]+)/gi)].map((m) => m[1]).filter((t) => !/^public\.finance_contra(s|_lines)$/.test(t))).toEqual([
      'public.finance_sequences',
    ]);
  });

  it('writes no table a bank balance, Banking or the Cash Flow reads', () => {
    for (const table of ['finance_transactions', 'finance_allocations', 'finance_accounts', 'finance_statement_lines']) {
      expect(body, table).not.toMatch(new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+public\\.${table}\\b`, 'i'));
      expect(code, table).not.toMatch(new RegExp(`from\\('${table}'\\)`));
    }
  });

  it('keeps finance_next_number security definer, writer first, and gives contra CT-', () => {
    const fn = body.slice(body.indexOf('create or replace function public.finance_next_number'));
    expect(fn.slice(0, fn.indexOf('end $$;'))).toMatch(/security definer\s+set search_path = ''/);
    expect(fn).toMatch(/if not private\.is_org_writer\(target_org\) then/);
    expect(fn).toMatch(/when 'contra' then 'CT-'/);
    expect(body).toMatch(/revoke all on function public\.finance_next_number\(uuid, text\) from public, anon, service_role;/);
  });

  it('refuses NaN by name on both amount columns', () => {
    expect(body).toMatch(/finance_contras_amount_check check \(amount > 0 and amount <> 'NaN'\)/);
    expect(body).toMatch(/finance_contra_lines_amount_check check \(amount > 0 and amount <> 'NaN'\)/);
    expect(body).toMatch(/amt = 'NaN'/);
  });

  it('hands service_role nothing on the new tables', () => {
    expect(body).toMatch(/revoke all on public\.finance_contras from anon, authenticated, service_role;/);
    expect(body).toMatch(/revoke all on public\.finance_contra_lines from anon, authenticated, service_role;/);
    expect(body).not.toMatch(/grant [^;]* to [^;]*service_role/i);
  });

  it('closes the columns only the database writes', () => {
    const grants = [...body.matchAll(/grant (insert|update) \(([^)]*)\) on public\.finance_contras/g)].map((m) => m[2]);
    expect(grants).toHaveLength(2);
    for (const cols of grants) {
      for (const closed of ['contra_no', 'created_by', 'posted_by', 'posted_at', 'voided_at']) {
        expect(cols.split(/,\s*/), closed).not.toContain(closed);
      }
    }
    expect(body).not.toMatch(/grant update[^;]*on public\.finance_contra_lines/);
  });

  it('names its triggers so they fire in the order the design needs', () => {
    const sorted = (names: string[]) => [...names].sort();
    expect(sorted(['finance_allocation_guard', 'finance_allocation_less_contra', 'finance_allocation_still'])).toEqual([
      'finance_allocation_guard',
      'finance_allocation_less_contra',
      'finance_allocation_still',
    ]);
    expect(sorted(['finance_invoice_guard', 'finance_invoice_sign_off', 'finance_invoice_void_contra', 'finance_void_stamp'])).toEqual([
      'finance_invoice_guard',
      'finance_invoice_sign_off',
      'finance_invoice_void_contra',
      'finance_void_stamp',
    ]);
    expect(
      sorted(['finance_bill_category', 'finance_bill_guard', 'finance_bill_po_link', 'finance_bill_sign_off', 'finance_bill_void_contra', 'finance_void_stamp']),
    ).toEqual(['finance_bill_category', 'finance_bill_guard', 'finance_bill_po_link', 'finance_bill_sign_off', 'finance_bill_void_contra', 'finance_void_stamp']);
    for (const t of ['finance_allocation_less_contra', 'finance_invoice_void_contra', 'finance_bill_void_contra', 'finance_contra_guard', 'finance_contra_line_guard']) {
      expect(body, t).toMatch(new RegExp(`create trigger ${t}\\b`));
    }
    expect(body).toMatch(/create trigger finance_void_stamp\s+before insert or update on public\.finance_contras/);
  });

  it('subtracts posted contra lines from both balances and leaves paid alone', () => {
    expect(body).toMatch(/- coalesce\(sc\.set_off, 0\) as balance/);
    expect(body).toMatch(/\(coalesce\(l\.total, 0\) - coalesce\(p\.paid, 0\) - coalesce\(sc\.set_off, 0\)\)::numeric\(14,2\) as balance/);
    expect(body).not.toMatch(/paid[^\n]*set_off[^\n]*as paid/);
  });

  it('puts a contra on Accounts Payable and Accounts Receivable only', () => {
    const branch = body.slice(body.indexOf("'contra'::text"), body.indexOf("where k.status = 'posted'"));
    expect(branch).toMatch(/'payable'::text, null::uuid, null::uuid, null::text, k\.amount::numeric, 0::numeric/);
    expect(branch).toMatch(/'receivable'::text, null::uuid, null::uuid, null::text, 0::numeric, k\.amount::numeric/);
    expect(branch).not.toMatch(/account_id/);
  });
});

describe('saveContraInput', () => {
  const base = {
    contact_id: UUID(1),
    contra_date: '2026-10-15',
    amount: 100,
    reference: '',
    notes: '',
    invoices: [{ invoice_id: UUID(2), amount: 100 }],
    bills: [{ bill_id: UUID(3), amount: 100 }],
  };

  it('takes a whole draft and stores empty text as null', () => {
    const parsed = saveContraInput.parse(base);
    expect(parsed.reference).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it.each([NaN, 0, -1, 1e15])('refuses an amount of %s', (amount) => {
    const r = saveContraInput.safeParse({ ...base, amount });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe(M.amount);
  });

  it('refuses a line amount that is not above zero', () => {
    const r = saveContraInput.safeParse({ ...base, bills: [{ bill_id: UUID(3), amount: NaN }] });
    expect(r.success).toBe(false);
  });

  it('rounds to the sen before it judges', () => {
    expect(saveContraInput.parse({ ...base, amount: 100.004 }).amount).toBe(100);
    expect(saveContraInput.safeParse({ ...base, amount: 0.004 }).success).toBe(false);
  });

  it('refuses the same invoice or bill twice', () => {
    const twice = { ...base, invoices: [{ invoice_id: UUID(2), amount: 50 }, { invoice_id: UUID(2), amount: 50 }] };
    expect(saveContraInput.safeParse(twice).error?.issues[0].message).toBe(M.duplicate);
  });

  it('refuses a reference over 100 characters', () => {
    expect(saveContraInput.safeParse({ ...base, reference: 'x'.repeat(101) }).error?.issues[0].message).toBe(M.reference);
  });

  it('saves a draft with no bill yet: posting is where both sides are asked for', () => {
    expect(saveContraInput.safeParse({ ...base, bills: [] }).success).toBe(true);
  });
});

describe('the data layer answers the database in words', () => {
  afterEach(() => vi.restoreAllMocks());

  function fake(answer: { data?: unknown; error?: { code: string; message: string } | null }) {
    const calls: { fn: string; args: unknown }[] = [];
    const chain = {
      delete: () => chain,
      eq: () => chain,
      select: () => chain,
      maybeSingle: async () => ({ data: answer.data ?? null, error: answer.error ?? null }),
    };
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return { data: answer.data ?? null, error: answer.error ?? null };
      },
      from: () => chain,
    };
    return { ctx: { client, orgId: UUID(9) } as unknown as FinanceWriteContext, calls };
  }

  const draft = {
    contact_id: UUID(1),
    contra_date: '2026-10-15',
    amount: 100,
    reference: 'Their ref 7',
    notes: null,
    invoices: [{ invoice_id: UUID(2), amount: 100 }],
    bills: [{ bill_id: UUID(3), amount: 100 }],
  };

  it('sends the header and every line to finance_save_contra', async () => {
    const { ctx, calls } = fake({ data: UUID(4) });
    expect(await saveContra(ctx, draft)).toEqual({ ok: true, data: { id: UUID(4) } });
    expect(calls).toEqual([
      {
        fn: 'finance_save_contra',
        args: {
          target_org: UUID(9),
          contra: { contact_id: UUID(1), contra_date: '2026-10-15', amount: 100, reference: 'Their ref 7', notes: null },
          lines: [
            { invoice_id: UUID(2), amount: 100 },
            { bill_id: UUID(3), amount: 100 },
          ],
        },
      },
    ]);
  });

  it.each([
    ['FIN31', M.wrongContact],
    ['FIN14', M.needsSignOff],
    ['42501', M.needsSignOff],
    ['FIN01', M.locked],
    ['FIN29', M.amount],
  ])('save: %s is "%s"', async (pg, sentence) => {
    const { ctx } = fake({ error: { code: pg, message: 'x' } });
    expect(await saveContra(ctx, draft)).toEqual({ ok: false, error: sentence });
  });

  it.each([
    ['FIN29', M.unbalanced],
    ['FIN04', M.notPosted],
    ['FIN05', M.tooMuch],
    ['FIN11', M.gone],
    ['FIN31', M.wrongContact],
  ])('post: %s is "%s"', async (pg, sentence) => {
    const { ctx } = fake({ error: { code: pg, message: 'x' } });
    expect(await postContra(ctx, { id: UUID(4) })).toEqual({ ok: false, error: sentence });
  });

  it('void: FIN33 says refunds depend on it', async () => {
    const { ctx } = fake({ error: { code: 'FIN33', message: 'x' } });
    expect(await voidContra(ctx, { id: UUID(4) })).toEqual({ ok: false, error: M.refundsDepend });
  });

  it('delete: a row gone is "no longer exists"', async () => {
    const { ctx } = fake({ data: null });
    expect(await deleteContra(ctx, { id: UUID(4) })).toEqual({ ok: false, error: M.gone });
  });

  it('an unknown refusal is the general sentence, and is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = fake({ error: { code: 'XX000', message: 'boom' } });
    expect(await postContra(ctx, { id: UUID(4) })).toEqual({ ok: false, error: WRITE_FAILED });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('pure helpers', () => {
  it('offers only contacts who are both a customer and a supplier, and active', () => {
    const c = (name: string, is_customer: boolean, is_supplier: boolean, active = true) => ({ id: name, name, is_customer, is_supplier, active });
    expect(contraContacts([c('B', true, true), c('A', true, true), c('C', true, false), c('D', true, true, false)]).map((x) => x.id)).toEqual([
      'A',
      'B',
    ]);
  });

  it('adds the sides in sen and says when it is ready to post', () => {
    expect(contraSides({ amount: 0.3, invoices: [{ amount: 0.1 }, { amount: 0.2 }], bills: [{ amount: 0.3 }] })).toEqual({
      invoiceSide: 0.3,
      billSide: 0.3,
      invoiceShort: 0,
      billShort: 0,
      ready: true,
    });
    expect(contraSides({ amount: 100, invoices: [{ amount: 60 }], bills: [] }).ready).toBe(false);
    expect(contraSides({ amount: 100, invoices: [{ amount: 60 }], bills: [{ amount: 100 }] }).invoiceShort).toBe(40);
  });

  it('offers by status, and nothing without the sign-off', () => {
    expect(contraActions('draft', true)).toEqual(['edit', 'post', 'delete']);
    expect(contraActions('posted', true)).toEqual(['void']);
    expect(contraActions('void', true)).toEqual([]);
    expect(contraActions('draft', false)).toEqual([]);
  });
});

describe('the ledger knows a contra, and the Cash Flow never sees one', () => {
  it('labels it and opens Contra Entries', () => {
    expect(SOURCE_LABELS.contra).toBe('Contra entry');
    expect(SOURCE_PATHS.contra).toBe('/finance/contra-entries');
  });

  it('cashMovements leaves out a contra, whose lines are on Accounts Receivable and Payable', () => {
    const accounts = [
      { id: 'bank', stands_for: 'bank' as const },
      { id: 'ar', stands_for: 'system' as const },
      { id: 'ap', stands_for: 'system' as const },
    ];
    const line = (account_id: string, debit: number, credit: number) => ({
      entry_key: 'contra:x',
      entry_date: '2026-10-15',
      source: 'contra' as const,
      source_id: 'x',
      source_no: 'CT-0001',
      description: 'Contra CT-0001 with A',
      account_id,
      debit,
      credit,
    });
    expect(cashMovements([line('ap', 100, 0), line('ar', 0, 100)], accounts)).toEqual([]);
  });
});

describe('listContras keeps every request short', () => {
  it('sends the ids of many contras in chunks, never in one filter', async () => {
    const N = 250;
    const contras = Array.from({ length: N }, (_, i) => ({
      id: UUID(1000 + i), contra_no: `CT-${i}`, contra_date: '2026-10-15', contact_id: UUID(2000 + i), amount: 10,
      reference: null, notes: null, status: 'posted', posted_at: null, voided_at: null,
    }));
    const lines = contras.flatMap((c, i) => [
      { id: UUID(3000 + i), contra_id: c.id, invoice_id: UUID(4000 + i), bill_id: null, amount: 10 },
      { id: UUID(5000 + i), contra_id: c.id, invoice_id: null, bill_id: UUID(6000 + i), amount: 10 },
    ]);
    const filters: { table: string; size: number }[] = [];
    const client = {
      from: (table: string) => {
        let ids: string[] | null = null;
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: (_c: string, values: string[]) => {
            ids = values;
            filters.push({ table, size: values.length });
            return chain;
          },
          order: () => chain,
          range: async () => {
            if (table === 'finance_contras') return { data: contras, error: null };
            if (table === 'finance_contra_lines') return { data: lines, error: null };
            if (table === 'finance_contacts') return { data: (ids ?? []).map((id) => ({ id, name: 'N' })), error: null };
            if (table === 'finance_invoices') return { data: (ids ?? []).map((id) => ({ id, invoice_no: 'INV' })), error: null };
            return { data: (ids ?? []).map((id) => ({ id, bill_no: 'BILL' })), error: null };
          },
        };
        return chain;
      },
    };
    const rows = await listContras({ client, orgId: UUID(9) } as unknown as FinanceWriteContext);
    expect(rows).toHaveLength(N);
    expect(rows[0].invoices[0].document_no).toBe('INV');
    expect(rows[0].contact_name).toBe('N');
    expect(filters.length).toBeGreaterThan(3);
    expect(Math.max(...filters.map((f) => f.size))).toBeLessThanOrEqual(CONTRA_ID_CHUNK);
    expect(filters.filter((f) => f.table === 'finance_invoices').reduce((t, f) => t + f.size, 0)).toBe(N);
  });
});
