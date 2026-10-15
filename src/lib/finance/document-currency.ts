/**
 * The currency part of a document form: the currency, the exchange rate, and
 * what the form says about the rate. Quotations use it from stage 2; the
 * invoice, bill and order forms are to use it as their stages come. Pure.
 *
 * The rule (spec, "Data model"): the person types amounts in the document's
 * currency; the rate is ringgit per one unit, and is Bank Negara Malaysia's
 * 1700 middle rate for the document's date (the newest on or before it)
 * until the person types another, which then reads "Typed by hand" beside
 * BNM's. The box itself takes ringgit per the unit BNM quotes (1 USD, 100
 * JPY), so the figure typed is the figure BNM publishes.
 */
import { lineSen } from './bill-math';
import { BASE_CURRENCY, minorUnits, quoteUnit } from './currencies';
import { type LineDraft, lineNumbers } from './document-form';
import { isIsoDate } from './document-lines';
import { rm } from './format';
import { type FxDefault, longDate, staleRateNote } from './fx-rates';

/** A rate this far from BNM's, either way, is asked about once before it is saved. */
export const FAR_FROM_BNM = 0.2;

export type RateSource = 'bnm' | 'manual';

export type CurrencyFields = {
  currency: string;
  /** Once the person picks a currency, choosing a customer no longer changes it. */
  currencyEdited: boolean;
  /** The rate box as typed: ringgit per `quoteUnit(currency)`. Empty when there is no rate yet. */
  rate: string;
  /** `bnm` while the box holds BNM's rate for `rateDate`; `manual` once the person types another. */
  rateSource: RateSource;
  /** The date of the BNM rate in the box; null when it was typed. */
  rateDate: string | null;
  /** The key (`currency|date`) of the last answer asked for and received; null while one is awaited or none was asked. */
  answered: string | null;
  /** BNM's rate for the current currency and date, as the last answer gave it; null when it has none. */
  bnm: FxDefault | null;
  /** True when the last lookup failed (not "BNM has none": the read itself). */
  lookupFailed: boolean;
  /** The rate box text the person has been asked about and kept, far from BNM's. */
  confirmedRate: string | null;
};

export const CURRENCY_MESSAGES = {
  rate: 'Enter the exchange rate as a number above 0, such as 4.0815.',
  // FIN38's sentence, also said before the database is asked.
  rateBeforeSending: 'Enter the exchange rate before marking it as sent.',
  wholeUnits: (code: string) => `${code} has no cents: enter whole amounts.`,
} as const;

/** A ringgit document: the fields every existing draft and every new form start with. */
export function ringgitFields(): CurrencyFields {
  return {
    currency: BASE_CURRENCY,
    currencyEdited: false,
    rate: '',
    rateSource: 'bnm',
    rateDate: null,
    answered: null,
    bnm: null,
    lookupFailed: false,
    confirmedRate: null,
  };
}

/*
 * Money and rates are worked in whole numbers here, never in floats: a rate is
 * a bigint count of 10^-10 (the database column is numeric(20,10)), and the
 * ringgit figures are rounded half up to the sen as Postgres rounds a numeric.
 */
const RATE_PLACES = 10;
const RATE_ONE = BigInt(10) ** BigInt(RATE_PLACES);
/** numeric(20,10) holds ten digits before the point. */
const RATE_LIMIT = BigInt(10) ** BigInt(20);

/** Decimal text with its point moved two places to the right (x100), done on the digits. */
function timesHundred(text: string): string {
  const [whole, fraction = ''] = text.split('.');
  const padded = fraction.padEnd(2, '0');
  const moved = `${whole}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  return padded.length > 2 ? `${moved}.${padded.slice(2)}` : moved;
}

/**
 * The box's text for a rate per one unit: per 100 for a currency BNM quotes per
 * 100. Kept to the database's ten decimals, so a rate typed by hand opens
 * again as it was typed.
 */
export function rateText(perOne: number, currency: string): string {
  const fixed = perOne.toFixed(RATE_PLACES);
  const shown = quoteUnit(currency) === 100 ? timesHundred(fixed) : fixed;
  return shown.replace(/\.?0+$/, '');
}

/** A rate in 10^-10 units as the decimal text of its number. */
function scaledText(scaled: bigint): string {
  const digits = scaled.toString().padStart(RATE_PLACES + 1, '0');
  const cut = digits.length - RATE_PLACES;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`.replace(/\.?0+$/, '');
}

/**
 * The rate in the box per one unit, in 10^-10 units: null when the box is
 * empty, undefined when it is not a number above 0 that the database can hold.
 * Ringgit is 1.
 */
function rateScaled(fields: CurrencyFields): bigint | null | undefined {
  if (fields.currency === BASE_CURRENCY) return RATE_ONE;
  const text = fields.rate.trim();
  if (text === '') return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return undefined;
  const fraction = m[2] ?? '';
  const digits = BigInt(`${m[1]}${fraction}` || '0');
  // The box is per 100 for some currencies: per one unit moves the point two places left.
  const places = fraction.length + (quoteUnit(fields.currency) === 100 ? 2 : 0);
  let scaled: bigint;
  if (places <= RATE_PLACES) {
    scaled = digits * BigInt(10) ** BigInt(RATE_PLACES - places);
  } else {
    const by = BigInt(10) ** BigInt(places - RATE_PLACES);
    scaled = (digits + by / BigInt(2)) / by;
  }
  return scaled > BigInt(0) && scaled < RATE_LIMIT ? scaled : undefined;
}

/** BNM's rate per one unit in 10^-10 units. */
function bnmScaled(bnm: FxDefault): bigint {
  return BigInt(bnm.rate.toFixed(RATE_PLACES).replace('.', ''));
}

/** A saved draft's currency, as the form shows it. */
export function savedFields(saved: {
  currency: string;
  fx_rate: number | null;
  fx_rate_source: RateSource | null;
  fx_rate_date: string | null;
}): CurrencyFields {
  if (saved.currency === BASE_CURRENCY) return ringgitFields();
  return {
    ...ringgitFields(),
    currency: saved.currency,
    currencyEdited: true,
    rate: saved.fx_rate === null ? '' : rateText(saved.fx_rate, saved.currency),
    rateSource: saved.fx_rate_source ?? 'bnm',
    rateDate: saved.fx_rate_source === 'bnm' ? saved.fx_rate_date : null,
  };
}

/** What to ask BNM's rate for, as one key; null for ringgit or while the date is half typed. */
export function rateKey(fields: CurrencyFields, date: string): string | null {
  if (fields.currency === BASE_CURRENCY || !isIsoDate(date)) return null;
  return `${fields.currency}|${date}`;
}

/** The person picks a currency (`byHand`), or a customer's default fills it. The rate waits for BNM's answer. */
export function withCurrency(fields: CurrencyFields, currency: string, byHand: boolean): CurrencyFields {
  if (currency === fields.currency) return byHand ? { ...fields, currencyEdited: true } : fields;
  return { ...ringgitFields(), currency, currencyEdited: byHand || fields.currencyEdited };
}

/** A customer was chosen: their default currency fills a new form, unless the person already picked one. */
export function withPartyCurrency(fields: CurrencyFields, defaultCurrency: string | null | undefined, isNew: boolean): CurrencyFields {
  if (!isNew || fields.currencyEdited || !defaultCurrency) return fields;
  return withCurrency(fields, defaultCurrency, false);
}

/** The rate per one unit in the box: null when empty, NaN when it is not a number above 0. */
export function ratePerOne(fields: CurrencyFields): number | null {
  if (fields.currency === BASE_CURRENCY) return 1;
  const scaled = rateScaled(fields);
  if (scaled === null) return null;
  return scaled === undefined ? Number.NaN : Number(scaledText(scaled));
}

/** The rate per one unit as exact decimal text (what the save is sent, so no digit is lost to a float): null when empty, 'NaN' when unusable. */
function ratePerOneText(fields: CurrencyFields): string | null {
  if (fields.currency === BASE_CURRENCY) return '1';
  const scaled = rateScaled(fields);
  return scaled === null ? null : scaled === undefined ? 'NaN' : scaledText(scaled);
}

/** True when the box holds exactly BNM's rate. */
function isBnmRate(fields: CurrencyFields, bnm: FxDefault | null): boolean {
  const typed = rateScaled(fields);
  return bnm !== null && typed !== null && typed !== undefined && bnmScaled(bnm) === typed;
}

/**
 * BNM's answer for `key` arrived. An answer for a key that is no longer the
 * form's (the person changed the date again meanwhile) is dropped. With
 * `offer`, a box that still holds BNM's rate (or nothing) takes the new one;
 * a typed rate is kept. Without it (a saved draft just opened) only BNM's
 * figure is noted beside the box.
 */
export function withRateAnswer(
  fields: CurrencyFields,
  date: string,
  key: string,
  answer: { ok: true; rate: FxDefault | null } | { ok: false },
  offer: boolean,
): CurrencyFields {
  if (rateKey(fields, date) !== key) return fields;
  if (!answer.ok) return { ...fields, answered: key, bnm: null, lookupFailed: true };
  const next = { ...fields, answered: key, bnm: answer.rate, lookupFailed: false };
  if (!offer || fields.rateSource === 'manual') return next;
  return answer.rate
    ? { ...next, rate: rateText(answer.rate.rate, fields.currency), rateSource: 'bnm', rateDate: answer.rate.rate_date }
    : { ...next, rate: '', rateSource: 'bnm', rateDate: null };
}

/** The person typed in the rate box. Typing BNM's own figure back makes it BNM's again. */
export function withRateTyped(fields: CurrencyFields, text: string): CurrencyFields {
  const typed = { ...fields, rate: text };
  if (text.trim() === '') return { ...typed, rateSource: 'bnm', rateDate: null };
  return isBnmRate(typed, fields.bnm)
    ? { ...typed, rateSource: 'bnm', rateDate: fields.bnm!.rate_date }
    : { ...typed, rateSource: 'manual', rateDate: null };
}

/** What the save action is sent. Ringgit sends its code alone; the database stores rate 1 for it. */
export function currencyPayload(fields: CurrencyFields) {
  if (fields.currency === BASE_CURRENCY) {
    return { currency: BASE_CURRENCY, fx_rate: null, fx_rate_source: null, fx_rate_date: null };
  }
  const perOne = ratePerOneText(fields);
  // A rate is BNM's only while the box holds the figure of a BNM date the form knows.
  const bnm = fields.rateSource === 'bnm' && fields.rateDate !== null && perOne !== null;
  return {
    currency: fields.currency,
    fx_rate: perOne,
    fx_rate_source: perOne === null ? null : bnm ? ('bnm' as const) : ('manual' as const),
    fx_rate_date: bnm ? fields.rateDate : null,
  };
}

/** The first thing wrong with the currency part, or null. Sending (or posting) needs a rate. */
export function currencyError(fields: CurrencyFields, sending: boolean): string | null {
  const perOne = ratePerOne(fields);
  if (perOne !== null && Number.isNaN(perOne)) return CURRENCY_MESSAGES.rate;
  if (sending && perOne === null) return CURRENCY_MESSAGES.rateBeforeSending;
  return null;
}

/**
 * The question asked once before saving a rate more than 20% from BNM's for
 * that date, or null. Saving again with the same rate goes ahead.
 */
export function farRateQuestion(fields: CurrencyFields): string | null {
  const typed = rateScaled(fields);
  if (fields.currency === BASE_CURRENCY || fields.bnm === null || typed === null || typed === undefined) return null;
  if (fields.confirmedRate === fields.rate) return null;
  // |typed - bnm| <= bnm * 20%, as whole numbers: five times the gap against BNM's rate.
  const bnm = bnmScaled(fields.bnm);
  const gap = typed > bnm ? typed - bnm : bnm - typed;
  if (gap * BigInt(Math.round(1 / FAR_FROM_BNM)) <= bnm) return null;
  return `This rate is more than 20% away from Bank Negara Malaysia's (${bnmWords(fields.bnm, fields.currency)}). Save again to keep it.`;
}

/** The form after the far-rate question was asked: the same rate is not asked about again. */
export function withRateConfirmed(fields: CurrencyFields): CurrencyFields {
  return { ...fields, confirmedRate: fields.rate };
}

/** "RM 4.0815 per USD, 15 October 2026" */
function bnmWords(bnm: FxDefault, currency: string): string {
  const unit = quoteUnit(currency);
  const per = unit === 1 ? currency : `${unit} ${currency}`;
  return `RM ${rateText(bnm.rate, currency)} per ${per}, ${longDate(bnm.rate_date)}`;
}

/**
 * What the form says under the rate box, for a foreign currency. Each line
 * is true in every case that reaches it: a lookup still out says nothing
 * about BNM, and "no rate" names the date it was asked for.
 */
export function rateNotes(fields: CurrencyFields, date: string): string[] {
  if (fields.currency === BASE_CURRENCY) return [];
  const key = rateKey(fields, date);
  const notes: string[] = [];
  if (fields.rateSource === 'bnm' && fields.rateDate !== null && fields.rate.trim() !== '') {
    notes.push(`Bank Negara Malaysia's 5 pm middle rate of ${longDate(fields.rateDate)}.`);
    if (isIsoDate(date)) {
      const stale = staleRateNote(fields.rateDate, date);
      if (stale) notes.push(stale);
    }
  } else if (fields.rateSource === 'manual' && fields.rate.trim() !== '') {
    notes.push(
      fields.bnm && fields.answered === key
        ? `Typed by hand. Bank Negara Malaysia's rate is ${bnmWords(fields.bnm, fields.currency)}.`
        : 'Typed by hand.',
    );
  }
  if (key !== null && fields.answered === key && fields.rate.trim() === '') {
    notes.push(
      fields.lookupFailed
        ? "Bank Negara Malaysia's rate could not be looked up. Type the rate, or change the date to try again."
        : `Bank Negara Malaysia has no rate for ${fields.currency} on or before ${longDate(date)}. Type the rate.`,
    );
  }
  return notes;
}

/** The box's label: "Exchange rate (RM per 100 JPY)". */
export function rateLabel(currency: string): string {
  const unit = quoteUnit(currency);
  return `Exchange rate (RM per ${unit === 1 ? currency : `${unit} ${currency}`})`;
}

/**
 * The document's total in ringgit at the rate in the box, as the database
 * will work it out: each line's amount and SST converted and rounded to the
 * sen, then added. null for ringgit (the total is already ringgit) and while
 * there is no usable rate.
 */
export function ringgitTotal(fields: CurrencyFields, lines: LineDraft[]): number | null {
  const rate = rateScaled(fields);
  if (fields.currency === BASE_CURRENCY || rate === null || rate === undefined) return null;
  // round(amount * rate, 2) on a two-decimal amount: the amount in sen times the rate, rounded half up.
  const sen = (amountSen: bigint) => (amountSen * rate + RATE_ONE / BigInt(2)) / RATE_ONE;
  let total = BigInt(0);
  for (const line of lines) {
    const { amount, sst } = lineSen(lineNumbers(line));
    total += sen(amount) + sen(sst);
  }
  return Number(total) / 100;
}

/** "About RM 4,081.50 at this rate." under the lines of a foreign document, or null. */
export function ringgitTotalNote(fields: CurrencyFields, lines: LineDraft[]): string | null {
  const total = ringgitTotal(fields, lines);
  return total === null ? null : `About ${rm(total)} at this rate.`;
}

/**
 * The first line amount that has cents in a currency with none, as a
 * sentence, or null. A price box and a fixed discount are checked.
 */
export function wholeUnitsError(currency: string, lines: { unit_price: number; discount_amount?: number | null }[]): string | null {
  if (minorUnits(currency) !== 0) return null;
  const whole = (n: number | null | undefined) => n === null || n === undefined || Number.isNaN(n) || Number.isInteger(n);
  return lines.every((l) => whole(l.unit_price) && whole(l.discount_amount)) ? null : CURRENCY_MESSAGES.wholeUnits(currency);
}
