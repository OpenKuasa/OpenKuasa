import { describe, expect, it } from 'vitest';
import { FX_REVALUATION_MESSAGES, type RevaluationItem, type RevaluationRun, postFxRevaluationInput, previewFxRevaluationInput } from '@/lib/finance/fx-revaluation';
import {
  WORKING_OUT,
  closingRateLabel,
  defaultMonthEnd,
  emptyNote,
  farRatesQuestion,
  groupItems,
  itemNote,
  laterRunBlock,
  mergeRateRows,
  missingRate,
  monthEndsBetween,
  postBlock,
  postPayload,
  postQuestion,
  previewRates,
  rateRowNotes,
  rateRowsFrom,
  rateShown,
  ratesMatch,
  revaluationCsv,
  revaluationTotals,
  withRowTyped,
  withTypedRates,
} from '@/lib/finance/fx-revaluation-views';

/**
 * The FX Revaluation screen's own rules (stage 6b): which month ends it offers, the closing-rate boxes, the
 * figures it shows while a typed rate waits for the server, and what Post sends. The figures are the plan's worked
 * examples (R1-R7), E = 31 October 2026 with BNM's 30 October selling rates.
 */

const E = '2026-10-31';
const DIGEST = '0123456789abcdef0123456789abcdef';

/** An item as a preview gives it, at BNM's USD 4.48 unless told otherwise. */
function item(over: Partial<RevaluationItem>): RevaluationItem {
  return {
    kind: 'invoice',
    item_id: 'a',
    reference: 'INV-0001',
    party: 'Lim Hardware',
    currency: 'USD',
    foreign_balance: 0,
    carried_myr: 0,
    earlier_myr: 0,
    rate_text: '4.4800000000',
    rate_source: 'bnm',
    rate_date: '2026-10-30',
    bnm_rate_text: '4.4800000000',
    bnm_rate_date: '2026-10-30',
    revalued_myr: 0,
    difference: 0,
    posted_myr: 0,
    gain: 0,
    digest: DIGEST,
    ...over,
  };
}

// R1 (invoice A), R2 (bill B), R5 (customer C in credit), R3 (the USD account), R4 (the SGD account, converted).
const A = item({ item_id: 'a', reference: 'INV-0001', foreign_balance: 600, carried_myr: 2520, revalued_myr: 2688, difference: 168, posted_myr: 168, gain: 168 });
const B = item({ kind: 'bill', item_id: 'b', reference: 'BILL-0001', party: 'Pacific Supply', foreign_balance: 1080, carried_myr: 4536, revalued_myr: 4838.4, difference: 302.4, posted_myr: 302.4, gain: -302.4 });
const C = item({ item_id: 'c', reference: 'INV-0002', foreign_balance: -100, carried_myr: -420, revalued_myr: -448, difference: -28, posted_myr: -28, gain: -28 });
const USD_ACCOUNT = item({ kind: 'account', item_id: 'u', reference: 'USD account', party: null, foreign_balance: 9000, carried_myr: 40240, revalued_myr: 40320, difference: 80, posted_myr: 80, gain: 80 });
const SGD_ACCOUNT = item({
  kind: 'account', item_id: 's', reference: 'SGD account', party: null, currency: 'SGD', foreign_balance: 0, carried_myr: -30,
  rate_text: null, rate_source: null, rate_date: null, bnm_rate_text: '3.4500000000', bnm_rate_date: '2026-10-30',
  revalued_myr: 0, difference: 30, posted_myr: 30, gain: 30,
});
const RUN_1 = [A, B, C, USD_ACCOUNT, SGD_ACCOUNT];

// R7: JPY 123,457 carried at a typed 0.029; BNM's closing rate 2.95 per 100.
const JPY = item({
  item_id: 'j', reference: 'INV-0003', currency: 'JPY', foreign_balance: 123457, carried_myr: 3580.25,
  rate_text: '0.0295000000', bnm_rate_text: '0.0295000000', revalued_myr: 3641.98, difference: 61.73, posted_myr: 61.73, gain: 61.73,
});

const run = (over: Partial<RevaluationRun>): RevaluationRun => ({
  id: 'r1', revaluation_no: 'FX-0001', period_end: E, posted_at: '2026-11-02T03:00:00Z', posted_by: null,
  rates: [{ currency: 'USD', rate_text: '4.4800000000', rate_source: 'bnm', rate_date: '2026-10-30' }],
  lines: RUN_1.map((l) => ({ ...l, id: `line-${l.item_id}`, digest: null })), net_gain: -52.4, ...over,
});

describe('the month ends offered', () => {
  it('is the last month end on or before today in Malaysia', () => {
    expect(defaultMonthEnd('2026-10-21')).toBe('2026-09-30');
    expect(defaultMonthEnd('2026-10-31')).toBe('2026-10-31');
    expect(defaultMonthEnd('2026-11-01')).toBe('2026-10-31');
    expect(defaultMonthEnd('2027-01-05')).toBe('2026-12-31');
    expect(defaultMonthEnd('2027-03-01')).toBe('2027-02-28');
    expect(defaultMonthEnd('2028-03-01')).toBe('2028-02-29');
  });

  it('lists every month end from the first foreign date to today, newest first, around a weekend and a year end', () => {
    // 31 October 2026 is a Saturday: it is still the month end.
    expect(monthEndsBetween('2026-10-05', '2026-11-03')).toEqual(['2026-10-31']);
    expect(monthEndsBetween('2026-11-15', '2027-03-01')).toEqual(['2027-02-28', '2027-01-31', '2026-12-31', '2026-11-30']);
    expect(monthEndsBetween('2027-12-31', '2028-03-01')).toEqual(['2028-02-29', '2028-01-31', '2027-12-31']);
  });

  it('never offers a month end after today, and always offers the newest', () => {
    expect(monthEndsBetween('2026-10-20', '2026-10-21')).toEqual(['2026-09-30']);
    expect(monthEndsBetween('2027-05-01', '2026-10-21')).toEqual(['2026-09-30']);
  });
});

describe('the closing-rate boxes', () => {
  it('are one per currency with a balance, filled from the preview in the box\'s unit, with BNM\'s notes', () => {
    const rows = rateRowsFrom([...RUN_1, JPY], E);
    // The SGD account has no SGD left: it needs no rate.
    expect(rows.map((r) => [r.currency, r.fields.rate, r.fields.rateSource, r.fields.rateDate])).toEqual([
      ['JPY', '2.95', 'bnm', '2026-10-30'],
      ['USD', '4.48', 'bnm', '2026-10-30'],
    ]);
    expect(closingRateLabel('JPY')).toBe('Closing rate (RM per 100 JPY)');
    expect(closingRateLabel('USD')).toBe('Closing rate (RM per USD)');
    expect(rateRowNotes(rows[1], E)).toEqual(["Bank Negara Malaysia's 5 pm selling rate of 30 October 2026."]);
  });

  it('say when BNM\'s rate is more than 7 days older than the month end', () => {
    const old = item({ foreign_balance: 1, rate_date: '2026-10-20', bnm_rate_date: '2026-10-20' });
    expect(rateRowNotes(rateRowsFrom([old], E)[0], E)).toEqual([
      "Bank Negara Malaysia's 5 pm selling rate of 20 October 2026.",
      'The latest rate is from 20 October 2026.',
    ]);
  });

  it('say BNM has none, and ask for one, when the preview had no rate for a currency', () => {
    const none = item({ currency: 'XAF', foreign_balance: 10, rate_text: null, rate_source: null, rate_date: null, bnm_rate_text: null, bnm_rate_date: null, revalued_myr: null, difference: null, posted_myr: null, gain: null });
    const rows = rateRowsFrom([none], E);
    expect(rows[0].fields.rate).toBe('');
    expect(rateRowNotes(rows[0], E)).toEqual(['Bank Negara Malaysia has no rate for XAF on or before 31 October 2026. Type the rate.']);
    expect(missingRate(rows)).toBe('XAF');
    expect(previewRates(rows)).toBeNull();
  });

  it('turn a typed rate into "Typed by hand", and BNM\'s figure typed back into BNM\'s again', () => {
    const rows = withRowTyped(rateRowsFrom(RUN_1, E), 'USD', '4.5');
    expect(rows[0].fields.rateSource).toBe('manual');
    expect(rateRowNotes(rows[0], E)).toEqual(["Typed by hand. Bank Negara Malaysia's rate is RM 4.48 per USD, 30 October 2026."]);
    const back = withRowTyped(rows, 'USD', '4.48');
    expect([back[0].fields.rateSource, back[0].fields.rateDate]).toEqual(['bnm', '2026-10-30']);
  });

  it('keep what was typed when a new preview comes, add a newly needed currency and drop one no longer needed', () => {
    const typed = withRowTyped(rateRowsFrom(RUN_1, E), 'USD', '4.5');
    const fresh = rateRowsFrom([A, JPY], E);
    expect(mergeRateRows(typed, fresh).map((r) => [r.currency, r.fields.rate])).toEqual([
      ['JPY', '2.95'],
      ['USD', '4.5'],
    ]);
    expect(mergeRateRows(typed, rateRowsFrom([JPY], E)).map((r) => r.currency)).toEqual(['JPY']);
  });

  it('ask once before posting a rate more than 20% from BNM\'s', () => {
    const rows = withRowTyped(rateRowsFrom(RUN_1, E), 'USD', '6');
    const asked = farRatesQuestion(rows);
    expect(asked?.question).toBe(
      "This rate is more than 20% away from Bank Negara Malaysia's (RM 4.48 per USD, 30 October 2026). Post again to keep it.",
    );
    expect(farRatesQuestion(asked!.rows)).toBeNull();
    expect(farRatesQuestion(rateRowsFrom(RUN_1, E))).toBeNull();
  });
});

describe('the figures while a typed rate waits for the server', () => {
  it('are the preview\'s own, digest and all, while the boxes hold the preview\'s rates', () => {
    const rows = rateRowsFrom(RUN_1, E);
    expect(ratesMatch(RUN_1, rows)).toBe(true);
    expect(withTypedRates(RUN_1, rows)).toBe(RUN_1);
  });

  it('reproduce R1 at a typed 4.5000 (+180.00), and drop the digest so nothing posts', () => {
    const rows = withRowTyped(rateRowsFrom(RUN_1, E), 'USD', '4.5000');
    expect(ratesMatch(RUN_1, rows)).toBe(false);
    const shown = withTypedRates(RUN_1, rows);
    const a = shown.find((i) => i.item_id === 'a')!;
    expect([a.rate_text, a.rate_source, a.rate_date, a.revalued_myr, a.difference, a.posted_myr, a.gain]).toEqual([
      '4.5000000000', 'manual', null, 2700, 180, 180, 180,
    ]);
    // R2 at 4.5: 1,080 x 4.5 = 4,860.00, owing 324.00 more.
    expect(shown.find((i) => i.item_id === 'b')!.gain).toBe(-324);
    // The converted SGD account needs no rate: it still revalues to 0.
    expect(shown.find((i) => i.item_id === 's')!.gain).toBe(30);
    expect(shown.every((i) => i.digest === null)).toBe(true);
    expect(postPayload(E, shown)).toBeNull();
    expect(postBlock(shown, rows, E, [])).toBe(WORKING_OUT);
  });

  it('work JPY per 100 in the box: 2.95 is 0.0295 per yen, R7\'s 3,641.98', () => {
    const typed = withRowTyped(rateRowsFrom([JPY], E), 'JPY', '3');
    const at3 = withTypedRates([JPY], typed)[0];
    // 123,457 x 0.03 = 3,703.71.
    expect([at3.rate_text, at3.revalued_myr, at3.difference]).toEqual(['0.0300000000', 3703.71, 123.46]);
    const back = withTypedRates([JPY], withRowTyped(typed, 'JPY', '2.95'));
    expect(back).toEqual([JPY]);
  });

  it('show no figures for a currency whose box is empty or not a rate', () => {
    const rows = withRowTyped(rateRowsFrom(RUN_1, E), 'USD', 'abc');
    const shown = withTypedRates(RUN_1, rows);
    expect(shown.find((i) => i.item_id === 'a')!.gain).toBeNull();
    expect(revaluationTotals(shown).complete).toBe(false);
    expect(postBlock(shown, rows, E, [])).toBe('Enter the closing rate for USD before posting.');
  });
});

describe('the tiles and the table', () => {
  it('add up run 1 in sen: 5 lines, net -52.40', () => {
    expect(revaluationTotals(RUN_1)).toEqual({
      lines: 5,
      netGain: -52.4,
      gains: 278,
      losses: -330.4,
      // 2,688 - 448 + 40,320 + 0 - 4,838.40
      revaluedMyr: 37721.6,
      toPost: 5,
      currencies: ['USD'],
      complete: true,
    });
  });

  it('group the items by kind, invoices first', () => {
    expect(groupItems(RUN_1).map((g) => [g.label, g.items.map((i) => i.reference), g.gain])).toEqual([
      ['Invoices', ['INV-0001', 'INV-0002'], 140],
      ['Supplier bills', ['BILL-0001'], -302.4],
      ['Bank and cash accounts', ['SGD account', 'USD account'], 110],
    ]);
  });

  it('label a converted account', () => {
    expect(itemNote(SGD_ACCOUNT)).toBe('Converted: no SGD left; the ringgit left is the gain or loss on converting.');
    expect(itemNote(USD_ACCOUNT)).toBeNull();
    expect(itemNote({ ...SGD_ACCOUNT, kind: 'invoice' })).toBeNull();
  });

  it('show a rate in the box\'s unit to four places', () => {
    expect(rateShown('4.4800000000', 'USD')).toBe('4.4800');
    expect(rateShown('0.0295000000', 'JPY')).toBe('2.9500 per 100');
    expect(rateShown('4.4812345678', 'USD')).toBe('4.4812');
    expect(rateShown('4.48125', 'USD')).toBe('4.4813');
    expect(rateShown(null, 'USD')).toBe('—');
  });

  it('say there is nothing to revalue, with the month end or without', () => {
    expect(emptyNote(E)).toBe('No foreign-currency invoices, bills or accounts at 31 October 2026. Nothing to revalue.');
    expect(emptyNote(null)).toBe('No foreign-currency invoices, bills or accounts. Nothing to revalue.');
  });
});

describe('posting', () => {
  it('sends the preview\'s digest unchanged, its rates and what it showed', () => {
    const payload = postPayload(E, RUN_1)!;
    expect(payload).toEqual({
      period_end: E,
      rates: { USD: { rate: '4.48', source: 'bnm', rate_date: '2026-10-30' } },
      expected: { lines: 5, net_gain: '-52.40', digest: DIGEST },
    });
    const parsed = postFxRevaluationInput.parse(payload);
    expect(parsed.expected.digest).toBe(DIGEST);
    expect(parsed.rates).toEqual({ USD: { rate: '4.4800000000', source: 'bnm', rate_date: '2026-10-30' } });
  });

  it('takes a JPY rate typed per 100 through the preview to the post at the same rate per one yen', () => {
    // The box: 3 per 100 yen, typed.
    const rows = withRowTyped(rateRowsFrom([JPY], E), 'JPY', '3');
    const sent = previewFxRevaluationInput.parse({ period_end: E, rates: previewRates(rows) });
    expect(sent.rates).toEqual({ JPY: { rate: '0.0300000000', source: 'manual' } });
    // The server answers at that rate (what the database would: rate::text per one unit), with its digest.
    const answer = [{ ...JPY, rate_text: '0.0300000000', rate_source: 'manual' as const, rate_date: null, revalued_myr: 3703.71, difference: 123.46, posted_myr: 123.46, gain: 123.46 }];
    const shown = withTypedRates(answer, mergeRateRows(rows, rateRowsFrom(answer, E)));
    expect(shown).toBe(answer);
    const posted = postFxRevaluationInput.parse(postPayload(E, shown));
    expect(posted.rates).toEqual(sent.rates);
    expect(posted.expected).toEqual({ lines: 1, net_gain: '123.46', digest: DIGEST });
  });

  it('is blocked by a later month end already posted, with FIN54\'s sentence', () => {
    const runs = [run({ revaluation_no: 'FX-0007', period_end: '2026-11-30' }), run({ period_end: '2026-09-30' })];
    expect(laterRunBlock(E, runs)).toBe(
      'FX-0007 for 30 Nov 2026 is already posted. Month ends are revalued in order, so an earlier one cannot be revalued now.',
    );
    expect(laterRunBlock('2026-11-30', runs)).toBeNull();
    expect(postBlock(RUN_1, rateRowsFrom(RUN_1, E), E, runs)).toBe(laterRunBlock(E, runs));
  });

  it('is blocked when no line posts anything, but not by lines that offset each other', () => {
    const settled = RUN_1.map((i) => ({ ...i, earlier_myr: i.difference as number, posted_myr: 0, gain: 0 }));
    expect(postBlock(settled, rateRowsFrom(settled, E), E, [])).toBe(FX_REVALUATION_MESSAGES.nothing(E));
    const offsetting = [
      item({ item_id: 'x', foreign_balance: 1, posted_myr: 12, gain: 12 }),
      item({ item_id: 'y', foreign_balance: 1, posted_myr: -12, gain: -12 }),
    ];
    expect(postBlock(offsetting, rateRowsFrom(offsetting, E), E, [])).toBeNull();
  });

  it('asks with the month end, its date and the next day\'s reversal', () => {
    expect(postQuestion(E)).toBe('Post FX revaluation for 31 October 2026? It is dated 31 Oct 2026 and reversed on 1 Nov 2026.');
    expect(postQuestion('2026-12-31')).toBe('Post FX revaluation for 31 December 2026? It is dated 31 Dec 2026 and reversed on 1 Jan 2027.');
  });
});

describe('a posted run as CSV', () => {
  it('has one row per item, kind by kind, with the exact rate per one unit', () => {
    const lines = revaluationCsv(run({})).replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('Kind,Reference,Party,Currency,Foreign balance,Rate (RM per 1 unit),Carried RM,Revalued RM,Earlier RM,Posted RM,Gain RM');
    expect(lines.slice(1)).toEqual([
      'Invoice,INV-0001,Lim Hardware,USD,600,4.4800000000,2520,2688,0,168,168',
      "Invoice,INV-0002,Lim Hardware,USD,-100,4.4800000000,-420,-448,0,-28,-28",
      'Supplier bill,BILL-0001,Pacific Supply,USD,1080,4.4800000000,4536,4838.4,0,302.4,-302.4',
      'Account,SGD account,,SGD,0,,-30,0,0,30,30',
      'Account,USD account,,USD,9000,4.4800000000,40240,40320,0,80,80',
    ]);
  });

  it('keeps a name that a spreadsheet would run as a formula as text', () => {
    const csv = revaluationCsv(run({ lines: [{ ...A, id: 'l', party: '=HYPERLINK("x")', digest: null }] }));
    expect(csv).toContain(`'=HYPERLINK(""x"")`);
  });
});
