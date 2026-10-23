import { z } from 'zod';

/** The longest tax identification number the company form takes. */
export const TIN_MAX = 20;
export const TIN_MESSAGE = 'A TIN is up to 20 letters and numbers.';

/**
 * The company's tax identification number (TIN), as the company form sends it: trimmed and upper-cased, up to
 * 20 letters and numbers, or empty for none. The database checks the same shape on `orgs.tin`
 * (20261125140000_bendahara_accounting_settings.sql).
 */
export const tinField = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === '' || /^[A-Z0-9]{1,20}$/.test(v), TIN_MESSAGE);
