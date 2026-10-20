/**
 * Money on a bank or cash account in another currency (stage 5b,
 * supabase/migrations/20261122110000_bendahara_fx_foreign_account_money.sql). A movement on such an account is in
 * the account's currency and is recorded as it moves, paid now, with its rate: Bank Negara Malaysia's 5 pm selling
 * rate for the movement's date (the one rule, `bnm` with its date), or one typed by hand (`manual`). The database
 * puts it into ringgit at that rate (amount_myr) and shares that ringgit over the documents it pays. What every
 * money form that may be on such an account shares: which accounts it offers, the rate it sends, and the ringgit it
 * comes to. Pure; rates travel as exact decimal text, and money is worked in whole sen (fx-settlement.ts).
 */
import { z } from 'zod';
import { BASE_CURRENCY } from './currencies';
import { CURRENCY_MESSAGES, type CurrencyFields, currencyPayload, ringgitFields, withCurrency } from './document-currency';
import { isIsoDate } from './document-lines';
import { rm } from './format';
import { movementRinggitText, ringgitOf, senFromText } from './fx-settlement';

/**
 * The sentences of a movement on an account in another currency. Each data layer maps the database's codes to them
 * itself (FIN38, FIN39, FIN47, FIN50); FIN51 is worded per kind of document, in each layer.
 */
export const MOVEMENT_MESSAGES = {
  // FIN38, and what the form says first.
  rate: 'Enter the exchange rate before recording this.',
  // FIN39: met from a direct call only (the form sends BNM's figure for the date it was asked for, or a typed one).
  notBnmRate: "That rate is not Bank Negara Malaysia's 5 pm selling rate for that day. Type it in again, and save.",
  // FIN47 on an account in another currency: the forms offer only "paid now" there, and tell a member first.
  payNow: 'Money on an account in another currency is recorded as paid, on the day it moves, by an owner or admin.',
  // FIN50 (narrowed in stage 5b): a draft on such an account, or a draft moved onto one. The draft forms list
  // ringgit accounts, so this is met from a stale tab or a direct call.
  draft: 'Money on an account in another currency is recorded when it moves, with its rate. Choose a ringgit account to save a draft.',
} as const;

/** The rate sent with a movement: per one unit, decimal text with at most ten places, above 0 (numeric(20,10)). */
const rateText = z
  .string({ error: MOVEMENT_MESSAGES.rate })
  .trim()
  .regex(/^\d{1,10}(\.\d{1,10})?$/, CURRENCY_MESSAGES.rate)
  .refine((v) => /[1-9]/.test(v), CURRENCY_MESSAGES.rate);

/**
 * The three keys a record function takes for a movement on an account in another currency, all optional (a ringgit
 * account sends none; the database asks for the rate when the account is foreign, FIN38). The finance assistant's
 * inputs omit them: it moves money on ringgit accounts only.
 */
export const movementRateFields = {
  fx_rate: rateText.optional(),
  fx_rate_source: z.enum(['bnm', 'manual'], { error: MOVEMENT_MESSAGES.rate }).optional(),
  fx_rate_date: z
    .string({ error: MOVEMENT_MESSAGES.notBnmRate })
    .refine(isIsoDate, MOVEMENT_MESSAGES.notBnmRate)
    .optional(),
};

/** The keys sent to the database: only those with a value (a missing key reads as "none"). */
export function movementRateKeys(input: { fx_rate?: string; fx_rate_source?: 'bnm' | 'manual'; fx_rate_date?: string }) {
  return {
    ...(input.fx_rate === undefined ? {} : { fx_rate: input.fx_rate }),
    ...(input.fx_rate_source === undefined ? {} : { fx_rate_source: input.fx_rate_source }),
    ...(input.fx_rate_date === undefined ? {} : { fx_rate_date: input.fx_rate_date }),
  };
}

/** The currency of the account with this id; ringgit when it is not among `accounts`. */
export function accountCurrency(accounts: { id: string; currency: string }[], accountId: string): string {
  return accounts.find((a) => a.id === accountId)?.currency ?? BASE_CURRENCY;
}

/** The accounts a draft (or a form that moves ringgit only) may offer: ringgit ones. */
export function ringgitOnly<A extends { currency: string }>(accounts: A[]): A[] {
  return accounts.filter((a) => a.currency === BASE_CURRENCY);
}

/**
 * The accounts a payment form offers: every ringgit account, every account in the documents' currency when they
 * are in another one (a USD invoice is paid into a USD account too), and the account already chosen.
 */
export function movementAccounts<A extends { id: string; currency: string }>(
  accounts: A[],
  documentCurrency: string | null,
  chosenId: string,
): A[] {
  return accounts.filter(
    (a) =>
      a.currency === BASE_CURRENCY ||
      a.id === chosenId ||
      (documentCurrency !== null && documentCurrency !== BASE_CURRENCY && a.currency === documentCurrency),
  );
}

/** A form's rate part for the account just chosen: ringgit (no rate), or that account's currency, waiting for BNM. */
export function fxForAccount(fx: CurrencyFields | undefined, currency: string): CurrencyFields {
  const fields = fx ?? ringgitFields();
  return currency === fields.currency ? fields : withCurrency(fields, currency, false);
}

/** True when the form is on an account in another currency. */
export function onForeignAccount(fx: CurrencyFields | undefined): boolean {
  return fx !== undefined && fx.currency !== BASE_CURRENCY;
}

/** The rate per one unit as exact text: null when the box is empty, 'NaN' when it is not a usable number. */
function perOneText(fx: CurrencyFields): string | null {
  return currencyPayload(fx).fx_rate;
}

/**
 * What a record function is sent for the rate: nothing on a ringgit account; on one in another currency the rate
 * per one unit as exact text, `bnm` with its date while the box holds BNM's figure, `manual` otherwise.
 */
export function movementRatePayload(fx: CurrencyFields | undefined): {
  fx_rate?: string;
  fx_rate_source?: 'bnm' | 'manual';
  fx_rate_date?: string;
} {
  if (!fx || !onForeignAccount(fx)) return {};
  const payload = currencyPayload(fx);
  if (payload.fx_rate === null) return {};
  return {
    fx_rate: payload.fx_rate,
    fx_rate_source: payload.fx_rate_source ?? 'manual',
    ...(payload.fx_rate_date ? { fx_rate_date: payload.fx_rate_date } : {}),
  };
}

/** The first thing wrong with the rate on an account in another currency, or null (always null on a ringgit one). */
export function movementRateError(fx: CurrencyFields | undefined): string | null {
  if (!fx || !onForeignAccount(fx)) return null;
  const text = perOneText(fx);
  if (text === null) return MOVEMENT_MESSAGES.rate;
  return text === 'NaN' ? CURRENCY_MESSAGES.rate : null;
}

/** The movement's ringgit as two-decimal text (what the previews share), or null while a figure is not a number. */
export function movementRinggit(amount: string, fx: CurrencyFields | undefined): string | null {
  if (!fx || !onForeignAccount(fx)) return null;
  const text = perOneText(fx);
  if (text === null || text === 'NaN') return null;
  return movementRinggitText(amount.replace(/,/g, '').trim(), text);
}

/** "About RM 1,660.00 at this rate." under the rate box, or null. */
export function movementRinggitNote(amount: string, fx: CurrencyFields | undefined): string | null {
  const ringgit = movementRinggit(amount, fx);
  const sen = ringgit === null ? null : senFromText(ringgit);
  return sen === null ? null : `About ${rm(ringgitOf(sen))} at this rate.`;
}
