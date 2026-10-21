/**
 * SST: the tax type of a product or invoice line, the two-month taxable periods the SST-02 return is made
 * for, and the workspace's SST settings (finance_sst_settings, 20261124100000_bendahara_sst_settings.sql).
 *
 * Reading the settings is every member's; saving them is an owner's or admin's (42501 otherwise). All date
 * arithmetic is on ISO strings and UTC, never local time.
 */
import { z } from 'zod';
import { type FinanceWriteContext, PG_FORBIDDEN, pgCode, writeFailed } from './result';

export type SstTaxType = 'sales' | 'service' | 'none';
export const SST_TAX_TYPES: readonly SstTaxType[] = ['sales', 'service', 'none'];
export const SST_TAX_TYPE_LABELS: Record<SstTaxType, string> = { sales: 'Sales tax', service: 'Service tax', none: 'No SST' };

/**
 * THE rule from a rate to a tax type: 5 and 10 are sales tax, 6 and 8 service tax, 0 none; any other rate has
 * no type and a person picks one. Its SQL twin is private.finance_sst_tax_type_for_rate
 * (supabase/migrations/20261124100000_bendahara_sst_settings.sql); change both together.
 */
export function taxTypeForRate(rate: number): SstTaxType | null {
  if (rate === 5 || rate === 10) return 'sales';
  if (rate === 6 || rate === 8) return 'service';
  if (rate === 0) return 'none';
  return null;
}

/** The longest SST code (the schedule item) on a product or line. */
export const SST_CODE_MAX = 20;
/** The longest registration number. */
export const SST_NUMBER_MAX = 35;

export type SstBasis = 'payment' | 'invoice';
export type SstSettings = {
  period_start_month: number;
  service_tax_no: string | null;
  sales_tax_no: string | null;
  service_tax_basis: SstBasis;
};

const registrationNo = (label: string) =>
  z
    .string({ error: `Enter the ${label}.` })
    .transform((s) => s.replace(/^ +| +$/g, ''))
    .transform((s) => (s === '' ? null : s))
    .pipe(z.string().max(SST_NUMBER_MAX, `Keep the ${label} to ${SST_NUMBER_MAX} characters or fewer.`).nullable())
    .nullish()
    .transform((v) => v ?? null);

export const sstSettingsInput = z.object({
  period_start_month: z
    .number({ error: 'Choose the month the first taxable period starts.' })
    .int('Choose the month the first taxable period starts.')
    .min(1, 'Choose the month the first taxable period starts.')
    .max(12, 'Choose the month the first taxable period starts.'),
  service_tax_no: registrationNo('service tax registration number'),
  sales_tax_no: registrationNo('sales tax registration number'),
  service_tax_basis: z.enum(['payment', 'invoice'], { error: 'Choose payment or invoice.' }).default('payment'),
});

export type SstPeriod = { start: string; end: string; due: string };

const pad = (n: number) => String(n).padStart(2, '0');
/** The last day of a month (month 1-12), by UTC arithmetic. */
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/**
 * The two-month taxable period a date falls in, when the first period of the year starts in `startMonth`
 * (1-12), and the day the return is due: the last day of the month after the period ends. Only the parity of
 * the start month matters for two-month periods.
 */
export function sstPeriodFor(date: string, startMonth: number): SstPeriod {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const offset = (((month - startMonth) % 2) + 2) % 2;
  let sy = year;
  let sm = month - offset;
  if (sm < 1) {
    sm += 12;
    sy -= 1;
  }
  let ey = sy;
  let em = sm + 1;
  if (em > 12) {
    em -= 12;
    ey += 1;
  }
  let dy = ey;
  let dm = em + 1;
  if (dm > 12) {
    dm -= 12;
    dy += 1;
  }
  return {
    start: iso(sy, sm, 1),
    end: iso(ey, em, lastDay(ey, em)),
    due: iso(dy, dm, lastDay(dy, dm)),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '1 Sep – 31 Oct 2026', or '1 Dec 2026 – 31 Jan 2027' across a year end. */
export function sstPeriodLabel(p: SstPeriod): string {
  const part = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
  const sy = p.start.slice(0, 4);
  const ey = p.end.slice(0, 4);
  return sy === ey ? `${part(p.start)} – ${part(p.end)} ${ey}` : `${part(p.start)} ${sy} – ${part(p.end)} ${ey}`;
}

export const SST_NEEDS_SIGN_OFF = 'Only an owner or admin can change SST settings.';

/** The workspace's SST settings, or null before anyone has saved them. */
export async function getSstSettings(ctx: FinanceWriteContext): Promise<SstSettings | null> {
  const { data, error } = await ctx.client
    .from('finance_sst_settings')
    .select('period_start_month, service_tax_no, sales_tax_no, service_tax_basis')
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (error) {
    console.error('[finance] getSstSettings failed:', error);
    return null;
  }
  return (data as SstSettings | null) ?? null;
}

export async function saveSstSettings(ctx: FinanceWriteContext, input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = sstSettingsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the SST settings and try again.' };
  const { error } = await ctx.client
    .from('finance_sst_settings')
    .upsert({ org_id: ctx.orgId, ...parsed.data }, { onConflict: 'org_id' });
  if (error) {
    if (pgCode(error) === PG_FORBIDDEN) return { ok: false, error: SST_NEEDS_SIGN_OFF };
    return writeFailed('saveSstSettings', error);
  }
  return { ok: true };
}
