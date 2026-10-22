/**
 * The reads and writes behind the SST Report's return (#222 stage 2): the invoice-line and credit-note rows a
 * return for one span needs, in the shapes sst-return.ts builds from, and marking a return as filed
 * (finance_sst_returns, 20261125090300_bendahara_sst_returns.sql).
 *
 * Reading is every member's. Marking and unmarking are an owner's or admin's (42501 otherwise). The table has
 * no update grant, so marking is a plain insert: a period already marked answers ok and keeps its first date.
 *
 * Stage 5: the figures typed in per return (finance_sst_return_figures,
 * 20261125100000_bendahara_sst_return_figures.sql): 11(e) cards, 13(b), 13(c), 13(d) and 13A. Saving is an owner's or admin's, and refused while the return is marked filed (FIN60).
 */
import { z } from 'zod';
import { addDays, malaysiaDate } from '@/lib/people/dates';
import { type FinanceWriteContext, PG_FORBIDDEN, PG_UNIQUE, pgCode, writeFailed } from './result';
import { type SstTaxType, sstPeriodFor, taxTypeForRate } from './sst';
import type { SstCreditRow, SstLineRow, SstReturnType, SstTypedFigures } from './sst-return';

export const SST_RETURN_PAGE_SIZE = 1000;
/** Invoice ids per `in (...)` filter, to keep the URL short. */
const ID_CHUNK = 200;

export const SST_RETURN_NEEDS_SIGN_OFF = 'Only an owner or admin can mark a return as filed.';
export const SST_RETURN_NOT_ENDED = 'You can mark a return as filed once its period has ended.';
const PERIOD_START = /^\d{4}-(0[1-9]|1[0-2])-01$/;

export const sstReturnInput = z.object({
  type: z.enum(['service', 'sales'], { error: 'Choose service tax or sales tax.' }),
  period_start: z
    .string({ error: 'Choose a taxable period.' })
    .regex(PERIOD_START, 'Choose a taxable period: it starts on the first of a month.'),
});
export type SstReturnInput = z.infer<typeof sstReturnInput>;

const num = (v: unknown) => Number(v ?? 0);
const toSen = (amount: number) => Math.round(amount * 100);
const fromSen = (sen: number) => sen / 100;

type InvoiceEmbed = { invoice_date: string; status: string; voided_at: string | null };

/** One line row as PostgREST returns it (with its invoice embedded), in the shape buildSstReturn reads. */
export function toSstLineRow(raw: Record<string, unknown>): SstLineRow {
  const inv = raw.finance_invoices as InvoiceEmbed;
  const voidedAt = inv.status === 'void' ? inv.voided_at : null;
  return {
    id: raw.id as string,
    invoice_id: raw.invoice_id as string,
    product_id: (raw.product_id as string | null) ?? null,
    description: (raw.description as string | null) ?? '',
    sst_rate: num(raw.sst_rate),
    tax_type: (raw.tax_type as SstTaxType | null) ?? null,
    sst_code: (raw.sst_code as string | null) ?? null,
    amount_myr: num(raw.amount_myr),
    sst_amount_myr: num(raw.sst_amount_myr),
    invoice_date: inv.invoice_date,
    // A void invoice with no voided_at keeps voided_on null; buildSstReturn then counts it nowhere.
    invoice_status: inv.status === 'void' ? 'void' : 'posted',
    voided_on: voidedAt ? malaysiaDate(voidedAt) : null,
  };
}

/** One credit-note row, with its invoice's ringgit total and SST per type. A ringgit note's amount_myr is null: its amount is ringgit. */
export function toSstCreditRow(
  raw: Record<string, unknown>,
  invoice: { total: number; sst: Record<SstReturnType, number> },
): SstCreditRow {
  const voidedAt = raw.status === 'void' ? ((raw.voided_at as string | null) ?? null) : null;
  return {
    id: raw.id as string,
    credit_date: raw.credit_date as string,
    // A void note with no voided_at keeps voided_on null; buildSstReturn then counts it nowhere.
    status: raw.status === 'void' ? 'void' : 'issued',
    voided_on: voidedAt ? malaysiaDate(voidedAt) : null,
    amount_myr: num(raw.amount_myr ?? raw.amount),
    invoice_total_myr: invoice.total,
    invoice_sst_myr: { service: invoice.sst.service, sales: invoice.sst.sales },
  };
}

const LINE_COLUMNS =
  'id,invoice_id,product_id,description,sst_rate,tax_type,sst_code,amount_myr,sst_amount_myr,finance_invoices!inner(invoice_date,status,voided_at)';
const CREDIT_COLUMNS = 'id,invoice_id,credit_date,status,voided_at,amount,amount_myr';

type Query = {
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
};

/** Every row of a query, a page at a time, ordered by the caller. Throws when a read fails. */
async function allPages(page: () => Query): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += SST_RETURN_PAGE_SIZE) {
    const { data, error } = await page().range(from, from + SST_RETURN_PAGE_SIZE - 1);
    if (error) throw error;
    const got = (data ?? []) as Record<string, unknown>[];
    rows.push(...got);
    if (got.length < SST_RETURN_PAGE_SIZE) return rows;
  }
}

/** Rows of both reads, each once (a document dated and voided in the span is in both). */
function byId(...lists: Record<string, unknown>[][]): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const list of lists) for (const r of list) seen.set(r.id as string, r);
  return [...seen.values()];
}

type InvoiceTotals = { total: number; sst: Record<SstReturnType, number> };

/** Each invoice's ringgit total (amount plus SST) and SST per type, over all its lines, whatever their date. */
async function invoiceTotals(ctx: FinanceWriteContext, ids: string[]): Promise<Map<string, InvoiceTotals>> {
  const sen = new Map<string, { total: number; service: number; sales: number }>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const lines = await allPages(() =>
      ctx.client
        .from('finance_invoice_lines')
        .select('id,invoice_id,sst_rate,tax_type,amount_myr,sst_amount_myr')
        .eq('org_id', ctx.orgId)
        .in('invoice_id', chunk)
        .order('id', { ascending: true }),
    );
    for (const l of lines) {
      const id = l.invoice_id as string;
      const t = sen.get(id) ?? { total: 0, service: 0, sales: 0 };
      const tax = toSen(num(l.sst_amount_myr));
      t.total += toSen(num(l.amount_myr)) + tax;
      const type = (l.tax_type as SstTaxType | null) ?? taxTypeForRate(num(l.sst_rate));
      if (type === 'service' || type === 'sales') t[type] += tax;
      sen.set(id, t);
    }
  }
  const out = new Map<string, InvoiceTotals>();
  for (const [id, t] of sen) out.set(id, { total: fromSen(t.total), sst: { service: fromSen(t.service), sales: fromSen(t.sales) } });
  return out;
}

/**
 * The rows a return for `span` (start and end, YYYY-MM-DD) is built from: lines of invoices posted or voided
 * whose invoice date is in the span, plus lines of invoices voided (in Malaysia) within it; credit notes issued
 * or voided whose credit date is in the span, plus those voided within it, each with its invoice's totals.
 * buildSstReturn places each row by its dates. Throws when a read fails.
 */
export async function readSstRows(
  ctx: FinanceWriteContext,
  span: { start: string; end: string },
): Promise<{ lines: SstLineRow[]; credits: SstCreditRow[] }> {
  // voided_at is an instant: the span in Malaysia runs from its first midnight to the midnight after its end.
  const voidFrom = `${span.start}T00:00:00+08:00`;
  const voidTo = `${addDays(span.end, 1)}T00:00:00+08:00`;

  const lines = () => ctx.client.from('finance_invoice_lines').select(LINE_COLUMNS).eq('org_id', ctx.orgId);
  const credits = () => ctx.client.from('finance_credit_notes').select(CREDIT_COLUMNS).eq('org_id', ctx.orgId);

  const [datedLines, voidedLines, datedCredits, voidedCredits] = await Promise.all([
    allPages(() =>
      lines()
        .in('finance_invoices.status', ['posted', 'void'])
        .gte('finance_invoices.invoice_date', span.start)
        .lte('finance_invoices.invoice_date', span.end)
        .order('id', { ascending: true }),
    ),
    allPages(() =>
      lines()
        .eq('finance_invoices.status', 'void')
        .gte('finance_invoices.voided_at', voidFrom)
        .lt('finance_invoices.voided_at', voidTo)
        .order('id', { ascending: true }),
    ),
    allPages(() =>
      credits().in('status', ['issued', 'void']).gte('credit_date', span.start).lte('credit_date', span.end).order('id', { ascending: true }),
    ),
    allPages(() => credits().eq('status', 'void').gte('voided_at', voidFrom).lt('voided_at', voidTo).order('id', { ascending: true })),
  ]);

  const creditRows = byId(datedCredits, voidedCredits);
  const totals = await invoiceTotals(ctx, [...new Set(creditRows.map((c) => c.invoice_id as string))]);
  const none: InvoiceTotals = { total: 0, sst: { service: 0, sales: 0 } };

  return {
    lines: byId(datedLines, voidedLines).map(toSstLineRow),
    credits: creditRows.map((c) => toSstCreditRow(c, totals.get(c.invoice_id as string) ?? none)),
  };
}

/** The periods of one tax type marked filed: period start → the date it was marked. Throws when the read fails. */
export async function listSstFiled(ctx: FinanceWriteContext, type: SstReturnType): Promise<Record<string, string>> {
  const rows = await allPages(() =>
    ctx.client
      .from('finance_sst_returns')
      .select('period_start,filed_on')
      .eq('org_id', ctx.orgId)
      .eq('tax_type', type)
      .order('period_start', { ascending: true }),
  );
  return Object.fromEntries(rows.map((r) => [r.period_start as string, r.filed_on as string]));
}

/**
 * Marks a return filed on `today` (Malaysian). Only once its period has ended: a two-month period starting on
 * `period_start` ends on the last day of the month after. Already marked answers ok, keeping the first date.
 */
export async function markSstReturnFiled(
  ctx: FinanceWriteContext,
  input: SstReturnInput,
  today: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const start = input.period_start;
  if (sstPeriodFor(start, Number(start.slice(5, 7))).end >= today) return { ok: false, error: SST_RETURN_NOT_ENDED };
  const { error } = await ctx.client
    .from('finance_sst_returns')
    .insert({ org_id: ctx.orgId, tax_type: input.type, period_start: start, filed_on: today });
  if (error) {
    if (pgCode(error) === PG_UNIQUE) return { ok: true };
    if (pgCode(error) === PG_FORBIDDEN) return { ok: false, error: SST_RETURN_NEEDS_SIGN_OFF };
    return writeFailed('markSstReturnFiled', error);
  }
  return { ok: true };
}

/** Takes the filed mark off a return. Nothing marked answers ok. */
export async function unmarkSstReturnFiled(
  ctx: FinanceWriteContext,
  input: SstReturnInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await ctx.client
    .from('finance_sst_returns')
    .delete()
    .eq('org_id', ctx.orgId)
    .eq('tax_type', input.type)
    .eq('period_start', input.period_start);
  if (error) {
    if (pgCode(error) === PG_FORBIDDEN) return { ok: false, error: SST_RETURN_NEEDS_SIGN_OFF };
    return writeFailed('unmarkSstReturnFiled', error);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ typed-in figures (stage 5) */

export const SST_FIGURES_FILED = 'This return is marked filed. Undo the mark to change its figures.';
export const SST_FIGURES_NEEDS_SIGN_OFF = 'Only an owner or admin can change the typed-in figures.';
/** The return is marked filed (private trigger on finance_sst_return_figures). */
const FIN_SST_FIGURES_FILED = 'FIN60';

const MAX_AMOUNT_SEN = 999_999_999_999;
const MAX_CARDS = 10_000_000;
/** Ringgit as typed: digits with optional thousands commas, and up to two decimals. No sign, no exponent. */
const AMOUNT_TEXT = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;
const CARDS_TEXT = /^(\d{1,3}(,\d{3})+|\d+)$/;

/** An amount box: text or a number, empty or absent as 0, to two decimals, 0 to 9,999,999,999.99. */
function amountField(item: string) {
  const wrong = `Enter ${item} as an amount in ringgit, like 1,234.50.`;
  return z.unknown().optional().transform((v, ctx): number => {
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) return 0;
    // A number is read as its shortest text, so 12.345 and 1e21 are refused just as typed text would be.
    const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (!AMOUNT_TEXT.test(text)) {
      ctx.addIssue({ code: 'custom', message: wrong });
      return z.NEVER;
    }
    const sen = Math.round(Number(text.replaceAll(',', '')) * 100);
    if (sen > MAX_AMOUNT_SEN) {
      ctx.addIssue({ code: 'custom', message: `${item} can be at most 9,999,999,999.99.` });
      return z.NEVER;
    }
    return sen / 100;
  });
}

/** The cards box: a whole number, empty or absent as 0, 0 to 10,000,000. */
function cardsField(item: string) {
  const wrong = `Enter ${item} as a whole number of cards, like 12.`;
  return z.unknown().optional().transform((v, ctx): number => {
    let count: number;
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) return 0;
    if (typeof v === 'string' && CARDS_TEXT.test(v.trim())) count = Number(v.trim().replaceAll(',', ''));
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) count = v;
    else {
      ctx.addIssue({ code: 'custom', message: wrong });
      return z.NEVER;
    }
    if (count > MAX_CARDS) {
      ctx.addIssue({ code: 'custom', message: `${item} can be at most 10,000,000 cards.` });
      return z.NEVER;
    }
    return count;
  });
}

/** Which return each box belongs to: 13(d) is on both. */
const ONLY_ON: Record<string, { type: SstReturnType; item: string }> = {
  cards_11e: { type: 'service', item: '11(e)' },
  deduction_13c: { type: 'service', item: '13(c)' },
  deduction_13b: { type: 'sales', item: '13(b)' },
  adjustment_13a: { type: 'sales', item: '13A' },
};

/**
 * The figures of one return. The other type's boxes must be 0 or absent (so a sales figure never reaches a
 * service return, nor the reverse) and are stored as 0, which the table's check also requires.
 */
export const sstFiguresInput = sstReturnInput
  .extend({
    cards_11e: cardsField('11(e)'),
    deduction_13b: amountField('13(b)'),
    deduction_13c: amountField('13(c)'),
    bad_debt_13d: amountField('13(d)'),
    adjustment_13a: amountField('13A'),
  })
  .superRefine((v, ctx) => {
    for (const [field, only] of Object.entries(ONLY_ON)) {
      if (only.type !== v.type && v[field as keyof typeof v] !== 0) {
        const name = only.type === 'service' ? 'service' : 'sales';
        ctx.addIssue({ code: 'custom', message: `${only.item} is on the ${name} tax return only.`, path: [field] });
      }
    }
  });
export type SstFiguresInput = z.infer<typeof sstFiguresInput>;

/** One type's typed-in figures: period start → figures. A period with no row has none (zeros). Throws when the read fails. */
export async function listSstFigures(ctx: FinanceWriteContext, type: SstReturnType): Promise<Record<string, SstTypedFigures>> {
  const rows = await allPages(() =>
    ctx.client
      .from('finance_sst_return_figures')
      .select('period_start,cards_11e,deduction_13b,deduction_13c,bad_debt_13d,adjustment_13a')
      .eq('org_id', ctx.orgId)
      .eq('tax_type', type)
      .order('period_start', { ascending: true }),
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.period_start as string,
      {
        cards11e: num(r.cards_11e),
        deduction13b: num(r.deduction_13b),
        deduction13c: num(r.deduction_13c),
        badDebt13d: num(r.bad_debt_13d),
        adjustment13a: num(r.adjustment_13a),
      },
    ]),
  );
}

/**
 * Saves a return's figures: all five columns, the other type's as 0, inserted or updated on the return's key.
 * Refused while the return is marked filed (FIN60) and for anyone but an owner or admin (42501).
 */
export async function saveSstFigures(
  ctx: FinanceWriteContext,
  input: SstFiguresInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const service = input.type === 'service';
  const { error } = await ctx.client.from('finance_sst_return_figures').upsert(
    {
      org_id: ctx.orgId,
      tax_type: input.type,
      period_start: input.period_start,
      cards_11e: service ? input.cards_11e : 0,
      deduction_13b: service ? 0 : input.deduction_13b,
      deduction_13c: service ? input.deduction_13c : 0,
      bad_debt_13d: input.bad_debt_13d,
      adjustment_13a: service ? 0 : input.adjustment_13a,
    },
    { onConflict: 'org_id,tax_type,period_start' },
  );
  if (error) {
    if (pgCode(error) === FIN_SST_FIGURES_FILED) return { ok: false, error: SST_FIGURES_FILED };
    if (pgCode(error) === PG_FORBIDDEN) return { ok: false, error: SST_FIGURES_NEEDS_SIGN_OFF };
    // FIN61 (a key change) cannot come from an upsert on the key; it and a check refusal (23514) are logged.
    return writeFailed('saveSstFigures', error);
  }
  return { ok: true };
}
