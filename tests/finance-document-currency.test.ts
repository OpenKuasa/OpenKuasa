import { describe, expect, it } from 'vitest';
import {
  CURRENCY_MESSAGES,
  currencyError,
  currencyPayload,
  farRateQuestion,
  rateKey,
  rateLabel,
  rateNotes,
  rateText,
  ringgitFields,
  ringgitTotal,
  ringgitTotalNote,
  savedFields,
  withCurrency,
  withPartyCurrency,
  withRateAnswer,
  withRateConfirmed,
  withRateTyped,
  wholeUnitsError,
} from '@/lib/finance/document-currency';
import { emptyLine } from '@/lib/finance/document-form';
import type { FxDefault } from '@/lib/finance/fx-rates';

const USD: FxDefault = { rate: 4.0815, rate_date: '2026-10-15', unit: 1, middle_rate: 4.0815 };
const JPY: FxDefault = { rate: 0.025857, rate_date: '2026-10-15', unit: 100, middle_rate: 2.5857 };
const DATE = '2026-10-15';
/** A form switched to `code` and answered by BNM with `bnm`. */
const answered = (code: string, bnm: FxDefault | null, date = DATE) =>
  withRateAnswer(withCurrency(ringgitFields(), code, true), date, `${code}|${date}`, { ok: true, rate: bnm }, true);

describe('a ringgit document', () => {
  it('asks nothing, says nothing, and sends its code alone', () => {
    const fields = ringgitFields();
    expect(rateKey(fields, DATE)).toBeNull();
    expect(rateNotes(fields, DATE)).toEqual([]);
    expect(currencyError(fields, true)).toBeNull();
    expect(currencyPayload(fields)).toEqual({ currency: 'MYR', fx_rate: null, fx_rate_source: null, fx_rate_date: null });
    expect(ringgitTotal(fields, [emptyLine('k')])).toBeNull();
  });

  it('opens a saved ringgit draft as ringgit', () => {
    expect(savedFields({ currency: 'MYR', fx_rate: 1, fx_rate_source: null, fx_rate_date: null })).toEqual(ringgitFields());
  });
});

describe('choosing a currency', () => {
  it('asks BNM for that currency and the document date, and only once the date is whole', () => {
    const usd = withCurrency(ringgitFields(), 'USD', true);
    expect(usd).toMatchObject({ currency: 'USD', currencyEdited: true, rate: '', rateSource: 'bnm' });
    expect(rateKey(usd, DATE)).toBe('USD|2026-10-15');
    expect(rateKey(usd, '2026-10-1')).toBeNull();
  });

  it('takes BNM’s rate into the box, per the unit BNM quotes', () => {
    expect(answered('USD', USD)).toMatchObject({ rate: '4.0815', rateSource: 'bnm', rateDate: '2026-10-15', bnm: USD });
    expect(answered('JPY', JPY)).toMatchObject({ rate: '2.5857', rateSource: 'bnm' });
    expect(rateLabel('JPY')).toBe('Exchange rate (RM per 100 JPY)');
    expect(rateLabel('USD')).toBe('Exchange rate (RM per USD)');
  });

  it('drops an answer for a date or currency the form has moved on from', () => {
    const usd = withCurrency(ringgitFields(), 'USD', true);
    expect(withRateAnswer(usd, '2026-10-16', 'USD|2026-10-15', { ok: true, rate: USD }, true)).toBe(usd);
  });

  it('a customer’s default fills a new form, but not one whose currency was picked, nor a saved draft', () => {
    expect(withPartyCurrency(ringgitFields(), 'SGD', true).currency).toBe('SGD');
    expect(withPartyCurrency(ringgitFields(), 'SGD', true).currencyEdited).toBe(false);
    expect(withPartyCurrency(withCurrency(ringgitFields(), 'USD', true), 'SGD', true).currency).toBe('USD');
    expect(withPartyCurrency(ringgitFields(), 'SGD', false).currency).toBe('MYR');
    expect(withPartyCurrency(ringgitFields(), null, true).currency).toBe('MYR');
  });
});

describe('the rate box', () => {
  it('sends BNM’s rate as BNM’s, per one unit, with its date', () => {
    expect(currencyPayload(answered('JPY', JPY))).toEqual({ currency: 'JPY', fx_rate: '0.025857', fx_rate_source: 'bnm', fx_rate_date: '2026-10-15' });
  });

  it('marks a typed rate as typed by hand, and BNM’s own figure typed back as BNM’s again', () => {
    const typed = withRateTyped(answered('USD', USD), '4.1');
    expect(currencyPayload(typed)).toEqual({ currency: 'USD', fx_rate: '4.1', fx_rate_source: 'manual', fx_rate_date: null });
    expect(rateNotes(typed, DATE)).toEqual(["Typed by hand. Bank Negara Malaysia's rate is RM 4.0815 per USD, 15 October 2026."]);
    expect(currencyPayload(withRateTyped(typed, '4.0815')).fx_rate_source).toBe('bnm');
  });

  it('keeps a typed rate when the date changes, and offers BNM’s new one when the box held BNM’s', () => {
    const later = { ...USD, rate: 4.2, rate_date: '2026-10-16' };
    const typed = withRateTyped(answered('USD', USD), '4.1');
    expect(withRateAnswer(typed, '2026-10-16', 'USD|2026-10-16', { ok: true, rate: later }, true)).toMatchObject({ rate: '4.1', rateSource: 'manual' });
    expect(withRateAnswer(answered('USD', USD), '2026-10-16', 'USD|2026-10-16', { ok: true, rate: later }, true)).toMatchObject({
      rate: '4.2',
      rateSource: 'bnm',
      rateDate: '2026-10-16',
    });
  });

  it('does not change a saved draft’s rate when it is opened, but notes BNM’s beside it', () => {
    const saved = savedFields({ currency: 'USD', fx_rate: 4.1, fx_rate_source: 'manual', fx_rate_date: null });
    const opened = withRateAnswer(saved, DATE, 'USD|2026-10-15', { ok: true, rate: USD }, false);
    expect(opened).toMatchObject({ rate: '4.1', rateSource: 'manual', bnm: USD });
  });

  it('refuses what is not a number above 0, and a send with no rate', () => {
    const usd = answered('USD', null);
    expect(currencyError(withRateTyped(usd, 'abc'), false)).toBe(CURRENCY_MESSAGES.rate);
    expect(currencyError(withRateTyped(usd, '0'), false)).toBe(CURRENCY_MESSAGES.rate);
    expect(currencyError(withRateTyped(usd, '-4'), false)).toBe(CURRENCY_MESSAGES.rate);
    expect(currencyError(usd, false)).toBeNull();
    expect(currencyError(usd, true)).toBe('Enter the exchange rate before marking it as sent.');
    expect(currencyPayload(usd)).toEqual({ currency: 'USD', fx_rate: null, fx_rate_source: null, fx_rate_date: null });
  });

  it('says when BNM has no rate, when the lookup failed, and when BNM’s rate is old', () => {
    expect(rateNotes(answered('ZAR', null), DATE)).toEqual([
      'Bank Negara Malaysia has no rate for ZAR on or before 15 October 2026. Type the rate.',
    ]);
    const failed = withRateAnswer(withCurrency(ringgitFields(), 'USD', true), DATE, 'USD|2026-10-15', { ok: false }, true);
    expect(rateNotes(failed, DATE)).toEqual([
      "Bank Negara Malaysia's rate could not be looked up. Type the rate, or change the date to try again.",
    ]);
    const old = answered('USD', { ...USD, rate_date: '2026-10-02' }, '2026-10-15');
    expect(rateNotes(old, '2026-10-15')).toEqual([
      "Bank Negara Malaysia's 5 pm middle rate of 2 October 2026.",
      'The latest rate is from 2 October 2026.',
    ]);
    // While an answer is awaited nothing is said about BNM.
    expect(rateNotes(withCurrency(ringgitFields(), 'USD', true), DATE)).toEqual([]);
  });

  it('asks once about a rate more than 20% from BNM’s', () => {
    const far = withRateTyped(answered('USD', USD), '5');
    expect(farRateQuestion(far)).toBe(
      "This rate is more than 20% away from Bank Negara Malaysia's (RM 4.0815 per USD, 15 October 2026). Save again to keep it.",
    );
    expect(farRateQuestion(withRateConfirmed(far))).toBeNull();
    expect(farRateQuestion(withRateTyped(answered('USD', USD), '4.8'))).toBeNull();
  });
});

describe('the ringgit total', () => {
  const line = (unit_price: string, quantity = '1', sst_rate = '0') => ({ ...emptyLine('k'), description: 'x', unit_price, quantity, sst_rate });

  it('converts each line and its SST to the sen, then adds', () => {
    const usd = answered('USD', USD);
    expect(ringgitTotal(usd, [line('1000')])).toBe(4081.5);
    // 0.33 USD × 4.0815 = 1.346895 → 1.35, three times: 4.05, not round(0.99 × 4.0815) = 4.04.
    expect(ringgitTotal(usd, [line('0.33'), line('0.33'), line('0.33')])).toBe(4.05);
    expect(ringgitTotal(usd, [line('100', '1', '8')])).toBe(440.8); // 408.15 + 32.65
    expect(ringgitTotalNote(usd, [line('1000')])).toBe('About RM 4,081.50 at this rate.');
  });

  it('rounds half up on exact numbers, not on floats', () => {
    // 1 × 1.005 is exactly 1.005, which rounds to 1.01; as a float it is 100.49999999999999 sen and would read 1.00.
    const usd = withRateTyped(answered('USD', USD), '1.005');
    expect(ringgitTotal(usd, [line('1')])).toBe(1.01);
    expect(ringgitTotal(usd, [line('1'), line('1')])).toBe(2.02);
    // A rate with all ten decimals the database keeps.
    expect(ringgitTotal(withRateTyped(answered('USD', USD), '4.0123456789'), [line('1000')])).toBe(4012.35);
  });

  // The same document, with the same numbers, is in supabase/tests/bendahara_quotation_currency_check.sql, where the
  // database's total_myr must read 5.05: that is what holds this function and the generated columns together.
  it('agrees with the database on half-sen lines and on discounted foreign lines', () => {
    const usd = withRateTyped(answered('USD', USD), '1.005');
    const lines = [
      line('1.00'), // 1.00 → 1.005 → 1.01 (half up)
      { ...line('0.33', '3', '8'), discount_pct: '10' }, // net 0.891: 0.89 + SST 0.07 → 0.89 + 0.07
      { ...line('1.50', '2', '6'), discount_amount: '0.10' }, // net 2.90 + SST 0.17 → 2.91 + 0.17
    ];
    expect(ringgitTotal(usd, lines)).toBe(5.05);
  });

  it('is not shown without a rate', () => {
    expect(ringgitTotalNote(answered('USD', null), [line('1000')])).toBeNull();
  });
});

describe('whole units', () => {
  it('refuses cents in a currency that has none', () => {
    expect(wholeUnitsError('JPY', [{ unit_price: 1500 }, { unit_price: 99, discount_amount: 10 }])).toBeNull();
    expect(wholeUnitsError('JPY', [{ unit_price: 1500.5 }])).toBe('JPY has no cents: enter whole amounts.');
    expect(wholeUnitsError('JPY', [{ unit_price: 1500, discount_amount: 0.5 }])).toBe('JPY has no cents: enter whole amounts.');
    expect(wholeUnitsError('USD', [{ unit_price: 1500.5 }])).toBeNull();
  });

  it('writes a per-one rate in the box per the unit BNM quotes', () => {
    expect(rateText(0.000158, 'VND')).toBe('0.0158');
    expect(rateText(4.0815, 'USD')).toBe('4.0815');
  });

  it('keeps all ten decimals of a rate, so a draft opens and saves again with the rate it had', () => {
    expect(rateText(4.0123456789, 'USD')).toBe('4.0123456789');
    expect(rateText(0.0123456789, 'JPY')).toBe('1.23456789');
    const reopened = savedFields({ currency: 'USD', fx_rate: 4.0123456789, fx_rate_source: 'manual', fx_rate_date: null });
    expect(currencyPayload(reopened).fx_rate).toBe('4.0123456789');
    expect(currencyPayload(withRateTyped(withCurrency(ringgitFields(), 'JPY', true), '2.5857')).fx_rate).toBe('0.025857');
    // 0.07 per 100 JPY is 0.0007 per yen, with no float slop in the rate that is sent.
    expect(currencyPayload(withRateTyped(withCurrency(ringgitFields(), 'JPY', true), '0.07')).fx_rate).toBe('0.0007');
  });

  it('refuses a rate the database cannot hold', () => {
    const usd = withCurrency(ringgitFields(), 'USD', true);
    for (const text of ['0', '0.', '.', '-1', '1e3', '1,5', 'NaN', 'Infinity', '12345678901']) {
      expect(currencyError(withRateTyped(usd, text), false), text).toBe(CURRENCY_MESSAGES.rate);
    }
    // Too small to be anything at ten decimals.
    expect(currencyError(withRateTyped(usd, '0.00000000001'), false)).toBe(CURRENCY_MESSAGES.rate);
    expect(currencyError(withRateTyped(usd, '.5'), false)).toBeNull();
    expect(currencyError(withRateTyped(usd, '5.'), false)).toBeNull();
  });
});
