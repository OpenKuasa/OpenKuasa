/**
 * What supplier bills and invoices share: a document dated with a real
 * calendar date, carrying lines of quantity × unit price with an SST rate.
 * The schemas round first and validate after, so parsing their own output
 * changes nothing. Pure, with no server imports.
 */
import { z } from 'zod';

export const DOCUMENT_LINES_MAX = 100;

export const LINE_MESSAGES = {
  date: 'Enter a valid date.',
  lines: 'Add at least one line.',
  description: 'Describe each line.',
  quantity: 'Enter a quantity above 0.',
  price: 'Enter a unit price of 0 or more.',
  sst: 'Enter an SST rate between 0 and 100.',
  tooLong: 'That is too long. Keep it to 200 characters or fewer.',
  product: 'Choose a product from the list, or leave it empty.',
} as const;

const M = LINE_MESSAGES;

/** YYYY-MM-DD that is a real calendar date from 1900 to 2200; a slipped key gives year 0202. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2200) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const round = (places: number) => (v: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * An SST rate as the column numeric(5,2) stores it: two decimals, half away
 * from zero, rounded on the figure as written. 1.005 is 1.01 here and in the
 * database, where `Math.round(1.005 * 100)` and `(1.005).toFixed(2)` both
 * give 1.00, because the nearest floating point number is a hair below 1.005.
 * Something that is not a number comes back as it was.
 */
export function roundRate(value: number): number {
  if (!Number.isFinite(value)) return value;
  // The shortest digits that give this number back, e.g. "1.005e+0": shift the point two places in the text.
  const [digits, exponent] = Math.abs(value).toExponential().split('e');
  const hundredths = Math.round(Number(`${digits}e${Number(exponent) + 2}`));
  return (Math.sign(value) * hundredths) / 100;
}

export const isoDate = z.string({ error: M.date }).refine(isIsoDate, M.date);

/** Optional text: trimmed, at most 200 characters, and an empty box is stored as null. */
export const optionalText = z
  .string({ error: M.tooLong })
  .trim()
  .max(200, M.tooLong)
  .transform((v) => (v === '' ? null : v))
  .nullable();

/**
 * An amount of money typed by a person: rounded to the sen first, then it must
 * be above zero and fit the column numeric(14,2). `message` is the sentence
 * for anything else.
 */
export function ringgitAmount(message: string) {
  return z
    .number({ error: message })
    .transform(round(2))
    .pipe(z.number().gt(0, message).max(999_999_999_999.99, message));
}

/** An id, or nothing chosen (an empty string from a select). */
const optionalId = z
  .union([z.string().uuid(M.product), z.literal(''), z.null()], { error: M.product })
  .transform((v) => (v === '' ? null : v));

/** One line of a bill or an invoice, as the database functions take it. */
export const documentLine = z.object({
  product_id: optionalId.default(null),
  description: z.string({ error: M.description }).trim().min(1, M.description).max(200, M.tooLong),
  quantity: z.number({ error: M.quantity }).transform(round(3)).pipe(z.number().gt(0, M.quantity).max(99_999_999, M.quantity)),
  uom: optionalText.default(null),
  pack_size: optionalText.default(null),
  unit_price: z.number({ error: M.price }).min(0, M.price).max(999_999_999, M.price).transform(round(4)),
  sst_rate: z.number({ error: M.sst }).transform(roundRate).pipe(z.number().min(0, M.sst).max(100, M.sst)).default(0),
});

export const DISCOUNT_MESSAGES = {
  pct: 'Enter a discount between 0 and 100%.',
  amount: 'Enter a discount of RM 0 or more.',
  both: 'Give a percentage discount or a ringgit discount, not both.',
  over: 'A discount cannot be more than the line.',
} as const;

const D = DISCOUNT_MESSAGES;

/**
 * A sales line (invoice or quotation) is a document line that may carry a
 * discount: a percentage of the line, or a fixed ringgit amount off it, but
 * not both. An empty or zero discount is stored as none. The amount cannot be
 * more than the line; the database checks the same, net of the discount.
 * Bills, RFQs and purchase orders use the plain `documentLine` and have none.
 */
export const salesDocumentLine = documentLine
  .extend({
    discount_pct: z.number({ error: D.pct }).min(0, D.pct).max(100, D.pct).transform(round(2)).nullable().default(null),
    discount_amount: z.number({ error: D.amount }).min(0, D.amount).max(999_999_999_999.99, D.amount).transform(round(2)).nullable().default(null),
  })
  .transform((l) => ({
    ...l,
    discount_pct: l.discount_pct && l.discount_pct > 0 ? l.discount_pct : null,
    discount_amount: l.discount_amount && l.discount_amount > 0 ? l.discount_amount : null,
  }))
  .refine((l) => !(l.discount_pct !== null && l.discount_amount !== null), { message: D.both, path: ['discount_amount'] })
  .refine((l) => l.discount_amount === null || l.discount_amount <= round(2)(l.quantity * l.unit_price), {
    message: D.over,
    path: ['discount_amount'],
  });

/** A saved line, as it is read back: the amounts are the database's generated columns. */
export type DocumentLineRow = {
  id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  uom: string | null;
  pack_size: string | null;
  unit_price: number;
  sst_rate: number;
  amount: number;
  sst_amount: number;
  /** Present only on sales lines (invoices, quotations). At most one is non-null. */
  discount_pct?: number | null;
  discount_amount?: number | null;
};

export const DOCUMENT_LINE_COLUMNS = 'id,product_id,description,quantity,uom,pack_size,unit_price,sst_rate,amount,sst_amount';

/** The columns above plus the sales-only discount; use for invoices and quotations. */
export const SALES_LINE_COLUMNS = `${DOCUMENT_LINE_COLUMNS},discount_pct,discount_amount`;

/** A line as read from the database, with its figures as numbers whatever form they arrived in. */
export function toDocumentLine(row: Record<string, unknown>): DocumentLineRow {
  const line: DocumentLineRow = {
    ...(row as unknown as DocumentLineRow),
    quantity: Number(row.quantity),
    unit_price: Number(row.unit_price),
    sst_rate: Number(row.sst_rate),
    amount: Number(row.amount),
    sst_amount: Number(row.sst_amount),
  };
  // Only sales lines are read with the discount columns; leave the field off other documents.
  if ('discount_pct' in row) line.discount_pct = row.discount_pct == null ? null : Number(row.discount_pct);
  if ('discount_amount' in row) line.discount_amount = row.discount_amount == null ? null : Number(row.discount_amount);
  return line;
}
