import { z } from 'zod';
import { todayInMalaysia } from '@/lib/people/dates';
import { isIsoDate } from './document-lines';
import {
  BAD_PREFIX,
  FUTURE_LOCK,
  type FinanceWriteContext,
  type FinResult,
  LOCKED,
  NOT_ALLOWED,
  NUMBER_BACK,
  PG_FORBIDDEN,
  PREFIX_TAKEN,
  pgCode,
  writeFailed,
} from './result';

/** A kind of document that takes a number from `finance_sequences` (the keys of `public.finance_next_number`). */
export type SequenceDoc =
  | 'invoice'
  | 'quotation'
  | 'credit_note'
  | 'bill'
  | 'receipt'
  | 'voucher'
  | 'transfer'
  | 'rfq'
  | 'purchase_order'
  | 'journal'
  | 'contra'
  | 'fx_revaluation'
  | 'supplier_credit_note';

/** The months by name, January first: `MONTHS[month - 1]` for a month numbered 1–12. */
export const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Every numbered document, its name, and the prefix it starts with. */
export const SEQUENCE_DOCS: { doc: SequenceDoc; label: string; defaultPrefix: string }[] = [
  { doc: 'invoice', label: 'Invoice', defaultPrefix: 'INV-' },
  { doc: 'quotation', label: 'Quotation', defaultPrefix: 'QT-' },
  { doc: 'credit_note', label: 'Credit note', defaultPrefix: 'CN-' },
  { doc: 'bill', label: 'Supplier bill', defaultPrefix: 'BILL-' },
  { doc: 'receipt', label: 'Receipt', defaultPrefix: 'RC-' },
  { doc: 'voucher', label: 'Payment voucher', defaultPrefix: 'PV-' },
  { doc: 'transfer', label: 'Transfer', defaultPrefix: 'TR-' },
  { doc: 'rfq', label: 'RFQ', defaultPrefix: 'RFQ-' },
  { doc: 'purchase_order', label: 'Purchase order', defaultPrefix: 'PO-' },
  { doc: 'journal', label: 'Journal', defaultPrefix: 'JV-' },
  { doc: 'contra', label: 'Contra entry', defaultPrefix: 'CT-' },
  { doc: 'fx_revaluation', label: 'FX revaluation', defaultPrefix: 'FX-' },
  { doc: 'supplier_credit_note', label: 'Supplier credit note', defaultPrefix: 'SCN-' },
];

/** The workspace's accounting settings: the month its financial year ends (1–12) and the books lock date. */
export type FinanceSettings = { yearEndMonth: number; lockDate: string | null; updatedAt: string | null };

/** One numbered document's next number. */
export type SequenceRow = { doc: SequenceDoc; label: string; prefix: string; nextNumber: number; pad: number };

/** A workspace that never saved settings: a December year end and open books. */
export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = { yearEndMonth: 12, lockDate: null, updatedAt: null };

/**
 * What a person reads when the database refuses a settings change (FIN63–FIN67). The sentences live in result.ts,
 * beside `writeFailed`, which answers them for every finance write.
 */
export const SETTINGS_MESSAGES = {
  locked: LOCKED,
  futureLock: FUTURE_LOCK,
  numberBack: NUMBER_BACK,
  badPrefix: BAD_PREFIX,
  prefixTaken: PREFIX_TAKEN,
};

/** Told to a member who tries to change the accounting settings. */
export const SETTINGS_NEEDS_SIGN_OFF = 'Only an owner or admin can change accounting settings.';

const YEAR_END_MESSAGE = 'Choose the month your financial year ends.';
const LOCK_DATE_MESSAGE = 'Enter a valid lock date.';
const NEXT_NUMBER_MESSAGE = 'The next number is a whole number from 1 to 999999999.';
/** The largest next number: it fits the database's integer column with room to count on. */
export const NEXT_NUMBER_MAX = 999_999_999;

/**
 * The financial year end and the books lock date. An empty lock date means open books. A lock date after today
 * in Malaysia is refused (the database refuses it too, FIN64).
 */
export const financeSettingsInput: z.ZodType<{ yearEndMonth: number; lockDate: string | null }> = z
  .object({
    yearEndMonth: z
      .number({ error: YEAR_END_MESSAGE })
      .int(YEAR_END_MESSAGE)
      .min(1, YEAR_END_MESSAGE)
      .max(12, YEAR_END_MESSAGE),
    lockDate: z
      .string({ error: LOCK_DATE_MESSAGE })
      .trim()
      .transform((v) => (v === '' ? null : v))
      .pipe(z.string().refine(isIsoDate, LOCK_DATE_MESSAGE).nullable())
      .nullish()
      .transform((v) => v ?? null),
  })
  .refine((v) => v.lockDate === null || v.lockDate <= todayInMalaysia(new Date()), {
    message: FUTURE_LOCK,
    path: ['lockDate'],
  });

const DOC_KEYS = SEQUENCE_DOCS.map((d) => d.doc) as [SequenceDoc, ...SequenceDoc[]];

/** One document's numbering: its prefix (trimmed and upper-cased) and the next number it takes. */
export const sequenceInput: z.ZodType<{ doc: SequenceDoc; prefix: string; nextNumber: number }> = z.object({
  doc: z.enum(DOC_KEYS, { error: 'Choose a document.' }),
  prefix: z
    .string({ error: BAD_PREFIX })
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9/-]{1,10}$/, BAD_PREFIX)),
  nextNumber: z
    .number({ error: NEXT_NUMBER_MESSAGE })
    .int(NEXT_NUMBER_MESSAGE)
    .min(1, NEXT_NUMBER_MESSAGE)
    .max(NEXT_NUMBER_MAX, NEXT_NUMBER_MESSAGE),
});

type SettingsRow = { year_end_month: number; lock_date: string | null; updated_at: string | null };
const SETTINGS_COLUMNS = 'year_end_month, lock_date, updated_at';

const fromRow = (row: SettingsRow): FinanceSettings => ({
  yearEndMonth: row.year_end_month,
  lockDate: row.lock_date,
  updatedAt: row.updated_at,
});

/**
 * The workspace's accounting settings, or the defaults (December, open books) before anyone has saved them.
 * A failed read throws: a settings form shown with the defaults after a failed read would, once saved, reopen
 * the books.
 */
export async function getFinanceSettings(ctx: FinanceWriteContext): Promise<FinanceSettings> {
  const { data, error } = await ctx.client
    .from('finance_settings')
    .select(SETTINGS_COLUMNS)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data as SettingsRow) : DEFAULT_FINANCE_SETTINGS;
}

/**
 * The settings for a screen or a tool that only reads them for its periods: a failed read is logged and the
 * defaults used, so a report never breaks on it. The settings screen itself uses `getFinanceSettings`.
 */
export async function financeSettingsOrDefault(ctx: FinanceWriteContext, where: string): Promise<FinanceSettings> {
  try {
    return await getFinanceSettings(ctx);
  } catch (error) {
    console.error(`[finance] ${where}: the accounting settings could not be read:`, error);
    return DEFAULT_FINANCE_SETTINGS;
  }
}

/** Saves the year end and the lock date (an owner or admin; the database checks again). */
export async function saveFinanceSettings(
  ctx: FinanceWriteContext,
  input: { yearEndMonth: number; lockDate: string | null },
): Promise<FinResult<FinanceSettings>> {
  const { data, error } = await ctx.client
    .from('finance_settings')
    .upsert({ org_id: ctx.orgId, year_end_month: input.yearEndMonth, lock_date: input.lockDate }, { onConflict: 'org_id' })
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) {
    if (pgCode(error) === PG_FORBIDDEN) return { ok: false, error: SETTINGS_NEEDS_SIGN_OFF };
    return writeFailed('saveFinanceSettings', error);
  }
  return { ok: true, data: fromRow(data as SettingsRow) };
}

type SequenceListRow = { doc_type: string; prefix: string; next_number: number; pad: number };

/** Every numbered document's prefix and next number, in the order of SEQUENCE_DOCS. A failed read throws. */
export async function listSequences(ctx: FinanceWriteContext): Promise<SequenceRow[]> {
  const { data, error } = await ctx.client.rpc('finance_sequence_list', { target_org: ctx.orgId });
  if (error) throw error;
  const byDoc = new Map(((data ?? []) as SequenceListRow[]).map((r) => [r.doc_type, r]));
  return SEQUENCE_DOCS.map(({ doc, label, defaultPrefix }) => {
    const row = byDoc.get(doc);
    return {
      doc,
      label,
      prefix: row?.prefix ?? defaultPrefix,
      nextNumber: row?.next_number ?? 1,
      pad: row?.pad ?? 4,
    };
  });
}

/** Changes a document's prefix and next number (an owner or admin). The next number can't go back (FIN65). */
export async function setSequence(
  ctx: FinanceWriteContext,
  input: { doc: SequenceDoc; prefix: string; nextNumber: number },
): Promise<FinResult<null>> {
  const { error } = await ctx.client.rpc('finance_set_sequence', {
    target_org: ctx.orgId,
    doc: input.doc,
    new_prefix: input.prefix,
    new_next: input.nextNumber,
  });
  if (error) {
    if (pgCode(error) === PG_FORBIDDEN) return { ok: false, error: NOT_ALLOWED };
    return writeFailed('setSequence', error);
  }
  return { ok: true, data: null };
}

/**
 * The number a document would take: the prefix and the next number padded with zeros to `pad` digits, never cut
 * (the rule of `public.finance_next_number`). INV- 43 4 → INV-0043.
 */
export function formatSequence(row: Pick<SequenceRow, 'prefix' | 'nextNumber' | 'pad'>): string {
  return row.prefix + String(row.nextNumber).padStart(row.pad, '0');
}
